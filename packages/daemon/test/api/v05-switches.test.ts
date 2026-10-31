/**
 * The v0.5 stubs and the switch (MA8): with Meetings on, every v0.5 route
 * still a WP0 stub answers 501 once it is through the gate (a built one
 * drops `stub` and is skipped); with
 * Meetings off, every route behind the switch answers 403 with the sentence
 * that turns it on, before validation and before any handler, while the
 * status and the three pairing routes still answer. A broken meetings.db
 * makes the switched routes 503 meetings_unavailable (MD1, API part). Phone
 * writes share Life's per-device write limit; the extension's do not. The
 * screenshot upload has its own body limit, and its 413 says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBodySchema, MEETING_SHOT_BODY_MAX, type RouteDef, type RouteName } from '@jantar/protocol';
import type { MeetingsService } from '../../src/contracts.js';
import { FEATURE_OFF, MEETING_WRITES_LIMITED } from '../../src/api/app.js';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { V04_LIMITS } from '../../src/api/services.js';
import { notBuiltParts } from '../../src/core/testing.js';
import { MEETINGS_BROKEN_REASON } from '../../src/meetings/db.js';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { EXT_ORIGIN, V05, V05_EXT, V05_OFF, V05_ON, V05_PHONE, extHeaders, pairExtension, pastGate, v05Call } from './v05-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const PAIRING: readonly RouteName[] = ['extPairStart', 'extPairClaim', 'extUnpair'];

/** The headers each v0.5 route needs to get through the gate: the extension's or a control device's. */
async function callers(t: TestApi) {
  const { key } = await pairExtension(t);
  const { cookie } = await pairCookie(t, ['read', 'control']);
  return (name: RouteName, def: RouteDef) => (def.scope === 'extension' ? extHeaders(key, def.method === 'GET' ? null : EXT_ORIGIN) : h(cookie));
}

describe('v0.5 stubs', () => {
  it('with Meetings on, each answers 501 over TCP, and over ctl.sock where served (404 elsewhere)', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const headers = await callers(api);
    for (const [name, def] of V05) {
      if (!ROUTE_IMPLS[name]?.stub) continue;
      const res = await v05Call(api, 'tcp', name, headers(name, def));
      expect(res.statusCode, `${name} ${res.body}`).toBe(501);
      expect(ErrorBodySchema.parse(res.json()).error.code).toBe('not_implemented');
      const viaCtl = await v05Call(api, 'ctl', name);
      expect(viaCtl.statusCode, `ctl ${name}`).toBe(def.ctl ? 501 : 404);
    }
    // The pairing routes are real.
    for (const name of PAIRING) expect(ROUTE_IMPLS[name]?.stub, name).toBeUndefined();
  });
});

describe('MA8: the Meetings switch', () => {
  it('off: every route behind it answers 403 with its sentence, even with a bad body; no handler runs', async () => {
    api = await makeApi({ ctx: { settings: V05_OFF } });
    const headers = await callers(api);
    const gated = V05.filter(([, d]) => d.feature === 'meetings');
    expect(gated.map(([n]) => n).sort()).toEqual([...V05_EXT, ...V05_PHONE].map(([n]) => n).filter((n) => n !== 'meetingsStatus').sort());
    const spies = gated.map(([name]) => vi.spyOn(ROUTE_IMPLS[name] as { handle: () => unknown }, 'handle'));
    for (const [name, def] of gated) {
      const res = await v05Call(api, 'tcp', name, headers(name, def));
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error, name).toEqual({ code: 'forbidden', message: FEATURE_OFF.meetings.message });
      if (def.method !== 'GET') expect((await v05Call(api, 'tcp', name, headers(name, def), { nonsense: 1 })).statusCode, `${name} bad body`).toBe(403);
      if (def.ctl) expect((await v05Call(api, 'ctl', name)).statusCode, `ctl ${name}`).toBe(403);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(FEATURE_OFF.meetings.message).toBe('Meetings are off. Turn them on at your Mac: jantar meetings on');
    // The status and the pairing routes sit behind no switch.
    expect((await v05Call(api, 'ctl', 'meetingsStatus')).statusCode).not.toBe(403);
    expect((await v05Call(api, 'ctl', 'extPairStart')).statusCode).toBe(200);
    expect((await v05Call(api, 'ctl', 'extUnpair')).statusCode).toBe(200);
  });

  it('turned on at the Mac, the routes open at once', async () => {
    api = await makeApi({ ctx: { settings: V05_OFF } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect((await v05Call(api, 'tcp', 'meetingsList', h(cookie))).statusCode).toBe(403);
    expect((await api.ctl.inject({ method: 'PATCH', url: '/v1/settings', payload: { meetings: { enabled: true } } })).statusCode).toBe(200);
    expect((await v05Call(api, 'tcp', 'meetingsList', h(cookie))).statusCode).not.toBe(403);
  });
});

describe('a broken meetings.db (MD1, API part)', () => {
  function brokenMeetings(): MeetingsService {
    const m = notBuiltParts().meetings;
    return new Proxy(m, { get: (t, p, r) => (p === 'broken' ? () => MEETINGS_BROKEN_REASON : Reflect.get(t, p, r)) });
  }

  it('every route behind the switch answers 503 with the sentence; the status, pairing, Life and sessions carry on', async () => {
    api = await makeApi({ ctx: { settings: V05_ON }, deps: () => ({ meetings: brokenMeetings() }) });
    const headers = await callers(api);
    for (const [name, def] of V05) {
      if (PAIRING.includes(name)) continue;
      const res = await v05Call(api, 'tcp', name, headers(name, def));
      if (def.feature === 'meetings') {
        expect(res.statusCode, name).toBe(503);
        expect(res.json().error, name).toEqual({ code: 'meetings_unavailable', message: MEETINGS_BROKEN_REASON });
      } else {
        expect(res.statusCode, name).not.toBe(503);
      }
    }
    expect((await v05Call(api, 'ctl', 'extPairStart')).statusCode).toBe(200);
    expect(MEETINGS_BROKEN_REASON).toBe('Meetings data could not be opened. The file is untouched. Move meetings.db aside at your Mac to start again (docs/extension.md).');
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/sessions', headers: h(cookie) })).statusCode).toBe(200);
  });

  it('with Meetings off the switch says so before the 503', async () => {
    api = await makeApi({ ctx: { settings: V05_OFF }, deps: () => ({ meetings: brokenMeetings() }) });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    expect((await v05Call(api, 'tcp', 'meetingsList', h(cookie))).json().error.code).toBe('forbidden');
  });
});

describe('limits in the pipeline', () => {
  it("a phone's meeting writes share Life's per-device limit (the 241st is 429 with the meetings sentence); reads and other devices are not counted", async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const other = await pairCookie(api, ['read', 'control']);
    for (let i = 0; i < V04_LIMITS.lifeWrite.limit; i++) {
      expect((await v05Call(api, 'tcp', 'meetingDelete', h(cookie))).statusCode, `write ${i + 1}`).not.toBe(429);
    }
    const limited = await v05Call(api, 'tcp', 'meetingUpdate', h(cookie));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'rate_limited', message: MEETING_WRITES_LIMITED });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await v05Call(api, 'tcp', 'meetingsList', h(cookie))).statusCode).not.toBe(429);
    expect((await v05Call(api, 'tcp', 'meetingDelete', h(other.cookie))).statusCode).not.toBe(429);
  });

  it("the extension's writes are not counted against Life's limit", async () => {
    api = await makeApi({ ctx: { settings: V05_ON }, api: { v05Limits: { extRequest: { limit: 1000, windowMs: 60_000 } } } });
    const { key } = await pairExtension(api);
    for (let i = 0; i < V04_LIMITS.lifeWrite.limit + 5; i++) {
      expect((await v05Call(api, 'tcp', 'extMeetingLines', extHeaders(key))).statusCode, `lines ${i + 1}`).not.toBe(429);
    }
  });

  it('the screenshot upload takes up to 6 MB and its 413 names it; every other route keeps 64 KB', async () => {
    api = await makeApi({ ctx: { settings: V05_ON } });
    const { key } = await pairExtension(api);
    const shot = (image: string) => ({ key: '1c5f8d5f-0000-4000-8000-000000000000', at: 0, image });
    const big = await v05Call(api, 'tcp', 'extMeetingShot', extHeaders(key), shot(`data:image/jpeg;base64,${'A'.repeat(MEETING_SHOT_BODY_MAX)}`));
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toEqual({ code: 'payload_too_large', message: 'request body is larger than 6 MB' });
    const fine = await v05Call(api, 'tcp', 'extMeetingShot', extHeaders(key), shot(`data:image/jpeg;base64,${'A'.repeat(200 * 1024)}`));
    expect(fine.statusCode, fine.body).not.toBe(413);
    expect(pastGate(fine), fine.body).toBe(true);
    const lines = await v05Call(api, 'tcp', 'extMeetingLines', extHeaders(key), { lines: [], pad: 'x'.repeat(70 * 1024) });
    expect(lines.statusCode).toBe(413);
    expect(lines.json().error.message).toBe('request body is larger than 64 KB');
  });
});
