/**
 * Bringing a ccw-v2 state dir (Jantar's name up to v0.3) into Jantar's. It
 * copies, never moves: nothing in the source is renamed, rewritten or
 * deleted, so ccw-v2 still works from it.
 *
 * Copied, each when present (only regular files):
 *   ccw-v2.db             -> jantar.db   paired devices, push subscriptions, audit log
 *   life.db               -> life.db     Life (a v0.4 ccw-v2)
 *   config.json           -> config.json then migrated to version 2 as v0.4 does
 *                                        (the copy as it was kept as config.json.v1)
 *   push/vapid.json       -> the same    the push keys paired phones subscribed with
 *   intel/captures.jsonl  -> the same    items captured with `intel add`
 *
 * The databases go through VACUUM INTO on a read-only connection (a
 * consistent snapshot; the source file is never written), the rest byte for
 * byte, all 0600. Everything is built in a staging folder beside the target
 * and renamed into place last, so a failed import leaves no half-filled
 * state dir. Not copied: logs/, run/, bin/ (`jantar install` and
 * `jantar hooks install` put Jantar's own client there), the rewrite and
 * food-estimate scratch folders, and life.db's backups/ (they stay where
 * they are).
 */
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { migrateSettingsFile, socketAnswers, type Paths } from '@jantar/daemon';
import { copySqliteFile } from '@jantar/daemon/db/sqlite';
import { expandHome } from '@jantar/daemon/files/deny';
import { CLI_NAME, HOME_ENV, LEGACY_DB_FILE, LEGACY_LAUNCHD_LABEL, LEGACY_STATE_DIR_NAME, LIFE_DB_FILE } from '@jantar/protocol';
import { guardRealPath } from './guard.js';
import { plistPath } from './launchd.js';

export type ImportKind = 'db' | 'config' | 'file';

export interface ImportItem {
  /** Path inside the source state dir. */
  from: string;
  /** Path inside the target state dir. */
  to: string;
  kind: ImportKind;
  /** What it holds, for the report. */
  what: string;
}

export interface ImportPlan {
  /** The ccw-v2 state dir (absolute). */
  from: string;
  /** Jantar's state dir (absolute). */
  to: string;
  items: ImportItem[];
  /** Why a real run would refuse; empty when it can go ahead. */
  refusals: string[];
  /** What else is in the source that is not copied and is not ccw-v2's own (a tunnel config, backups of its own files), by name. */
  left: string[];
}

export interface ImportDeps {
  /** Whether a daemon answers on the Unix socket (tests). Default: a connect to it. */
  daemonAnswers?: (sock: string) => Promise<boolean>;
}

/** What ccw-v2 itself keeps in its state dir and Jantar makes anew: never copied, not worth naming. */
const OWN = new Set(['logs', 'run', 'bin', 'rewrite', 'food-estimate', 'push', 'intel', 'config.json']);
const OWN_DB = new RegExp(`^(?:${[LEGACY_DB_FILE, LIFE_DB_FILE].map((f) => f.replace(/[.]/g, '\\.')).join('|')})(?:-wal|-shm)?$`);

/** Everything an import may copy, source name first. */
function candidates(paths: Pick<Paths, 'dbFile'>): ImportItem[] {
  return [
    { from: LEGACY_DB_FILE, to: basename(paths.dbFile), kind: 'db', what: 'paired devices, push subscriptions, audit log' },
    { from: LIFE_DB_FILE, to: LIFE_DB_FILE, kind: 'db', what: 'Life' },
    { from: 'config.json', to: 'config.json', kind: 'config', what: 'settings' },
    { from: join('push', 'vapid.json'), to: join('push', 'vapid.json'), kind: 'file', what: 'push keys, so paired phones keep their notifications' },
    { from: join('intel', 'captures.jsonl'), to: join('intel', 'captures.jsonl'), kind: 'file', what: 'captured Intel items' },
  ];
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isFile();
  } catch {
    return false;
  }
}

/** The entries of `dir`; null when it does not exist. */
async function entries(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function real(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

/** ~/.ccw-v2 under the (possibly synthetic) user home. */
export function defaultImportSource(paths: Pick<Paths, 'userHome'>): string {
  return join(paths.userHome, LEGACY_STATE_DIR_NAME);
}

/**
 * What an import of `fromInput` into `paths.home` would copy, and why it
 * would refuse. Reads only. Throws when the source is not a ccw-v2 state dir.
 */
export async function planImport(paths: Paths, fromInput: string, deps: ImportDeps = {}): Promise<ImportPlan> {
  const from = resolve(expandHome(fromInput, paths.userHome));
  const to = resolve(paths.home);
  guardRealPath(from, "ccw-v2's state dir");
  guardRealPath(to, 'the Jantar state dir');
  if ((await entries(from)) === null) throw new Error(`there is no ${from} to import from`);

  const items: ImportItem[] = [];
  for (const c of candidates(paths)) if (await isFile(join(from, c.from))) items.push(c);
  if (!items.some((i) => i.from === LEGACY_DB_FILE || i.from === 'config.json')) {
    throw new Error(`${from} is not a ccw-v2 state dir (it has no ${LEGACY_DB_FILE} or config.json)`);
  }

  const refusals: string[] = [];
  if ((await real(from)) === (await real(to))) {
    refusals.push(`${to} is already Jantar's state dir. Set ${HOME_ENV} to a new folder to import into.`);
  } else {
    const there = await entries(to);
    if (there && there.length > 0) {
      refusals.push(`${to} is not empty. ${CLI_NAME} import-ccw-v2 only fills an empty state dir: move that one aside first.`);
    }
  }
  const answers = deps.daemonAnswers ?? ((sock: string) => socketAnswers(sock));
  if (await answers(join(from, 'run', 'ctl.sock'))) {
    refusals.push(`A ccw-v2 daemon is running for ${from}. Stop it first (ccw-v2 uninstall stops it and keeps ${from}).`);
  }
  // While it is installed launchd starts ccw-v2's daemon at login, on Jantar's port with the same device keys,
  // so a phone revoked in Jantar would still get in there.
  const agent = plistPath(paths, LEGACY_LAUNCHD_LABEL);
  if (await isFile(agent)) {
    refusals.push(`ccw-v2's LaunchAgent is still installed (${agent}): launchd would start the old daemon again at login. Run ccw-v2 uninstall first (it keeps ${from}).`);
  }
  const left = ((await entries(from)) ?? []).filter((n) => !OWN.has(n) && !OWN_DB.test(n)).sort();
  return { from, to, items, refusals, left };
}

export interface ImportedItem extends ImportItem {
  /** config.json only: it was version 1 and is now version 2. */
  migrated?: boolean;
}

/**
 * Copy the plan's items into a staging folder beside `plan.to`, then put the
 * folder in place of `plan.to` (which must not exist or be empty). On any
 * failure the staging folder is removed and nothing else has changed.
 */
export async function runImport(plan: ImportPlan): Promise<ImportedItem[]> {
  if (plan.refusals.length) throw new Error(plan.refusals[0]);
  guardRealPath(plan.to, 'the Jantar state dir');
  await mkdir(dirname(plan.to), { recursive: true });
  const staging = await mkdtemp(`${plan.to}.import-`);
  const done: ImportedItem[] = [];
  try {
    await chmod(staging, 0o700);
    for (const item of plan.items) {
      const src = join(plan.from, item.from);
      const dest = join(staging, item.to);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      if (item.kind === 'db') {
        copySqliteFile(src, dest);
        done.push(item);
        continue;
      }
      await copyFile(src, dest, fsConstants.COPYFILE_EXCL);
      await chmod(dest, 0o600);
      if (item.kind === 'config') {
        // As v0.4 migrates its own file: the copy as it was goes to config.json.v1.
        const r = await migrateSettingsFile(
          { configFile: dest, ctlSock: join(staging, 'run', 'ctl.sock'), home: staging },
          { daemonAnswers: async () => false },
        );
        done.push({ ...item, migrated: r.ok && r.migrated });
        continue;
      }
      done.push(item);
    }
    // An empty target goes first (rmdir refuses one that filled up meanwhile).
    if ((await entries(plan.to)) !== null) await rmdir(plan.to);
    await rename(staging, plan.to);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  return done;
}
