/**
 * Bills (v0.4 spec 5.7). The bill sheet: Name, Amount, Category, Repeats
 * (Every month | Every year) and Next due; Delete asks first. The paid
 * sheet: the amount (the bill's, to change if this one differed) and the
 * day paid (today), then Paid logs the expense and moves the due day on.
 */
import { useId, useState, type FormEvent } from 'react';
import type { Bill, BillBody, BillPatch, BillRepeat } from '@jantar/protocol';
import { amountInput, parseAmount } from '../../../../lib/money.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Segmented } from '../../accounts/Segmented.js';
import { TwoTap } from '../../session/TwoTap.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, useOffline, useWrite } from '../today/parts.js';
import { AmountField, CategoryPicker, categoryOk } from './fields.js';

export interface BillSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** null: a new bill. */
  bill: Bill | null;
  today: string;
  currency: string | null;
  chips: readonly string[];
  onSaved: () => void;
}

export function BillSheet(props: BillSheetProps) {
  const { open, onOpenChange, sheetKey, bill } = props;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={bill ? bill.name : 'New bill'}>
      <BillForm key={sheetKey} {...props} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

function BillForm({ bill, today, currency, chips, onSaved, onDone }: BillSheetProps & { onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [name, setName] = useState(bill?.name ?? '');
  const [startAmount] = useState(() => (bill ? amountInput(bill.amount, currency) : ''));
  const [amount, setAmount] = useState(startAmount);
  const [category, setCategory] = useState(bill?.category ?? 'Bills');
  const [repeat, setRepeat] = useState<BillRepeat>(bill?.repeat ?? 'monthly');
  const [nextDue, setNextDue] = useState(bill?.nextDue ?? today);
  const value = parseAmount(amount, currency);
  // Only a typed amount is sent (fields.tsx): the untouched one stays the bill's own.
  const kept = bill !== null && amount === startAmount;
  const list = bill && !chips.includes(bill.category) ? [...chips, bill.category] : chips;
  const ok = name.trim().length > 0 && (kept || value !== null) && categoryOk(category) && nextDue !== '';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    if (!bill) {
      if (value === null) return;
      const body: BillBody = { name: name.trim(), amount: value, category: category.trim(), repeat, nextDue };
      const r = await w.run(JSON.stringify(body), (key) => api.billCreate(body, key));
      if (!r.ok) return;
    } else {
      const patch: BillPatch = {};
      if (name.trim() !== bill.name) patch.name = name.trim();
      if (!kept && value !== null && value !== bill.amount) patch.amount = value;
      if (category.trim() !== bill.category) patch.category = category.trim();
      if (repeat !== bill.repeat) patch.repeat = repeat;
      if (nextDue !== bill.nextDue) patch.nextDue = nextDue;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => api.billUpdate(bill.id, patch, key));
        if (!r.ok) return;
      }
    }
    onSaved();
    onDone();
  };
  const remove = async () => {
    if (!bill) return;
    const r = await w.run(`delete:${bill.id}`, (key) => api.billDelete(bill.id, key));
    if (!r.ok) return;
    onSaved();
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={bill ? 'Edit bill' : 'New bill'}>
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <AmountField id={`${id}-amount`} value={amount} start={bill ? startAmount : undefined} onChange={setAmount} currency={currency} />
      <CategoryPicker id={`${id}-cat`} chips={list} value={category} onChange={setCategory} />
      <Field label="Repeats">
        <Segmented<BillRepeat>
          label="Repeats"
          fill
          value={repeat}
          onChange={setRepeat}
          segments={[
            { key: 'monthly', label: 'Every month' },
            { key: 'yearly', label: 'Every year' },
          ]}
        />
      </Field>
      <Field label="Next due" htmlFor={`${id}-due`}>
        <input id={`${id}-due`} type="date" className={INPUT} value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {bill ? 'Save' : 'Add bill'}
        </Button>
        {bill ? (
          <TwoTap size="lg" variant="text" confirmLabel="Delete bill" disabled={w.busy || offline} onConfirm={() => void remove()}>
            Delete
          </TwoTap>
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

export interface PaidSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  bill: Bill | null;
  today: string;
  currency: string | null;
  onSaved: () => void;
}

export function PaidSheet({ open, onOpenChange, sheetKey, bill, today, currency, onSaved }: PaidSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={bill ? `Paid ${bill.name}` : 'Paid'}>
      {bill ? <PaidForm key={sheetKey} bill={bill} today={today} currency={currency} onSaved={onSaved} onDone={() => onOpenChange(false)} /> : null}
    </Sheet>
  );
}

function PaidForm({ bill, today, currency, onSaved, onDone }: { bill: Bill; today: string; currency: string | null; onSaved: () => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [startAmount] = useState(() => amountInput(bill.amount, currency));
  const [amount, setAmount] = useState(startAmount);
  const [day, setDay] = useState(today);
  const value = parseAmount(amount, currency);
  const kept = amount === startAmount;
  const ok = (kept || value !== null) && day !== '';

  const paid = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    // An untouched amount is left to the daemon (the bill's own), never the field's rounding of it.
    const body = { day, ...(!kept && value !== null ? { amount: value } : {}) };
    const r = await w.run(JSON.stringify(body), (key) => api.billPaid(bill.id, body, key));
    if (!r.ok) return;
    onSaved();
    onDone();
  };

  return (
    <form onSubmit={(e) => void paid(e)} aria-label={`Paid ${bill.name}`}>
      <AmountField id={`${id}-amount`} value={amount} start={startAmount} onChange={setAmount} currency={currency} />
      <Field label="Paid on" htmlFor={`${id}-day`}>
        <input id={`${id}-day`} type="date" className={INPUT} value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      <p className="type-small text-ink-3">Logs an expense under {bill.category} and moves the bill to its next due day.</p>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          Paid
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
