/**
 * Today's FOOD section (v0.4 spec 5.2): calories against the target as
 * mono numbers over a 2 px bar, and the latest weight with the day it was
 * logged, left out when that is today (Today's header already says the
 * day; its reply carries no change over 7 days, Food shows it). A tap opens
 * Food. Over the target the bar is full and the excess is --ink-2, never
 * ember. Today comes from the shared LifeStatus.
 *
 * v0.5.3, with `onWeight` (Today): the weight line is its own button that
 * opens the weight sheet, reading today's weight (named "Weight today,
 * 72.4 kg"), or "Log weight" while none is logged today; off while offline,
 * like Add food. `weightBusy`: the sheet's data is on its way (the spinner
 * after 150 ms). The calories still open Food.
 */
import { ScalesIcon } from '@phosphor-icons/react';
import type { Weight } from '@jantar/protocol';
import { Spinner } from '../../../kit/Spinner.js';
import { Link } from '../../../shell/Link.js';
import { dayLabel } from '../shared/DayNav.js';
import { useLifeStatus } from '../shared/useLife.js';
import { LineBar, useOffline } from '../today/parts.js';
import { kcalText, kgText } from './format.js';

export interface FoodTodayProps {
  kcal: number;
  target: number;
  weight: Weight | null;
  /** v0.5.3: the weight line opens the weight sheet (Today). */
  onWeight?: () => void;
  /** v0.5.3: the weight sheet's data is on its way. */
  weightBusy?: boolean;
}

export function FoodToday({ kcal, target, weight, onWeight, weightBusy = false }: FoodTodayProps) {
  const { status } = useLifeStatus();
  const offline = useOffline();
  const over = kcal - target;
  const today = weight !== null && weight.day === status?.today;
  const calories = (
    <>
      <span className="flex items-baseline gap-8 type-mono">
        <span className="text-ink">
          {kcalText(kcal)} / {kcalText(target)} kcal
        </span>
        {over > 0 ? <span className="ml-auto text-ink-2">+{kcalText(over)} over</span> : null}
      </span>
      <LineBar value={kcal} max={target} className="mt-8" />
    </>
  );
  if (onWeight) {
    return (
      <>
        <Link href="/food" className="block px-16 pb-6 pt-10 transition-colors duration-120 ease-hover hover:bg-hover">
          {calories}
        </Link>
        <button
          type="button"
          onClick={onWeight}
          disabled={offline}
          // Named outright, so the spinner inside never joins the name.
          aria-label={today ? `Weight today, ${kgText(weight.kg)} kg` : 'Log weight'}
          className="flex min-h-44 w-full items-center gap-8 px-16 text-left transition-colors duration-120 ease-hover hover:bg-hover disabled:text-ink-3 disabled:hover:bg-transparent"
        >
          <ScalesIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
          {today ? <span className="type-mono text-ink-2">{kgText(weight.kg)} kg</span> : <span className="type-small text-ink-2">Log weight</span>}
          <Spinner active={weightBusy} className="ml-auto" />
        </button>
      </>
    );
  }
  return (
    <Link href="/food" className="block px-16 py-10 transition-colors duration-120 ease-hover hover:bg-hover">
      {calories}
      {weight ? (
        <span className="mt-8 block type-mono text-ink-2">
          {kgText(weight.kg)} kg{today ? '' : ` · ${dayLabel(weight.day)}`}
        </span>
      ) : null}
    </Link>
  );
}
