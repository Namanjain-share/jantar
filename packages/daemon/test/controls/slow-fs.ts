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

export function holdFs(ms: number): Promise<void> {
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
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      for (const fd of fds) writeSync(fd, 'x');
      void Promise.all(reads).then(() => {
        for (const fd of fds) closeSync(fd);
        rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    }, ms);
  });
}
