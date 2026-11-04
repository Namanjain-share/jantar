/**
 * 0.14.0 Switching rules over the API: GET and PATCH /v1/accounts/switching
 * on a synthetic home with ccw (makeFakeHome({ ccw: true })), the real ccw
 * reader and write.ts.
 *
 * - A phone paired with control reads and saves; a read-scope phone, a
 *   cookie without its device secret and a write from another Origin are
 *   refused, and the file stays as it was.
 * - A bad body is refused before anything is read or written.
 * - A read-only daemon refuses the save (403, before the handler) and still
 *   reads; a Mac without ccw answers 404 ccw_absent; a switch.json that won't
 *   parse answers 409 with the sentence the phone shows, untouched.
 * - The audit row names the keys saved, never a value.
 * - Her host (0.11's People) never reaches either route, with his strongest
 *   credential or none: 404 with an empty body, the file untouched.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { DEVICE_SECRET_HEADER, ErrorBodySchema, SettingsSchema, SwitchRulesSchema, type Scope } from '@jantar/protocol';
import { READ_ONLY_REFUSED } from '../../src/api/app.js';
import { READ_ONLY_REASON } from '../../src/modes.js';
import { createCcwLegacy } from '../../src/sources/ccw-legacy/index.js';
import { SWITCH_COPY } from '../../src/sources/ccw-legacy/write.js';
import { bare, h, makeApi, pairCookie, type TestApi } from './fakes.js';

const URL_ = '/v1/accounts/switching';
const RAMP = { days: [50, 50, 50, 50, 75, 85, 95], lastHour: 100 };

let api: TestApi | undefined;
let home: FakeHome | undefined;
afterEach(async () => {
  await api?.close();
  await home?.cleanup();
  api = undefined;
  home = undefined;
});

/** An API on a fake home with ccw (or without), its ccw reader the real one. */
async function setup(opts: { ccw?: boolean; readOnly?: boolean; people?: boolean } = {}) {
  home = await makeFakeHome({ ccw: opts.ccw ?? true });
  api = await makeApi({
    ctx: {
      userHome: home.home,
      home: home.jantarHome,
      ...(opts.people
        ? {
            settings: SettingsSchema.parse({
              remote: { mode: 'cloudflare', publicUrl: 'https://jantar.test', peopleUrl: 'https://us.test' },
              people: { enabled: true, ownerName: 'Sam' },
            }),
          }
        : {}),
    },
    api: opts.readOnly ? { mode: { readOnly: true, terminal: 'terminal-app' } } : {},
    deps: (ctx) => ({ ccwLegacy: createCcwLegacy(ctx) }),
  });
  const file = api.ctx.paths.ccwSwitchJson;
  return { api, file, text: () => readFile(file, 'utf8') };
}

async function phone(a: TestApi, scopes: Scope[] = ['read', 'control']) {
  return (await pairCookie(a, scopes, 'Test phone')).cookie;
}

const patch = (a: TestApi, headers: Record<string, string>, payload: unknown) =>
  a.tcp.inject({ method: 'PATCH', url: URL_, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });

describe('0.14.0 switching rules: a phone paired with control', () => {
  it('reads the rules and saves them; the reply is the rules as saved', async () => {
    const { api: a, text } = await setup();
    const cookie = await phone(a);
    const got = await a.tcp.inject({ method: 'GET', url: URL_, headers: h(cookie) });
    expect(got.statusCode, got.body).toBe(200);
    expect(SwitchRulesSchema.parse(got.json())).toEqual({ hold: [3], ceiling: 97, weeklyCeiling: 95, leadMin: 10, weeklyRamp: {} });

    const res = await patch(a, h(cookie), { hold: [1, 3], weeklyCeiling: 99, weeklyRamp: { '2': RAMP } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ hold: [1, 3], ceiling: 97, weeklyCeiling: 99, leadMin: 10, weeklyRamp: { '2': RAMP } });
    const saved = JSON.parse(await text()) as Record<string, unknown>;
    expect(saved).toMatchObject({ hold: [1, 3], weekly_ceiling: 99, weekly_ramp: { '2': { days: RAMP.days, last_hour: 100 } } });
    // the rest of ccw's file as it was
    expect(saved).toMatchObject({ on: false, dry_run: true, save_prompt: 'synthetic save prompt', groups: [['alpha-app', 'bravo-api']] });

    const removed = await patch(a, h(cookie), { weeklyRamp: { '2': null } });
    expect(removed.json()).toMatchObject({ weeklyRamp: {} });
    expect(JSON.parse(await text())).not.toHaveProperty('weekly_ramp');
  });

  it('audits the keys it saved, never a value', async () => {
    const { api: a } = await setup();
    const cookie = await phone(a);
    expect((await patch(a, h(cookie), { leadMin: 43, weeklyRamp: { '2': RAMP } })).statusCode).toBe(200);
    const row = a.ctx.db.audit.list({ limit: 50 }).find((r) => r.action === 'patchSwitchRules');
    expect(row?.params).toEqual({ keys: ['leadMin', 'weeklyRamp'] });
    expect(row?.result).toBe('ok');
    expect(JSON.stringify(row?.params)).not.toMatch(/43|85|100/);
  });

  it('is served on ctl.sock too (the Mac itself)', async () => {
    const { api: a } = await setup();
    const res = await a.ctl.inject({ method: 'PATCH', url: URL_, payload: { ceiling: 95 } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await a.ctl.inject({ method: 'GET', url: URL_ })).json()).toMatchObject({ ceiling: 95 });
  });
});

describe('0.14.0 switching rules: refusals', () => {
  it('a read-scope phone, a cookie without its secret and another Origin change nothing', async () => {
    const { api: a, text } = await setup();
    const before = await text();
    const viewer = await phone(a, ['read']);
    expect((await a.tcp.inject({ method: 'GET', url: URL_, headers: h(viewer) })).statusCode).toBe(403);
    expect((await patch(a, h(viewer), { ceiling: 90 })).statusCode).toBe(403);
    const cookie = await phone(a);
    expect((await patch(a, bare(cookie), { ceiling: 90 })).statusCode).toBe(401); // the device secret is missing
    const other = h(cookie, { origin: 'http://127.0.0.1:9999' });
    expect((await patch(a, other, { ceiling: 90 })).statusCode).toBe(403);
    expect((await patch(a, bare(), { ceiling: 90 })).statusCode).toBe(401); // not paired
    expect(await text()).toBe(before);
  });

  it('refuses a bad body before reading or writing', async () => {
    const { api: a, text } = await setup();
    const before = await text();
    const cookie = await phone(a);
    for (const body of [{}, { on: true }, { ceiling: 49 }, { hold: [1, 1] }, { weeklyRamp: { '02': RAMP } }, { weeklyRamp: { '2': { days: [50], lastHour: 100 } } }]) {
      const res = await patch(a, h(cookie), body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(ErrorBodySchema.parse(res.json()).error.code).toBe('invalid_request');
    }
    expect(await text()).toBe(before);
  });

  it('a read-only daemon refuses the save and still reads', async () => {
    expect(READ_ONLY_REFUSED.has('patchSwitchRules')).toBe(true);
    expect(READ_ONLY_REFUSED.has('getSwitchRules')).toBe(false);
    const { api: a, text } = await setup({ readOnly: true });
    const before = await text();
    const cookie = await phone(a);
    const res = await patch(a, h(cookie), { ceiling: 90 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toEqual({ code: 'forbidden', message: READ_ONLY_REASON });
    expect((await a.ctl.inject({ method: 'PATCH', url: URL_, payload: { ceiling: 90 } })).statusCode).toBe(403);
    expect((await a.tcp.inject({ method: 'GET', url: URL_, headers: h(cookie) })).statusCode).toBe(200);
    expect(await text()).toBe(before);
  });

  it('a Mac without ccw answers 404 ccw_absent, and nothing is made', async () => {
    const { api: a } = await setup({ ccw: false });
    const cookie = await phone(a);
    for (const res of [await a.tcp.inject({ method: 'GET', url: URL_, headers: h(cookie) }), await patch(a, h(cookie), { ceiling: 90 })]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toEqual({ code: 'ccw_absent', message: SWITCH_COPY.absent });
    }
    const { existsSync } = await import('node:fs');
    expect(existsSync(a.ctx.paths.ccwDir)).toBe(false);
  });

  it('a switch.json that will not parse answers 409 and is left as it is', async () => {
    const { api: a, file, text } = await setup();
    await writeFile(file, '{"on": true, "hold": [1');
    const cookie = await phone(a);
    const res = await patch(a, h(cookie), { ceiling: 90 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'conflict', message: SWITCH_COPY.broken });
    expect((await a.tcp.inject({ method: 'GET', url: URL_, headers: h(cookie) })).statusCode).toBe(409);
    expect(await text()).toBe('{"on": true, "hold": [1');
    const row = a.ctx.db.audit.list({ limit: 50 }).find((r) => r.action === 'patchSwitchRules');
    expect(row?.detail).toBe(`conflict: ${SWITCH_COPY.broken}`);
  });
});

describe('0.14.0 switching rules: her host never reaches them', () => {
  it('answers 404 with an empty body on her host, whatever comes with it; his host saves', async () => {
    const { api: a, text } = await setup({ people: true });
    const before = await text();
    const p = await pairCookie(a, ['read', 'control', 'launch', 'admin'], 'Sam admin');
    const his = { cookie: p.cookie, [DEVICE_SECRET_HEADER]: p.secret };
    for (const origin of ['https://us.test', 'https://jantar.test', undefined]) {
      for (const cred of [his, {}]) {
        const headers = { host: 'us.test', ...cred, ...(origin ? { origin } : {}) };
        const g = await a.tcp.inject({ method: 'GET', url: URL_, headers });
        const w = await patch(a, headers, { ceiling: 90 });
        expect([g.statusCode, g.body, w.statusCode, w.body], `${origin} ${Object.keys(cred).length ? 'his' : 'none'}`).toEqual([404, '', 404, '']);
      }
    }
    expect(await text()).toBe(before);
    expect(a.ctx.db.audit.list({ limit: 100 }).some((r) => r.action === 'patchSwitchRules')).toBe(false);
    // the same call on his own host is the route's own answer
    const mine = await patch(a, { host: 'jantar.test', origin: 'https://jantar.test', ...his }, { ceiling: 90 });
    expect(mine.statusCode, mine.body).toBe(200);
  });
});
