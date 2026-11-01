/**
 * A todo's repeat (v0.4 spec 5.3): Never, Every day, Every week on chosen
 * days, Every month (on the due day's date). Shown only with a due day. A
 * week with no day chosen repeats on the due day's weekday.
 */
import clsx from 'clsx';
import type { Repeat } from '@jantar/protocol';
import { Segmented } from '../../accounts/Segmented.js';

type Choice = 'never' | Repeat['freq'];

/** Monday first, as the phone shows them; values are 0 = Sunday ... 6 = Saturday. */
const WEEKDAYS: readonly { value: number; short: string; name: string }[] = [
  { value: 1, short: 'M', name: 'Monday' },
  { value: 2, short: 'T', name: 'Tuesday' },
  { value: 3, short: 'W', name: 'Wednesday' },
  { value: 4, short: 'T', name: 'Thursday' },
  { value: 5, short: 'F', name: 'Friday' },
  { value: 6, short: 'S', name: 'Saturday' },
  { value: 0, short: 'S', name: 'Sunday' },
];

export function RepeatPicker({ value, onChange }: { value: Repeat | undefined; onChange: (next: Repeat | undefined) => void }) {
  const choice: Choice = value?.freq ?? 'never';
  const days = new Set(value?.byWeekday ?? []);
  const pick = (c: Choice) => onChange(c === 'never' ? undefined : c === 'weekly' ? { freq: 'weekly' } : { freq: c });
  const toggle = (d: number) => {
    const next = new Set(days);
    if (next.has(d)) next.delete(d);
    else next.add(d);
    onChange(next.size ? { freq: 'weekly', byWeekday: [...next].sort((a, b) => a - b) } : { freq: 'weekly' });
  };
  return (
    <div>
      <Segmented<Choice>
        label="Repeat"
        fill
        value={choice}
        onChange={pick}
        segments={[
          { key: 'never', label: 'Never' },
          { key: 'daily', label: 'Every day' },
          { key: 'weekly', label: 'Every week' },
          { key: 'monthly', label: 'Every month' },
        ]}
      />
      {choice === 'weekly' ? (
        <div role="group" aria-label="On these days" className="mt-8 flex gap-4">
          {WEEKDAYS.map((d) => (
            <button
              key={d.value}
              type="button"
              aria-pressed={days.has(d.value)}
              aria-label={d.name}
              onClick={() => toggle(d.value)}
              className={clsx(
                'size-36 rounded-chip border type-mono transition-colors duration-120 ease-hover coarse:size-44',
                days.has(d.value) ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-3 hover:text-ink',
              )}
            >
              {d.short}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
