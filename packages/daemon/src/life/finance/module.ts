/**
 * Finance and bills (spec 4.8; WP-FF): expenses and income by category and
 * month, an optional monthly budget per category, and monthly or yearly
 * bills that ping at 09:00 on their due day (pings.ts) and log an expense
 * when paid. No accounts, balances, imports or other currencies: amounts
 * are integer hundredths of the one currency (settings life.currency, a
 * label only), and the phone formats them.
 *
 * - A month is its entries newest first, the expense and income totals,
 *   the expense categories that have a spend or a budget (by spend), every
 *   bill by due day, and the category list for the picker: the defaults
 *   plus every category used in the last 12 months.
 * - A bill keeps its date in `byMonthDay` (set from nextDue on create and
 *   when nextDue is changed by hand), so Paid moves a bill due on the 31st
 *   to 28 Feb and then back to 31 Mar. Paid logs the expense (the bill's
 *   category and name, its amount unless the body gives one, `billId`) on
 *   the day given (default today) and moves nextDue a month or a year on.
 * - Caps answer conflict with a fixed sentence; every write ends with
 *   `core.changed()`; replies carry ids only.
 */
import { monthOf, shiftDay, shiftMonths } from '@jantar/life-core';
import {
  BillSchema,
  DEFAULT_CATEGORIES,
  LIFE_LIMITS,
  MoneyEntrySchema,
  type Bill,
  type BillBody,
  type BillPaidBody,
  type BillPatch,
  type BudgetBody,
  type MoneyBody,
  type MoneyEntry,
  type MoneyMonth,
  type MoneyPatch,
} from '@jantar/protocol';
import type { Actor, FinanceModule, LifeCore, LifeModuleDeps, LifeResult } from '../../contracts.js';
import { armBill, billPingHandler } from './pings.js';
import { FinanceRepo } from './repo.js';

export const FINANCE_SENTENCES = {
  noDay: 'That date does not exist.',
  noMonth: 'That month does not exist.',
  noEntry: 'That entry is gone.',
  noBill: 'That bill is gone.',
  monthFull: `You have ${LIFE_LIMITS.moneyPerMonth.toLocaleString('en')} entries that month. Delete one to add another.`,
  billsFull: `You have ${LIFE_LIMITS.bills} bills. Delete one to add another.`,
  invalid: 'That entry is not valid.',
  invalidBill: 'That bill is not valid.',
} as const;

/** How far ahead Today lists bills: due within this many days, or overdue. */
export const BILLS_AHEAD_DAYS = 3;
/** How far back a category stays in the picker. */
export const CATEGORY_MONTHS = 12;

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A day key that names a real date (the key's pattern lets 2026-02-31 through). */
function isRealDay(day: string): boolean {
  try {
    return shiftDay(day, 0) === day;
  } catch {
    return false;
  }
}

/** The date of the month of a day key (1 to 31). */
function dateOf(day: string): number {
  return Number(day.slice(8, 10));
}

/** Optional text with its spaces trimmed, or undefined when nothing is left. */
function text(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function fail(code: 'invalid_request' | 'not_found' | 'conflict', reason: string): LifeResult<never> {
  return { ok: false, code, reason };
}

function sortedUnique(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export function buildFinanceModule(core: LifeCore, deps: LifeModuleDeps): FinanceModule {
  const repo = new FinanceRepo(core, deps.ctx.log.child({ part: 'life', module: 'finance' }));
  core.scheduler.register(billPingHandler(core, repo));

  /** An entry with its note trimmed, and left out when empty. */
  const entryOf = (e: Omit<MoneyEntry, 'note'> & { note?: string | null | undefined }): MoneyEntry => {
    const { note, ...rest } = e;
    const n = text(note);
    return n === undefined ? rest : { ...rest, note: n };
  };

  const done = <T>(value: T): LifeResult<T> => {
    core.changed();
    return { ok: true, value };
  };

  return {
    name: 'finance',

    month(month?: string) {
      const today = core.today();
      const m = month ?? monthOf(today);
      if (!MONTH_KEY.test(m)) return fail('invalid_request', FINANCE_SENTENCES.noMonth);
      const entries = repo.entriesIn(m);
      let spent = 0;
      let income = 0;
      const byCat = new Map<string, number>();
      for (const e of entries) {
        if (e.kind === 'income') {
          income += e.amount;
          continue;
        }
        spent += e.amount;
        byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount);
      }
      const budgets = repo.budgets();
      const byCategory = [...new Set([...byCat.keys(), ...budgets.keys()])]
        .map((category) => ({ category, spent: byCat.get(category) ?? 0, budget: budgets.get(category) ?? null }))
        .sort((a, b) => b.spent - a.spent || a.category.localeCompare(b.category, 'en', { sensitivity: 'base' }));
      const defaults: string[] = [...DEFAULT_CATEGORIES.expense, ...DEFAULT_CATEGORIES.income];
      const used = sortedUnique(repo.categoriesSince(shiftMonths(today, -CATEGORY_MONTHS))).filter((c) => !defaults.includes(c));
      const value: MoneyMonth = {
        month: m,
        currency: core.settings().currency,
        entries,
        spent,
        income,
        byCategory,
        categories: [...new Set(defaults), ...used],
        bills: repo.bills(),
      };
      return { ok: true, value };
    },

    add(body: MoneyBody, _actor: Actor) {
      if (!isRealDay(body.day)) return fail('invalid_request', FINANCE_SENTENCES.noDay);
      if (repo.countIn(monthOf(body.day)) >= LIFE_LIMITS.moneyPerMonth) return fail('conflict', FINANCE_SENTENCES.monthFull);
      const now = core.now().toISOString();
      const entry = entryOf({ ...body, id: core.newId(), category: body.category.trim(), createdAt: now, updatedAt: now });
      if (!MoneyEntrySchema.safeParse(entry).success) return fail('invalid_request', FINANCE_SENTENCES.invalid);
      repo.putEntry(entry);
      return done({ id: entry.id });
    },

    update(id: string, patch: MoneyPatch, _actor: Actor) {
      const e = repo.entry(id);
      if (!e) return fail('not_found', FINANCE_SENTENCES.noEntry);
      const day = patch.day ?? e.day;
      if (!isRealDay(day)) return fail('invalid_request', FINANCE_SENTENCES.noDay);
      if (monthOf(day) !== monthOf(e.day) && repo.countIn(monthOf(day)) >= LIFE_LIMITS.moneyPerMonth) return fail('conflict', FINANCE_SENTENCES.monthFull);
      const next = entryOf({
        ...e,
        kind: patch.kind ?? e.kind,
        amount: patch.amount ?? e.amount,
        category: (patch.category ?? e.category).trim(),
        // null clears the note
        note: patch.note === undefined ? e.note : patch.note,
        day,
        updatedAt: core.now().toISOString(),
      });
      if (!MoneyEntrySchema.safeParse(next).success) return fail('invalid_request', FINANCE_SENTENCES.invalid);
      repo.putEntry(next);
      return done(true as const);
    },

    remove(id: string, _actor: Actor) {
      return repo.deleteEntry(id) ? done(true as const) : fail('not_found', FINANCE_SENTENCES.noEntry);
    },

    setBudget(body: BudgetBody, _actor: Actor) {
      repo.setBudget(body.category.trim(), body.amount);
      return done(true as const);
    },

    createBill(body: BillBody, _actor: Actor) {
      if (!isRealDay(body.nextDue)) return fail('invalid_request', FINANCE_SENTENCES.noDay);
      if (repo.billCount() >= LIFE_LIMITS.bills) return fail('conflict', FINANCE_SENTENCES.billsFull);
      const now = core.now().toISOString();
      const bill: Bill = {
        id: core.newId(),
        name: body.name.trim(),
        amount: body.amount,
        category: body.category.trim(),
        repeat: body.repeat,
        nextDue: body.nextDue,
        byMonthDay: dateOf(body.nextDue),
        createdAt: now,
        updatedAt: now,
      };
      if (!BillSchema.safeParse(bill).success) return fail('invalid_request', FINANCE_SENTENCES.invalidBill);
      repo.putBill(bill);
      armBill(core, repo, bill);
      return done({ id: bill.id });
    },

    updateBill(id: string, patch: BillPatch, _actor: Actor) {
      const b = repo.bill(id);
      if (!b) return fail('not_found', FINANCE_SENTENCES.noBill);
      if (patch.nextDue !== undefined && !isRealDay(patch.nextDue)) return fail('invalid_request', FINANCE_SENTENCES.noDay);
      const next: Bill = {
        ...b,
        name: (patch.name ?? b.name).trim(),
        amount: patch.amount ?? b.amount,
        category: (patch.category ?? b.category).trim(),
        repeat: patch.repeat ?? b.repeat,
        updatedAt: core.now().toISOString(),
      };
      // A due day set by hand is the bill's date from now on.
      if (patch.nextDue !== undefined) {
        next.nextDue = patch.nextDue;
        next.byMonthDay = dateOf(patch.nextDue);
      }
      if (!BillSchema.safeParse(next).success) return fail('invalid_request', FINANCE_SENTENCES.invalidBill);
      repo.putBill(next);
      armBill(core, repo, next);
      return done(true as const);
    },

    paid(id: string, body: BillPaidBody, _actor: Actor) {
      const day = body.day ?? core.today();
      if (!isRealDay(day)) return fail('invalid_request', FINANCE_SENTENCES.noDay);
      const result = core.db.tx((): LifeResult<{ id: string; bill: Bill }> => {
        const b = repo.bill(id);
        if (!b) return fail('not_found', FINANCE_SENTENCES.noBill);
        if (repo.countIn(monthOf(day)) >= LIFE_LIMITS.moneyPerMonth) return fail('conflict', FINANCE_SENTENCES.monthFull);
        const now = core.now().toISOString();
        const expense: MoneyEntry = {
          id: core.newId(),
          kind: 'expense',
          amount: body.amount ?? b.amount,
          category: b.category,
          note: b.name,
          day,
          billId: b.id,
          createdAt: now,
          updatedAt: now,
        };
        const moved: Bill = {
          ...b,
          nextDue: shiftMonths(b.nextDue, b.repeat === 'yearly' ? 12 : 1, b.byMonthDay ?? dateOf(b.nextDue)),
          updatedAt: now,
        };
        repo.putEntry(expense);
        repo.putBill(moved);
        return { ok: true, value: { id: expense.id, bill: moved } };
      });
      if (!result.ok) return result;
      armBill(core, repo, result.value.bill);
      return done({ id: result.value.id });
    },

    removeBill(id: string, _actor: Actor) {
      if (!repo.deleteBill(id)) return fail('not_found', FINANCE_SENTENCES.noBill);
      core.scheduler.clear('bill', id);
      core.scheduler.poke();
      return done(true as const);
    },

    /** Bills due within BILLS_AHEAD_DAYS of `day`, or overdue, by due day. */
    today(day: string) {
      const until = shiftDay(day, BILLS_AHEAD_DAYS);
      return { bills: repo.bills().filter((b) => b.nextDue <= until) };
    },
  };
}
