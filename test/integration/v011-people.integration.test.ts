/**
 * v0.11 People, the CLI against a real jantard (spec 9.5): cloudflare mode
 * with a people hostname, then `jantar people` end to end over ctl.sock.
 *
 * - `people on --name`, `add --email --no-food`, `offer --preset
 *   everything --see food=off` (the printed fields match, the offer is
 *   recorded once), `invite` (a /p/join#c= link on her host).
 * - She joins on her host over HTTP; `people list` carries no last-seen,
 *   `people devices` no last-seen or address.
 * - `people modules --food off` with rows is refused (none here: it works).
 * - `people todos` reads through the agreement and leaves a view mark in
 *   her Activity.
 * - `people remove --now` revokes her device: her next call is refused.
 * - Every mutating route refuses over TCP, an admin device included
 *   (localOnly).
 * Synthetic people only (Sam, Asha, @example.com).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, type PairStartResponse } from '@jantar/protocol';
import { PERSON_COOKIE, type JoinPreview, type PersonActivityResponse } from '@jantar/protocol/people';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const PUBLIC = 'https://jantar.example.com';
const PEOPLE = 'https://us.example.com';
const PEOPLE_HOST = 'us.example.com';

describe('v0.11 jantar people', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let her = '';
  let pid = '';

  const cli = async (...args: string[]) => {
    const io = memoryIo();
    const code = await main(['people', ...args], { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  };
  const onHer = (method: string, path: string, body?: unknown, cookie?: string) =>
    http(d.port, method, path, { ...(body !== undefined ? { body } : {}), ...(cookie ? { cookie } : {}), origin: PEOPLE, headers: { host: PEOPLE_HOST } });

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true, timezone: 'UTC' } } });
    await d.ctx.settings.patch({ remote: { mode: 'cloudflare', publicUrl: PUBLIC, peopleUrl: PEOPLE } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('on, add, offer and invite at the Mac; she joins on her host', async () => {
    expect((await cli('on', '--name', 'Sam')).code).toBe(0);
    const add = await cli('add', 'Asha', '--email', 'asha@example.com', '--no-food');
    expect(add.code, add.err).toBe(0);
    expect(add.out).toContain('add asha@example.com');
    const offer = await cli('offer', 'Asha', '--preset', 'everything', '--see', 'food=off');
    expect(offer.code, offer.err).toBe(0);
    expect(offer.out).toMatch(/see\.todos = true/);
    expect(offer.out).toMatch(/see\.meds = full/);
    expect(offer.out).toMatch(/see\.food = false/);
    expect(offer.out).toMatch(/editHers\.weight = true/);
    const inv = await cli('invite', 'Asha', '--json');
    const { url } = JSON.parse(inv.out) as { url: string };
    expect(url.startsWith(`${PEOPLE}/p/join#c=`)).toBe(true);
    const code = url.split('#c=')[1] as string;
    const preview = (await onHer('POST', '/v1/p/join/preview', { code })).body as JoinPreview;
    expect(preview.offer.see.food).toBe(false);
    const listed = await callDaemon<{ people: { id: string }[] }>(ctl, 'GET', '/v1/people');
    const ledger = d.ctx.db.people.consents.listFor(listed.people[0]?.id ?? '');
    expect(ledger.filter((r) => r.action === 'offered')).toHaveLength(1);
    const joined = await onHer('POST', '/v1/p/join', { code, acceptedVersion: preview.version, agreement: preview.offer, adult: true, name: 'Asha', deviceName: 'Asha phone' });
    expect(joined.status, joined.text).toBe(200);
    her = cookieFrom(joined, PERSON_COOKIE) as string;
    pid = (joined.body as { personId: string }).personId;
    expect(her).toBeTruthy();
  });

  it('list and devices carry no last-seen, user agent or address', async () => {
    const list = await cli('list', '--json');
    expect(list.out).not.toMatch(/lastSeen|userAgent|\d+\.\d+\.\d+\.\d+/);
    const devices = await cli('devices', 'Asha');
    expect(devices.out).toContain('Asha phone');
    expect(devices.out).not.toMatch(/lastSeen|last seen/i);
  });

  it('people todos reads through the agreement and leaves a view mark', async () => {
    await onHer('POST', '/v1/p/todos', { title: 'Water the plants' }, her);
    const r = await cli('todos', 'Asha');
    expect(r.out).toContain('Water the plants');
    const act = (await onHer('GET', '/v1/p/activity', undefined, her)).body as PersonActivityResponse;
    expect(act.activity.some((a: PersonActivityResponse['activity'][number]) => a.action === 'view' && a.area === 'todos')).toBe(true);
  });

  it('every mutating People route refuses over TCP, an admin device included', async () => {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'Sam admin', scopes: ['read', 'control', 'launch', 'admin'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'Sam admin' } });
    const admin = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(admin, claim.body);
    for (const [m, path, body] of [
      ['POST', '/v1/people', { name: 'Bea' }],
      ['POST', `/v1/people/${pid}/offer`, {}],
      ['POST', `/v1/people/${pid}/invite`, undefined],
      ['DELETE', `/v1/people/${pid}/invite`, undefined],
      ['PATCH', `/v1/people/${pid}/modules`, { food: true }],
      ['POST', `/v1/people/${pid}/remove`, { mode: 'now', forget: false }],
      ['POST', '/v1/people/switch', { on: false }],
    ] as const) {
      const r = await http(d.port, m, path, { cookie: admin, ...(body ? { body } : {}) });
      expect(r.status, `${m} ${path}`).toBe(403);
    }
  });

  it('remove --now cuts her off at once', async () => {
    expect((await onHer('GET', '/v1/p/me', undefined, her)).status).toBe(200);
    const r = await cli('remove', 'Asha', '--now');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('remove asha@example.com');
    expect((await onHer('GET', '/v1/p/me', undefined, her)).status).toBe(401);
  });
});
