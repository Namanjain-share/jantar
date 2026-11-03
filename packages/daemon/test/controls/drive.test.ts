/**
 * 0.12.1: drive() (helpers.ts) on a slow runner. Its fake budget is spent in
 * setImmediate turns, which pass far faster than a busy runner finishes a
 * real fs call, so the fake clock now runs no faster than real time while
 * one is in flight, and real time bounds the whole wait. holdFs (slow-fs.ts)
 * makes the slow disk on purpose.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { T0, drive, fsInFlight } from './helpers.js';
import { holdFs } from './slow-fs.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('0.12.1: drive on a slow runner', () => {
  it('waits out slow fs calls, and the fake clock runs no faster than real time meanwhile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccw-drive-'));
    roots.push(dir);
    const clock = new FakeClock(T0);
    const held = holdFs(300);
    const work = (async () => {
      await clock.sleep(200);
      await mkdir(join(dir, 'a'));
      await writeFile(join(dir, 'a', 'b'), 'x');
      const text = await readFile(join(dir, 'a', 'b'), 'utf8');
      await clock.sleep(200);
      return text;
    })();
    const t = Date.now();
    expect(await drive(clock, work)).toBe('x');
    const real = Date.now() - t;
    const fake = clock.now() - Date.parse(T0);
    expect(real).toBeGreaterThanOrEqual(290);
    expect(fake).toBeGreaterThanOrEqual(400);
    // Held: at most real time (plus a step); after: the second sleep, at full speed.
    expect(fake).toBeLessThanOrEqual(real + 50 + 200);
    await held;
  });

  it('an fs call that does not end does not stop the fake clock: it runs at real time', async () => {
    const clock = new FakeClock(T0);
    const held = holdFs(1_000);
    const t = Date.now();
    await drive(clock, clock.sleep(300));
    expect(Date.now() - t).toBeLessThan(800);
    expect(fsInFlight().length).toBeGreaterThan(0);
    await held;
  });

  it('once the fake budget is spent, a promise that settles in real time still settles', async () => {
    const clock = new FakeClock(T0);
    const late = new Promise<string>((r) => setTimeout(() => r('late'), 150));
    expect(await drive(clock, late, 50, 500)).toBe('late');
    expect(clock.now() - Date.parse(T0)).toBe(500);
  });

  it('a promise that never settles fails in real time, naming both budgets', async () => {
    const clock = new FakeClock(T0);
    const t = Date.now();
    await expect(drive(clock, new Promise<never>(() => {}), 50, 1_000, 300)).rejects.toThrow(
      /^did not settle: 1000 ms of fake time \(of 1000\) and \d+ ms of real time \(of 300\); fs calls in flight: none$/,
    );
    expect(Date.now() - t).toBeGreaterThanOrEqual(300);
  });
});
