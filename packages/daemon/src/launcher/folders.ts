/**
 * The new-session folder browser (spec 4.5.1): directories only, through the
 * one path policy (FilesService.policy), which works whether Files is on or
 * off. Nothing inside a folder is read: `git` and `claudeMd` are name checks
 * (an lstat of `<dir>/.git` and `<dir>/CLAUDE.md`).
 *
 * - list: dirs and links that stay inside a root. Dot dirs, node_modules,
 *   .git, dist and build are hidden unless `showHidden`. Sorted pinned, live,
 *   recent, then name; pages of 500.
 * - recent: the newest 8 folders from launches and folders_seen (updated on
 *   every session.added); a folder no longer under a root is left out.
 * - pin: in the db, shared by every device, at most 20.
 * - create: one `mkdir` (0755, never recursive) of a checked name in a
 *   checked parent; EEXIST is a conflict, EPERM the macOS privacy sentence;
 *   settings.launch.rate.foldersPerHour per actor. Where the new folder
 *   landed is checked again (a parent swapped for a symlink meanwhile).
 */
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FolderNameSchema,
  localSessions,
  type AccountId,
  type FileRoot,
  type FolderCreateBody,
  type FolderEntry,
  type FolderPinBody,
  type FolderRecent,
  type FoldersListQuery,
  type FoldersListResponse,
  type Session,
} from '@jantar/protocol';
import type {
  Actor,
  DaemonContext,
  FilePolicy,
  FileRefusal,
  FolderBrowser,
  LaunchErrorCode,
  LaunchResult,
  ResolvedRoot,
} from '../contracts.js';
import { actorId } from '../core/actor.js';
import { hasScope } from '../auth/scopes.js';

/** Entries per page. */
export const FOLDERS_PAGE = 500;
export const RECENT_MAX = 8;
/** At most this many candidates are located under a root for `recent`. */
const RECENT_SCAN = 50;
export const PINS_MAX = 20;
/** Shown only with showHidden (dot dirs are hidden too). */
export const HIDDEN_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build']);

export const TCC_SENTENCE =
  "macOS hasn't let Jantar use this folder. Allow it under System Settings > Privacy & Security > Files and Folders.";

const HOUR_MS = 60 * 60_000;
/** realpath of each live session's cwd, cached this long. */
const LIVE_TTL_MS = 30_000;

export type Failure = { ok: false; code: LaunchErrorCode; reason: string; retryAfterMs?: number };

export function fail(code: LaunchErrorCode, reason: string, retryAfterMs?: number): Failure {
  return retryAfterMs === undefined ? { ok: false, code, reason } : { ok: false, code, reason, retryAfterMs };
}

export function isRefusal(v: object): v is FileRefusal {
  return 'refused' in v;
}

/** A path-policy refusal as a launcher answer. */
export function refusalResult(r: FileRefusal): Failure {
  switch (r.refused) {
    case 'no_root':
    case 'missing':
      return fail('not_found', r.message);
    case 'protected':
    case 'outside':
    case 'os_permission':
      return fail('forbidden', r.message);
    case 'bad_path':
    case 'not_dir':
    case 'not_file':
    case 'too_large':
    case 'unsupported_type':
      return fail('invalid_request', r.message);
  }
}

/** "~/Desktop/work" + "foo/bar" -> "~/Desktop/work/foo/bar". */
export function displayOf(root: Pick<ResolvedRoot, 'display'>, rel: string): string {
  if (!rel) return root.display;
  return `${root.display.replace(/\/+$/u, '')}/${rel}`;
}

/** Absolute paths only for an admin device or the CLI (as FilesService.roots). */
export function seesAbsolutePaths(actor: Actor): boolean {
  return actor.kind === 'cli' || (actor.kind === 'device' && hasScope(actor.scopes, 'admin'));
}

export function fileRoot(r: ResolvedRoot, actor: Actor): FileRoot {
  const out: FileRoot = { id: r.id, kind: r.kind, label: r.label, display: r.display, home: r.home };
  if (r.sid) out.sid = r.sid;
  if (seesAbsolutePaths(actor)) out.path = r.real;
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function realOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** When a folder was last used, by whom and as what (from folders_seen and launches). */
export interface FolderUse {
  lastUsed: string;
  lastAccount?: AccountId;
  name?: string;
}

export class Folders implements FolderBrowser {
  private readonly creates = new Map<string, number[]>();
  private readonly liveCache = new Map<string, { real: string; at: number }>();

  constructor(
    private readonly ctx: DaemonContext,
    private readonly policy: () => FilePolicy,
    /** Files' audit of a refusal (files.denied and the probe alarm). */
    private readonly denied: (actor: Actor, root: string, rel: string, r: FileRefusal) => void = () => {},
  ) {}

  /** A refusal, audited like Files' own, as the API answer. */
  private refusal(actor: Actor, root: string, rel: string, r: FileRefusal): Failure {
    this.denied(actor, root, rel, r);
    return refusalResult(r);
  }

  async roots(actor: Actor): Promise<FileRoot[]> {
    return (await this.policy().roots()).map((r) => fileRoot(r, actor));
  }

  async list(q: FoldersListQuery, actor: Actor): Promise<LaunchResult<{ listing: FoldersListResponse }>> {
    const showHidden = q.showHidden || this.ctx.settings.get().folders.showHidden;
    const dir = await this.policy().openDir(q.root, q.path, { hidden: showHidden, dirsOnly: true });
    if (isRefusal(dir)) return this.refusal(actor, q.root, q.path, dir);
    const shown = dir.entries.filter(
      (e) =>
        (e.type === 'dir' || (e.type === 'link' && e.link === 'inside')) &&
        (showHidden || (!e.name.startsWith('.') && !HIDDEN_NAMES.has(e.name))),
    );
    const live = await this.liveByFolder();
    const uses = this.uses();
    const pins = new Set(this.ctx.db.folders.pins().filter((p) => p.rootId === dir.root.id).map((p) => p.rel));
    const rows = await mapLimit(shown, 16, async (e) => {
      const abs = join(dir.real, e.name);
      const real = e.type === 'link' ? await realOr(abs) : abs;
      const rel = dir.rel ? `${dir.rel}/${e.name}` : e.name;
      const use = uses.get(real);
      const entry: FolderEntry = { name: e.name, link: e.type === 'link', git: false, claudeMd: false, live: live.get(real) ?? 0, pinned: pins.has(rel) };
      if (use) {
        entry.lastUsed = use.lastUsed;
        if (use.lastAccount !== undefined) entry.lastAccount = use.lastAccount;
      }
      return { entry, real };
    });
    rows.sort((a, b) => sortKey(a.entry, b.entry));
    let start = 0;
    if (q.after !== undefined) {
      const at = rows.findIndex((r) => r.entry.name === q.after);
      start = at >= 0 ? at + 1 : rows.length;
    }
    const page = rows.slice(start, start + FOLDERS_PAGE);
    await mapLimit(page, 16, async (r) => {
      [r.entry.git, r.entry.claudeMd] = await Promise.all([exists(join(r.real, '.git')), exists(join(r.real, 'CLAUDE.md'))]);
    });
    const more = start + FOLDERS_PAGE < rows.length;
    return {
      ok: true,
      listing: {
        root: dir.root.id,
        path: dir.rel,
        display: displayOf(dir.root, dir.rel),
        entries: page.map((r) => r.entry),
        next: more ? (page[page.length - 1]?.entry.name ?? null) : null,
        hiddenProtected: dir.hiddenProtected,
        truncated: dir.truncated,
        // Every page's folders, for "Showing 500 of 812" (a floor when the scan was cut short).
        total: rows.length,
      },
    };
  }

  async recent(_actor: Actor): Promise<FolderRecent[]> {
    const policy = this.policy();
    const roots = new Map((await policy.roots()).map((r) => [r.id, r]));
    const out: FolderRecent[] = [];
    const newest = [...this.uses().entries()].sort((a, b) => b[1].lastUsed.localeCompare(a[1].lastUsed)).slice(0, RECENT_SCAN);
    for (const [cwd, use] of newest) {
      if (out.length >= RECENT_MAX) break;
      const at = await policy.locate(cwd);
      if (isRefusal(at)) continue;
      const root = roots.get(at.rootId);
      if (!root) continue;
      const row: FolderRecent = { rootId: at.rootId, path: at.rel, display: displayOf(root, at.rel), lastUsed: use.lastUsed };
      if (use.lastAccount !== undefined) row.lastAccount = use.lastAccount;
      if (use.name) row.name = use.name;
      out.push(row);
    }
    return out;
  }

  async pin(body: FolderPinBody, actor: Actor): Promise<LaunchResult> {
    if (!body.pinned) {
      // Unpinning works for a folder that is gone already: then the path is taken as given.
      const dir = await this.policy().resolveDir(body.root, body.path);
      const rel = isRefusal(dir) ? body.path.replace(/^\/+|\/+$/gu, '') : dir.rel;
      this.ctx.db.folders.unpin(isRefusal(dir) ? body.root : dir.root.id, rel);
      return { ok: true };
    }
    const dir = await this.policy().resolveDir(body.root, body.path);
    if (isRefusal(dir)) return this.refusal(actor, body.root, body.path, dir);
    const pins = this.ctx.db.folders.pins();
    const already = pins.some((p) => p.rootId === dir.root.id && p.rel === dir.rel);
    if (!already && pins.length >= PINS_MAX) return fail('conflict', `You can pin at most ${PINS_MAX} folders; unpin one first`);
    this.ctx.db.folders.pin({ rootId: dir.root.id, rel: dir.rel, pinnedAt: this.ctx.clock.iso(), by: actorId(actor) });
    return { ok: true };
  }

  async create(body: FolderCreateBody, actor: Actor): Promise<LaunchResult<{ created: { root: string; path: string } }>> {
    // An allow-list, as starting a session: the CLI or a device with launch (never the system or the extension).
    if (!(actor.kind === 'cli' || (actor.kind === 'device' && hasScope(actor.scopes, 'launch')))) {
      return fail('forbidden', "This device can't create folders. On your Mac run: jantar devices grant <device> launch");
    }
    if (!FolderNameSchema.safeParse(body.name).success) {
      return fail('invalid_request', 'A folder name starts with a letter or digit, has no "/", and does not end in a space or a dot');
    }
    const who = actorId(actor);
    const limit = this.ctx.settings.get().launch.rate.foldersPerHour;
    const now = this.ctx.clock.now();
    const hits = (this.creates.get(who) ?? []).filter((t) => t > now - HOUR_MS);
    this.creates.set(who, hits);
    if (hits.length >= limit) {
      return fail('rate_limited', `At most ${limit} new folders an hour; try again later`, Math.max(1, (hits[0] ?? now) + HOUR_MS - now));
    }
    const policy = this.policy();
    const parent = await policy.resolveDir(body.root, body.parent);
    if (isRefusal(parent)) return this.refusal(actor, body.root, body.parent, parent);
    const target = join(parent.real, body.name);
    if (policy.isProtected(target)) return fail('forbidden', 'That name is on the protected list');
    hits.push(now);
    try {
      await mkdir(target, { mode: 0o755 });
    } catch (e) {
      return mkdirFailure(e, body.name);
    }
    const rel = parent.rel ? `${parent.rel}/${body.name}` : body.name;
    // A parent swapped for a symlink between the check and mkdir would have put the folder elsewhere.
    const landed = await policy.resolveDir(parent.root.id, rel);
    if (isRefusal(landed) || landed.real !== (await realOr(target))) {
      await rmdir(target).catch(() => undefined);
      this.ctx.log.warn('new folder did not land under its root; removed', { root: parent.root.id });
      return fail('forbidden', 'The folder moved while it was being created');
    }
    return { ok: true, created: { root: landed.root.id, path: landed.rel } };
  }

  /** folders_seen: a session ran in this folder (session.added). */
  async noteSession(s: Pick<Session, 'cwd' | 'account' | 'name'>): Promise<void> {
    if (!s.cwd.startsWith('/')) return;
    // The time of the event, not of the realpath call's return.
    const lastSeenAt = this.ctx.clock.iso();
    const row: Parameters<typeof this.ctx.db.folders.seen>[0] = { cwd: await realOr(s.cwd), lastSeenAt };
    if (s.account !== null) row.account = s.account;
    if (s.name) row.name = s.name;
    this.ctx.db.folders.seen(row);
  }

  /** Last use per folder realpath, newest wins: folders_seen and launches that opened a window. */
  uses(): Map<string, FolderUse> {
    const out = new Map<string, FolderUse>();
    const put = (cwd: string, use: FolderUse) => {
      const prev = out.get(cwd);
      if (!prev || prev.lastUsed < use.lastUsed) out.set(cwd, use);
    };
    for (const s of this.ctx.db.folders.recentSeen(500)) {
      const use: FolderUse = { lastUsed: s.lastSeenAt };
      if (s.account !== undefined) use.lastAccount = s.account;
      if (s.name) use.name = s.name;
      put(s.cwd, use);
    }
    for (const j of this.ctx.db.launches.list({ limit: 200 })) {
      if (!j.tty) continue;
      put(j.folder, { lastUsed: j.createdAt, lastAccount: j.actualAccount ?? j.account, name: j.name });
    }
    return out;
  }

  /** Live sessions per folder realpath. */
  private async liveByFolder(): Promise<Map<string, number>> {
    const now = this.ctx.clock.now();
    const out = new Map<string, number>();
    // v0.6: the Mac's own sessions only: a server's folder is never realpathed here.
    const sessions = Object.values(localSessions(this.ctx.store.getState())).filter((s) => s.status !== 'ended');
    for (const s of sessions) {
      let hit = this.liveCache.get(s.cwd);
      if (!hit || now - hit.at > LIVE_TTL_MS) {
        hit = { real: await realOr(s.cwd), at: now };
        this.liveCache.set(s.cwd, hit);
      }
      out.set(hit.real, (out.get(hit.real) ?? 0) + 1);
    }
    if (this.liveCache.size > 500) this.liveCache.clear();
    return out;
  }
}

/** Pinned first, then folders with live sessions, then the recently used (newest first), then by name. */
function sortKey(a: FolderEntry, b: FolderEntry): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.live > 0 !== b.live > 0) return a.live > 0 ? -1 : 1;
  if (a.lastUsed !== b.lastUsed) {
    if (!a.lastUsed) return 1;
    if (!b.lastUsed) return -1;
    return b.lastUsed.localeCompare(a.lastUsed);
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function mkdirFailure(e: unknown, name: string): Failure {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'EEXIST':
      return fail('conflict', `A folder named ${name} already exists here`);
    case 'EPERM':
      return fail('forbidden', TCC_SENTENCE);
    case 'EACCES':
      return fail('forbidden', 'macOS refused to create a folder here (permission denied)');
    case 'ENOENT':
    case 'ENOTDIR':
      return fail('not_found', 'The parent folder is gone');
    case 'ENOSPC':
      return fail('unavailable', 'The disk is full');
    default:
      return fail('unavailable', 'The folder could not be created');
  }
}
