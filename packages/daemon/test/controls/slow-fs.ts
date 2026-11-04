/**
 * 0.12.1: a slow runner's disk, made on purpose. Every libuv threadpool thread
 * waits in read() on a FIFO of our own (in a temp dir) for `ms` of real time,
 * so each fs call made meanwhile queues behind them: the shape of the CI
 * failures where a fake-clock driver gave up while a real mkdir or readFile
 * was still pending. Race-free: each FIFO is opened read-write, so the byte
 * that frees a thread is waiting for it even if its read() has not started.
 * Resolves once the threads are free and the FIFOs are gone. POSIX only.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, read, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function holdFs(ms: number): Promise<void> & { release: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ccw-hold-'));
  const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  const fds: number[] = [];
  const reads: Promise<void>[] = [];
  for (let i = 0; i < threads; i++) {
    const fifo = join(dir, `q${i}`);
    execFileSync('mkfifo', [fifo]);
    const fd = openSync(fifo, constants.O_RDWR);
    fds.push(fd);
    reads.push(new Promise<void>((r) => read(fd, Buffer.alloc(1), 0, 1, null, () => r())));
  }
  // 0.12.1: release() frees the threads early (a test does it in a finally, so a failed assertion never leaves
  // the threadpool held for the next test); the timer does it after `ms` otherwise. Either way only once.
  let free = (): void => {};
  const done = new Promise<void>((resolve) => {
    let freed = false;
    free = () => {
      if (freed) return;
      freed = true;
      clearTimeout(timer);
      for (const fd of fds) writeSync(fd, 'x');
      void Promise.all(reads).then(() => {
        for (const fd of fds) closeSync(fd);
        rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    };
    const timer = setTimeout(() => free(), ms);
  });
  return Object.assign(done, { release: () => free() });
}
