/**
 * v0.5.3 wave 0, the pipeline's part:
 * - S6: notifyTest, folderTodos and folderTodoCreate are the Mac's only:
 *   over TCP, an admin device included, 403 with their sentence and no
 *   handler runs; over ctl.sock they reach their stubs (501), the folder
 *   routes behind the Todos switch.
 * - S10 (pipeline part): a capture's `via` is ctl-only, like its `cwd`.
 * - S12 (daemon part, spec 3.2): every screenshot upload logs exactly one
 *   info line, refusals included (200, 401, 403 Origin, 403 Meetings off,
 *   413, 429), with its status and Content-Length and nothing else.
 * - The API takes daemon.ts's one PaneLookup when it is given one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBodySchema, MEETING_SHOT_BODY_MAX, ROUTES, SettingsSchema, type RouteDef, type RouteName } from '@jantar/protocol';
import type { MeetingCapture, MeetingsService } from '../../src/contracts.js';
import { LOCAL_ONLY_REFUSED, SHOT_UPLOAD_LOG } from '../../src/api/app.js';
import { ROUTE_IMPLS } from '../../src/api/routes.js';
import { PaneLookup, V053_LIMITS } from '../../src/api/services.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { CLIENT_ID, SHOT_ULID, V05_REQ, extHeaders, pairExtension } from './v05-helpers.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

type Method = 'GET' | 'POST';

const FOLDER = '/synthetic/home/work/demo-app';
const V053: Partial<Record<RouteName, { url: string; body?: object }>> = {
  folderTodos: { url: `/v1/folder/todos?folder=${encodeURIComponent(FOLDER)}` },
  folderTodoCreate: { url: '/v1/folder/todos', body: { folder: FOLDER, title: 'Write the release notes' } },
  notifyTest: { url: '/v1/notify/test', body: { group: 'needs' } },
};
const NAMES = Object.keys(V053) as RouteName[];
const TODOS_ON = SettingsSchema.parse({ life: { todos: true }, intel: { enabled: true } });

function call(t: TestApi, transport: 'tcp' | 'ctl', name: RouteName, headers: Record<string, string> = {}) {
  const def = ROUTES[name] as RouteDef;
  const r = V053[name] ?? { url: def.path };
  return t[transport].inject({ method: def.method as Method, url: r.url, headers, ...(r.body ? { payload: r.body } : {}) });
}

describe('S6: the v0.5.3 routes are the Mac only', () => {
  it('over TCP an admin device gets 403 with the sentence that names the CLI; no handler runs', async () => {
    api = await makeApi({ ctx: { settings: TODOS_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    const spies = NAMES.map((n) => vi.spyOn(ROUTE_IMPLS[n] as { handle: () => unknown }, 'handle'));
    for (const name of NAMES) {
      const res = await call(api, 'tcp', name, h(cookie));
      expect(res.statusCode, name).toBe(403);
      expect(ErrorBodySchema.parse(res.json()).error).toEqual({ code: 'forbidden', message: LOCAL_ONLY_REFUSED[name] });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(LOCAL_ONLY_REFUSED.folderTodos).toBe("Only the Mac's CLI adds a todo by folder");
    expect(LOCAL_ONLY_REFUSED.folderTodoCreate).toBe("Only the Mac's CLI adds a todo by folder");
    expect(LOCAL_ONLY_REFUSED.notifyTest).toBe('Test alerts on the Mac: jantar notify test');
  });

  it('over ctl.sock they reach their handlers (wave 0: 501 until their packages land)', async () => {
    api = await makeApi({ ctx: { settings: TODOS_ON } });
    for (const name of NAMES) {
      const res = await call(api, 'ctl', name);
      expect([403, 401, 404, 400], `${name} ${res.body}`).not.toContain(res.statusCode);
    }
    // The test push is a stub until the alerts package builds it.
    if (ROUTE_IMPLS.notifyTest?.stub) expect((await call(api, 'ctl', 'notifyTest')).statusCode).toBe(501);
  });

  it('the folder routes sit behind the Todos switch; the test push behind none', async () => {
    api = await makeApi();
    for (const name of ['folderTodos', 'folderTodoCreate'] as const) {
      const res = await call(api, 'ctl', name);
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error.message).toBe('Todos are off. Turn them on at your Mac: jantar life on todos');
    }
    expect((await call(api, 'ctl', 'notifyTest')).statusCode).not.toBe(403);
  });

  it('folder todos are capped at 20 an hour per actor (the limiter the Life package applies)', () => {
    expect(V053_LIMITS.folderTodo).toEqual({ limit: 20, windowMs: 60 * 60_000 });
  });
});

describe("S10: a capture's via is the Mac's CLI's only", () => {
  it('over TCP a body with via is 400 before any handler; over ctl.sock it passes', async () => {
    api = await makeApi({ ctx: { settings: TODOS_ON } });
    const { cookie } = await pairCookie(api, ['read', 'control', 'admin']);
    const spy = vi.spyOn(ROUTE_IMPLS.intelCapture as { handle: () => unknown }, 'handle');
    const body = { title: 'Example capture', via: 'claude' };
    const tcp = await api.tcp.inject({ method: 'POST', url: '/v1/intel/captures', headers: h(cookie), payload: body });
    expect(tcp.statusCode).toBe(400);
    expect(tcp.json().error.message).toMatch(/^invalid body at via/);
    expect(spy).not.toHaveBeenCalled();
    const ctl = await api.ctl.inject({ method: 'POST', url: '/v1/intel/captures', payload: body });
    expect(ctl.statusCode).not.toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('S12: one log line per screenshot upload, refusals included', () => {
  const shotUrl = `/v1/ext/meetings/${CLIENT_ID}/shots`;

  /** A daemon with Meetings `on` whose capture saves every screenshot (the real one is meetings-routes.test.ts's). */
  async function shotApi(on: boolean, extRequest?: number) {
    const capture = notBuilt<MeetingCapture>('Meetings', { shot: async () => ({ ok: true, value: { id: SHOT_ULID } }) });
    const meetings = notBuilt<MeetingsService>('Meetings', { start: async () => {}, stop: async () => {}, broken: () => null, capture });
    api = await makeApi({
      ctx: { settings: SettingsSchema.parse({ meetings: { enabled: on } }) },
      ...(extRequest ? { api: { v05Limits: { extRequest: { limit: extRequest, windowMs: 60_000 } } } } : {}),
      deps: () => ({ meetings }),
    });
    return pairExtension(api);
  }

  const lines = () => api.ctx.log.records.filter((r) => r.msg === SHOT_UPLOAD_LOG);
  const upload = (headers: Record<string, string>, payload: unknown = V05_REQ.extMeetingShot?.body) =>
    api.tcp.inject({ method: 'POST', url: shotUrl, headers, payload: payload as object });

  /** One more line, with that status, at info, holding only the status and Content-Length (and the logger's part). */
  async function logsOne(status: number, run: () => Promise<{ statusCode: number; headers: Record<string, unknown> }>) {
    const before = lines().length;
    const res = await run();
    expect(res.statusCode).toBe(status);
    const added = lines().slice(before);
    expect(added, String(status)).toHaveLength(1);
    const line = added[0];
    expect(line?.level).toBe('info');
    const { part, ...fields } = line?.fields ?? {};
    expect(part).toBe('api');
    expect(Object.keys(fields).sort(), String(status)).toEqual(['bytes', 'status']);
    expect(fields.status).toBe(status);
    expect(typeof fields.bytes).toBe('number');
    return line;
  }

  it('200, 401 (no key), 403 (wrong Origin) and 429 (over the limiter) each log one line', async () => {
    const { key } = await shotApi(true, 2);
    await logsOne(200, () => upload(extHeaders(key)));
    await logsOne(401, () => upload(extHeaders(undefined)));
    await logsOne(403, () => upload(extHeaders(key, 'https://meet.google.com')));
    await logsOne(200, () => upload(extHeaders(key)));
    // The refusals before the limiter counted nothing; the two saved uploads used the limit up.
    await logsOne(429, () => upload(extHeaders(key)));
    // Nothing the line could leak is in any record: the client id, the key, the image.
    const all = JSON.stringify(api.ctx.log.records.filter((r) => r.msg === SHOT_UPLOAD_LOG));
    expect(all).not.toContain(CLIENT_ID);
    expect(all).not.toContain(key);
    expect(all).not.toContain('base64');
  });

  it('403 (Meetings off) and 413 (over the route limit) each log one line', async () => {
    const off = await shotApi(false);
    await logsOne(403, () => upload(extHeaders(off.key)));
    await api.close();
    const { key } = await shotApi(true);
    const huge = { key: '1c5f8d5f-0000-4000-8000-000000000000', at: 1_793_350_802_000, image: `data:image/jpeg;base64,${'A'.repeat(MEETING_SHOT_BODY_MAX)}` };
    const line = await logsOne(413, () => upload(extHeaders(key), huge));
    expect(line?.fields.bytes).toBeGreaterThan(MEETING_SHOT_BODY_MAX);
  });

  it('every other route keeps its debug request line only', async () => {
    const { key } = await shotApi(true);
    await api.tcp.inject({ method: 'GET', url: '/v1/ext/info', headers: extHeaders(key, null) });
    expect(lines()).toHaveLength(0);
    expect(api.ctx.log.records.some((r) => r.msg === 'request' && r.level === 'debug' && r.fields.route === '/v1/ext/info')).toBe(true);
  });
});

describe("the API shares daemon.ts's pane lookup", () => {
  it('takes the PaneLookup it is given, else builds its own', async () => {
    api = await makeApi();
    const own = api.services.panes;
    expect(own).toBeInstanceOf(PaneLookup);
    await api.close();
    const shared = new PaneLookup(api.fakes.terminal, api.ctx);
    api = await makeApi({ deps: () => ({ panes: shared }) });
    expect(api.services.panes).toBe(shared);
  });
});
