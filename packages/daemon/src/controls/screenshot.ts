/**
 * Terminal screenshots for the API (controls addendum; research controls.md
 * 1.3). The capture itself is the backend's (terminal-app/shot.ts); this
 * part decides whether one is taken at all:
 *
 * - screenshots.enabled, else screenshots_off. `select` (briefly selecting a
 *   background tab) only with screenshots.allowSelect and the control scope,
 *   and the backend still refuses it while Terminal is in use with that
 *   window in front;
 * - per pane: an image younger than 2.5 s is served again; up to 10 s old,
 *   it is served again while the tab's text is unchanged (one text read
 *   instead of a capture); concurrent asks share one capture (single
 *   flight); at most one new capture per 2 s. Only a run of screencapture
 *   counts: a refusal before it (another tab showing, a minimized window, a
 *   closed tab) costs nothing, so "switch tabs and capture" can follow a 409
 *   at once. Kept images are dropped 10 s after they were taken;
 * - daemon-wide: one screencapture at a time;
 * - the pane's writer lock is held, so a capture never lands between a
 *   send's typing and its Enter.
 * Per-device limits (10 a minute, select 2 a minute) are the API's.
 *
 * A capture's temp files are unlinked when it ends; ones a crash or a
 * SIGKILL left behind (full-size images of a Terminal window, which may
 * show secrets) are removed when the service starts (sweepShots).
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pane } from '@jantar/protocol';
import type { Actor, ControlResult, DaemonContext, ScreenshotOptions, ScreenshotResult, TerminalErrorCode, TimerId } from '../contracts.js';
import { hasScope } from '../auth/scopes.js';
import { sha256Hex } from '../core/hash.js';
import { KeyedQueue } from '../writer/queue.js';
import { SCREENSHOTS_OFF, locate, refuse, withLock, type ControlsDeps } from './common.js';

export const SHOT_FRESH_MS = 2_500;
export const SHOT_SAME_TEXT_MS = 10_000;
export const SHOT_PANE_SPACING_MS = 2_000;
/** Screen lines hashed for the same-text check. */
const TEXT_LINES = 200;

/** Backend refusals that come before screencapture runs. */
const NOT_CAPTURED: ReadonlySet<TerminalErrorCode> = new Set(['not_visible', 'not_found', 'unsupported']);

export const SELECT_OFF = 'Selecting a background tab for a screenshot is off. Turn it on at your Mac: jantar screenshots allow-select';

interface Cached {
  key: string;
  shot: ScreenshotResult;
  at: number;
  textHash: string | null;
}

/** Images that differ in size or format are different images. */
export function shotKey(opts: ScreenshotOptions, defaultEdge: number): string {
  return `${opts.full ? 'full' : String(opts.maxEdge ?? defaultEdge)}|${opts.format ?? 'png'}`;
}

export class Screenshots {
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<ControlResult<ScreenshotResult>>>();
  private readonly lastCapture = new Map<string, number>();
  private readonly captures = new KeyedQueue();
  private sweepTimer: TimerId | undefined;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: ControlsDeps,
  ) {}

  async take(sid: string, opts: ScreenshotOptions, actor: Actor): Promise<ControlResult<ScreenshotResult>> {
    const settings = this.ctx.settings.get().screenshots;
    if (!settings.enabled) return refuse('screenshots_off', SCREENSHOTS_OFF);
    if (opts.select) {
      if (!settings.allowSelect) return refuse('forbidden', SELECT_OFF);
      // An allow-list: the CLI or a device with control (never the system or the extension).
      if (!(actor.kind === 'cli' || (actor.kind === 'device' && hasScope(actor.scopes, 'control')))) {
        return refuse('forbidden', 'selecting a background tab needs the control scope');
      }
    }
    if (!this.deps.terminal.getScreenshot) return refuse('unsupported', 'this terminal cannot take screenshots');
    const found = await locate(this.ctx, this.deps, sid);
    if (!found.ok) return found;
    const { pane } = found;
    this.sweep();

    const key = shotKey(opts, settings.maxEdge);
    const place = `${sid}|${pane.tty}`;
    const hit = this.cache.get(place);
    if (hit && hit.key === key && this.ctx.clock.now() - hit.at < SHOT_FRESH_MS) return { ok: true, ...hit.shot, cached: true };

    const flight = `${place}|${key}|${opts.select ? 'select' : 'never'}`;
    const running = this.inflight.get(flight);
    if (running) return running;
    const p = this.capture(place, pane, key, opts).finally(() => this.inflight.delete(flight));
    this.inflight.set(flight, p);
    return p;
  }

  /** Drop every kept image (the daemon is stopping). */
  clear(): void {
    this.ctx.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
    this.cache.clear();
    this.lastCapture.clear();
  }

  private capture(place: string, pane: Pane, key: string, opts: ScreenshotOptions): Promise<ControlResult<ScreenshotResult>> {
    return withLock(this.ctx, this.deps, pane, async () => {
      const getScreenshot = this.deps.terminal.getScreenshot?.bind(this.deps.terminal);
      if (!getScreenshot) return refuse('unsupported', 'this terminal cannot take screenshots');
      const screen = await this.deps.terminal.readScreen(pane, { lines: TEXT_LINES });
      const textHash = screen.ok ? sha256Hex(screen.text) : null;
      const now = this.ctx.clock.now();
      const hit = this.cache.get(place);
      if (hit && hit.key === key && textHash !== null && hit.textHash === textHash && now - hit.at < SHOT_SAME_TEXT_MS) {
        return { ok: true, ...hit.shot, cached: true };
      }
      const last = this.lastCapture.get(place);
      if (last !== undefined && now - last < SHOT_PANE_SPACING_MS) {
        return refuse('rate_limited', 'this session was captured less than 2 seconds ago');
      }
      const r = await this.captures.run('screencapture', () =>
        getScreenshot(pane, {
          ...(opts.maxEdge !== undefined ? { maxEdge: opts.maxEdge } : {}),
          ...(opts.format ? { format: opts.format } : {}),
          select: opts.select ? 'if-safe' : 'never',
          full: opts.full === true,
        }),
      );
      if (r.ok || !NOT_CAPTURED.has(r.code)) this.lastCapture.set(place, now);
      if (!r.ok) return r;
      const { ok: _ok, ...taken } = r;
      const shot: ScreenshotResult = { ...taken, etag: sha256Hex(taken.bytes), cached: false };
      this.cache.set(place, { key, shot, at: this.ctx.clock.now(), textHash });
      this.sweepLater();
      return { ok: true, ...shot };
    });
  }

  /** Sweep once the newest kept image is too old to serve, so none stays in memory unasked. */
  private sweepLater(): void {
    this.ctx.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = this.ctx.clock.setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep();
    }, SHOT_SAME_TEXT_MS);
  }

  /** Images older than the same-text window are never served again. */
  private sweep(): void {
    const now = this.ctx.clock.now();
    for (const [place, c] of this.cache) if (now - c.at >= SHOT_SAME_TEXT_MS) this.cache.delete(place);
    for (const [place, at] of this.lastCapture) if (now - at >= SHOT_PANE_SPACING_MS) this.lastCapture.delete(place);
  }
}

/**
 * Remove the plain files directly in ctx.paths.shotsDir: captures a daemon
 * that died mid-capture left there. Links and dirs are left alone (the dir
 * is the daemon's own, 0700); a missing dir is fine.
 */
export async function sweepShots(ctx: DaemonContext): Promise<number> {
  const dir = ctx.paths.shotsDir;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!(await lstat(path)).isFile()) continue;
      await unlink(path);
      removed += 1;
    } catch (e) {
      ctx.log.warn('could not remove a leftover screenshot', { error: String(e) });
    }
  }
  if (removed > 0) ctx.log.info('removed leftover screenshots', { count: removed });
  return removed;
}
