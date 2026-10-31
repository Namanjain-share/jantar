/**
 * Installs, removes and inspects Jantar's Claude Code hooks in a GIVEN
 * settings.json (docs/hook-protocol.md section 4).
 *
 * - Merge, never replace: every existing key and hook entry is kept (e.g.
 *   `cleanupPeriodDays` and another tool's PreToolUse hook). Our groups are
 *   appended to each event's list.
 * - Our entries are recognised by their command path (`.../jantar-hook`, or
 *   `.../ccw-v2-hook` from before the rename to Jantar, which install
 *   replaces), so uninstall removes exactly those, and drops groups / event
 *   keys / the `hooks` key only when they became empty because of it.
 * - Refuses when the file does not parse or has an unexpected shape.
 * - Writes atomically onto the REAL file (symlinks are resolved first), so
 *   cswap profile settings that are symlinks keep pointing at it. The file's
 *   mode, indentation and trailing newline are kept. A byte-exact backup
 *   `<file>.jantar-backup-<timestamp>` (0600) is made first.
 * - plan*() functions only read; install/uninstall write when something
 *   changes and the file is still what the plan saw.
 */
import { realpathSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { HOOK_CLIENT_PATH, WAIT_FLAG } from '@jantar/hook';
import { HOOK_EVENT_NAMES, HOOK_NAME, LEGACY_HOOK_NAME, type HookEventName } from '@jantar/protocol';
import { writeFileAtomic } from '../config.js';
import { canonicalJson } from '../core/hash.js';
import { unifiedDiff } from './diff.js';
import { isPlainObject } from './keys.js';

/** Events whose group gets `"matcher": "*"` (tool and notification events). */
export const MATCHER_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
]);
/** Seconds. When it passes Claude simply keeps its own dialog, so a long wait is harmless. */
export const BLOCKING_TIMEOUT_S = 86_400;
export const ASYNC_TIMEOUT_S = 5;

export interface HookCommandSpec {
  /** Absolute path of the node binary (hooks run with whatever PATH Claude has). */
  node: string;
  /** Absolute path of the installed client, normally <state dir>/bin/jantar-hook. */
  hookBin: string;
}

export interface HookCommand {
  type: 'command';
  command: string;
  async?: boolean;
  timeout: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

const UNSAFE_IN_COMMAND = /["$`\\\n\r]/;

export class UnsafePathError extends Error {}

function checkPath(label: string, p: string): void {
  if (!isAbsolute(p)) throw new UnsafePathError(`${label} must be an absolute path: ${p}`);
  if (UNSAFE_IN_COMMAND.test(p)) throw new UnsafePathError(`${label} contains a character that is unsafe in a hook command: ${p}`);
}

/** `"<node>" "<hookBin>"` (+ ` --wait`). Claude runs hook commands through a shell. */
export function hookCommandLine(spec: HookCommandSpec, wait = false): string {
  checkPath('node path', spec.node);
  checkPath('hook client path', spec.hookBin);
  return `"${spec.node}" "${spec.hookBin}"${wait ? ` ${WAIT_FLAG}` : ''}`;
}

/** The group Jantar registers for `event`. */
export function desiredGroup(event: HookEventName, spec: HookCommandSpec): HookGroup {
  if (event === 'PermissionRequest') {
    return { matcher: '*', hooks: [{ type: 'command', command: hookCommandLine(spec, true), timeout: BLOCKING_TIMEOUT_S }] };
  }
  const hook: HookCommand = { type: 'command', command: hookCommandLine(spec), async: true, timeout: ASYNC_TIMEOUT_S };
  return MATCHER_EVENTS.has(event) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] };
}

/** Every group Jantar registers, keyed by event. */
export function desiredHooks(spec: HookCommandSpec): Record<HookEventName, HookGroup[]> {
  const out = {} as Record<HookEventName, HookGroup[]>;
  for (const ev of HOOK_EVENT_NAMES) out[ev] = [desiredGroup(ev, spec)];
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OUR_COMMAND_RE = new RegExp(`(^|[\\s"'/])(?:${escapeRe(HOOK_NAME)}|${escapeRe(LEGACY_HOOK_NAME)})(?=$|[\\s"'])`);

/** A hook command that runs jantar-hook, or ccw-v2's ccw-v2-hook (any install location, any node path). */
export function isOurCommand(command: string): boolean {
  return OUR_COMMAND_RE.test(command);
}

function isOurHook(h: unknown): boolean {
  return isPlainObject(h) && typeof h.command === 'string' && isOurCommand(h.command);
}

// ---------------------------------------------------------------------------
// Reading

export type HooksErrorCode =
  | 'parse_error'
  | 'invalid_shape'
  | 'read_error'
  | 'changed'
  | 'write_error'
  | 'unsafe_path'
  | 'refused';

export interface HooksFailure {
  ok: false;
  code: HooksErrorCode;
  message: string;
  settingsPath: string;
}

interface LoadedSettings {
  settingsPath: string;
  realPath: string;
  isSymlink: boolean;
  exists: boolean;
  raw: string;
  mode: number;
  data: Record<string, unknown>;
}

function failure(settingsPath: string, code: HooksErrorCode, message: string): HooksFailure {
  return { ok: false, code, message, settingsPath };
}

async function loadSettingsFile(settingsPathIn: string): Promise<LoadedSettings | HooksFailure> {
  const settingsPath = resolve(settingsPathIn);
  let isSymlink = false;
  let realPath = settingsPath;
  try {
    const st = await lstat(settingsPath);
    isSymlink = st.isSymbolicLink();
    // Always the fully resolved path: the file that is really written, and
    // what profile symlinks resolve to (on macOS /var itself is a symlink).
    realPath = await realpath(settingsPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !isSymlink) {
      const parent = await realpath(dirname(settingsPath)).catch(() => dirname(settingsPath));
      realPath = join(parent, basename(settingsPath));
      return { settingsPath, realPath, isSymlink: false, exists: false, raw: '', mode: 0o600, data: {} };
    }
    return failure(settingsPath, 'read_error', `cannot resolve ${settingsPath}: ${(e as Error).message}`);
  }
  let raw: string;
  let mode: number;
  try {
    const st = await stat(realPath);
    if (!st.isFile()) return failure(settingsPath, 'read_error', `${realPath} is not a regular file`);
    mode = st.mode & 0o777;
    raw = await readFile(realPath, 'utf8');
  } catch (e) {
    return failure(settingsPath, 'read_error', `cannot read ${realPath}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return failure(settingsPath, 'parse_error', `${realPath} is not valid JSON (${(e as Error).message}); nothing was changed`);
  }
  if (!isPlainObject(data)) return failure(settingsPath, 'invalid_shape', `${realPath} is not a JSON object; nothing was changed`);
  if (data.hooks !== undefined && !isPlainObject(data.hooks)) {
    return failure(settingsPath, 'invalid_shape', `"hooks" in ${realPath} is not an object; nothing was changed`);
  }
  return { settingsPath, realPath, isSymlink, exists: true, raw, mode, data };
}

interface Format {
  indent: string | number;
  newline: boolean;
}

function detectFormat(raw: string): Format {
  if (raw.trim() === '') return { indent: 2, newline: true };
  const newline = raw.endsWith('\n');
  const body = raw.trim();
  if (!body.includes('\n')) return { indent: body.length <= 2 ? 2 : 0, newline };
  const m = raw.match(/\n([ \t]+)\S/);
  return { indent: m ? (m[1] as string) : 2, newline };
}

function serialize(data: unknown, fmt: Format): string {
  return `${JSON.stringify(data, null, fmt.indent)}${fmt.newline ? '\n' : ''}`;
}

/** Copy of an object with `key` replaced (or appended), keeping key order. */
function withKey(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k === key ? value : v]));
  }
  return Object.fromEntries([...Object.entries(obj), [key, value]]);
}

function withoutKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

/** Remove our hook entries from a list of groups. Groups emptied by that are dropped. */
function stripOurs(groups: unknown[]): { groups: unknown[]; removed: number } {
  const out: unknown[] = [];
  let removed = 0;
  for (const g of groups) {
    if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
      out.push(g);
      continue;
    }
    const kept = g.hooks.filter((h) => !isOurHook(h));
    const n = g.hooks.length - kept.length;
    if (n === 0) {
      out.push(g);
      continue;
    }
    removed += n;
    if (kept.length > 0) out.push(withKey(g, 'hooks', kept));
  }
  return { groups: out, removed };
}

function countOurs(groups: unknown[]): number {
  let n = 0;
  for (const g of groups) if (isPlainObject(g) && Array.isArray(g.hooks)) n += g.hooks.filter(isOurHook).length;
  return n;
}

const OUR_EVENTS: ReadonlySet<string> = new Set<string>(HOOK_EVENT_NAMES);

type EditResult = { ok: true; data: Record<string, unknown>; events: string[] } | { ok: false; message: string };

function computeInstall(data: Record<string, unknown>, spec: HookCommandSpec): EditResult {
  const hooks = isPlainObject(data.hooks) ? data.hooks : undefined;
  const next: Record<string, unknown> = {};
  const events: string[] = [];
  for (const [ev, val] of Object.entries(hooks ?? {})) {
    if (OUR_EVENTS.has(ev)) {
      if (!Array.isArray(val)) return { ok: false, message: `"hooks.${ev}" is not a list; nothing was changed` };
      const desired = desiredGroup(ev as HookEventName, spec);
      const oursAt = val.filter((g) => isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurHook));
      if (countOurs(val) === 1 && oursAt.length === 1 && canonicalJson(oursAt[0]) === canonicalJson(desired)) {
        next[ev] = val;
        continue;
      }
      next[ev] = [...stripOurs(val).groups, desired];
      events.push(ev);
    } else if (Array.isArray(val)) {
      // Our entry under an event we no longer register: remove it.
      const { groups, removed } = stripOurs(val);
      if (removed === 0) next[ev] = val;
      else {
        events.push(ev);
        if (groups.length > 0) next[ev] = groups;
      }
    } else {
      next[ev] = val;
    }
  }
  for (const ev of HOOK_EVENT_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(next, ev)) {
      next[ev] = [desiredGroup(ev, spec)];
      events.push(ev);
    }
  }
  return { ok: true, data: events.length ? withKey(data, 'hooks', next) : data, events };
}

function computeUninstall(data: Record<string, unknown>): EditResult {
  const hooks = isPlainObject(data.hooks) ? data.hooks : undefined;
  if (!hooks) return { ok: true, data, events: [] };
  const next: Record<string, unknown> = {};
  const events: string[] = [];
  for (const [ev, val] of Object.entries(hooks)) {
    if (!Array.isArray(val)) {
      next[ev] = val;
      continue;
    }
    const { groups, removed } = stripOurs(val);
    if (removed === 0) {
      next[ev] = val;
      continue;
    }
    events.push(ev);
    if (groups.length > 0) next[ev] = groups;
  }
  if (events.length === 0) return { ok: true, data, events };
  return {
    ok: true,
    data: Object.keys(next).length === 0 ? withoutKey(data, 'hooks') : withKey(data, 'hooks', next),
    events,
  };
}

// ---------------------------------------------------------------------------
// Plans

export interface HooksTarget {
  /** The settings file to edit (e.g. ~/.claude/settings.json). Symlinks are followed. */
  settingsPath: string;
}

export interface HooksInstallOptions extends HooksTarget, HookCommandSpec {
  /** Compute and return the plan only. */
  dryRun?: boolean;
  /** Back up before writing (default true). */
  backup?: boolean;
  /** Refuse to write unless the file still has exactly this content (the text the shown diff was made from). */
  expectedBefore?: string;
  /** Clock for the backup name. */
  now?: () => Date;
}

export type HooksUninstallOptions = Omit<HooksInstallOptions, 'node' | 'hookBin'>;

export interface HooksPlan {
  ok: true;
  action: 'install' | 'uninstall';
  settingsPath: string;
  /** The file actually written (the symlink target when settingsPath is a link). */
  realPath: string;
  isSymlink: boolean;
  exists: boolean;
  mode: number;
  changed: boolean;
  before: string;
  after: string;
  /** Unified diff of before -> after ('' when unchanged). */
  diff: string;
  /** Events whose entries change. */
  events: string[];
}

export interface HooksWritten extends HooksPlan {
  written: boolean;
  backupPath?: string;
}

function makePlan(action: 'install' | 'uninstall', loaded: LoadedSettings, edit: EditResult): HooksPlan | HooksFailure {
  if (!edit.ok) return failure(loaded.settingsPath, 'invalid_shape', edit.message);
  const fmt = detectFormat(loaded.raw);
  const after = edit.events.length ? serialize(edit.data, fmt) : loaded.raw;
  const changed = after !== loaded.raw && (loaded.exists || edit.events.length > 0);
  return {
    ok: true,
    action,
    settingsPath: loaded.settingsPath,
    realPath: loaded.realPath,
    isSymlink: loaded.isSymlink,
    exists: loaded.exists,
    mode: loaded.mode,
    changed,
    before: loaded.raw,
    after,
    diff: changed
      ? unifiedDiff(loaded.raw, after, { fromLabel: `${loaded.realPath} (current)`, toLabel: `${loaded.realPath} (after ${action})` })
      : '',
    events: edit.events,
  };
}

export async function planInstall(opts: HooksTarget & HookCommandSpec): Promise<HooksPlan | HooksFailure> {
  try {
    hookCommandLine(opts);
  } catch (e) {
    return failure(resolve(opts.settingsPath), 'unsafe_path', (e as Error).message);
  }
  const loaded = await loadSettingsFile(opts.settingsPath);
  if (!('raw' in loaded)) return loaded;
  return makePlan('install', loaded, computeInstall(loaded.data, opts));
}

export async function planUninstall(opts: HooksTarget): Promise<HooksPlan | HooksFailure> {
  const loaded = await loadSettingsFile(opts.settingsPath);
  if (!('raw' in loaded)) return loaded;
  if (!loaded.exists) return makePlan('uninstall', loaded, { ok: true, data: {}, events: [] });
  return makePlan('uninstall', loaded, computeUninstall(loaded.data));
}

// ---------------------------------------------------------------------------
// Writing

/**
 * Safety net: a test run must never edit the real user's Claude settings,
 * whatever HOME says (the passwd home is used).
 */
export function guardRealFilesForTests(path: string, what: string): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') return;
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    return;
  }
  const real = [join(home, '.claude'), join(home, '.claude-swap-backup'), join(home, '.jantar'), join(home, '.ccw-v2'), join(home, '.config', 'ccw')];
  const resolved = real.map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  for (const root of [...real, ...resolved]) {
    if (path === root || path.startsWith(`${root}/`)) {
      throw new Error(`refusing to write ${what} under the real ${root} from a test run`);
    }
  }
}

function backupStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function makeBackup(realPath: string, now: Date): Promise<string> {
  const stamp = backupStamp(now);
  for (let i = 0; i < 1000; i++) {
    const p = `${realPath}.jantar-backup-${stamp}${i ? `-${i}` : ''}`;
    try {
      await copyFile(realPath, p, fsConstants.COPYFILE_EXCL);
      await chmod(p, 0o600);
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new Error('could not choose a backup file name');
}

async function writePlan(plan: HooksPlan, opts: HooksUninstallOptions): Promise<HooksWritten | HooksFailure> {
  try {
    guardRealFilesForTests(plan.realPath, 'Claude settings');
  } catch (e) {
    return failure(plan.settingsPath, 'refused', (e as Error).message);
  }
  // The file must still be exactly what the plan (and the diff the user saw) was made from.
  let current: string | null;
  try {
    current = await readFile(plan.realPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return failure(plan.settingsPath, 'read_error', `cannot read ${plan.realPath}: ${(e as Error).message}`);
    }
    current = null;
  }
  if ((current ?? '') !== plan.before || (current === null) === plan.exists) {
    return failure(plan.settingsPath, 'changed', `${plan.realPath} changed while the update was being prepared; nothing was written`);
  }
  let backupPath: string | undefined;
  try {
    if (plan.exists && opts.backup !== false) backupPath = await makeBackup(plan.realPath, (opts.now ?? (() => new Date()))());
    if (!plan.exists) await mkdir(dirname(plan.realPath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(plan.realPath, plan.after, { mode: plan.exists ? plan.mode : 0o600 });
  } catch (e) {
    return failure(plan.settingsPath, 'write_error', `could not write ${plan.realPath}: ${(e as Error).message}`);
  }
  return { ...plan, written: true, ...(backupPath ? { backupPath } : {}) };
}

async function applyPlan(plan: HooksPlan | HooksFailure, opts: HooksUninstallOptions): Promise<HooksWritten | HooksFailure> {
  if (!plan.ok) return plan;
  if (opts.expectedBefore !== undefined && opts.expectedBefore !== plan.before) {
    return failure(plan.settingsPath, 'changed', `${plan.realPath} changed since the diff was shown; nothing was written`);
  }
  if (!plan.changed || opts.dryRun) return { ...plan, written: false };
  return writePlan(plan, opts);
}

/** Merge Jantar's hooks into the settings file (see the module comment). */
export async function installHooks(opts: HooksInstallOptions): Promise<HooksWritten | HooksFailure> {
  return applyPlan(await planInstall(opts), opts);
}

/** Remove exactly Jantar's hook entries from the settings file. */
export async function uninstallHooks(opts: HooksUninstallOptions): Promise<HooksWritten | HooksFailure> {
  return applyPlan(await planUninstall(opts), opts);
}

// ---------------------------------------------------------------------------
// Status

export type EventInstallState = 'ok' | 'missing' | 'outdated' | 'duplicate';

export interface ProfileLink {
  /** Profile dir name; the leading number is the cswap slot. */
  name: string;
  /** linked = a symlink to the target file; separate = its own file (gets no hooks); missing = no settings.json. */
  settings: 'linked' | 'separate' | 'missing';
}

export interface HooksStatus {
  ok: boolean;
  settingsPath: string;
  realPath?: string;
  isSymlink: boolean;
  exists: boolean;
  error?: { code: HooksErrorCode; message: string };
  state: 'installed' | 'partial' | 'outdated' | 'not-installed' | 'unreadable';
  events: Array<{ event: HookEventName; state: EventInstallState }>;
  /** Our entries under events Jantar does not register. */
  strayEntries: number;
  /** The command the installer would register (without --wait). */
  command: string;
  hookBin: string;
  hookBinPresent: boolean;
  /** The installed client is byte-equal to the one shipped with this version. */
  hookBinCurrent: boolean;
  profiles?: ProfileLink[];
}

export interface HooksStatusOptions extends HooksTarget, HookCommandSpec {
  /** cswap profiles dir (each profile's settings.json should be a symlink to the target). */
  profilesDir?: string;
  /** Client to compare the installed copy with. Default: the shipped client. */
  clientSource?: string;
}

async function profileLinks(profilesDir: string, target: string): Promise<ProfileLink[]> {
  let names: string[];
  try {
    names = (await readdir(profilesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const out: ProfileLink[] = [];
  for (const name of names) {
    const p = join(profilesDir, name, 'settings.json');
    let settings: ProfileLink['settings'] = 'missing';
    try {
      const st = await lstat(p);
      // A link to the target, or the target itself (`--settings <a slot's own file>`); a link to nothing is no file.
      const real = await realpath(p).catch(() => null);
      settings = real === null ? 'missing' : real === target ? 'linked' : 'separate';
      if (real !== null && !st.isSymbolicLink() && !st.isFile()) settings = 'separate';
    } catch {
      settings = 'missing';
    }
    out.push({ name, settings });
  }
  return out;
}

export async function hooksStatus(opts: HooksStatusOptions): Promise<HooksStatus> {
  let command = '';
  try {
    command = hookCommandLine(opts);
  } catch {
    command = '';
  }
  let hookBinPresent = false;
  let hookBinCurrent = false;
  try {
    const cur = await readFile(opts.hookBin);
    hookBinPresent = true;
    const shipped = await readFile(opts.clientSource ?? HOOK_CLIENT_PATH);
    hookBinCurrent = cur.equals(shipped);
  } catch {
    // not installed
  }
  const base = { command, hookBin: opts.hookBin, hookBinPresent, hookBinCurrent };
  const loaded = await loadSettingsFile(opts.settingsPath);
  if (!('raw' in loaded)) {
    return {
      ok: false,
      settingsPath: loaded.settingsPath,
      isSymlink: false,
      exists: true,
      error: { code: loaded.code, message: loaded.message },
      state: 'unreadable',
      events: [],
      strayEntries: 0,
      ...base,
    };
  }
  const hooks = isPlainObject(loaded.data.hooks) ? loaded.data.hooks : {};
  const events: HooksStatus['events'] = [];
  for (const ev of HOOK_EVENT_NAMES) {
    const val = hooks[ev];
    const groups = Array.isArray(val) ? val : [];
    const n = countOurs(groups);
    let state: EventInstallState = 'missing';
    if (n > 1) state = 'duplicate';
    else if (n === 1) {
      const g = groups.find((x) => isPlainObject(x) && Array.isArray(x.hooks) && x.hooks.some(isOurHook));
      state = command && canonicalJson(g) === canonicalJson(desiredGroup(ev, opts)) ? 'ok' : 'outdated';
    }
    events.push({ event: ev, state });
  }
  let strayEntries = 0;
  for (const [ev, val] of Object.entries(hooks)) {
    if (!OUR_EVENTS.has(ev) && Array.isArray(val)) strayEntries += countOurs(val);
  }
  const okCount = events.filter((e) => e.state === 'ok').length;
  const missing = events.filter((e) => e.state === 'missing').length;
  let state: HooksStatus['state'];
  if (okCount === events.length && strayEntries === 0) state = 'installed';
  else if (missing === events.length && strayEntries === 0) state = 'not-installed';
  else if (missing === 0) state = 'outdated';
  else state = 'partial';
  const out: HooksStatus = {
    ok: true,
    settingsPath: loaded.settingsPath,
    realPath: loaded.realPath,
    isSymlink: loaded.isSymlink,
    exists: loaded.exists,
    state,
    events,
    strayEntries,
    ...base,
  };
  if (opts.profilesDir) out.profiles = await profileLinks(opts.profilesDir, loaded.realPath);
  return out;
}

// ---------------------------------------------------------------------------
// The client file

/**
 * Copy the shipped hook client to `hookBin` (atomic, 0700). The copy has no
 * file extension; the client is written to run as CommonJS or ES module.
 */
export async function installHookClient(opts: { hookBin: string; source?: string }): Promise<{ changed: boolean; path: string }> {
  const target = resolve(opts.hookBin);
  guardRealFilesForTests(target, 'the hook client');
  const src = await readFile(opts.source ?? HOOK_CLIENT_PATH);
  try {
    const cur = await readFile(target);
    const mode = (await stat(target)).mode & 0o777;
    if (cur.equals(src) && mode === 0o700) return { changed: false, path: target };
  } catch {
    // not there yet
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFileAtomic(target, src, { mode: 0o700 });
  return { changed: true, path: target };
}

/** The backup files next to `settingsPath` made by install/uninstall, oldest first. */
export async function listBackups(settingsPath: string): Promise<string[]> {
  let real = resolve(settingsPath);
  try {
    real = await realpath(real);
  } catch {
    // keep as is
  }
  const prefix = `${basename(real)}.jantar-backup-`;
  try {
    return (await readdir(dirname(real)))
      .filter((n) => n.startsWith(prefix))
      .sort()
      .map((n) => join(dirname(real), n));
  } catch {
    return [];
  }
}
