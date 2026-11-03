/**
 * v0.11 People: her food log as the owner sees it (spec 3.5), one component
 * for his Partner › Health and her "See what {owner} sees" (the same DTO,
 * so the mirror matches). `full`: what she ate that day with its calories
 * (an item logged without calories shows no number), the day's total
 * against her target, and the week's totals; never when she logged an
 * item, her saved foods or her weight. `counts`: how many meals, that day
 * and on each day of the week, naming nothing. Nothing here scores a day or
 * colours it. Text renders as plain text (React escapes it).
 */
import type { OwnerFoodView } from '@jantar/protocol/people';
import { dayLabel } from './time.js';

/** "1 meal", "3 meals". */
export function mealsWord(n: number): string {
  return `${n} meal${n === 1 ? '' : 's'}`;
}

/** An item's calories as a reader sees them: none for an item logged without them. */
export function kcalWord(kcal: number): string {
  return kcal > 0 ? `${kcal} kcal` : '';
}

/** His Today line for her food (and her mirror of it): "Food: 3 meals · 1240 of 1800 kcal" at full, "Food: 3 meals logged" at counts. */
export function foodTodayLine(f: { level: 'full'; meals: number; kcal: number; target: number } | { level: 'counts'; meals: number }): string {
  if (f.meals === 0) return 'Food: nothing logged yet';
  return f.level === 'full' ? `Food: ${mealsWord(f.meals)} · ${f.kcal} of ${f.target} kcal` : `Food: ${mealsWord(f.meals)} logged`;
}

export function FoodRead({ view }: { view: OwnerFoodView }) {
  const when = view.day === view.today ? 'Today' : dayLabel(view.day);
  const week = (
    <>
      <h3 className="mt-12 font-semibold">The last 7 days</h3>
      <ul className="divide-y divide-line">
        {view.days.map((d) => (
          <li key={d.day} className="flex justify-between gap-8 py-4">
            <span>{dayLabel(d.day)}</span>
            <span className="text-ink-2">
              {d.meals === 0 ? 'Nothing logged' : mealsWord(d.meals)}
              {'kcal' in d && d.kcal > 0 ? ` · ${d.kcal} kcal` : ''}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
  if (view.level === 'counts') {
    return (
      <section aria-label="Food" className="mt-12">
        <p>
          {when}: {view.meals === 0 ? 'nothing logged' : `${mealsWord(view.meals)} logged`}
        </p>
        <p className="text-small text-ink-2">Only how many meals are shared, never what or how much.</p>
        {week}
      </section>
    );
  }
  return (
    <section aria-label="Food" className="mt-12">
      <p>
        {when}: {view.kcal} of {view.target} kcal · {mealsWord(view.items.length)}
      </p>
      {view.items.length ? (
        <ul className="divide-y divide-line">
          {view.items.map((i) => (
            <li key={i.id} className="flex justify-between gap-8 py-4">
              <span className="min-w-0 break-words">{i.name}</span>
              <span className="shrink-0 text-ink-2">{kcalWord(i.kcal)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-ink-2">Nothing logged {view.day === view.today ? 'yet today' : 'that day'}.</p>
      )}
      {week}
    </section>
  );
}
