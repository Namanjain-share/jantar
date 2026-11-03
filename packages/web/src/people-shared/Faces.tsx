/**
 * v0.12 People: five large tap targets for a 1–5 answer (mood, energy,
 * sleep quality): never a slider (spec 3.1). Each target is at least 44 px.
 */
import { FACES } from './time.js';

export function Faces({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-4">
      {FACES.map((f, i) => {
        const v = i + 1;
        const on = value === v;
        return (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${label} ${v} of 5`}
            onClick={() => onChange(on ? undefined : v)}
            className={`flex size-48 items-center justify-center rounded-btn border text-title ${on ? 'border-ink bg-hover' : 'border-line'}`}
          >
            {f}
          </button>
        );
      })}
    </div>
  );
}
