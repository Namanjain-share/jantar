/**
 * Finance (v0.4 spec 5.7): one call, `GET /v1/money?month=`.
 *
 *   Finance                                 +
 *   ‹  October 2026  ›                        MonthNav, › stops at this month
 *   Spent £1,850 · Income £3,000              mono
 *   BY CATEGORY   Food £420 / £500 ▬▬▬─       CategoryRow; a tap sets its budget
 *   BILLS         Example Stream £9 [Paid]    BillRow; a tap edits it
 *   ENTRIES       30 Oct  Groceries  £64      newest first; a tap edits it (Delete: 5 s Undo)
 *   [+ Expense]  [+ Income]
 *
 * Amounts are hundredths, shown through lib/money.ts. With no currency set
 * they are plain numbers and one line names the Mac command that sets one.
 * `bill` (from a bill's push or Today) opens that bill's Paid sheet. The
 * title is the page's <h1> in every state.
 */
import { PlusIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { Bill, MoneyEntry, MoneyKind } from '@jantar/protocol';
import { formatAmount } from '../../../../lib/money.js';
import { routePath } from '../../../../lib/router.js';
import { useDeps, useNavigate, useNow } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { RailLabel } from '../../../kit/RailLabel.js';
import { MonthNav, dayLabel } from '../shared/DayNav.js';
import { CommandSentence, EMPTY, LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { Loaded, Page, clockIn, useHeldDeletes, useOffline, useSheet, useUndo, useWrite } from '../today/parts.js';
import { BillRow } from './BillRow.js';
import { BillSheet, PaidSheet } from './BillSheet.js';
import { BudgetSheet, type BudgetTarget } from './BudgetSheet.js';
import { CategoryRow } from './CategoryRow.js';
import { MoneyEntrySheet } from './EntrySheet.js';
import { categoriesFor } from './fields.js';

export interface MoneyProps {
  month?: string | undefined;
  bill?: string | undefined;
}

/** With no currency set at the Mac (a literal code, so the CLI sentences test can run it). */
export const NO_CURRENCY = 'Amounts show as plain numbers. Set a currency at your Mac: jantar life set currency USD';

export function Money({ month, bill }: MoneyProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const nowMs = useNow(60_000);
  const load = useLifeLoad(`money:${month ?? 'now'}`, () => api.moneyMonth(month));
  const today = status?.today ?? clockIn(nowMs, status?.timezone).day;
  const current = today.slice(0, 7);
  const shown = load.data?.month ?? month ?? current;

  const entry = useSheet<MoneyEntry>();
  const [kind, setKind] = useState<MoneyKind>('expense');
  const budget = useSheet<BudgetTarget>();
  const billSheet = useSheet<Bill>();
  const paid = useSheet<Bill>();
  const undo = useUndo();
  const held = useHeldDeletes(undo);
  const remove = useWrite();
  const opened = useRef<string | null>(null);
  const target = bill ? load.data?.bills.find((b) => b.id === bill) : undefined;
  const { show: showPaid } = paid;

  useEffect(() => {
    if (!target || opened.current === target.id) return;
    opened.current = target.id;
    showPaid(target);
  }, [target, showPaid]);

  const add = (k: MoneyKind) => {
    setKind(k);
    entry.show(null);
  };
  /** A new entry's day: today in this month, else the 1st of the month shown. */
  const entryDay = shown === current ? today : `${shown}-01`;
  const deleteEntry = (e: MoneyEntry, currency: string | null) =>
    held.remove(e.id, `Deleted: ${e.category} ${formatAmount(e.amount, currency)}`, async () => {
      const r = await remove.run(`delete:${e.id}`, (key) => api.moneyDelete(e.id, key));
      if (r.ok) load.reload();
      return r.ok;
    });

  return (
    // One add control, "+ Expense" and "+ Income" under the entries: a header "+" too would say it twice,
    // and would open nothing before the month loads.
    <Page title="Finance" undo={undo}>
      <div className="px-8 pb-4">
        <MonthNav month={shown} current={current} onMonth={(m) => navigate(routePath(m === current ? { name: 'money' } : { name: 'money', month: m }), { replace: true })} />
      </div>
      <Loaded load={load}>
        {(m) => {
          const chips = categoriesFor('expense', m.categories);
          const entries = held.visible(m.entries, (e) => e.id);
          return (
            <>
              <p className="px-16 pb-12 type-mono text-ink">
                Spent {formatAmount(m.spent, m.currency)} · Income {formatAmount(m.income, m.currency)}
              </p>
              {m.currency === null ? <CommandSentence className="px-16 pb-12" sentence={NO_CURRENCY} /> : null}

              <section aria-label="By category">
                <RailLabel ground="bg">By category</RailLabel>
                {m.byCategory.length === 0 ? (
                  <LifeEmpty>No spending this month.</LifeEmpty>
                ) : (
                  <ul>
                    {m.byCategory.map((c) => (
                      <CategoryRow key={c.category} row={c} currency={m.currency} onOpen={() => budget.show({ category: c.category, budget: c.budget })} />
                    ))}
                  </ul>
                )}
                <div className="px-16 py-8">
                  <Button variant="text" size="sm" disabled={offline} onClick={() => budget.show({ category: '', budget: null })}>
                    <PlusIcon size={12} aria-hidden="true" />
                    Set a budget
                  </Button>
                </div>
              </section>

              <section aria-label="Bills">
                <RailLabel ground="bg" count={m.bills.length}>
                  Bills
                </RailLabel>
                {m.bills.length ? (
                  <ul>
                    {m.bills.map((b) => (
                      <BillRow key={b.id} bill={b} today={today} currency={m.currency} offline={offline} onOpen={() => billSheet.show(b)} onPaid={() => paid.show(b)} />
                    ))}
                  </ul>
                ) : (
                  <LifeEmpty>No bills yet. A bill pings on its due day, and Paid logs it.</LifeEmpty>
                )}
                <div className="px-16 py-8">
                  <Button variant="text" size="sm" disabled={offline} onClick={() => billSheet.show(null)}>
                    <PlusIcon size={12} aria-hidden="true" />
                    Add bill
                  </Button>
                </div>
              </section>

              <section aria-label="Entries">
                <RailLabel ground="bg" count={entries.length}>
                  Entries
                </RailLabel>
                {remove.error ? (
                  <div className="px-16">
                    <NotSaved error={remove.error} />
                  </div>
                ) : null}
                {entries.length === 0 ? <LifeEmpty>{EMPTY.money}</LifeEmpty> : <Entries entries={entries} currency={m.currency} onOpen={(e) => entry.show(e)} />}
              </section>

              <div className="flex gap-8 px-16 pt-12">
                <Button disabled={offline} onClick={() => add('expense')}>
                  <PlusIcon size={16} aria-hidden="true" />
                  Expense
                </Button>
                <Button disabled={offline} onClick={() => add('income')}>
                  <PlusIcon size={16} aria-hidden="true" />
                  Income
                </Button>
              </div>

              <MoneyEntrySheet
                open={entry.open}
                onOpenChange={entry.onOpenChange}
                sheetKey={entry.key}
                entry={entry.item}
                kind={kind}
                day={entryDay}
                currency={m.currency}
                categories={m.categories}
                incomeSeen={m.entries.filter((e) => e.kind === 'income').map((e) => e.category)}
                onSaved={load.reload}
                onDelete={(e) => deleteEntry(e, m.currency)}
              />
              <BudgetSheet open={budget.open} onOpenChange={budget.onOpenChange} sheetKey={budget.key} target={budget.item} currency={m.currency} chips={chips} onSaved={load.reload} />
              <BillSheet open={billSheet.open} onOpenChange={billSheet.onOpenChange} sheetKey={billSheet.key} bill={billSheet.item} today={today} currency={m.currency} chips={chips} onSaved={load.reload} />
              <PaidSheet open={paid.open} onOpenChange={paid.onOpenChange} sheetKey={paid.key} bill={paid.item} today={today} currency={m.currency} onSaved={load.reload} />
            </>
          );
        }}
      </Loaded>
    </Page>
  );
}

/** The month's entries, newest first: `30 Oct  Groceries  £64  milk, eggs`. */
function Entries({ entries, currency, onOpen }: { entries: readonly MoneyEntry[]; currency: string | null; onOpen: (e: MoneyEntry) => void }) {
  return (
    <ul aria-label="Entries">
      {entries.map((e) => (
        <li key={e.id} className="border-b border-line">
          <button type="button" onClick={() => onOpen(e)} className="flex min-h-44 w-full items-center gap-12 px-16 py-6 text-left transition-colors duration-120 ease-hover hover:bg-hover">
            <span className="w-48 flex-none type-mono text-ink-3">{dayLabel(e.day).replace(/^\S+ /, '')}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate type-row text-ink">{e.category}</span>
              {e.note ? <span className="block truncate type-small text-ink-2">{e.note}</span> : null}
            </span>
            <span className="flex-none type-mono text-ink">
              {e.kind === 'income' ? '+' : ''}
              {formatAmount(e.amount, currency)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
