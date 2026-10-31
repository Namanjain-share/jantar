/**
 * One expense category of a month (v0.4 spec 5.7): `Food  £420 / £500`
 * over a 2 px --ink bar when it has a budget, no bar without one. A tap
 * opens its budget sheet.
 *
 * Ember (design rule 3, spec 5.0): "£80 over" once the spend passes the
 * budget, and nothing else.
 */
import type { MoneyMonth } from '@jantar/protocol';
import { formatAmount } from '../../../../lib/money.js';
import { LineBar } from '../today/parts.js';

export type CategoryLine = MoneyMonth['byCategory'][number];

export function CategoryRow({ row, currency, onOpen }: { row: CategoryLine; currency: string | null; onOpen: () => void }) {
  const over = row.budget !== null && row.spent > row.budget ? row.spent - row.budget : 0;
  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col justify-center px-16 py-10 text-left transition-colors duration-120 ease-hover hover:bg-hover coarse:min-h-44"
      >
        <span className="flex items-baseline gap-8">
          <span className="min-w-0 flex-1 truncate type-row text-ink">{row.category}</span>
          <span className="flex-none type-mono text-ink">
            {formatAmount(row.spent, currency)}
            {row.budget !== null ? <span className="text-ink-3"> / {formatAmount(row.budget, currency)}</span> : null}
          </span>
        </span>
        {row.budget !== null ? <LineBar value={row.spent} max={row.budget} className="mt-6" /> : null}
        {over > 0 ? <span className="mt-4 block type-mono text-signal-text">{formatAmount(over, currency)} over</span> : null}
      </button>
    </li>
  );
}
