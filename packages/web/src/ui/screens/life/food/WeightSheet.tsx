/**
 * The weight sheet (v0.4 spec 5.5): the weight for the day Food shows (kg,
 * one decimal; logging again that day replaces it), the last 30 weights
 * with Delete (no confirm: a 5 s Undo, the delete sent once it goes, or
 * when the sheet closes), and the goal weight with Clear. No BMI, no
 * chart, no pounds.
 */
import { useId, useState, type FormEvent } from 'react';
import type { Weight, WeightSummary } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { dayLabel } from '../shared/DayNav.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, RowMenu, SheetActions, UndoLine, useHeldDeletes, useOffline, useUndo, useWrite } from '../today/parts.js';
import { kgText, parseKg } from './format.js';

export interface WeightSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** The day Food shows (never after today). */
  day: string;
  today: string;
  weight: WeightSummary;
  onSaved: () => void;
}

export function WeightSheet({ open, onOpenChange, sheetKey, day, today, weight, onSaved }: WeightSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Weight">
      <WeightForms key={sheetKey} day={day} today={today} weight={weight} onSaved={onSaved} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

function WeightForms({ day, today, weight, onSaved, onDone }: { day: string; today: string; weight: WeightSummary; onSaved: () => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const id = useId();
  const logged = weight.recent.find((w) => w.day === day);
  const [kg, setKg] = useState(logged ? String(logged.kg) : '');
  const [goal, setGoal] = useState(weight.goalKg !== null ? String(weight.goalKg) : '');
  const log = useWrite();
  const goalW = useWrite();
  const row = useWrite();
  const undo = useUndo();
  const held = useHeldDeletes(undo);
  const recent = held.visible(weight.recent, (w) => w.day);
  const value = parseKg(kg);
  const goalValue = parseKg(goal);

  const saveWeight = async (e: FormEvent) => {
    e.preventDefault();
    if (value === null || log.busy || offline) return;
    // The new weight replaces the day's: a delete held for that day must not follow it.
    held.release(day);
    const r = await log.run(`${day}:${value}`, (key) => api.weightSet(day, value, key));
    if (!r.ok) return;
    onSaved();
    onDone();
  };
  const saveGoal = async (next: number | null) => {
    if (goalW.busy || offline) return;
    const r = await goalW.run(`goal:${next}`, (key) => api.foodTargets({ goalKg: next }, key));
    if (!r.ok) return;
    if (next === null) setGoal('');
    onSaved();
  };
  const remove = (w: Weight) =>
    held.remove(w.day, `Deleted: ${kgText(w.kg)} kg on ${dayLabel(w.day)}`, async () => {
      const r = await row.run(`delete:${w.day}`, (key) => api.weightDelete(w.day, key));
      if (r.ok) onSaved();
      return r.ok;
    });

  return (
    <>
      <form onSubmit={(e) => void saveWeight(e)} aria-label="Log weight">
        <Field label={day === today ? 'Weight today, kg' : `Weight on ${dayLabel(day)}, kg`} htmlFor={`${id}-kg`}>
          <input id={`${id}-kg`} className={INPUT} inputMode="decimal" autoComplete="off" value={kg} aria-invalid={kg !== '' && value === null} onChange={(e) => setKg(e.target.value)} />
        </Field>
        {kg !== '' && value === null ? <p className="type-small text-ink-2">A weight in kg from 20 to 400, like 72.4.</p> : null}
        {log.error ? <NotSaved error={log.error} /> : null}
        <SheetActions>
          <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={value === null || log.busy || offline}>
            {log.busy ? <Spinner label="Saving" /> : null}
            Save weight
          </Button>
        </SheetActions>
      </form>

      <form
        className="mt-16"
        aria-label="Goal weight"
        onSubmit={(e) => {
          e.preventDefault();
          if (goalValue !== null) void saveGoal(goalValue);
        }}
      >
        <Field label="Goal weight, kg" htmlFor={`${id}-goal`}>
          <div className="flex items-center gap-8">
            <input id={`${id}-goal`} className={INPUT} inputMode="decimal" autoComplete="off" value={goal} aria-invalid={goal !== '' && goalValue === null} onChange={(e) => setGoal(e.target.value)} />
            <Button type="submit" disabled={goalValue === null || goalW.busy || offline}>
              Save goal
            </Button>
            {weight.goalKg !== null ? (
              <Button variant="text" disabled={goalW.busy || offline} onClick={() => void saveGoal(null)}>
                Clear
              </Button>
            ) : null}
          </div>
        </Field>
        {goalW.error ? <NotSaved error={goalW.error} /> : null}
      </form>

      {recent.length ? (
        <section aria-label="Recent weights" className="mt-16">
          <h3 className="mb-6 type-small text-ink-3">Last {recent.length === 1 ? 'weight' : `${recent.length} weights`}</h3>
          <ul className="border-t border-line">
            {recent.map((w) => (
              <li key={w.day} className="flex items-center gap-12 border-b border-line py-4">
                <span className="w-96 flex-none type-mono text-ink-3">{dayLabel(w.day)}</span>
                <span className="flex-1 type-mono text-ink">{kgText(w.kg)} kg</span>
                <RowMenu label={`Weight on ${dayLabel(w.day)}`} disabled={offline || row.busy} groups={[{ items: [{ label: 'Delete', onSelect: () => remove(w) }] }]} />
              </li>
            ))}
          </ul>
          {row.error ? <NotSaved error={row.error} /> : null}
        </section>
      ) : null}
      {offline ? <OfflineLine className="mt-8" /> : null}
      {/* Last, so it pins to the bottom of the sheet however far down the weight was. */}
      <UndoLine offer={undo.offer} onUndo={undo.take} ground="raised" className="-mx-16 mt-16" />
    </>
  );
}
