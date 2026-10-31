/**
 * The finance tables (life.db migration 1): `money` (one row per entry, with
 * month, day, kind, category and amount as columns for the month's totals;
 * the entry itself is `json`), `budgets` (category -> monthly amount) and
 * `bills` (next_due as a column, the bill as `json`). Amounts are integer
 * hundredths of the currency unit. Every json is checked with its protocol
 * schema on the way out; a row that fails is left out and logged by table
 * and id only. `core.db` is read on every call.
 */
import { BillSchema, MoneyEntrySchema, type Bill, type MoneyEntry } from '@jantar/protocol';
import { monthOf } from '@jantar/life-core';
import type { LifeCore, Logger } from '../../contracts.js';

type JsonRow = { id: string; json: string };

export class FinanceRepo {
  constructor(
    private readonly core: LifeCore,
    private readonly log: Logger,
  ) {}

  /** A month's entries, newest first (by day, then by when they were added). */
  entriesIn(month: string): MoneyEntry[] {
    const rows = this.core.db.prepare('SELECT id, json FROM money WHERE month = ? ORDER BY day DESC, rowid DESC').all(month) as JsonRow[];
    return rows.flatMap((r) => this.check(MoneyEntrySchema, 'money', r));
  }

  entry(id: string): MoneyEntry | null {
    const row = this.core.db.prepare('SELECT id, json FROM money WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? (this.check(MoneyEntrySchema, 'money', row)[0] ?? null) : null;
  }

  countIn(month: string): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM money WHERE month = ?').get(month) as { n: number }).n;
  }

  putEntry(e: MoneyEntry): void {
    this.core.db
      .prepare(
        'INSERT INTO money (id, month, day, kind, category, amount, json) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET month = excluded.month, day = excluded.day, kind = excluded.kind, category = excluded.category, amount = excluded.amount, json = excluded.json',
      )
      .run(e.id, monthOf(e.day), e.day, e.kind, e.category, e.amount, JSON.stringify(MoneyEntrySchema.parse(e)));
  }

  deleteEntry(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM money WHERE id = ?').run(id).changes) > 0;
  }

  /** Categories of entries on or after `fromDay`, any kind. */
  categoriesSince(fromDay: string): string[] {
    const rows = this.core.db.prepare('SELECT DISTINCT category FROM money WHERE day >= ?').all(fromDay) as { category: string }[];
    return rows.map((r) => r.category);
  }

  budgets(): Map<string, number> {
    const rows = this.core.db.prepare('SELECT category, amount FROM budgets').all() as { category: string; amount: number }[];
    return new Map(rows.map((r) => [r.category, r.amount]));
  }

  setBudget(category: string, amount: number | null): void {
    if (amount === null) this.core.db.prepare('DELETE FROM budgets WHERE category = ?').run(category);
    else this.core.db.prepare('INSERT INTO budgets (category, amount) VALUES (?, ?) ON CONFLICT (category) DO UPDATE SET amount = excluded.amount').run(category, amount);
  }

  /** Every bill, by next due day, then name. */
  bills(): Bill[] {
    const rows = this.core.db.prepare('SELECT id, json FROM bills ORDER BY next_due, id').all() as JsonRow[];
    return rows.flatMap((r) => this.check(BillSchema, 'bills', r)).sort((a, b) => cmp(a.nextDue, b.nextDue) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  }

  bill(id: string): Bill | null {
    const row = this.core.db.prepare('SELECT id, json FROM bills WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? (this.check(BillSchema, 'bills', row)[0] ?? null) : null;
  }

  /** The stored next_at of a bill's ping row (null: no row, or parked). */
  pingAt(id: string): string | null {
    const r = this.core.db.prepare("SELECT next_at FROM pings WHERE kind = 'bill' AND ref = ?").get(id) as { next_at: string | null } | undefined;
    return r?.next_at ?? null;
  }

  billCount(): number {
    return (this.core.db.prepare('SELECT COUNT(*) AS n FROM bills').get() as { n: number }).n;
  }

  putBill(b: Bill): void {
    this.core.db
      .prepare('INSERT INTO bills (id, next_due, json) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET next_due = excluded.next_due, json = excluded.json')
      .run(b.id, b.nextDue, JSON.stringify(BillSchema.parse(b)));
  }

  deleteBill(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM bills WHERE id = ?').run(id).changes) > 0;
  }

  private check<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, table: string, r: JsonRow): T[] {
    let json: unknown = null;
    try {
      json = JSON.parse(r.json);
    } catch {
      /* checked below */
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return [parsed.data];
    this.log.warn('life: a row failed its check and is left out', { table, id: r.id });
    return [];
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
