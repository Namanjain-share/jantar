/**
 * A dish (v0.10, spec 0.10 A7.3): Name, Stars (none yet: "Not tried yet"),
 * Price (an amount in the Life currency), "Would order again" and Notes
 * (200). It saves the café's whole dish list with this one put in its
 * place (or added at the end), as the daemon takes dishes wholesale.
 * Delete takes it out at once with a 5 s Undo that puts the list back.
 */
import { useId, useState, type FormEvent } from 'react';
import type { Dish, Place } from '@jantar/protocol';
import { amountInput, parseAmount } from '../../../../lib/money.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { SwitchRow } from '../../devices/parts.js';
import { AmountField } from '../money/fields.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite, type Undo } from '../today/parts.js';
import { ClearRating, StarPicker } from './Stars.js';

export interface DishSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  place: Place;
  /** The dish's place in the list; null for a new one. */
  index: number | null;
  currency: string | null;
  undo: Undo;
  onSaved: () => void;
}

export function DishSheet({ open, onOpenChange, sheetKey, place, index, ...rest }: DishSheetProps) {
  const dish = index !== null ? place.dishes[index] : undefined;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={dish ? dish.name : 'New dish'}>
      <DishForm key={sheetKey} place={place} index={dish ? index : null} {...rest} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

function DishForm({ place, index, currency, undo, onSaved, onDone }: Omit<DishSheetProps, 'open' | 'onOpenChange' | 'sheetKey'> & { onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const dish = index !== null ? place.dishes[index] : undefined;
  const [name, setName] = useState(dish?.name ?? '');
  const [rating, setRating] = useState<number | null>(dish?.rating ?? null);
  const [startPrice] = useState(() => (dish?.price !== undefined ? amountInput(dish.price, currency) : ''));
  const [price, setPrice] = useState(startPrice);
  const [again, setAgain] = useState(dish?.again ?? false);
  const [notes, setNotes] = useState(dish?.notes ?? '');
  const value = parseAmount(price, currency);
  const kept = dish !== undefined && price === startPrice;
  const priceOk = price.trim() === '' || kept || value !== null;
  const ok = name.trim().length > 0 && priceOk && (dish !== undefined || place.dishes.length < 30);

  const send = (dishes: Dish[]) => w.run(JSON.stringify(dishes), (key) => api.placeUpdate(place.id, { dishes }, key));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    const amount = price.trim() === '' ? undefined : kept ? dish?.price : (value ?? undefined);
    const next: Dish = {
      name: name.trim(),
      ...(rating ? { rating } : {}),
      ...(amount !== undefined ? { price: amount } : {}),
      // "Would order again" is said only once it is on (or was said before).
      ...(again || dish?.again !== undefined ? { again } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    const dishes = index === null ? [...place.dishes, next] : place.dishes.map((d, i) => (i === index ? next : d));
    const r = await send(dishes);
    if (!r.ok) return;
    onSaved();
    onDone();
  };

  const remove = async () => {
    if (index === null || !dish) return;
    const before = place.dishes;
    const r = await send(before.filter((_, i) => i !== index));
    if (!r.ok) return;
    onSaved();
    onDone();
    undo.show(`Deleted: ${dish.name}`, () => {
      void api.placeUpdate(place.id, { dishes: before }).then(onSaved, onSaved);
    });
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={dish ? 'Edit dish' : 'New dish'}>
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Stars" id={`${id}-stars`} aside={<ClearRating value={rating} label="Clear the stars" onClear={() => setRating(null)} />}>
        <StarPicker label={`Rating for ${name.trim() || 'this dish'}`} value={rating} onChange={setRating} />
        {rating ? null : <p className="mt-4 type-small text-ink-3">Not tried yet</p>}
      </Field>
      <AmountField id={`${id}-price`} label="Price" value={price} start={dish ? startPrice : undefined} onChange={setPrice} currency={currency} />
      <SwitchRow id={`${id}-again`} checked={again} onChange={setAgain}>
        Would order again
      </SwitchRow>
      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} className={TEXTAREA} value={notes} maxLength={200} rows={2} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {dish ? 'Save' : 'Add dish'}
        </Button>
        {dish ? (
          <Button variant="text" size="lg" disabled={w.busy || offline} onClick={() => void remove()}>
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
