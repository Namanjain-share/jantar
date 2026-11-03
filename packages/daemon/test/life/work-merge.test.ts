/**
 * v0.13 Work, P3b (life/work): possible duplicates, his "not a duplicate"
 * rulings, merging two clients, and the starter lists, through the module
 * with the real Todos module on an in-memory life.db. Made-up companies
 * only.
 *
 * - duplicates group clients by e-mail, phone (its last 10 digits) and
 *   name, minus his rulings;
 * - a merge keeps the survivor's values, fills its blanks from the loser
 *   (or takes the picked ones), unions the lists, and moves the loser's
 *   deals, log, follow-ups, projects and people, in one transaction; a
 *   meeting both were linked to keeps one row; the loser is hidden; an
 *   imported loser's mark moves with it (B3); two people or two companies;
 * - the starter lists count and list through one predicate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MERGE_FIELDS, starterClientLists } from '@jantar/life-core';
import { WORK_CLIENT_LISTS, WORK_MERGE_FIELDS } from '@jantar/protocol/work';
import type { Actor, TodosModule, WorkModule } from '../../src/contracts.js';
import { createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { WORK_REASONS } from '../../src/life/work/module.js';
import { makeFakes } from '../api/fakes.js';

const PHONE: Actor = { kind: 'device', deviceId: 'd1', scopes: ['read', 'control'] };

let core: TestLifeCore;
let todos: TodosModule;
let work: WorkModule;

beforeEach(() => {
  core = createTestLifeCore({ tz: 'UTC', settings: { todos: true, work: true, currency: 'INR' } });
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

describe('duplicates', () => {
  it('groups by e-mail, phone and name; his "not a duplicate" ruling takes a pair out', () => {
    const a = add('Riya Sharma', { email: 'riya@acme.example' });
    const b = add('R. Sharma', { email: 'RIYA@acme.example', phone: '+91 98765 43210' });
    const c = add('Riya S', { phone: '098765 43210' });
    add('Globex', { kind: 'company' });
    const groups = ok(work.duplicates(PHONE)).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.clients.map((x) => x.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(groups[0]?.reasons).toEqual(['email', 'phone']);
    // One ruling leaves the group while another pair is still undecided.
    ok(work.notDuplicate(a.id, b.id, PHONE));
    expect(ok(work.duplicates(PHONE)).groups).toHaveLength(1);
    ok(work.notDuplicate(b.id, c.id, PHONE));
    ok(work.notDuplicate(c.id, a.id, PHONE));
    expect(ok(work.duplicates(PHONE)).groups).toEqual([]);
    expect(work.contact(a.id)?.notDuplicateOf?.sort()).toEqual([b.id, c.id].sort());
    expect(work.notDuplicate(a.id, a.id, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.clientGone });
  });
});

describe('merge', () => {
  it('the conflicts are the fields both hold differently (a company by its name)', () => {
    const acme = add('Acme Studio', { kind: 'company' });
    const globex = add('Globex', { kind: 'company' });
    const a = add('Riya Sharma', { companyId: acme.id, title: 'Head of Ops', city: 'Pune' });
    const b = add('R. Sharma', { companyId: globex.id, title: 'Head of Ops', source: 'Referral' });
    expect(ok(work.mergeConflicts(a.id, b.id, PHONE)).conflicts).toEqual([
      { field: 'name', label: 'Name', survivor: 'Riya Sharma', loser: 'R. Sharma' },
      { field: 'companyId', label: 'Company', survivor: 'Acme Studio', loser: 'Globex' },
    ]);
    expect(work.mergeConflicts(a.id, acme.id, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.mergeKinds });
    expect(work.mergeConflicts(a.id, a.id, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.mergeSelf });
  });

  it("moves the loser's deals, log, follow-ups, projects and people to the survivor; the loser is hidden", () => {
    const keep = add('Acme Studio', { kind: 'company', state: 'lead', phone: '+91 98765 43210' });
    const gone = add('ACME studio', { kind: 'company', state: 'client', email: 'hello@acme.example', city: 'Pune', tags: ['retail'] });
    const riya = add('Riya Sharma', { companyId: gone.id });
    const deal = ok(work.createDeal({ clientId: gone.id, title: 'Site rebuild' }, PHONE)).id;
    const call = ok(work.addLog(gone.id, { kind: 'call', body: 'Scope', next: { title: 'Send quote', due: { day: '2026-11-05' } } }, PHONE));
    const project = ok(todos.createProject({ name: 'Site rebuild', clientId: gone.id }, PHONE)).id;
    // A meeting linked to both: one row stays.
    const m = { id: '01JZZZZZZZZZZZZZZZZZZZZZM1', projectId: null, startedAt: '2026-11-02T10:00:00.000Z' };
    ok(work.setMeetingClients(m, [keep.id, gone.id], PHONE));
    ok(work.merge(keep.id, { loserId: gone.id, picks: ['name'] }, PHONE));
    const h = ok(work.client(keep.id, PHONE));
    expect(h.contact).toMatchObject({ name: 'ACME studio', state: 'client', city: 'Pune', tags: ['retail'], emails: ['hello@acme.example'], phones: [{ value: '+91 98765 43210' }] });
    expect(h.deals.map((x) => x.id)).toEqual([deal]);
    expect(h.log.filter((r) => r.kind !== 'followup').map((r) => r.kind).sort()).toEqual(['call', 'created', 'meeting']);
    expect(h.followUps.map((t) => [t.id, t.contactId])).toEqual([[call.todoId, keep.id]]);
    expect(h.projects.map((p) => p.id)).toEqual([project]);
    expect(h.people?.map((p) => p.id)).toEqual([riya.id]);
    expect(work.contact(riya.id)?.companyId).toBe(keep.id);
    expect(h.contact.lastTouchAt).toBe('2026-11-03T09:00:00.000Z');
    // The loser is hidden everywhere, and its id is refused as a link.
    expect(work.client(gone.id, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.noClient });
    expect(ok(work.clients({ sort: 'name' }, PHONE)).clients.map((c) => c.id).sort()).toEqual([keep.id, riya.id].sort());
    expect(todos.createTodo({ title: 'x', contactId: gone.id }, PHONE).ok).toBe(false);
    expect(ok(work.duplicates(PHONE)).groups).toEqual([]);
  });

  it("an imported loser's mark moves to the survivor (B3); two people or two companies only", () => {
    const p = ok(work.importPreview({ format: 'csv', text: 'Name,Email\nRiya Sharma,riya@acme.example\n' }, PHONE));
    ok(work.importRows({ previewId: p.previewId, rows: [{ index: 0, action: 'add' }] }, PHONE));
    const imported = ok(work.clients({ sort: 'name' }, PHONE)).clients[0]?.id as string;
    const mine = add('Riya', { phone: '+91 98765 43210' });
    ok(work.merge(mine.id, { loserId: imported }, PHONE));
    expect(work.contact(mine.id)).toMatchObject({ name: 'Riya', from: 'import', emails: ['riya@acme.example'] });
    const co = add('Globex', { kind: 'company' });
    expect(work.merge(mine.id, { loserId: co.id }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.mergeKinds });
    expect(work.merge(mine.id, { loserId: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.clientGone });
  });
});

describe("the protocol's lists match life-core's", () => {
  it('the merge fields and the starter lists', () => {
    expect([...WORK_MERGE_FIELDS]).toEqual([...MERGE_FIELDS]);
    expect([...WORK_CLIENT_LISTS]).toEqual(starterClientLists().map((l) => l.id));
  });
});

describe('starter lists', () => {
  it('each counts and lists through the one predicate', () => {
    const due = add('Umbrella', { kind: 'company', state: 'client', checkInDays: 7 });
    const lead = add('Initech', { kind: 'company' });
    const noMail = add('Sam Lee');
    ok(work.createDeal({ clientId: lead.id, title: 'Audit' }, PHONE));
    core.clock.set('2026-11-20T09:00:00.000Z');
    const lists = Object.fromEntries(ok(work.clientLists(PHONE)).lists.map((l) => [l.id, l]));
    expect(lists['check-in']).toMatchObject({ name: 'Needs a check-in', description: 'check-in due', count: 1 });
    expect(lists['open-deals']?.count).toBe(1);
    expect(lists['quiet-leads']?.count).toBe(2);
    expect(lists['no-email']).toMatchObject({ description: 'People · no email', count: 1 });
    const ids = (list: string) => ok(work.clients({ sort: 'name', list } as never, PHONE)).clients.map((c) => c.id);
    expect(ids('check-in')).toEqual([due.id]);
    expect(ids('open-deals')).toEqual([lead.id]);
    expect(ids('no-email')).toEqual([noMail.id]);
  });
});
