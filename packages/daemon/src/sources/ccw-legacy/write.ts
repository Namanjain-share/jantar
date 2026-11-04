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
 * - The file as it was goes to switch.json.prev first, then the new one is
 *   written to a temp file in the same folder (0600, fsynced) and renamed
 *   into place, so ccw reads either the old file or the new one, never half.
 * - One save at a time per file (a second waits for the first).
 *
 * ccw reads switch.json every couple of seconds, so it uses a saved rule
 * within a minute. Files keeps ~/.config/ccw out of reach all the same
 * (files/deny.ts).
 */
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
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
export const switchFs = { open, readFile, rename, rm, stat };

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
  try {
    // The file as it was, kept beside it (replacing the last one), before anything changes.
    await writeAtomic(`${target}.prev`, read.text);
    const ok = await writeAtomic(target, JSON.stringify(merged, null, 2), async () => {
      // ccw (or a hand edit) wrote it while this save ran: theirs stands.
      const now = await switchFs.readFile(target, 'utf8').catch(() => null);
      return now === read.text;
    });
    if (!ok) return { ok: false, code: 'conflict', message: SWITCH_COPY.changed };
  } catch {
    return { ok: false, code: 'unavailable', message: SWITCH_COPY.failed };
  }
  return { ok: true, rules: rulesOf(parseSwitchConfig(merged) as CcwSwitchConfig) };
}

/**
 * `text` into `path` through a temp file in the same folder (0600, fsynced),
 * renamed into place only if `stillOk` says so (false: nothing changed).
 */
async function writeAtomic(path: string, text: string, stillOk?: () => Promise<boolean>): Promise<boolean> {
  const tmp = join(dirname(path), `.${basename(path)}.jantar-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const fh = await switchFs.open(tmp, 'wx', 0o600);
  try {
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (stillOk && !(await stillOk())) {
      await switchFs.rm(tmp, { force: true });
      return false;
    }
    await switchFs.rename(tmp, path);
    return true;
  } catch (e) {
    await switchFs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
