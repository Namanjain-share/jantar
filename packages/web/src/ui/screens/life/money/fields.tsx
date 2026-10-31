/**
 * The fields Finance's sheets share (v0.4 spec 5.7): an amount typed as
 * text (`inputMode="decimal"`, the currency symbol beside it when one is
 * set) and read by lib/money.ts into hundredths, with a dot for decimals
 * and commas only for thousands (AMOUNT_HINT says so under a field it
 * cannot read); a category picked from chips (the defaults plus any used
 * before), with "Other…" to type one.
 *
 * A sheet that edits a stored amount sends it only once it is typed: the
 * field shows it rounded to the currency's own decimals (¥ shows 150
 * hundredths as "2", and under half a yen as "0", which is not an amount),
 * so the untouched field is never flagged and never stops a save.
 */
import clsx from 'clsx';
import { useState } from 'react';
import { CategorySchema, DEFAULT_CATEGORIES, type MoneyKind } from '@jantar/protocol';
import { currencySymbol, parseAmount } from '../../../../lib/money.js';
import { Field, INPUT } from '../today/parts.js';

/** Under an amount the field cannot read: lib/money.ts parseAmount's rule, in a line. */
export const AMOUNT_HINT = 'An amount above zero, like 1240 or 1,240.50: a dot for decimals, commas only for thousands.';

export function AmountField({
  id,
  label = 'Amount',
  value,
  start,
  onChange,
  currency,
}: {
  id: string;
  label?: string;
  value: string;
  /** The stored amount as the field first showed it: left untouched, it is not sent. */
  start?: string | undefined;
  onChange: (v: string) => void;
  currency: string | null;
}) {
  const symbol = currencySymbol(currency);
  const bad = value.trim() !== '' && value !== start && parseAmount(value, currency) === null;
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-8">
        {symbol ? (
          <span aria-hidden="true" className="flex-none type-mono text-ink-2">
            {symbol}
          </span>
        ) : null}
        <input id={id} className={INPUT} inputMode="decimal" autoComplete="off" value={value} aria-invalid={bad} onChange={(e) => onChange(e.target.value)} />
      </div>
      {bad ? <p className="mt-4 type-small text-ink-2">{AMOUNT_HINT}</p> : null}
    </Field>
  );
}

/** The chips for a kind: expenses leave out the income-only defaults; income offers its defaults plus `seen`. */
export function categoriesFor(kind: MoneyKind, categories: readonly string[], seen: readonly string[] = []): string[] {
  const incomeOnly = new Set<string>(DEFAULT_CATEGORIES.income.filter((c) => !(DEFAULT_CATEGORIES.expense as readonly string[]).includes(c)));
  if (kind === 'income') return [...new Set([...DEFAULT_CATEGORIES.income, ...seen])];
  return categories.filter((c) => !incomeOnly.has(c));
}

const CHIP = 'h-32 rounded-chip border px-10 type-small transition-colors duration-120 ease-hover coarse:h-44';

export function CategoryPicker({ id, chips, value, onChange }: { id: string; chips: readonly string[]; value: string; onChange: (v: string) => void }) {
  const known = chips.includes(value);
  const [other, setOther] = useState(value !== '' && !known);
  return (
    <Field label="Category" id={id}>
      <div role="group" aria-labelledby={id} className="flex flex-wrap gap-6">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={!other && value === c}
            onClick={() => {
              setOther(false);
              onChange(c);
            }}
            className={clsx(CHIP, !other && value === c ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:text-ink')}
          >
            {c}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={other}
          onClick={() => {
            setOther(true);
            if (known) onChange('');
          }}
          className={clsx(CHIP, other ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:text-ink')}
        >
          Other…
        </button>
      </div>
      {other ? <input aria-label="New category" className={clsx(INPUT, 'mt-8')} value={value} maxLength={24} autoComplete="off" onChange={(e) => onChange(e.target.value)} /> : null}
    </Field>
  );
}

export const categoryOk = (c: string) => CategorySchema.safeParse(c).success;
