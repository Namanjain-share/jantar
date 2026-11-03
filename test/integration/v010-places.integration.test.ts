/**
 * v0.10 Cafés depth end to end (spec 0.10 A4, A5, A8): jantard in-process
 * on a synthetic HOME with the production wiring (harness.ts), in the UTC
 * Life zone; `jantar` (main() from packages/cli) on the real ctl.sock; a
 * phone paired with control, its event stream open from the start.
 *
 * 1. Cafés on; the phone adds four cafés (one marked with LIFE_MARKER in
 *    every text: name, area, notes, a dish's notes, a tag) and logs visits
 *    (one marked in its notes and what was had); the first visit marks a
 *    café tried.
 * 2. Sorts: best (the score), recent, visits, name, price, work.
 * 3. Filters: every tag, price at most, stars at least, would go again,
 *    area, a search; the tag and area counts.
 * 4. One café with its visits, newest first, paged; a future visit is 400.
 * 5. `jantar place list` and `show` read them over ctl.sock; no café write
 *    is there (404).
 * 6. Deleting a café deletes its visits.
 * 7. The sweep: the marker is in no WS frame, stored event, audit row, log
 *    line or write reply; audit rows carry the café's id only.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIFE_MARKER, perfBudgetMs, placeBody, visitBody } from '@jantar/fixtures';
import { DEVICE_COOKIE, eventsSocketProtocols, type PairStartResponse, type PlaceDetail, type PlacesResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { LIFE_SCHEMA_VERSION } from '../../packages/daemon/src/life/db.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';

// The `ws` client @fastify/websocket itself depends on (the daemon's own dependency; test only).
const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url));
interface WsClient {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  once(ev: 'open', fn: () => void): void;
  close(): void;
}
const WebSocket = createRequire(daemonRequire.resolve('@fastify/websocket'))('ws') as new (url: string, protocols: string[], opts: { headers: Record<string, string> }) => WsClient;

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ago = (n: number) => dayOf(Date.now() - n * DAY_MS);

describe('v0.10 Cafés depth through jantard: sorts, filters, visits, jantar place and the privacy sweep', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let ws: WsClient | null = null;
  const frames: string[] = [];
  const writes: Array<{ what: string; text: string }> = [];
  const ids: Record<string, string> = {};

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const headers: Record<string, string> = method === 'GET' ? {} : { 'idempotency-key': `k-${randomUUID()}` };
    const r = await http(d.port, method, path, { cookie: phone, headers, ...(body === undefined ? {} : { body }) });
    if (method !== 'GET') writes.push({ what: `${method} ${path}`, text: r.text });
    return r;
  }

  async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}: ${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as T;
  }

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  const names = async (query = ''): Promise<string[]> => (await ok<PlacesResponse>('GET', `/v1/places${query}`)).places.map((p) => p.name);

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { timezone: 'UTC', currency: 'INR' } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'cafés phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'cafés phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    const secret = (claim.body as { deviceSecret: string }).deviceSecret;
    const socket = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(secret), { headers: { origin: `http://127.0.0.1:${d.port}`, cookie: phone } });
    socket.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.on('error', reject);
    });
    ws = socket;
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    ws?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. cafés on; four cafés and their visits; the first visit marks a café tried', async () => {
    const on = await cli('life', 'on', 'places');
    expect(on.code, on.err).toBe(0);
    const made = async (key: string, body: unknown) => {
      ids[key] = (await ok<{ id: string }>('POST', '/v1/places', body)).id;
    };
    await made('marked', placeBody({ tried: false, stars: 3, price: 3, again: 'maybe', ratings: { work: 2 } }, { marked: true }));
    await made('work', { name: 'Example Café', area: 'Old Town', stars: 4, price: 2, again: 'yes', ratings: { work: 5 }, tags: ['Wi-Fi', 'sockets', 'quiet'], dishes: [{ name: 'Cardamom bun', rating: 5, price: 18000 }] });
    await made('dosa', { name: 'Sample Dosa House', area: 'old town', tried: true, stars: 5, price: 1, again: 'yes', tags: ['veg', 'wifi'], dishes: [{ name: 'Ghee roast dosa', rating: 4 }] });
    await made('want', { name: 'Fixture Bakery', ratings: { food: 4, drinks: 3 } });
    expect(Object.values(ids).every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);

    await ok('POST', `/v1/places/${ids.work}/visits`, { day: ago(20), spend: 40000, stars: 4 });
    await ok('POST', `/v1/places/${ids.work}/visits`, { day: ago(5), spend: 50000 });
    await ok('POST', `/v1/places/${ids.work}/visits`, { day: ago(2) });
    await ok('POST', `/v1/places/${ids.dosa}/visits`, { day: ago(1), spend: 30000 });
    const v = await ok<{ id: string }>('POST', `/v1/places/${ids.marked}/visits`, visitBody({ day: ago(3) }, { marked: true }));
    expect(writes.at(-1)?.text).toBe(JSON.stringify({ id: v.id }));
    const all = await ok<PlacesResponse>('GET', '/v1/places');
    const marked = all.places.find((p) => p.id === ids.marked);
    expect(marked?.tried).toBe(true);
    expect(all.places.find((p) => p.id === ids.work)?.visits).toEqual({ count: 3, last: ago(2), avgSpend: 45000 });
  });

  it('2. every sort, each ending with the name', async () => {
    // Scores: dosa 5, work 4, want 3.5 (the mean of 4 and 3), marked 3.
    expect(await names()).toEqual(['Sample Dosa House', 'Example Café', 'Fixture Bakery', `Example Café ${LIFE_MARKER}`]);
    expect(await names('?sort=recent')).toEqual(['Sample Dosa House', 'Example Café', `Example Café ${LIFE_MARKER}`, 'Fixture Bakery']);
    expect(await names('?sort=visits')).toEqual(['Example Café', `Example Café ${LIFE_MARKER}`, 'Sample Dosa House', 'Fixture Bakery']);
    expect(await names('?sort=name')).toEqual(['Example Café', `Example Café ${LIFE_MARKER}`, 'Fixture Bakery', 'Sample Dosa House']);
    expect(await names('?sort=price')).toEqual(['Sample Dosa House', 'Example Café', `Example Café ${LIFE_MARKER}`, 'Fixture Bakery']);
    expect(await names('?sort=work')).toEqual(['Example Café', `Example Café ${LIFE_MARKER}`, 'Sample Dosa House', 'Fixture Bakery']);
  });

  it('3. every filter alone and together; the tag and area counts', async () => {
    expect(await names('?tags=wifi')).toEqual(['Sample Dosa House', 'Example Café', `Example Café ${LIFE_MARKER}`]);
    expect(await names('?tags=Wi-Fi,quiet')).toEqual(['Example Café']);
    expect(await names('?price=2')).toEqual(['Sample Dosa House', 'Example Café']);
    expect(await names('?stars=4')).toEqual(['Sample Dosa House', 'Example Café']);
    expect(await names('?again=1')).toEqual(['Sample Dosa House', 'Example Café']);
    expect(await names('?area=OLD%20TOWN')).toEqual(['Sample Dosa House', 'Example Café']);
    expect(await names('?q=cardamom')).toEqual(['Example Café']);
    expect(await names('?filter=tried&tags=wifi&price=2&stars=4&again=1&area=old%20town&q=example')).toEqual(['Example Café']);
    const r = await ok<PlacesResponse>('GET', '/v1/places?tags=quiet');
    expect(r.tags.slice(0, 2)).toEqual([
      { tag: 'wifi', n: 3 },
      { tag: 'sockets', n: 2 },
    ]);
    expect(r.areas).toEqual([
      { area: 'Old Town', n: 2 },
      { area: `Example Area ${LIFE_MARKER}`, n: 1 },
    ]);
    expect((await call('GET', '/v1/places?sort=rating')).status).toBe(400);
  });

  it('4. one café with its visits, newest first; a future visit is 400 with its sentence', async () => {
    const one = await ok<PlaceDetail>('GET', `/v1/places/${ids.work}`);
    expect(one.place.name).toBe('Example Café');
    expect(one.place.tags).toEqual(['wifi', 'sockets', 'quiet']);
    expect(one.visits.map((v) => v.day)).toEqual([ago(2), ago(5), ago(20)]);
    expect(one.more).toBe(false);
    const older = await ok<PlaceDetail>('GET', `/v1/places/${ids.work}?before=${one.visits[0]!.id}`);
    expect(older.visits.map((v) => v.day)).toEqual([ago(5), ago(20)]);
    const future = await call('POST', `/v1/places/${ids.work}/visits`, { day: dayOf(Date.now() + 2 * DAY_MS) });
    expect(future.status).toBe(400);
    expect((future.body as { error: { message: string } }).error.message).toBe('A visit can be today or earlier.');
  });

  it('5. jantar place list and show read them over ctl.sock; no café write is there', async () => {
    const list = await cli('place', 'list', '--sort', 'visits', '--tag', 'wifi');
    expect(list.code, list.err).toBe(0);
    const lines = list.out.trim().split('\n');
    expect(lines[0]).toBe('3 cafés, most visited first');
    expect(lines[1]).toMatch(/^Example Café\s+★★★★☆ {2}₹₹ +Old Town · last \d+ \w{3} · Wi-Fi, Sockets, Quiet {2}[0-9A-Z]{26}$/);
    expect(list.out).not.toContain('\u001b');
    const show = await cli('place', 'show', ids.work!);
    expect(show.code, show.err).toBe(0);
    expect(show.out).toContain('Ratings: Work ★★★★★');
    expect(show.out).toContain('Visits: 3 · about ₹450 a visit');
    const status = await cli('life', 'status');
    expect(status.out).toContain(`(life.db schema ${LIFE_SCHEMA_VERSION})`);
    for (const [method, path] of [
      ['POST', '/v1/places'],
      ['PATCH', `/v1/places/${ids.work}`],
      ['DELETE', `/v1/places/${ids.work}`],
      ['POST', `/v1/places/${ids.work}/visits`],
    ] as const) {
      const r = await ctl.request(method, path, {});
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it("6. deleting a café deletes its visits; another café's stay", async () => {
    await ok('DELETE', `/v1/places/${ids.work}`);
    const raw = new DatabaseSync(d.ctx.paths.lifeDb, { readOnly: true });
    try {
      const left = raw.prepare('SELECT place_id FROM place_visits ORDER BY place_id').all() as Array<{ place_id: string }>;
      expect(left.map((r) => r.place_id).sort()).toEqual([ids.dosa, ids.marked].sort());
    } finally {
      raw.close();
    }
    expect((await call('GET', `/v1/places/${ids.work}`)).status).toBe(404);
  });

  it('7. the sweep: no café text in frames, events, audit rows, logs or write replies; audit rows hold the id only', async () => {
    const replay = d.ctx.store.replay(0);
    const events = replay.kind === 'events' ? replay.events : [];
    const audit = d.ctx.db.audit.list().filter((a) => a.action.startsWith('place'));
    expect(audit.length).toBeGreaterThan(5);
    for (const a of audit) {
      expect(a.params, a.action).toEqual({});
      expect(Object.values(ids)).toContain(a.target);
    }
    for (const [what, text] of [
      ['frames', frames.join('\n')],
      ['events', JSON.stringify(events)],
      ['audit', JSON.stringify(d.ctx.db.audit.list())],
      ['logs', JSON.stringify(d.log.records)],
      ['writes', JSON.stringify(writes)],
    ] as const) {
      expect(text, what).not.toContain(LIFE_MARKER);
    }
    expect(frames.some((f) => f.includes('life.changed'))).toBe(true);
  });
});
