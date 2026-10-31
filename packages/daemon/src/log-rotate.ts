/**
 * Keeps the daemon's own log files bounded (integration step).
 *
 * launchd points the daemon's stdout / stderr at <home>/logs/daemon.{out,err}.log
 * and never rotates them. The file descriptors stay open for the life of the
 * process, so renaming would not help: once a file passes `maxBytes`, its
 * newest `keepBytes` are copied to `<file>.1` (replacing the previous copy)
 * and the file is truncated in place. launchd opens the files with O_APPEND,
 * so later writes land at the new end.
 *
 * Only the named files inside paths.logsDir are ever touched.
 */
import { open, stat, truncate, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Clock, Logger, Service, TimerId } from './contracts.js';

export const DAEMON_LOG_FILES = ['daemon.out.log', 'daemon.err.log'] as const;

export interface LogRotatorOptions {
  logsDir: string;
  clock: Clock;
  log: Logger;
  /** Default: DAEMON_LOG_FILES. Plain file names inside logsDir. */
  files?: readonly string[];
  /** Rotate once a file is larger than this. Default 10 MiB. */
  maxBytes?: number;
  /** Bytes kept in `<file>.1`. Default 1 MiB. */
  keepBytes?: number;
  /** Check interval. Default 10 minutes. */
  intervalMs?: number;
}

export class LogRotator implements Service {
  private timer: TimerId | undefined;
  private running: Promise<void> | null = null;
  private readonly files: readonly string[];
  private readonly maxBytes: number;
  private readonly keepBytes: number;
  private readonly intervalMs: number;

  constructor(private readonly opts: LogRotatorOptions) {
    this.files = (opts.files ?? DAEMON_LOG_FILES).map((f) => basename(f));
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.keepBytes = Math.min(opts.keepBytes ?? 1024 * 1024, this.maxBytes);
    this.intervalMs = opts.intervalMs ?? 10 * 60_000;
  }

  async start(): Promise<void> {
    await this.check();
    this.timer = this.opts.clock.setInterval(() => {
      void this.check();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.opts.clock.clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One pass over every file (serialized). Resolves once done; never throws. */
  check(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const name of this.files) await this.rotateIfBig(join(this.opts.logsDir, name));
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async rotateIfBig(path: string): Promise<void> {
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size <= this.maxBytes) return;
      const keep = Math.min(this.keepBytes, st.size);
      const buf = Buffer.alloc(keep);
      const fh = await open(path, 'r');
      try {
        await fh.read(buf, 0, keep, st.size - keep);
      } finally {
        await fh.close();
      }
      // Start the kept copy at a line boundary.
      const nl = buf.indexOf(0x0a);
      const tail = nl >= 0 && nl < buf.length - 1 ? buf.subarray(nl + 1) : buf;
      await writeFile(`${path}.1`, tail, { mode: 0o600 });
      await truncate(path, 0);
      this.opts.log.info('log file rotated', { file: basename(path), bytes: st.size });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.opts.log.warn('log rotation failed', { file: basename(path), error: String(e) });
    }
  }
}
