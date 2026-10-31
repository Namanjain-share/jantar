/**
 * A session id that names an Object.prototype member ("constructor",
 * "__proto__", "toString", ...) is just an unknown session: every route with
 * a :sid answers 404, never 500 or a handler reaching its part with a
 * function for a session (route-kit.ts sessionOr404 reads own keys only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES, SettingsSchema, type RouteDef, type RouteName } from '@jantar/protocol';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const ALL_ON = SettingsSchema.parse({
  files: { enabled: true },
  launch: { enabled: true },
  rewrite: { enabled: true },
  controls: { enabled: true },
  screenshots: { enabled: true },
});

/** Bodies that pass validation, so the status says what the handler did with the sid. */
const BODY: Partial<Record<RouteName, unknown>> = {
  rewriteStart: { text: 'fix the flaky test' },
  sessionKey: { key: 'interrupt' },
  sessionMode: { mode: 'plan' },
  sessionCommand: { name: 'compact' },
};

const SIDS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

// sendPrompt leaves the session check to the writer (writer/preconditions.ts lookupSession, the
// writer tests), and the API fakes' writer takes any sid.
const sidRoutes = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([n, d]) => d.path.includes('/:sid') && n !== 'sendPrompt');

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('a sid that names an Object.prototype member', () => {
  it('is an unknown session on every :sid route', async () => {
    expect(sidRoutes.length).toBeGreaterThan(5);
    api = await makeApi({ ctx: { settings: ALL_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control', 'launch']);
    const wrong: string[] = [];
    for (const [name, def] of sidRoutes) {
      for (const sid of SIDS) {
        const url = def.path.replace(':sid', encodeURIComponent(sid)).replace(/:([A-Za-z]+)/g, 'x');
        const body = BODY[name] ?? (def.method === 'GET' || def.method === 'DELETE' ? undefined : {});
        const res = await api.tcp.inject({
          method: def.method as Method,
          url,
          headers: h(cookie, { 'idempotency-key': `k-${name}-${sid}` }),
          ...(body !== undefined ? { payload: body as object } : {}),
        });
        // 400 is a body this table does not fill in; anything at 500 or above is the bug.
        if (res.statusCode !== 404 && res.statusCode !== 400) wrong.push(`${name} ${sid}: ${res.statusCode} ${res.body.slice(0, 120)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
