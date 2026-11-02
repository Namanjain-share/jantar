/**
 * A visit (v0.10, spec 0.10 A7.3): Day (today by default, never later),
 * Spend (an amount in the Life currency), "How was it" (stars, optional),
 * "What I had" (chips from the café's dishes, plus one typed) and Notes
 * (500). Log visit only: "Also rate the dishes I had" gives each dish had
 * stars, saved to the café's dish list after the visit (a new name is
 * added to it). Edit sends only what changed (a cleared value is null);
 * Delete takes the visit out at once with a 5 s Undo on the café's screen.
 */
import clsx from 'clsx';
import { useId, useState, type FormEvent } from 'react';
import type { Dish, Place, PlaceVisit, PlaceVisitBody, PlaceVisitPatch } from '@jantar/protocol';
import { amountInput, parseAmount } from '../../../../lib/money.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Switch } from '../../devices/parts.js';
import { AmountField, CHIP, CHIP_OFF, CHIP_ON } from '../money/fields.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite } from '../today/parts.js';
import { ClearRating, StarPicker } from './Stars.js';

/** Dishes one visit can name. */
const HAD_MAX = 10;

export interface VisitSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  place: Place;
  /** null: Log visit. */
  visit: PlaceVisit | null;
  /** Today in the Life zone: the latest day a visit can be. */
  today: string;
  currency: string | null;
  onSaved: () => void;
  /** Delete: the screen takes it out at once and sends the delete once its Undo goes. */
  onDelete: (visit: PlaceVisit) => void;
}

export function VisitSheet({ open, onOpenChange, sheetKey, visit, ...rest }: VisitSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={visit ? 'Visit' : 'Log visit'}>
      <VisitForm key={sheetKey} visit={visit} {...rest} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

/** The dish list with `rated` given their stars (by name, any case); a name not on it is added at the end. */
export function withRatings(dishes: readonly Dish[], rated: ReadonlyMap<string, number>): Dish[] {
  const left = new Map([...rated].map(([n, r]) => [n.toLowerCase(), { name: n, rating: r }]));
  const out = dishes.map((d) => {
    const r = left.get(d.name.toLowerCase());
    if (!r) return d;
    left.delete(d.name.toLowerCase());
    return { ...d, rating: r.rating };
  });
  for (const r of left.values()) if (out.length < 30) out.push(r);
  return out;
}

function VisitForm({ place, visit, today, currency, onSaved, onDelete, onDone }: Omit<VisitSheetProps, 'open' | 'onOpenChange' | 'sheetKey'> & { onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [day, setDay] = useState(visit?.day ?? today);
  const [startSpend] = useState(() => (visit?.spend !== undefined ? amountInput(visit.spend, currency) : ''));
  const [spend, setSpend] = useState(startSpend);
  const [stars, setStars] = useState<number | null>(visit?.stars ?? null);
  const [had, setHad] = useState<string[]>(visit?.had ?? []);
  const [typed, setTyped] = useState('');
  const [notes, setNotes] = useState(visit?.notes ?? '');
  const [rate, setRate] = useState(false);
  const [rated, setRated] = useState<Map<string, number>>(() => new Map());
  const value = parseAmount(spend, currency);
  const kept = visit !== null && spend === startSpend;
  const spendOk = spend.trim() === '' || kept || value !== null;
  const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today;
  const ok = dayOk && spendOk;
  const chips = [...new Set([...place.dishes.map((d) => d.name), ...had])];
  const isHad = (n: string) => had.some((h) => h.toLowerCase() === n.toLowerCase());
  const toggle = (n: string) => setHad((h) => (isHad(n) ? h.filter((x) => x.toLowerCase() !== n.toLowerCase()) : h.length < HAD_MAX ? [...h, n] : h));
  const addTyped = () => {
    const n = typed.trim();
    if (!n || isHad(n) || had.length >= HAD_MAX) return;
    setHad((h) => [...h, n.slice(0, 60)]);
    setTyped('');
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    const amount = spend.trim() === '' ? undefined : kept ? visit?.spend : (value ?? undefined);
    if (!visit) {
      const body: PlaceVisitBody = {
        day,
        ...(amount !== undefined ? { spend: amount } : {}),
        ...(stars ? { stars } : {}),
        ...(had.length ? { had } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      const r = await w.run(JSON.stringify(body), (key) => api.placeVisitAdd(place.id, body, key));
      if (!r.ok) return;
      const ratings = new Map([...rated].filter(([n]) => isHad(n)));
      if (rate && ratings.size) {
        const dishes = withRatings(place.dishes, ratings);
        const d = await w.run(JSON.stringify(dishes), (key) => api.placeUpdate(place.id, { dishes }, key));
        if (!d.ok) {
          // The visit is in; only the dish stars were not saved.
          onSaved();
          return;
        }
      }
    } else {
      const patch: PlaceVisitPatch = {};
      if (day !== visit.day) patch.day = day;
      if (amount !== visit.spend) patch.spend = amount ?? null;
      if ((stars ?? undefined) !== visit.stars) patch.stars = stars;
      if (JSON.stringify(had) !== JSON.stringify(visit.had ?? [])) patch.had = had.length ? had : null;
      if (notes.trim() !== (visit.notes ?? '')) patch.notes = notes.trim() || null;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => api.placeVisitUpdate(place.id, visit.id, patch, key));
        if (!r.ok) return;
      }
    }
    onSaved();
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={visit ? 'Edit visit' : 'Log visit'}>
      <Field label="Day" htmlFor={`${id}-day`}>
        <input id={`${id}-day`} type="date" className={INPUT} value={day} max={today} aria-invalid={!dayOk} onChange={(e) => setDay(e.target.value)} />
      </Field>
      {!dayOk ? <p className="type-small text-ink-2">A visit can be today or earlier.</p> : null}
      <AmountField id={`${id}-spend`} label="Spend" value={spend} start={visit ? startSpend : undefined} onChange={setSpend} currency={currency} />
      <Field label="How was it" id={`${id}-stars`} aside={<ClearRating value={stars} label="Clear how it was" onClear={() => setStars(null)} />}>
        <StarPicker label="How was it" value={stars} onChange={setStars} />
      </Field>
      <Field label="What I had" id={`${id}-had`}>
        <div role="group" aria-labelledby={`${id}-had`} className="flex flex-wrap gap-6">
          {chips.map((n) => (
            <button key={n} type="button" aria-pressed={isHad(n)} onClick={() => toggle(n)} className={clsx(CHIP, isHad(n) ? CHIP_ON : CHIP_OFF)}>
              {n}
            </button>
          ))}
        </div>
        <div className="mt-8 flex items-center gap-8">
          <input
            aria-label="Another dish"
            className={INPUT}
            value={typed}
            maxLength={60}
            autoComplete="off"
            placeholder="Another dish"
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTyped();
              }
            }}
          />
          <Button disabled={!typed.trim() || had.length >= HAD_MAX} onClick={addTyped}>
            Add
          </Button>
        </div>
      </Field>
      {!visit && had.length ? (
        <>
          <div className="flex min-h-44 items-center gap-12 py-8">
            <Switch id={`${id}-rate`} checked={rate} onChange={setRate} />
            <label htmlFor={`${id}-rate`} className="type-small text-ink">
              Also rate the dishes I had
            </label>
          </div>
          {rate
            ? had.map((n) => (
                <Field key={n} label={n} id={`${id}-rate-${n}`}>
                  <StarPicker label={`Rating for ${n}`} value={rated.get(n) ?? null} onChange={(r) => setRated((m) => new Map(m).set(n, r))} />
                </Field>
              ))
            : null}
        </>
      ) : null}
      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} className={TEXTAREA} value={notes} maxLength={500} rows={3} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {visit ? 'Save' : 'Log visit'}
        </Button>
        {visit ? (
          <Button
            variant="text"
            size="lg"
            disabled={w.busy || offline}
            onClick={() => {
              onDelete(visit);
              onDone();
            }}
          >
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
