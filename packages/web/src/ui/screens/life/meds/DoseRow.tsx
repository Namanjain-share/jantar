/**
 * One dose time of one medicine on one day (v0.4 spec 5.2, 5.4), on
 * Medicines and on Today:
 *
 *   08:00  Testamol 500 mg      [Taken] Skip     due now (time in mustard)
 *   ■ 08:00  Placebin 10 mg     [Taken] Skip     over 60 min late: the ember glyph and time
 *   21:00  Testamol 500 mg           pending     later today (--ink-3)
 *   08:00  Testamol 500 mg      ✓ 08:12 · late   taken: a check, never green
 *   21:00  Placebin 10 mg            missed      a past day; tap to log it
 *
 * Each state has its own word or glyph, so it reads in grayscale too. The
 * row opens the dose sheet; Taken and Skip write straight away. This file
 * and MedRow are the medicine rows allowed ember (design rule 3).
 */
import { CheckIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { MedsDayItem } from '@jantar/protocol';
import { Button } from '../../../kit/Button.js';
import { StatusGlyph } from '../../../kit/StatusGlyph.js';
import { hhmmIn, medLabel } from './data.js';

export interface DoseRowProps {
  item: MedsDayItem;
  /** Its time has come (today): Taken and Skip sit on the row. */
  due: boolean;
  /** The Life zone, for the time a dose was taken. */
  tz: string | null;
  /** Offline or a write running. */
  disabled?: boolean;
  onOpen(): void;
  onLog(status: 'taken' | 'skipped'): void;
}

/** The state in words, for the row's name and the tests. */
export function doseWord(item: MedsDayItem, due: boolean, tz: string | null): string {
  if (item.status === 'taken') return `taken at ${item.at ? hhmmIn(item.at, tz) : item.slot}${item.late ? ', late' : ''}`;
  if (item.status === 'skipped') return 'skipped';
  if (item.status === 'missed') return 'missed';
  if (item.overdue) return 'overdue';
  return due ? 'due' : 'pending';
}

export function DoseRow({ item, due, tz, disabled = false, onOpen, onLog }: DoseRowProps) {
  const label = medLabel(item);
  const pending = item.status === 'pending';
  const now = pending && (due || item.overdue);
  return (
    <li
      data-dose={`${item.medId}@${item.slot}`}
      data-status={item.status}
      data-overdue={item.overdue ? '' : undefined}
      className="flex min-h-52 items-center gap-8 border-b border-line pr-12 animate-fade"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${label} at ${item.slot}, ${doseWord(item, due, tz)}`}
        className="flex min-h-52 min-w-0 flex-1 items-center gap-8 pl-12 text-left transition-colors duration-120 ease-hover hover:bg-hover focus-visible:-outline-offset-2"
      >
        <span className="flex w-16 flex-none justify-center">{item.overdue ? <StatusGlyph state="needs" /> : null}</span>
        <span className={clsx('w-44 flex-none type-mono', item.overdue ? 'text-signal-text' : now ? 'text-jup-text' : 'text-ink-3')}>{item.slot}</span>
        <span className="min-w-0 flex-1 truncate type-row text-ink">
          {item.name}
          {item.dose ? <span className="text-ink-2"> {item.dose}</span> : null}
        </span>
      </button>
      {now ? (
        <span className="flex flex-none items-center gap-4">
          <Button size="sm" aria-label={`Taken: ${label} at ${item.slot}`} disabled={disabled} onClick={() => onLog('taken')}>
            Taken
          </Button>
          <Button size="sm" variant="text" aria-label={`Skip: ${label} at ${item.slot}`} disabled={disabled} onClick={() => onLog('skipped')}>
            Skip
          </Button>
        </span>
      ) : item.status === 'taken' ? (
        <span className="flex flex-none items-center gap-4 type-mono text-ink-3">
          <CheckIcon size={14} weight="bold" aria-hidden="true" />
          {item.at ? hhmmIn(item.at, tz) : item.slot}
          {item.late ? <span> · late</span> : null}
        </span>
      ) : (
        <span className="flex-none type-small text-ink-3">{item.status === 'skipped' ? 'skipped' : item.status === 'missed' ? 'missed' : 'pending'}</span>
      )}
    </li>
  );
}
