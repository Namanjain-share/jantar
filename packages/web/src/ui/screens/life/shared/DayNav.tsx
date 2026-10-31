/**
 * Stepping through days and months (v0.4 spec 5.4, 5.7): `‹ Thu 30 Oct ›`,
 * where › stops at today and a "Today" chip comes back; `‹ October 2026 ›`
 * for Finance. Day keys are the Life zone's own (the daemon says which day
 * is today), so the arithmetic here is calendar arithmetic in UTC.
 */
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import clsx from 'clsx';

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `day` moved by `n` days. */
export function shiftDayKey(day: string, n: number): string {
  const m = KEY.exec(day);
  if (!m) return day;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}

/** `YYYY-MM` moved by `n` months. */
export function shiftMonthKey(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** "Thu 30 Oct". */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
}

/** "October 2026". */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const STEP = 'inline-flex size-32 items-center justify-center rounded-btn text-ink-2 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent coarse:size-44';

function Stepper({
  label,
  unit,
  back,
  forward,
  canForward,
  chip,
  onChip,
}: {
  label: string;
  /** What a step moves by, for the arrows' names ("Previous day"). */
  unit: 'day' | 'month';
  back: () => void;
  forward: () => void;
  canForward: boolean;
  chip?: string;
  onChip?: () => void;
}) {
  return (
    <div className="flex h-44 items-center gap-4">
      <button type="button" className={STEP} aria-label={`Previous ${unit}`} onClick={back}>
        <CaretLeftIcon size={16} aria-hidden="true" />
      </button>
      <span className="min-w-112 text-center type-mono text-ink">{label}</span>
      <button type="button" className={STEP} aria-label={`Next ${unit}`} disabled={!canForward} onClick={forward}>
        <CaretRightIcon size={16} aria-hidden="true" />
      </button>
      {chip && onChip ? (
        <button
          type="button"
          className={clsx('ml-8 inline-flex h-28 items-center rounded-chip border border-line px-10 type-small text-ink-2 hover:bg-hover hover:text-ink coarse:h-44')}
          onClick={onChip}
        >
          {chip}
        </button>
      ) : null}
    </div>
  );
}

/** Days up to today: › stops there; away from today a "Today" chip returns. */
export function DayNav({ day, today, onDay }: { day: string; today: string; onDay: (day: string) => void }) {
  return (
    <Stepper
      label={dayLabel(day)}
      unit="day"
      back={() => onDay(shiftDayKey(day, -1))}
      forward={() => onDay(shiftDayKey(day, 1))}
      canForward={day < today}
      {...(day !== today ? { chip: 'Today', onChip: () => onDay(today) } : {})}
    />
  );
}

/** Months up to this one. */
export function MonthNav({ month, current, onMonth }: { month: string; current: string; onMonth: (month: string) => void }) {
  return (
    <Stepper
      label={monthLabel(month)}
      unit="month"
      back={() => onMonth(shiftMonthKey(month, -1))}
      forward={() => onMonth(shiftMonthKey(month, 1))}
      canForward={month < current}
      {...(month !== current ? { chip: 'This month', onChip: () => onMonth(current) } : {})}
    />
  );
}
