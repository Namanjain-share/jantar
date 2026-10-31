/**
 * The folders Files and New session may browse (settings folders.*, Mac
 * only): configured roots, and `folders.allow` exceptions for home dot paths.
 *
 * The CLI checks a new root the way the daemon resolves one (files/roots.ts):
 * by name before touching the disk, then by its realpath, against the same
 * hard denylist (DenyRules from the daemon package, both forms of $HOME and
 * of the state dir). `/`, `/Users`, `~/Library`, home dot dirs and anything
 * the denylist protects are refused here, and the daemon refuses them again
 * at load whatever config.json says.
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, normalize, resolve } from 'node:path';
import type { Paths } from '@jantar/daemon';
import { DenyRules, expandHome, segsOf } from '@jantar/daemon/files/deny';
import { rootRefusal } from '@jantar/daemon/files/roots';
import { RootIdSchema, type FolderRoot, type Settings } from '@jantar/protocol';
import { hasControlChars } from './switches.js';

type Folders = Settings['folders'];
type HomePaths = Pick<Paths, 'userHome' | 'home'>;

/** FoldersSettingsSchema's limits. */
export const ROOTS_MAX = 20;
export const ALLOW_MAX = 50;
export const LABEL_MAX = 32;
const ID_MAX = 24;

/** A path as typed: "~" and "~/x" against $HOME, a relative path against the current directory. */
export function expandPath(input: string, userHome: string): string {
  return resolve(expandHome(input.trim(), userHome));
}

/** "~/Desktop/work" for a path under $HOME, else the path itself. */
export function displayPath(abs: string, userHome: string): string {
  const home = normalize(userHome).replace(/\/+$/, '');
  if (abs === home) return '~';
  return abs.startsWith(`${home}/`) ? `~/${abs.slice(home.length + 1)}` : abs;
}

async function realOr(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** A path and its realpath when they differ (a home under /var is /private/var once resolved). */
async function forms(p: string): Promise<string[]> {
  const n = normalize(p);
  const r = await realOr(n);
  return r && r !== n ? [n, r] : [n];
}

/** The denylist as the daemon compiles it for these folders settings. */
export async function denyRulesFor(paths: HomePaths, folders: Folders): Promise<DenyRules> {
  const extraReal: string[] = [];
  for (const raw of folders.extraDeny) {
    const abs = normalize(expandHome(raw.trim(), paths.userHome));
    if (!isAbsolute(abs)) continue;
    const r = await realOr(abs);
    if (r && r !== abs && !extraReal.includes(r)) extraReal.push(r);
  }
  return new DenyRules({
    homes: await forms(paths.userHome),
    stateDirs: await forms(paths.home),
    extraDeny: [...folders.extraDeny, ...extraReal],
    allow: folders.allow,
  });
}

/** Why an absolute path cannot be a root, or null when it can: the daemon's own check. */
export { rootRefusal };

export type RootCheck = { ok: true; real: string } | { ok: false; reason: string };

/** Whether `input` may become a root: refused by name first, then it must be a folder, then refused by its realpath. */
export async function checkRoot(input: string, paths: HomePaths, folders: Folders): Promise<RootCheck> {
  const abs = expandPath(input, paths.userHome);
  const rules = await denyRulesFor(paths, folders);
  const lexical = rootRefusal(abs, rules);
  if (lexical) return { ok: false, reason: `${abs} is ${lexical}: the phone never browses it` };
  const real = await realOr(abs);
  if (!real) return { ok: false, reason: `${abs} does not exist` };
  try {
    if (!(await stat(real)).isDirectory()) return { ok: false, reason: `${abs} is not a folder` };
  } catch {
    return { ok: false, reason: `${abs} cannot be read` };
  }
  const why = rootRefusal(real, rules);
  if (why) return { ok: false, reason: `${abs} leads to ${real}, ${why}: the phone never browses it` };
  return { ok: true, real };
}

/** A root id from a folder name: "Desktop" gives "desktop", "My Work" gives "my-work"; "-2", "-3" when taken. */
export function rootIdFrom(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, ID_MAX)
      .replace(/-+$/, '') || 'root';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const id = `${base.slice(0, ID_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(id)) return id;
  }
  return base;
}

/** "work" or "r.work" as the id stored in settings. */
export function bareRootId(id: string): string {
  return id.startsWith('r.') ? id.slice(2) : id;
}

export type RootAdd = { ok: true; root: FolderRoot; roots: FolderRoot[] } | { ok: false; reason: string };

/** The roots after adding `real` (already checked): its id and label, refusing a taken id or a folder that is already a root. */
export async function addRoot(
  folders: Folders,
  real: string,
  opts: { id?: string; label?: string; userHome: string },
): Promise<RootAdd> {
  if (folders.roots.length >= ROOTS_MAX) return { ok: false, reason: `there are already ${ROOTS_MAX} roots; remove one first` };
  for (const r of folders.roots) {
    const theirs = await realOr(expandPath(r.path, opts.userHome));
    if (theirs === real) return { ok: false, reason: `${displayPath(real, opts.userHome)} is already a root (${r.id})` };
  }
  const taken = new Set(folders.roots.map((r) => r.id));
  const atHome = normalize(real) === normalize((await realOr(opts.userHome)) ?? opts.userHome);
  let id: string;
  if (opts.id !== undefined) {
    id = bareRootId(opts.id);
    if (!RootIdSchema.safeParse(id).success) return { ok: false, reason: `--id must be 1 to 24 of a-z, 0-9 and "-", starting with a letter or digit` };
    if (taken.has(id)) return { ok: false, reason: `a root with id ${id} already exists` };
  } else {
    id = rootIdFrom(atHome ? 'home' : basename(real), taken);
  }
  let label: string;
  if (opts.label !== undefined) {
    label = opts.label.trim();
    if (!label || label.length > LABEL_MAX || hasControlChars(label)) return { ok: false, reason: `--label must be 1 to ${LABEL_MAX} printable characters` };
  } else {
    label = (atHome ? 'Home' : basename(real)).replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim().slice(0, LABEL_MAX).trim() || id;
  }
  const root: FolderRoot = { id, path: real, label };
  return { ok: true, root, roots: [...folders.roots, root] };
}

/** Why a configured root is not served now (missing, refused), or null when the daemon would serve it. */
export async function rootProblem(root: FolderRoot, paths: HomePaths, rules: DenyRules): Promise<string | null> {
  const abs = normalize(expandHome(root.path, paths.userHome));
  if (!isAbsolute(abs)) return 'not an absolute path';
  const lexical = rootRefusal(abs, rules);
  if (lexical) return `refused: ${lexical}`;
  const real = await realOr(abs);
  if (!real) return 'missing';
  try {
    if (!(await stat(real)).isDirectory()) return 'not a folder';
  } catch {
    return 'missing';
  }
  const why = rootRefusal(real, rules);
  return why ? `refused: ${why}` : null;
}

export type AllowCheck = { ok: true; entry: string } | { ok: false; reason: string };

/**
 * A `folders.allow` entry ("~/.config/nvim") for a home dot path. Anything
 * else needs no exception, and an exception never opens what the hard
 * denylist names (~/.ssh, ~/.claude*, ~/.config/gh, ...).
 */
export async function checkAllow(input: string, paths: HomePaths, folders: Folders): Promise<AllowCheck> {
  const abs = expandPath(input, paths.userHome);
  if (hasControlChars(abs)) return { ok: false, reason: 'the path holds a control character' };
  const rules = await denyRulesFor(paths, folders);
  const segs = segsOf(abs);
  const rel = rules.homeRel(segs);
  if (rel === null) return { ok: false, reason: `${abs} is not in your home folder; only home dot paths (like ~/.config/nvim) need allowing` };
  const own = abs.split('/').filter((s) => s !== '').slice(segs.length - rel.length);
  if (own.length === 0 || !(own[0] as string).startsWith('.')) {
    return { ok: false, reason: `${displayPath(abs, paths.userHome)} is not a hidden home folder: under a root it shows without an exception` };
  }
  const entry = `~/${own.join('/')}`;
  const after = await denyRulesFor(paths, { ...folders, allow: [...folders.allow, entry] });
  if (after.check(abs) !== 'ok') return { ok: false, reason: `${entry} stays protected: the hard denylist covers it, and an exception can't open it` };
  return { ok: true, entry };
}

/** The allow entry `input` names, as stored (the "~/..." form or exactly as written). */
export function findAllow(allow: readonly string[], input: string, userHome: string): string | null {
  const abs = expandPath(input, userHome);
  const tilde = displayPath(abs, userHome);
  return allow.find((a) => a === input || a === tilde || expandPath(a, userHome) === abs) ?? null;
}
