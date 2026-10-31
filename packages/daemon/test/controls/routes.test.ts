/**
 * The controls routes over the real API pipeline: scopes and Origin (G1),
 * ctl.sock refusal, error codes, per-device limits, the screenshot's bytes
 * and headers (G6), select rules, audit rows without screen or prompt text
 * (A1, G7) and confirm for /clear and /rewind (C5).
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCREENSHOT_AT_HEADER,
  SCREENSHOT_DISTURBED_HEADER,
  SCREENSHOT_SIZE_HEADER,
  SettingsSchema,
  type ControlKey,
  type PermissionModeName,
  type Settings,
  type SlashCommand,
} from '@jantar/protocol';
import type { Actor, ControlResult, ControlsService, DialogAnswer, ScreenshotOptions, ScreenshotResult } from '../../src/contracts.js';
import { CLEAR_UNVERIFIED } from '../../src/controls/keys.js';
import { buildControlsService } from '../../src/controls/service.js';
import { V03_LIMITS } from '../../src/api/services.js';
import { bare, h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { SCREEN_SECRET, ScriptedTerminal, claudeScreen, dialogScreen, drive, pngShot } from './helpers.js';

const SID = 'sess-aaaa-1111';
const ON: Settings = SettingsSchema.parse({ screenshots: { enabled: true } });
const SELECT: Settings = SettingsSchema.parse({ screenshots: { enabled: true, allowSelect: true } });

class FakeControls implements ControlsService {
  keys: [string, ControlKey, Actor][] = [];
  modes: [string, PermissionModeName][] = [];
  commands: [string, SlashCommand][] = [];
  shots: [string, ScreenshotOptions, Actor][] = [];
  keyResult: ControlResult = { ok: true };
  modeResult: ControlResult<{ mode: PermissionModeName; steps: number }> = { ok: true, mode: 'plan', steps: 2 };
  commandResult: ControlResult<{ proven: boolean }> = { ok: true, proven: true };
  shotResult: ControlResult<ScreenshotResult> = { ok: true, ...pngShot(), etag: 'e'.repeat(64), cached: false };
  async start() {}
  async stop() {}
  async key(sid: string, key: ControlKey, actor: Actor) {
    this.keys.push([sid, key, actor]);
    return this.keyResult;
  }
  async setMode(sid: string, mode: PermissionModeName) {
    this.modes.push([sid, mode]);
    return this.modeResult;
  }
  async command(sid: string, cmd: SlashCommand) {
    this.commands.push([sid, cmd]);
    return this.commandResult;
  }
  async screenshot(sid: string, opts: ScreenshotOptions, actor: Actor) {
    this.shots.push([sid, opts, actor]);
    return this.shotResult;
  }
  // v0.4.2: not used here (test/api/v042-routes.test.ts drives these routes).
  async answerDialog(): Promise<ControlResult<DialogAnswer>> {
    return { ok: false, code: 'unsupported', reason: 'not used here' };
  }
  async keypad(): Promise<ControlResult> {
    return { ok: false, code: 'unsupported', reason: 'not used here' };
  }
}

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

async function withFake(settings: Settings = ON) {
  const controls = new FakeControls();
  api = await makeApi({ ctx: { settings }, deps: () => ({ controls }) });
  return controls;
}

const post = (url: string, headers: Record<string, string>, payload: unknown) => api.tcp.inject({ method: 'POST', url, headers, payload: payload as object });
const get = (url: string, headers: Record<string, string>) => api.tcp.inject({ method: 'GET', url, headers });

const KEYS = `/v1/sessions/${SID}/keys`;
const MODE = `/v1/sessions/${SID}/mode`;
const CMD = `/v1/sessions/${SID}/command`;
const SHOT = `/v1/sessions/${SID}/screenshot`;

describe('controls routes: who may call them', () => {
  it('G1: an unpaired browser gets 401, a read-scope device 403 on the writes, a bad Origin 403; screenshots need only read', async () => {
    const controls = await withFake();
    const reader = await pairCookie(api, ['read']);
    const phone = await pairCookie(api);
    for (const [url, body] of [
      [KEYS, { key: 'interrupt' }],
      [MODE, { mode: 'plan' }],
      [CMD, { name: 'compact' }],
    ] as const) {
      expect((await post(url, h(), body)).statusCode, url).toBe(401);
      expect((await post(url, h(reader.cookie), body)).statusCode, url).toBe(403);
      expect((await post(url, { ...h(phone.cookie), origin: 'https://evil.example' }, body)).statusCode, url).toBe(403);
      // The cookie without the device secret is not enough for a control write.
      expect((await post(url, bare(phone.cookie), body)).statusCode, url).toBe(401);
    }
    expect((await get(SHOT, h())).statusCode).toBe(401);
    expect((await get(SHOT, h(reader.cookie))).statusCode).toBe(200);
    expect(controls.keys).toEqual([]);
    expect(controls.modes).toEqual([]);
    expect(controls.commands).toEqual([]);
  });

  it('none of them is served on ctl.sock (a session must not press keys into itself)', async () => {
    const controls = await withFake();
    for (const [method, url, payload] of [
      ['POST', KEYS, { key: 'interrupt' }],
      ['POST', MODE, { mode: 'plan' }],
      ['POST', CMD, { name: 'plan' }],
      ['GET', SHOT, undefined],
    ] as const) {
      const res = await api.ctl.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(404);
    }
    expect(controls.keys).toEqual([]);
    expect(controls.shots).toEqual([]);
  });

  it('a session the daemon does not know is a 404 before any control runs', async () => {
    const controls = await withFake();
    const { cookie } = await pairCookie(api);
    expect((await post('/v1/sessions/nope/keys', h(cookie), { key: 'interrupt' })).statusCode).toBe(404);
    expect((await get('/v1/sessions/nope/screenshot', h(cookie))).statusCode).toBe(404);
    expect(controls.keys).toEqual([]);
    expect(controls.shots).toEqual([]);
  });
});

describe('sessionKey, sessionMode, sessionCommand', () => {
  it('press a key and audit { sid, key, sent }: sent is the key typed (interrupt follows interruptKey)', async () => {
    const controls = await withFake();
    const { cookie, deviceId } = await pairCookie(api);
    const res = await post(KEYS, h(cookie), { key: 'interrupt' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(controls.keys).toEqual([[SID, 'interrupt', expect.objectContaining({ kind: 'device', deviceId })]]);
    await api.ctx.settings.patch({ controls: { interruptKey: 'escape' } });
    expect((await post(KEYS, h(cookie), { key: 'interrupt' })).statusCode).toBe(200);
    const rows = api.ctx.db.audit.list().filter((a) => a.action === 'sessionKey');
    expect(rows.map((r) => r.params)).toEqual([
      { sid: SID, key: 'interrupt', sent: 'interrupt' },
      { sid: SID, key: 'interrupt', sent: 'escape' },
    ]);
    expect(rows[0]).toMatchObject({ actor: `device:${deviceId}`, target: SID, result: 'ok' });
    // Only ControlKey names pass validation.
    expect((await post(KEYS, h(cookie), { key: 'tab' })).statusCode).toBe(400);
    expect((await post(KEYS, h(cookie), { key: 'enter', bytes: '\u001b' })).statusCode).toBe(400);
    expect(controls.keys).toHaveLength(2);
  });

  it('turn each refusal into its error code and status', async () => {
    const controls = await withFake();
    const { cookie } = await pairCookie(api);
    const cases: [ControlResult, number, string][] = [
      [{ ok: false, code: 'dialog_open', reason: 'a dialog is open' }, 409, 'dialog_open'],
      [{ ok: false, code: 'input_not_empty', reason: 'draft' }, 409, 'input_not_empty'],
      [{ ok: false, code: 'escape_unverified', reason: 'not yet' }, 409, 'escape_unverified'],
      [{ ok: false, code: 'not_visible', reason: 'another tab' }, 409, 'tab_not_visible'],
      [{ ok: false, code: 'refused', reason: 'a card is open' }, 422, 'refused'],
      [{ ok: false, code: 'forbidden', reason: 'Controls are off' }, 403, 'forbidden'],
      [{ ok: false, code: 'not_found', reason: 'no tab' }, 404, 'not_found'],
      [{ ok: false, code: 'unsupported', reason: 'read-only' }, 501, 'not_implemented'],
      [{ ok: false, code: 'unreadable', reason: 'no screen' }, 503, 'unavailable'],
    ];
    for (const [result, status, code] of cases) {
      controls.keyResult = result;
      const res = await post(KEYS, h(cookie), { key: 'shiftTab' });
      expect(res.statusCode, code).toBe(status);
      expect(res.json().error, code).toEqual({ code, message: (result as { reason: string }).reason });
    }
    controls.keyResult = { ok: false, code: 'rate_limited', reason: 'Ctrl+C went to this session less than 3 seconds ago' };
    const spaced = await post(KEYS, h(cookie), { key: 'interrupt' });
    expect(spaced.statusCode).toBe(429);
    expect(spaced.headers['retry-after']).toBe('3');
    const refused = api.ctx.db.audit.list().filter((a) => a.action === 'sessionKey' && a.result === 'refused');
    expect(refused.length).toBeGreaterThan(0);
  });

  it('switch the mode and audit { sid, mode, steps }; mode_unavailable is a 409', async () => {
    const controls = await withFake();
    const { cookie } = await pairCookie(api);
    const res = await post(MODE, h(cookie), { mode: 'plan' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: 'plan', steps: 2 });
    expect(api.ctx.db.audit.list().find((a) => a.action === 'sessionMode')?.params).toEqual({ sid: SID, mode: 'plan', steps: 2 });
    controls.modeResult = { ok: false, code: 'mode_unavailable', reason: "bypass permissions is not in this session's cycle" };
    const no = await post(MODE, h(cookie), { mode: 'bypassPermissions', confirm: true });
    expect(no.statusCode).toBe(409);
    expect(no.json().error.code).toBe('mode_unavailable');
    expect((await post(MODE, h(cookie), { mode: 'dontAsk' })).statusCode).toBe(400);
  });

  it('a switch to a mode that never asks (bypass, auto) needs confirm: true (400 without, and nothing runs)', async () => {
    const controls = await withFake();
    const { cookie } = await pairCookie(api);
    for (const mode of ['bypassPermissions', 'auto']) {
      for (const body of [{ mode }, { mode, confirm: false }]) {
        const res = await post(MODE, h(cookie), body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
    }
    expect(controls.modes).toEqual([]);
    expect((await post(MODE, h(cookie), { mode: 'auto', confirm: true })).statusCode).toBe(200);
    expect(controls.modes).toEqual([[SID, 'auto']]);
  });

  it('C5: /clear and /rewind need confirm: true (400 without, and nothing runs)', async () => {
    const controls = await withFake();
    const { cookie } = await pairCookie(api);
    for (const name of ['clear', 'rewind']) {
      expect((await post(CMD, h(cookie), { name })).statusCode, name).toBe(400);
      expect((await post(CMD, h(cookie), { name, confirm: false })).statusCode, name).toBe(400);
    }
    expect(controls.commands).toEqual([]);
    const ok = await post(CMD, h(cookie), { name: 'clear', confirm: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ proven: true });
    // The service gets the command alone, never the confirm flag.
    expect(controls.commands).toEqual([[SID, { name: 'clear' }]]);
  });

  it('send commands; the audit keeps the model and effort word but never /plan or /compact text', async () => {
    const controls = await withFake();
    const { cookie } = await pairCookie(api);
    expect((await post(CMD, h(cookie), { name: 'model', args: 'opus' })).statusCode).toBe(200);
    expect((await post(CMD, h(cookie), { name: 'compact', args: `keep ${SCREEN_SECRET}` })).statusCode).toBe(200);
    controls.commandResult = { ok: true, proven: false };
    expect((await post(CMD, h(cookie), { name: 'plan' })).json()).toEqual({ proven: false });
    expect((await post(CMD, h(cookie), { name: 'model', args: 'gpt-9' })).statusCode).toBe(400);
    const rows = api.ctx.db.audit.list().filter((a) => a.action === 'sessionCommand' && a.result === 'ok');
    expect(rows.map((r) => r.params)).toEqual([
      { sid: SID, name: 'model', args: 'opus', proven: true },
      { sid: SID, name: 'compact', argsLength: `keep ${SCREEN_SECRET}`.length, proven: true },
      { sid: SID, name: 'plan', proven: false },
    ]);
    expect(JSON.stringify(api.ctx.db.audit.list())).not.toContain(SCREEN_SECRET);
  });

  it('share one per-device limit of 30 a minute across keys, modes and commands', async () => {
    await withFake();
    const { cookie } = await pairCookie(api);
    const other = await pairCookie(api, ['read', 'control'], 'Other phone');
    for (let i = 0; i < V03_LIMITS.keys.limit - 2; i++) expect((await post(KEYS, h(cookie), { key: 'clearInput' })).statusCode).toBe(200);
    expect((await post(MODE, h(cookie), { mode: 'plan' })).statusCode).toBe(200);
    expect((await post(CMD, h(cookie), { name: 'plan' })).statusCode).toBe(200);
    const res = await post(KEYS, h(cookie), { key: 'clearInput' });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // Per device: another phone still gets through.
    expect((await post(KEYS, h(other.cookie), { key: 'clearInput' })).statusCode).toBe(200);
  });
});

describe('sessionScreenshot', () => {
  it('G6: answers the image bytes with no-store, its etag and the capture headers', async () => {
    const controls = await withFake();
    const { cookie } = await pairCookie(api, ['read']);
    const shot = pngShot({ disturbed: false });
    const etag = createHash('sha256').update(shot.bytes).digest('hex');
    controls.shotResult = { ok: true, ...shot, etag, cached: false };
    const res = await get(`${SHOT}?max=1200&format=png`, h(cookie));
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(shot.bytes)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBe(`"${etag}"`);
    expect(res.headers[SCREENSHOT_AT_HEADER]).toBe(shot.at);
    expect(res.headers[SCREENSHOT_SIZE_HEADER]).toBe('1600x1000');
    expect(res.headers[SCREENSHOT_DISTURBED_HEADER]).toBe('0');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(controls.shots[0]?.[1]).toEqual({ maxEdge: 1200, format: 'png', select: false, full: false });
    // A plain screenshot is a read: no audit row.
    expect(api.ctx.db.audit.list().filter((a) => a.action === 'sessionScreenshot')).toEqual([]);
  });

  it('select=1 needs the control scope and screenshots.allowSelect, and is audited with disturbed', async () => {
    const off = await withFake(ON);
    const phone = await pairCookie(api);
    const off403 = await get(`${SHOT}?select=1`, h(phone.cookie));
    expect(off403.statusCode).toBe(403);
    expect(off403.json().error.message).toMatch(/allow-select/);
    expect(off.shots).toEqual([]);
    await api.close();

    const controls = await withFake(SELECT);
    const reader = await pairCookie(api, ['read']);
    const ctl = await pairCookie(api);
    const denied = await get(`${SHOT}?select=1`, h(reader.cookie));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toMatch(/control scope/);
    // SEC-2: it switches the Mac's tab, so a cookie replayed without its device secret cannot (a plain picture is a read).
    const replayed = await get(`${SHOT}?select=1`, bare(ctl.cookie));
    expect(replayed.statusCode).toBe(401);
    expect(controls.shots).toEqual([]);
    controls.shotResult = { ok: true, ...pngShot({ disturbed: true }), etag: 'a'.repeat(64), cached: false };
    expect((await get(SHOT, bare(ctl.cookie))).statusCode).toBe(200);
    controls.shots.length = 0;
    const res = await get(`${SHOT}?select=1`, h(ctl.cookie));
    expect(res.statusCode).toBe(200);
    expect(res.headers[SCREENSHOT_DISTURBED_HEADER]).toBe('1');
    expect(controls.shots.map((s) => s[1].select)).toEqual([true]);
    const rows = api.ctx.db.audit.list().filter((a) => a.action === 'sessionScreenshot');
    expect(rows).toEqual([expect.objectContaining({ actor: `device:${ctl.deviceId}`, target: SID, result: 'ok', params: expect.objectContaining({ select: true, disturbed: true }) })]);
  });

  it('screenshots off: 403 screenshots_off before anything runs; a hidden tab: 409 tab_not_visible as JSON', async () => {
    const off = await withFake(SettingsSchema.parse({}));
    const { cookie } = await pairCookie(api);
    const res = await get(SHOT, h(cookie));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('screenshots_off');
    expect(off.shots).toEqual([]);
    await api.close();

    const controls = await withFake();
    const phone = await pairCookie(api);
    controls.shotResult = { ok: false, code: 'not_visible', reason: 'another tab is showing in that window' };
    const hidden = await get(SHOT, h(phone.cookie));
    expect(hidden.statusCode).toBe(409);
    expect(hidden.headers['content-type']).toMatch(/application\/json/);
    expect(hidden.json().error).toEqual({ code: 'tab_not_visible', message: 'another tab is showing in that window' });
    expect(hidden.headers['cache-control']).toBe('no-store');
  });

  it('limits a device to 10 a minute, and select=1 to 2 a minute', async () => {
    await withFake(SELECT);
    const { cookie } = await pairCookie(api);
    for (let i = 0; i < V03_LIMITS.screenshotSelect.limit; i++) expect((await get(`${SHOT}?select=1`, h(cookie))).statusCode).toBe(200);
    expect((await get(`${SHOT}?select=1`, h(cookie))).statusCode).toBe(429);
    // That refused select=1 passed the 10-a-minute limit first, so it counts there.
    for (let i = V03_LIMITS.screenshotSelect.limit + 1; i < V03_LIMITS.screenshot.limit; i++) expect((await get(SHOT, h(cookie))).statusCode).toBe(200);
    const res = await get(SHOT, h(cookie));
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('a select=1 request the 10-a-minute limit refuses costs no select try (that limit is checked first)', async () => {
    const controls = await withFake(SELECT);
    const { cookie } = await pairCookie(api);
    for (let i = 0; i < V03_LIMITS.screenshot.limit; i++) expect((await get(SHOT, h(cookie))).statusCode).toBe(200);
    api.ctx.clock.advance(30_000);
    for (let i = 0; i < V03_LIMITS.screenshotSelect.limit; i++) {
      const res = await get(`${SHOT}?select=1`, h(cookie));
      expect(res.statusCode).toBe(429);
      expect(res.json().error.message).toBe('too many screenshots; wait a moment');
    }
    // The plain ones have left the window; the refused select=1 requests left nothing in theirs.
    api.ctx.clock.advance(V03_LIMITS.screenshot.windowMs - 30_000 + 1);
    for (let i = 0; i < V03_LIMITS.screenshotSelect.limit; i++) expect((await get(`${SHOT}?select=1`, h(cookie))).statusCode).toBe(200);
    expect(controls.shots.filter((x) => x[1].select)).toHaveLength(V03_LIMITS.screenshotSelect.limit);
  });
});

describe('with the real controls service', () => {
  async function real(settings: Settings = ON) {
    let terminal!: ScriptedTerminal;
    api = await makeApi({
      ctx: { settings },
      deps: (ctx, f) => {
        terminal = new ScriptedTerminal();
        return {
          terminal,
          controls: buildControlsService(ctx, { sessions: f.sessions, terminal, writer: f.writer, hooks: f.hooks, transcripts: f.transcripts, ccwLegacy: f.ccwLegacy }),
        };
      },
    });
    return terminal;
  }

  it('A1, G7: refusals, audit rows, events and replies never carry screen text', async () => {
    const terminal = await real();
    const { cookie } = await pairCookie(api);
    terminal.screen = dialogScreen();
    const replies: string[] = [];
    for (const key of ['shiftTab', 'interrupt', 'clearInput'] as const) {
      const res = await drive(api.ctx.clock, post(KEYS, h(cookie), { key }));
      expect(res.statusCode, key).toBe(409);
      replies.push(res.body);
    }
    replies.push((await drive(api.ctx.clock, post(MODE, h(cookie), { mode: 'plan' }))).body);
    replies.push((await drive(api.ctx.clock, post(CMD, h(cookie), { name: 'clear', confirm: true }))).body);
    terminal.screen = claudeScreen({ draft: SCREEN_SECRET });
    replies.push((await drive(api.ctx.clock, post(KEYS, h(cookie), { key: 'shiftTab' }))).body);
    replies.push((await drive(api.ctx.clock, get(SHOT, h(cookie)))).body);
    expect(terminal.pressed).toEqual([]);
    const everything = JSON.stringify({ replies, audit: api.ctx.db.audit.list(), events: api.ctx.store.replay(0), log: api.ctx.log.records });
    expect(everything).not.toContain(SCREEN_SECRET);
    expect(everything).not.toContain('echo');
  });

  it('presses a key end to end (Clear draft with the rows its box shows)', async () => {
    const terminal = await real();
    const { cookie } = await pairCookie(api);
    terminal.screen = claudeScreen({ draft: 'a draft', more: ['on three', 'rows'] });
    const res = await drive(api.ctx.clock, post(KEYS, h(cookie), { key: 'clearInput' }));
    expect(res.statusCode).toBe(200);
    expect(terminal.pressed).toEqual(['clearInput']);
    expect(terminal.keyOpts).toEqual([{ rows: 3 }]);
  });

  it('Clear draft is refused (422, nothing typed) while a config turns controls.clearVerified off', async () => {
    const terminal = await real(SettingsSchema.parse({ screenshots: { enabled: true }, controls: { clearVerified: false } }));
    const { cookie } = await pairCookie(api);
    const res = await drive(api.ctx.clock, post(KEYS, h(cookie), { key: 'clearInput' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'refused', message: CLEAR_UNVERIFIED });
    expect(terminal.pressed).toEqual([]);
  });
});
