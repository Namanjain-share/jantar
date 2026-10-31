/**
 * One bill (v0.4 spec 5.2, 5.7): its name, then `£9 · Mon 3 Nov` in mono
 * (`· yearly` for a yearly one), and Paid on Finance. A tap opens it.
 *
 * Ember (design rule 3, spec 5.0): the due day once it is today or past,
 * and nothing else.
 */
import type { Bill } from '@jantar/protocol';
import { formatAmount } from '../../../../lib/money.js';
import { Button } from '../../../kit/Button.js';
import { dueDay } from '../todos/model.js';

export function BillRow({ bill, today, currency, offline = false, onOpen, onPaid }: { bill: Bill; today: string; currency: string | null; offline?: boolean; onOpen: () => void; onPaid?: () => void }) {
  const due = bill.nextDue <= today;
  return (
    <li data-bill={bill.id} className="flex items-center gap-8 border-b border-line pr-16">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 py-10 pl-16 text-left transition-colors duration-120 ease-hover hover:bg-hover">
        <span className="block truncate type-row text-ink">{bill.name}</span>
        <span className="mt-2 flex flex-wrap items-center gap-x-6 type-mono text-ink-3">
          <span>{formatAmount(bill.amount, currency)}</span>
          <span aria-hidden="true">·</span>
          <span className={due ? 'text-signal-text' : undefined}>{bill.nextDue < today ? `overdue · ${dueDay(bill.nextDue, today)}` : dueDay(bill.nextDue, today)}</span>
          {bill.repeat === 'yearly' ? (
            <>
              <span aria-hidden="true">·</span>
              <span>yearly</span>
            </>
          ) : null}
        </span>
      </button>
      {onPaid ? (
        <Button size="sm" disabled={offline} onClick={onPaid} aria-label={`Paid ${bill.name}`}>
          Paid
        </Button>
      ) : null}
    </li>
  );
}
