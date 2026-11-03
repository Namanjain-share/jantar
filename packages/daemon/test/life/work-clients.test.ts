/**
 * v0.13 Work, P2 (life/work): clients and companies, the log, follow-ups,
 * Today's card, Work's settings and client_here, through the module with
 * the real Todos module on an in-memory life.db. Made-up companies only.
 *
 * - a client: added (a company by name made or reused), changed (null
 *   clears; a company can't sit in a company; a company with people stays
 *   one), found (q on name, company, e-mail, phone digits; filters; sorts),
 *   its duplicates warned (e-mail, phone's last 10 digits, name), deleted
 *   with every 4.5 cascade (deals and log go; todos, projects and people
 *   let go of it);
 * - the log: a row and its next step in one save (a refused todo leaves no
 *   row), the touch rebuilt on every change, a page merging done
 *   follow-ups, Jantar's own rows refused to edit;
 * - follow-ups and projects with a client only in his space (O13, W-T4),
 *   checked against Work's table; a follow-up's push names no client unless
 *   names are on, and opens the client while Work is on (W23);
 * - Today's card (check-ins) and the follow-ups' client names; settings in
 *   meta; client_here by a project's folder or a company's own;
 * - anyone but the owner is answered not found (O14).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORK_LIMITS } from '@jantar/protocol/work';
import type { Actor, TodosModule, WorkModule } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { todoPush } from '../../src/life/todos/pings.js';
import { WORK_NOT_FOUND, WORK_REASONS } from '../../src/life/work/module.js';
import { makeFakes } from '../api/fakes.js';

const CLI: Actor = { kind: 'cli' };
const PHONE: Actor = { kind: 'device', deviceId: 'd1', scopes: ['read', 'control'] };
const HER_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
const HER: Actor = { kind: 'person', personId: HER_ID, deviceId: 'd' };

let core: TestLifeCore;
let todos: TodosModule;
let work: WorkModule;

beforeEach(() => {
  core = createTestLifeCore({ tz: 'UTC', settings: { todos: true, work: true } });
  core.clock.set('2026-11-03T09:00:00.000Z');
  const ctx = createTestContext({ clock: core.clock, userHome: '/synthetic/home' });
  const f = makeFakes(ctx);
  const d = { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy };
  todos = LIFE_MODULE_BUILDERS.todos(core, d);
  work = LIFE_MODULE_BUILDERS.work(core, d, todos);
});
afterEach(() => core.close());

function ok<T>(r: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const add = (name: string, extra: Record<string, unknown> = {}) => ok(work.createClient({ name, ...extra }, PHONE));
const hub = (id: string) => ok(work.client(id, PHONE));

describe('clients and companies', () => {
  it('adds a person with her company by name, reusing a company of the same name (any case)', () => {
    const a = add('Riya Sharma', { companyName: 'Acme Studio', phone: '+91 98765 43210', email: 'riya@acme.example', tags: [' Design ', 'design'] });
    expect(a.companyId).toBeDefined();
    const b = add('Sam Lee', { companyName: 'acme studio' });
    expect(b.companyId).toBe(a.companyId);
    const h = hub(a.id);
    expect(h.contact).toMatchObject({ name: 'Riya Sharma', kind: 'person', state: 'lead', phones: [{ value: '+91 98765 43210' }], emails: ['riya@acme.example'], tags: ['design'] });
    expect(h.contact.from).toBeUndefined();
    expect(h.company).toEqual({ id: a.companyId, name: 'Acme Studio', state: 'lead' });
    const company = hub(a.companyId as string);
    expect(company.people?.map((p) => p.name)).toEqual(['Riya Sharma', 'Sam Lee']);
    expect(core.changedCount).toBeGreaterThanOrEqual(2);
  });

  it('a name in any script is its own company; a symbols-only name is reused only by the same text (made-up names)', () => {
    // Before: anything outside a-z0-9 folded to "", so every non-Latin company was the first one.
    const asha = add('Asha', { companyName: 'डेल्टा ट्रेडर्स' });
    const ravi = add('Ravi', { companyName: 'ग्लोबल सॉल्यूशंस' });
    expect(ravi.companyId).not.toBe(asha.companyId);
    expect(add('Meera', { companyName: ' डेल्टा  ट्रेडर्स ' }).companyId).toBe(asha.companyId);
    const star = add('Ana', { companyName: '★' });
    expect(add('Ben', { companyName: '—' }).companyId).not.toBe(star.companyId);
    expect(add('Cy', { companyName: '★' }).companyId).toBe(star.companyId);
    // A deal by a client's name: never an unrelated non-Latin client.
    const mehta = add('मेहता एंटरप्राइज़', { kind: 'company' });
    const deal = ok(work.createDeal({ clientName: '山田商事', title: 'Site rebuild' }, PHONE));
    expect(deal.clientId).not.toBe(mehta.id);
    expect(ok(work.createDeal({ clientName: 'मेहता एंटरप्राइज़', title: 'Audit' }, PHONE)).clientId).toBe(mehta.id);
    expect(ok(work.createDeal({ clientName: '山田商事', title: 'Audit' }, PHONE)).clientId).toBe(deal.clientId);
    // Through an import: two people at two Devanagari companies are at two companies.
    const p = ok(work.importPreview({ format: 'csv', text: 'Name,Company\nDev,अल्फ़ा ग्रुप\nIra,बीटा ग्रुप\nJai,अल्फ़ा ग्रुप\n' }, PHONE));
    ok(work.importRows({ previewId: p.previewId, rows: p.rows.map((r) => ({ index: r.index, action: 'add' as const })) }, PHONE));
    const all = ok(work.clients({ sort: 'name' }, PHONE)).clients;
    const at = (n: string) => all.find((c) => c.name === n)?.company?.name;
    expect([at('Dev'), at('Ira'), at('Jai')]).toEqual(['अल्फ़ा ग्रुप', 'बीटा ग्रुप', 'अल्फ़ा ग्रुप']);
  });

  it('a company id must be a company; a company sits in none; a company with people stays one', () => {
    const person = add('Riya Sharma');
    expect(work.createClient({ name: 'Sam', companyId: person.id }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.notCompany });
    expect(work.createClient({ name: 'Sam', companyId: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.companyGone });
    const co = add('Globex', { kind: 'company' });
    const other = add('Initech', { kind: 'company' });
    expect(work.updateClient(co.id, { companyId: other.id }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.companyInCompany });
    expect(work.updateClient(person.id, { companyId: co.id }, PHONE).ok).toBe(true);
    expect(work.updateClient(co.id, { kind: 'person' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.companyHasPeople });
  });

  it('a change keeps what it does not name; null clears; tags are normalized; `from` is kept', () => {
    const c = add('Riya', { notes: 'Prefers calls', title: 'Head of Ops', checkInDays: 30 });
    core.clock.set('2026-11-03T10:00:00.000Z');
    ok(work.updateClient(c.id, { notes: null, tags: ['VIP', 'vip', 'Retainer'], emails: ['riya@acme.example'] }, PHONE));
    const after = hub(c.id).contact;
    expect(after).toMatchObject({ name: 'Riya', title: 'Head of Ops', checkInDays: 30, tags: ['vip', 'retainer'], emails: ['riya@acme.example'], updatedAt: '2026-11-03T10:00:00.000Z' });
    expect(after.notes).toBeUndefined();
  });

  it('the list finds by name, company, e-mail and phone digits; filters by state, tag and company; sorts', () => {
    const riya = add('Riya Sharma', { companyName: 'Acme Studio', phone: '+91 98765 43210', email: 'riya@acme.example', tags: ['vip'] });
    add('Sam Lee', { state: 'client' });
    add('Zed Past', { state: 'past' });
    const names = (q: Record<string, unknown>) => ok(work.clients({ sort: 'name', ...q } as never, PHONE)).clients.map((c) => c.name);
    expect(names({})).toEqual(['Acme Studio', 'Riya Sharma', 'Sam Lee', 'Zed Past']);
    expect(names({ q: 'acme' })).toEqual(['Acme Studio', 'Riya Sharma']);
    expect(names({ q: 'riya@ACME' })).toEqual(['Riya Sharma']);
    expect(names({ q: '98765-43210' })).toEqual(['Riya Sharma']);
    expect(names({ state: 'client' })).toEqual(['Sam Lee']);
    expect(names({ tag: 'VIP' })).toEqual(['Riya Sharma']);
    expect(names({ company: riya.companyId, kind: 'person' })).toEqual(['Riya Sharma']);
    // Newest touch first.
    core.clock.set('2026-11-03T12:00:00.000Z');
    ok(work.addLog(riya.id, { kind: 'call' }, PHONE));
    expect(ok(work.clients({ sort: 'touch' }, PHONE)).clients[0]?.name).toBe('Riya Sharma');
    const row = ok(work.clients({ sort: 'name', q: 'riya' }, PHONE)).clients[0];
    expect(row).toMatchObject({ company: { id: riya.companyId, name: 'Acme Studio' }, lastTouchAt: '2026-11-03T12:00:00.000Z', openDeals: { count: 0, sums: [] } });
  });

  it('warns of duplicates: the same e-mail, then phone (last 10 digits), then the same name; never blocks', () => {
    const a = add('Riya Sharma', { phone: '+91 98765 43210', email: 'Riya@Acme.example' });
    const b = add('Dr. Riya Sharma');
    const sim = (body: Record<string, unknown>) => ok(work.similar(body as never, PHONE)).matches.map((m) => [m.id, m.why]);
    expect(sim({ email: 'riya@acme.example' })).toEqual([[a.id, 'email']]);
    expect(sim({ phone: '098765 43210' })).toEqual([[a.id, 'phone']]);
    // Both by name (same-millisecond ids sort either way).
    expect(sim({ name: 'riya sharma' }).sort()).toEqual(
      [
        [a.id, 'name'],
        [b.id, 'name'],
      ].sort(),
    );
    expect(sim({ name: 'riya sharma', except: a.id })).toEqual([[b.id, 'name']]);
    // Still added.
    expect(work.createClient({ name: 'Riya Sharma', email: 'riya@acme.example' }, PHONE).ok).toBe(true);
  });

  it('names by id for a chip, unknown ids left out', () => {
    const a = add('Acme Studio', { kind: 'company' });
    expect(ok(work.names([a.id, '01JZZZZZZZZZZZZZZZZZZZZZZX', a.id], PHONE))).toEqual({ clients: [{ id: a.id, name: 'Acme Studio' }] });
  });

  it('a full book refuses with the fixed sentence', () => {
    const at = '2026-11-03T09:00:00.000Z';
    const ins = core.db.prepare("INSERT INTO work_contacts (id, kind, state, name_key, updated_at, json) VALUES (?, 'person', 'lead', 'x', ?, '{}')");
    core.db.tx(() => {
      for (let i = 0; i < WORK_LIMITS.contacts; i++) ins.run(`fill-${i}`, at);
    });
    expect(work.createClient({ name: 'One more' }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: 'Work holds 5,000 clients at most. Mark some as past or delete them.' });
  });

  it('deleting a client: its deals and log go; its todos, projects and people let go of it (one transaction)', () => {
    const co = add('Acme Studio', { kind: 'company' });
    const riya = add('Riya Sharma', { companyId: co.id });
    const p = ok(todos.createProject({ name: 'Site rebuild', clientId: co.id }, PHONE));
    ok(work.addLog(co.id, { kind: 'note', body: 'Kick-off', next: { title: 'Send the quote', due: { day: '2026-11-05' } } }, PHONE));
    core.db
      .prepare("INSERT INTO work_deals (id, contact_id, stage, updated_at, json) VALUES ('d1', ?, 'new', '2026-11-03T09:00:00.000Z', '{\"title\":\"Synthetic deal\"}')")
      .run(co.id);
    core.db.prepare("INSERT INTO work_log (id, contact_id, deal_id, at, kind, json) VALUES ('l-deal', NULL, 'd1', '2026-11-03T09:00:00.000Z', 'stage', '{}')").run();
    const removed = ok(work.removeClient(co.id, PHONE));
    // Every log row that went: the note, and (P3) the deal's own row.
    expect(removed).toEqual({ deals: 1, log: 2 });
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM work_log').get()).toEqual({ n: 0 });
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM work_deals').get()).toEqual({ n: 0 });
    const t = ok(todos.listTodos({ done: false })).todos[0];
    expect(t?.title).toBe('Send the quote');
    expect(t?.contactId).toBeUndefined();
    expect(core.db.prepare('SELECT contact_id FROM todos').get()).toEqual({ contact_id: null });
    expect(ok(todos.listProjects()).projects.find((x) => x.id === p.id)?.clientId).toBeUndefined();
    expect(hub(riya.id).contact.companyId).toBeUndefined();
    expect(work.client(co.id, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.noClient });
  });
});

describe('the log', () => {
  it('a call and its next step in one save; the touch follows the log', () => {
    const c = add('Riya Sharma');
    const r = ok(work.addLog(c.id, { kind: 'call', direction: 'out', minutes: 25, outcome: 'good', body: 'Went through the quote', next: { title: 'Send the quote', due: { day: '2026-11-05', time: '15:00' } } }, PHONE));
    expect(r.todoId).toBeDefined();
    const h = hub(c.id);
    expect(h.contact.lastTouchAt).toBe('2026-11-03T09:00:00.000Z');
    expect(h.followUps.map((t) => [t.id, t.title, t.contactId])).toEqual([[r.todoId, 'Send the quote', c.id]]);
    expect(h.log).toEqual([{ id: r.id, kind: 'call', at: '2026-11-03T09:00:00.000Z', contactId: c.id, body: 'Went through the quote', direction: 'out', minutes: 25, outcome: 'good' }]);
    // The follow-up rings at its time.
    expect([...core.scheduler.rows.values()].some((x) => x.kind === "todo" && x.ref === r.todoId)).toBe(true);
  });

  it('a refused next step leaves no log row and no touch', () => {
    const c = add('Riya Sharma');
    const r = work.addLog(c.id, { kind: 'call', next: { title: 'Send the quote', due: { day: '2026-11-05' }, projectId: '01JZZZZZZZZZZZZZZZZZZZZZZX' } }, PHONE);
    expect(r.ok).toBe(false);
    expect(core.db.prepare('SELECT COUNT(*) AS n FROM work_log').get()).toEqual({ n: 0 });
    expect(hub(c.id).contact.lastTouchAt).toBeUndefined();
  });

  it('refuses an entry in the future, a gone project or deal; edits and deletes rebuild the touch', () => {
    const c = add('Riya Sharma');
    expect(work.addLog(c.id, { kind: 'note', at: '2026-11-04T09:00:00.000Z' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.logFuture });
    expect(work.addLog(c.id, { kind: 'note', dealId: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.dealGone });
    const older = ok(work.addLog(c.id, { kind: 'email', at: '2026-11-01T09:00:00.000Z' }, PHONE));
    const newer = ok(work.addLog(c.id, { kind: 'message', at: '2026-11-02T09:00:00.000Z' }, PHONE));
    expect(hub(c.id).contact.lastTouchAt).toBe('2026-11-02T09:00:00.000Z');
    ok(work.removeLog(newer.id, PHONE));
    expect(hub(c.id).contact.lastTouchAt).toBe('2026-11-01T09:00:00.000Z');
    ok(work.updateLog(older.id, { at: '2026-10-30T09:00:00.000Z', body: 'Sent the deck' }, PHONE));
    expect(hub(c.id).contact.lastTouchAt).toBe('2026-10-30T09:00:00.000Z');
    expect(work.logRow(older.id)).toMatchObject({ kind: 'email', body: 'Sent the deck' });
  });

  it('the touch column matches a rebuild: drift is repaired at start', () => {
    const c = add('Riya Sharma');
    const d = add('Sam Lee');
    ok(work.addLog(c.id, { kind: 'call', at: '2026-11-01T09:00:00.000Z' }, PHONE));
    core.db.prepare('UPDATE work_contacts SET last_touch_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', c.id);
    core.db.prepare('UPDATE work_contacts SET last_touch_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', d.id);
    work.start?.();
    expect(hub(c.id).contact.lastTouchAt).toBe('2026-11-01T09:00:00.000Z');
    expect(hub(d.id).contact.lastTouchAt).toBeUndefined();
  });

  it("refuses to edit or delete Jantar's own rows (a meeting's link, a stage move)", () => {
    const c = add('Riya Sharma');
    core.db.prepare("INSERT INTO work_log (id, contact_id, meeting_id, at, kind, json) VALUES ('l-m', ?, '01JZZZZZZZZZZZZZZZZZZZZZZW', '2026-11-01T09:00:00.000Z', 'meeting', '{\"auto\":true}')").run(c.id);
    expect(work.updateLog('l-m', { body: 'x' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.logJantars });
    expect(work.removeLog('l-m', PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.logJantars });
  });

  it('a page merges done follow-ups by their done time, newest first, with a cursor', () => {
    const c = add('Riya Sharma');
    for (let i = 0; i < WORK_LIMITS.clientLog + 3; i++) ok(work.addLog(c.id, { kind: 'note', at: new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 3_600_000).toISOString(), body: `n${i}` }, PHONE));
    const t = ok(todos.createTodo({ title: 'Follow up', contactId: c.id }, PHONE));
    ok(todos.setDone(t.id, true, PHONE));
    const first = hub(c.id);
    expect(first.log[0]).toMatchObject({ id: t.id, kind: 'followup', title: 'Follow up', at: '2026-11-03T09:00:00.000Z' });
    expect(first.log).toHaveLength(WORK_LIMITS.clientLog);
    expect(first.logNext).toBeDefined();
    const second = ok(work.clientLog(c.id, first.logNext, PHONE));
    expect(second.log.map((r) => r.body)).toEqual(['n3', 'n2', 'n1', 'n0'].slice(0, second.log.length));
    expect(second.next).toBeUndefined();
    expect(new Set([...first.log, ...second.log].map((r) => r.id)).size).toBe(WORK_LIMITS.clientLog + 4);
  });
});

describe('follow-ups and projects with a client: his space only (O13, W-T4)', () => {
  it('a todo takes a client of his and loses it with null; an unknown client is refused', () => {
    const c = add('Riya Sharma');
    const t = ok(todos.createTodo({ title: 'Call back', contactId: c.id }, PHONE));
    expect(todos.followUps(c.id, false).map((x) => x.id)).toEqual([t.id]);
    expect(todos.createTodo({ title: 'Call back', contactId: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false, reason: "That client doesn't exist any more." });
    ok(todos.updateTodo(t.id, { contactId: null }, PHONE));
    expect(todos.followUps(c.id, false)).toEqual([]);
    expect(core.db.prepare('SELECT contact_id FROM todos WHERE id = ?').get(t.id)).toEqual({ contact_id: null });
  });

  it("his todos list takes ?contact= (one client's follow-ups), with the project and text filters", () => {
    const c = add('Riya Sharma');
    const other = add('Sam Lee');
    const p = ok(todos.createProject({ name: 'Site' }, PHONE)).id;
    const a = ok(todos.createTodo({ title: 'Send the quote', contactId: c.id, projectId: p, due: { day: '2026-11-05' } }, PHONE)).id;
    const b = ok(todos.createTodo({ title: 'Call back', contactId: c.id, due: { day: '2026-11-04' } }, PHONE)).id;
    ok(todos.createTodo({ title: 'Call back', contactId: other.id }, PHONE));
    ok(todos.createTodo({ title: 'Plain' }, PHONE));
    const ids = (q: Record<string, unknown>) => ok(todos.listTodos({ done: false, ...q } as never)).todos.map((t) => t.id);
    expect(ids({ contact: c.id })).toEqual([b, a]);
    expect(ids({ contact: c.id, project: p })).toEqual([a]);
    expect(ids({ contact: c.id, project: 'none' })).toEqual([b]);
    expect(ids({ contact: c.id, q: 'QUOTE' })).toEqual([a]);
    ok(todos.setDone(b, true, PHONE));
    expect(ids({ contact: c.id, done: true })).toEqual([b]);
  });

  it('a todo or a project outside his space never takes a client, a deal or a business', () => {
    const c = add('Riya Sharma');
    const hers = todos.inSpace(HER_ID);
    expect(hers.createTodo({ title: 'Call back', contactId: c.id }, HER)).toMatchObject({ ok: false, reason: 'Only your own todos can have a client.' });
    const herTodo = ok(hers.createTodo({ title: 'Plain' }, HER));
    expect(hers.updateTodo(herTodo.id, { contactId: c.id }, HER)).toMatchObject({ ok: false, reason: 'Only your own todos can have a client.' });
    expect(hers.createProject({ name: 'Hers', clientId: c.id }, HER)).toMatchObject({ ok: false, reason: 'Only your own projects can have a client.' });
    const shared = todos.inSpace('s:01JZZZZZZZZZZZZZZZZZZZZZZY');
    expect(shared.createProject({ name: 'Groceries', clientId: c.id }, CLI)).toMatchObject({ ok: false, reason: "A shared list can't have a client." });
    const list = ok(shared.createProject({ name: 'Groceries' }, CLI));
    expect(shared.updateProject(list.id, { clientId: c.id }, CLI)).toMatchObject({ ok: false, reason: "A shared list can't have a client." });
    expect(hers.followUps(null, false)).toEqual([]);
  });

  it('his project takes a client and a business of his; a business must be in Work settings', () => {
    const c = add('Acme Studio', { kind: 'company' });
    expect(todos.createProject({ name: 'Site', business: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false, reason: "That business doesn't exist any more. Add it in Work's settings." });
    ok(work.settingsUpdate({ businesses: [{ name: 'Northwind Studio' }] }, PHONE));
    const b = ok(work.settingsGet(PHONE)).businesses[0];
    const p = ok(todos.createProject({ name: 'Site', clientId: c.id, business: b?.id }, PHONE));
    expect(ok(todos.listProjects()).projects[0]).toMatchObject({ id: p.id, clientId: c.id, business: b?.id });
    expect(hub(c.id).projects.map((x) => x.id)).toEqual([p.id]);
    expect(ok(work.clients({ sort: 'name', business: b?.id }, PHONE)).clients.map((x) => x.name)).toEqual(['Acme Studio']);
    ok(todos.updateProject(p.id, { clientId: null, business: null }, PHONE));
    expect(ok(todos.listProjects()).projects[0]?.clientId).toBeUndefined();
  });

  it("a follow-up's push says no client words unless names are on, and opens the client while Work is on (W23)", () => {
    const t = { id: '01JZZZZZZZZZZZZZZZZZZZZZZV', title: 'Call Riya at Acme', priority: 'normal' as const, contactId: '01JZZZZZZZZZZZZZZZZZZZZZZT', createdAt: 'x', updatedAt: 'x' };
    const at = new Date('2026-11-03T15:00:00.000Z');
    expect(todoPush(t, t.id, at, false, 'UTC', 'full', undefined, { work: true, names: false })).toMatchObject({ title: 'Todo due', body: 'Follow-up · 15:00', url: `/work?tab=clients&id=${t.contactId}` });
    expect(todoPush(t, t.id, at, true, 'UTC', 'full', undefined, { work: true, names: false }).body).toBe('Missed at 15:00 · Follow-up · 15:00');
    expect(todoPush(t, t.id, at, false, 'UTC', 'full', undefined, { work: true, names: true }).body).toBe('Call Riya at Acme · 15:00');
    expect(todoPush(t, t.id, at, false, 'UTC', 'full', undefined, { work: false, names: false }).url).toBe(`/todos?id=${t.id}`);
    const plain = { ...t, contactId: undefined };
    expect(todoPush(plain, t.id, at, false, 'UTC', 'full', undefined, { work: true, names: false }).body).toBe('Call Riya at Acme · 15:00');
  });
});

describe("Today's card, settings and client_here", () => {
  it('check-ins due (the first 3, the rest counted) and the follow-ups due today with their client names', () => {
    for (const [name, days] of [['Acme', 7], ['Globex', 14], ['Initech', 30], ['Umbrella', 7], ['Hooli', 365]] as const) add(name, { kind: 'company', checkInDays: days });
    core.clock.set('2026-11-20T09:00:00.000Z');
    const acme = ok(work.clients({ sort: 'name', q: 'acme' }, PHONE)).clients[0];
    ok(todos.createTodo({ title: 'Send the quote', due: { day: '2026-11-20' }, contactId: acme?.id }, PHONE));
    const card = work.today('2026-11-20').work;
    expect(card?.checkIns.map((x) => x.name)).toEqual(['Acme', 'Umbrella', 'Globex']);
    expect(card?.checkIns[0]).toMatchObject({ every: 7, since: null });
    expect(card?.checkInsMore).toBe(0);
    expect(card?.clients).toEqual([{ id: acme?.id, name: 'Acme' }]);
    // A touch resets a check-in.
    ok(work.addLog(acme?.id as string, { kind: 'call' }, PHONE));
    expect(work.today('2026-11-20').work?.checkIns.map((x) => x.name)).toEqual(['Umbrella', 'Globex']);
  });

  it("Work's settings live in meta: businesses keep their ids, a dial code, quiet days; the lock-screen switch is read only", () => {
    expect(ok(work.settingsGet(PHONE))).toEqual({ businesses: [], quietDays: 14, lockScreenNames: false });
    ok(work.settingsUpdate({ businesses: [{ name: 'Northwind Studio' }, { name: 'Globex Labs' }], dialCode: '+91', quietDays: 21 }, PHONE));
    const s = ok(work.settingsGet(PHONE));
    expect(s).toMatchObject({ dialCode: '+91', quietDays: 21, businesses: [{ name: 'Northwind Studio' }, { name: 'Globex Labs' }] });
    ok(work.settingsUpdate({ businesses: [{ id: s.businesses[1]?.id, name: 'Globex' }], dialCode: null }, PHONE));
    const again = ok(work.settingsGet(PHONE));
    expect(again.businesses).toEqual([{ id: s.businesses[1]?.id, name: 'Globex' }]);
    expect(again.dialCode).toBeUndefined();
    core.setSettings({ workLockScreenNames: true });
    expect(ok(work.settingsGet(PHONE)).lockScreenNames).toBe(true);
  });

  it("client_here: the client of the folder's project (the deepest), else a company whose folder holds it; never phones or notes", () => {
    const co = add('Acme Studio', { kind: 'company', folder: '/synthetic/work/client/acme' });
    expect(work.forFolder('/synthetic/work/client/acme/web')).toMatchObject({ client: { id: co.id, name: 'Acme Studio', kind: 'company', state: 'lead', openDeals: 0 } });
    const riya = add('Riya Sharma', { companyId: co.id, phone: '+91 98765 43210', notes: 'private notes' });
    ok(todos.createProject({ name: 'Web', folder: '/synthetic/work/client/acme/web', clientId: riya.id }, PHONE));
    ok(todos.createTodo({ title: 'Send the quote', due: { day: '2026-11-05' }, contactId: riya.id }, PHONE));
    const here = work.forFolder('/synthetic/work/client/acme/web/src');
    expect(here.client).toMatchObject({ id: riya.id, company: { id: co.id, name: 'Acme Studio' }, project: { name: 'Web' }, next: { title: 'Send the quote', due: { day: '2026-11-05' } } });
    expect(JSON.stringify(here)).not.toMatch(/98765|private notes/);
    expect(work.forFolder('/synthetic/elsewhere')).toEqual({ client: null });
    // A company linked to the home folder holds only exactly it.
    add('Home Co', { kind: 'company', folder: '/synthetic/home' });
    expect(work.forFolder('/synthetic/home/scratch')).toEqual({ client: null });
  });

  it('the seed can also make one company client per folder, the project its client', () => {
    const r = ok(work.seed([{ folder: '/synthetic/work/client/acme', name: 'Acme' }], CLI, { clients: true }));
    expect(r.clients).toHaveLength(1);
    const c = hub(r.clients?.[0] as string);
    expect(c.contact).toMatchObject({ name: 'Acme', kind: 'company', state: 'client', folder: '/synthetic/work/client/acme' });
    expect(c.projects.map((p) => p.id)).toEqual(r.projects);
  });

  it('the search finds clients by name, company, e-mail and phone digits', () => {
    const riya = add('Riya Sharma', { companyName: 'Acme Studio', email: 'riya@acme.example', phone: '98765 43210' });
    const items = (q: string) => ok(work.search(q, 5, PHONE)).clients.map((c) => [c.label, c.href]);
    expect(items('sharma')).toEqual([['Riya Sharma', `/work?tab=clients&id=${riya.id}`]]);
    expect(items('acme').map(([l]) => l)).toEqual(['Acme Studio', 'Riya Sharma']);
    expect(items('543')).toEqual([['Riya Sharma', `/work?tab=clients&id=${riya.id}`]]);
  });
});

describe('anyone but the owner is answered not found (O14)', () => {
  it('every read and write of a person', () => {
    const c = add('Riya Sharma');
    const nf = { ok: false, code: 'not_found', reason: WORK_NOT_FOUND };
    expect(work.clients({ sort: 'name' }, HER)).toEqual(nf);
    expect(work.client(c.id, HER)).toEqual(nf);
    expect(work.createClient({ name: 'X' }, HER)).toEqual(nf);
    expect(work.updateClient(c.id, { name: 'X' }, HER)).toEqual(nf);
    expect(work.removeClient(c.id, HER)).toEqual(nf);
    expect(work.addLog(c.id, { kind: 'note' }, HER)).toEqual(nf);
    expect(work.similar({ name: 'Riya' }, HER)).toEqual(nf);
    expect(work.names([c.id], HER)).toEqual(nf);
    expect(work.settingsGet(HER)).toEqual(nf);
    expect(work.exportCsv(HER)).toEqual(nf);
    expect(work.search('riya', 5, HER)).toEqual(nf);
    expect(hub(c.id).contact.name).toBe('Riya Sharma');
  });
});
