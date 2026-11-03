/**
 * v0.11 People: her food log (spec 3.5), as each side reads and writes it,
 * on the isolation fixture (Sam; Asha on Everything with her food log on and
 * shared in full; Bea on Standard with no food log).
 *
 * - Hers alone to write: log what she ate (calories optional), edit, delete,
 *   her own target; strict bodies refuse an author or a space; he has no
 *   food verb at all.
 * - Her food module (O6): off, every route of hers is the one "food log is
 *   off" 404, her Today has no food, his read and her mirror are 404 and his
 *   Today has no food tile; turning it on grants him nothing (D24); it can't
 *   go off while she has entries.
 * - M5 / isolation: her credential never reads or changes his food log or
 *   his targets, nor his hers; Bea's never reaches Asha's.
 * - His view at his level: full (items, calories, the week's totals, never
 *   when she logged one or her saved foods), counts (how many meals, naming
 *   nothing), off (404, a locked tile on Today). T10: her mirror deep-equals
 *   his view at each level. Each read of his is one view mark an hour; her
 *   own reads leave none. His Today and 21:00 summary carry the same level.
 * - T11: her export holds her food log and her targets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FoodDay } from '@jantar/protocol';
import { PERSON_COOKIE, type JoinPreview, type OwnerFoodView, type PersonActivityResponse, type PersonOwnToday, type PersonToday } from '@jantar/protocol/people';
import { DAY, NONE, OWNER_HOST, OWNER_ORIGIN, credHeaders, joinPerson, makeFixture, onHer, type Cred, type Fixture } from '../people/isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

const him = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object, cred: Cred = f.owner.control) =>
  f.api.tcp.inject({ method, url, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred) }, ...(payload ? { payload } : {}) });
const herCall = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object, who: Cred = f.asha.full) => onHer(f.api, method, url, who, payload);
const ctl = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => f.api.ctl.inject({ method, url, ...(payload ? { payload } : {}) });
const idOf = (r: { json(): unknown }) => (r.json() as { id: string }).id;
const herDay = async (who: Cred = f.asha.full) => (await herCall('GET', '/v1/p/food', undefined, who)).json() as FoodDay;
const views = async () => ((await herCall('GET', '/v1/p/activity')).json() as PersonActivityResponse).activity.filter((r) => r.action === 'view' && r.area === 'food');
const OFF = 'The food log is off in this space.';

describe('her food log', () => {
  it('she logs what she ate, calories optional; edits, deletes and sets her target; her day totals it', async () => {
    const a = await herCall('POST', '/v1/p/food', { day: DAY, name: 'Poha', kcal: 320 });
    expect(a.statusCode, a.body).toBe(201);
    const b = await herCall('POST', '/v1/p/food', { day: DAY, name: 'Green tea' });
    expect(b.statusCode, b.body).toBe(201);
    let d = await herDay();
    expect(d.entries.map((e) => [e.name, e.kcal])).toEqual([
      ['Poha', 320],
      ['Green tea', 0],
    ]);
    expect(d.kcal).toBe(320);
    expect((await herCall('PATCH', `/v1/p/food/${idOf(a)}`, { kcal: 350 })).statusCode).toBe(200);
    expect((await herCall('DELETE', `/v1/p/food/${idOf(b)}`)).statusCode).toBe(200);
    expect((await herCall('PUT', '/v1/p/food/targets', { kcalTarget: 1800, goalKg: 58 })).statusCode).toBe(200);
    d = await herDay();
    expect([d.kcal, d.target, d.weight.goalKg, d.entries.length]).toEqual([350, 1800, 58, 1]);
    // A saved food of hers is one tap.
    expect((await herCall('POST', '/v1/p/food', { day: DAY, name: 'Dal', kcal: 250, save: true })).statusCode).toBe(201);
    const saved = (await herDay()).saved.find((s) => s.name === 'Dal');
    expect((await herCall('POST', '/v1/p/food', { day: DAY, savedId: saved?.id })).statusCode).toBe(201);
    // Her Today carries the day's meals, calories and target for the quick add.
    const today = (await herCall('GET', '/v1/p/today')).json() as PersonOwnToday;
    expect(today.food).toEqual({ meals: 3, kcal: 850, target: 1800 });
  });

  it('bodies naming an author or a space are refused; he has no food verb', async () => {
    for (const extra of [{ by: '' }, { space: '' }, { person: 'x' }]) {
      expect((await herCall('POST', '/v1/p/food', { day: DAY, name: 'X', ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
    }
    const id = idOf(await herCall('POST', '/v1/p/food', { day: DAY, name: 'Toast', kcal: 150 }));
    for (const [method, url] of [
      ['POST', `/v1/people/${f.asha.id}/food`],
      ['PATCH', `/v1/people/${f.asha.id}/food/${id}`],
      ['DELETE', `/v1/people/${f.asha.id}/food/${id}`],
      ['PUT', `/v1/people/${f.asha.id}/food/targets`],
    ] as const) {
      expect((await him(method, url, method === 'DELETE' ? undefined : { name: 'x', kcal: 1, kcalTarget: 1000 }, f.owner.admin)).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await herDay()).entries.map((e) => e.name)).toEqual(['Toast']);
  });
});

describe('her food module (O6)', () => {
  it('off: every route of hers is the one 404, her Today has none, his read and her mirror are 404, his Today has no tile', async () => {
    const day = DAY;
    for (const [method, url, body] of [
      ['GET', '/v1/p/food', undefined],
      ['POST', '/v1/p/food', { day, name: 'Rice', kcal: 200 }],
      ['PATCH', '/v1/p/food/01JZZZZZZZZZZZZZZZZZZZZZZZ', { kcal: 1 }],
      ['DELETE', '/v1/p/food/01JZZZZZZZZZZZZZZZZZZZZZZZ', undefined],
      ['PUT', '/v1/p/food/targets', { kcalTarget: 1500 }],
    ] as const) {
      const r = await herCall(method, url, body, f.bea.full);
      expect(r.statusCode, `${method} ${url}`).toBe(404);
      expect(r.json().error.message).toBe(OFF);
    }
    expect(((await herCall('GET', '/v1/p/today', undefined, f.bea.full)).json() as PersonOwnToday).food).toBeNull();
    expect((await him('GET', `/v1/people/${f.bea.id}/food`)).statusCode).toBe(404);
    expect((await herCall('GET', '/v1/p/mirror/food', undefined, f.bea.full)).statusCode).toBe(404);
    expect(((await him('GET', `/v1/people/${f.bea.id}/today`)).json() as PersonToday).food).toBeNull();
    // Consent: Bea joined on Standard, which carries food in full, but with no food log the offer and what
    // she accepted both hold it off, so nothing of a food log is agreed before there is one.
    const bea = (await herCall('GET', '/v1/p/me', undefined, f.bea.full)).json() as { agreement: { see: { food: string } }; person: { modules: { food: boolean } } };
    expect([bea.person.modules.food, bea.agreement.see.food]).toEqual([false, 'off']);
  });

  it('on at the Mac: her log opens; he sees nothing until she accepts a request (D24); off is refused while she has entries', async () => {
    expect((await ctl('PATCH', `/v1/people/${f.bea.id}/modules`, { food: true })).statusCode).toBe(200);
    expect((await herCall('POST', '/v1/p/food', { day: DAY, name: 'Upma', kcal: 300 }, f.bea.full)).statusCode).toBe(201);
    expect((await him('GET', `/v1/people/${f.bea.id}/food`)).statusCode).toBe(404);
    expect(((await him('GET', `/v1/people/${f.bea.id}/today`)).json() as PersonToday).food).toEqual({ locked: true });
    expect((await herCall('GET', '/v1/p/mirror/food', undefined, f.bea.full)).json()).toEqual({ locked: true });
    const off = await ctl('PATCH', `/v1/people/${f.bea.id}/modules`, { food: false });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.message).toMatch(/food entries/);
    // His request for it waits for her yes; then he sees it at the level she accepted.
    expect((await him('POST', `/v1/people/${f.bea.id}/agreement`, { see: { food: 'counts' } }, f.owner.admin)).statusCode).toBe(200);
    expect((await him('GET', `/v1/people/${f.bea.id}/food`)).statusCode).toBe(404);
    const me = (await herCall('GET', '/v1/p/me', undefined, f.bea.full)).json() as { pending: { version: number } };
    expect((await herCall('POST', '/v1/p/agreement/accept', { version: me.pending.version }, f.bea.full)).statusCode).toBe(200);
    const v = (await him('GET', `/v1/people/${f.bea.id}/food`)).json() as OwnerFoodView;
    expect(v).toMatchObject({ level: 'counts', meals: 1 });
  });

  it('turning it off once she has deleted her entries takes see.food with it, in the ledger and her Activity', async () => {
    const id = idOf(await herCall('POST', '/v1/p/food', { day: DAY, name: 'Idli', kcal: 120 }));
    expect((await ctl('PATCH', `/v1/people/${f.asha.id}/modules`, { food: false })).statusCode).toBe(409);
    await herCall('DELETE', `/v1/p/food/${id}`);
    expect((await ctl('PATCH', `/v1/people/${f.asha.id}/modules`, { food: false })).statusCode).toBe(200);
    const me = (await herCall('GET', '/v1/p/me')).json() as { agreement: { see: { food: string } }; person: { modules: { food: boolean } } };
    expect([me.agreement.see.food, me.person.modules.food]).toEqual(['off', false]);
    const act = ((await herCall('GET', '/v1/p/activity')).json() as PersonActivityResponse).activity;
    expect(act.find((r) => r.action === 'module.changed')).toMatchObject({ actor: 'owner', fields: ['food=off'] });
    expect((await herCall('GET', '/v1/p/food')).statusCode).toBe(404);
  });
});

describe('review 5, B1: no food level is agreed that her page showed as "not part of your space"', () => {
  const joinAs = async (name: string, pid: string, agreement?: (offer: JoinPreview['offer']) => Promise<JoinPreview['offer']>) => {
    const { url } = (await ctl('POST', `/v1/people/${pid}/invite`)).json() as { url: string };
    const code = url.split('#c=')[1] as string;
    const p = (await onHer(f.api, 'POST', '/v1/p/join/preview', NONE, { code })).json() as JoinPreview;
    const r = await onHer(f.api, 'POST', '/v1/p/join', NONE, { code, acceptedVersion: p.version, agreement: agreement ? await agreement(p.offer) : p.offer, adult: true, name, deviceName: `${name} phone` });
    const set = r.cookies.find((c) => c.name === PERSON_COOKIE);
    const cred: Cred = { name, cookie: `${PERSON_COOKIE}=${set?.value}`, secret: r.statusCode === 200 ? (r.json() as { deviceSecret: string }).deviceSecret : '' };
    return { preview: p, status: r.statusCode, body: r.body, cred };
  };
  const agreed = async (who: Cred) => ((await herCall('GET', '/v1/p/me', undefined, who)).json() as { agreement: { see: Record<string, unknown> }; pending: { version: number; fields: { see: Record<string, unknown> } } | null });

  it('the food log off between his offer and the invite: her page and what she agrees to both hold food off; food on later grants nothing', async () => {
    const pid = idOf(await ctl('POST', '/v1/people', { name: 'Hana', email: 'hana@example.com', modules: { food: true } }));
    expect(((await ctl('POST', `/v1/people/${pid}/offer`, { preset: 'standard' })).json() as { fields: { see: { food: string } } }).fields.see.food).toBe('full');
    expect((await ctl('PATCH', `/v1/people/${pid}/modules`, { food: false })).statusCode).toBe(200);
    // His screens and the doctor read the offer as she would get it.
    const list = (await ctl('GET', '/v1/people')).json() as { people: { id: string; offer: { see: { food: string } } | null }[] };
    expect(list.people.find((x) => x.id === pid)?.offer?.see.food).toBe('off');
    const hana = await joinAs('Hana', pid);
    expect([hana.preview.modules.food, hana.preview.offer.see.food]).toEqual([false, 'off']);
    expect(hana.status, hana.body).toBe(200);
    expect((await agreed(hana.cred)).agreement.see.food).toBe('off');
    const doctor = ((await ctl('GET', '/v1/people/doctor')).json() as { checks: { name: string; ok: boolean; detail: string }[] }).checks;
    expect(doctor.find((c) => c.name === 'food log (Hana)')).toEqual({ name: 'food log (Hana)', ok: true, detail: 'off (to turn it on: jantar people modules Hana --food on)' });
    expect((await ctl('PATCH', `/v1/people/${pid}/modules`, { food: true })).statusCode).toBe(200);
    expect((await herCall('POST', '/v1/p/food', { day: DAY, name: 'Private meal', kcal: 640 }, hana.cred)).statusCode).toBe(201);
    expect((await him('GET', `/v1/people/${pid}/food`)).statusCode).toBe(404);
    expect((await agreed(hana.cred)).agreement.see.food).toBe('off');
  });

  it('a page loaded while the food log was on, sent after it went off: she joins, with food off', async () => {
    const pid = idOf(await ctl('POST', '/v1/people', { name: 'Hana', email: 'hana@example.com', modules: { food: true } }));
    const hana = await joinAs('Hana', pid, async (offer) => {
      // Her page showed food in full (the module was on); he turns it off before she taps Join.
      expect(offer.see.food).toBe('full');
      expect((await ctl('PATCH', `/v1/people/${pid}/modules`, { food: false })).statusCode).toBe(200);
      return offer;
    });
    expect(hana.status, hana.body).toBe(200);
    expect((await agreed(hana.cred)).agreement.see.food).toBe('off');
  });

  it("his ask for food, then the food log off: the ask loses food (and goes when that was all of it); her Allow can't agree to it", async () => {
    const ivy = await joinPerson(f.api, 'Ivy', { food: true, offer: { see: { food: 'off', sleep: false } } });
    expect((await him('POST', `/v1/people/${ivy.id}/agreement`, { see: { food: 'full' } }, f.owner.admin)).statusCode).toBe(200);
    expect((await agreed(ivy.full)).pending?.fields.see.food).toBe('full');
    expect((await ctl('PATCH', `/v1/people/${ivy.id}/modules`, { food: false })).statusCode).toBe(200);
    // Food was all he asked: nothing is left for her to answer, on her screen or his.
    expect((await agreed(ivy.full)).pending).toBeNull();
    const list = (await ctl('GET', '/v1/people')).json() as { people: { id: string; pendingProposal: unknown }[] };
    expect(list.people.find((x) => x.id === ivy.id)?.pendingProposal).toBeNull();
    expect((await herCall('POST', '/v1/p/agreement/accept', { version: 999 }, ivy.full)).statusCode).toBe(409);
    // An ask for food and sleep keeps sleep; her Allow gives sleep and never food.
    expect((await ctl('PATCH', `/v1/people/${ivy.id}/modules`, { food: true })).statusCode).toBe(200);
    expect((await him('POST', `/v1/people/${ivy.id}/agreement`, { see: { food: 'full', sleep: true } }, f.owner.admin)).statusCode).toBe(200);
    expect((await ctl('PATCH', `/v1/people/${ivy.id}/modules`, { food: false })).statusCode).toBe(200);
    const me = await agreed(ivy.full);
    expect([me.pending?.fields.see.food, me.pending?.fields.see.sleep]).toEqual(['off', true]);
    expect((await herCall('POST', '/v1/p/agreement/accept', { version: me.pending?.version }, ivy.full)).statusCode).toBe(200);
    expect((await ctl('PATCH', `/v1/people/${ivy.id}/modules`, { food: true })).statusCode).toBe(200);
    expect((await herCall('POST', '/v1/p/food', { day: DAY, name: 'Ivy lunch', kcal: 500 }, ivy.full)).statusCode).toBe(201);
    expect((await him('GET', `/v1/people/${ivy.id}/food`)).statusCode).toBe(404);
    expect((await agreed(ivy.full)).agreement.see).toMatchObject({ food: 'off', sleep: true });
  });

  it('a food level stored beside no food log (an older ledger): the doctor says to put it off, and food on puts it off first', async () => {
    // Bea has no food log; write the row an older build could have left: her agreement with food in full.
    const { version: _v, ...me } = (await agreed(f.bea.full)).agreement as { version: number; see: Record<string, unknown> };
    const rows = f.api.ctx.db.people.consents.listFor(f.bea.id);
    const version = Math.max(...rows.map((r) => r.version)) + 1;
    f.api.ctx.db.people.consents.append({ personId: f.bea.id, version, action: 'narrowed', by: 'test', at: '2026-11-03T09:00:00.000Z', json: { agreement: { ...me, see: { ...me.see, food: 'full' } } } as never });
    const doctor = ((await ctl('GET', '/v1/people/doctor')).json() as { checks: { name: string; ok: boolean; detail: string }[] }).checks;
    expect(doctor.find((c) => c.name === 'food log (Bea)')).toEqual({ name: 'food log (Bea)', ok: false, detail: 'off, yet see.food is full: jantar people modules Bea --food off puts it off' });
    expect((await ctl('PATCH', `/v1/people/${f.bea.id}/modules`, { food: true })).statusCode).toBe(200);
    expect((await agreed(f.bea.full)).agreement.see.food).toBe('off');
    expect((await herCall('POST', '/v1/p/food', { day: DAY, name: 'Upma', kcal: 300 }, f.bea.full)).statusCode).toBe(201);
    expect((await him('GET', `/v1/people/${f.bea.id}/food`)).statusCode).toBe(404);
  });
});

describe('M5: isolation both ways', () => {
  it("her credential never reads or changes his food log or targets; his never lists hers", async () => {
    const his = await him('POST', '/v1/food', { day: DAY, name: 'Sam lunch', kcal: 700 });
    expect(his.statusCode, his.body).toBe(200);
    await him('PUT', '/v1/food/targets', { kcalTarget: 2400 });
    const hers = idOf(await herCall('POST', '/v1/p/food', { day: DAY, name: 'Asha lunch', kcal: 500 }));
    await herCall('PUT', '/v1/p/food/targets', { kcalTarget: 1700, goalKg: 55 });
    const mine = (await him('GET', `/v1/food?day=${DAY}`)).json() as FoodDay;
    expect(mine.entries.map((e) => e.name)).toEqual(['Sam lunch']);
    expect([mine.kcal, mine.target, mine.weight.goalKg]).toEqual([700, 2400, null]);
    const d = await herDay();
    expect(d.entries.map((e) => e.name)).toEqual(['Asha lunch']);
    expect([d.kcal, d.target]).toEqual([500, 1700]);
    // An id of his is no id of hers, and the other way round.
    expect((await herCall('PATCH', `/v1/p/food/${idOf(his)}`, { kcal: 1 })).statusCode).toBe(404);
    expect((await herCall('DELETE', `/v1/p/food/${idOf(his)}`)).statusCode).toBe(404);
    expect((await him('PATCH', `/v1/food/${hers}`, { kcal: 1 })).statusCode).toBe(404);
    expect((await him('DELETE', `/v1/food/${hers}`)).statusCode).toBe(404);
    expect(((await him('GET', `/v1/food?day=${DAY}`)).json() as FoodDay).entries).toHaveLength(1);
    // Her targets are her own meta keys.
    const core = f.life.people.openCore();
    expect([core?.db.meta('kcal_target'), core?.db.meta(`kcal_target:${f.asha.id}`), core?.db.meta(`goal_kg10:${f.asha.id}`)]).toEqual(['2400', '1700', '550']);
  });

  it("Bea's credential never reaches Asha's food log; Asha's routes on his host are 404", async () => {
    await ctl('PATCH', `/v1/people/${f.bea.id}/modules`, { food: true });
    const id = idOf(await herCall('POST', '/v1/p/food', { day: DAY, name: 'Private', kcal: 10 }));
    expect((await herDay(f.bea.full)).entries).toEqual([]);
    expect((await herCall('PATCH', `/v1/p/food/${id}`, { name: 'x' }, f.bea.full)).statusCode).toBe(404);
    expect((await herCall('DELETE', `/v1/p/food/${id}`, undefined, f.bea.full)).statusCode).toBe(404);
    expect((await him('GET', '/v1/p/food', undefined, f.owner.admin)).statusCode).toBe(404);
  });
});

describe('his view at his level, and her mirror of it (T10)', () => {
  const seed = async () => {
    await herCall('PUT', '/v1/p/food/targets', { kcalTarget: 1800 });
    await herCall('POST', '/v1/p/food', { day: '2026-11-01', name: 'Paratha', kcal: 400 });
    await herCall('POST', '/v1/p/food', { day: DAY, name: 'Poha', kcal: 320 });
    await herCall('POST', '/v1/p/food', { day: DAY, name: 'Salad' });
    await herCall('POST', '/v1/p/food', { day: DAY, name: 'Dal', kcal: 250, save: true });
  };

  it('full: what she ate with its calories and the week, never when or her saved foods; one view mark an hour', async () => {
    await seed();
    const r = await him('GET', `/v1/people/${f.asha.id}/food`);
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json() as OwnerFoodView;
    expect(v).toMatchObject({ level: 'full', day: DAY, today: DAY, target: 1800, kcal: 570 });
    if (v.level !== 'full') throw new Error('full');
    expect(v.items.map((i) => [i.name, i.kcal])).toEqual([
      ['Poha', 320],
      ['Salad', 0],
      ['Dal', 250],
    ]);
    expect(v.days).toHaveLength(7);
    expect(v.days[0]).toEqual({ day: DAY, meals: 3, kcal: 570 });
    expect(v.days[2]).toEqual({ day: '2026-11-01', meals: 1, kcal: 400 });
    expect(r.body).not.toMatch(/"at"|createdAt|updatedAt|saved|weight/);
    // Another day, by ?day=.
    expect(((await him('GET', `/v1/people/${f.asha.id}/food?day=2026-11-01`)).json() as OwnerFoodView).day).toBe('2026-11-01');
    expect(await views()).toHaveLength(1);
    // Her mirror: the same, deep-equal, and no mark.
    expect((await herCall('GET', '/v1/p/mirror/food')).json()).toEqual(v);
    await herDay();
    expect(await views()).toHaveLength(1);
    f.api.ctx.clock.advance(3600_000);
    await him('GET', `/v1/people/${f.asha.id}/food`);
    expect(await views()).toHaveLength(2);
  });

  it('counts: how many meals, today and each day of the week, naming nothing; her narrowing applies at once', async () => {
    await seed();
    expect((await herCall('POST', '/v1/p/agreement/narrow', { see: { food: 'counts' } })).statusCode).toBe(200);
    const r = await him('GET', `/v1/people/${f.asha.id}/food`);
    const v = r.json() as OwnerFoodView;
    expect(v).toMatchObject({ level: 'counts', day: DAY, meals: 3 });
    if (v.level !== 'counts') throw new Error('counts');
    expect(v.days.map((x) => x.meals)).toEqual([3, 0, 1, 0, 0, 0, 0]);
    expect(r.body).not.toMatch(/Poha|Salad|Dal|kcal|target|items/);
    expect((await herCall('GET', '/v1/p/mirror/food')).json()).toEqual(v);
    const t = (await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday;
    expect(t.food).toEqual({ level: 'counts', meals: 3 });
    expect(JSON.stringify(t)).not.toMatch(/Poha|Salad|Dal/);
    // Off: his route is the unknown-pid 404, Today a locked tile, her mirror says locked.
    expect((await herCall('POST', '/v1/p/agreement/narrow', { see: { food: 'off' } })).statusCode).toBe(200);
    expect((await him('GET', `/v1/people/${f.asha.id}/food`)).statusCode).toBe(404);
    expect(((await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday).food).toEqual({ locked: true });
    expect((await herCall('GET', '/v1/p/mirror/food')).json()).toEqual({ locked: true });
    // She can't widen it back herself (a proposal of his does).
    expect((await herCall('POST', '/v1/p/agreement/narrow', { see: { food: 'counts' } })).statusCode).toBe(400);
  });

  it('his Today at full and his 21:00 summary at each level; her Today mirror deep-equals his', async () => {
    await seed();
    const t = (await him('GET', `/v1/people/${f.asha.id}/today`)).json() as PersonToday;
    expect(t.food).toEqual({ level: 'full', meals: 3, kcal: 570, target: 1800 });
    expect((await herCall('GET', '/v1/p/mirror/today')).json()).toEqual(t);
    expect(f.life.people.alerts?.summaryText()).toMatch(/Asha's day: .*3 meals logged \(570 kcal\)/);
    await herCall('POST', '/v1/p/agreement/narrow', { see: { food: 'counts' } });
    const counts = f.life.people.alerts?.summaryText() ?? '';
    expect(counts).toMatch(/3 meals logged/);
    expect(counts).not.toMatch(/kcal|Poha/);
    await herCall('POST', '/v1/p/agreement/narrow', { see: { food: 'off' } });
    expect(f.life.people.alerts?.summaryText() ?? '').not.toMatch(/meal/);
  });

  it('paused: his read still answers (he can see, not add); a paused person adds nothing of his', async () => {
    await seed();
    await herCall('POST', '/v1/p/pause', {});
    expect((await him('GET', `/v1/people/${f.asha.id}/food`)).statusCode).toBe(200);
    expect((await herCall('POST', '/v1/p/food', { day: DAY, name: 'Still hers', kcal: 90 })).statusCode).toBe(201);
  });
});

describe('her writes reach his screens only while he sees her food log (M11)', () => {
  it('ticks his devices at full, never while see.food is off', async () => {
    let his = 0;
    const was = f.life.people.ownerChanged;
    f.life.people.ownerChanged = () => {
      his += 1;
      was();
    };
    await herCall('POST', '/v1/p/food', { day: DAY, name: 'Seen', kcal: 100 });
    expect(his).toBe(1);
    await herCall('POST', '/v1/p/agreement/narrow', { see: { food: 'off' } });
    his = 0;
    await herCall('POST', '/v1/p/food', { day: DAY, name: 'Unseen', kcal: 100 });
    expect(his).toBe(0);
  });
});

describe('people doctor', () => {
  it('names each food log and what he sees of it', async () => {
    const r = await ctl('GET', '/v1/people/doctor');
    expect(r.statusCode).toBe(200);
    const checks = (r.json() as { checks: { name: string; ok: boolean; detail: string }[] }).checks.filter((c) => c.name.startsWith('food log'));
    expect(checks).toContainEqual({ name: 'food log (Asha)', ok: true, detail: 'on; you see what they eat, with calories' });
    expect(checks).toContainEqual({ name: 'food log (Bea)', ok: true, detail: 'off (to turn it on: jantar people modules Bea --food on)' });
    await herCall('POST', '/v1/p/agreement/narrow', { see: { food: 'counts' } });
    const after = ((await ctl('GET', '/v1/people/doctor')).json() as { checks: { name: string; detail: string }[] }).checks;
    expect(after.find((c) => c.name === 'food log (Asha)')?.detail).toBe('on; you see how many meals they log');
  });
});

describe('T11: her export', () => {
  it('holds her food log and her targets', async () => {
    await herCall('PUT', '/v1/p/food/targets', { kcalTarget: 1600, goalKg: 54.5 });
    await herCall('POST', '/v1/p/food', { day: DAY, name: 'Khichdi', kcal: 380, save: true });
    await him('POST', '/v1/food', { day: DAY, name: 'Not hers', kcal: 1 });
    const r = await herCall('GET', '/v1/p/export?format=json');
    expect(r.statusCode).toBe(200);
    const x = r.json() as { food: { name: string }[]; foodsSaved: { name: string }[]; targets: { kcalTarget: number; goalKg: number } };
    expect(x.food.map((e) => e.name)).toEqual(['Khichdi']);
    expect(x.foodsSaved.map((e) => e.name)).toEqual(['Khichdi']);
    expect(x.targets).toEqual({ kcalTarget: 1600, goalKg: 54.5 });
    const html = (await herCall('GET', '/v1/p/export')).body;
    expect(html).toContain('Khichdi');
    expect(html).not.toContain('Not hers');
  });
});
