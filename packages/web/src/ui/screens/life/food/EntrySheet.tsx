/**
 * Editing one food entry (v0.4 spec 5.5): its name and kcal. Delete is on
 * the row's ··· menu.
 */
import { useId, useState, type FormEvent } from 'react';
import type { FoodEntry, FoodPatch } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, useOffline, useWrite } from '../today/parts.js';
import { parseKcal } from './format.js';

export function EntrySheet({ open, onOpenChange, sheetKey, entry, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; sheetKey: number; entry: FoodEntry | null; onSaved: () => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Edit food">
      {entry ? <EntryForm key={sheetKey} entry={entry} onSaved={onSaved} onDone={() => onOpenChange(false)} /> : null}
    </Sheet>
  );
}

function EntryForm({ entry, onSaved, onDone }: { entry: FoodEntry; onSaved: () => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [name, setName] = useState(entry.name);
  const [kcal, setKcal] = useState(String(entry.kcal));
  const k = parseKcal(kcal);
  const ok = name.trim().length > 0 && k !== null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    const patch: FoodPatch = {};
    if (name.trim() !== entry.name) patch.name = name.trim();
    if (k !== entry.kcal) patch.kcal = k;
    if (Object.keys(patch).length) {
      const r = await w.run(JSON.stringify(patch), (key) => api.foodUpdate(entry.id, patch, key));
      if (!r.ok) return;
      onSaved();
    }
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label="Edit food">
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="kcal" htmlFor={`${id}-kcal`}>
        <input id={`${id}-kcal`} className={INPUT} inputMode="numeric" autoComplete="off" value={kcal} aria-invalid={kcal !== '' && k === null} onChange={(e) => setKcal(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          Save
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
