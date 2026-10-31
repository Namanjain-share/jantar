import { PROTOCOL_VERSION } from '@jantar/protocol';
import type { Clock, DaemonContext, DbOpener, Logger } from './contracts.js';
import { FileSettingsStore, ensureStateDirs, migrateSettingsFile, resolveAccountsMode, resolveBins, resolvePaths, type Env } from './config.js';
import { systemClock } from './core/clock.js';
import { createExecFile } from './core/exec.js';
import { createLogger } from './core/log.js';
import { realProcessProbe } from './core/proc.js';
import { MemoryStore } from './core/store.js';
import { DAEMON_VERSION } from './version.js';

export interface CreateContextOptions {
  env?: Env;
  openDb: DbOpener;
  log?: Logger;
  /** Look binaries up on $PATH too (CLI and tests; the daemon under launchd uses config + well-known paths). */
  usePath?: boolean;
  /** Default the system clock. End-to-end tests pass one they move forward (a Life ping at 08:00). */
  clock?: Clock;
}

/**
 * Build the real DaemonContext: state dirs, the settings file migrated to
 * version 2 (refused while another daemon owns the state dir: that throws,
 * and the daemon exits), settings, binaries, accounts mode, db, store.
 */
export async function createDaemonContext(opts: CreateContextOptions): Promise<DaemonContext> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? createLogger({ level: env.JANTAR_LOG_LEVEL === 'debug' ? 'debug' : 'info' });
  const paths = resolvePaths({ env });
  await ensureStateDirs(paths);
  const migrated = await migrateSettingsFile(paths);
  if (!migrated.ok) throw new Error(migrated.reason);
  if (migrated.migrated) log.info('settings migrated to version 2; the old file is kept as config.json.v1');
  const settings = await FileSettingsStore.open(paths, log);
  const bins = await resolveBins({ settings: settings.get(), env, userHome: paths.userHome, usePath: opts.usePath ?? false });
  const accountsMode = resolveAccountsMode(bins, paths, env);
  const db = opts.openDb(paths, log);
  const clock = opts.clock ?? systemClock;
  const store = new MemoryStore({ clock, log, startSeq: db.events.maxSeq() });
  return {
    version: { daemon: DAEMON_VERSION, protocol: PROTOCOL_VERSION },
    paths,
    env,
    settings,
    bins,
    clock,
    exec: createExecFile({ env }),
    proc: realProcessProbe,
    log,
    store,
    db,
    accountsMode: () => accountsMode,
  };
}
