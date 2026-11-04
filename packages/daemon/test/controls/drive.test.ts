/**
 * 0.12.1: drive() (helpers.ts) on a slow runner. Its fake budget is spent in
 * setImmediate turns, which pass far faster than a busy runner finishes a
 * real fs call, so while one is in flight each step now waits a millisecond
 * of real time, and real time bounds the whole wait. holdFs (slow-fs.ts)
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
  it('waits out slow fs calls between two fake sleeps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccw-drive-'));
    roots.push(dir);
    const clock = new FakeClock(T0);
    const held = holdFs(300);
    try {
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
      expect(Date.now() - t).toBeGreaterThanOrEqual(290);
      expect(clock.now() - Date.parse(T0)).toBeGreaterThanOrEqual(400);
    } finally {
      held.release();
      await held;
    }
  });

  it('while an fs call is in flight each step waits a millisecond of real time, and the clock still moves', async () => {
    const clock = new FakeClock(T0);
    // Held until released below: an fs call that does not end while drive runs.
    const held = holdFs(60_000);
    try {
      const t = Date.now();
      // 100 steps of 50 ms.
      await drive(clock, clock.sleep(5_000));
      expect(Date.now() - t).toBeGreaterThanOrEqual(100);
      // It returned while the fs call was still in flight: one that does not end does not stop it.
      expect(fsInFlight().length).toBeGreaterThan(0);
    } finally {
      held.release();
      await held;
    }
  });

  it('once the fake budget is spent, a promise that settles in real time still settles', async () => {
    const clock = new FakeClock(T0);
    // Late enough that even a slow runner has spent the 10-step fake budget first.
    const late = new Promise<string>((r) => setTimeout(() => r('late'), 3_000));
    expect(await drive(clock, late, 50, 500)).toBe('late');
    expect(clock.now() - Date.parse(T0)).toBe(500);
  });

  it('a promise that never settles fails in real time, naming both budgets', async () => {
    const clock = new FakeClock(T0);
    const t = Date.now();
    await expect(drive(clock, new Promise<never>(() => {}), 50, 1_000, 300)).rejects.toThrow(
      /^did not settle: \d+ ms of fake time \(of 1000\) and \d+ ms of real time \(of 300\); fs calls in flight: (none|\w+(, \w+)*)$/,
    );
    expect(Date.now() - t).toBeGreaterThanOrEqual(300);
  });
});
