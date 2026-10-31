/**
 * A category's monthly budget (v0.4 spec 5.7): "Monthly budget for Food",
 * an amount, Save and Remove. Opened from a category row, or from "Set a
 * budget" with a category to pick first.
 */
import { useId, useState, type FormEvent } from 'react';
import { amountInput, parseAmount } from '../../../../lib/money.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { NotSaved } from '../shared/states.js';
import { OfflineLine, SheetActions, useOffline, useWrite } from '../today/parts.js';
import { AmountField, CategoryPicker, categoryOk } from './fields.js';

export interface BudgetTarget {
  /** Empty: pick one in the sheet. */
  category: string;
  budget: number | null;
}

export interface BudgetSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  target: BudgetTarget | null;
  currency: string | null;
  /** Expense categories to pick from. */
  chips: readonly string[];
  onSaved: () => void;
}

export function BudgetSheet({ open, onOpenChange, sheetKey, target, currency, chips, onSaved }: BudgetSheetProps) {
  const title = target?.category ? `Monthly budget for ${target.category}` : 'Monthly budget';
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      {target ? <BudgetForm key={sheetKey} target={target} currency={currency} chips={chips} onSaved={onSaved} onDone={() => onOpenChange(false)} /> : null}
    </Sheet>
  );
}

function BudgetForm({ target, currency, chips, onSaved, onDone }: { target: BudgetTarget; currency: string | null; chips: readonly string[]; onSaved: () => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [category, setCategory] = useState(target.category);
  const [startAmount] = useState(() => (target.budget !== null ? amountInput(target.budget, currency) : ''));
  const [amount, setAmount] = useState(startAmount);
  // Only a typed amount (fields.tsx): Save on the untouched field keeps the stored budget, not the field's rounding of it.
  const sent = target.budget !== null && amount === startAmount ? target.budget : parseAmount(amount, currency);
  const ok = categoryOk(category) && sent !== null;

  const set = async (next: number | null) => {
    if (!categoryOk(category) || w.busy || offline) return;
    const body = { category: category.trim(), amount: next };
    const r = await w.run(JSON.stringify(body), (key) => api.budgetSet(body, key));
    if (!r.ok) return;
    onSaved();
    onDone();
  };

  return (
    <form
      aria-label="Monthly budget"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (ok) void set(sent);
      }}
    >
      {target.category ? null : <CategoryPicker id={`${id}-cat`} chips={chips} value={category} onChange={setCategory} />}
      <AmountField id={`${id}-amount`} label="A month" value={amount} start={target.budget !== null ? startAmount : undefined} onChange={setAmount} currency={currency} />
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          Save budget
        </Button>
        {target.budget !== null ? (
          <Button variant="text" size="lg" disabled={w.busy || offline} onClick={() => void set(null)}>
            Remove
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
