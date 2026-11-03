/**
 * v0.13 Work, P3 (life/work): deals, their stages, moves and insights,
 * through the module with the real Todos module on an in-memory life.db.
 * Made-up companies only.
 *
 * - a deal: added for a client by id or by name (reused, else a new
 *   company), on an open stage only, in the Life currency unless named, its
 *   source joined to one in use; its "added" row in the client's log;
 *   changed (null clears; a reason only on a lost deal; a business or a
 *   project that isn't there refused); deleted (its own rows go, a call
 *   logged with it stays, its todos let go of it);
 * - moves (4.5): an open move writes a `stage` row; Won stamps it, makes a
 *   lead a client and, when asked, makes the project (client, business and
 *   deal linked) in the same save, refused as one; Lost takes a reason and
 *   never demotes a client; a closed deal moved back is open again;
 * - cards: the next step (the deal's todo, else the client's), quiet (no
 *   move and no touch), the close state; the list's filters and each
 *   stage's column per currency; Today's counts; a client's and a
 *   project's deals; search; client_here; the deals CSV;
 * - stages: renamed, reordered, added, removed (a stage with deals needs an
 *   open stage that stays), Won and Lost never removed;
 * - insights: one book per currency, no data as null, the funnel and time in
 *   stage from the moves;
 * - milestones on his project (P3): set in order (kept ids stay), shown on
 *   the hub with their progress, never on a project of hers or a shared
 *   list;
 * - caps answer fixed sentences.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORK_LIMITS, type WorkDealCard } from '@jantar/protocol/work';
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
const client = (name: string, extra: Record<string, unknown> = {}) => ok(work.createClient({ name, ...extra }, PHONE)).id;
const deal = (clientId: string, title: string, extra: Record<string, unknown> = {}) => ok(work.createDeal({ clientId, title, ...extra }, PHONE)).id;
const hub = (id: string) => ok(work.deal(id, PHONE));
const card = (id: string): WorkDealCard => hub(id).card;
const later = (days: number) => core.clock.set(new Date(core.clock.now() + days * 86_400_000).toISOString());

describe('a deal', () => {
  it('is added for a client by id, on the first open stage, in the Life currency, with its "added" row', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const id = deal(acme, 'Site rebuild', { value: 45_000_000, expectedClose: '2026-11-30', source: 'Referral' });
    const h = hub(id);
    expect(h.deal).toMatchObject({ title: 'Site rebuild', contactId: acme, stage: 'new', value: 45_000_000, currency: 'INR', expectedClose: '2026-11-30', source: 'Referral', stageMovedAt: '2026-11-03T09:00:00.000Z' });
    expect(h.card).toMatchObject({ stageName: 'New lead', kind: 'open', daysInStage: 0, closeState: 'later', quiet: false, client: { id: acme, name: 'Acme Studio' } });
    expect(h.client).toMatchObject({ id: acme, state: 'lead' });
    expect(h.log.map((r) => [r.kind, r.stageTo])).toEqual([['created', 'new']]);
    // The client's log shows it too; it is not a touch.
    const c = ok(work.client(acme, PHONE));
    expect(c.log.map((r) => r.kind)).toEqual(['created']);
    expect(c.contact.lastTouchAt).toBeUndefined();
    expect(c.openDeals).toEqual({ count: 1, sums: [{ currency: 'INR', amount: 45_000_000 }] });
  });

  it('by name: a client with that name (any case), else a new company, a lead', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    expect(ok(work.createDeal({ clientName: 'acme studio', title: 'Audit' }, PHONE)).clientId).toBe(acme);
    const made = ok(work.createDeal({ clientName: 'Northwind Traders', title: 'App' }, PHONE));
    expect(work.contact(made.clientId)).toMatchObject({ name: 'Northwind Traders', kind: 'company', state: 'lead' });
  });

  it('starts only on an open stage that exists, for a client that exists; a source joins one in use', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    expect(work.createDeal({ clientId: acme, title: 'x', stage: 'won' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.startOpen });
    expect(work.createDeal({ clientId: acme, title: 'x', stage: 'nope' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.noStage });
    expect(work.createDeal({ clientId: '01JZZZZZZZZZZZZZZZZZZZZZZX', title: 'x' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.clientGone });
    expect(work.createDeal({ clientId: acme, title: 'x', business: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.businessGone });
    expect(work.createDeal({ clientId: acme, title: 'x', projectId: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.projectGone });
    deal(acme, 'One', { source: 'Referral', stage: 'proposal', currency: 'USD' });
    const two = deal(acme, 'Two', { source: '  referral ' });
    expect(hub(two).deal.source).toBe('Referral');
    expect(core.changedCount).toBeGreaterThan(0);
  });

  it('changes (null clears); a reason only on a lost deal; a new client takes its own rows, not its calls', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const globex = client('Globex', { kind: 'company' });
    const id = deal(acme, 'Site rebuild', { value: 100, expectedClose: '2026-11-30' });
    ok(work.addLog(acme, { kind: 'call', body: 'Scope', dealId: id }, PHONE));
    expect(work.updateDeal(id, { lostCode: 'price' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.notLost });
    expect(work.updateDeal(id, { business: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.businessGone });
    ok(work.updateDeal(id, { title: 'Site and shop', value: null, expectedClose: null, clientId: globex }, PHONE));
    const h = hub(id);
    expect(h.deal).toMatchObject({ title: 'Site and shop', contactId: globex });
    expect(h.deal.value).toBeUndefined();
    expect(h.deal.expectedClose).toBeUndefined();
    expect(ok(work.client(globex, PHONE)).log.map((r) => r.kind)).toEqual(['created']);
    expect(ok(work.client(acme, PHONE)).log.map((r) => r.kind)).toEqual(['call']);
    expect(work.updateDeal('01JZZZZZZZZZZZZZZZZZZZZZZX', { title: 'x' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.noDeal });
  });

  it('deleting it removes its own rows; a call logged with it stays, and its todos let go of it', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const id = deal(acme, 'Site rebuild');
    ok(work.moveDeal(id, { stage: 'contacted' }, PHONE));
    const call = ok(work.addLog(acme, { kind: 'call', body: 'Scope', dealId: id, next: { title: 'Send quote', due: { day: '2026-11-05' } } }, PHONE));
    expect(todos.dealFollowUps(id, false).map((t) => t.id)).toEqual([call.todoId]);
    expect(ok(work.removeDeal(id, PHONE))).toEqual({ log: 2 });
    expect(work.dealRecord(id)).toBeNull();
    const c = ok(work.client(acme, PHONE));
    expect(c.log.map((r) => [r.kind, r.dealId])).toEqual([['call', undefined]]);
    expect(c.followUps[0]?.dealId).toBeUndefined();
    expect(c.followUps[0]?.contactId).toBe(acme);
  });

  it("a client's delete takes its deals and lets its todos go of them", () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const other = client('Initech', { kind: 'company' });
    const id = deal(acme, 'Site rebuild');
    const t = ok(todos.createTodo({ title: 'Chase', contactId: other, dealId: id }, PHONE)).id;
    expect(ok(work.removeClient(acme, PHONE))).toEqual({ deals: 1, log: 1 });
    expect(work.dealRecord(id)).toBeNull();
    expect(ok(todos.listTodos({ done: false })).todos.find((x) => x.id === t)?.dealId).toBeUndefined();
  });

  it("a todo given a deal and no client is the deal's client's follow-up; letting go of the client lets go of the deal (W11)", () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const id = deal(acme, 'Site rebuild');
    const contactOf = (t: string) => core.db.prepare('SELECT contact_id FROM todos WHERE id = ?').get(t);
    const linksOf = (t: string) => {
      const x = ok(todos.listTodos({ done: false })).todos.find((y) => y.id === t);
      return { contactId: x?.contactId, dealId: x?.dealId };
    };
    // Made with its deal alone: the deal's client is its client.
    const quote = ok(todos.createTodo({ title: 'Send the quote', dealId: id, due: { day: '2026-11-05', time: '15:00' } }, PHONE)).id;
    expect(linksOf(quote)).toEqual({ contactId: acme, dealId: id });
    expect(contactOf(quote)).toEqual({ contact_id: acme });
    // A plain todo given the deal later: the same.
    const chase = ok(todos.createTodo({ title: 'Chase' }, PHONE)).id;
    ok(todos.updateTodo(chase, { dealId: id }, PHONE));
    expect(linksOf(chase)).toEqual({ contactId: acme, dealId: id });
    expect(todos.followUps(acme, false).map((t) => t.id)).toEqual([quote, chase]);
    expect(ok(work.client(acme, PHONE)).followUps.map((t) => t.id)).toEqual([quote, chase]);
    // A client named with the deal stays (a person at the company, say).
    const riya = client('Riya Sharma', { companyId: acme });
    const call = ok(todos.createTodo({ title: 'Call Riya', contactId: riya, dealId: id }, PHONE)).id;
    expect(linksOf(call)).toEqual({ contactId: riya, dealId: id });
    // Letting go of the client lets go of the deal: no todo keeps a deal without a client.
    ok(todos.updateTodo(chase, { contactId: null }, PHONE));
    expect(linksOf(chase)).toEqual({ contactId: undefined, dealId: undefined });
    expect(contactOf(chase)).toEqual({ contact_id: null });
    // ...unless the same change names a deal, whose client comes with it.
    ok(todos.updateTodo(chase, { contactId: null, dealId: id }, PHONE));
    expect(linksOf(chase)).toEqual({ contactId: acme, dealId: id });
    // A deal that isn't there is still refused.
    expect(todos.createTodo({ title: 'Lost', dealId: '01JZZZZZZZZZZZZZZZZZZZZZZX' }, PHONE)).toMatchObject({ ok: false });
  });
});

describe('moves', () => {
  it('an open move writes a stage row and restarts its days in stage; the same stage is no change', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const id = deal(acme, 'Site rebuild');
    later(3);
    expect(card(id).daysInStage).toBe(3);
    expect(ok(work.moveDeal(id, { stage: 'proposal' }, PHONE))).toEqual({ id, from: 'new' });
    expect(card(id)).toMatchObject({ stage: 'proposal', stageName: 'Proposal sent', daysInStage: 0 });
    expect(hub(id).log.map((r) => [r.kind, r.stageFrom, r.stageTo])).toEqual([
      ['stage', 'new', 'proposal'],
      ['created', undefined, 'new'],
    ]);
    const n = core.changedCount;
    expect(ok(work.moveDeal(id, { stage: 'proposal' }, PHONE))).toEqual({ id, from: 'proposal' });
    expect(core.changedCount).toBe(n);
    expect(hub(id).log).toHaveLength(2);
  });

  it('Won stamps it, makes a lead a client, and makes its project with its client, business and the deal linked', () => {
    ok(work.settingsUpdate({ businesses: [{ name: 'Northwind Studio' }] }, PHONE));
    const business = ok(work.settingsGet(PHONE)).businesses[0]?.id as string;
    const acme = client('Acme Studio', { kind: 'company', folder: '/synthetic/work/acme' });
    const id = deal(acme, 'Site rebuild', { business, value: 100 });
    expect(work.moveDeal(id, { stage: 'proposal', project: { name: 'x' } }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.projectNeedsWon });
    expect(work.moveDeal(id, { stage: 'won', lostCode: 'price' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.reasonNeedsLost });
    const moved = ok(work.moveDeal(id, { stage: 'won', project: { name: 'Site rebuild', folder: '/synthetic/work/acme' } }, PHONE));
    expect(moved.from).toBe('new');
    const h = hub(id);
    expect(h.deal).toMatchObject({ stage: 'won', wonAt: '2026-11-03T09:00:00.000Z', projectId: moved.projectId });
    expect(h.card).toMatchObject({ kind: 'won', quiet: false });
    expect(h.card.closeState).toBeUndefined();
    expect(h.project).toMatchObject({ id: moved.projectId, name: 'Site rebuild', folder: '/synthetic/work/acme', clientId: acme, business });
    expect(work.contact(acme)?.state).toBe('client');
    // The project's hub carries the deal.
    expect(ok(work.projectPart(moved.projectId as string, acme, PHONE)).deal).toMatchObject({ id, kind: 'won' });
    // A second project for it is refused.
    expect(work.moveDeal(id, { stage: 'won', project: { name: 'Again' } }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.hasProject });
  });

  it("Won's project refused leaves the deal as it was (one save)", () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const id = deal(acme, 'Site rebuild');
    for (let i = 0; i < 500; i += 1) ok(todos.createProject({ name: `P${i}` }, PHONE));
    const r = work.moveDeal(id, { stage: 'won', project: { name: 'One too many' } }, PHONE);
    expect(r.ok).toBe(false);
    expect(hub(id).deal).toMatchObject({ stage: 'new' });
    expect(hub(id).deal.wonAt).toBeUndefined();
    expect(work.contact(acme)?.state).toBe('lead');
    expect(hub(id).log.map((r2) => r2.kind)).toEqual(['created']);
  });

  it('Lost takes a reason and never demotes a client; moved back, it is open again', () => {
    const acme = client('Acme Studio', { kind: 'company', state: 'client' });
    const id = deal(acme, 'Retainer', { stage: 'negotiation' });
    ok(work.moveDeal(id, { stage: 'lost', lostCode: 'price', lostNote: 'Went with a cheaper studio' }, PHONE));
    expect(hub(id).deal).toMatchObject({ stage: 'lost', lostAt: '2026-11-03T09:00:00.000Z', lostCode: 'price', lostNote: 'Went with a cheaper studio' });
    expect(work.contact(acme)?.state).toBe('client');
    // A reason changed on the lost deal: no new row.
    ok(work.moveDeal(id, { stage: 'lost', lostCode: 'timing' }, PHONE));
    expect(hub(id).deal.lostCode).toBe('timing');
    expect(hub(id).log.filter((r) => r.kind === 'stage')).toHaveLength(1);
    ok(work.updateDeal(id, { lostNote: null }, PHONE));
    expect(hub(id).deal.lostNote).toBeUndefined();
    later(1);
    expect(ok(work.moveDeal(id, { stage: 'contacted' }, PHONE)).from).toBe('lost');
    const d = hub(id).deal;
    expect(d.stage).toBe('contacted');
    for (const k of ['lostAt', 'lostCode', 'wonAt'] as const) expect(d[k]).toBeUndefined();
    expect(card(id).kind).toBe('open');
  });

  it('an unknown deal or stage is refused', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const id = deal(acme, 'Site rebuild');
    expect(work.moveDeal('01JZZZZZZZZZZZZZZZZZZZZZZX', { stage: 'won' }, PHONE)).toMatchObject({ ok: false, code: 'not_found', reason: WORK_REASONS.noDeal });
    expect(work.moveDeal(id, { stage: 'closed' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.noStage });
  });
});

describe('cards, the list and Today', () => {
  it("the next step is the deal's earliest todo, else its client's; none is flagged on Today", () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const globex = client('Globex', { kind: 'company' });
    const a = deal(acme, 'Site rebuild');
    const g = deal(globex, 'Audit', { expectedClose: '2026-11-05' });
    expect(card(a).next).toBeUndefined();
    const general = ok(work.addLog(acme, { kind: 'note', next: { title: 'Say hello', due: { day: '2026-11-10' } } }, PHONE)).todoId as string;
    expect(card(a).next).toMatchObject({ todoId: general, title: 'Say hello' });
    const own = ok(todos.createTodo({ title: 'Send quote', contactId: acme, dealId: a, due: { day: '2026-11-12' } }, PHONE)).id;
    expect(card(a).next).toMatchObject({ todoId: own, title: 'Send quote' });
    const w = work.today('2026-11-03').work;
    expect(w).toMatchObject({ noNextStep: 1, quiet: 0, closing: 1 });
    expect(card(g).closeState).toBe('soon');
  });

  it('quiet: no move and no touch with its client in the quiet days (a stage may set its own)', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const id = deal(acme, 'Site rebuild');
    later(13);
    expect(card(id).quiet).toBe(false);
    later(1);
    expect(card(id).quiet).toBe(true);
    expect(work.today('2026-11-17').work?.quiet).toBe(1);
    ok(work.addLog(acme, { kind: 'call' }, PHONE));
    expect(card(id).quiet).toBe(false);
    later(3);
    const stages = ok(work.stagesGet(PHONE)).stages.map((s) => ({ id: s.id, name: s.name, ...(s.id === 'new' ? { quietDays: 2 } : {}) }));
    ok(work.stagesPut({ stages }, PHONE));
    expect(card(id).quiet).toBe(true);
  });

  it('the list: open by default, by stage then close day; filters; closed ones newest first', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const globex = client('Globex', { kind: 'company' });
    const a = deal(acme, 'Site rebuild', { stage: 'proposal', expectedClose: '2026-12-20' });
    const b = deal(acme, 'Shop', { stage: 'proposal', expectedClose: '2026-11-06' });
    const c = deal(globex, 'Audit', { stage: 'new' });
    const d = deal(globex, 'Logo', { stage: 'new' });
    ok(work.moveDeal(d, { stage: 'lost' }, PHONE));
    const list = (q: Record<string, unknown> = {}) => ok(work.deals({ open: true, ...q } as never, PHONE)).deals.map((x) => x.id);
    expect(list()).toEqual([c, b, a]);
    expect(list({ stage: 'proposal' })).toEqual([b, a]);
    expect(list({ client: globex })).toEqual([c]);
    expect(list({ closing: 'week' })).toEqual([b]);
    expect(list({ closing: 'month' })).toEqual([b]);
    expect(list({ q: 'globex' })).toEqual([c]);
    expect(list({ q: 'SHOP' })).toEqual([b]);
    expect(list({ open: false })).toEqual([d]);
    expect(list({ quiet: true })).toEqual([]);
  });

  it("each stage's column: its open deals' value and weighted value per currency, never added across; Won and Lost for 30 days", () => {
    const acme = client('Acme Studio', { kind: 'company' });
    deal(acme, 'A', { stage: 'proposal', value: 100_000 });
    deal(acme, 'B', { stage: 'proposal', value: 50_000, currency: 'USD' });
    const won = deal(acme, 'C', { stage: 'negotiation', value: 200_000 });
    ok(work.moveDeal(won, { stage: 'won' }, PHONE));
    const cols = ok(work.deals({ open: true }, PHONE)).stages;
    expect(cols.map((x) => x.id)).toEqual(['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost']);
    const proposal = cols.find((x) => x.id === 'proposal');
    expect(proposal).toMatchObject({ probability: 60, count: 2, quiet: 0 });
    expect(proposal?.value).toEqual([
      { currency: 'INR', amount: 100_000 },
      { currency: 'USD', amount: 50_000 },
    ]);
    expect(proposal?.weighted).toEqual([
      { currency: 'INR', amount: 60_000 },
      { currency: 'USD', amount: 30_000 },
    ]);
    expect(cols.find((x) => x.id === 'won')).toMatchObject({ count: 1, value: [{ currency: 'INR', amount: 200_000 }] });
    later(31);
    expect(ok(work.deals({ open: true }, PHONE)).stages.find((x) => x.id === 'won')?.count).toBe(0);
  });

  it("a person's page lists its own deals and its company's; a company's, its own and its people's", () => {
    const riya = ok(work.createClient({ name: 'Riya Sharma', companyName: 'Acme Studio' }, PHONE));
    const co = riya.companyId as string;
    const mine = deal(riya.id, 'Workshop');
    const theirs = deal(co, 'Site rebuild');
    const other = client('Globex', { kind: 'company' });
    deal(other, 'Audit');
    expect(ok(work.client(riya.id, PHONE)).deals.map((x) => x.id).sort()).toEqual([mine, theirs].sort());
    expect(ok(work.client(co, PHONE)).deals.map((x) => x.id).sort()).toEqual([mine, theirs].sort());
  });

  it('search finds a deal by title or client; client_here lists its open deals; the deals CSV', () => {
    const acme = client('Acme Studio', { kind: 'company', folder: '/synthetic/work/acme' });
    const id = deal(acme, 'Site rebuild', { stage: 'proposal', value: 450_000, source: 'Referral' });
    const done = deal(acme, 'Old audit');
    ok(work.moveDeal(done, { stage: 'won' }, PHONE));
    const found = ok(work.search('rebuild', 5, PHONE)).deals;
    expect(found).toEqual([{ kind: 'deal', id, label: 'Site rebuild', sub: 'Acme Studio · Proposal sent', href: `/work?tab=deals&id=${id}` }]);
    expect(ok(work.search('acme', 5, PHONE)).deals.map((x) => x.id)).toEqual([id, done]);
    expect(work.forFolder('/synthetic/work/acme/web').client?.deals).toEqual([{ title: 'Site rebuild', stage: 'Proposal sent' }]);
    const csv = ok(work.exportCsv(PHONE, 'deals'));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Title,Client,Stage,Value,Currency,Expected close,Source,Business,Project,Added,In stage since,Won,Lost,Lost reason,Lost note');
    expect(lines).toHaveLength(3);
    expect(csv).toContain('Site rebuild,Acme Studio,Proposal sent,4500.00,INR,,Referral');
  });
});

describe('stages', () => {
  it('six by default, the open ones ramped 20 to 80', () => {
    const s = ok(work.stagesGet(PHONE));
    expect(s.stages.map((x) => [x.id, x.order, x.effectiveProbability])).toEqual([
      ['new', 0, 20],
      ['contacted', 1, 40],
      ['proposal', 2, 60],
      ['negotiation', 3, 80],
      ['won', 4, 100],
      ['lost', 5, 0],
    ]);
    expect(s.quietDays).toBe(14);
  });

  it('renamed, reordered and added; a probability kept when left out, cleared by null', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    deal(acme, 'Site rebuild', { stage: 'proposal' });
    ok(work.stagesPut({ stages: [{ id: 'new', name: 'Lead', probability: 10 }, { id: 'proposal', name: 'Quoted' }, { name: 'Demo' }, { id: 'contacted', name: 'Contacted' }, { id: 'negotiation', name: 'Negotiation' }, { id: 'won', name: 'Signed' }, { id: 'lost', name: 'Lost' }] }, PHONE));
    let s = ok(work.stagesGet(PHONE)).stages;
    expect(s.map((x) => x.name)).toEqual(['Lead', 'Quoted', 'Demo', 'Contacted', 'Negotiation', 'Signed', 'Lost']);
    expect(s[0]).toMatchObject({ probability: 10, effectiveProbability: 10 });
    expect(s[1]).toMatchObject({ deals: 1 });
    ok(work.stagesPut({ stages: s.map((x) => ({ id: x.id, name: x.name })) }, PHONE));
    expect(ok(work.stagesGet(PHONE)).stages[0]?.probability).toBe(10);
    ok(work.stagesPut({ stages: s.map((x) => ({ id: x.id, name: x.name, ...(x.id === 'new' ? { probability: null } : {}) })) }, PHONE));
    s = ok(work.stagesGet(PHONE)).stages;
    expect(s[0]?.probability).toBeUndefined();
  });

  it('a removed stage with deals needs an open stage that stays; an empty one goes freely', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const id = deal(acme, 'Site rebuild', { stage: 'contacted' });
    later(2);
    const keep = (ids: string[]) => ids.map((x) => ({ id: x, name: x }));
    expect(work.stagesPut({ stages: keep(['new', 'proposal', 'negotiation', 'won', 'lost']) }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.stageHasDeals });
    expect(work.stagesPut({ stages: keep(['new', 'proposal', 'negotiation', 'won', 'lost']), moves: [{ from: 'contacted', to: 'won' }] }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.moveToOpen });
    expect(ok(work.stagesPut({ stages: keep(['proposal', 'negotiation', 'won', 'lost']), moves: [{ from: 'contacted', to: 'proposal' }] }, PHONE))).toEqual({ moved: 1 });
    // Re-filed, not moved: no stage row, and its days in stage go on.
    expect(card(id)).toMatchObject({ stage: 'proposal', daysInStage: 2 });
    expect(hub(id).log.map((r) => r.kind)).toEqual(['created']);
  });

  it('Won and Lost are never removed; an unknown or doubled id is refused', () => {
    const keep = (ids: string[]) => ids.map((x) => ({ id: x, name: x }));
    expect(work.stagesPut({ stages: keep(['new', 'contacted', 'won']) }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.keepEnds });
    expect(work.stagesPut({ stages: keep(['new', 'zzz', 'won', 'lost']) }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.noStage });
    expect(work.stagesPut({ stages: keep(['new', 'new', 'won', 'lost']) }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.stageTwice });
    expect(ok(work.stagesGet(PHONE)).stages).toHaveLength(6);
  });
});

describe('insights', () => {
  it('no data is null, never 0%', () => {
    const r = ok(work.insights({ period: '90d' }, PHONE));
    expect(r.books).toEqual([]);
    expect(r.funnel.rows.every((x) => x.conversionRate === null)).toBe(true);
    expect(r.timeInStage.every((x) => x.averageDays === null)).toBe(true);
  });

  it('one book per currency (the Life currency first); win rate, cycle, losses and the funnel from the moves', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const a = deal(acme, 'A', { value: 100_000, source: 'Referral' });
    const b = deal(acme, 'B', { value: 50_000, source: 'Referral' });
    const c = deal(acme, 'C', { value: 7_000, currency: 'USD' });
    deal(acme, 'D', { value: 30_000, stage: 'proposal', expectedClose: '2026-12-15' });
    later(10);
    ok(work.moveDeal(a, { stage: 'proposal' }, PHONE));
    later(10);
    ok(work.moveDeal(a, { stage: 'won' }, PHONE));
    ok(work.moveDeal(b, { stage: 'lost', lostCode: 'price' }, PHONE));
    ok(work.moveDeal(c, { stage: 'won' }, PHONE));
    const r = ok(work.insights({ period: '90d' }, PHONE));
    expect(r.books.map((x) => x.currency)).toEqual(['INR', 'USD']);
    const inr = r.books[0];
    expect(inr?.winRate).toEqual({ won: 1, lost: 1, closed: 2, open: 1, rate: 0.5 });
    expect(inr?.cycle).toMatchObject({ averageDays: 20, sample: 1 });
    expect(inr?.losses).toEqual([{ code: 'price', label: 'Price', count: 1, value: 50_000, share: 1 }]);
    expect(inr?.sources[0]).toMatchObject({ source: 'Referral', deals: 2, won: 1, lost: 1, revenue: 100_000 });
    expect(inr?.revenueByMonth.at(-1)).toMatchObject({ month: '2026-11', value: 100_000, count: 1 });
    expect(inr?.forecast.months).toEqual([{ month: '2026-12', label: 'Dec 2026', value: 30_000, weighted: 18_000, count: 1 }]);
    expect(inr?.open).toEqual({ count: 1, value: 30_000, weighted: 18_000 });
    expect(r.books[1]?.winRate.rate).toBe(1);
    const funnel = Object.fromEntries(r.funnel.rows.map((x) => [x.stageId, x]));
    expect(funnel.new).toMatchObject({ entered: 3, exited: 3, advanced: 2, lostFrom: 1 });
    expect(funnel.proposal).toMatchObject({ entered: 2, exited: 1, advanced: 1 });
    expect(funnel.won).toMatchObject({ entered: 2 });
    const dwell = Object.fromEntries(r.timeInStage.map((x) => [x.stageId, x]));
    // In New: A 10 days, B and C 20 days each (both closed straight from it).
    expect(dwell.new).toMatchObject({ sample: 3, averageDays: 16.7, medianDays: 20 });
    expect(dwell.proposal).toMatchObject({ sample: 1, averageDays: 10, sittingCount: 1 });
  });

  it('a business filters every figure', () => {
    ok(work.settingsUpdate({ businesses: [{ name: 'Northwind Studio' }] }, PHONE));
    const business = ok(work.settingsGet(PHONE)).businesses[0]?.id as string;
    const acme = client('Acme Studio', { kind: 'company' });
    const a = deal(acme, 'A', { business });
    deal(acme, 'B');
    ok(work.moveDeal(a, { stage: 'won' }, PHONE));
    const r = ok(work.insights({ period: 'fy', business }, PHONE));
    expect(r.period.from).toBe('2026-04-01T00:00:00.000Z');
    expect(r.books[0]?.winRate).toMatchObject({ won: 1, open: 0 });
    expect(r.funnel.rows.find((x) => x.stageId === 'new')?.entered).toBe(1);
  });
});

describe('caps', () => {
  it('at most 500 open deals (a fixed sentence); a closed one moved back counts too', () => {
    const acme = client('Acme Studio', { kind: 'company' });
    const first = deal(acme, 'D0');
    ok(work.moveDeal(first, { stage: 'won' }, PHONE));
    for (let i = 1; i <= WORK_LIMITS.openDeals; i += 1) deal(acme, `D${i}`);
    expect(work.createDeal({ clientId: acme, title: 'One more' }, PHONE)).toMatchObject({ ok: false, code: 'conflict', reason: WORK_REASONS.openDealsFull });
    expect(work.moveDeal(first, { stage: 'new' }, PHONE)).toMatchObject({ ok: false, reason: WORK_REASONS.openDealsFull });
    expect(WORK_REASONS.openDealsFull).toBe('Work holds 500 open deals at most. Close some (Won or Lost) first.');
  });
});

describe('milestones', () => {
  it("set in order on his project; kept ids stay; the hub's progress names the missed ones and the next", () => {
    const p = ok(todos.createProject({ name: 'Site rebuild' }, PHONE)).id;
    expect(ok(work.projectPart(p, undefined, PHONE)).milestones).toBeUndefined();
    ok(work.setMilestones(p, { milestones: [{ name: 'Wireframes', target: '2026-11-01' }, { name: 'Build', target: '2026-11-20' }, { name: 'Launch' }] }, PHONE));
    let m = ok(work.projectPart(p, undefined, PHONE)).milestones;
    expect(m?.items.map((x) => x.name)).toEqual(['Wireframes', 'Build', 'Launch']);
    const [wire, build] = m?.items ?? [];
    expect(m).toMatchObject({ done: 0, percent: 0, missed: [wire?.id], next: wire?.id });
    ok(work.setMilestones(p, { milestones: [{ id: wire?.id, name: 'Wireframes', target: '2026-11-01', done: true }, { id: build?.id, name: 'Build', target: '2026-11-20' }, { id: '01JZZZZZZZZZZZZZZZZZZZZZZX', name: 'Launch' }] }, PHONE));
    m = ok(work.projectPart(p, undefined, PHONE)).milestones;
    expect(m?.items.map((x) => x.id).slice(0, 2)).toEqual([wire?.id, build?.id]);
    expect(m?.items[2]?.id).not.toBe('01JZZZZZZZZZZZZZZZZZZZZZZX');
    expect(m).toMatchObject({ done: 1, percent: 33, missed: [], next: build?.id });
    expect(m?.items[0]?.done).toBe(true);
    // A project edit keeps them; an empty list clears them.
    ok(todos.updateProject(p, { notes: 'Diwali launch' }, PHONE));
    expect(ok(work.projectPart(p, undefined, PHONE)).milestones?.items).toHaveLength(3);
    ok(work.setMilestones(p, { milestones: [] }, PHONE));
    expect(ok(work.projectPart(p, undefined, PHONE)).milestones).toBeUndefined();
  });

  it('never on a project that is not his: her space, a shared list, or none', () => {
    const HER = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(work.setMilestones('01JZZZZZZZZZZZZZZZZZZZZZZX', { milestones: [{ name: 'x' }] }, PHONE)).toMatchObject({ ok: false, code: 'not_found' });
    const hers = todos.inSpace(HER);
    const p = ok(hers.createProject({ name: 'Her project' }, { kind: 'person', personId: HER, deviceId: 'd' })).id;
    expect(hers.setMilestones(p, [{ id: p, name: 'x' }], PHONE)).toMatchObject({ ok: false, reason: 'Only your own projects can have milestones.' });
    expect(hers.milestones(p)).toBeNull();
    expect(work.setMilestones(p, { milestones: [{ name: 'x' }] }, PHONE)).toMatchObject({ ok: false, code: 'not_found' });
  });
});
