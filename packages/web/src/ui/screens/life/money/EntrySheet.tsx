/**
 * The entry sheet (v0.4 spec 5.7): `[ Expense | Income ]`, Amount, Category,
 * Note and Date (by default the day the month shows: today in this month).
 * Editing sends only what changed. Delete asks nothing: it closes the sheet
 * and Finance holds it back under a 5 s Undo.
 */
import { useId, useState, type FormEvent } from 'react';
import type { MoneyBody, MoneyEntry, MoneyKind, MoneyPatch } from '@jantar/protocol';
import { amountInput, parseAmount } from '../../../../lib/money.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Segmented } from '../../accounts/Segmented.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, useOffline, useWrite } from '../today/parts.js';
import { AmountField, CategoryPicker, categoriesFor, categoryOk } from './fields.js';

export interface MoneyEntrySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** null: a new entry of `kind`. */
  entry: MoneyEntry | null;
  kind: MoneyKind;
  day: string;
  currency: string | null;
  categories: readonly string[];
  /** Income categories already used this month. */
  incomeSeen: readonly string[];
  onSaved: () => void;
  /** Delete: Finance takes it out at once and sends the delete once its Undo goes. */
  onDelete: (entry: MoneyEntry) => void;
}

export function MoneyEntrySheet(props: MoneyEntrySheetProps) {
  const { open, onOpenChange, sheetKey, entry, kind } = props;
  const title = entry ? `Edit ${entry.kind}` : kind === 'income' ? 'New income' : 'New expense';
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      <EntryForm key={sheetKey} {...props} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

function EntryForm({ entry, kind: startKind, day: startDay, currency, categories, incomeSeen, onSaved, onDelete, onDone }: MoneyEntrySheetProps & { onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [kind, setKind] = useState<MoneyKind>(entry?.kind ?? startKind);
  const [startAmount] = useState(() => (entry ? amountInput(entry.amount, currency) : ''));
  const [amount, setAmount] = useState(startAmount);
  const [category, setCategory] = useState(entry?.category ?? '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [day, setDay] = useState(entry?.day ?? startDay);
  const value = parseAmount(amount, currency);
  // Only a typed amount is sent (fields.tsx): the untouched one stays the stored amount.
  const kept = entry !== null && amount === startAmount;
  const chips = categoriesFor(kind, categories, incomeSeen);
  if (entry && !chips.includes(entry.category) && entry.kind === kind) chips.push(entry.category);
  const ok = (kept || value !== null) && categoryOk(category) && day !== '';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    if (!entry) {
      if (value === null) return;
      const body: MoneyBody = { kind, amount: value, category: category.trim(), day, ...(note.trim() ? { note: note.trim() } : {}) };
      const r = await w.run(JSON.stringify(body), (key) => api.moneyAdd(body, key));
      if (!r.ok) return;
    } else {
      const patch: MoneyPatch = {};
      if (kind !== entry.kind) patch.kind = kind;
      if (!kept && value !== null && value !== entry.amount) patch.amount = value;
      if (category.trim() !== entry.category) patch.category = category.trim();
      if (note.trim() !== (entry.note ?? '')) patch.note = note.trim() || null;
      if (day !== entry.day) patch.day = day;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => api.moneyUpdate(entry.id, patch, key));
        if (!r.ok) return;
      }
    }
    onSaved();
    onDone();
  };
  const remove = () => {
    if (!entry) return;
    onDelete(entry);
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={kind === 'income' ? 'Income' : 'Expense'}>
      <Segmented<MoneyKind>
        label="Kind"
        fill
        value={kind}
        onChange={(k) => {
          setKind(k);
          setCategory('');
        }}
        segments={[
          { key: 'expense', label: 'Expense' },
          { key: 'income', label: 'Income' },
        ]}
      />
      <AmountField id={`${id}-amount`} value={amount} start={entry ? startAmount : undefined} onChange={setAmount} currency={currency} />
      <CategoryPicker key={kind} id={`${id}-cat`} chips={chips} value={category} onChange={setCategory} />
      <Field label="Note" htmlFor={`${id}-note`}>
        <input id={`${id}-note`} className={INPUT} value={note} maxLength={200} autoComplete="off" onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="Date" htmlFor={`${id}-day`}>
        <input id={`${id}-day`} type="date" className={INPUT} value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {entry ? 'Save' : kind === 'income' ? 'Add income' : 'Add expense'}
        </Button>
        {entry ? (
          <Button variant="text" size="lg" disabled={w.busy || offline} onClick={remove}>
            Delete
          </Button>
        ) : (
          <Button variant="text" size="lg" onClick={onDone}>
            Cancel
          </Button>
        )}
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
