/**
 * Sliding-window rate limiter keyed by caller (IP, device, ...). There is no
 * global bucket, so one noisy caller can never lock everyone else out. The
 * key map is bounded: expired keys are swept on use and the oldest keys are
 * dropped past `maxKeys`.
 */
import type { Clock } from '../contracts.js';

export interface RateLimitOptions {
  /** Attempts allowed per window. */
  limit: number;
  windowMs: number;
  clock: Pick<Clock, 'now'>;
  /** Keys tracked at most (default 10 000). */
  maxKeys?: number;
}

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; retryAfterMs: number };

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxKeys: number;
  private lastSweep = 0;

  constructor(private readonly opts: RateLimitOptions) {
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Record one attempt for `key`; refused when the window is full (refused attempts are not recorded). */
  hit(key: string): RateLimitResult {
    const now = this.opts.clock.now();
    this.sweep(now);
    const since = now - this.opts.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.opts.limit) {
      this.hits.set(key, list);
      const oldest = list[0] ?? now;
      return { ok: false, retryAfterMs: Math.max(1, oldest + this.opts.windowMs - now) };
    }
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list); // re-insert: Map order = least recently used first
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
    return { ok: true, remaining: this.opts.limit - list.length };
  }

  /**
   * What `hit` would answer now, recording nothing (`remaining` counts this
   * one as not yet made). Check first and hit once the request is taken, so
   * a request refused for another reason spends nothing.
   */
  check(key: string): RateLimitResult {
    const now = this.opts.clock.now();
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.opts.windowMs);
    if (list.length < this.opts.limit) return { ok: true, remaining: this.opts.limit - list.length };
    return { ok: false, retryAfterMs: Math.max(1, (list[0] ?? now) + this.opts.windowMs - now) };
  }

  /** Number of keys currently tracked (tests). */
  size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.opts.windowMs) return;
    this.lastSweep = now;
    const since = now - this.opts.windowMs;
    for (const [k, list] of this.hits) {
      if (!list.some((t) => t > since)) this.hits.delete(k);
    }
  }
}

export interface BudgetOptions {
  /** Units (bytes, ...) allowed per window. */
  limit: number;
  windowMs: number;
  clock: Pick<Clock, 'now'>;
  maxKeys?: number;
}

/**
 * A sliding-window budget of units per key (e.g. raw file bytes per device
 * per 10 minutes). `take` records an amount only when it still fits, so a
 * refused request costs nothing.
 */
export class SlidingWindowBudget {
  private readonly used = new Map<string, { at: number; amount: number }[]>();
  private readonly maxKeys: number;

  constructor(private readonly opts: BudgetOptions) {
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  take(key: string, amount: number): RateLimitResult {
    const now = this.opts.clock.now();
    const since = now - this.opts.windowMs;
    const list = (this.used.get(key) ?? []).filter((e) => e.at > since);
    const total = list.reduce((n, e) => n + e.amount, 0);
    if (total + amount > this.opts.limit) {
      this.used.set(key, list);
      const oldest = list[0]?.at ?? now;
      return { ok: false, retryAfterMs: Math.max(1, oldest + this.opts.windowMs - now) };
    }
    list.push({ at: now, amount });
    this.used.delete(key);
    this.used.set(key, list);
    while (this.used.size > this.maxKeys) {
      const first = this.used.keys().next().value;
      if (first === undefined) break;
      this.used.delete(first);
    }
    return { ok: true, remaining: this.opts.limit - total - amount };
  }
}
