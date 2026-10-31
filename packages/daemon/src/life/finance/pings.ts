/**
 * Bill pings (spec 4.8, 4.3): kind `bill`, one row per bill, ringing at
 * 09:00 (Life zone) on its due day; Paid moves the due day and sets the next
 * one. The scheduler sends; this file says when and what.
 *
 * - A row is armed only for a 09:00 still ahead. A bill added or moved
 *   after 09:00 on its due day shows on Today without a push; one that came
 *   due while the Mac slept is caught up by the scheduler (its row was
 *   armed before, and the start sweep runs before resync); a row still
 *   due for that 09:00 is left to the scheduler, so a failed send is retried.
 * - check: a deleted bill cancels the row; a due day changed since the row
 *   was set (Paid, an edit) skips it, and so does a row that already rang
 *   for this due time.
 * - The lock screen says "Bill due" with no name or amount unless
 *   life.lockScreenDetails is on at the Mac; then "Example Stream ·
 *   ₹649.00" (the one place the daemon formats money).
 */
import { hhmmOf, instantAt } from '@jantar/life-core';
import type { Bill } from '@jantar/protocol';
import type { LifeCore, LifePush, PingHandler, PingRow } from '../../contracts.js';
import type { FinanceRepo } from './repo.js';

/** When a bill rings on its due day, in the Life zone. */
export const BILL_PING_TIME = '09:00';

/** An amount in hundredths as the lock screen shows it: Intl currency, or a plain number with two decimals. */
export function formatAmount(amount: number, currency: string | null): string {
  const value = amount / 100;
  if (currency) {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency }).format(value);
    } catch {
      /* a code this runtime does not know: the plain number */
    }
  }
  return value.toFixed(2);
}

/** The instant a bill due on `nextDue` rings. */
export function billDueAt(core: LifeCore, nextDue: string): Date {
  return instantAt(nextDue, BILL_PING_TIME, core.tz());
}

/**
 * A bill's row: armed for its 09:00 while that is still ahead, else parked.
 * A row already due for this very 09:00 is left alone: it is not sent yet
 * (the catch-up the start sweep is sending, a failed send the next sweep
 * retries), and parking it would drop that push.
 */
function setRow(core: LifeCore, repo: FinanceRepo, bill: Bill): void {
  const at = billDueAt(core, bill.nextDue);
  const now = core.now().getTime();
  if (at.getTime() <= now && repo.pingAt(bill.id) === at.toISOString()) return;
  core.scheduler.set('bill', bill.id, '', at.getTime() > now ? at : null);
}

/** After a write: set the bill's row and re-arm the scheduler's timer. */
export function armBill(core: LifeCore, repo: FinanceRepo, bill: Bill): void {
  setRow(core, repo, bill);
  core.scheduler.poke();
}

export function billPingHandler(core: LifeCore, repo: FinanceRepo): PingHandler {
  return {
    kind: 'bill',

    check(row: PingRow, dueAt: Date): 'send' | 'skip' | 'cancel' {
      const bill = repo.bill(row.ref);
      if (!bill) return 'cancel';
      if (billDueAt(core, bill.nextDue).getTime() !== dueAt.getTime()) return 'skip';
      if (row.lastSentAt !== null && Date.parse(row.lastSentAt) >= dueAt.getTime()) return 'skip';
      return 'send';
    },

    push(rows: readonly PingRow[], dueAt: Date, late: boolean): LifePush {
      const life = core.settings();
      const first = rows[0];
      const bill = rows.length === 1 && first ? repo.bill(first.ref) : null;
      let body = 'Due today';
      if (bill && life.lockScreenDetails) body = `${bill.name} · ${formatAmount(bill.amount, life.currency)}`;
      if (late) body = `Missed at ${hhmmOf(dueAt, core.tz())} · ${body}`;
      if (rows.length === 1 && first) return { kind: 'life', title: 'Bill due', body, url: `/money?bill=${first.ref}`, tag: `life:bill:${first.ref}` };
      return { kind: 'life', title: `Bills due · ${rows.length}`, body, url: '/money', tag: 'life:bill' };
    },

    /** A bill rings once per due day; Paid sets the next one. */
    next(): Date | null {
      return null;
    },

    resync(): void {
      for (const bill of repo.bills()) setRow(core, repo, bill);
      core.scheduler.poke();
    },
  };
}
