/**
 * Terminal screenshots for Terminal.app (work package C owns this file, and
 * its own constant script in shot-script.ts). The controls addendum's
 * pipeline, option A by default and C only on request:
 *
 *  1. `shotinfo` (no side effects): the window id, whether our tab is the
 *     one showing, and whether the window is minimized or hidden.
 *  2. A minimized or hidden window is refused ('not_visible'); nothing is
 *     de-miniaturized.
 *  3. Our tab showing: capture it, `disturbed: false`.
 *  4. Another tab showing: 'not_visible' ("another tab is showing in that
 *     window"), unless `select: 'if-safe'`: `select` our tab (refused by the
 *     script itself while Terminal is the active app with this window in
 *     front, or when the showing tab's tty can't be read to put it back),
 *     wait for the redraw, capture, then `restore` the tab that was showing
 *     at once, before the slower resize. `disturbed: true`.
 *  5. `screencapture -x -o -a -r -l <wid> -t png <tmp>`: no sound, no
 *     shadow, no attached sheets, no dpi metadata; a covered window is still
 *     captured without being raised. tmp lives in ctx.paths.shotsDir (0700)
 *     and every file is unlinked in `finally`.
 *  6. `sips -Z <maxEdge>` (skipped with `full`), then JPEG 75 when asked
 *     for or when the PNG is over 1.5 MB. Caps: SCREENSHOT_MAX_BYTES, or
 *     SCREENSHOT_FULL_MAX_BYTES with `full`.
 *
 * A failed or empty capture almost always means macOS has not given Screen
 * Recording to the daemon's node binary: the reason names that binary.
 * Binaries come from ctx.bins.screencapture / ctx.bins.sips (null:
 * 'unsupported'). Every value reaches a program through argv, never a shell.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SCREENSHOT_FULL_MAX_BYTES, SCREENSHOT_MAX_BYTES, type Pane } from '@jantar/protocol';
import type { DaemonContext, OpResult, ScreenshotRequest, TerminalErrorCode, TerminalShot } from '../../contracts.js';
import type { TerminalAppHost } from './host.js';
import { BAD_MODE, MISSING, NOT_RUNNING } from './script.js';
import { SHOT_IN_USE, SHOT_SCRIPT, type ShotScriptMode } from './shot-script.js';

/** Above this a PNG is re-encoded as JPEG (below it terminal text stays sharper as PNG). */
export const PNG_SOFT_MAX = 1.5 * 1024 * 1024;
export const JPEG_QUALITY = 75;
/** Terminal draws a tab it just selected within a frame or two. */
export const REDRAW_MS = 200;
export const CAPTURE_TIMEOUT_MS = 10_000;
export const SIPS_TIMEOUT_MS = 15_000;
/** The long edge a resize may ask for (ScreenshotQuerySchema's `max`). */
export const MIN_EDGE = 320;
export const MAX_EDGE = 4000;

type Failure = { ok: false; code: TerminalErrorCode; reason: string };

function fail(code: TerminalErrorCode, reason: string): Failure {
  return { ok: false, code, reason };
}

export interface ShotInfo {
  windowId: string;
  /** Our tab is the one the window shows. */
  selected: boolean;
  windowIndex: number;
  windowFrontmost: boolean;
  miniaturized: boolean;
  visible: boolean;
  /** Terminal is the active app. */
  appFrontmost: boolean;
}

/** The `shotinfo` answer (after "ok\n"), or null when it is not one. */
export function parseShotInfo(out: string): ShotInfo | null {
  const f = out.split('\n').map((s) => s.trim());
  const bool = (s: string | undefined) => (s === 'true' ? true : s === 'false' ? false : null);
  const [wid, sel, idx, winFront, mini, vis, appFront] = f;
  const flags = [bool(sel), bool(winFront), bool(mini), bool(vis), bool(appFront)];
  if (!wid || !/^\d{1,10}$/u.test(wid) || !idx || !/^\d+$/u.test(idx) || flags.some((b) => b === null)) return null;
  const [selected, windowFrontmost, miniaturized, visible, appFrontmost] = flags as boolean[];
  return {
    windowId: wid,
    selected: selected as boolean,
    windowIndex: Number(idx),
    windowFrontmost: windowFrontmost as boolean,
    miniaturized: miniaturized as boolean,
    visible: visible as boolean,
    appFrontmost: appFrontmost as boolean,
  };
}

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** Type and pixel size of a PNG (IHDR) or JPEG (first SOF marker); null for anything else. */
export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    const width = b.readUInt32BE(16);
    const height = b.readUInt32BE(20);
    return width > 0 && height > 0 ? { mime: 'image/png', width, height } : null;
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] as number;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan before any frame header
    const len = b.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= b.length) return null;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : null;
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Run SHOT_SCRIPT with values only in argv; the tab-finding markers become errors. */
async function shotScript(host: TerminalAppHost, tty: string, mode: ShotScriptMode, extra?: string): Promise<OpResult<{ out: string }>> {
  const args = [tty, mode];
  if (extra !== undefined) args.push(extra);
  const r = await host.runScript(SHOT_SCRIPT, args, { label: mode });
  if (!r.ok) return r;
  const out = r.out;
  if (out === MISSING) return fail('not_found', 'that Terminal tab is no longer open');
  if (out === NOT_RUNNING) return fail('not_found', 'Terminal is not running');
  if (out === BAD_MODE) return fail('failed', `unknown screenshot script mode ${mode}`);
  if (out === SHOT_IN_USE) return { ok: true, out };
  if (out === 'ok') return { ok: true, out: '' };
  if (out.startsWith('ok\n')) return { ok: true, out: out.slice(3) };
  return fail('failed', 'Terminal gave an unexpected answer');
}

async function shotsDir(ctx: DaemonContext): Promise<string> {
  const dir = ctx.paths.shotsDir;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir keeps the mode of a dir that already exists.
  await chmod(dir, 0o700);
  return dir;
}

/** Size of a regular file, or 0 when it is missing, empty or not a plain file. */
async function fileSize(path: string): Promise<number> {
  try {
    const st = await lstat(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function screenRecordingReason(ctx: DaemonContext): string {
  return `screencapture could not capture the window. Is Screen Recording allowed for ${ctx.bins.node}? (System Settings > Privacy & Security > Screen Recording)`;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function screenshotImpl(host: TerminalAppHost, pane: Pane, opts: ScreenshotRequest = {}): Promise<OpResult<TerminalShot>> {
  const { ctx } = host;
  const screencapture = ctx.bins.screencapture;
  const sips = ctx.bins.sips;
  if (!screencapture || !sips) return fail('unsupported', 'screencapture or sips is not available on this Mac');
  const maxEdge = Math.max(MIN_EDGE, Math.min(MAX_EDGE, Math.floor(opts.maxEdge ?? ctx.settings.get().screenshots.maxEdge)));
  const cap = opts.full ? SCREENSHOT_FULL_MAX_BYTES : SCREENSHOT_MAX_BYTES;

  const asked = await shotScript(host, pane.tty, 'shotinfo');
  if (!asked.ok) return asked;
  const info = parseShotInfo(asked.out);
  if (!info) return fail('failed', 'Terminal gave an unexpected answer');
  if (info.miniaturized || !info.visible) return fail('not_visible', 'the Terminal window is minimized or hidden');

  // The tty of the tab that was showing, once ours was selected for the capture.
  let previous: string | null = null;
  if (!info.selected) {
    if (opts.select !== 'if-safe') return fail('not_visible', 'another tab is showing in that window');
    const sel = await shotScript(host, pane.tty, 'select');
    if (!sel.ok) return sel;
    if (sel.out === SHOT_IN_USE) return fail('not_visible', 'another tab is showing in that window, and Terminal is in use with that window in front');
    // The script selects nothing when it can't name the tab to put back.
    if (!sel.out.trim()) return fail('not_visible', "another tab is showing in that window, and it couldn't be told which one to put back");
    previous = sel.out.trim();
    ctx.log.info('screenshot selected a background tab', { pane: pane.id });
  }
  const disturbed = previous !== null;
  const restore = async () => {
    const prev = previous;
    previous = null;
    if (!prev) return;
    const r = await shotScript(host, pane.tty, 'restore', prev);
    if (!r.ok) ctx.log.warn('the tab that was showing could not be selected again after a screenshot', { pane: pane.id, code: r.code });
  };

  const name = randomBytes(9).toString('base64url');
  const files: string[] = [];
  try {
    const dir = await shotsDir(ctx);
    const raw = join(dir, `${name}.png`);
    files.push(raw);
    if (disturbed) await ctx.clock.sleep(REDRAW_MS);
    const at = ctx.clock.iso();
    const grab = await ctx.exec(screencapture, ['-x', '-o', '-a', '-r', '-l', info.windowId, '-t', 'png', raw], { timeoutMs: CAPTURE_TIMEOUT_MS });
    // The user's tab goes back before the resize.
    await restore();
    if (grab.spawnError) return fail('unsupported', 'screencapture could not be started');
    if (grab.timedOut) return fail('timeout', 'screencapture did not finish in time');
    if (grab.code !== 0 || (await fileSize(raw)) === 0) return fail('permission', screenRecordingReason(ctx));

    const runSips = async (args: string[]): Promise<Failure | null> => {
      const r = await ctx.exec(sips, args, { timeoutMs: SIPS_TIMEOUT_MS });
      if (r.spawnError) return fail('unsupported', 'sips could not be started');
      if (r.timedOut) return fail('timeout', 'sips did not finish in time');
      if (r.code !== 0) return fail('failed', 'sips could not convert the screenshot');
      return null;
    };
    let src = raw;
    if (!opts.full) {
      const small = join(dir, `${name}-s.png`);
      files.push(small);
      const bad = await runSips(['-Z', String(maxEdge), raw, '--out', small]);
      if (bad) return bad;
      src = small;
    }
    if (opts.format === 'jpeg' || (await fileSize(src)) > PNG_SOFT_MAX) {
      const jpeg = join(dir, `${name}-q.jpg`);
      files.push(jpeg);
      const bad = await runSips(['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY), src, '--out', jpeg]);
      if (bad) return bad;
      src = jpeg;
    }
    const size = await fileSize(src);
    if (size === 0) return fail('failed', 'sips wrote no image');
    if (size > cap) return fail('failed', `the screenshot is larger than ${mb(cap)}; ask for a smaller one`);
    const bytes = await readFile(src);
    const image = imageInfo(bytes);
    if (!image) return fail('failed', 'the screenshot is not a PNG or JPEG image');
    return { ok: true, bytes, mime: image.mime, width: image.width, height: image.height, at, windowId: info.windowId, disturbed };
  } catch (e) {
    ctx.log.warn('screenshot failed', { pane: pane.id, error: e instanceof Error ? e.name : 'unknown' });
    return fail('failed', 'the screenshot could not be written or read');
  } finally {
    await restore();
    await Promise.all(files.map((f) => rm(f, { force: true }).catch(() => undefined)));
  }
}
