import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/core/clock.js';
import { memoryLogger } from '../src/core/log.js';
import { LogRotator } from '../src/log-rotate.js';

describe('LogRotator', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), '.jantar-test-logs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const lines = (n: number, width = 99) => Array.from({ length: n }, (_, i) => `${String(i).padStart(6, '0')} ${'x'.repeat(width - 7)}`).join('\n') + '\n';

  it('keeps the newest lines in <file>.1 and truncates the live file once it passes the limit', async () => {
    const file = join(dir, 'daemon.err.log');
    await writeFile(file, lines(200)); // 20 000 bytes
    const log = memoryLogger();
    const r = new LogRotator({ logsDir: dir, clock: new FakeClock(), log, maxBytes: 10_000, keepBytes: 1_050 });
    await r.check();
    expect((await stat(file)).size).toBe(0);
    const kept = await readFile(`${file}.1`, 'utf8');
    expect(kept.length).toBeLessThanOrEqual(1_050);
    expect(kept.startsWith('0001')).toBe(true); // starts on a line boundary
    expect(kept.endsWith('000199 ' + 'x'.repeat(92) + '\n')).toBe(true);
    expect(log.records.some((x) => x.msg === 'log file rotated')).toBe(true);
  });

  it('leaves small and missing files alone, and only touches its own file names', async () => {
    const small = join(dir, 'daemon.out.log');
    const other = join(dir, 'other.log');
    await writeFile(small, 'short\n');
    await writeFile(other, lines(200));
    const r = new LogRotator({ logsDir: dir, clock: new FakeClock(), log: memoryLogger(), maxBytes: 10_000 });
    await r.check();
    expect(await readFile(small, 'utf8')).toBe('short\n');
    expect((await stat(other)).size).toBe(20_000);
  });

  it('checks again on its interval and stops cleanly', async () => {
    const clock = new FakeClock();
    const file = join(dir, 'daemon.out.log');
    const r = new LogRotator({ logsDir: dir, clock, log: memoryLogger(), maxBytes: 1_000, keepBytes: 100, intervalMs: 60_000 });
    await r.start();
    await writeFile(file, lines(50));
    await clock.advance(60_000);
    await r.check();
    expect((await stat(file)).size).toBe(0);
    await r.stop();
    await writeFile(file, lines(50));
    await clock.advance(120_000);
    expect((await stat(file)).size).toBe(5_000);
  });
});
