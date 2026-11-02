/**
 * v0.12 People (P1): invites, the agreement, her states and her exits.
 *
 * - Invites (spec 2.3, 2.4, D9, C14, C37): preview spends nothing; a join
 *   spends the code once (a race yields one device); 24 h; wrong, spent and
 *   expired codes answer one sentence; a widened body or another Access
 *   email spends nothing; invites are the Mac's; "Copy link again" needs an
 *   admin device; link codes last 5 minutes, work once, stop at 5 devices.
 * - The agreement (M19): this owner's offer is Everything with food off,
 *   clamped to what P1 builds; narrowing only lowers and applies before the
 *   next read; one proposal at a time, a 7-day cooling-off after a decline,
 *   "Don't ask again"; the ledger holds no free text.
 * - Exits (T21, C12): Me, Pause, Leave, Export and Activity work while
 *   People is off, in --read-only and (Leave, Pause, Me) while life.db is
 *   broken; with People off, every /v1/people/* is 404 on TCP.
 * - States: ending reaches her exits only and turns into left at the end
 *   of the window; forget deletes her row and stays forgotten (reconcile).
 * - No owner-only record of her (T19, C8): his audit rows for her writes
 *   are `person.write` with no target and no params.
 */
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PERSON_COOKIE, type JoinPreview, type PersonMe, type PersonView } from '@jantar/protocol/people';
import { setPeopleMaxForTests } from '../../src/life/people/module.js';
import { NONE, OWNER_HOST, OWNER_ORIGIN, credHeaders, joinPerson, linkDevice, makeFixture, onHer, type Fixture } from './isolation-fixture.js';

let f: Fixture | null = null;
afterEach(async () => {
  await f?.close();
  f = null;
});

async function fx(opts: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  f = await makeFixture(opts);
  return f;
}

const ctl = (fx: Fixture, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  fx.api.ctl.inject({ method, url, ...(payload ? { payload } : {}) });
const him = (fx: Fixture, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cred = fx.owner.admin, payload?: object) =>
  fx.api.tcp.inject({ method, url, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred) }, ...(payload ? { payload } : {}) });

async function freshInvite(fx: Fixture, name: string, email?: string): Promise<{ id: string; code: string }> {
  const add = await ctl(fx, 'POST', '/v1/people', { name, ...(email ? { email } : {}) });
  const id = (add.json() as { id: string }).id;
  const inv = await ctl(fx, 'POST', `/v1/people/${id}/invite`);
  return { id, code: (inv.json() as { url: string }).url.split('#c=')[1] as string };
}

describe('invites', () => {
  it('preview spends nothing; a join spends it once; a second join with it is the one invalid answer', async () => {
    const x = await fx();
    const { code } = await freshInvite(x, 'Ines');
    const p1 = await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code });
    const p2 = await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code });
    expect([p1.statusCode, p2.statusCode]).toEqual([200, 200]);
    const preview = p1.json() as JoinPreview;
    // Standard by default, clamped to P1: no plan, review, sleep, journal or chat field is on.
    expect(preview.offer.see).toMatchObject({ todos: true, meds: 'full', weight: true, plan: false, review: 'off', sleep: false, journal: false, chat: false });
    expect(preview.fields).not.toContain('see.journal');
    const body = { code, acceptedVersion: preview.version, agreement: preview.offer, adult: true, name: 'Ines', deviceName: 'phone' };
    const [a, b] = await Promise.all([onHer(x.api, 'POST', '/v1/p/join', NONE, body), onHer(x.api, 'POST', '/v1/p/join', NONE, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const again = await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code });
    const wrong = await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(again.statusCode).toBe(400);
    expect(again.body).toBe(wrong.body);
  });

  it('expires after 24 hours with the same answer; a restart keeps an unspent one', async () => {
    const x = await fx();
    const { code } = await freshInvite(x, 'Jo');
    x.api.ctx.clock.advance(23 * 3600_000);
    expect((await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code })).statusCode).toBe(200);
    x.api.ctx.clock.advance(3600_000 + 1);
    const late = await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code });
    expect(late.statusCode).toBe(400);
    expect(late.json()).toEqual({ error: { code: 'invalid_request', message: 'This invite link has expired or was already used. Ask for a new one.' } });
  });

  it('a widened agreement, a wrong version or another Access email spends nothing', async () => {
    const x = await fx();
    const { code } = await freshInvite(x, 'Kim', 'kim@example.com');
    const preview = (await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code })).json() as JoinPreview;
    const base = { code, acceptedVersion: preview.version, agreement: preview.offer, adult: true, name: 'Kim', deviceName: 'phone' };
    const widened = { ...base, agreement: { ...preview.offer, see: { ...preview.offer.see, food: true } } };
    expect((await onHer(x.api, 'POST', '/v1/p/join', NONE, widened)).statusCode).toBe(400);
    expect((await onHer(x.api, 'POST', '/v1/p/join', NONE, { ...base, acceptedVersion: preview.version + 1 })).statusCode).toBe(409);
    const otherEmail = await x.api.tcp.inject({
      method: 'POST',
      url: '/v1/p/join',
      headers: { host: 'us.test', origin: 'https://us.test', 'cf-access-authenticated-user-email': 'someone@example.com' },
      payload: base,
    });
    expect(otherEmail.statusCode).toBe(403);
    expect(otherEmail.json().error.message).toBe("This invite is for a different email. You're signed in as someone@example.com.");
    // Still unspent: she can join with her own email, narrowed below the offer.
    const ok = await x.api.tcp.inject({
      method: 'POST',
      url: '/v1/p/join',
      headers: { host: 'us.test', origin: 'https://us.test', 'cf-access-authenticated-user-email': 'KIM@example.com' },
      payload: { ...base, agreement: { ...preview.offer, see: { ...preview.offer.see, meds: 'adherence' }, assign: { ...preview.offer.assign, meds: false }, editHers: { ...preview.offer.editHers, meds: false } } },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const set = ok.cookies.find((c) => c.name === PERSON_COOKIE);
    expect(set).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(set?.domain).toBeUndefined();
  });

  it("invites are the Mac's; Copy link again needs an admin device", async () => {
    const x = await fx();
    const { id } = await freshInvite(x, 'Lu');
    expect((await him(x, 'POST', `/v1/people/${id}/invite`, x.owner.admin)).statusCode).toBe(403);
    expect((await him(x, 'POST', '/v1/people', x.owner.admin, { name: 'Mo' })).statusCode).toBe(403);
    expect((await him(x, 'GET', `/v1/people/${id}/invite`, x.owner.control)).statusCode).toBe(403);
    const again = await him(x, 'GET', `/v1/people/${id}/invite`, x.owner.admin);
    expect(again.statusCode).toBe(200);
    expect((again.json() as { url: string }).url).toMatch(/^https:\/\/us\.test\/p\/join#c=/);
  });

  it('PEOPLE_MAX holds (1 in this build)', async () => {
    const x = await fx();
    setPeopleMaxForTests(undefined);
    const r = await ctl(x, 'POST', '/v1/people', { name: 'Nia' });
    expect(r.statusCode).toBe(409);
  });

  it('link codes: 5 minutes, once, at most 5 devices', async () => {
    const x = await fx();
    const code = (await onHer(x.api, 'POST', '/v1/p/devices/link', x.asha.full)).json() as { code: string };
    x.api.ctx.clock.advance(5 * 60_000 + 1);
    expect((await onHer(x.api, 'POST', '/v1/p/devices/link/claim', NONE, { code: code.code, deviceName: 'late' })).statusCode).toBe(400);
    for (let i = 0; i < 4; i++) await linkDevice(x.api, x.asha, `d${i}`);
    const full = await onHer(x.api, 'POST', '/v1/p/devices/link', x.asha.full);
    expect(full.statusCode).toBe(409);
  });
});

describe('the agreement', () => {
  it("this owner's offer: Everything with food off, clamped to P1", async () => {
    const x = await fx();
    const me = (await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json() as PersonMe;
    expect(me.agreement).toEqual({
      version: expect.any(Number),
      see: { todos: true, meds: 'full', weight: true, food: false, plan: false, review: 'off', sleep: false, journal: false, chat: false },
      assign: { todos: true, meds: true, plan: false },
      editHers: { todos: true, meds: true, weight: true, plan: false },
      comment: { journal: false },
      assistant: false,
    });
  });

  it('narrowing only lowers, takes what depends on it, and applies before the next read', async () => {
    const x = await fx();
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { food: true } })).statusCode).toBe(400);
    const steps: [object, (a: NonNullable<PersonView['agreement']>) => void][] = [
      [{ see: { meds: 'adherence' } }, (a) => expect([a.see.meds, a.assign.meds, a.editHers.meds]).toEqual(['adherence', false, false])],
      [{ see: { meds: 'off' } }, (a) => expect(a.see.meds).toBe('off')],
      [{ editHers: { todos: false } }, (a) => expect([a.see.todos, a.assign.todos, a.editHers.todos]).toEqual([true, true, false])],
      [{ see: { weight: false } }, (a) => expect([a.see.weight, a.editHers.weight]).toEqual([false, false])],
      [{ see: { todos: false } }, (a) => expect([a.see.todos, a.assign.todos]).toEqual([false, false])],
    ];
    for (const [patch, check] of steps) {
      expect((await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, patch)).statusCode).toBe(200);
      const view = (await him(x, 'GET', `/v1/people/${x.asha.id}`, x.owner.control)).json() as { person: PersonView };
      if (!view.person.agreement) throw new Error('no agreement');
      check(view.person.agreement);
    }
    // Back up is never hers to do alone: a widening is a 400, and nothing changes.
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { meds: 'adherence' } })).statusCode).toBe(400);
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { plan: true } })).statusCode).toBe(400);
  });

  it('one proposal at a time; a decline cools for 7 days; "Don\'t ask again" holds; the ledger keeps no note', async () => {
    const x = await fx();
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { weight: false } });
    const p1 = await him(x, 'POST', `/v1/people/${x.asha.id}/agreement`, x.owner.admin, { see: { weight: true }, note: 'NOTE-CANARY' });
    expect(p1.statusCode, p1.body).toBe(200);
    expect((await him(x, 'POST', `/v1/people/${x.asha.id}/agreement`, x.owner.admin, { editHers: { weight: true } })).statusCode).toBe(409);
    expect((await him(x, 'POST', `/v1/people/${x.asha.id}/agreement`, x.owner.control, { see: { weight: true } })).statusCode).toBe(403);
    const me = (await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json() as PersonMe;
    expect(me.pending?.note).toBe('NOTE-CANARY');
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/decline', x.asha.full, { version: me.pending?.version })).statusCode).toBe(200);
    const cooling = await him(x, 'POST', `/v1/people/${x.asha.id}/agreement`, x.owner.admin, { see: { weight: true } });
    expect(cooling.statusCode).toBe(409);
    expect(cooling.json().error.message).toMatch(/can be asked again from \d{4}-\d{2}-\d{2}/);
    x.api.ctx.clock.advance(7 * 24 * 3600_000 + 1);
    const p2 = await him(x, 'POST', `/v1/people/${x.asha.id}/agreement`, x.owner.admin, { see: { weight: true } });
    expect(p2.statusCode).toBe(200);
    const v2 = ((await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json() as PersonMe).pending?.version;
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/decline', x.asha.full, { version: v2, dontAsk: true })).statusCode).toBe(200);
    x.api.ctx.clock.advance(8 * 24 * 3600_000);
    expect((await him(x, 'POST', `/v1/people/${x.asha.id}/agreement`, x.owner.admin, { see: { weight: true } })).json().error.message).toMatch(/Don't ask/);
    for (const row of x.api.ctx.db.people.consents.listFor(x.asha.id)) expect(JSON.stringify(row.json)).not.toContain('NOTE-CANARY');
  });
});

describe('her exits (T21, C12)', () => {
  it('People switched off: her exits work, everything else of hers and of his is 404', async () => {
    const x = await fx();
    expect((await ctl(x, 'POST', '/v1/people/switch', { on: false })).statusCode).toBe(200);
    expect((await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json().peopleOn).toBe(false);
    expect((await onHer(x.api, 'GET', '/v1/p/activity', x.asha.full)).statusCode).toBe(200);
    expect((await onHer(x.api, 'GET', '/v1/p/export', x.asha.full)).statusCode).toBe(200);
    expect((await onHer(x.api, 'PATCH', '/v1/p/prefs', x.asha.full, { lockScreen: 'all' })).statusCode).toBe(404);
    for (const url of ['/v1/people', `/v1/people/${x.asha.id}`, `/v1/people/${x.asha.id}/activity`, `/v1/people/${x.asha.id}/devices`]) {
      expect((await him(x, 'GET', url, x.owner.admin)).statusCode, url).toBe(404);
    }
    expect((await onHer(x.api, 'POST', '/v1/p/pause', x.asha.full, {})).statusCode).toBe(200);
    expect((await onHer(x.api, 'POST', '/v1/p/leave', x.asha.full, { data: 'keep30', confirm: 'LEAVE' })).statusCode).toBe(200);
    expect(x.api.ctx.db.people.devices.listFor(x.asha.id).every((d) => d.revokedAt !== null)).toBe(true);
    expect(x.api.ctx.db.people.consents.latestFor(x.asha.id)?.action).toBe('left');
  });

  it('--read-only: her exits and her Life writes are not refused', async () => {
    const x = await fx({ api: { mode: { readOnly: true, terminal: 'terminal-app' } } });
    expect((await onHer(x.api, 'POST', '/v1/p/pause', x.asha.full, {})).statusCode).toBe(200);
    expect((await onHer(x.api, 'POST', '/v1/p/resume', x.asha.full, {})).statusCode).toBe(200);
    expect((await onHer(x.api, 'GET', '/v1/p/export?format=json', x.asha.full)).statusCode).toBe(200);
    expect((await onHer(x.api, 'POST', '/v1/p/leave', x.asha.full, { data: 'keep30', confirm: 'LEAVE' })).statusCode).toBe(200);
  });

  it('life.db broken: Leave and Pause work on jantar.db alone, Me works, Export says it cannot read, the rest 503', async () => {
    const x = await fx();
    await x.life.stop();
    writeFileSync(x.api.ctx.paths.lifeDb, 'this is not a database, deliberately');
    await x.life.start();
    expect(x.life.broken()).not.toBeNull();
    expect((await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json().lifeBroken).toBe(true);
    const exp = await onHer(x.api, 'GET', '/v1/p/export', x.asha.full);
    expect(exp.statusCode).toBe(503);
    expect(exp.json().error.message).toBe("Your data can't be read right now. Leaving still works, and your data will be deleted on schedule.");
    expect((await onHer(x.api, 'PATCH', '/v1/p/prefs', x.asha.full, { lockScreen: 'all' })).statusCode).toBe(503);
    expect((await onHer(x.api, 'POST', '/v1/p/pause', x.asha.full, {})).statusCode).toBe(200);
    expect((await onHer(x.api, 'POST', '/v1/p/leave', x.asha.full, { data: 'delete', confirm: 'LEAVE' })).statusCode).toBe(200);
    expect(x.api.ctx.db.people.devices.listFor(x.asha.id).every((d) => d.revokedAt !== null)).toBe(true);
    expect(x.api.ctx.db.people.consents.listFor(x.asha.id).map((r) => r.action).slice(-3)).toEqual(['paused', 'left', 'forgotten']);
  });
});

describe('states', () => {
  it('ending: her exits only, nothing for him; at the end of the window she has left', async () => {
    const x = await fx();
    expect((await onHer(x.api, 'GET', '/v1/p/me', x.dev.full)).json().person.state).toBe('ending');
    expect((await onHer(x.api, 'GET', '/v1/p/export', x.dev.full)).statusCode).toBe(200);
    expect((await onHer(x.api, 'PATCH', '/v1/p/prefs', x.dev.full, { lockScreen: 'all' })).statusCode).toBe(404);
    expect((await him(x, 'GET', `/v1/people/${x.dev.id}`, x.owner.control)).statusCode).toBe(404);
    expect((await onHer(x.api, 'POST', '/v1/p/devices/link', x.dev.full)).statusCode).toBe(404);
    x.api.ctx.clock.advance(7 * 24 * 3600_000 + 1);
    expect((await onHer(x.api, 'GET', '/v1/p/me', x.dev.full)).statusCode).toBe(404);
    expect((await onHer(x.api, 'GET', '/v1/p/me', x.dev.full)).statusCode).toBe(401);
  });

  it('paused: he still reads (with view marks), she resumes; only she can', async () => {
    const x = await fx();
    expect((await him(x, 'GET', `/v1/people/${x.cara.id}`, x.owner.control)).json().person.state).toBe('paused');
    expect((await onHer(x.api, 'POST', '/v1/p/resume', x.cara.full, {})).statusCode).toBe(200);
    expect((await him(x, 'GET', `/v1/people/${x.cara.id}`, x.owner.control)).json().person.state).toBe('active');
  });

  it('forgotten stays forgotten: a person row put back (an old backup) is removed again by reconcile', async () => {
    const x = await fx();
    const core = x.life.people.openCore();
    if (!core) throw new Error('life closed');
    const at = x.api.ctx.clock.iso();
    core.db
      .prepare('INSERT INTO people (id, state, updated_at, json) VALUES (?, ?, ?, ?)')
      .run(x.fay.id, 'active', at, JSON.stringify({ id: x.fay.id, name: 'Fay', color: 'teal', state: 'active', sharedSpace: 's:01JZZZZZZZZZZZZZZZZZZZZZZZ', createdAt: at, updatedAt: at }));
    core.db.prepare("INSERT INTO todos (id, project_id, due_day, done_at, updated_at, json, space) VALUES ('01JZZZZZZZZZZZZZZZZZZZZZZY', NULL, NULL, NULL, ?, '{}', ?)").run(at, x.fay.id);
    x.life.people.reconcile();
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM people WHERE id = ?').get(x.fay.id)).toEqual({ n: 0 });
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM todos WHERE space = ?').get(x.fay.id)).toEqual({ n: 0 });
    expect((await onHer(x.api, 'GET', '/v1/p/me', x.fay.oldCookie)).statusCode).toBe(401);
  });

  it('an active person whose space a restore removed is told to set up again (401)', async () => {
    const x = await fx();
    const core = x.life.people.openCore();
    core?.db.prepare('DELETE FROM people WHERE id = ?').run(x.bea.id);
    const r = await onHer(x.api, 'GET', '/v1/p/me', x.bea.full);
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe('Sharing needs to be set up again. Ask for a new invite.');
  });
});

describe('T19: no owner-only record of her', () => {
  it('his audit rows for her writes are person.write with no target and no params; logs name her routes as /v1/p/*', async () => {
    const x = await fx();
    await onHer(x.api, 'PATCH', '/v1/p/prefs', x.asha.full, { lockScreen: 'all' });
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { weight: false } });
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { food: true } });
    const rows = x.api.ctx.db.audit.list({ limit: 1000 }).filter((r) => r.actor.startsWith(`person:${x.asha.id}`));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.action).toBe('person.write');
      expect(r.target).toBeUndefined();
      expect(r.params).toEqual({});
      if (r.detail !== undefined) expect(r.detail).toMatch(/^[a-z_]+$/);
    }
    x.api.ctx.log.records.length = 0;
    await onHer(x.api, 'GET', '/v1/p/activity', x.asha.full);
    await onHer(x.api, 'PATCH', '/v1/p/prefs', x.asha.full, { lockScreen: 'hide_all' });
    const routes = x.api.ctx.log.records.filter((r) => r.msg === 'request').map((r) => r.fields?.['route']);
    expect(routes).toEqual(['/v1/p/*', '/v1/p/*']);
  });

  it('his device list of hers never carries last-seen, a user agent or an address (C20)', async () => {
    const x = await fx();
    const r = (await him(x, 'GET', `/v1/people/${x.asha.id}/devices`, x.owner.control)).json() as { devices: object[] };
    for (const d of r.devices) expect(Object.keys(d).sort()).toEqual(expect.arrayContaining(['createdAt', 'id', 'name']));
    expect(JSON.stringify(r)).not.toMatch(/lastSeen|userAgent|user_agent|\d+\.\d+\.\d+\.\d+/);
    const list = JSON.stringify((await him(x, 'GET', '/v1/people', x.owner.control)).json());
    expect(list).not.toMatch(/lastSeen|userAgent/);
  });
});

it('joinPerson works for a fresh partner end to end (fixture self-check)', async () => {
  const x = await fx();
  const p = await joinPerson(x.api, 'Ola', { preset: 'light' });
  const me = (await onHer(x.api, 'GET', '/v1/p/me', p.full)).json() as PersonMe;
  expect(me.person.name).toBe('Ola');
  expect(me.agreement?.see.meds).toBe('off');
});

describe('the daily sweep', () => {
  it('forgets a left space after its 30 days, not before; closes an ending window', async () => {
    const x = await fx();
    const core = x.life.people.openCore();
    if (!core) throw new Error('life closed');
    await onHer(x.api, 'POST', '/v1/p/todos', x.asha.full, { title: 'Keep me a while' });
    expect((await onHer(x.api, 'POST', '/v1/p/leave', x.asha.full, { data: 'keep30', confirm: 'LEAVE' })).statusCode).toBe(200);
    x.api.ctx.clock.advance(29 * 24 * 3600_000);
    x.life.people.sweep();
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM todos WHERE space = ?').get(x.asha.id)).toEqual({ n: 1 });
    x.api.ctx.clock.advance(2 * 24 * 3600_000);
    x.life.people.sweep();
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM todos WHERE space = ?').get(x.asha.id)).toEqual({ n: 0 });
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM people WHERE id = ?').get(x.asha.id)).toEqual({ n: 0 });
    expect(x.api.ctx.db.people.consents.latestFor(x.asha.id)?.action).toBe('forgotten');
    // Dev's ending window (7 days) closed along the way: his devices are revoked and he has left.
    expect(x.api.ctx.db.people.devices.listFor(x.dev.id).every((d) => d.revokedAt !== null)).toBe(true);
  });
});
