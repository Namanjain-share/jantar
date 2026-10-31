/** Screenshots in the controls service: switches, select rules, cache, single flight and limits (C6). */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsSchema, type Settings } from '@jantar/protocol';
import type { OpResult, TerminalShot } from '../../src/contracts.js';
import { SHOT_FRESH_MS, SHOT_PANE_SPACING_MS, SHOT_SAME_TEXT_MS, Screenshots, sweepShots } from '../../src/controls/screenshot.js';
import { buildControlsService } from '../../src/controls/service.js';
import { readOnlyTerminal } from '../../src/modes.js';
import { PHONE, READER, SID, TTY, claudeScreen, drive, flush, makeRig, makeSession, pngShot, type Rig } from './helpers.js';

const ON: Settings = SettingsSchema.parse({ screenshots: { enabled: true } });
const SELECT: Settings = SettingsSchema.parse({ screenshots: { enabled: true, allowSelect: true } });

const depsOf = (rig: Rig) => ({
  sessions: { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: () => null },
  terminal: rig.terminal,
  writer: rig.writer,
  hooks: rig.hooks,
  transcripts: {} as never,
  ccwLegacy: rig.ccw,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('screenshots (C6)', () => {
  it('is refused while screenshots are off, and nothing is captured', async () => {
    const rig = makeRig();
    expect(await rig.controls.screenshot(SID, {}, PHONE)).toMatchObject({ ok: false, code: 'screenshots_off', reason: expect.stringMatching(/jantar screenshots on/) });
    expect(rig.terminal.shotCalls).toEqual([]);
  });

  it('captures without selecting by default, and answers the image with its sha256 etag', async () => {
    const rig = makeRig({ settings: ON });
    const r = await drive(rig.clock, rig.controls.screenshot(SID, { maxEdge: 1200, format: 'png' }, READER));
    if (!r.ok) throw new Error(r.reason);
    expect(rig.terminal.shotCalls).toEqual([{ maxEdge: 1200, format: 'png', select: 'never', full: false }]);
    expect(r.etag).toBe(createHash('sha256').update(r.bytes).digest('hex'));
    expect(r).toMatchObject({ mime: 'image/png', cached: false, disturbed: false });
  });

  it('select needs screenshots.allowSelect and the control scope; then the backend may select', async () => {
    const off = makeRig({ settings: ON });
    expect(await off.controls.screenshot(SID, { select: true }, PHONE)).toMatchObject({ ok: false, code: 'forbidden', reason: expect.stringMatching(/allow-select/) });
    const on = makeRig({ settings: SELECT });
    expect(await on.controls.screenshot(SID, { select: true }, READER)).toMatchObject({ ok: false, code: 'forbidden', reason: expect.stringMatching(/control scope/) });
    expect(off.terminal.shotCalls).toEqual([]);
    expect(on.terminal.shotCalls).toEqual([]);
    on.terminal.shot = async () => ({ ok: true, ...pngShot({ disturbed: true }) });
    expect(await drive(on.clock, on.controls.screenshot(SID, { select: true }, PHONE))).toMatchObject({ ok: true, disturbed: true });
    expect(on.terminal.shotCalls).toEqual([{ select: 'if-safe', full: false }]);
  });

  it('a tab that is not showing passes through as not_visible (the API answers 409)', async () => {
    const rig = makeRig({ settings: ON });
    rig.terminal.shot = async () => ({ ok: false, code: 'not_visible', reason: 'another tab is showing in that window' });
    expect(await drive(rig.clock, rig.controls.screenshot(SID, {}, PHONE))).toEqual({ ok: false, code: 'not_visible', reason: 'another tab is showing in that window' });
  });

  it('single flight: asks that arrive together share one capture', async () => {
    const rig = makeRig({ settings: ON });
    const gate = deferred<OpResult<TerminalShot>>();
    rig.terminal.shot = () => gate.promise;
    const a = rig.controls.screenshot(SID, {}, PHONE);
    const b = rig.controls.screenshot(SID, {}, READER);
    await flush();
    gate.resolve({ ok: true, ...pngShot() });
    const [ra, rb] = await Promise.all([a, b]);
    expect(rig.terminal.shotCalls).toHaveLength(1);
    expect(ra).toBe(rb);
  });

  it('serves the image again for 2.5 s, then up to 10 s while the text is unchanged, then captures again', async () => {
    const rig = makeRig({ settings: ON });
    const take = () => drive(rig.clock, rig.controls.screenshot(SID, {}, PHONE), 10);
    expect(await take()).toMatchObject({ ok: true, cached: false });
    rig.clock.advance(SHOT_FRESH_MS - 100);
    expect(await take()).toMatchObject({ ok: true, cached: true });
    rig.clock.advance(1_000);
    expect(await take()).toMatchObject({ ok: true, cached: true });
    expect(rig.terminal.shotCalls).toHaveLength(1);
    // The text changed: a new picture.
    rig.terminal.screen = claudeScreen({ mode: 'plan' });
    expect(await take()).toMatchObject({ ok: true, cached: false });
    expect(rig.terminal.shotCalls).toHaveLength(2);
    // Unchanged text, but too old.
    rig.clock.advance(SHOT_SAME_TEXT_MS);
    expect(await take()).toMatchObject({ ok: true, cached: false });
    expect(rig.terminal.shotCalls).toHaveLength(3);
  });

  it('takes at most one new capture per pane every 2 s', async () => {
    const rig = makeRig({ settings: ON });
    expect(await drive(rig.clock, rig.controls.screenshot(SID, {}, PHONE), 10)).toMatchObject({ ok: true });
    // Another size is another image, so the cache does not answer it.
    expect(await drive(rig.clock, rig.controls.screenshot(SID, { maxEdge: 800 }, PHONE), 10)).toMatchObject({ ok: false, code: 'rate_limited' });
    rig.clock.advance(SHOT_PANE_SPACING_MS);
    expect(await drive(rig.clock, rig.controls.screenshot(SID, { maxEdge: 800 }, PHONE), 10)).toMatchObject({ ok: true, cached: false });
    expect(rig.terminal.shotCalls).toHaveLength(2);
  });

  it('a refusal before screencapture runs (409) does not start the 2 s spacing: switching tabs can follow at once', async () => {
    const rig = makeRig({ settings: SELECT });
    rig.terminal.shot = async (opts) =>
      opts.select === 'if-safe' ? { ok: true, ...pngShot({ disturbed: true }) } : { ok: false, code: 'not_visible', reason: 'another tab is showing in that window' };
    expect(await drive(rig.clock, rig.controls.screenshot(SID, {}, PHONE), 10)).toMatchObject({ ok: false, code: 'not_visible' });
    expect(await drive(rig.clock, rig.controls.screenshot(SID, { select: true }, PHONE), 10)).toMatchObject({ ok: true, disturbed: true });
    expect(rig.terminal.shotCalls).toEqual([
      { select: 'never', full: false },
      { select: 'if-safe', full: false },
    ]);
    // A closed tab or a terminal that cannot capture costs nothing either.
    for (const code of ['not_found', 'unsupported'] as const) {
      const other = makeRig({ settings: ON });
      other.terminal.shot = async () => ({ ok: false, code, reason: 'no' });
      await drive(other.clock, other.controls.screenshot(SID, {}, PHONE), 10);
      other.terminal.shot = async () => ({ ok: true, ...pngShot() });
      expect(await drive(other.clock, other.controls.screenshot(SID, {}, PHONE), 10), code).toMatchObject({ ok: true, cached: false });
    }
  });

  it('a capture that ran and failed still counts toward the 2 s spacing', async () => {
    const rig = makeRig({ settings: ON });
    rig.terminal.shot = async () => ({ ok: false, code: 'permission', reason: 'Screen Recording is not allowed' });
    expect(await drive(rig.clock, rig.controls.screenshot(SID, {}, PHONE), 10)).toMatchObject({ ok: false, code: 'permission' });
    expect(await drive(rig.clock, rig.controls.screenshot(SID, {}, PHONE), 10)).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(rig.terminal.shotCalls).toHaveLength(1);
  });

  it('drops a kept image 10 s after it was taken, even when nobody asks again', async () => {
    const rig = makeRig({ settings: ON });
    const shots = new Screenshots(rig.ctx, depsOf(rig));
    const kept = (shots as unknown as { cache: Map<string, unknown> }).cache;
    expect(await drive(rig.clock, shots.take(SID, {}, PHONE), 10)).toMatchObject({ ok: true });
    expect(kept.size).toBe(1);
    rig.clock.advance(SHOT_SAME_TEXT_MS - 100);
    expect(kept.size).toBe(1);
    rig.clock.advance(100);
    expect(kept.size).toBe(0);
    expect(rig.clock.pending()).toBe(0);
    // Stopping clears the timer too.
    await drive(rig.clock, shots.take(SID, {}, PHONE), 10);
    shots.clear();
    expect(rig.clock.pending()).toBe(0);
  });

  it('runs one screencapture at a time across the daemon', async () => {
    const rig = makeRig({ settings: ON });
    const other = makeSession({ sid: '22222222-2222-4222-8222-222222222222', pid: 41002, tty: '/dev/ttys004' });
    rig.ctx.store.emit({ type: 'session.added', sid: other.sid, data: { session: other } });
    let running = 0;
    let most = 0;
    const gates = [deferred<void>(), deferred<void>()];
    let n = 0;
    rig.terminal.shot = async () => {
      running += 1;
      most = Math.max(most, running);
      await (gates[n++] as { promise: Promise<void> }).promise;
      running -= 1;
      return { ok: true, ...pngShot() };
    };
    const a = rig.controls.screenshot(SID, {}, PHONE);
    const b = rig.controls.screenshot(other.sid, {}, PHONE);
    await flush();
    expect(n).toBe(1);
    gates[0]?.resolve();
    await flush();
    expect(n).toBe(2);
    gates[1]?.resolve();
    expect(await a).toMatchObject({ ok: true });
    expect(await b).toMatchObject({ ok: true });
    expect(most).toBe(1);
  });

  it('waits for a send that holds the pane lock', async () => {
    const rig = makeRig({ settings: ON });
    const send = deferred<void>();
    void rig.writer.withPaneLock({ id: 'p', backend: 'terminal-app', handle: '1:1', tty: TTY, foreground: 'claude' }, () => send.promise);
    const r = rig.controls.screenshot(SID, {}, PHONE);
    await flush();
    expect(rig.terminal.shotCalls).toEqual([]);
    send.resolve();
    expect(await r).toMatchObject({ ok: true });
    expect(rig.terminal.shotCalls).toHaveLength(1);
  });

  it('G8: under --read-only a select request never selects', async () => {
    const rig = makeRig({ settings: SELECT });
    const controls = buildControlsService(rig.ctx, { ...depsOf(rig), terminal: readOnlyTerminal(rig.terminal) });
    await drive(rig.clock, controls.screenshot(SID, { select: true }, PHONE));
    expect(rig.terminal.shotCalls).toEqual([{ select: 'never', full: false }]);
  });

  it('refuses a session that is not running, and forgets every image when stopped', async () => {
    const rig = makeRig({ settings: ON });
    expect(await rig.controls.screenshot('nope', {}, PHONE)).toMatchObject({ ok: false, code: 'not_found' });
    await drive(rig.clock, rig.controls.screenshot(SID, {}, PHONE));
    await rig.controls.stop();
    rig.clock.advance(SHOT_PANE_SPACING_MS);
    expect(await drive(rig.clock, rig.controls.screenshot(SID, {}, PHONE))).toMatchObject({ ok: true, cached: false });
  });
});

describe('leftover captures', () => {
  it('the service removes the plain files a killed daemon left in the shots dir when it starts, and nothing else', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ccw-shots-')));
    try {
      const rig = makeRig({ ctx: { userHome: home, home: join(home, '.jantar') } });
      const dir = rig.ctx.paths.shotsDir;
      mkdirSync(join(dir, 'kept-dir'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'a1b2.png'), 'raw capture');
      writeFileSync(join(dir, 'a1b2.jpg'), 'resized capture');
      const outside = join(home, 'outside.png');
      writeFileSync(outside, 'not ours');
      symlinkSync(outside, join(dir, 'link.png'));
      const svc = rig.controls;
      await svc.start();
      expect(readdirSync(dir).sort()).toEqual(['kept-dir', 'link.png']);
      expect(existsSync(outside)).toBe(true);
      await svc.stop();
      // A missing dir is fine.
      rmSync(dir, { recursive: true, force: true });
      await expect(sweepShots(rig.ctx)).resolves.toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
