/**
 * A clock an end-to-end test moves forward, for the Life pings (a medicine
 * at 08:00, a bill at 09:00) without waiting for them: `now()` is the wall
 * clock plus an offset, and every timer keeps its due time on this clock.
 * `jumpTo(t)` moves now to `t` and re-arms the timers, so each one it passed
 * fires at once (an interval once, then on from the jump), the way a Mac
 * waking from sleep runs its overdue timers. Between jumps time runs at the
 * wall clock's pace, with real timers.
 */
import type { Clock, TimerId } from '@jantar/daemon';

interface WarpTimer {
  id: number;
  /** Due, on this clock. */
  at: number;
  fn: () => void;
  every?: number;
  real?: ReturnType<typeof setTimeout>;
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export class WarpClock implements Clock {
  private offset = 0;
  private nextId = 1;
  private readonly timers = new Map<number, WarpTimer>();

  now(): number {
    return Date.now() + this.offset;
  }

  iso(ms?: number): string {
    return new Date(ms ?? this.now()).toISOString();
  }

  setTimeout(fn: () => void, ms: number): TimerId {
    return this.add({ id: this.nextId++, at: this.now() + Math.max(0, ms), fn });
  }

  setInterval(fn: () => void, ms: number): TimerId {
    const every = Math.max(1, ms);
    return this.add({ id: this.nextId++, at: this.now() + every, fn, every });
  }

  clearTimeout(id: TimerId | undefined): void {
    this.drop(id);
  }

  clearInterval(id: TimerId | undefined): void {
    this.drop(id);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const onAbort = () => {
        this.clearTimeout(id);
        reject(abortError());
      };
      const id = this.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Move now forward to `ms` (epoch ms on this clock) and fire every timer it passed. */
  jumpTo(ms: number): void {
    if (ms <= this.now()) throw new Error(`WarpClock moves forward only: ${new Date(ms).toISOString()} is not after ${this.iso()}`);
    this.offset = ms - Date.now();
    for (const t of this.timers.values()) this.arm(t);
  }

  private add(t: WarpTimer): TimerId {
    this.timers.set(t.id, t);
    this.arm(t);
    return t.id as unknown as TimerId;
  }

  private drop(id: TimerId | undefined): void {
    if (id === undefined) return;
    const key = id as unknown as number;
    const t = this.timers.get(key);
    if (t?.real) clearTimeout(t.real);
    this.timers.delete(key);
  }

  private arm(t: WarpTimer): void {
    if (t.real) clearTimeout(t.real);
    t.real = setTimeout(() => {
      t.real = undefined;
      if (this.timers.get(t.id) !== t) return;
      if (t.every) {
        // Once per jump, however many periods it passed; then on from now.
        t.at += t.every;
        if (t.at <= this.now()) t.at = this.now() + t.every;
        this.arm(t);
      } else {
        this.timers.delete(t.id);
      }
      t.fn();
    }, Math.max(0, t.at - this.now()));
  }
}
