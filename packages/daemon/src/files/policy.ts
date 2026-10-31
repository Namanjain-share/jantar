/**
 * The one path authority (v0.3 spec 4.4.2). Files, Folders, the launcher
 * and Rewrite's context reach user files only through here; clients send a
 * root id and a relative path, never an absolute path.
 *
 * Every open follows the same steps, in this order:
 *   root -> parseRel -> denylist on the lexical path (before touching the
 *   disk) -> realpath -> containment in the root's realpath -> denylist on
 *   the realpath -> open with O_NOFOLLOW | O_NONBLOCK -> fstat must be a
 *   regular file -> lstat(real) must be the same inode.
 * Later reads use the handle, never the path again. A path that does not
 * exist is judged where it would be, below its deepest existing parent
 * (`unresolved`).
 *
 * What is left (documented, accepted): a parent dir swapped for a symlink
 * between realpath and open. The inode re-check narrows it; closing it would
 * need openat() walking, which Node lacks, and whoever can do it already runs
 * as the user. Hard links into a protected file cannot be seen by path; the
 * content rule (text.ts) covers private keys.
 *
 * A path from elsewhere (a transcript's file op, a session's cwd) is located
 * only when its name lies under a root (`underRoot`): one outside every root
 * is never resolved, since a realpath under ~/Documents or ~/Desktop can
 * bring up a macOS privacy prompt for jantard.
 *
 * Nothing here depends on files.enabled: the launcher uses it while Files is off.
 */
import { join, isAbsolute, normalize, relative, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { DaemonContext, DirEntryInfo, FilePolicy, FileRefusal, FileRefusalCode, OpenedDir, OpenedFile, ResolvedRoot } from '../contracts.js';
import { fsx } from '../sources/lib/fsx.js';
import { DenyRules, expandHome, segsOf, type DenyVerdict } from './deny.js';
import { ROOT_CACHE_MS, Roots } from './roots.js';

export const REL_MAX_BYTES = 1024;
export const REL_MAX_SEGS = 64;
export const SEG_MAX_BYTES = 255;
/** Entries read from one directory at most (spec 4.4.2). */
export const DIR_MAX_SCAN = 10_000;

const MESSAGES: Record<FileRefusalCode, string> = {
  no_root: 'That folder is not shared with this device (or its session has ended).',
  bad_path: 'That path is not allowed.',
  protected: 'This file is protected. Keys and secrets never leave the Mac.',
  outside: 'That path leads outside the shared folder.',
  not_file: 'That is not a regular file.',
  not_dir: 'That is not a folder.',
  missing: 'That file is no longer there.',
  too_large: 'This file is too large to show.',
  os_permission: "macOS hasn't let Jantar read this folder. Allow it in System Settings > Privacy & Security > Files and Folders.",
  unsupported_type: 'Jantar shows this file as text, or not at all.',
};

/** macOS's /var, /tmp and /etc are symlinks into /private. */
const PRIVATE_ALIAS_RE = /^\/(?:var|tmp|etc)(?=\/|$)/;

/** /var/x as /private/var/x (likewise /tmp, /etc) on macOS, by name alone; any other path as it is. */
export function privateSpelling(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' && PRIVATE_ALIAS_RE.test(path) ? `/private${path}` : path;
}

export function refuse(code: FileRefusalCode, message: string = MESSAGES[code]): FileRefusal {
  return { refused: code, message };
}

export function isRefusal(v: unknown): v is FileRefusal {
  return typeof v === 'object' && v !== null && typeof (v as { refused?: unknown }).refused === 'string';
}

// Control characters (C0, DEL, C1), backslash, and lone surrogates.
const BAD_REL_CHARS = /[\u0000-\u001f\u007f-\u009f\\]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * A clean relative POSIX path as segments ('' is the root itself), or null:
 * no leading '/', no NUL, control characters or backslash, no '', '.' or '..'
 * segment (refused, never normalised), at most 1024 bytes, 64 segments and
 * 255 bytes per segment.
 */
export function parseRel(rel: string): string[] | null {
  if (rel === '') return [];
  if (Buffer.byteLength(rel) > REL_MAX_BYTES || BAD_REL_CHARS.test(rel) || rel.startsWith('/')) return null;
  const segs = rel.split('/');
  if (segs.length > REL_MAX_SEGS) return null;
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..' || Buffer.byteLength(s) > SEG_MAX_BYTES) return null;
  }
  return segs;
}

/** `p` is `r` or lies below it (both realpaths). */
export function inside(p: string, r: string): boolean {
  const x = relative(r, p);
  return x === '' || (x !== '..' && !x.startsWith(`..${sep}`) && !isAbsolute(x));
}

function errCode(e: unknown): string {
  return String((e as NodeJS.ErrnoException | null)?.code ?? '');
}

/** One scanned directory entry: its name and the type its dirent claimed (lstat decides later). */
export interface ScanItem {
  name: string;
  type: DirEntryInfo['type'];
}

/** A directory read but not yet described: sorted names, ready for paging. */
export interface ScannedDir {
  real: string;
  rel: string;
  root: ResolvedRoot;
  display: string;
  items: ScanItem[];
  hiddenProtected: number;
  truncated: boolean;
}

interface DirTarget {
  root: ResolvedRoot;
  rel: string;
  real: string;
  st: BigIntStats;
  display: string;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Dirs first, then by name (natural, case-insensitive; code units break ties). */
export function compareItems(a: ScanItem, b: ScanItem): number {
  const ga = a.type === 'dir' ? 0 : 1;
  const gb = b.type === 'dir' ? 0 : 1;
  if (ga !== gb) return ga - gb;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Where a page starts after the cursor `after` (the last name of the previous page). */
export function cursorIndex(items: readonly ScanItem[], after: string | undefined): number {
  if (after === undefined) return 0;
  const at = items.findIndex((i) => i.name === after);
  if (at >= 0) return at + 1;
  // The cursor entry vanished: resume after where a dir of that name would sort
  // (a file cursor then repeats the files from the start, never skips any).
  const probe: ScanItem = { name: after, type: 'dir' };
  const next = items.findIndex((i) => compareItems(probe, i) < 0);
  return next === -1 ? items.length : next;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class PathPolicy implements FilePolicy {
  private readonly rootSet: Roots;
  private homeForms: string[];
  private stateForms: string[];
  private homesTriedAt = -Infinity;
  private homesDone = false;
  private homesPending: Promise<void> | null = null;
  /** Realpaths of absolute and ~ extraDeny entries that differ from the entry as written. */
  private extraReal: { entries: readonly string[]; at: number; forms: string[] } = { entries: [], at: -Infinity, forms: [] };
  private extraPending: Promise<void> | null = null;
  private compiled: { key: unknown; homes: string; rules: DenyRules } | null = null;

  constructor(private readonly ctx: Pick<DaemonContext, 'settings' | 'store' | 'clock' | 'log' | 'paths'>) {
    this.homeForms = [normalize(ctx.paths.userHome)];
    this.stateForms = [normalize(ctx.paths.home)];
    this.rootSet = new Roots({ ctx, rules: () => this.rules(), homes: () => this.homeForms });
    // Start now, so a synchronous isProtected() from another part soon knows both forms of $HOME.
    void this.ready();
  }

  /**
   * Resolve the realpaths the rules match besides the paths as given: $HOME,
   * the state dir and the absolute or ~ extraDeny entries.
   */
  async ready(): Promise<void> {
    await this.resolveHomes();
    await this.resolveExtraDeny();
  }

  /**
   * $HOME and the state dir, so the prefix rules match either form (a home
   * under /var is /private/var once resolved). Retried every few seconds
   * until both exist; concurrent callers share one try.
   */
  private async resolveHomes(): Promise<void> {
    if (this.homesDone) return;
    if (this.homesPending) return this.homesPending;
    const now = this.ctx.clock.now();
    if (now - this.homesTriedAt < ROOT_CACHE_MS) return;
    this.homesTriedAt = now;
    const realOf = async (p: string): Promise<string | null> => {
      try {
        return await fsx.realpath(p);
      } catch {
        return null;
      }
    };
    this.homesPending = (async () => {
      const home = await realOf(this.ctx.paths.userHome);
      const state = await realOf(this.ctx.paths.home);
      if (home && !this.homeForms.includes(home)) this.homeForms = [...this.homeForms, home];
      if (state && !this.stateForms.includes(state)) this.stateForms = [...this.stateForms, state];
      this.homesDone = home !== null && state !== null;
    })().finally(() => {
      this.homesPending = null;
    });
    return this.homesPending;
  }

  /**
   * An extraDeny path given through a symlink ("/opt/link" leading to
   * "/srv/secret") matches by its realpath too, as $HOME does. Resolved again
   * when the entries change and every ROOT_CACHE_MS (an entry may appear later).
   */
  private async resolveExtraDeny(): Promise<void> {
    if (this.extraPending) {
      await this.extraPending;
      // That run was for older entries: resolve these too.
      if (this.extraReal.entries !== this.ctx.settings.get().folders.extraDeny) return this.resolveExtraDeny();
      return;
    }
    const entries = this.ctx.settings.get().folders.extraDeny;
    const now = this.ctx.clock.now();
    if (this.extraReal.entries === entries && now - this.extraReal.at < ROOT_CACHE_MS) return;
    this.extraPending = (async () => {
      const forms: string[] = [];
      for (const raw of entries) {
        const abs = normalize(expandHome(raw.trim(), this.ctx.paths.userHome));
        if (!isAbsolute(abs)) continue;
        try {
          const real = await fsx.realpath(abs);
          if (real !== abs && !forms.includes(real)) forms.push(real);
        } catch {
          // Missing for now: the entry still matches as written.
        }
      }
      this.extraReal = { entries, at: now, forms };
    })().finally(() => {
      this.extraPending = null;
    });
    return this.extraPending;
  }

  /** The denylist for the current settings (rebuilt when folders settings change). */
  rules(): DenyRules {
    const folders = this.ctx.settings.get().folders;
    // New extraDeny entries: start resolving them now, so a synchronous isProtected() soon matches their realpaths too.
    if (folders.extraDeny !== this.extraReal.entries && !this.extraPending) void this.resolveExtraDeny();
    const extraForms = this.extraReal.forms;
    const homes = [...this.homeForms, '|', ...this.stateForms, '|', ...extraForms].join('\n');
    if (this.compiled && this.compiled.key === folders && this.compiled.homes === homes) return this.compiled.rules;
    const extraDeny = extraForms.length > 0 ? [...folders.extraDeny, ...extraForms] : folders.extraDeny;
    const rules = new DenyRules({ homes: this.homeForms, stateDirs: this.stateForms, extraDeny, allow: folders.allow });
    this.compiled = { key: folders, homes, rules };
    return rules;
  }

  async roots(): Promise<ResolvedRoot[]> {
    await this.ready();
    return this.rootSet.list();
  }

  async root(rootId: string): Promise<ResolvedRoot | null> {
    await this.ready();
    return this.rootSet.resolve(rootId);
  }

  isProtected(absPath: string): boolean {
    if (!isAbsolute(absPath)) return true;
    return this.rules().isProtected(normalize(absPath));
  }

  async openForRead(rootId: string, rel: string): Promise<OpenedFile | FileRefusal> {
    const root = await this.root(rootId);
    if (!root) return refuse('no_root');
    const segs = parseRel(rel);
    if (!segs) return refuse('bad_path');
    const rules = this.rules();
    const lexical = join(root.real, ...segs);
    if (rules.check(lexical) !== 'ok') return refuse('protected');
    let real: string;
    try {
      real = await fsx.realpath(lexical);
    } catch (e) {
      return this.unresolved(e, root, segs, rules, (v) => v === 'ok');
    }
    if (!inside(real, root.real)) return refuse('outside');
    if (rules.check(real) !== 'ok') return refuse('protected');
    let fh: OpenedFile['fh'];
    try {
      fh = await fsx.openNoFollow(real);
    } catch (e) {
      return this.fsRefusal(e);
    }
    try {
      const big = await fh.stat({ bigint: true });
      if (!big.isFile()) {
        await fh.close();
        return refuse('not_file');
      }
      const l = await fsx.lstat(real);
      if (l.ino !== big.ino || l.dev !== big.dev) {
        await fh.close();
        return refuse('outside');
      }
      const stat = await fh.stat();
      return { fh, stat, real, rel: segs.join('/'), root };
    } catch (e) {
      await fh.close().catch(() => undefined);
      return this.fsRefusal(e);
    }
  }

  async openDir(rootId: string, rel: string, opts: { hidden?: boolean; dirsOnly?: boolean; maxScan?: number } = {}): Promise<OpenedDir | FileRefusal> {
    const scan = await this.scanDir(rootId, rel, opts);
    if (isRefusal(scan)) return scan;
    const described = await this.describe(scan, scan.items, opts.dirsOnly === true);
    return {
      real: scan.real,
      rel: scan.rel,
      root: scan.root,
      entries: described.entries,
      hiddenProtected: scan.hiddenProtected + described.hiddenProtected,
      truncated: scan.truncated,
    };
  }

  async resolveDir(rootId: string, rel: string): Promise<{ real: string; rel: string; root: ResolvedRoot; display: string } | FileRefusal> {
    const t = await this.dirTarget(rootId, rel, false);
    if (isRefusal(t)) return t;
    return { real: t.real, rel: t.rel, root: t.root, display: t.display };
  }

  async underRoot(absPath: string): Promise<boolean> {
    if (!isAbsolute(absPath) || absPath.includes('\0')) return false;
    // Normalised segments (case and Unicode folded, as APFS matches): this only decides whether to look closer.
    const segs = segsOf(privateSpelling(normalize(absPath)));
    for (const r of await this.roots()) {
      for (const form of r.given === undefined ? [r.real] : [r.real, r.given]) {
        const rs = segsOf(privateSpelling(form));
        if (rs.length <= segs.length && rs.every((x, i) => segs[i] === x)) return true;
      }
    }
    return false;
  }

  async locate(absPath: string): Promise<{ rootId: string; rel: string } | FileRefusal> {
    if (!isAbsolute(absPath) || absPath.includes('\0')) return refuse('bad_path');
    await this.ready();
    const rules = this.rules();
    if (rules.check(normalize(absPath)) !== 'ok') return refuse('protected');
    // Outside every root by name: never resolved (missing or not, it can't be shown).
    if (!(await this.underRoot(absPath))) return refuse('outside');
    let real: string;
    try {
      real = await fsx.realpath(absPath);
    } catch (e) {
      return this.fsRefusal(e);
    }
    if (rules.check(real) !== 'ok') return refuse('protected');
    let best: ResolvedRoot | null = null;
    for (const r of await this.rootSet.list()) {
      if (inside(real, r.real) && (!best || r.real.length > best.real.length)) best = r;
    }
    if (!best) return refuse('outside');
    const rel = relative(best.real, real).split(sep).join('/');
    if (parseRel(rel) === null) return refuse('bad_path');
    return { rootId: best.id, rel };
  }

  /**
   * stat for the files routes: a regular file (opened, the caller closes it)
   * or a directory. Anything else is `not_file`.
   */
  async statTarget(rootId: string, rel: string): Promise<{ file: OpenedFile } | { dir: { st: BigIntStats; rel: string } } | FileRefusal> {
    const opened = await this.openForRead(rootId, rel);
    if (!isRefusal(opened)) return { file: opened };
    // A home dot dir on the way to a folders.allow entry is listed (scanDir), so it stats as a folder too.
    const ancestor = opened.refused === 'protected' && (await this.lexicalVerdict(rootId, rel)) === 'ancestor';
    if (opened.refused !== 'not_file' && !ancestor) return opened;
    const dir = await this.dirTarget(rootId, rel, ancestor);
    if (isRefusal(dir)) {
      if (dir.refused !== 'not_dir') return dir;
      // An allow ancestor that is not a folder stays protected; anything else (a FIFO, a socket) is not_file.
      return ancestor ? opened : refuse('not_file');
    }
    return { dir: { st: dir.st, rel: dir.rel } };
  }

  /** The denylist's verdict on a root's relative path, without the disk (null for an unknown root or a bad path). */
  private async lexicalVerdict(rootId: string, rel: string): Promise<DenyVerdict | null> {
    const root = await this.root(rootId);
    const segs = parseRel(rel);
    if (!root || !segs) return null;
    return this.rules().check(join(root.real, ...segs));
  }

  /**
   * Read a directory's names (at most `maxScan`), leaving out protected
   * entries (counted) and, unless `hidden`, dot entries. Sorted dirs first,
   * then by name. Nothing is lstat'd yet: `describe` does that per page.
   */
  async scanDir(rootId: string, rel: string, opts: { hidden?: boolean; dirsOnly?: boolean; maxScan?: number } = {}): Promise<ScannedDir | FileRefusal> {
    const t = await this.dirTarget(rootId, rel, true);
    if (isRefusal(t)) return t;
    const rules = this.rules();
    const maxScan = Math.max(1, Math.min(opts.maxScan ?? DIR_MAX_SCAN, DIR_MAX_SCAN));
    let dir: Awaited<ReturnType<typeof fsx.opendir>>;
    try {
      dir = await fsx.opendir(t.real);
    } catch (e) {
      return this.fsRefusal(e);
    }
    const items: ScanItem[] = [];
    let hiddenProtected = 0;
    let scanned = 0;
    let truncated = false;
    try {
      for (;;) {
        const ent = await dir.read();
        if (!ent) break;
        if (scanned >= maxScan) {
          truncated = true;
          break;
        }
        scanned += 1;
        if (rules.check(join(t.real, ent.name)) === 'protected') {
          hiddenProtected += 1;
          continue;
        }
        if (!opts.hidden && ent.name.startsWith('.')) continue;
        const type: ScanItem['type'] = ent.isDirectory() ? 'dir' : ent.isSymbolicLink() ? 'link' : ent.isFile() ? 'file' : 'other';
        if (opts.dirsOnly && type !== 'dir' && type !== 'link') continue;
        items.push({ name: ent.name, type });
      }
    } catch (e) {
      return this.fsRefusal(e);
    } finally {
      await dir.close().catch(() => undefined);
    }
    // The dir must still be the one checked above (not swapped for a link while it was read).
    try {
      const after = await fsx.lstat(t.real);
      if (after.ino !== t.st.ino || after.dev !== t.st.dev) return refuse('outside');
    } catch (e) {
      return this.fsRefusal(e);
    }
    items.sort(compareItems);
    return { real: t.real, rel: t.rel, root: t.root, display: t.display, items, hiddenProtected, truncated };
  }

  /**
   * lstat each item (in `dir`) for its entry: size and mtime for files and
   * dirs; for a link, where it leads (`inside` the root, `outside`, or
   * `broken`). A link to a protected target is left out and counted; with
   * `dirsOnly`, links that do not lead to a dir inside the root are dropped.
   * Entries that vanished since the scan are dropped.
   */
  async describe(dir: Pick<ScannedDir, 'real' | 'root'>, items: readonly ScanItem[], dirsOnly = false): Promise<{ entries: DirEntryInfo[]; hiddenProtected: number }> {
    const rules = this.rules();
    let hiddenProtected = 0;
    const out = await mapLimited(items, 32, async (item): Promise<DirEntryInfo | null> => {
      const abs = join(dir.real, item.name);
      let l: BigIntStats;
      try {
        l = await fsx.lstat(abs);
      } catch {
        return null;
      }
      const mtimeMs = Number(l.mtimeMs);
      if (l.isDirectory()) return { name: item.name, type: 'dir', mtimeMs };
      if (l.isFile()) return dirsOnly ? null : { name: item.name, type: 'file', size: Number(l.size), mtimeMs };
      if (!l.isSymbolicLink()) return dirsOnly ? null : { name: item.name, type: 'other' };
      let target: string;
      try {
        target = await fsx.realpath(abs);
      } catch {
        return dirsOnly ? null : { name: item.name, type: 'link', link: 'broken' };
      }
      if (rules.check(target) !== 'ok') {
        hiddenProtected += 1;
        return null;
      }
      const where = inside(target, dir.root.real) ? 'inside' : 'outside';
      if (dirsOnly) {
        if (where !== 'inside') return null;
        try {
          if (!(await fsx.stat(target)).isDirectory()) return null;
        } catch {
          return null;
        }
      }
      return { name: item.name, type: 'link', link: where };
    });
    return { entries: out.filter((e): e is DirEntryInfo => e !== null), hiddenProtected };
  }

  /**
   * The checks every directory goes through (same order as openForRead).
   * `ancestor`: a home dot dir on the way to a `folders.allow` entry may be
   * listed (its children are judged one by one), never resolved as a folder.
   */
  private async dirTarget(rootId: string, rel: string, ancestorOk: boolean): Promise<DirTarget | FileRefusal> {
    const root = await this.root(rootId);
    if (!root) return refuse('no_root');
    const segs = parseRel(rel);
    if (!segs) return refuse('bad_path');
    const rules = this.rules();
    const okVerdict = (v: DenyVerdict) => v === 'ok' || (ancestorOk && v === 'ancestor');
    const lexical = join(root.real, ...segs);
    if (!okVerdict(rules.check(lexical))) return refuse('protected');
    let real: string;
    try {
      real = await fsx.realpath(lexical);
    } catch (e) {
      return this.unresolved(e, root, segs, rules, okVerdict);
    }
    if (!inside(real, root.real)) return refuse('outside');
    if (!okVerdict(rules.check(real))) return refuse('protected');
    let st: BigIntStats;
    try {
      st = await fsx.lstat(real);
    } catch (e) {
      return this.fsRefusal(e);
    }
    if (st.isSymbolicLink()) return refuse('outside');
    if (!st.isDirectory()) return refuse('not_dir');
    const relPath = segs.join('/');
    return { root, rel: relPath, real, st, display: relPath === '' ? root.display : `${root.display}/${relPath}` };
  }

  /**
   * The refusal for a client path that realpath could not resolve, judged
   * where it would be: its deepest existing parent's realpath plus the rest.
   * It is `missing` only when that is inside the root and passes `ok`.
   * Behind a link out of the root it is `outside`, and behind a link into a
   * protected dir `protected`, as an existing path there is, so a phone
   * cannot test which paths exist beyond the link. Parents are prefixes of
   * a path the lexical check passed.
   */
  private async unresolved(e: unknown, root: ResolvedRoot, segs: readonly string[], rules: DenyRules, ok: (v: DenyVerdict) => boolean): Promise<FileRefusal> {
    const code = errCode(e);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return this.fsRefusal(e);
    for (let n = segs.length - 1; n > 0; n--) {
      let parent: string;
      try {
        parent = await fsx.realpath(join(root.real, ...segs.slice(0, n)));
      } catch {
        continue;
      }
      if (!inside(parent, root.real)) return refuse('outside');
      if (!ok(rules.check(join(parent, ...segs.slice(n))))) return refuse('protected');
      break;
    }
    return refuse('missing');
  }

  private fsRefusal(e: unknown): FileRefusal {
    switch (errCode(e)) {
      case 'ENOENT':
      case 'ENOTDIR':
        return refuse('missing');
      case 'EPERM':
        return refuse('os_permission');
      case 'EACCES':
        return refuse('os_permission', 'Jantar is not allowed to read that (file permissions).');
      case 'ELOOP':
        // O_NOFOLLOW met a symlink: the file was swapped after realpath.
        return refuse('outside');
      case 'ENAMETOOLONG':
        return refuse('bad_path');
      case 'ENXIO':
      case 'ENODEV':
      case 'EOPNOTSUPP':
        return refuse('not_file');
      default:
        // The code only: an error's message names the path.
        this.ctx.log.warn('files: unexpected file system error', { code: errCode(e) || 'unknown' });
        return refuse('missing', 'Jantar could not read that path.');
    }
  }
}
