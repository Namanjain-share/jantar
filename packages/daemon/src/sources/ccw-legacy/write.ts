/**
 * 0.14.0: the one place Jantar writes into ~/.config/ccw: the owner's
 * switching rules, into ccw's switch.json, when he taps Save on the
 * Accounts screen's Switching rules sheet (PATCH /v1/accounts/switching,
 * api/routes/switching.ts). Nothing else here, and nothing in the read
 * side (files.ts, index.ts), ever writes there.
 *
 * - Only the five keys the sheet edits change: hold, ceiling,
 *   weekly_ceiling, lead_min and weekly_ramp (snake_case, as ccw spells
 *   them). Every other key stays as it was parsed: same names, same order,
 *   same values (written back as JSON with two-space indents, the way ccw's
 *   own json.dump(indent=2) writes the file).
 * - A file that won't parse is never written into: the save is refused
 *   (409) and the file is left as it is. So is a missing one (ccw writes
 *   it on its first start), and one that changes while the save runs.
 * - The file as it was and the new one are each written to a temp file in
 *   the same folder (0600, fsynced). switch.json is read again, and must be
 *   as it was, before each temp file is written and once more before the
 *   two are renamed into place: switch.json.prev first, then switch.json,
 *   so ccw reads either the old file or the new one, never half. A save
 *   that finds the file changed (409) leaves both, and switch.json.prev,
 *   as they were.
 * - Its own temp files (.switch.json.jantar-<pid>-<hex>.tmp and
 *   .switch.json.prev.jantar-…) left by a save that never finished (the
 *   daemon stopped mid-save) are removed by the next save. Nothing else in
 *   the folder is touched.
 * - One save at a time per file (a second waits for the first).
 * - A switch.json that is a symlink is read through it, and the save puts
 *   a regular file in its place (the link's target is left as it was), as
 *   ccw's own save (os.replace) does.
 *
 * ccw reads switch.json every couple of seconds, so it uses a saved rule
 * within a minute. Files keeps ~/.config/ccw out of reach all the same
 * (files/deny.ts).
 */
import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { SwitchRules, SwitchRulesPatch } from '@jantar/protocol';
import type { Paths } from '../../contracts.js';
import { isObj } from '../lib/values.js';
import { parseSwitchConfig, type CcwSwitchConfig } from './files.js';

/** What a refusal says, in the words the phone shows. */
export const SWITCH_COPY = {
  absent: "ccw isn't on this Mac, so there are no switching rules to change.",
  missing: "ccw hasn't written its switch.json yet. Start ccw on the Mac once, then try again.",
  broken: "ccw's switch.json doesn't read as JSON right now, so nothing was saved. Fix the file on the Mac (or wait for ccw to finish writing it), then try again.",
  changed: "ccw's switch.json changed while saving, so nothing was saved. Try again.",
  tooBig: "ccw's switch.json is too large to be its own, so nothing was saved.",
  failed: "ccw's switch.json could not be saved.",
} as const;

/** switch.json is a few kilobytes; anything near this is not ccw's. */
const MAX_BYTES = 1024 * 1024;

export type SwitchResult = { ok: true; rules: SwitchRules } | SwitchRefusal;
export interface SwitchRefusal {
  ok: false;
  code: 'ccw_absent' | 'conflict' | 'unavailable';
  message: string;
}

/**
 * The file-system calls a save makes, as one object so a test can watch
 * them (the rename's moment, the temp file's mode) without touching the
 * module system.
 */
export const switchFs = { lstat, open, readFile, readdir, rename, rm, stat };

/** The rules as the sheet shows them, from a parsed switch.json. */
export function rulesOf(cfg: CcwSwitchConfig): SwitchRules {
  return {
    hold: [...cfg.hold],
    ceiling: cfg.ceiling,
    weeklyCeiling: cfg.weeklyCeiling,
    leadMin: cfg.leadMin,
    weeklyRamp: Object.fromEntries(Object.entries(cfg.weeklyRamp).map(([k, r]) => [k, { days: [...r.days], lastHour: r.lastHour }])),
  };
}

/**
 * switch.json with the patch applied: only hold, ceiling, weekly_ceiling,
 * lead_min and weekly_ramp change; the rest is the parsed file as it was.
 * A ramp entry set to null goes; the weekly_ramp key goes once it is empty.
 */
export function mergeSwitchRules(file: Readonly<Record<string, unknown>>, patch: SwitchRulesPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...file };
  if (patch.hold !== undefined) out.hold = [...patch.hold].sort((a, b) => a - b);
  if (patch.ceiling !== undefined) out.ceiling = patch.ceiling;
  if (patch.weeklyCeiling !== undefined) out.weekly_ceiling = patch.weeklyCeiling;
  if (patch.leadMin !== undefined) out.lead_min = patch.leadMin;
  if (patch.weeklyRamp !== undefined) {
    const ramp: Record<string, unknown> = isObj(file.weekly_ramp) ? { ...file.weekly_ramp } : {};
    for (const [account, entry] of Object.entries(patch.weeklyRamp)) {
      if (entry === null) delete ramp[account];
      else ramp[account] = { days: [...entry.days], last_hour: entry.lastHour };
    }
    if (Object.keys(ramp).length > 0) out.weekly_ramp = ramp;
    else delete out.weekly_ramp;
  }
  return out;
}

type SwitchPaths = Pick<Paths, 'ccwDir' | 'ccwSwitchJson'>;

/** switch.json's text and its parsed object, or why there is none to use. */
async function loadFile(paths: SwitchPaths): Promise<{ ok: true; text: string; file: Record<string, unknown> } | SwitchRefusal> {
  const refuse = (code: SwitchRefusal['code'], message: string): SwitchRefusal => ({ ok: false, code, message });
  try {
    if (!(await switchFs.stat(paths.ccwDir)).isDirectory()) return refuse('ccw_absent', SWITCH_COPY.absent);
  } catch {
    return refuse('ccw_absent', SWITCH_COPY.absent);
  }
  let text: string;
  try {
    const st = await switchFs.stat(paths.ccwSwitchJson).catch(() => null);
    if (st && st.size > MAX_BYTES) return refuse('conflict', SWITCH_COPY.tooBig);
    text = await switchFs.readFile(paths.ccwSwitchJson, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? refuse('conflict', SWITCH_COPY.missing) : refuse('unavailable', SWITCH_COPY.failed);
  }
  if (Buffer.byteLength(text) > MAX_BYTES) return refuse('conflict', SWITCH_COPY.tooBig);
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return refuse('conflict', SWITCH_COPY.broken);
  }
  if (!isObj(file)) return refuse('conflict', SWITCH_COPY.broken);
  return { ok: true, text, file };
}

/** The switching rules as switch.json holds them now (GET /v1/accounts/switching). */
export async function readSwitchRules(paths: SwitchPaths): Promise<SwitchResult> {
  const r = await loadFile(paths);
  if (!r.ok) return r;
  return { ok: true, rules: rulesOf(parseSwitchConfig(r.file) as CcwSwitchConfig) };
}

/** Saves wait for the one before them on the same file. */
const queues = new Map<string, Promise<unknown>>();

/** Save the patch into switch.json (the module comment says how); the reply is the rules as now saved. */
export function writeSwitchRules(paths: SwitchPaths, patch: SwitchRulesPatch): Promise<SwitchResult> {
  const key = paths.ccwSwitchJson;
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => save(paths, patch),
    () => save(paths, patch),
  );
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function save(paths: SwitchPaths, patch: SwitchRulesPatch): Promise<SwitchResult> {
  const read = await loadFile(paths);
  if (!read.ok) return read;
  const merged = mergeSwitchRules(read.file, patch);
  const target = paths.ccwSwitchJson;
  await clearStaleTemps(target).catch(() => undefined);
  const changed: SwitchRefusal = { ok: false, code: 'conflict', message: SWITCH_COPY.changed };
  // ccw (or a hand edit) wrote it since it was read: theirs stands, and so does switch.json.prev.
  const unchanged = async () => (await switchFs.readFile(target, 'utf8').catch(() => null)) === read.text;
  const temps: string[] = [];
  try {
    if (!(await unchanged())) return changed;
    const prevTmp = await writeTemp(`${target}.prev`, read.text);
    temps.push(prevTmp);
    if (!(await unchanged())) return changed;
    const nextTmp = await writeTemp(target, JSON.stringify(merged, null, 2));
    temps.push(nextTmp);
    if (!(await unchanged())) return changed;
    // The file as it was, kept beside it (replacing the last one), then the new one.
    await switchFs.rename(prevTmp, `${target}.prev`);
    temps.shift();
    await switchFs.rename(nextTmp, target);
    temps.shift();
  } catch {
    return { ok: false, code: 'unavailable', message: SWITCH_COPY.failed };
  } finally {
    for (const t of temps) await switchFs.rm(t, { force: true }).catch(() => undefined);
  }
  return { ok: true, rules: rulesOf(parseSwitchConfig(merged) as CcwSwitchConfig) };
}

/** `text` in a new temp file beside `path` (0600, fsynced, closed); its path. */
async function writeTemp(path: string, text: string): Promise<string> {
  const tmp = join(dirname(path), `.${basename(path)}.jantar-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const fh = await switchFs.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await switchFs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  await fh.close();
  return tmp;
}

/** A temp file older than this is a save's that never finished, whoever's it was. */
const STALE_TEMP_MS = 10 * 60_000;

/** A pid that is running (or that this process may not signal: someone's, so running). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove the temp files a save into `target` left behind, and only those
 * (writeTemp's names, regular files): this process's own (its saves on the
 * file run one at a time, so none is in progress), a stopped process's, and
 * any older than STALE_TEMP_MS.
 */
async function clearStaleTemps(target: string): Promise<void> {
  const dir = dirname(target);
  const name = basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`^\\.${name}(?:\\.prev)?\\.jantar-(\\d+)-[0-9a-f]{12}\\.tmp$`);
  for (const entry of await switchFs.readdir(dir)) {
    const m = own.exec(entry);
    if (!m) continue;
    const file = join(dir, entry);
    const st = await switchFs.lstat(file).catch(() => null);
    if (!st?.isFile()) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && pidAlive(pid) && Date.now() - st.mtimeMs < STALE_TEMP_MS) continue;
    await switchFs.rm(file, { force: true }).catch(() => undefined);
  }
}
