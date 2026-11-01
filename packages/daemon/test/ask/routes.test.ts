/**
 * Ask's seven routes over the real pipeline (spec 8, 9.1; 12.2 "routes"),
 * Fastify inject, the Ask part on a fake exec:
 *
 * - The gate: control scope (reads too: a read-only device gets 403),
 *   writes need an allowed Origin and the device secret; never on ctl.sock.
 * - The switch off: 403 with "Ask is off. Turn it on at your Mac: jantar
 *   ask on", before any handler.
 * - --read-only: askSend alone is refused (403); Clear, Cancel and the
 *   taps still work.
 * - askSend is 202 `{ id }`; an Idempotency-Key replay is the same turn
 *   and no second run; 10 a minute and 100 a day per device (429 with
 *   their sentences); every Ask write counts against the Life write limit.
 * - A full turn: send, list, Add, Skip, Undo, Clear, with the replies and
 *   audit rows (the turn's id only) and the errors' codes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskListSchema, ErrorBodySchema, IdReplySchema, ROUTES, buildPath, type RouteDef, type RouteName } from '@jantar/protocol';
import { ASK_WRITES_LIMITED, FEATURE_OFF, needsDeviceSecret } from '../../src/api/app.js';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { ASK_SEND_DAY_LIMITED, ASK_SEND_LIMITED } from '../../src/api/routes/ask.js';
import { ASK_LIMITS, V04_LIMITS } from '../../src/api/services.js';
import { ASK_SENTENCES } from '../../src/ask/answer.js';
import { READ_ONLY_REASON } from '../../src/modes.js';
import { TEST_BINS, createFakeExec, type ExecCall } from '../../src/core/testing.js';
import { bare, h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { FakeClock } from '../../src/core/clock.js';
import { NOW, TODAY, WAIT, answerText, askOn, askSettings, claudeJson, type AskParts } from './helpers.js';

const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const ASK = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([, d]) => d.feature === 'ask');

let api: TestApi | undefined;
let parts: AskParts | undefined;
const temps: string[] = [];
afterEach(async () => {
  await parts?.ask.stop();
  parts?.core.close();
  parts = undefined;
  await api?.close();
  api = undefined;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Opts {
  settings?: Record<string, unknown>;
  readOnly?: boolean;
  /** What each claude run answers (default: one todo). */
  answer?: (call: ExecCall) => string;
}

/** The API with the Ask part on a fake exec whose claude answers at once; a paired control device. */
async function askApi(opts: Opts = {}) {
  const runs: ExecCall[] = [];
  const answer = opts.answer ?? (() => answerText([{ type: 'todo', title: 'Call the bank' }, { type: 'food', name: 'Roti', kcal: 240 }, { type: 'show', what: 'calories' }]));
  const exec = createFakeExec((call) => {
    if (call.file !== TEST_BINS.claude) return undefined;
    runs.push(call);
    return { stdout: claudeJson(answer(call)) };
  });
  const state = mkdtempSync(join(tmpdir(), 'jantar-ask-api-'));
  temps.push(state);
  api = await makeApi({
    ctx: { settings: askSettings(opts.settings), home: state, exec, accountsMode: 'single', clock: new FakeClock(NOW) },
    ...(opts.readOnly ? { api: { mode: { readOnly: true, terminal: 'terminal-app' } } } : {}),
    deps: (ctx) => {
      parts = askOn(ctx, { readOnly: opts.readOnly === true });
      void parts.ask.start();
      return { life: parts.life, ask: parts.ask };
    },
  });
  const { cookie } = await pairCookie(api, ['read', 'control']);
  const t = api;
  const call = (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}, who = cookie) =>
    t.tcp.inject({ method: method as 'GET', url, headers: h(who, extra), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const list = async (who = cookie) => AskListSchema.parse((await call('GET', '/v1/ask', undefined, {}, who)).json());
  const settled = async (id: string, who = cookie) => {
    await vi.waitFor(async () => {
      const turn = (await list(who)).turns.find((x) => x.id === id);
      if (!turn || turn.state === 'queued' || turn.state === 'running') throw new Error('not yet');
    }, WAIT);
    return (await list(who)).turns.find((x) => x.id === id);
  };
  return { api: t, cookie, call, list, settled, runs };
}

/** A request that gets through validation for each Ask route. */
function sample(name: RouteName): { url: string; payload?: unknown } {
  const def = ROUTES[name] as RouteDef;
  const url = buildPath(def, { id: ID, n: '0' });
  if (name === 'askSend') return { url, payload: { text: 'todo add milk' } };
  if (name === 'askAdd') return { url, payload: {} };
  return { url };
}

describe('the gate', () => {
  it('seven routes: a read-only device gets 403 on each, before any handler; writes need Origin and the secret', async () => {
    expect(ASK.map(([n]) => n).sort()).toEqual(['askAdd', 'askCancel', 'askClear', 'askList', 'askSend', 'askSkip', 'askUndo']);
    const { api, cookie } = await askApi();
    const reader = await pairCookie(api, ['read']);
    const spies = ASK.map(([name]) => vi.spyOn(ROUTE_IMPLS[name] as { handle: () => unknown }, 'handle'));
    for (const [name, def] of ASK) {
      const { url, payload } = sample(name);
      const read = await api.tcp.inject({ method: def.method as 'GET', url, headers: h(reader.cookie), ...(payload ? { payload: payload as object } : {}) });
      expect(read.statusCode, name).toBe(403);
      expect(read.json().error.message).toBe('this device does not have the control scope');
      if (def.method === 'GET') continue;
      expect(needsDeviceSecret(def), name).toBe(true);
      const noSecret = await api.tcp.inject({ method: def.method as 'POST', url, headers: bare(cookie), ...(payload ? { payload: payload as object } : {}) });
      expect(noSecret.statusCode, name).toBe(401);
      const evil = await api.tcp.inject({ method: def.method as 'POST', url, headers: h(cookie, { origin: 'https://evil.example' }), ...(payload ? { payload: payload as object } : {}) });
      expect(evil.statusCode, name).toBe(403);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });

  it('never on ctl.sock', async () => {
    const { api } = await askApi();
    for (const [name, def] of ASK) {
      const { url, payload } = sample(name);
      const res = await api.ctl.inject({ method: def.method as 'GET', url, ...(payload ? { payload: payload as object } : {}) });
      expect(res.statusCode, name).toBe(404);
    }
  });

  it('the switch off: 403 with the sentence that turns it on, on every route', async () => {
    const { api, call } = await askApi({ settings: { ask: { enabled: false } } });
    expect(FEATURE_OFF.ask).toEqual({ code: 'forbidden', message: 'Ask is off. Turn it on at your Mac: jantar ask on' });
    for (const [name, def] of ASK) {
      const { url, payload } = sample(name);
      const res = await call(def.method, url, payload);
      expect(res.statusCode, name).toBe(403);
      expect(ErrorBodySchema.parse(res.json()).error).toEqual(FEATURE_OFF.ask);
    }
    expect(api.ctx.db.audit.list().filter((a) => a.action === 'askSend')).toHaveLength(1);
  });

  it('--read-only refuses askSend alone: the list says why, Clear and Cancel still answer', async () => {
    const { call, list, runs } = await askApi({ readOnly: true });
    const sent = await call('POST', '/v1/ask', { text: 'todo add milk' });
    expect(sent.statusCode).toBe(403);
    expect(sent.json().error.message).toBe(READ_ONLY_REASON);
    expect(await list()).toEqual({ ready: false, reason: ASK_SENTENCES.readOnly, turns: [] });
    expect((await call('DELETE', '/v1/ask')).statusCode).toBe(200);
    expect((await call('DELETE', `/v1/ask/turns/${ID}`)).statusCode).toBe(404);
    expect((await call('POST', `/v1/ask/turns/${ID}/actions/0`, {})).statusCode).toBe(404);
    expect(runs).toEqual([]);
  });
});

describe('a turn over the API', () => {
  it('202 { id }; the list has the cards; Add, Skip and Undo answer ids or ok; audit rows name the turn only', async () => {
    const { api, call, list, settled } = await askApi();
    const sent = await call('POST', '/v1/ask', { text: 'todo add call the bank' });
    expect(sent.statusCode).toBe(202);
    const { id } = IdReplySchema.parse(sent.json());
    expect(Object.keys(sent.json())).toEqual(['id']);
    const turn = await settled(id);
    expect(turn).toMatchObject({ state: 'done', text: 'todo add call the bank', cards: [{ state: 'proposed' }, { state: 'proposed' }, { state: 'proposed', action: { type: 'show', what: 'calories' } }] });

    const added = await call('POST', `/v1/ask/turns/${id}/actions/0`, {});
    expect(added.statusCode).toBe(200);
    const todoId = IdReplySchema.parse(added.json()).id;
    expect((await call('POST', `/v1/ask/turns/${id}/actions/0`, {})).json().error).toEqual({ code: 'conflict', message: ASK_SENTENCES.added });
    const edited = await call('POST', `/v1/ask/turns/${id}/actions/1`, { edit: { type: 'food', day: TODAY, name: 'Two rotis', kcal: 250 } });
    expect(edited.statusCode).toBe(200);
    expect((await call('POST', `/v1/ask/turns/${id}/actions/2`, {})).json().error).toEqual({ code: 'conflict', message: ASK_SENTENCES.notWrite });
    expect((await call('POST', `/v1/ask/turns/${id}/actions/2/skip`)).statusCode).toBe(409);
    expect((await call('DELETE', `/v1/ask/turns/${id}/actions/0`)).json()).toEqual({ ok: true });
    expect((await call('POST', `/v1/ask/turns/${id}/actions/0/skip`)).json()).toEqual({ ok: true });
    expect((await list()).turns[0]?.cards.map((c) => [c.state, c.ref ?? null])).toEqual([
      ['skipped', null],
      ['added', IdReplySchema.parse(edited.json()).id],
      ['proposed', null],
    ]);
    // Errors: a bad body, an edit of the wrong shape, a card past 9, an unknown turn.
    expect((await call('POST', `/v1/ask/turns/${id}/actions/1`, { edit: { type: 'food', name: 'x' } })).statusCode).toBe(400);
    expect((await call('POST', `/v1/ask/turns/${id}/actions/10`, {})).statusCode).toBe(400);
    expect((await call('POST', `/v1/ask/turns/${ID}/actions/0`, {})).json().error).toEqual({ code: 'not_found', message: ASK_SENTENCES.noTurn });
    expect((await call('POST', '/v1/ask', { text: '   ' })).statusCode).toBe(400);
    expect((await call('POST', '/v1/ask', { text: 'x'.repeat(1001) })).statusCode).toBe(400);

    const rows = api.ctx.db.audit.list().filter((a) => a.action.startsWith('ask'));
    expect(rows.find((a) => a.action === 'askSend')).toMatchObject({ target: id, result: 'ok', params: {} });
    const taps = rows.filter((a) => (a.action === 'askAdd' || a.action === 'askUndo' || a.action === 'askSkip') && a.result === 'ok');
    expect(taps.map((a) => [a.action, a.target])).toEqual([
      ['askAdd', id],
      ['askAdd', id],
      ['askUndo', id],
      ['askSkip', id],
    ]);
    expect(rows.some((a) => a.target === todoId)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('call the bank');

    expect((await call('DELETE', '/v1/ask')).json()).toEqual({ ok: true });
    expect((await list()).turns).toEqual([]);
  });

  it('a second device sees none of it', async () => {
    const { api, call, list, settled } = await askApi();
    const { id } = IdReplySchema.parse((await call('POST', '/v1/ask', { text: 'todo add milk' })).json());
    await settled(id);
    const other = await pairCookie(api, ['read', 'control'], 'Tablet');
    expect((await list(other.cookie)).turns).toEqual([]);
    expect((await call('DELETE', `/v1/ask/turns/${id}`, undefined, {}, other.cookie)).statusCode).toBe(404);
    expect((await call('POST', `/v1/ask/turns/${id}/actions/0`, {}, {}, other.cookie)).statusCode).toBe(404);
  });

  it('an Idempotency-Key replay is the same turn, and no second run', async () => {
    const { call, settled, runs } = await askApi();
    const a = await call('POST', '/v1/ask', { text: 'todo add milk' }, { 'idempotency-key': 'k-1' });
    const b = await call('POST', '/v1/ask', { text: 'todo add milk' }, { 'idempotency-key': 'k-1' });
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(b.json()).toEqual(a.json());
    expect(b.headers['idempotent-replayed']).toBe('true');
    await settled(IdReplySchema.parse(a.json()).id);
    expect(runs).toHaveLength(1);
  });
});

describe('limits', () => {
  it(`${ASK_LIMITS.send.limit} messages a minute per device, then 429 with retry-after; a minute later it runs again`, async () => {
    const { api, call, settled } = await askApi();
    for (let i = 0; i < ASK_LIMITS.send.limit; i++) {
      const r = await call('POST', '/v1/ask', { text: `todo add task ${i}` });
      expect(r.statusCode, `message ${i + 1}`).toBe(202);
      await settled(IdReplySchema.parse(r.json()).id);
    }
    const limited = await call('POST', '/v1/ask', { text: 'todo add one more' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'rate_limited', message: ASK_SEND_LIMITED });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    api.ctx.clock.advance(ASK_LIMITS.send.windowMs);
    expect((await call('POST', '/v1/ask', { text: 'todo add one more' })).statusCode).toBe(202);
  });

  it(`${ASK_LIMITS.sendDay.limit} a day per device: the next is 429 with its own sentence`, async () => {
    const { api, call, settled } = await askApi();
    for (let i = 0; i < ASK_LIMITS.sendDay.limit; i++) {
      if (i > 0 && i % ASK_LIMITS.send.limit === 0) api.ctx.clock.advance(ASK_LIMITS.send.windowMs);
      const r = await call('POST', '/v1/ask', { text: `todo add task ${i}` });
      expect(r.statusCode, `message ${i + 1}`).toBe(202);
      await settled(IdReplySchema.parse(r.json()).id);
    }
    api.ctx.clock.advance(ASK_LIMITS.send.windowMs);
    const limited = await call('POST', '/v1/ask', { text: 'todo add one more' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'rate_limited', message: ASK_SEND_DAY_LIMITED });
    expect(ASK_SEND_DAY_LIMITED).toBe('This device has asked 100 times today. Try again tomorrow.');
  }, 60_000);

  it('every Ask write counts against the Life write limit (its own sentence); reads do not', async () => {
    const { api, call } = await askApi();
    const who = api.ctx.db.devices.list().find((d) => d.name === 'Test phone');
    for (let i = 0; i < V04_LIMITS.lifeWrite.limit - 1; i++) api.services.lifeWriteLimiter.hit(`device:${who?.id}`);
    expect((await call('DELETE', '/v1/ask')).statusCode).toBe(200);
    expect((await call('GET', '/v1/ask')).statusCode).toBe(200);
    const limited = await call('DELETE', '/v1/ask');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'rate_limited', message: ASK_WRITES_LIMITED });
    expect((await call('POST', '/v1/ask', { text: 'todo add milk' })).statusCode).toBe(429);
  });
});
