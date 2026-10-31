/**
 * Event ordering. Async hooks run as separate processes and can reach the
 * daemon out of order, so every event carries the client's start time
 * (`_jantar.ts`, wall clock ms) and a monotonic stamp (`_jantar.mono`,
 * process.hrtime.bigint(), comparable across processes on one machine).
 *
 * ReorderBuffer holds each event for a short window and releases events in
 * stamp order. An event that arrives later than the window is still released
 * (late); its effects are then judged by its timestamp (mergeStatus and the
 * card rules ignore stale observations).
 */
import type { Clock, Logger, TimerId } from '../contracts.js';

export interface OrderKey {
  /** Monotonic ns from the hook client, when it sent one. */
  mono?: bigint;
  /** Wall clock ms from the hook client. */
  ts: number;
  /** Arrival order at the daemon (tie breaker). */
  seq: number;
}

/** Negative when `a` happened before `b`. */
export function compareKeys(a: OrderKey, b: OrderKey): number {
  if (a.mono !== undefined && b.mono !== undefined && a.mono !== b.mono) return a.mono < b.mono ? -1 : 1;
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.seq - b.seq;
}

export function parseMono(mono: string | undefined): bigint | undefined {
  if (!mono || !/^\d{1,30}$/.test(mono)) return undefined;
  try {
    return BigInt(mono);
  } catch {
    return undefined;
  }
}

interface Held<T> {
  item: T;
  key: OrderKey;
  dueAt: number;
}

export class ReorderBuffer<T> {
  private held: Held<T>[] = [];
  private timer: TimerId | undefined;
  private timerAt = Number.POSITIVE_INFINITY;

  constructor(
    private readonly clock: Clock,
    private readonly windowMs: number,
    private readonly deliver: (item: T) => void,
    private readonly log?: Logger,
  ) {}

  get size(): number {
    return this.held.length;
  }

  push(item: T, key: OrderKey): void {
    if (this.windowMs <= 0) {
      this.safeDeliver(item);
      return;
    }
    const entry: Held<T> = { item, key, dueAt: this.clock.now() + this.windowMs };
    // Insert in key order (the list is short: one window's worth of events).
    let i = this.held.length;
    while (i > 0 && compareKeys((this.held[i - 1] as Held<T>).key, key) > 0) i -= 1;
    this.held.splice(i, 0, entry);
    this.schedule();
  }

  /** Release everything now (shutdown). */
  flushAll(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
    const all = this.held;
    this.held = [];
    for (const h of all) this.safeDeliver(h.item);
  }

  /** Drop everything without delivering (stop without processing). */
  clear(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
    this.held = [];
  }

  private schedule(): void {
    if (this.held.length === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const h of this.held) if (h.dueAt < earliest) earliest = h.dueAt;
    if (this.timer !== undefined && this.timerAt <= earliest) return;
    this.clock.clearTimeout(this.timer);
    this.timerAt = earliest;
    this.timer = this.clock.setTimeout(() => this.flushDue(), Math.max(0, earliest - this.clock.now()));
  }

  private flushDue(): void {
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
    const now = this.clock.now();
    // Release up to the last due event in key order: anything ordered before a
    // due event is released with it, so delivery stays sorted.
    let last = -1;
    for (let i = 0; i < this.held.length; i++) if ((this.held[i] as Held<T>).dueAt <= now) last = i;
    const out = this.held.splice(0, last + 1);
    for (const h of out) this.safeDeliver(h.item);
    this.schedule();
  }

  private safeDeliver(item: T): void {
    try {
      this.deliver(item);
    } catch (e) {
      this.log?.error('hook event handler threw', { error: String(e) });
    }
  }
}
