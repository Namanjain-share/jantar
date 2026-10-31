/**
 * Pure helpers for the Files screens: sizes, relative paths, where the
 * viewer stands, and how a changed file reads in a row. No React, no API.
 *
 * Paths are always (root id, relative POSIX path) pairs, as the daemon
 * takes them. A folder's place ends in "/" ("src/auth/"), a file's does
 * not, so the URL alone says which view to show; the "/" is dropped before
 * any call (the daemon refuses empty segments).
 */
import type { FileChange, FileOp, Session } from '@jantar/protocol';
import type { FilesLocation } from '../../../lib/router.js';
import { extOf } from '../../../lib/highlight/languages.js';

/** "812 B", "4.1 KB", "12.4 MB", "1.2 GB" (1024-based, as the daemon's windows are). */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** "src/auth/session.ts" -> "session.ts". */
export function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** "src/auth/session.ts" -> "src/auth/"; "" at the top. */
export function dirOf(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? '' : trimmed.slice(0, at + 1);
}

/** The path the daemon takes: no trailing slash. */
export function apiPath(p: string | undefined): string {
  return (p ?? '').replace(/\/+$/, '');
}

/** Where the viewer stands: the root list, a folder, or a file. */
export type Place = { kind: 'lists' } | { kind: 'dir'; root: string; path: string } | { kind: 'file'; root: string; path: string; tab: 'file' | 'edits' };

export function placeOf(loc: FilesLocation): Place {
  if (!loc.root) return { kind: 'lists' };
  const path = loc.path ?? '';
  if (!path || path.endsWith('/')) return { kind: 'dir', root: loc.root, path };
  return { kind: 'file', root: loc.root, path, tab: loc.tab ?? 'file' };
}

/** A folder's place ("" is the root itself). */
export function dirLocation(root: string, path: string): FilesLocation {
  const p = apiPath(path);
  return p ? { root, path: `${p}/` } : { root };
}

/**
 * Resolve a relative link target from a document at `from` (both relative
 * to the root): "../b.md#x" next to "docs/a.md" is "b.md". A leading "/"
 * means the root. Null when it leaves the root or names nothing.
 */
export function resolveRel(from: string, target: string): string | null {
  let t = target.split('#')[0]!.split('?')[0]!;
  try {
    t = decodeURIComponent(t);
  } catch {
    // keep it as written
  }
  if (!t) return null;
  const segs = t.startsWith('/') ? [] : dirOf(from).split('/').filter(Boolean);
  for (const s of t.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') {
      if (!segs.length) return null;
      segs.pop();
    } else {
      segs.push(s);
    }
  }
  const out = segs.join('/');
  return out ? (t.endsWith('/') ? `${out}/` : out) : null;
}

/** What GET /v1/files/raw serves as an image (the daemon's files/raw.ts). A Set: "constructor" is just a name. */
const RAW_IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic']);

/**
 * Whether a document's own image (`rel`, already resolved inside the root)
 * may be fetched: only an image the daemon would serve, never through a dot
 * folder or a dotfile. So a README cannot make the phone ask for `.env` or
 * `.ssh/id_rsa` on its own: each refusal is an audit row, and a few of them
 * raise the "protected files" alarm on every device.
 */
export function fetchableImage(rel: string): boolean {
  if (!rel || rel.split('/').some((s) => s.startsWith('.'))) return false;
  return RAW_IMAGES.has(extOf(rel));
}

/** Breadcrumb segments: the root's own name, then each folder down to `path`. */
export function crumbs(rootLabel: string, path: string): Array<{ label: string; path: string }> {
  const out = [{ label: rootLabel, path: '' }];
  let at = '';
  for (const seg of apiPath(path).split('/').filter(Boolean)) {
    at += `${seg}/`;
    out.push({ label: seg, path: at });
  }
  return out;
}

/** "+42 −7" (U+2212 minus), "~+6 −2" when estimated; "" with no counts. */
export function countsText(added: number | null, removed: number | null, approx = false): string {
  if (added === null && removed === null) return '';
  return `${approx ? '~' : ''}+${added ?? 0} −${removed ?? 0}`;
}

/** "Edit ×3", "Write, Edit ×4", "Write". */
export function toolsText(c: Pick<FileChange, 'tools' | 'ops'>): string {
  const tools = c.tools.length ? c.tools.join(', ') : 'Edit';
  return c.ops > 1 ? `${tools} ×${c.ops}` : tools;
}

/** Where a changed file sits, for line 2: its folder under the root, or its absolute folder. */
export function changeDir(c: Pick<FileChange, 'rel' | 'path'>): string {
  return c.rel !== undefined ? dirOf(c.rel) || './' : dirOf(c.path);
}

/** The name a row shows. */
export function changeName(c: Pick<FileChange, 'rel' | 'path'>): string {
  return baseName(c.rel ?? c.path);
}

/** Tags on a changed-file row, in the spec's order. */
export function changeTags(c: FileChange): string[] {
  const tags: string[] = [];
  if (c.created) tags.push('new');
  if (c.last.status === 'rejected') tags.push('rejected');
  if (c.last.status === 'blocked') tags.push('blocked');
  if (c.viewable === 'outside') tags.push('outside project');
  if (c.viewable === 'missing') tags.push('deleted');
  if (c.viewable === 'protected') tags.push('protected');
  return tags;
}

/** The one line a row that cannot open shows instead of a viewer. */
export const UNVIEWABLE: Readonly<Record<Exclude<FileChange['viewable'], 'yes'>, string>> = {
  protected: 'This file is protected. Keys and secrets never leave the Mac.',
  outside: 'This file is outside the folders Jantar shows. Add its folder as a root on the Mac to read it here.',
  missing: 'That file is no longer there.',
};

/** Whether a row opens the viewer (else it shows its one line). */
export function opensViewer(c: FileChange): c is FileChange & { rootId: string; rel: string } {
  return c.viewable === 'yes' && typeof c.rootId === 'string' && typeof c.rel === 'string' && c.rel !== '';
}

/** Newest first. */
export function newestFirst<T extends { lastAt: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/** The session a rail names: "web-app · fix login", or its short id once it has gone. */
export function sessionLabel(sid: string, s: Session | undefined): string {
  if (!s) return sid.slice(0, 8);
  const name = s.name?.trim();
  return name ? `${s.folder} · ${name}` : s.folder;
}

export interface ChangeGroup {
  key: string;
  label: string;
  changes: FileChange[];
}

/** One group per session, the session with the newest change first, each newest first. */
export function groupBySession(changes: readonly FileChange[], sessions: Readonly<Record<string, Session>>): ChangeGroup[] {
  const groups = new Map<string, FileChange[]>();
  for (const c of newestFirst(changes)) {
    const list = groups.get(c.sid);
    if (list) list.push(c);
    else groups.set(c.sid, [c]);
  }
  return [...groups].map(([sid, list]) => ({ key: sid, label: sessionLabel(sid, sessions[sid]), changes: list }));
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** How many different files were changed today (local day). */
export function changedToday(changes: readonly FileChange[], now: number): number {
  const paths = new Set<string>();
  for (const c of changes) {
    const t = Date.parse(c.lastAt);
    if (Number.isFinite(t) && sameDay(t, now)) paths.add(c.path);
  }
  return paths.size;
}

/** "14 files changed today", "No files changed today"; "187+ files changed today" when the list was cut short. */
export function todayLine(n: number, more = false): string {
  if (!n) return 'No files changed today';
  if (more) return `${n}+ files changed today`;
  return n === 1 ? '1 file changed today' : `${n} files changed today`;
}

/** Whether a list cut at `limit` rows may leave out more of today's files: it is full and its oldest row is from today. */
export function todayCut(changes: readonly FileChange[], limit: number, now: number): boolean {
  if (changes.length < limit) return false;
  let oldest = Number.POSITIVE_INFINITY;
  for (const c of changes) {
    const t = Date.parse(c.lastAt);
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  return Number.isFinite(oldest) && sameDay(oldest, now);
}

/**
 * Whether `c` is the file at `rel` under folder `cwd`. Sessions that share a
 * folder (or work in a root set on the Mac) share one root in the list, so a
 * change's root can be another session's: its absolute path says whose folder it is in.
 */
export function changedIn(c: FileChange, cwd: string, rel: string): boolean {
  return rel !== '' && c.path === `${cwd.replace(/\/+$/, '')}/${rel}`;
}

/** The live session that changed the file at `rel`, when the file is in that session's own folder. */
export function changedBy(c: FileChange | undefined, sessions: Readonly<Record<string, Session>>, rel: string): string | undefined {
  if (!c || !Object.hasOwn(sessions, c.sid)) return undefined;
  const s = sessions[c.sid]!;
  return s.status !== 'ended' && changedIn(c, s.cwd, rel) ? c.sid : undefined;
}

/** The newest change to a file under a root, if any session changed it. */
export function changeAt(changes: readonly FileChange[] | null | undefined, root: string, path: string): FileChange | undefined {
  if (!changes) return undefined;
  let best: FileChange | undefined;
  for (const c of changes) {
    if (c.rootId === root && c.rel === path && (!best || c.lastAt > best.lastAt)) best = c;
  }
  return best;
}

export type RowIcon = 'code' | 'image' | 'pdf' | 'text';

/** Row icons by extension (a Map: "constructor" and "__proto__" are just names). */
const ICON = new Map<string, RowIcon>([
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'svg', 'ico', 'bmp'].map((e) => [e, 'image'] as const),
  ['pdf', 'pdf'],
  ...['md', 'markdown', 'txt', 'rst', 'csv', 'log'].map((e) => [e, 'text'] as const),
]);

/** Which file icon a row gets: code by default. */
export function iconFor(name: string): RowIcon {
  return ICON.get(extOf(name)) ?? 'code';
}

/** "ok", "rejected", ... as an op's header says it. */
export const OP_STATUS: Readonly<Record<FileOp['status'], string>> = {
  ok: 'ok',
  rejected: 'rejected',
  blocked: 'blocked by a hook',
  error: 'failed',
  pending: 'waiting',
};

/** "Ask about this" text: "@src/x.ts " or "@src/x.ts:12-20 ". */
export function mention(rel: string, sel: LineRange | null): string {
  if (!sel) return `@${rel} `;
  return sel.from === sel.to ? `@${rel}:${sel.from} ` : `@${rel}:${sel.from}-${sel.to} `;
}

/** "src/x.ts:12" or "src/x.ts:12-20". */
export function pathLine(rel: string, sel: LineRange): string {
  return sel.from === sel.to ? `${rel}:${sel.from}` : `${rel}:${sel.from}-${sel.to}`;
}

/** Selected lines, 1-based and inclusive. */
export interface LineRange {
  from: number;
  to: number;
}

/** A tap on line `n`: select it, extend the selection to it, or clear it when it is the only one. */
export function nextSelection(cur: LineRange | null, n: number): LineRange | null {
  if (!cur) return { from: n, to: n };
  if (cur.from === n && cur.to === n) return null;
  if (cur.from === cur.to) return { from: Math.min(cur.from, n), to: Math.max(cur.from, n) };
  return { from: n, to: n };
}
