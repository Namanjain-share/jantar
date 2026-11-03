/**
 * v0.11 People (P1): invites, the agreement, her states and her exits.
 *
 * - Invites (spec 2.3, 2.4, D9, C14, C37): preview spends nothing; a join
 *   spends the code once (a race yields one device); 24 h; wrong, spent and
 *   expired codes answer one sentence; a widened body or another Access
 *   email spends nothing; invites are the Mac's; "Copy link again" needs an
 *   admin device; link codes last 5 minutes, work once, stop at 5 devices.
 * - The agreement (M19): this owner's offer is Everything with food on,
 *   clamped to what P1 builds; narrowing only lowers and applies before the
 *   next read; one proposal at a time, a 7-day cooling-off after a decline,
 *   "Don't ask again"; the ledger holds no free text.
 * - Exits (T21, C12): Me, Pause, Leave, Export and Activity work while
 *   People is off, in --read-only and (Leave, Pause, Me) while life.db is
 *   broken; with People off, every /v1/people/* is 404 on TCP.
 * - States: ending reaches her exits only and turns into left at the end
 *   of the window; forget deletes her row and stays forgotten (reconcile);
 *   a space a restore took out is "set up again" for her and a note on his
 *   People list (T20), which remove clears.
 * - No owner-only record of her (T19, C8): his audit rows for her writes
 *   are `person.write` with no target and no params.
 */
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PERSON_COOKIE, type JoinPreview, type PeopleList, type PersonMe, type PersonView } from '@jantar/protocol/people';
import { setPeopleMaxForTests } from '../../src/life/people/module.js';
import { LOOPBACK_HOST, LOOPBACK_ORIGIN, NONE, OWNER_HOST, OWNER_ORIGIN, credHeaders, joinPerson, linkDevice, makeFixture, onHer, resetLimiters, type Fixture } from './isolation-fixture.js';

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
    // Standard by default: the plan and review counts, but no sleep, journal or chat (each offered, off in Standard).
    expect(preview.offer.see).toMatchObject({ todos: true, meds: 'full', weight: true, plan: true, review: 'counts', sleep: false, journal: false, chat: false });
    expect(preview.fields).toContain('see.journal');
    // P3 builds her chat; his assistant reading her space (`assistant`) is not built in this release, so it's never offered.
    expect(preview.fields).toContain('see.chat');
    expect(preview.fields).not.toContain('assistant');
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
    const widened = { ...base, agreement: { ...preview.offer, see: { ...preview.offer.see, sleep: true } } };
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

  it('review 5, B3: a name or device name with a control character is a 400 that spends nothing (his terminal prints them)', async () => {
    const x = await fx();
    const { id, code } = await freshInvite(x, 'Kia');
    const preview = (await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code })).json() as JoinPreview;
    const base = { code, acceptedVersion: preview.version, agreement: preview.offer, adult: true, name: 'Kia', deviceName: 'Kia phone' };
    for (const bad of [{ name: 'Kia\u001b]0;Jantar: all clear\u0007\u001b[2J' }, { name: 'Kia\u202e' }, { deviceName: 'phone\u001b[8m' }, { deviceName: 'phone\nline' }]) {
      const r = await onHer(x.api, 'POST', '/v1/p/join', NONE, { ...base, ...bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await ctl(x, 'POST', '/v1/people', { name: 'Esc\u001b[31m' })).statusCode).toBe(400);
    const ok = await onHer(x.api, 'POST', '/v1/p/join', NONE, base);
    expect(ok.statusCode, ok.body).toBe(200);
    const kia = { name: 'kia', cookie: `${PERSON_COOKIE}=${ok.cookies.find((c) => c.name === PERSON_COOKIE)?.value}`, secret: (ok.json() as { deviceSecret: string }).deviceSecret };
    const link = (await onHer(x.api, 'POST', '/v1/p/devices/link', kia)).json() as { code: string };
    const badClaim = await onHer(x.api, 'POST', '/v1/p/devices/link/claim', NONE, { code: link.code, deviceName: 'tab\u0007let' });
    expect([badClaim.statusCode, badClaim.json().error.code]).toEqual([400, 'invalid_request']);
    // The refused name spent nothing: the same code links her tablet under a plain name.
    expect((await onHer(x.api, 'POST', '/v1/p/devices/link/claim', NONE, { code: link.code, deviceName: 'tablet' })).statusCode).toBe(200);
    const people = ((await ctl(x, 'GET', '/v1/people')).json() as PeopleList).people;
    expect(people.find((p) => p.id === id)?.name).toBe('Kia');
  });

  it("invites are the Mac's; Copy link again needs an admin device with its secret, and is audited (C14)", async () => {
    const x = await fx();
    const { id } = await freshInvite(x, 'Lu');
    expect((await him(x, 'POST', `/v1/people/${id}/invite`, x.owner.admin)).statusCode).toBe(403);
    expect((await him(x, 'POST', '/v1/people', x.owner.admin, { name: 'Mo' })).statusCode).toBe(403);
    expect((await him(x, 'POST', `/v1/people/${id}/invite/again`, x.owner.control)).statusCode).toBe(403);
    // A read can't lift it: there is no GET.
    expect((await him(x, 'GET', `/v1/people/${id}/invite`, x.owner.admin)).statusCode).toBe(404);
    // The admin cookie alone (no device secret) where the cookie isn't bound to his https host: refused, like every admin write (SEC-2).
    resetLimiters(x.api);
    const bare = await x.api.tcp.inject({ method: 'POST', url: `/v1/people/${id}/invite/again`, headers: { host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN, ...credHeaders(x.owner.cookieOnly) } });
    expect(bare.statusCode).toBe(401);
    expect(bare.body).not.toContain('#c=');
    const before = x.api.ctx.db.audit.list({ limit: 1000 }).filter((r) => r.action === 'personInviteLink').length;
    const again = await him(x, 'POST', `/v1/people/${id}/invite/again`, x.owner.admin);
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as { url: string }).url).toMatch(/^https:\/\/us\.test\/p\/join#c=/);
    const rows = x.api.ctx.db.audit.list({ limit: 1000 }).filter((r) => r.action === 'personInviteLink');
    expect(rows.length).toBe(before + 1);
    expect(rows.find((r) => r.result === 'ok')).toMatchObject({ target: id });
    expect(JSON.stringify(rows)).not.toContain('#c=');
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

  it('M4: revoking a device voids the link codes it minted (the one invalid answer)', async () => {
    const x = await fx();
    const stolen = await linkDevice(x.api, x.asha, 'Stolen phone');
    const minted = await onHer(x.api, 'POST', '/v1/p/devices/link', stolen.cred);
    expect(minted.statusCode).toBe(200);
    const code = (minted.json() as { code: string }).code;
    // A code her own phone minted stays good.
    const mine = (await onHer(x.api, 'POST', '/v1/p/devices/link', x.asha.full)).json() as { code: string };
    expect((await onHer(x.api, 'DELETE', `/v1/p/devices/${stolen.deviceId}`, x.asha.full)).statusCode).toBe(200);
    const bogus = await onHer(x.api, 'POST', '/v1/p/devices/link/claim', NONE, { code: 'A'.repeat(code.length), deviceName: 'x' });
    resetLimiters(x.api);
    const claim = await onHer(x.api, 'POST', '/v1/p/devices/link/claim', NONE, { code, deviceName: 'Thief' });
    expect([claim.statusCode, claim.json()]).toEqual([bogus.statusCode, bogus.json()]);
    expect(claim.cookies.find((c) => c.name === PERSON_COOKIE)).toBeUndefined();
    // His revoke (an admin device, C18) voids them too.
    const other = await linkDevice(x.api, x.asha, 'Old tablet');
    const code2 = ((await onHer(x.api, 'POST', '/v1/p/devices/link', other.cred)).json() as { code: string }).code;
    expect((await him(x, 'DELETE', `/v1/people/${x.asha.id}/devices/${other.deviceId}`, x.owner.admin)).statusCode).toBe(200);
    resetLimiters(x.api);
    expect((await onHer(x.api, 'POST', '/v1/p/devices/link/claim', NONE, { code: code2, deviceName: 'Thief 2' })).statusCode).toBe(bogus.statusCode);
    resetLimiters(x.api);
    expect((await onHer(x.api, 'POST', '/v1/p/devices/link/claim', NONE, { code: mine.code, deviceName: 'Her laptop' })).statusCode).toBe(200);
  });
});

describe('the agreement', () => {
  it("this owner's offer: Everything with her food log on, clamped to the built phase (P3: chat on, assistant off)", async () => {
    const x = await fx();
    const me = (await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json() as PersonMe;
    expect(me.agreement).toEqual({
      version: expect.any(Number),
      see: { todos: true, meds: 'full', weight: true, food: 'full', plan: true, review: 'full', sleep: true, journal: true, chat: true },
      assign: { todos: true, meds: true, plan: true },
      editHers: { todos: true, meds: true, weight: true, plan: true },
      comment: { journal: true },
      assistant: false,
    });
  });

  it('narrowing only lowers, takes what depends on it, and applies before the next read', async () => {
    const x = await fx();
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { food: 'counts' } })).statusCode).toBe(200);
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { food: 'full' } })).statusCode).toBe(400);
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
    // Turning chat back on after narrowing it off is a widening: 400.
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { chat: false } })).statusCode).toBe(200);
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { chat: true } })).statusCode).toBe(400);
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

  it('a proposal made before she narrows asks only for what he widened: accepting it never re-opens what she closed', async () => {
    const x = await fx();
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { sleep: false } });
    expect((await him(x, 'POST', `/v1/people/${x.asha.id}/agreement`, x.owner.admin, { see: { sleep: true }, note: 'just sleep please' })).statusCode).toBe(200);
    // She switches her journal off while it waits.
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { journal: false } });
    const me = (await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json() as PersonMe;
    // The card shows her agreement as it is now, with only sleep raised.
    expect(me.pending?.fields.see).toMatchObject({ sleep: true, journal: false });
    expect((await onHer(x.api, 'POST', '/v1/p/agreement/accept', x.asha.full, { version: me.pending?.version })).statusCode).toBe(200);
    const after = ((await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json() as PersonMe).agreement;
    expect([after?.see.sleep, after?.see.journal]).toEqual([true, false]);
    expect((await him(x, 'GET', `/v1/people/${x.asha.id}/journal`, x.owner.control)).statusCode).toBe(404);
    // A narrowing after he asked carries into the card as well.
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { weight: false } });
    expect((await him(x, 'POST', `/v1/people/${x.asha.id}/agreement`, x.owner.admin, { see: { weight: true } })).statusCode).toBe(200);
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { plan: false } });
    expect(((await onHer(x.api, 'GET', '/v1/p/me', x.asha.full)).json() as PersonMe).pending?.fields.see).toMatchObject({ weight: true, plan: false });
  });
});

describe('her exits (T21, C12)', () => {
  it('People switched off: her exits work, everything else of hers and of his is 404', async () => {
    const x = await fx();
    // An invite and a device-link code made before the switch.
    const { code } = await freshInvite(x, 'Hal');
    const link = ((await onHer(x.api, 'POST', '/v1/p/devices/link', x.asha.full)).json() as { code: string }).code;
    expect((await ctl(x, 'POST', '/v1/people/switch', { on: false })).statusCode).toBe(200);
    // M4: no one new gets in while it is off: the join routes are 404 and spend nothing.
    const preview = await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code });
    expect(preview.statusCode).toBe(404);
    const join = await onHer(x.api, 'POST', '/v1/p/join', NONE, { code, acceptedVersion: 1, agreement: {}, adult: true, name: 'Hal', deviceName: 'Hal phone' });
    expect(join.statusCode).toBe(404);
    const claim = await onHer(x.api, 'POST', '/v1/p/devices/link/claim', NONE, { code: link, deviceName: 'Linked while off' });
    expect(claim.statusCode).toBe(404);
    expect(claim.cookies.find((c) => c.name === PERSON_COOKIE)).toBeUndefined();
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
    // Switched on again, the invite made before is still unspent.
    expect((await ctl(x, 'POST', '/v1/people/switch', { on: true })).statusCode).toBe(200);
    resetLimiters(x.api);
    expect((await onHer(x.api, 'POST', '/v1/p/join/preview', NONE, { code })).statusCode).toBe(200);
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
    // M8: his admin device can't revoke a device of hers in her window either (his list of them is 404 too).
    expect((await him(x, 'GET', `/v1/people/${x.dev.id}/devices`, x.owner.admin)).statusCode).toBe(404);
    expect((await him(x, 'DELETE', `/v1/people/${x.dev.id}/devices/${x.dev.deviceId}`, x.owner.admin)).statusCode).toBe(404);
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

  it('T20: his People list says whose space a restore removed (id only, no name); remove clears it at once, with no window', async () => {
    const x = await fx();
    const core = x.life.people.openCore();
    core?.db.prepare('DELETE FROM people WHERE id = ?').run(x.bea.id);
    const list = (await him(x, 'GET', '/v1/people', x.owner.control)).json() as PeopleList;
    expect(list.setupAgain).toEqual([{ id: x.bea.id }]);
    expect(list.people.map((p) => p.id)).not.toContain(x.bea.id);
    // Everything else of his about her is the unknown-pid answer (M8 has every write).
    const unknown = await him(x, 'GET', '/v1/people/01JZZZZZZZZZZZZZZZZZZZZZZZ', x.owner.control);
    const get = await him(x, 'GET', `/v1/people/${x.bea.id}`, x.owner.control);
    expect([get.statusCode, get.body]).toEqual([unknown.statusCode, unknown.body]);
    // The CLI's default is a window; a space with nothing in it to download has none.
    expect((await ctl(x, 'POST', `/v1/people/${x.bea.id}/remove`, { mode: 'window', forget: false })).statusCode).toBe(200);
    expect(x.life.people.gateState(x.bea.id)).toBe('gone');
    expect(((await him(x, 'GET', '/v1/people', x.owner.control)).json() as PeopleList).setupAgain).toBeUndefined();
    expect((await onHer(x.api, 'GET', '/v1/p/me', x.bea.full)).json().error.message).toBe('Open your invite link again.');
    // A pid that never was stays the unknown answer on remove too.
    expect((await ctl(x, 'POST', '/v1/people/01JZZZZZZZZZZZZZZZZZZZZZZZ/remove', { mode: 'now', forget: false })).statusCode).toBe(404);
  });
});

describe('T19: no owner-only record of her', () => {
  it('his audit rows for her writes are person.write with no target and no params; logs name her routes as /v1/p/*', async () => {
    const x = await fx();
    await onHer(x.api, 'PATCH', '/v1/p/prefs', x.asha.full, { lockScreen: 'all' });
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { weight: false } });
    await onHer(x.api, 'POST', '/v1/p/agreement/narrow', x.asha.full, { see: { food: 'counts' } });
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
