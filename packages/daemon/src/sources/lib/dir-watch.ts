/**
 * Debounced directory watching (FSEvents on macOS through fs.watch).
 *
 * Only a hint to rescan sooner: every source also polls, so a watch that
 * cannot be set up (missing dir, too many watchers) or that misses an event
 * costs latency, never correctness. Watchers are non-persistent, so they
 * never keep the daemon alive on their own.
 */
import type { FSWatcher } from 'node:fs';
import type { Clock, Logger, TimerId } from '../../contracts.js';
import { fsx } from './fsx.js';

export interface DirWatcherOptions {
  clock: Clock;
  log: Logger;
  /** Coalesce bursts of events into one callback (default 150 ms). */
  debounceMs?: number;
}

export class DirWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private timer: TimerId | undefined;
  private closed = false;
  private readonly debounceMs: number;

  constructor(
    private readonly onChange: () => void,
    private readonly opts: DirWatcherOptions,
  ) {
    this.debounceMs = opts.debounceMs ?? 150;
  }

  /** Watch exactly these directories (adds new ones, drops the rest). */
  setDirs(dirs: Iterable<string>): void {
    if (this.closed) return;
    const want = new Set(dirs);
    for (const [dir, w] of this.watchers) {
      if (!want.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of want) {
      if (this.watchers.has(dir)) continue;
      try {
        const w = fsx.watch(dir, () => this.kick());
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir); // set up again on the next setDirs()
        });
        this.watchers.set(dir, w);
      } catch {
        // missing or unwatchable: the poll covers it
      }
    }
  }

  watched(): string[] {
    return [...this.watchers.keys()];
  }

  close(): void {
    this.closed = true;
    this.opts.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private kick(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = this.opts.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      try {
        this.onChange();
      } catch (e) {
        this.opts.log.error('watch callback threw', { error: String(e) });
      }
    }, this.debounceMs);
  }
}
