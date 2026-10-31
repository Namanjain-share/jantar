import type { Clock, TimerId } from '../contracts.js';

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  iso: (ms?: number) => new Date(ms ?? Date.now()).toISOString(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerId,
  clearTimeout: (id) => {
    if (id !== undefined) clearTimeout(id as unknown as NodeJS.Timeout);
  },
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as TimerId,
  clearInterval: (id) => {
    if (id !== undefined) clearInterval(id as unknown as NodeJS.Timeout);
  },
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

interface FakeTimer {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
  every?: number;
}

/**
 * A manual clock for tests. Time moves only through `advance()` / `set()`,
 * which run due timers in time order (ties in creation order).
 */
export class FakeClock implements Clock {
  private t: number;
  private timers = new Map<number, FakeTimer>();
  private nextId = 1;
  private nextSeq = 1;

  constructor(start: number | string = '2026-01-15T10:00:00.000Z') {
    this.t = typeof start === 'string' ? Date.parse(start) : start;
  }

  now(): number {
    return this.t;
  }

  iso(ms?: number): string {
    return new Date(ms ?? this.t).toISOString();
  }

  setTimeout(fn: () => void, ms: number): TimerId {
    return this.add(fn, ms);
  }

  setInterval(fn: () => void, ms: number): TimerId {
    return this.add(fn, ms, Math.max(1, ms));
  }

  clearTimeout(id: TimerId | undefined): void {
    if (id !== undefined) this.timers.delete(id as unknown as number);
  }

  clearInterval(id: TimerId | undefined): void {
    this.clearTimeout(id);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const id = this.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        this.clearTimeout(id);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Number of pending timers. */
  pending(): number {
    return this.timers.size;
  }

  /** Move time forward, running every timer that falls due (synchronously). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((x) => x.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.every !== undefined) {
        due.at += due.every;
        due.seq = this.nextSeq++;
      } else {
        this.timers.delete(due.id);
      }
      due.fn();
    }
    this.t = target;
  }

  /** Like advance(), then lets pending promise callbacks run (await it in tests). */
  async tick(ms: number): Promise<void> {
    this.advance(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  set(ms: number | string): void {
    const target = typeof ms === 'string' ? Date.parse(ms) : ms;
    this.advance(Math.max(0, target - this.t));
  }

  private add(fn: () => void, ms: number, every?: number): TimerId {
    const id = this.nextId++;
    const timer: FakeTimer = { id, at: this.t + Math.max(0, ms), seq: this.nextSeq++, fn };
    if (every !== undefined) timer.every = every;
    this.timers.set(id, timer);
    return id as unknown as TimerId;
  }
}
