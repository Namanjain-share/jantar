/**
 * Terminal.app screenshots (terminal-app/shot.ts and shot-script.ts): the
 * no-side-effect check, the refusals, the select-capture-restore path, the
 * fixed screencapture and sips argv, sizes and formats, and the temp files
 * (C6, C7). Fake osascript, screencapture and sips answer through the fake
 * exec; the images are written to a temp dir. Nothing real runs.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCREENSHOT_FULL_MAX_BYTES, SCREENSHOT_MAX_BYTES, SettingsSchema, type Pane } from '@jantar/protocol';
import { createFakeExec, createTestContext, type ExecCall, type TestContext } from '../../src/core/testing.js';
import { TERMINAL_APP_SCRIPT, TerminalAppBackend } from '../../src/terminal/terminal-app/index.js';
import { PNG_SOFT_MAX, REDRAW_MS, imageInfo, parseShotInfo } from '../../src/terminal/terminal-app/shot.js';
import { SHOT_SCRIPT } from '../../src/terminal/terminal-app/shot-script.js';
import { drive } from '../controls/helpers.js';

const TTY = '/dev/ttys003';
const OTHER_TTY = '/dev/ttys002';
const pane: Pane = { id: 'terminal-app:ttys003', backend: 'terminal-app', handle: '4013:2', tty: TTY, foreground: 'claude' };

function png(width: number, height: number, size = 64): Buffer {
  const b = Buffer.alloc(Math.max(33, size));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number, size = 64): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03]);
  const b = Buffer.alloc(Math.max(head.length + 2, size));
  head.copy(b, 0);
  b[b.length - 2] = 0xff;
  b[b.length - 1] = 0xd9;
  return b;
}

interface Win {
  wid: string;
  selected: boolean;
  miniaturized: boolean;
  visible: boolean;
  windowFrontmost: boolean;
  appFrontmost: boolean;
  /** The tab showing in the window (tty). */
  showing: string;
}

interface Model {
  win: Win;
  /** Script modes run, in order, with any third argument. */
  modes: string[];
  capture: 'ok' | 'fail' | 'empty' | 'spawn';
  /** Size of the native PNG screencapture writes, and of the PNG sips writes. */
  rawBytes: number;
  smallBytes: number;
  jpegBytes: number;
  sipsFails: boolean;
  /** Each external program run, in order (osascript by its mode). */
  order: string[];
  /** Runs while screencapture runs (e.g. the user switching tabs). */
  onCapture?: () => void;
  /** The showing tab's tty can't be read: the script's select answers "ok" alone. */
  prevUnknown?: boolean;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function rig(over: Partial<Model> = {}, winOver: Partial<Win> = {}, bins: { screencapture?: string | null; sips?: string | null } = {}) {
  const m: Model = {
    win: { wid: '4013', selected: true, miniaturized: false, visible: true, windowFrontmost: false, appFrontmost: false, showing: TTY, ...winOver },
    modes: [],
    capture: 'ok',
    rawBytes: 4000,
    smallBytes: 2000,
    jpegBytes: 1500,
    sipsFails: false,
    order: [],
    ...over,
  };
  m.win.selected = m.win.showing === TTY;
  const exec = createFakeExec((call: ExecCall) => {
    const a = call.args;
    if (call.file.endsWith('/osascript')) {
      if (a[0] !== '-' || call.opts.input !== SHOT_SCRIPT) return { code: 99, stderr: 'contract broken' };
      if (a[1] !== TTY) return { stdout: '__JANTAR_MISSING__\n' };
      const mode = a[2] as string;
      m.modes.push(a[3] !== undefined ? `${mode} ${a[3]}` : mode);
      m.order.push(mode);
      const w = m.win;
      switch (mode) {
        case 'shotinfo':
          return { stdout: `ok\n${w.wid}\n${w.showing === TTY}\n1\n${w.windowFrontmost}\n${w.miniaturized}\n${w.visible}\n${w.appFrontmost}\n` };
        case 'select': {
          if (w.appFrontmost && w.windowFrontmost) return { stdout: '__JANTAR_IN_USE__\n' };
          if (m.prevUnknown) return { stdout: 'ok\n' };
          const prev = w.showing;
          w.showing = TTY;
          return { stdout: `ok\n${prev}\n` };
        }
        case 'restore':
          if (w.showing !== TTY) return { stdout: 'ok\nmoved\n' };
          w.showing = a[3] as string;
          return { stdout: 'ok\nrestored\n' };
        default:
          return { stdout: '__JANTAR_BAD_MODE__\n' };
      }
    }
    if (call.file.endsWith('/screencapture')) {
      m.order.push(`screencapture showing=${m.win.showing === TTY ? 'ours' : 'other'}`);
      m.onCapture?.();
      if (m.capture === 'spawn') return { code: null, spawnError: 'ENOENT' };
      if (m.capture === 'fail') return { code: 1, stderr: 'could not create image from window' };
      if (m.capture === 'ok') writeFileSync(a[a.length - 1] as string, png(2880, 1800, m.rawBytes));
      return { code: 0 };
    }
    if (call.file.endsWith('/sips')) {
      m.order.push(`sips ${a[0]}`);
      if (m.sipsFails) return { code: 1, stderr: 'sips: error' };
      const out = a[a.length - 1] as string;
      if (a[0] === '-Z') {
        const edge = Number(a[1]);
        const info = imageInfo(readFileSync(a[2] as string));
        const scale = Math.min(1, edge / Math.max(info?.width ?? 1, info?.height ?? 1));
        writeFileSync(out, png(Math.round((info?.width ?? 0) * scale), Math.round((info?.height ?? 0) * scale), m.smallBytes));
      } else {
        const info = imageInfo(readFileSync(a[6] as string));
        writeFileSync(out, jpeg(info?.width ?? 0, info?.height ?? 0, m.jpegBytes));
      }
      return { code: 0 };
    }
    return undefined;
  });
  const home = mkdtempSync(join(tmpdir(), 'ccw-shot-'));
  roots.push(home);
  const ctx: TestContext = createTestContext({
    exec,
    home,
    settings: SettingsSchema.parse({ screenshots: { enabled: true } }),
    bins: { screencapture: '/fake/bin/screencapture', sips: '/fake/bin/sips', ...bins },
  });
  const backend = new TerminalAppBackend(ctx, { platform: 'darwin' });
  return { m, exec, ctx, backend };
}

const shotFiles = (ctx: TestContext) => {
  try {
    return readdirSync(ctx.paths.shotsDir);
  } catch {
    return [];
  }
};

describe('screenshots on Terminal.app', () => {
  it('captures the showing tab: shotinfo, the fixed screencapture flags, sips -Z, a PNG, not disturbed', async () => {
    const { backend, exec, ctx, m } = rig();
    const r = await backend.getScreenshot(pane, { maxEdge: 1600 });
    expect(r).toMatchObject({ ok: true, mime: 'image/png', width: 1600, height: 1000, windowId: '4013', disturbed: false, at: ctx.clock.iso() });
    expect(m.modes).toEqual(['shotinfo']);
    const cap = exec.calls.find((c) => c.file.endsWith('/screencapture'));
    expect(cap?.args.slice(0, -1)).toEqual(['-x', '-o', '-a', '-r', '-l', '4013', '-t', 'png']);
    expect(cap?.args.at(-1)?.startsWith(`${ctx.paths.shotsDir}/`)).toBe(true);
    expect(cap?.opts.timeoutMs).toBe(10_000);
    const sips = exec.calls.filter((c) => c.file.endsWith('/sips'));
    expect(sips).toHaveLength(1);
    expect(sips[0]?.args.slice(0, 2)).toEqual(['-Z', '1600']);
    expect(sips[0]?.args[3]).toBe('--out');
  });

  it('C6: another tab showing gives not_visible, and nothing is selected or captured', async () => {
    const { backend, exec, m } = rig({}, { showing: OTHER_TTY });
    expect(await backend.getScreenshot(pane)).toMatchObject({ ok: false, code: 'not_visible', reason: 'another tab is showing in that window' });
    expect(m.modes).toEqual(['shotinfo']);
    expect(m.win.showing).toBe(OTHER_TTY);
    expect(exec.calls.some((c) => c.file.endsWith('/screencapture'))).toBe(false);
  });

  it('C6: a minimized or hidden window is refused without being touched', async () => {
    for (const win of [{ miniaturized: true }, { visible: false }]) {
      const { backend, exec, m } = rig({}, win);
      expect(await backend.getScreenshot(pane, { select: 'if-safe' }), JSON.stringify(win)).toMatchObject({
        ok: false,
        code: 'not_visible',
        reason: expect.stringMatching(/minimized or hidden/),
      });
      expect(m.modes).toEqual(['shotinfo']);
      expect(exec.calls.filter((c) => !c.file.endsWith('/osascript'))).toEqual([]);
    }
  });

  it('C6: select: selects our tab, waits for the redraw, captures it, puts the other tab back before resizing', async () => {
    const { backend, ctx, m } = rig({}, { showing: OTHER_TTY });
    const started = ctx.clock.now();
    const r = await drive(ctx.clock, backend.getScreenshot(pane, { select: 'if-safe' }));
    expect(r).toMatchObject({ ok: true, disturbed: true });
    expect(m.modes).toEqual(['shotinfo', 'select', `restore ${OTHER_TTY}`]);
    expect(m.order).toEqual(['shotinfo', 'select', 'screencapture showing=ours', 'restore', 'sips -Z']);
    expect(m.win.showing).toBe(OTHER_TTY);
    expect(ctx.clock.now() - started).toBeGreaterThanOrEqual(REDRAW_MS);
  });

  it('C6: select is refused while Terminal is the active app with that window in front (it would take keystrokes)', async () => {
    const { backend, exec, m } = rig({}, { showing: OTHER_TTY, appFrontmost: true, windowFrontmost: true });
    expect(await backend.getScreenshot(pane, { select: 'if-safe' })).toMatchObject({ ok: false, code: 'not_visible' });
    expect(m.modes).toEqual(['shotinfo', 'select']);
    expect(m.win.showing).toBe(OTHER_TTY);
    expect(exec.calls.some((c) => c.file.endsWith('/screencapture'))).toBe(false);
  });

  it("C6: select changes nothing when the showing tab's tty can't be read (it could not be put back)", async () => {
    const { backend, exec, ctx, m } = rig({ prevUnknown: true }, { showing: OTHER_TTY });
    expect(await drive(ctx.clock, backend.getScreenshot(pane, { select: 'if-safe' }))).toMatchObject({ ok: false, code: 'not_visible' });
    expect(m.modes).toEqual(['shotinfo', 'select']);
    expect(m.win.showing).toBe(OTHER_TTY);
    expect(exec.calls.some((c) => c.file.endsWith('/screencapture'))).toBe(false);
  });

  it('C6: the previous tab is put back even when the capture fails, and only if ours is still showing', async () => {
    const failed = rig({ capture: 'fail' }, { showing: OTHER_TTY });
    expect(await drive(failed.ctx.clock, failed.backend.getScreenshot(pane, { select: 'if-safe' }))).toMatchObject({ ok: false, code: 'permission' });
    expect(failed.m.modes).toEqual(['shotinfo', 'select', `restore ${OTHER_TTY}`]);
    expect(failed.m.win.showing).toBe(OTHER_TTY);

    // The user switched to a third tab during the capture: their choice stands.
    const moved = rig({ capture: 'fail' }, { showing: OTHER_TTY });
    moved.m.onCapture = () => (moved.m.win.showing = '/dev/ttys009');
    const r = await drive(moved.ctx.clock, moved.backend.getScreenshot(pane, { select: 'if-safe' }));
    expect(r).toMatchObject({ ok: false, code: 'permission' });
    expect(moved.m.modes).toEqual(['shotinfo', 'select', `restore ${OTHER_TTY}`]);
    expect(moved.m.win.showing).toBe('/dev/ttys009');
  });

  it('C6: every temp file is unlinked, after a capture and after each kind of failure; the dir is 0700', async () => {
    const cases: Partial<Model>[] = [{}, { capture: 'fail' }, { capture: 'empty' }, { sipsFails: true }, { rawBytes: 20, smallBytes: 20 }];
    for (const over of cases) {
      const { backend, ctx } = rig(over);
      await backend.getScreenshot(pane);
      expect(shotFiles(ctx), JSON.stringify(over)).toEqual([]);
      expect(statSync(ctx.paths.shotsDir).mode & 0o777).toBe(0o700);
    }
  });

  it('a failed or empty capture names the binary that needs Screen Recording', async () => {
    for (const capture of ['fail', 'empty'] as const) {
      const { backend, ctx } = rig({ capture });
      const r = await backend.getScreenshot(pane);
      expect(r).toMatchObject({ ok: false, code: 'permission' });
      expect(!r.ok && r.reason).toContain(ctx.bins.node);
      expect(!r.ok && r.reason).toContain('Screen Recording');
    }
    expect(await rig({ capture: 'spawn' }).backend.getScreenshot(pane)).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('JPEG 75 when asked for, and when the resized PNG is over 1.5 MB', async () => {
    const asked = rig();
    const r = await asked.backend.getScreenshot(pane, { format: 'jpeg', maxEdge: 1200 });
    expect(r).toMatchObject({ ok: true, mime: 'image/jpeg', width: 1200, height: 750 });
    const conv = asked.exec.calls.filter((c) => c.file.endsWith('/sips'))[1];
    expect(conv?.args.slice(0, 4)).toEqual(['-s', 'format', 'jpeg', '-s']);
    expect(conv?.args.slice(4, 5)).toEqual(['formatOptions']);
    expect(conv?.args[5]).toBe('75');

    const big = rig({ smallBytes: Math.ceil(PNG_SOFT_MAX) + 10 });
    expect(await big.backend.getScreenshot(pane)).toMatchObject({ ok: true, mime: 'image/jpeg' });
    const small = rig({ smallBytes: 1000 });
    expect(await small.backend.getScreenshot(pane)).toMatchObject({ ok: true, mime: 'image/png' });
  });

  it('caps the reply at 2 MB, or 6 MB at native size (full skips the resize)', async () => {
    const over = rig({ smallBytes: Math.ceil(PNG_SOFT_MAX) + 10, jpegBytes: SCREENSHOT_MAX_BYTES + 1 });
    expect(await over.backend.getScreenshot(pane)).toMatchObject({ ok: false, code: 'failed', reason: expect.stringMatching(/larger than 2 MB/) });
    expect(shotFiles(over.ctx)).toEqual([]);

    const full = rig({ rawBytes: 1000 });
    const r = await full.backend.getScreenshot(pane, { full: true });
    expect(r).toMatchObject({ ok: true, mime: 'image/png', width: 2880, height: 1800 });
    expect(full.exec.calls.filter((c) => c.file.endsWith('/sips'))).toEqual([]);

    const fullBig = rig({ rawBytes: Math.ceil(PNG_SOFT_MAX) + 10, jpegBytes: SCREENSHOT_MAX_BYTES + 1 });
    expect(await fullBig.backend.getScreenshot(pane, { full: true })).toMatchObject({ ok: true, mime: 'image/jpeg' });
    const fullOver = rig({ rawBytes: Math.ceil(PNG_SOFT_MAX) + 10, jpegBytes: SCREENSHOT_FULL_MAX_BYTES + 1 });
    expect(await fullOver.backend.getScreenshot(pane, { full: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/6 MB/) });
  });

  it('is unsupported without screencapture or sips, and runs nothing', async () => {
    for (const bins of [{ screencapture: null }, { sips: null }]) {
      const { backend, exec } = rig({}, {}, bins);
      expect(await backend.getScreenshot(pane)).toMatchObject({ ok: false, code: 'unsupported' });
      expect(exec.calls).toEqual([]);
    }
  });

  it('a closed tab or a stopped Terminal is not_found', async () => {
    const { backend } = rig();
    expect(await backend.getScreenshot({ ...pane, tty: '/dev/ttys077' })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('screenshot parsing', () => {
  it('reads PNG and JPEG sizes and nothing else', () => {
    expect(imageInfo(png(800, 500))).toEqual({ mime: 'image/png', width: 800, height: 500 });
    expect(imageInfo(jpeg(1200, 750))).toEqual({ mime: 'image/jpeg', width: 1200, height: 750 });
    for (const bad of [Buffer.from('<html><script>'), Buffer.alloc(0), png(0, 10), Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])]) expect(imageInfo(bad)).toBeNull();
  });

  it('reads the shotinfo answer strictly', () => {
    expect(parseShotInfo('4013\ntrue\n2\nfalse\nfalse\ntrue\nfalse')).toEqual({
      windowId: '4013',
      selected: true,
      windowIndex: 2,
      windowFrontmost: false,
      miniaturized: false,
      visible: true,
      appFrontmost: false,
    });
    expect(parseShotInfo('4013; rm -rf\ntrue\n1\nfalse\nfalse\ntrue\nfalse')).toBeNull();
    expect(parseShotInfo('4013\nyes\n1\nfalse\nfalse\ntrue\nfalse')).toBeNull();
  });
});

describe('C7: the screenshot script is constant and gets values through argv only', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('has no interpolation, never activates Terminal or raises a window', () => {
    expect(SHOT_SCRIPT).not.toContain('${');
    expect(SHOT_SCRIPT).not.toMatch(/\bactivate\b|set index of|miniaturized of window id foundWid to/);
    const src = strip(readFileSync(join(__dirname, '../../src/terminal/terminal-app/shot-script.ts'), 'utf8'));
    // One template literal, holding no placeholder.
    expect(src.match(/`/g)).toHaveLength(2);
    expect(src).not.toContain('${');
  });

  it('select returns before switching when it cannot name the tab to put back', () => {
    const branch = SHOT_SCRIPT.slice(SHOT_SCRIPT.indexOf('else if mode is "select"'), SHOT_SCRIPT.indexOf('else if mode is "restore"'));
    const guard = branch.indexOf('if prevTty is "" then return "ok"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(branch.indexOf('set selected of tab foundIdx'));
  });

  it('shot.ts runs only SHOT_SCRIPT, with the tty and the previous tty in argv', async () => {
    const src = strip(readFileSync(join(__dirname, '../../src/terminal/terminal-app/shot.ts'), 'utf8'));
    expect(src.match(/runScript\(/g)).toEqual(['runScript(']);
    expect(src).toContain('host.runScript(SHOT_SCRIPT, args');
    expect(src).not.toMatch(/tell application|do script/);

    // A tab name that would be AppleScript if it were ever pasted into the script.
    const odd = '/dev/ttys002" & (do shell script "touch /tmp/zq7-marker") & "';
    const { backend, exec, ctx, m } = rig({}, { showing: odd });
    expect(await drive(ctx.clock, backend.getScreenshot(pane, { select: 'if-safe' }))).toMatchObject({ ok: true, disturbed: true });
    expect(m.modes).toEqual(['shotinfo', 'select', `restore ${odd}`]);
    const osa = exec.calls.filter((x) => x.file.endsWith('/osascript'));
    expect(osa.at(-1)?.args).toEqual(['-', TTY, 'restore', odd]);
    for (const c of osa) {
      expect(c.opts.input).toBe(SHOT_SCRIPT);
      expect(c.opts.input).not.toContain('zq7-marker');
    }
    // The prompt-typing script is never used for screenshots.
    expect(osa.some((c) => c.opts.input === TERMINAL_APP_SCRIPT)).toBe(false);
  });
});
