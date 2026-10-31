/**
 * Today's FOOD section (v0.4 spec 5.2): calories against the target as
 * mono numbers over a 2 px bar, and the latest weight with the day it was
 * logged, left out when that is today (Today's header already says the
 * day; its reply carries no change over 7 days, Food shows it). A tap opens
 * Food. Over the target the bar is full and the excess is --ink-2, never
 * ember. Today comes from the shared LifeStatus.
 */
import type { Weight } from '@jantar/protocol';
import { Link } from '../../../shell/Link.js';
import { dayLabel } from '../shared/DayNav.js';
import { useLifeStatus } from '../shared/useLife.js';
import { LineBar } from '../today/parts.js';
import { kcalText, kgText } from './format.js';

export interface FoodTodayProps {
  kcal: number;
  target: number;
  weight: Weight | null;
}

export function FoodToday({ kcal, target, weight }: FoodTodayProps) {
  const { status } = useLifeStatus();
  const over = kcal - target;
  return (
    <Link href="/food" className="block px-16 py-10 transition-colors duration-120 ease-hover hover:bg-hover">
      <span className="flex items-baseline gap-8 type-mono">
        <span className="text-ink">
          {kcalText(kcal)} / {kcalText(target)} kcal
        </span>
        {over > 0 ? <span className="ml-auto text-ink-2">+{kcalText(over)} over</span> : null}
      </span>
      <LineBar value={kcal} max={target} className="mt-8" />
      {weight ? (
        <span className="mt-8 block type-mono text-ink-2">
          {kgText(weight.kg)} kg{weight.day === status?.today ? '' : ` · ${dayLabel(weight.day)}`}
        </span>
      ) : null}
    </Link>
  );
}
