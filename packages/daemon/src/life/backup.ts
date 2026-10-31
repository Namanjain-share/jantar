/**
 * life.db backups (spec 4.1) in the fixed folder <state dir>/backups.
 *
 * - Backup: `VACUUM INTO '<backupsDir>/life-YYYY-MM-DD.tmp'` (a consistent
 *   copy, no second process; the empty .tmp is created 0600 first so the
 *   copy is never readable by others), then rename to `life-YYYY-MM-DD.db`
 *   (the day in the Life zone; a second backup that day replaces it). Then
 *   the oldest `life-*.db` beyond LIFE_BACKUP_KEEP are deleted, and never
 *   any other file. The folder is created 0700.
 * - Nightly at 03:30 in the Life zone, and at start when the newest backup
 *   is older than 24 h (`BackupTimer`). The timer goes by the wall clock:
 *   Node's timers stop while the Mac sleeps, so a 03:30 slept through runs
 *   within BACKUP_CHECK_MS of waking. A failure logs a code and pushes
 *   "Life backup failed" once per day.
 * - Restore: `restoreTarget` checks the name (`life-*.db`, no separator)
 *   and that it is a regular file directly inside the folder (no symlink).
 *   The service then copies it beside life.db and lets openLifeDb judge the
 *   copy (header, quick_check, schema) before anything is swapped.
 *
 * Errors are codes for the log; the phone and the CLI get fixed sentences.
 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { instantAt, shiftDay, dayKeyOf } from '@jantar/life-core';
import { LIFE_BACKUP_KEEP, LifeBackupNameSchema } from '@jantar/protocol';
import type { Clock, LifeDb, Logger, TimerId } from '../contracts.js';

/** When the nightly backup runs, in the Life zone. */
export const BACKUP_TIME = '03:30';
/** At start, a backup is made when the newest is older than this (or there is none). */
export const BACKUP_STALE_MS = 24 * 60 * 60_000;
/** How often the nightly timer looks at the wall clock (Node's timers run late after the Mac sleeps). */
export const BACKUP_CHECK_MS = 60_000;

export type BackupFailure = 'dir_failed' | 'vacuum_failed' | 'rename_failed';

export interface BackupFile {
  name: string;
  mtimeMs: number;
}

/** Create the backups folder 0700 (and tighten it when it exists). */
export function ensureBackupsDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The `life-*.db` regular files directly in `dir`, newest first (ties by name). Missing dir: none. */
export function listBackups(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of names) {
    if (!LifeBackupNameSchema.safeParse(name).success) continue;
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile()) out.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // Gone since the listing.
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

/** LifeStatus.backups. */
export function backupSummary(dir: string): { last: string | null; count: number } {
  const all = listBackups(dir);
  const newest = all[0];
  return { last: newest ? new Date(newest.mtimeMs).toISOString() : null, count: all.length };
}

/**
 * Delete the oldest `life-*.db` beyond `keep`; nothing else. `fresh` (the
 * backup just written) always counts as the newest, whatever its mtime.
 * Answers the names deleted.
 */
export function pruneBackups(dir: string, keep: number = LIFE_BACKUP_KEEP, fresh?: string): string[] {
  const all = listBackups(dir);
  const others = all.filter((b) => b.name !== fresh);
  const room = fresh !== undefined && others.length < all.length ? keep - 1 : keep;
  const gone: string[] = [];
  for (const old of others.slice(Math.max(0, room))) {
    try {
      unlinkSync(join(dir, old.name));
      gone.push(old.name);
    } catch {
      // Already gone, or not ours to delete: left alone.
    }
  }
  return gone;
}

/** The nightly file name for `day`. */
export function backupName(day: string): string {
  return `life-${day}.db`;
}

/**
 * Copy the open life.db into `dir` as life-<day>.db (0600) and prune.
 * Answers the file name, or a failure code (nothing half-written is left).
 */
export function writeBackup(db: LifeDb, dir: string, day: string): { ok: true; file: string } | { ok: false; code: BackupFailure } {
  try {
    ensureBackupsDir(dir);
  } catch {
    return { ok: false, code: 'dir_failed' };
  }
  const file = backupName(day);
  const tmp = join(dir, `life-${day}.tmp`);
  const removeTmp = () => {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  };
  try {
    removeTmp();
    closeSync(openSync(tmp, 'wx', 0o600));
    db.prepare('VACUUM INTO ?').run(tmp);
    chmodSync(tmp, 0o600);
  } catch {
    removeTmp();
    return { ok: false, code: 'vacuum_failed' };
  }
  try {
    renameSync(tmp, join(dir, file));
  } catch {
    removeTmp();
    return { ok: false, code: 'rename_failed' };
  }
  pruneBackups(dir, LIFE_BACKUP_KEEP, file);
  return { ok: true, file };
}

/** Why a restore name was refused (the CLI shows it). */
export const RESTORE_REFUSED = {
  name: 'That is not a backup name. Backups are named life-<date>.db, with no folder.',
  missing: 'No such backup in the backups folder.',
  notFile: 'That backup is not a plain file (a link or a folder is never restored).',
} as const;

/** The path of backup `name` inside `dir`, or why it cannot be restored. */
export function restoreTarget(dir: string, name: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (!LifeBackupNameSchema.safeParse(name).success || name.includes('/') || name.includes('\\')) return { ok: false, reason: RESTORE_REFUSED.name };
  const path = join(dir, name);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false, reason: RESTORE_REFUSED.missing };
  }
  if (!st.isFile()) return { ok: false, reason: RESTORE_REFUSED.notFile };
  return { ok: true, path };
}

/** The next 03:30 in `tz` strictly after `now`. */
export function nextBackupAt(now: Date, tz: string): Date {
  const today = dayKeyOf(now, tz);
  const at = instantAt(today, BACKUP_TIME, tz);
  return at.getTime() > now.getTime() ? at : instantAt(shiftDay(today, 1), BACKUP_TIME, tz);
}

/**
 * The nightly timer: the next 03:30 in the Life zone as a wall-clock time
 * (`dueAt`), checked against ctx.clock.now() at least every
 * BACKUP_CHECK_MS, so a night the Mac slept through is caught up soon after
 * it wakes, not 24 h of awake time later. Moved on after each run and when
 * the zone changes. `run` makes the backup (the service's); a run that
 * finds Life closed simply waits for the next night.
 */
export class BackupTimer {
  private timer: TimerId | undefined;
  private running = false;
  /** When the next backup is due (epoch ms, wall clock). */
  private dueAt = 0;

  constructor(
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: { dir: string; tz: () => string; run: () => Promise<unknown> },
  ) {}

  /** Arm, and back up now when the newest backup is older than BACKUP_STALE_MS. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const newest = listBackups(this.opts.dir)[0];
    if (!newest || this.clock.now() - newest.mtimeMs > BACKUP_STALE_MS) this.fire();
    else this.arm();
  }

  stop(): void {
    this.running = false;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The zone changed: the next 03:30 moved. */
  rearm(): void {
    if (this.running) this.arm();
  }

  private arm(): void {
    this.dueAt = nextBackupAt(new Date(this.clock.now()), this.opts.tz()).getTime();
    this.wait();
  }

  /** Fire once the wall clock has reached dueAt; until then look again in at most BACKUP_CHECK_MS. */
  private wait(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const left = this.dueAt - this.clock.now();
    if (left <= 0) return this.fire();
    this.timer = this.clock.setTimeout(() => this.wait(), Math.min(left, BACKUP_CHECK_MS));
  }

  private fire(): void {
    this.timer = undefined;
    void this.opts
      .run()
      .catch((e: unknown) => this.log.error('life backup failed', { event: 'life.backup', error: e instanceof Error ? e.name : 'unknown' }))
      .finally(() => {
        if (this.running) this.arm();
      });
  }
}
