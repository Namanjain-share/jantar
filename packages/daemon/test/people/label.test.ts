/**
 * v0.11 People: the space's name with one person (his label), on the
 * isolation fixture (Sam; Asha on Everything; Bea on Standard).
 *
 * - He names it when he adds someone (`jantar people add --label`) or later
 *   (his app, or `jantar people label` over ctl.sock): a preset or his own
 *   words, trimmed, 1 to 40 characters, plain text on one line. Unset (or
 *   the default itself) it is "Accountability partner", and nothing is
 *   stored.
 * - It is his, never in the ledger: her join page, her Me, his list and her
 *   export carry it; renaming is an Activity row with the old and new names
 *   (once she has joined) and ticks her app, never Bea's.
 * - Pushes about the space carry it as their title: hers (her test push,
 *   `hide_all`, an alert from him) and his about her (an alert from her).
 * - Her manifest (`/v1/p/manifest`, her credential only) is the built one
 *   under the label, short_name at most 12 characters.
 * - A label with markup is text: JSON carries it as typed, her HTML export
 *   escapes it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoinPreview, PeopleList, PersonActivityResponse, PersonMe } from '@jantar/protocol/people';
import { NONE, OWNER_HOST, OWNER_ORIGIN, PEOPLE_HOST, credHeaders, makeFixture, onHer, type Cred, type Fixture } from './isolation-fixture.js';

let f: Fixture;
let dist: string | null = null;
afterEach(async () => {
  await f?.close();
  if (dist) rmSync(dist, { recursive: true, force: true });
  dist = null;
});

const setup = async (withDist = false) => {
  if (withDist) {
    dist = mkdtempSync(join(tmpdir(), 'jantar-label-'));
    mkdirSync(join(dist, 'icons'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>owner</title>');
    writeFileSync(join(dist, 'p.html'), '<!doctype html><title>hers</title>');
    writeFileSync(join(dist, 'p.webmanifest'), JSON.stringify({ id: '/p', name: 'Accountability partner', short_name: 'Partner', start_url: '/p', scope: '/p', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] }));
  }
  f = await makeFixture(dist ? { api: { webDist: dist } } : {});
  f.api.fakes.pushed.length = 0;
};

type Method = 'GET' | 'POST' | 'PATCH';
const him = (method: Method, url: string, payload?: object, cred: Cred = f.owner.control) =>
  f.api.tcp.inject({ method, url, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred) }, ...(payload ? { payload } : {}) });
const ctl = (method: Method, url: string, payload?: object) => f.api.ctl.inject({ method, url, ...(payload ? { payload } : {}) });
const me = async (who: Cred = f.asha.full) => (await onHer(f.api, 'GET', '/v1/p/me', who)).json() as PersonMe;
const listed = async () => ((await ctl('GET', '/v1/people')).json() as PeopleList).people;
const activity = async (who: Cred = f.asha.full) => ((await onHer(f.api, 'GET', '/v1/p/activity', who)).json() as PersonActivityResponse).activity;
const labelRows = async (who?: Cred) => (await activity(who)).filter((r) => r.action === 'label.changed').map((r) => r.changes?.[0]);
const stored = (pid: string) => f.life.people.person(pid)?.label;

describe('the space’s name', () => {
  it('defaults to "Accountability partner" with nothing stored; add --label names it, and her join page reads it', async () => {
    await setup();
    expect(stored(f.asha.id)).toBeUndefined();
    expect((await me()).label).toBe('Accountability partner');
    expect((await listed()).find((p) => p.id === f.asha.id)?.label).toBe('Accountability partner');
    const add = await ctl('POST', '/v1/people', { name: 'Hal', email: 'hal@example.com', label: '  Cofounder  ' });
    expect(add.statusCode, add.body).toBe(201);
    const hal = (add.json() as { id: string }).id;
    expect(stored(hal)).toBe('Cofounder');
    const { url } = (await ctl('POST', `/v1/people/${hal}/invite`)).json() as { url: string };
    const preview = (await onHer(f.api, 'POST', '/v1/p/join/preview', NONE, { code: url.split('#c=')[1] })).json() as JoinPreview;
    expect(preview.label).toBe('Cofounder');
    // The default named outright is the default: nothing stored.
    const ivy = ((await ctl('POST', '/v1/people', { name: 'Ivy', label: 'Accountability partner' })).json() as { id: string }).id;
    expect(stored(ivy)).toBeUndefined();
    expect((await listed()).find((p) => p.id === ivy)?.label).toBe('Accountability partner');
  });

  it('he renames it from his app or the Mac: her app reads it at once, an Activity row each time, never Bea’s', async () => {
    await setup();
    const before = await activity(f.bea.full);
    const r = await him('PATCH', `/v1/people/${f.asha.id}`, { label: 'Coach' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await me()).label).toBe('Coach');
    expect((await me(f.bea.full)).label).toBe('Accountability partner');
    // The Mac's CLI reaches the same route over ctl.sock (jantar people label).
    expect((await ctl('PATCH', `/v1/people/${f.asha.id}`, { label: 'Running coach' })).statusCode).toBe(200);
    // The same name again changes nothing; null is back to the default.
    expect((await him('PATCH', `/v1/people/${f.asha.id}`, { label: 'Running coach' })).statusCode).toBe(200);
    expect((await him('PATCH', `/v1/people/${f.asha.id}`, { label: null })).statusCode).toBe(200);
    expect(stored(f.asha.id)).toBeUndefined();
    expect(await labelRows()).toEqual([
      { field: 'label', from: 'Running coach', to: 'Accountability partner' },
      { field: 'label', from: 'Coach', to: 'Running coach' },
      { field: 'label', from: 'Accountability partner', to: 'Coach' },
    ]);
    expect(await activity(f.bea.full)).toEqual(before);
    // Never in the ledger.
    expect(JSON.stringify(f.api.ctx.db.people.consents.listFor(f.asha.id))).not.toContain('Running coach');
    // A read device can't rename; an unknown or gone person is the unknown-pid answer.
    expect((await him('PATCH', `/v1/people/${f.asha.id}`, { label: 'Mentor' }, f.owner.read)).statusCode).toBe(403);
    expect((await him('PATCH', `/v1/people/${f.eli.id}`, { label: 'Mentor' })).statusCode).toBe(404);
  });

  it('is plain text on one line, 1 to 40 characters; markup is kept as typed and escaped in her export', async () => {
    await setup();
    for (const bad of ['', '   ', 'x'.repeat(41), 'Line one\nline two', `Coach${String.fromCharCode(0x202e)}`, `Bell${String.fromCharCode(7)}`, `Esc${String.fromCharCode(0x1b)}[31m`]) {
      const r = await him('PATCH', `/v1/people/${f.asha.id}`, { label: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect((await ctl('POST', '/v1/people', { name: 'Jo', label: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const hostile = '<img src=x onerror=alert(1)>&"\'';
    expect((await him('PATCH', `/v1/people/${f.asha.id}`, { label: hostile })).statusCode).toBe(200);
    expect((await me()).label).toBe(hostile);
    const html = await onHer(f.api, 'GET', '/v1/p/export?format=html', f.asha.full);
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('<p>Space: &lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;</p>');
    expect(html.body).not.toContain('<img');
    const json = (await onHer(f.api, 'GET', '/v1/p/export?format=json', f.asha.full)).json() as { person: { label: string } };
    expect(json.person.label).toBe(hostile);
  });

  it('titles the pushes about the space: hers (the test push, hide_all, an alert from him) and his about her', async () => {
    await setup();
    const sub = (cred: Cred, endpoint: string, host: 'hers' | 'his') =>
      host === 'hers'
        ? onHer(f.api, 'POST', '/v1/p/push/subscribe', cred, { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } })
        : him('POST', '/v1/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
    const HER = 'https://fcm.googleapis.com/fcm/send/asha-1';
    const HIS = 'https://fcm.googleapis.com/fcm/send/sam-1';
    await sub(f.asha.full, HER, 'hers');
    await sub(f.owner.control, HIS, 'his');
    const to = (endpoint: string) => f.api.fakes.pushed.filter((p) => p.endpoint === endpoint).map((p) => JSON.parse(p.payload) as { title: string; body: string });
    await him('PATCH', `/v1/people/${f.asha.id}`, { label: 'Cofounder' });
    await onHer(f.api, 'POST', '/v1/p/push/test', f.asha.full);
    expect(to(HER).at(-1)).toMatchObject({ title: 'Cofounder', body: 'Notifications work.' });
    expect((await onHer(f.api, 'PATCH', '/v1/p/prefs', f.asha.full, { lockScreen: 'hide_all' })).statusCode).toBe(200);
    await onHer(f.api, 'POST', '/v1/p/push/test', f.asha.full);
    expect(to(HER).at(-1)).toEqual(expect.objectContaining({ title: 'Cofounder', body: 'Something new in your space' }));
    expect((await onHer(f.api, 'PATCH', '/v1/p/prefs', f.asha.full, { lockScreen: 'hide_alerts' })).statusCode).toBe(200);
    // An alert from him: her lock screen hides its text, so the title is the space's name.
    const sent = await him('POST', '/v1/people/alerts', { to: f.asha.id, kind: 'check_in' });
    expect(sent.statusCode, sent.body).toBe(201);
    await vi.waitFor(() => expect(to(HER).at(-1)).toMatchObject({ title: 'Cofounder', body: 'Alert from Sam' }));
    // An alert from her: his lock screen shows no details by default, so the title is the space's name too.
    expect((await onHer(f.api, 'POST', '/v1/p/alerts', f.asha.full, { kind: 'check_in' })).statusCode).toBe(201);
    await vi.waitFor(() => expect(to(HIS).at(-1)).toMatchObject({ title: 'Cofounder', body: 'Alert from Asha' }));
  });
});

describe('her manifest', () => {
  it('is the built one under her label, for her credential on her host only', async () => {
    await setup(true);
    const get = (cred: Cred, host = PEOPLE_HOST) => f.api.tcp.inject({ method: 'GET', url: '/v1/p/manifest', headers: { host, ...credHeaders(cred) } });
    const dflt = await get(f.asha.full);
    expect(dflt.statusCode, dflt.body).toBe(200);
    expect(dflt.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(String(dflt.headers['cache-control'])).toContain('no-store');
    expect(dflt.json()).toMatchObject({ id: '/p', start_url: '/p', scope: '/p', name: 'Accountability partner', short_name: 'Partner', icons: [{ src: '/icons/icon-192.png' }] });
    await him('PATCH', `/v1/people/${f.asha.id}`, { label: 'Cofounder' });
    expect((await get(f.asha.full)).json()).toMatchObject({ name: 'Cofounder', short_name: 'Cofounder', description: expect.stringContaining('with your cofounder.') });
    await him('PATCH', `/v1/people/${f.asha.id}`, { label: 'My running coach' });
    expect((await get(f.asha.full)).json()).toMatchObject({ name: 'My running coach', short_name: 'My running' });
    // The cookie alone is enough for a GET (a manifest fetch sends no secret); Bea gets hers, untouched.
    expect((await get(f.asha.cookie)).statusCode).toBe(200);
    expect((await get(f.bea.full)).json()).toMatchObject({ name: 'Accountability partner', short_name: 'Partner' });
    // No credential: her not-joined answer; his host: no such route.
    expect((await get(NONE)).statusCode).toBe(401);
    expect((await get(f.owner.admin, OWNER_HOST)).statusCode).toBe(404);
    expect((await get(f.asha.revoked)).statusCode).toBe(401);
  });

  it('is a bare one under her label while her app isn’t built', async () => {
    await setup();
    await him('PATCH', `/v1/people/${f.asha.id}`, { label: 'Teammate' });
    const r = await f.api.tcp.inject({ method: 'GET', url: '/v1/p/manifest', headers: { host: PEOPLE_HOST, ...credHeaders(f.asha.full) } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: '/p', start_url: '/p', scope: '/p', display: 'standalone', name: 'Teammate', short_name: 'Teammate', description: expect.stringContaining('with your teammate.') });
  });
});
