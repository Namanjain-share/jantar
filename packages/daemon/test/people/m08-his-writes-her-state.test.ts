/**
 * v0.11 People: M8 for his writes. Every write of his over a device (from
 * PEOPLE_ROUTES, so a write added later joins the day it lands) × her
 * state, with real row ids of hers and bodies that pass their schemas:
 *
 * - setup_again (T20, spec 2.7: the ledger says she shares, but a restore
 *   of an older backup took her row out of life.db): byte-equal to the
 *   unknown-pid answer, as his reads already are, his routes about her
 *   included, and nothing lands in her space, her Activity or her alerts.
 * - ending, left, forgotten: the unknown-pid answer, data routes and his
 *   routes about her alike. Invited: the unknown-pid answer on every data
 *   route (only M9's "about the person" routes answer).
 * - paused: every write into her space (each route with an `area`) is 409
 *   `paused`. Alert sends are held, not refused, and shared lists are both
 *   people's, so neither is in that column.
 *
 * Synthetic people only: Sam, Asha, Bea and the fixture's other states.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RouteDef } from '@jantar/protocol';
import { PEOPLE_ROUTES, type PeopleRouteName } from '@jantar/protocol/people';
import { DAY, OWNER_HOST, OWNER_ORIGIN, UNKNOWN_ULID, credHeaders, makeFixture, onHer, resetLimiters, type Fixture, type PersonCreds } from './isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** His routes about the person that write (M9's list): an invited person answers them too. */
const ABOUT_HER = new Set<string>(['personPropose', 'personOwnerDeviceRevoke', 'personInviteLink', 'personColor']);

/** Every write of his over a device: not his own prefs, not the Mac's `localOnly` routes (M7 refuses those over TCP). */
const WRITES = (Object.entries(PEOPLE_ROUTES) as [PeopleRouteName, RouteDef][]).filter(([name, d]) => d.method !== 'GET' && !d.localOnly && name !== 'peopleOwnerPrefs');

const MED = { name: 'Vitamin D', times: ['08:00'], schedule: { freq: 'daily' } };

/** Row ids in one person's space, each written through the real routes while she shares. */
interface Rows {
  herTodo: string;
  hisTodo: string;
  herMed: string;
  hisMed: string;
  step: string;
  srev: number;
  template: string;
  entry: string;
  comment: string;
  list: string;
  item: string;
  alert: string;
  device: string;
}

/** A request for one route: its URL and body for a pid and a set of rows. */
type Req = (pid: string, r: Rows) => { url: string; body?: object };

const REQ: Record<string, Req> = {
  personOwnerWeightUpdate: (p) => ({ url: `/v1/people/${p}/weights/${DAY}`, body: { kg: 60.9 } }),
  personOwnerWeightDelete: (p) => ({ url: `/v1/people/${p}/weights/${DAY}` }),
  personAssign: (p) => ({ url: `/v1/people/${p}/todos`, body: { title: 'Into a gone space' } }),
  personOwnerTodoUpdate: (p, r) => ({ url: `/v1/people/${p}/todos/${r.hisTodo}`, body: { title: 'Changed' } }),
  personOwnerTodoDelete: (p, r) => ({ url: `/v1/people/${p}/todos/${r.herTodo}` }),
  personMedAssign: (p) => ({ url: `/v1/people/${p}/medicines`, body: { ...MED, name: 'Into a gone space' } }),
  personOwnerMedUpdate: (p, r) => ({ url: `/v1/people/${p}/medicines/${r.hisMed}`, body: { dose: '2' } }),
  personOwnerMedStop: (p, r) => ({ url: `/v1/people/${p}/medicines/${r.herMed}/stop` }),
  personPlanPut: (p, r) => ({ url: `/v1/people/${p}/plans/${DAY}`, body: { srev: r.srev, steps: [{ title: 'Read' }], between: [] } }),
  personPlanDelete: (p) => ({ url: `/v1/people/${p}/plans/${DAY}` }),
  personPlanApply: (p, r) => ({ url: `/v1/people/${p}/plans/${DAY}/apply`, body: { templateId: r.template, mode: 'append', srev: r.srev } }),
  personReviewCarry: (p, r) => ({ url: `/v1/people/${p}/plans/${DAY}/review/carry`, body: { steps: [r.step], to: '2026-11-04' } }),
  personTemplateCreate: (p) => ({ url: `/v1/people/${p}/templates`, body: { name: 'Evening', steps: [] } }),
  personTemplateUpdate: (p, r) => ({ url: `/v1/people/${p}/templates/${r.template}`, body: { name: 'Renamed' } }),
  personTemplateDelete: (p, r) => ({ url: `/v1/people/${p}/templates/${r.template}` }),
  personOwnerJournalComment: (p, r) => ({ url: `/v1/people/${p}/journal/${r.entry}/comments`, body: { text: 'Into a gone space' } }),
  personOwnerJournalCommentDelete: (p, r) => ({ url: `/v1/people/${p}/journal/${r.entry}/comments/${r.comment}` }),
  peopleAlertSend: (p) => ({ url: '/v1/people/alerts', body: { to: p, kind: 'check_in' } }),
  peopleAlertSeen: (_p, r) => ({ url: `/v1/people/alerts/${r.alert}/seen` }),
  peopleAlertReply: (_p, r) => ({ url: `/v1/people/alerts/${r.alert}/reply`, body: { kind: 'on_my_way' } }),
  personOwnerListCreate: (p) => ({ url: `/v1/people/${p}/lists`, body: { name: 'Into a gone space', kind: 'plain' } }),
  personOwnerListUpdate: (p, r) => ({ url: `/v1/people/${p}/lists/${r.list}`, body: { name: 'Renamed' } }),
  personOwnerListDelete: (p, r) => ({ url: `/v1/people/${p}/lists/${r.list}` }),
  personOwnerListItemAdd: (p, r) => ({ url: `/v1/people/${p}/lists/${r.list}/items`, body: { title: 'Bread' } }),
  personOwnerListItemUpdate: (p, r) => ({ url: `/v1/people/${p}/lists/${r.list}/items/${r.item}`, body: { title: 'Soy milk' } }),
  personOwnerListItemDelete: (p, r) => ({ url: `/v1/people/${p}/lists/${r.list}/items/${r.item}` }),
  personOwnerListItemTick: (p, r) => ({ url: `/v1/people/${p}/lists/${r.list}/items/${r.item}/tick`, body: { done: true } }),
  personOwnerListItemAssign: (p, r) => ({ url: `/v1/people/${p}/lists/${r.list}/items/${r.item}/assign`, body: {} }),
  personPropose: (p) => ({ url: `/v1/people/${p}/agreement`, body: { see: { weight: true } } }),
  personOwnerDeviceRevoke: (p, r) => ({ url: `/v1/people/${p}/devices/${r.device}` }),
  personInviteLink: (p) => ({ url: `/v1/people/${p}/invite/again`, body: {} }),
  personColor: (p) => ({ url: `/v1/people/${p}`, body: { color: 'rose' } }),
};

async function him(method: Method, url: string, body?: object) {
  resetLimiters(f.api);
  return f.api.tcp.inject({
    method,
    url,
    headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(f.owner.admin), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
}

async function made(r: ReturnType<typeof him>): Promise<string> {
  const x = await r;
  expect(x.statusCode, x.body).toBeLessThan(300);
  return (x.json() as { id: string }).id;
}

let journalN = 0;

/** Rows of every kind his writes touch, in one person's space (she shares, with Everything). */
async function seed(who: PersonCreds): Promise<Rows> {
  const pid = who.id;
  const her = (method: Method, url: string, body?: object) => onHer(f.api, method, url, who.full, body);
  const herTodo = await made(her('POST', '/v1/p/todos', { title: 'Her own' }));
  const hisTodo = await made(him('POST', `/v1/people/${pid}/todos`, { title: 'From Sam' }));
  const herMed = await made(her('POST', '/v1/p/medicines', MED));
  const hisMed = await made(him('POST', `/v1/people/${pid}/medicines`, { ...MED, name: 'Iron' }));
  expect((await her('PUT', `/v1/p/weights/${DAY}`, { kg: 61.4 })).statusCode).toBe(200);
  const put = await him('PUT', `/v1/people/${pid}/plans/${DAY}`, { srev: 0, steps: [{ title: 'Walk', at: '18:00' }], between: [], send: 'quiet' });
  expect(put.statusCode, put.body).toBe(200);
  const plan = (put.json() as { plan: { srev: number; steps: { id: string }[] } }).plan;
  const template = await made(him('POST', `/v1/people/${pid}/templates`, { name: 'Morning', steps: [{ title: 'Stretch' }] }));
  journalN += 1;
  const entry = await made(her('POST', '/v1/p/journal', { clientId: `journal-m08-${journalN}`, kind: 'entry', text: 'A long walk.' }));
  const comment = await made(him('POST', `/v1/people/${pid}/journal/${entry}/comments`, { text: 'Lovely' }));
  const list = await made(him('POST', `/v1/people/${pid}/lists`, { name: 'Errands', kind: 'plain' }));
  const item = await made(him('POST', `/v1/people/${pid}/lists/${list}/items`, { title: 'Oat milk' }));
  const alert = await made(her('POST', '/v1/p/alerts', { kind: 'call_me' }));
  return { herTodo, hisTodo, herMed, hisMed, step: plan.steps[0]?.id ?? '', srev: plan.srev, template, entry, comment, list, item, alert, device: who.deviceId };
}

/** One write, and the same write for a pid (and an alert) that doesn't exist: the unknown answer. */
async function both(name: string, def: RouteDef, pid: string, rows: Rows) {
  const req = REQ[name] as Req;
  const unknown = req(UNKNOWN_ULID, { ...rows, alert: UNKNOWN_ULID });
  const u = await him(def.method as Method, unknown.url, unknown.body);
  const mine = req(pid, rows);
  const r = await him(def.method as Method, mine.url, mine.body);
  return { got: `${r.statusCode} ${r.body}`, unknown: `${u.statusCode} ${u.body}`, unknownStatus: u.statusCode };
}

/** Rows anywhere in life.db that belong to her: her space's rows in every table, her Activity, her alerts. */
function hersInLife(pid: string): Record<string, number> {
  const core = f.life.people.openCore();
  if (!core) throw new Error('life.db closed');
  const out: Record<string, number> = {};
  const count = (sql: string, ...args: string[]) => (core.db.prepare(sql).get(...args) as { n: number }).n;
  for (const { name } of core.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
    const cols = (core.db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map((c) => c.name);
    if (cols.includes('space')) out[name] = count(`SELECT COUNT(*) AS n FROM ${name} WHERE space = ?`, pid);
  }
  out.person_activity = count('SELECT COUNT(*) AS n FROM person_activity WHERE person = ?', pid);
  out.person_alerts = count('SELECT COUNT(*) AS n FROM person_alerts WHERE from_person = ? OR to_person = ?', pid, pid);
  return out;
}

it('every write of his has a request here (a new one joins the matrix the day it lands)', () => {
  expect(WRITES.map(([n]) => n).filter((n) => !(n in REQ))).toEqual([]);
  expect(WRITES.length).toBeGreaterThanOrEqual(32);
});

describe('M8: his writes × her state', () => {
  it('setup_again (a restore took her row out of life.db): every write of his is the unknown-pid answer, and nothing lands', async () => {
    const rows = await seed(f.asha);
    const core = f.life.people.openCore();
    if (!core) throw new Error('life.db closed');
    core.db.prepare('DELETE FROM people WHERE id = ?').run(f.asha.id);
    expect(f.life.people.gateState(f.asha.id)).toBe('setup_again');
    const before = hersInLife(f.asha.id);
    const read = await him('GET', `/v1/people/${f.asha.id}/medicines`);
    const unknownRead = await him('GET', `/v1/people/${UNKNOWN_ULID}/medicines`);
    expect(`${read.statusCode} ${read.body}`).toBe(`${unknownRead.statusCode} ${unknownRead.body}`);
    const bad: string[] = [];
    for (const [name, def] of WRITES) {
      const r = await both(name, def, f.asha.id, rows);
      // The unknown answer is a 404: the body passed its schema, so only the gate can refuse it.
      expect(r.unknownStatus, `${name}: ${r.unknown}`).toBe(404);
      if (r.got !== r.unknown) bad.push(`${name} ${def.method} ${def.path} -> ${r.got.slice(0, 90)}`);
    }
    expect(bad).toEqual([]);
    expect(hersInLife(f.asha.id)).toEqual(before);
  });

  it('ending, left, forgotten and invited: the unknown-pid answer (invited: on every data route)', async () => {
    const rows = await seed(f.asha);
    const bad: string[] = [];
    for (const [who, pid] of [
      ['ending', f.dev.id],
      ['left', f.eli.id],
      ['forgotten', f.fay.id],
      ['invited', f.gus.id],
    ] as const) {
      for (const [name, def] of WRITES) {
        // Alert ids aren't a person's: seen and reply are checked in the setup_again case above.
        if (!def.path.includes(':pid') && name !== 'peopleAlertSend') continue;
        if (who === 'invited' && ABOUT_HER.has(name)) continue;
        const r = await both(name, def, pid, rows);
        expect(r.unknownStatus, `${name}: ${r.unknown}`).toBe(404);
        if (r.got !== r.unknown) bad.push(`${who} ${name} -> ${r.got.slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('paused: every write into her space is 409 paused, with rows of hers that exist', async () => {
    const her = (url: string) => onHer(f.api, 'POST', url, f.cara.full, {});
    expect((await her('/v1/p/resume')).statusCode).toBe(200);
    const rows = await seed(f.cara);
    expect((await her('/v1/p/pause')).statusCode).toBe(200);
    const bad: string[] = [];
    for (const [name, def] of WRITES) {
      if (!def.area) continue;
      const req = (REQ[name] as Req)(f.cara.id, rows);
      const r = await him(def.method as Method, req.url, req.body);
      if (r.statusCode !== 409 || !/paused/.test(r.body)) bad.push(`${name} -> ${r.statusCode} ${r.body.slice(0, 90)}`);
    }
    expect(bad).toEqual([]);
  });
});
