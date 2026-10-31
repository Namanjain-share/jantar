/**
 * The target sheet (v0.4 spec 5.5): the daily calorie target, 800 to
 * 6,000, kept by the daemon (life.db meta), not a Mac setting.
 */
import { useId, useState, type FormEvent } from 'react';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, useOffline, useWrite } from '../today/parts.js';
import { parseTarget } from './format.js';

export function TargetSheet({ open, onOpenChange, sheetKey, target, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; sheetKey: number; target: number; onSaved: () => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Daily calorie target">
      <TargetForm key={sheetKey} target={target} onSaved={onSaved} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

function TargetForm({ target, onSaved, onDone }: { target: number; onSaved: () => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [text, setText] = useState(String(target));
  const value = parseTarget(text);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (value === null || w.busy || offline) return;
    const r = await w.run(`kcal:${value}`, (key) => api.foodTargets({ kcalTarget: value }, key));
    if (!r.ok) return;
    onSaved();
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label="Daily calorie target">
      <Field label="kcal a day" htmlFor={`${id}-kcal`}>
        <input id={`${id}-kcal`} className={INPUT} inputMode="numeric" autoComplete="off" value={text} aria-invalid={text !== '' && value === null} onChange={(e) => setText(e.target.value)} />
      </Field>
      {text !== '' && value === null ? <p className="type-small text-ink-2">A whole number from 800 to 6,000.</p> : null}
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={value === null || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          Save target
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
