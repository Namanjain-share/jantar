/**
 * v0.11 People: one quick way to log what she ate (spec 3.5), on her Today
 * and in her food log: what it was, calories if she knows them (an item
 * without them counts as 0 and shows no number), and "Keep for one tap".
 * A photo of a meal goes through her Chat, which logs it the same way.
 */
import type { FoodLevel } from '@jantar/protocol/people-core';
import { useState } from 'react';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';

const field = 'min-h-44 rounded-btn border border-line bg-bg px-8 type-input';

/** What {owner} sees of her food log, in one line (her Today and her food log say it where she logs). */
export function foodSeesLine(owner: string, level: FoodLevel): string {
  if (level === 'full') return `${owner} sees what you log here, with the calories.`;
  if (level === 'counts') return `${owner} sees only how many meals you log, never what.`;
  return `${owner} sees none of your food log.`;
}

/** "450" → 450; "" → undefined; anything else (or out of 0 to 10,000) → null. */
export function kcalOf(text: string): number | undefined | null {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : null;
}

export function FoodAddForm({
  api,
  day,
  keep = false,
  onAdded,
  onError,
}: {
  api: PersonApi;
  day: string;
  /** Show "Keep for one tap" (her food log; Today stays one line). */
  keep?: boolean;
  onAdded: (id: string, name: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const k = kcalOf(kcal);
  return (
    <form
      className="mt-8 flex flex-col gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        if (!n || k === null || busy) return;
        setBusy(true);
        api
          .foodAdd({ day, name: n, ...(k !== undefined ? { kcal: k } : {}), ...(save ? { save: true } : {}) })
          .then(
            (r) => {
              setName('');
              setKcal('');
              setSave(false);
              onAdded(r.id, n);
            },
            (err: Error) => onError(err.message),
          )
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex flex-wrap gap-8">
        <input aria-label="What did you eat?" placeholder="What did you eat?" className={`${field} min-w-0 flex-1 basis-[10rem]`} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Calories (optional)" placeholder="kcal" inputMode="numeric" className={`${field} w-88`} value={kcal} onChange={(e) => setKcal(e.target.value)} />
        <Button type="submit" variant="primary" className="min-h-44" disabled={!name.trim() || k === null || busy}>
          Log
        </Button>
      </div>
      {k === null ? <p className="text-small text-ink-2">Calories are a whole number up to 10,000, or leave them empty.</p> : null}
      {keep ? (
        <label className="flex min-h-44 items-center gap-8 text-small">
          <input type="checkbox" className="size-20" checked={save} onChange={(e) => setSave(e.target.checked)} /> Keep for one tap
        </label>
      ) : null}
    </form>
  );
}
