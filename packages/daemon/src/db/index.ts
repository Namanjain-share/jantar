/**
 * Storage for jantard (work package E): SQLite in WAL mode at paths.dbFile.
 *
 *   const ctx = await createDaemonContext({ openDb: openSqliteDb });
 *   persistEvents(ctx.store, ctx.db);          // events ring + alert history
 *   persistPendingHistory(ctx.store, ctx.db);  // card history (see below)
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DaemonEvent, PendingRequest } from '@jantar/protocol';
import type { Db, DbOpener, Logger, Paths, Store, Unsubscribe } from '../contracts.js';
import { openSqliteFile, type OpenSqliteOptions, type SqliteDb } from './sqlite.js';

export {
  ALERT_HISTORY_CAP,
  AUDIT_CAP,
  FOLDERS_SEEN_CAP,
  LAUNCH_HISTORY_CAP,
  PENDING_HISTORY_CAP,
  PRUNE_EVERY,
  REWRITE_RUNS_CAP,
  copySqliteFile,
  openSqliteFile,
  type OpenSqliteOptions,
  type SqliteDb,
} from './sqlite.js';
export { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './schema.js';

/** DbOpener for createDaemonContext(): opens and migrates paths.dbFile (0600, dir 0700). */
export const openSqliteDb: DbOpener = (paths: Paths, log: Logger): Db => {
  mkdirSync(dirname(paths.dbFile), { recursive: true, mode: 0o700 });
  return openSqliteFile(paths.dbFile, { log: log.child({ part: 'db' }) });
};

/** Open with options (tests, tools). */
export function openSqliteDbWith(paths: Pick<Paths, 'dbFile'>, opts: OpenSqliteOptions = {}): SqliteDb {
  return openSqliteFile(paths.dbFile, opts);
}

/**
 * Persist every event (the integration step wires this once, before any
 * part starts). Write errors are logged, never thrown into the bus.
 */
export function persistEvents(store: Pick<Store, 'subscribe'>, db: Db, log?: Logger): Unsubscribe {
  return store.subscribe((ev: DaemonEvent) => {
    try {
      db.events.append(ev);
    } catch (e) {
      log?.error('failed to persist event', { seq: ev.seq, type: ev.type, error: String(e) });
    }
  });
}

/**
 * Keep `db.pending` (card history) in step with pending.opened / resolved.
 * Records are insert-or-replace by id, so this is safe to run even if the
 * hooks bridge also records cards itself.
 */
export function persistPendingHistory(store: Pick<Store, 'subscribe'>, db: Db, log?: Logger): Unsubscribe {
  return store.subscribe((ev: DaemonEvent) => {
    try {
      if (ev.type === 'pending.opened') {
        db.pending.record(ev.data.pending);
      } else if (ev.type === 'pending.resolved') {
        const prev = db.pending.get(ev.data.id);
        if (!prev) return;
        const next: PendingRequest = { ...prev, state: ev.data.state };
        if (ev.data.decidedBy !== undefined) next.decidedBy = ev.data.decidedBy;
        if (ev.data.decision !== undefined) next.decision = ev.data.decision;
        if (ev.data.state !== 'decided') {
          next.closedAt = ev.ts;
          if (ev.data.reason !== undefined) next.closeReason = ev.data.reason;
        }
        db.pending.record(next);
      }
    } catch (e) {
      log?.error('failed to record pending history', { seq: ev.seq, error: String(e) });
    }
  });
}
