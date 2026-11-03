/**
 * v0.11 People: the sleep week (spec 3.12), one component for her Health ›
 * Sleep and his Partner › Health (the same DTO, so the mirror matches).
 * Bars run from bedtime to wake time on an 18:00–14:00 axis. "short" is a
 * plain label under 6 h, never a colour or an alert; the arrow shows only
 * when the daemon found a real baseline.
 */
import type { SleepWeek as Week } from '@jantar/protocol/people';
import { dayLabel, face, minutesLabel, shiftDay, shortDay, weekdayOf } from './time.js';

const AXIS = 20 * 60;

export function SleepWeek({ week, onWeek, actions }: { week: Week; onWeek?: (monday: string) => void; actions?: (night: Week['nights'][number]) => React.ReactNode }) {
  const byNight = new Map(week.nights.map((n) => [n.night, n]));
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(week.from, i));
  const arrow = week.trend === 'up' ? ' ↑' : week.trend === 'down' ? ' ↓' : '';
  return (
    <section aria-label="Sleep week">
      <div className="flex items-center justify-between gap-8">
        <h2 className="font-semibold">
          Sleep {shortDay(week.from)} – {shortDay(week.to)}
        </h2>
        {onWeek ? (
          <div className="flex">
            <button type="button" aria-label="Week before" className="size-44" onClick={() => onWeek(shiftDay(week.from, -7))}>
              ◀
            </button>
            <button type="button" aria-label="Week after" className="size-44" onClick={() => onWeek(shiftDay(week.from, 7))}>
              ▶
            </button>
          </div>
        ) : null}
      </div>
      {week.avgMinutes !== null ? (
        <p className="text-small">
          Avg {minutesLabel(week.avgMinutes)}
          {arrow}
          {week.avgBed ? `   Bed ${week.avgBed}` : ''}
          {week.avgWake ? ` · Up ${week.avgWake}` : ''}
        </p>
      ) : (
        <p className="text-small text-ink-2">No nights logged this week.</p>
      )}
      {week.bedSpreadMin !== null && week.bedSpreadMin > 0 ? <p className="text-small text-ink-2">Bedtime varies by {minutesLabel(week.bedSpreadMin)}</p> : null}
      {week.open ? <p className="mt-4 text-small">Asleep since {week.open.since.slice(11, 16)} ({dayLabel(week.open.night)})</p> : null}
      <ul className="mt-8">
        {days.map((d) => {
          const n = byNight.get(d);
          const from = n?.axis ? Math.max(0, Math.min(AXIS, n.axis.from)) : 0;
          const to = n?.axis ? Math.max(from, Math.min(AXIS, n.axis.to)) : 0;
          return (
            <li key={d} className="flex min-h-32 items-center gap-8 text-small">
              <span className="w-32 shrink-0">{weekdayOf(d)}</span>
              <span className="relative h-12 flex-1 rounded-chip bg-hover" aria-hidden="true">
                {n && to > from ? <span className="absolute inset-y-0 rounded-chip bg-ink-3" style={{ left: `${(from / AXIS) * 100}%`, width: `${((to - from) / AXIS) * 100}%` }} /> : null}
              </span>
              <span className="w-112 shrink-0 text-right">
                {n
                  ? n.minutes !== undefined
                    ? `${minutesLabel(n.minutes)}${n.short ? ' short' : ''} ${face(n.quality)}`
                    : n.noWake
                      ? 'wake time not logged'
                      : 'no wake time yet'
                  : '·'}
              </span>
              {n && actions ? actions(n) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
