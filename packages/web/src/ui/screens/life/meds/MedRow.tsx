/**
 * One medicine under YOUR MEDICINES (v0.4 spec 5.4):
 *
 *   Testamol 500 mg
 *   08:00, 21:00 · every day
 *   14 left · runs out 13 Nov · 93% in 30 days
 *
 * With 7 days of pills or fewer the days left are in ember (the only ember
 * here; design rule 3); a stopped medicine says when it stopped. A tap
 * opens the medicine sheet.
 */
import clsx from 'clsx';
import type { MedicineView } from '@jantar/protocol';
import { dayLabel } from '../shared/DayNav.js';
import { medLabel, scheduleText, supplyParts } from './data.js';

export function MedRow({ med, onOpen }: { med: MedicineView; onOpen(): void }) {
  const s = supplyParts(med);
  const parts = [s.pills, s.runs, s.pct].filter((p): p is string => p !== null);
  const when = `${med.times.join(', ')} · ${scheduleText(med.schedule)}`;
  const name = [medLabel(med), when, ...(med.stoppedOn ? [`stopped ${dayLabel(med.stoppedOn)}`] : parts)].join(', ');
  return (
    <li data-med={med.id} data-low={s.low ? '' : undefined} className="border-b border-line animate-fade">
      <button
        type="button"
        onClick={onOpen}
        aria-label={name}
        className="block w-full px-16 py-10 text-left transition-colors duration-120 ease-hover hover:bg-hover focus-visible:-outline-offset-2"
      >
        <span className={clsx('block truncate type-row', med.stoppedOn ? 'text-ink-2' : 'text-ink')}>
          {med.name}
          {med.dose ? <span className="text-ink-2"> {med.dose}</span> : null}
        </span>
        <span className="mt-2 block type-mono text-ink-3">{when}</span>
        {med.stoppedOn ? (
          <span className="mt-2 block type-small text-ink-3">Stopped {dayLabel(med.stoppedOn)}</span>
        ) : parts.length ? (
          <span className="mt-2 block type-mono text-ink-3">
            {parts.map((p, i) => (
              <span key={p}>
                {i > 0 ? ' · ' : null}
                <span className={p === s.runs && s.low ? 'text-signal-text' : undefined}>{p}</span>
              </span>
            ))}
          </span>
        ) : null}
      </button>
    </li>
  );
}
