/**
 * v0.11 People: a day in a People path is a date on the calendar. The day
 * key's pattern lets 2026-02-30 through; every `:day` and `:night` path
 * parameter of the People routes, hers and his, is the one calendar-checked
 * schema (PeopleDaySchema, pinned by the arch test), so such a day is a 400
 * before any handler runs and no row is ever written for it. A leap day is
 * a day.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonWeightsResponse } from '@jantar/protocol/people';
import { OWNER_HOST, OWNER_ORIGIN, credHeaders, makeFixture, onHer, type Fixture } from './isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const him = (method: 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'POST', url: string, payload?: object) =>
  f.api.tcp.inject({ method, url, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(f.owner.control) }, ...(payload ? { payload } : {}) });
const weights = async () => ((await onHer(f.api, 'GET', '/v1/p/weights', f.asha.full)).json() as PersonWeightsResponse).weights.map((w) => w.day);

describe('People day paths are dates on the calendar', () => {
  it('her weight on 2026-02-30 is a 400 and no row; a past leap day is a day', async () => {
    for (const day of ['2026-02-30', '2026-02-29', '2026-04-31', '2100-02-29']) {
      const r = await onHer(f.api, 'PUT', `/v1/p/weights/${day}`, f.asha.full, { kg: 61.5 });
      expect(r.statusCode, `${day} ${r.body}`).toBe(400);
      expect(r.body).toContain('not a date on the calendar');
      expect((await onHer(f.api, 'DELETE', `/v1/p/weights/${day}`, f.asha.full)).statusCode, day).toBe(400);
    }
    expect(await weights()).toEqual([]);
    expect((await onHer(f.api, 'PUT', '/v1/p/weights/2024-02-29', f.asha.full, { kg: 61.5 })).statusCode).toBe(200);
    expect((await onHer(f.api, 'PUT', '/v1/p/weights/2000-02-29', f.asha.full, { kg: 61 })).statusCode).toBe(200);
    expect((await weights()).sort()).toEqual(['2000-02-29', '2024-02-29']);
  });

  it('her plan, review, rough day and sleep paths refuse a day that is not on the calendar', async () => {
    for (const [method, url, body] of [
      ['GET', '/v1/p/plans/2026-02-30', undefined],
      ['POST', '/v1/p/plans/2026-02-30/steps', { title: 'Walk' }],
      ['POST', '/v1/p/plans/2026-06-31/rough', {}],
      ['GET', '/v1/p/plans/2026-09-31/review', undefined],
      ['PUT', '/v1/p/sleep/2026-11-31', { start: '2026-11-30T23:00:00.000Z', end: '2026-12-01T07:00:00.000Z' }],
      ['DELETE', '/v1/p/sleep/2026-02-30', undefined],
    ] as const) {
      const r = await onHer(f.api, method, url, f.asha.full, body);
      expect(r.statusCode, `${method} ${url} ${r.body}`).toBe(400);
      expect(r.body, `${method} ${url}`).toContain('not a date on the calendar');
    }
  });

  it('his plan, review and weight paths refuse one too', async () => {
    await onHer(f.api, 'PUT', '/v1/p/weights/2026-11-02', f.asha.full, { kg: 61.5 });
    for (const [method, url, body] of [
      ['GET', `/v1/people/${f.asha.id}/plans/2026-02-30`, undefined],
      ['PUT', `/v1/people/${f.asha.id}/plans/2026-02-30`, { steps: [] }],
      ['GET', `/v1/people/${f.asha.id}/plans/2026-02-30/review`, undefined],
      ['PATCH', `/v1/people/${f.asha.id}/weights/2026-02-30`, { kg: 62 }],
      ['DELETE', `/v1/people/${f.asha.id}/weights/2026-02-31`, undefined],
    ] as const) {
      const r = await him(method, url, body);
      expect(r.statusCode, `${method} ${url} ${r.body}`).toBe(400);
      expect(r.body, `${method} ${url}`).toContain('not a date on the calendar');
    }
    expect(await weights()).toEqual(['2026-11-02']);
  });
});
