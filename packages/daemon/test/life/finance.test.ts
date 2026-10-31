/**
 * Finance and bills (spec 4.8, WP-FF): month totals, entries newest first,
 * spend by category against budgets, the category picker list, caps;
 * monthly and yearly bills that keep their date (the 31st clamps, then comes
 * back), Paid logging the expense and moving the due day; the bill pings
 * (LS3, bill part: armed for 09:00 on the due day, a deleted bill's row
 * removed, guards before sending) and their lock-screen text (LP4, bill
 * part: no name or amount unless lockScreenDetails is on); Finance's part of
 * Today; and the routes (ids only in write replies, target-only audit rows,
 * nothing on ctl.sock, no Life text in events, audit or logs).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_MARKER, billBody, moneyBody } from '@jantar/fixtures';
import { instantAt } from '@jantar/life-core';
import { DEFAULT_CATEGORIES, LIFE_LIMITS, MoneyMonthSchema, type Bill, type MoneyMonth, type Settings } from '@jantar/protocol';
import type { Actor, FinanceModule, LifeCore, LifeService, PingHandler, PingRow } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createPushSpy, createTestContext, createTestLifeCore, type TestLifeCore } from '../../src/core/testing.js';
import { FINANCE_SENTENCES, buildFinanceModule } from '../../src/life/finance/module.js';
import { formatAmount } from '../../src/life/finance/pings.js';
import { LifeScheduler } from '../../src/life/scheduler.js';
import { h, makeApi, makeFakes, pairCookie, type TestApi } from '../api/fakes.js';
import { V04_ON } from '../api/v04-helpers.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
/** 11:30 in Asia/Kolkata on 2026-10-30: past this morning's 09:00. */
const NOW = '2026-10-30T06:00:00.000Z';
const TODAY = '2026-10-30';
const TZ = 'Asia/Kolkata';
const GHOST = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';

let core: TestLifeCore | undefined;
let api: TestApi | undefined;
afterEach(async () => {
  core?.close();
  core = undefined;
  await api?.close();
  api = undefined;
});

function rig(settings: Partial<Settings['life']> = {}) {
  core = createTestLifeCore({ clock: new FakeClock(NOW), tz: TZ, settings: { finance: true, ...settings } });
  const ctx = createTestContext({ clock: core.clock });
  const f = makeFakes(ctx);
  const finance = buildFinanceModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
  const handler = core.scheduler.handlers.get('bill') as PingHandler;
  return { core, finance, handler };
}

function value<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

function month(finance: FinanceModule, m?: string): MoneyMonth {
  const v = value(finance.month(m));
  expect(MoneyMonthSchema.parse(v)).toEqual(v);
  return v;
}

const bill = (finance: FinanceModule, id: string): Bill => month(finance).bills.find((b) => b.id === id) as Bill;
const nineAt = (day: string, tz = TZ) => instantAt(day, '09:00', tz).toISOString();

describe('entries and the month', () => {
  it('totals spend and income for the month, entries newest first, other months left out', () => {
    const { core, finance } = rig();
    const groceries = value(finance.add(moneyBody({ day: '2026-10-02' }), PHONE)).id;
    const salary = value(finance.add(moneyBody({ kind: 'income', amount: 5_000_000, category: 'Salary', note: 'October', day: '2026-10-01' }), PHONE)).id;
    const lunch = value(finance.add(moneyBody({ amount: 50_000, category: 'Food', day: '2026-10-15' }), PHONE)).id;
    const dinner = value(finance.add(moneyBody({ amount: 30_000, category: 'Food', day: '2026-10-28' }), PHONE)).id;
    value(finance.add(moneyBody({ amount: 999, day: '2026-11-01' }), PHONE));
    const oct = month(finance);
    expect(oct).toMatchObject({ month: '2026-10', currency: null, spent: 204_000, income: 5_000_000 });
    expect(oct.entries.map((e) => e.id)).toEqual([dinner, lunch, groceries, salary]);
    expect(oct.entries[2]).toEqual({ id: groceries, kind: 'expense', amount: 124_000, category: 'Groceries', note: 'milk, eggs', day: '2026-10-02', createdAt: NOW, updatedAt: NOW });
    expect(month(finance, '2026-11')).toMatchObject({ spent: 999, income: 0 });
    expect(month(finance, '2026-09')).toMatchObject({ entries: [], spent: 0, income: 0, byCategory: [] });
    expect(core.changedCount).toBe(5);
  });

  it('entries on the same day: the one added last first', () => {
    const { finance } = rig();
    const first = value(finance.add(moneyBody({ day: TODAY }), PHONE)).id;
    const second = value(finance.add(moneyBody({ day: TODAY }), PHONE)).id;
    expect(month(finance).entries.map((e) => e.id)).toEqual([second, first]);
  });

  it('spend by expense category with its budget, by spend; a budget with no spend is listed; income is not', () => {
    const { finance } = rig();
    value(finance.add(moneyBody({ amount: 124_000, category: 'Groceries' }), PHONE));
    value(finance.add(moneyBody({ amount: 50_000, category: 'Food' }), PHONE));
    value(finance.add(moneyBody({ amount: 30_000, category: 'Food' }), PHONE));
    value(finance.add(moneyBody({ kind: 'income', amount: 9_000, category: 'Salary' }), PHONE));
    expect(finance.setBudget({ category: 'Food', amount: 60_000 }, PHONE)).toEqual({ ok: true, value: true });
    value(finance.setBudget({ category: 'Transport', amount: 20_000 }, PHONE));
    expect(month(finance).byCategory).toEqual([
      { category: 'Groceries', spent: 124_000, budget: null },
      { category: 'Food', spent: 80_000, budget: 60_000 },
      { category: 'Transport', spent: 0, budget: 20_000 },
    ]);
    value(finance.setBudget({ category: 'Food', amount: 90_000 }, PHONE));
    value(finance.setBudget({ category: 'Transport', amount: null }, PHONE));
    expect(month(finance).byCategory).toEqual([
      { category: 'Groceries', spent: 124_000, budget: null },
      { category: 'Food', spent: 80_000, budget: 90_000 },
    ]);
  });

  it('the picker: the default categories, then every other one used in the last 12 months', () => {
    const { finance } = rig();
    value(finance.add(moneyBody({ category: 'Snacks', day: '2026-03-02' }), PHONE));
    value(finance.add(moneyBody({ category: 'Books', day: '2026-10-01' }), PHONE));
    value(finance.add(moneyBody({ category: 'Groceries', day: '2026-10-01' }), PHONE));
    value(finance.add(moneyBody({ category: 'Old Hobby', day: '2025-10-29' }), PHONE));
    const defaults = [...new Set<string>([...DEFAULT_CATEGORIES.expense, ...DEFAULT_CATEGORIES.income])];
    expect(month(finance).categories).toEqual([...defaults, 'Books', 'Snacks']);
    expect(defaults.filter((c) => c === 'Other')).toHaveLength(1);
  });

  it('carries the currency from the settings (a label only)', () => {
    const { finance } = rig({ currency: 'INR' });
    expect(month(finance).currency).toBe('INR');
  });

  it('changes an entry (a new day moves it to that month; null clears the note) and deletes one', () => {
    const { core, finance } = rig();
    const { id } = value(finance.add(moneyBody(), PHONE));
    core.clock.advance(1000);
    expect(finance.update(id, { day: '2026-09-30', note: null, category: '  Fun ', amount: 100 }, PHONE)).toEqual({ ok: true, value: true });
    expect(month(finance).entries).toEqual([]);
    const sep = month(finance, '2026-09');
    expect(sep.entries[0]).toEqual({ id, kind: 'expense', amount: 100, category: 'Fun', day: '2026-09-30', createdAt: NOW, updatedAt: '2026-10-30T06:00:01.000Z' });
    expect(core.db.prepare('SELECT month, day, category, amount FROM money WHERE id = ?').get(id)).toEqual({ month: '2026-09', day: '2026-09-30', category: 'Fun', amount: 100 });
    expect(finance.remove(id, PHONE)).toEqual({ ok: true, value: true });
    expect(finance.remove(id, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FINANCE_SENTENCES.noEntry });
    expect(finance.update(GHOST, { amount: 1 }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FINANCE_SENTENCES.noEntry });
  });

  it('refuses a day or month that does not exist', () => {
    const { finance } = rig();
    expect(finance.add(moneyBody({ day: '2026-02-30' }), PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: FINANCE_SENTENCES.noDay });
    expect(finance.month('2026-13')).toEqual({ ok: false, code: 'invalid_request', reason: FINANCE_SENTENCES.noMonth });
  });

  it(`caps a month at ${LIFE_LIMITS.moneyPerMonth} entries: adding, moving or paying into it is refused`, () => {
    const { core, finance } = rig();
    const db = core.db;
    db.tx(() => {
      for (let i = 0; i < LIFE_LIMITS.moneyPerMonth; i++) {
        const id = core.newId();
        db.prepare('INSERT INTO money (id, month, day, kind, category, amount, json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          id,
          '2026-10',
          '2026-10-01',
          'expense',
          'Food',
          1,
          JSON.stringify({ id, kind: 'expense', amount: 1, category: 'Food', day: '2026-10-01', createdAt: NOW, updatedAt: NOW }),
        );
      }
    });
    expect(finance.add(moneyBody(), PHONE)).toEqual({ ok: false, code: 'conflict', reason: FINANCE_SENTENCES.monthFull });
    const nov = value(finance.add(moneyBody({ day: '2026-11-02' }), PHONE)).id;
    expect(finance.update(nov, { day: '2026-10-05' }, PHONE)).toEqual({ ok: false, code: 'conflict', reason: FINANCE_SENTENCES.monthFull });
    const b = value(finance.createBill(billBody(), PHONE)).id;
    expect(finance.paid(b, {}, PHONE)).toEqual({ ok: false, code: 'conflict', reason: FINANCE_SENTENCES.monthFull });
    expect(bill(finance, b).nextDue).toBe('2026-11-03');
  });
});

describe('bills', () => {
  it('keeps its date from nextDue; lists every bill by due day; a hand-set nextDue is the new date', () => {
    const { core, finance } = rig();
    const late = value(finance.createBill(billBody({ name: 'Example Rent', nextDue: '2026-11-05' }), PHONE)).id;
    const { id } = value(finance.createBill(billBody(), PHONE));
    expect(month(finance).bills.map((b) => b.id)).toEqual([id, late]);
    expect(bill(finance, id)).toEqual({
      id,
      name: 'Example Stream',
      amount: 64_900,
      category: 'Bills',
      repeat: 'monthly',
      nextDue: '2026-11-03',
      byMonthDay: 3,
      createdAt: NOW,
      updatedAt: NOW,
    });
    core.clock.advance(1000);
    expect(finance.updateBill(id, { nextDue: '2026-11-30', amount: 69_900 }, PHONE)).toEqual({ ok: true, value: true });
    expect(bill(finance, id)).toMatchObject({ nextDue: '2026-11-30', byMonthDay: 30, amount: 69_900, updatedAt: '2026-10-30T06:00:01.000Z' });
    value(finance.updateBill(id, { name: 'Renamed' }, PHONE));
    expect(bill(finance, id)).toMatchObject({ name: 'Renamed', byMonthDay: 30 });
    expect(finance.updateBill(GHOST, { amount: 1 }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FINANCE_SENTENCES.noBill });
    expect(finance.createBill(billBody({ nextDue: '2026-02-31' }), PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: FINANCE_SENTENCES.noDay });
  });

  it('Paid logs the expense (category, amount, the name as its note, billId; today) and moves nextDue a month on; the reply is its id', () => {
    const { finance } = rig();
    const { id } = value(finance.createBill(billBody(), PHONE));
    const paid = value(finance.paid(id, {}, PHONE));
    const entries = month(finance).entries;
    expect(entries).toEqual([
      { id: paid.id, kind: 'expense', amount: 64_900, category: 'Bills', note: 'Example Stream', day: TODAY, billId: id, createdAt: NOW, updatedAt: NOW },
    ]);
    expect(bill(finance, id).nextDue).toBe('2026-12-03');
    // Another amount and day.
    value(finance.paid(id, { day: '2026-10-29', amount: 70_000 }, PHONE));
    expect(month(finance).entries.find((e) => e.day === '2026-10-29')).toMatchObject({ amount: 70_000, billId: id });
    expect(bill(finance, id).nextDue).toBe('2027-01-03');
    expect(finance.paid(GHOST, {}, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FINANCE_SENTENCES.noBill });
  });

  it('the 31st: due 28 Feb after 31 Jan, then 31 Mar again', () => {
    const { finance } = rig();
    const { id } = value(finance.createBill(billBody({ nextDue: '2027-01-31' }), PHONE));
    const due = () => bill(finance, id).nextDue;
    value(finance.paid(id, {}, PHONE));
    expect(due()).toBe('2027-02-28');
    value(finance.paid(id, {}, PHONE));
    expect(due()).toBe('2027-03-31');
    value(finance.paid(id, {}, PHONE));
    expect(due()).toBe('2027-04-30');
  });

  it('a yearly bill moves a year on; one on 29 Feb keeps its date for the next leap year', () => {
    const { finance } = rig();
    const yearly = value(finance.createBill(billBody({ repeat: 'yearly', nextDue: '2027-03-15' }), PHONE)).id;
    value(finance.paid(yearly, {}, PHONE));
    expect(bill(finance, yearly).nextDue).toBe('2028-03-15');
    const leap = value(finance.createBill(billBody({ repeat: 'yearly', nextDue: '2028-02-29' }), PHONE)).id;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      value(finance.paid(leap, {}, PHONE));
      seen.push(bill(finance, leap).nextDue);
    }
    expect(seen).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });

  it('deletes a bill; its paid expenses stay', () => {
    const { finance } = rig();
    const { id } = value(finance.createBill(billBody(), PHONE));
    value(finance.paid(id, {}, PHONE));
    expect(finance.removeBill(id, PHONE)).toEqual({ ok: true, value: true });
    expect(month(finance)).toMatchObject({ bills: [], spent: 64_900 });
    expect(finance.removeBill(id, PHONE)).toEqual({ ok: false, code: 'not_found', reason: FINANCE_SENTENCES.noBill });
  });

  it(`caps bills at ${LIFE_LIMITS.bills}`, () => {
    const { finance } = rig();
    for (let i = 0; i < LIFE_LIMITS.bills; i++) value(finance.createBill(billBody({ name: `Bill ${i}` }), PHONE));
    expect(finance.createBill(billBody(), PHONE)).toEqual({ ok: false, code: 'conflict', reason: FINANCE_SENTENCES.billsFull });
  });
});

describe('bill pings (LS3, bill part)', () => {
  it('registers the bill handler; a bill rings at 09:00 (Life zone) on its due day', () => {
    const { core, finance, handler } = rig();
    expect(handler.kind).toBe('bill');
    const { id } = value(finance.createBill(billBody({ nextDue: '2026-10-31' }), PHONE));
    expect(core.scheduler.row('bill', id)?.nextAt).toBe(nineAt('2026-10-31'));
    expect(nineAt('2026-10-31')).toBe('2026-10-31T03:30:00.000Z');
    expect(core.scheduler.pokes).toBeGreaterThan(0);
  });

  it('a 09:00 already gone is not armed: a bill due today, added at 11:30, rings no more today (Today lists it)', () => {
    const { core, finance } = rig();
    const { id } = value(finance.createBill(billBody({ nextDue: TODAY }), PHONE));
    expect(core.scheduler.row('bill', id)?.nextAt).toBeNull();
    expect(finance.today(TODAY).bills?.map((b) => b.id)).toEqual([id]);
  });

  it('Paid and a new due day move the row; a deleted bill has no row', () => {
    const { core, finance } = rig();
    const { id } = value(finance.createBill(billBody(), PHONE));
    expect(core.scheduler.row('bill', id)?.nextAt).toBe(nineAt('2026-11-03'));
    value(finance.paid(id, {}, PHONE));
    expect(core.scheduler.row('bill', id)?.nextAt).toBe(nineAt('2026-12-03'));
    value(finance.updateBill(id, { nextDue: '2026-11-20' }, PHONE));
    expect(core.scheduler.row('bill', id)?.nextAt).toBe(nineAt('2026-11-20'));
    value(finance.removeBill(id, PHONE));
    expect(core.scheduler.row('bill', id)).toBeUndefined();
    expect(core.scheduler.calls.at(-1)).toEqual({ op: 'clear', kind: 'bill', ref: id });
  });

  it('check: send when due; a deleted bill cancels; a due day changed since skips; a row that already rang skips', () => {
    const { core, finance, handler } = rig();
    const { id } = value(finance.createBill(billBody(), PHONE));
    const row = core.scheduler.row('bill', id) as PingRow;
    const dueAt = new Date(nineAt('2026-11-03'));
    expect(handler.check(row, dueAt, false)).toBe('send');
    expect(handler.check(row, dueAt, true)).toBe('send');
    expect(handler.check({ ...row, lastSentAt: nineAt('2026-11-03') }, dueAt, false)).toBe('skip');
    expect(handler.check({ ...row, lastSentAt: nineAt('2026-10-03') }, dueAt, false)).toBe('send');
    value(finance.paid(id, {}, PHONE));
    expect(handler.check(row, dueAt, false)).toBe('skip');
    value(finance.removeBill(id, PHONE));
    expect(handler.check(row, dueAt, false)).toBe('cancel');
    expect(handler.next(row, dueAt)).toBeNull();
  });

  it('under the real scheduler: a catch-up whose send fails at start stays due through the resync, and the next sweep sends it once', async () => {
    const clock = new FakeClock(NOW);
    core = createTestLifeCore({ clock, tz: TZ, settings: { finance: true } });
    const ctx = createTestContext({ clock });
    const spy = createPushSpy({ delivered: 0, failed: 1 });
    const sched = new LifeScheduler(clock, ctx.log, () => (core as TestLifeCore).db, { send: spy.send });
    (core as LifeCore).scheduler = sched;
    const f = makeFakes(ctx);
    const finance = buildFinanceModule(core, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
    try {
      const { id } = value(finance.createBill(billBody({ nextDue: '2026-10-31' }), PHONE));
      // The Mac sleeps over tomorrow's 09:00; at 11:00 start() sweeps (the catch-up), then resyncs.
      clock.set(instantAt('2026-10-31', '11:00', TZ).toISOString());
      sched.start();
      await sched.settled();
      expect(spy.pushes.map((p) => p.body)).toEqual(['Missed at 09:00 · Due today']);
      expect(sched.rows('bill')[0]).toMatchObject({ ref: id, nextAt: nineAt('2026-10-31'), failures: 1 });
      // An edit that keeps the due day leaves it due too.
      value(finance.updateBill(id, { amount: 1000 }, PHONE));
      expect(sched.rows('bill')[0]?.nextAt).toBe(nineAt('2026-10-31'));

      spy.result = { delivered: 1, failed: 0 };
      sched.sweep();
      await sched.settled();
      expect(spy.pushes).toHaveLength(2);
      expect(sched.rows('bill')[0]).toMatchObject({ nextAt: null });
      sched.sweep();
      await sched.settled();
      expect(spy.pushes).toHaveLength(2);
    } finally {
      sched.stop();
    }
  });

  it('resync rebuilds every row from the bills, in the zone in force', () => {
    const { core, finance, handler } = rig();
    const a = value(finance.createBill(billBody({ nextDue: '2026-11-03' }), PHONE)).id;
    const b = value(finance.createBill(billBody({ nextDue: '2026-12-01', repeat: 'yearly' }), PHONE)).id;
    core.scheduler.rows.clear();
    handler.resync();
    expect(core.scheduler.row('bill', a)?.nextAt).toBe(nineAt('2026-11-03'));
    expect(core.scheduler.row('bill', b)?.nextAt).toBe(nineAt('2026-12-01'));
    core.setSettings({ timezone: 'America/New_York' });
    handler.resync();
    expect(core.scheduler.row('bill', a)?.nextAt).toBe(nineAt('2026-11-03', 'America/New_York'));
  });
});

describe('the lock screen (LP4, bill part)', () => {
  it('by default: "Bill due", "Due today", ids only in the url and tag; no name or amount anywhere', () => {
    const { core, finance, handler } = rig({ currency: 'INR' });
    const { id } = value(finance.createBill(billBody({}, { marked: true }), PHONE));
    const row = core.scheduler.row('bill', id) as PingRow;
    const push = handler.push([row], new Date(nineAt('2026-11-03')), false);
    expect(push).toEqual({ kind: 'life', title: 'Bill due', body: 'Due today', url: `/money?bill=${id}`, tag: `life:bill:${id}` });
    const text = JSON.stringify(push);
    for (const leak of ['Example Stream', LIFE_MARKER, '649', '₹']) expect(text, leak).not.toContain(leak);
  });

  it('with lockScreenDetails on: the name and the amount in the currency, or a plain amount with none', () => {
    const { core, finance, handler } = rig({ currency: 'INR', lockScreenDetails: true });
    const { id } = value(finance.createBill(billBody(), PHONE));
    const row = core.scheduler.row('bill', id) as PingRow;
    const dueAt = new Date(nineAt('2026-11-03'));
    expect(handler.push([row], dueAt, false).body).toBe('Example Stream · ₹649.00');
    core.setSettings({ currency: null });
    expect(handler.push([row], dueAt, false).body).toBe('Example Stream · 649.00');
  });

  it('late: "Missed at 09:00 · " before the body', () => {
    const { core, finance, handler } = rig();
    const { id } = value(finance.createBill(billBody(), PHONE));
    const row = core.scheduler.row('bill', id) as PingRow;
    expect(handler.push([row], new Date(nineAt('2026-11-03')), true)).toMatchObject({ title: 'Bill due', body: 'Missed at 09:00 · Due today' });
  });

  it('two bills in one push: a count, no names even with details on', () => {
    const { core, finance, handler } = rig({ currency: 'INR', lockScreenDetails: true });
    const a = value(finance.createBill(billBody(), PHONE)).id;
    const b = value(finance.createBill(billBody({ name: 'Example Cloud' }), PHONE)).id;
    const rows = [core.scheduler.row('bill', a), core.scheduler.row('bill', b)] as PingRow[];
    const push = handler.push(rows, new Date(nineAt('2026-11-03')), false);
    expect(push).toEqual({ kind: 'life', title: 'Bills due · 2', body: 'Due today', url: '/money', tag: 'life:bill' });
  });

  it('formatAmount: hundredths in the currency (any currency), or two decimals with none', () => {
    expect(formatAmount(64_900, 'INR')).toBe('₹649.00');
    expect(formatAmount(64_900, 'USD')).toBe('$649.00');
    expect(formatAmount(123_400, 'JPY')).toBe('¥1,234');
    expect(formatAmount(64_900, null)).toBe('649.00');
  });
});

describe("Finance's part of Today", () => {
  it('bills due within 3 days or overdue, by due day', () => {
    const { finance } = rig();
    const overdue = value(finance.createBill(billBody({ name: 'Overdue', nextDue: '2026-10-20' }), PHONE)).id;
    const soon = value(finance.createBill(billBody({ name: 'Soon', nextDue: '2026-11-02' }), PHONE)).id;
    const today = value(finance.createBill(billBody({ name: 'Today', nextDue: TODAY }), PHONE)).id;
    value(finance.createBill(billBody({ name: 'Later', nextDue: '2026-11-03' }), PHONE));
    expect(finance.today(TODAY).bills?.map((b) => b.id)).toEqual([overdue, today, soon]);
  });
});

describe('finance routes', () => {
  async function financeApi() {
    let built: TestLifeCore | undefined;
    api = await makeApi({
      ctx: { settings: V04_ON, clock: new FakeClock(NOW) },
      deps: (ctx, f) => {
        built = createTestLifeCore({ clock: ctx.clock, tz: TZ, settings: { finance: true } });
        const finance = buildFinanceModule(built, { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy });
        return { life: notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, finance }) };
      },
    });
    core = built;
    const { cookie } = await pairCookie(api, ['read', 'control']);
    return { api, cookie };
  }

  it('write replies are ids or ok (billPaid: the new expense); the month reads back; audit rows hold the target id; no text anywhere', async () => {
    const { api, cookie } = await financeApi();
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      api.tcp.inject({ method, url, headers: h(cookie), ...(payload ? { payload } : {}) });
    const add = await call('POST', '/v1/money', moneyBody({ day: TODAY }, { marked: true }));
    const entry = (add.json() as { id: string }).id;
    expect(add.json()).toEqual({ id: entry });
    expect((await call('PATCH', `/v1/money/${entry}`, { note: `fresh ${LIFE_MARKER}` })).json()).toEqual({ ok: true });
    expect((await call('PUT', '/v1/money/budgets', { category: `C ${LIFE_MARKER}`, amount: 100_000 })).json()).toEqual({ ok: true });
    const created = await call('POST', '/v1/bills', billBody({}, { marked: true }));
    const billId = (created.json() as { id: string }).id;
    expect(created.json()).toEqual({ id: billId });
    expect((await call('PATCH', `/v1/bills/${billId}`, { amount: 70_000 })).json()).toEqual({ ok: true });
    const paid = await call('POST', `/v1/bills/${billId}/paid`, {});
    const expense = (paid.json() as { id: string }).id;
    expect(paid.json()).toEqual({ id: expense });
    const m = MoneyMonthSchema.parse((await call('GET', '/v1/money?month=2026-10')).json());
    expect(m.entries.map((e) => e.id).sort()).toEqual([entry, expense].sort());
    expect(m.entries.find((e) => e.id === expense)).toMatchObject({ billId, amount: 70_000 });
    expect(m.bills.map((b) => [b.id, b.nextDue])).toEqual([[billId, '2026-12-03']]);
    expect((await call('DELETE', `/v1/bills/${billId}`)).json()).toEqual({ ok: true });
    expect((await call('DELETE', `/v1/money/${entry}`)).json()).toEqual({ ok: true });

    const audit = api.ctx.db.audit.list().filter((a) => /^(money|budget|bill)/.test(a.action));
    expect(audit.map((a) => [a.action, a.target ?? null])).toEqual([
      ['moneyAdd', entry],
      ['moneyUpdate', entry],
      ['budgetSet', null],
      ['billCreate', billId],
      ['billUpdate', billId],
      ['billPaid', billId],
      ['billDelete', billId],
      ['moneyDelete', entry],
    ]);
    for (const a of audit) expect(a.params).toEqual({});
    const r = api.ctx.store.replay(0);
    expect(JSON.stringify([r.kind === 'events' ? r.events : [], api.ctx.db.audit.list(), api.ctx.log.records])).not.toContain(LIFE_MARKER);
  });

  it('404 with the fixed sentence for an unknown bill; 400 for a bad amount, month or repeat; not on ctl.sock', async () => {
    const { api, cookie } = await financeApi();
    const ghost = await api.tcp.inject({ method: 'POST', url: `/v1/bills/${GHOST}/paid`, headers: h(cookie), payload: {} });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error).toEqual({ code: 'not_found', message: FINANCE_SENTENCES.noBill });
    for (const payload of [moneyBody({ amount: 0 }), moneyBody({ amount: 1.5 }), { ...moneyBody(), extra: 1 }]) {
      expect((await api.tcp.inject({ method: 'POST', url: '/v1/money', headers: h(cookie), payload })).statusCode).toBe(400);
    }
    expect((await api.tcp.inject({ method: 'POST', url: '/v1/bills', headers: h(cookie), payload: { ...billBody(), repeat: 'weekly' } })).statusCode).toBe(400);
    expect((await api.tcp.inject({ method: 'GET', url: '/v1/money?month=2026-13', headers: h(cookie) })).statusCode).toBe(400);
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/money' })).statusCode).toBe(404);
    expect((await api.ctl.inject({ method: 'POST', url: '/v1/bills', payload: billBody() })).statusCode).toBe(404);
  });
});
