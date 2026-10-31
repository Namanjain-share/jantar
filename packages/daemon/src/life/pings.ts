/**
 * The `pings` table (life.db): one row per thing that will ring, written by
 * the modules (through Scheduler.set and clear) and read and advanced only
 * by the scheduler (scheduler.ts).
 *
 * A row is (kind, ref, sub), unique: a todo, a medicine's dose time ("08:00"
 * in `sub`), a medicine's refill, a bill. `next_at` is the next time it
 * rings (null: parked until its producer sets it again), `claimed_at` the
 * claim of the sweep sending it. Every statement reads the database through
 * `db()` on each call, so a restore that swaps the handle is picked up.
 *
 * Nothing here holds Life text: rows carry ids, times and counts.
 */
import type { LifeDb, PingKind, PingRow } from '../contracts.js';
import { newId } from '../core/ids.js';

/** A claim older than this is a dead sweep's (a crash mid-send): the row can be claimed again. Four send deadlines. */
export const CLAIM_LEASE_MS = 120_000;
/** A row due longer ago than this is a catch-up (sleep, a restart), sent once and marked late. */
export const LATE_AFTER_MS = 120_000;
/** A catch-up further behind than this is not sent at all: the row only moves on. */
export const CATCH_UP_MAX_MS = 6 * 60 * 60_000;
/** Failed sends of one occurrence before the scheduler gives up on it and moves on. */
export const MAX_FAILURES = 5;
/** How often the scheduler sweeps for due rows. */
export const SWEEP_MS = 30_000;
/** The exact timer is armed for the earliest row due within this. */
export const NEAR_MS = 60_000;
/** Rows read per sweep. */
export const SWEEP_LIMIT = 200;

/** Which Life module a kind belongs to: a kind rings only while its module is on. */
export const KIND_MODULE = {
  todo: 'todos',
  med: 'medicines',
  refill: 'medicines',
  bill: 'finance',
} as const satisfies Record<PingKind, string>;

export const PING_KINDS = Object.keys(KIND_MODULE) as PingKind[];

interface RawRow {
  id: string;
  kind: string;
  ref: string;
  sub: string;
  next_at: string | null;
  claimed_at: string | null;
  failures: number;
  last_sent_at: string | null;
}

function rowOf(r: RawRow): PingRow {
  return {
    id: r.id,
    kind: r.kind as PingKind,
    ref: r.ref,
    sub: r.sub,
    nextAt: r.next_at,
    claimedAt: r.claimed_at,
    failures: Number(r.failures),
    lastSentAt: r.last_sent_at,
  };
}

/** `?, ?, ?` for an IN list of `n` values (n >= 1). */
function marks(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export class PingsRepo {
  constructor(private readonly db: () => LifeDb) {}

  /** Upsert; a new time clears the claim and the failures, and keeps last_sent_at. */
  set(kind: PingKind, ref: string, sub: string, nextAt: string | null): void {
    this.db()
      .prepare(
        `INSERT INTO pings (id, kind, ref, sub, next_at, claimed_at, failures) VALUES (?, ?, ?, ?, ?, NULL, 0)
         ON CONFLICT (kind, ref, sub) DO UPDATE SET next_at = excluded.next_at, claimed_at = NULL, failures = 0`,
      )
      .run(newId(), kind, ref, sub, nextAt);
  }

  clear(kind: PingKind, ref: string, sub?: string): void {
    if (sub === undefined) this.db().prepare('DELETE FROM pings WHERE kind = ? AND ref = ?').run(kind, ref);
    else this.db().prepare('DELETE FROM pings WHERE kind = ? AND ref = ? AND sub = ?').run(kind, ref, sub);
  }

  get(kind: PingKind, ref: string, sub = ''): PingRow | undefined {
    const r = this.db().prepare('SELECT * FROM pings WHERE kind = ? AND ref = ? AND sub = ?').get(kind, ref, sub) as RawRow | undefined;
    return r ? rowOf(r) : undefined;
  }

  /** Every row (of `kind`), oldest due first; parked rows last. */
  list(kind?: PingKind): PingRow[] {
    const rows = (
      kind === undefined
        ? this.db().prepare('SELECT * FROM pings ORDER BY next_at IS NULL, next_at, id').all()
        : this.db().prepare('SELECT * FROM pings WHERE kind = ? ORDER BY next_at IS NULL, next_at, id').all(kind)
    ) as unknown as RawRow[];
    return rows.map(rowOf);
  }

  /**
   * Rows of `kinds` due at `nowIso` or before: medicine and refill rows
   * first, then oldest first. Muted reminders stay due, so a pile of them
   * never keeps a dose ping out of the `limit` read.
   */
  due(kinds: readonly PingKind[], nowIso: string, limit = SWEEP_LIMIT): PingRow[] {
    if (kinds.length === 0) return [];
    const rows = this.db()
      .prepare(
        `SELECT * FROM pings WHERE next_at IS NOT NULL AND next_at <= ? AND kind IN (${marks(kinds.length)})
         ORDER BY kind IN ('med', 'refill') DESC, next_at, id LIMIT ?`,
      )
      .all(nowIso, ...kinds, limit) as unknown as RawRow[];
    return rows.map(rowOf);
  }

  /** The earliest next_at among `kinds` strictly after `afterIso`, or null (rows already due are the sweep's). */
  earliest(kinds: readonly PingKind[], afterIso: string): string | null {
    if (kinds.length === 0) return null;
    const r = this.db()
      .prepare(`SELECT MIN(next_at) AS at FROM pings WHERE next_at > ? AND kind IN (${marks(kinds.length)})`)
      .get(afterIso, ...kinds) as { at: string | null } | undefined;
    return r?.at ?? null;
  }

  /**
   * Claim before send: only a row still due at the time this sweep saw, and
   * not claimed within the lease, is taken. True when this call took it.
   */
  claim(id: string, seen: string, nowIso: string, leaseIso: string): boolean {
    const r = this.db()
      .prepare('UPDATE pings SET claimed_at = ? WHERE id = ? AND next_at = ? AND (claimed_at IS NULL OR claimed_at < ?)')
      .run(nowIso, id, seen, leaseIso);
    return Number(r.changes) === 1;
  }

  /**
   * Move a claimed row on: its next time, claim and failures cleared,
   * `sentAt` recorded when it was sent. A producer that set the row since
   * the claim (which cleared it) wins: nothing changes then.
   */
  advance(id: string, claimedAt: string, nextAt: string | null, sentAt: string | null): void {
    this.db()
      .prepare(
        'UPDATE pings SET next_at = ?, claimed_at = NULL, failures = 0, last_sent_at = COALESCE(?, last_sent_at) WHERE id = ? AND claimed_at = ?',
      )
      .run(nextAt, sentAt, id, claimedAt);
  }

  /** A failed send: the claim goes, next_at stays (the next sweep retries), one more failure counted. */
  failed(id: string, claimedAt: string): void {
    this.db().prepare('UPDATE pings SET claimed_at = NULL, failures = failures + 1 WHERE id = ? AND claimed_at = ?').run(id, claimedAt);
  }

  /** Let go of a claim without counting anything (a muted reminder waits out the mute). */
  release(id: string, claimedAt: string): void {
    this.db().prepare('UPDATE pings SET claimed_at = NULL WHERE id = ? AND claimed_at = ?').run(id, claimedAt);
  }

  /** A row whose source is gone (the handler said cancel). */
  remove(id: string, claimedAt: string): void {
    this.db().prepare('DELETE FROM pings WHERE id = ? AND claimed_at = ?').run(id, claimedAt);
  }
}

/**
 * What a log line says about an error: its name and code, never its
 * message (a module's message could carry Life text).
 */
export function errorKind(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? `${e.name} ${code}` : e.name;
}
