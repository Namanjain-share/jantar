/**
 * The one Life scheduler (spec 1.3, 4.2): every Life push (timed todos,
 * medicine times, refills, bills) goes out from here, at most once per
 * occurrence.
 *
 *   loop     every SWEEP_MS, and when the exact timer fires: read the due
 *            rows of the kinds whose module is on (medicine rows first,
 *            pings.ts `due`), drop the ones this process is still sending,
 *            group them by (kind, the handler's group or the row, the
 *            minute) and deliver each group; then arm one timer for the
 *            earliest row due within NEAR_MS, even after a read that
 *            failed (v0.5.3), so the next row still rings on time.
 *   start    sweep once (the catch-up after a restart), resync() every
 *            handler, then the loop.
 *   deliver  1 claim each row (pings.ts claim: still due at the time seen,
 *              no claim younger than CLAIM_LEASE_MS) and add it to `sending`
 *            2 late: more than LATE_AFTER_MS behind; a catch-up rings for
 *              the latest missed occurrence only, and not at all past
 *              CATCH_UP_MAX_MS (the row just moves on)
 *            3 check each row against its source: cancel deletes the row,
 *              skip moves it on; a check that throws sends for med and
 *              refill (a missed dose is the worse failure) and skips the rest
 *            4 send one push for the rows left, raced against the deadline
 *              (push.ts withDeadline). Every device failing, or the
 *              deadline passing, keeps next_at and counts a failure (the next
 *              sweep retries; after MAX_FAILURES the row moves on). Muted
 *              (a reminder) keeps next_at and counts nothing. v0.5.3: so does
 *              every failure being one where the push never left the Mac
 *              (`offline`: no DNS or no connect, a Mac asleep or off Wi-Fi):
 *              the row waits for the network, logged once while it waits,
 *              and goes out marked late once a sweep can send it, within
 *              CATCH_UP_MAX_MS and after its check (step 2 and 3) again. A
 *              push that may have reached the push service is never sent
 *              twice: any other failure counts. Delivered, or no device to
 *              send to, moves the row on.
 *            5 move on: next_at = handler.next(row, max(now, due)), claim and
 *              failures cleared, only while the claim is still ours (a
 *              producer's set in between wins).
 *            Rows leave `sending` when the send itself ends, which after a
 *            timeout is later than the decision: no sweep claims a row
 *            whose push is still on its way.
 *
 * stop() only stops sweeping: a send in flight still writes its step 5, so
 * turning the last module off and on again never repeats a push. detach()
 * (the handle closing or being swapped) is what drops those writes. A crash,
 * or a handle closed between a push and step 5, can repeat that push once,
 * after the lease. Logs carry kinds, counts and durations, never refs or text.
 */
import { LIFE_PUSH_DEADLINE_MS } from '@jantar/protocol';
import type { Clock, LifeDb, Logger, PingHandler, PingKind, PingRow, Scheduler, TimerId } from '../contracts.js';
import { CATCH_UP_MAX_MS, CLAIM_LEASE_MS, LATE_AFTER_MS, MAX_FAILURES, NEAR_MS, PING_KINDS, PingsRepo, SWEEP_MS, errorKind } from './pings.js';
import { withDeadline, type LifeSend, type LifeSendResult } from './push.js';

/** Kinds whose check fails open: a guard that throws still sends. */
const FAIL_OPEN: ReadonlySet<PingKind> = new Set(['med', 'refill']);

/** Steps of next() walked to find a catch-up's latest missed occurrence (a daily row asleep for years stops here). */
const MAX_WALK = 1000;

export interface LifeSchedulerOptions {
  /** Sends one push (push.ts sendLifePush in the daemon). */
  send: LifeSend;
  /** The kinds that may ring now (their module is on). Default: every kind. */
  kinds?: () => readonly PingKind[];
  deadlineMs?: number;
}

interface Due {
  row: PingRow;
  handler: PingHandler;
  /** The occurrence that rings: next_at, or the latest one missed. */
  dueAt: Date;
}

export class LifeScheduler implements Scheduler {
  private readonly handlers = new Map<PingKind, PingHandler>();
  private readonly repo: PingsRepo;
  /** Row ids whose push this process is still sending. */
  private readonly sending = new Set<string>();
  /** v0.5.3: row ids waiting for the network (logged once each); a row leaves when it is sent or moves on. */
  private readonly waiting = new Set<string>();
  /** Deliveries not yet decided (settled() waits on them). */
  private readonly deciding = new Set<Promise<void>>();
  private running = false;
  /** Bumped by detach(): a delivery from before it writes nothing (the handle is closing or swapped by a restore). */
  private generation = 0;
  private sweepTimer: TimerId | undefined;
  private nearTimer: TimerId | undefined;
  private nearAt: number | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly log: Logger,
    db: () => LifeDb,
    private readonly opts: LifeSchedulerOptions,
  ) {
    this.repo = new PingsRepo(db);
  }

  register(h: PingHandler): void {
    this.handlers.set(h.kind, h);
  }

  set(kind: PingKind, ref: string, sub: string, nextAt: Date | null): void {
    this.repo.set(kind, ref, sub, nextAt ? nextAt.toISOString() : null);
  }

  clear(kind: PingKind, ref: string, sub?: string): void {
    this.repo.clear(kind, ref, sub);
  }

  poke(): void {
    if (this.running) this.arm();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The rows as stored (tests, status). */
  rows(kind?: PingKind): PingRow[] {
    return this.repo.list(kind);
  }

  /** Sweep once (the catch-up), rebuild every handler's rows, then sweep on a timer. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.sweep();
    this.resyncAll();
    this.sweepTimer = this.clock.setInterval(() => this.sweep(), SWEEP_MS);
    this.arm();
  }

  /** Stop sweeping. Sends in flight finish and write their outcome back (the handle is still open). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clock.clearInterval(this.sweepTimer);
    this.clock.clearTimeout(this.nearTimer);
    this.sweepTimer = undefined;
    this.nearTimer = undefined;
    this.nearAt = null;
  }

  /** The handle is about to close or be swapped: a delivery still in flight writes nothing back. */
  detach(): void {
    this.generation += 1;
  }

  /** Rebuild every handler's rows from its source (start, a time zone change, a restore). */
  resyncAll(kinds?: ReadonlySet<PingKind>): void {
    for (const h of this.handlers.values()) {
      if (kinds && !kinds.has(h.kind)) continue;
      try {
        h.resync();
      } catch (e) {
        this.log.error('life ping resync failed', { kind: h.kind, error: errorKind(e) });
      }
    }
    this.poke();
  }

  /**
   * After a restore: every row already due moves on to its next occurrence
   * after now, unsent and unclaimed. The restored rows are from before the
   * backup, so a ring that came due since (and may have gone out on the
   * file that was replaced) is never caught up as a late push.
   */
  skipDue(): void {
    const now = new Date(this.clock.now());
    for (const row of this.repo.list()) {
      if (row.nextAt === null || Date.parse(row.nextAt) > now.getTime()) continue;
      const handler = this.handlers.get(row.kind);
      if (!handler) continue;
      let next: Date | null = null;
      try {
        next = handler.next(row, now);
      } catch (e) {
        this.log.error('life ping next failed', { kind: row.kind, error: errorKind(e) });
      }
      try {
        this.repo.set(row.kind, row.ref, row.sub, next ? next.toISOString() : null);
      } catch (e) {
        this.log.error('life ping update failed', { kind: row.kind, error: errorKind(e) });
      }
    }
  }

  /** Resolves when every delivery started so far has decided (sent, failed or timed out). */
  async settled(): Promise<void> {
    while (this.deciding.size > 0) await Promise.allSettled([...this.deciding]);
  }

  /** One pass over the due rows. Synchronous up to the sends, so two sweeps never interleave a claim. */
  sweep(): void {
    if (!this.running) return;
    try {
      this.deliverDue();
    } finally {
      // A read that failed still arms the near timer: the next row rings on time, not at the next sweep.
      this.arm();
    }
  }

  // -------------------------------------------------------------------------

  private deliverDue(): void {
    const started = this.clock.now();
    const now = new Date(started);
    let rows: PingRow[];
    try {
      rows = this.repo.due(this.activeKinds(), now.toISOString());
    } catch (e) {
      this.log.error('life sweep failed', { error: errorKind(e) });
      return;
    }
    const groups = new Map<string, Due[]>();
    for (const row of rows) {
      if (this.sending.has(row.id) || row.nextAt === null) continue;
      const handler = this.handlers.get(row.kind);
      if (!handler) continue;
      const dueAt = this.latestDue(handler, row, now);
      let key = row.id;
      try {
        key = handler.group?.(row) ?? row.id;
      } catch {
        // An unreadable group key sends the row on its own.
      }
      const gk = `${row.kind}|${key}|${Math.floor(dueAt.getTime() / 60_000)}`;
      const list = groups.get(gk) ?? [];
      list.push({ row, handler, dueAt });
      groups.set(gk, list);
    }
    let delivering = 0;
    for (const group of groups.values()) {
      const p = this.deliver(group, now);
      if (p) {
        delivering += 1;
        this.deciding.add(p);
        void p.finally(() => this.deciding.delete(p));
      }
    }
    if (delivering > 0) this.log.debug('life sweep', { due: rows.length, groups: delivering, ms: this.clock.now() - started });
  }

  private activeKinds(): readonly PingKind[] {
    const on = this.opts.kinds?.() ?? PING_KINDS;
    return on.filter((k) => this.handlers.has(k));
  }

  /** The occurrence a due row rings for: its next_at, or (a catch-up) the latest one at or before now. */
  private latestDue(handler: PingHandler, row: PingRow, now: Date): Date {
    let due = new Date(row.nextAt as string);
    if (now.getTime() - due.getTime() <= LATE_AFTER_MS) return due;
    for (let i = 0; i < MAX_WALK; i++) {
      let next: Date | null;
      try {
        next = handler.next(row, due);
      } catch {
        break;
      }
      if (!next || next.getTime() <= due.getTime() || next.getTime() > now.getTime()) break;
      due = next;
    }
    return due;
  }

  /** Claims, checks and starts the send for one group; the promise ends when the group is decided. */
  private deliver(group: readonly Due[], now: Date): Promise<void> | null {
    const nowIso = now.toISOString();
    const lease = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
    const claimed: Due[] = [];
    for (const d of group) {
      try {
        if (this.repo.claim(d.row.id, d.row.nextAt as string, nowIso, lease)) claimed.push(d);
      } catch (e) {
        this.log.error('life ping claim failed', { kind: d.row.kind, error: errorKind(e) });
      }
    }
    if (claimed.length === 0) return null;
    for (const d of claimed) this.sending.add(d.row.id);
    const generation = this.generation;
    const first = claimed[0] as Due;
    const { handler, dueAt } = first;
    const behind = now.getTime() - dueAt.getTime();
    const late = behind > LATE_AFTER_MS;

    const done = (ids: readonly string[]) => {
      for (const id of ids) this.sending.delete(id);
    };
    const write = (fn: () => void) => {
      if (generation !== this.generation) return;
      try {
        fn();
      } catch (e) {
        this.log.error('life ping update failed', { kind: handler.kind, error: errorKind(e) });
      }
    };
    const advance = (d: Due, sent: boolean) => {
      this.waiting.delete(d.row.id);
      write(() => {
        const after = new Date(Math.max(now.getTime(), d.dueAt.getTime()));
        let next: Date | null = null;
        try {
          next = d.handler.next(d.row, after);
        } catch (e) {
          this.log.error('life ping next failed', { kind: d.row.kind, error: errorKind(e) });
        }
        this.repo.advance(d.row.id, nowIso, next ? next.toISOString() : null, sent ? nowIso : null);
      });
    };

    if (late && behind > CATCH_UP_MAX_MS) {
      for (const d of claimed) advance(d, false);
      done(claimed.map((d) => d.row.id));
      this.log.info('life ping too late to send', { kind: handler.kind, rows: claimed.length });
      return Promise.resolve();
    }

    const send: Due[] = [];
    for (const d of claimed) {
      let verdict: 'send' | 'skip' | 'cancel';
      try {
        verdict = d.handler.check(d.row, d.dueAt, late);
      } catch (e) {
        verdict = FAIL_OPEN.has(d.row.kind) ? 'send' : 'skip';
        this.log.warn('life ping check failed', { kind: d.row.kind, verdict, error: errorKind(e) });
      }
      if (verdict === 'send') send.push(d);
      else if (verdict === 'cancel') {
        this.waiting.delete(d.row.id);
        write(() => this.repo.remove(d.row.id, nowIso));
      } else advance(d, false);
    }
    const unsent = claimed.filter((d) => !send.includes(d)).map((d) => d.row.id);
    done(unsent);
    if (send.length === 0) return Promise.resolve();

    const ids = send.map((d) => d.row.id);
    const failure = (why: string) => {
      for (const d of send) {
        if (d.row.failures + 1 >= MAX_FAILURES) {
          advance(d, false);
          this.log.warn('life ping gave up', { event: 'life.ping.gave_up', kind: d.row.kind, failures: d.row.failures + 1 });
        } else {
          write(() => this.repo.failed(d.row.id, nowIso));
        }
      }
      this.log.warn('life push not delivered', { kind: handler.kind, rows: send.length, why });
    };

    let sending: Promise<LifeSendResult>;
    try {
      const push = handler.push(send.map((d) => d.row), dueAt, late);
      sending = Promise.resolve(this.opts.send(push));
    } catch (e) {
      sending = Promise.reject(e);
    }
    // The rows stay in `sending` until the send itself ends, even after the deadline.
    void sending.then(
      () => done(ids),
      () => done(ids),
    );
    const t0 = this.clock.now();
    return withDeadline(this.clock, sending, this.opts.deadlineMs ?? LIFE_PUSH_DEADLINE_MS).then(
      (r) => {
        if (r.timedOut) return failure('deadline');
        const res = r.value;
        if (res.muted) {
          for (const d of send) write(() => this.repo.release(d.row.id, nowIso));
          return;
        }
        if (res.delivered === 0 && res.failed > 0 && (res.offline ?? 0) === res.failed) {
          // The push never left the Mac: keep next_at, count nothing, and retry on the next sweep.
          for (const d of send) write(() => this.repo.release(d.row.id, nowIso));
          const fresh = send.filter((d) => !this.waiting.has(d.row.id));
          for (const d of fresh) this.waiting.add(d.row.id);
          if (fresh.length > 0) this.log.info('life push waiting for the network', { kind: handler.kind, rows: fresh.length });
          return;
        }
        if (res.failed > 0 && res.delivered === 0) return failure('every device failed');
        const waited = send.some((d) => this.waiting.has(d.row.id));
        for (const d of send) advance(d, true);
        this.log.info('life push sent', { kind: handler.kind, rows: send.length, delivered: res.delivered, late, ...(waited ? { waited: true } : {}), ms: this.clock.now() - t0 });
      },
      (e: unknown) => failure(errorKind(e)),
    );
  }

  /**
   * One timer for the earliest row coming due within NEAR_MS. Rows already
   * due (in flight, failed, muted) wait for the sweep, so the timer never
   * spins on them.
   */
  private arm(): void {
    if (!this.running) return;
    const now = this.clock.now();
    let at: number | null = null;
    try {
      const iso = this.repo.earliest(this.activeKinds(), new Date(now).toISOString());
      at = iso ? Date.parse(iso) : null;
    } catch {
      at = null;
    }
    if (at === null || at - now > NEAR_MS) {
      this.clock.clearTimeout(this.nearTimer);
      this.nearTimer = undefined;
      this.nearAt = null;
      return;
    }
    const when = at;
    if (this.nearTimer !== undefined && this.nearAt === when) return;
    this.clock.clearTimeout(this.nearTimer);
    this.nearAt = when;
    this.nearTimer = this.clock.setTimeout(() => {
      this.nearTimer = undefined;
      this.nearAt = null;
      this.sweep();
    }, when - now);
  }
}
