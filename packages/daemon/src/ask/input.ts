/**
 * What an Ask run reads on stdin (spec 3.2): three tagged blocks.
 *
 *   <now>      today, the time and the Life zone, yesterday, the 7 days
 *              before and after today, each with its weekday (so the model
 *              never works one out)
 *   <life>     which Life parts are on (todos, food, money, medicines for
 *              show only; never cafés), the currency code and the fixed
 *              category names (DEFAULT_CATEGORIES, never the user's own)
 *   <message>  what the user typed, as typed
 *
 * Nothing from Life's data goes in: no titles, projects, medicines, doses,
 * calories, weights or amounts. The message is data: any of our three tags
 * inside it, however spelled (any case, spaces around the "/", zero-width
 * or bidi characters inside the name), is escaped ("</message>" becomes
 * "<\/message>") so it can neither close its block nor open another.
 *
 * Nothing here is logged or emitted: the input holds what the user typed.
 */
import { shiftDay, weekdayOf } from '@jantar/life-core';
import { DEFAULT_CATEGORIES } from '@jantar/protocol';
import { tagEscaper } from '../rewrite/context.js';

export const ASK_TAGS = ['now', 'life', 'message'] as const;

const escapeAskTags = tagEscaper(ASK_TAGS);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The parts the run is told about, in the order the line names them. */
export interface AskInputLife {
  todos: boolean;
  food: boolean;
  /** Life's `finance` module ("money" to the model). */
  finance: boolean;
  /** Show cards only: nothing is ever written to Medicines from Ask. */
  medicines: boolean;
}

export interface AskInput {
  /** Today's day key in the Life zone. */
  today: string;
  /** Now as HH:MM in the Life zone. */
  now: string;
  timezone: string;
  modules: AskInputLife;
  /** `life.currency` (an ISO code), or null. */
  currency: string | null;
  /** What the user typed. */
  text: string;
}

/** "Sun 2026-11-01". */
export function dayWithWeekday(day: string): string {
  return `${WEEKDAYS[weekdayOf(day)]} ${day}`;
}

/** The "On:" line's parts. */
function onLine(m: AskInputLife): string {
  const parts: string[] = [];
  if (m.todos) parts.push('todos');
  if (m.food) parts.push('food');
  if (m.finance) parts.push('money');
  if (m.medicines) parts.push('medicines (show only)');
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** The run's stdin. */
export function askInput(i: AskInput): string {
  const days = (from: number, to: number, step: number) => {
    const out: string[] = [];
    for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(dayWithWeekday(shiftDay(i.today, n)));
    return out.join(', ');
  };
  return [
    '<now>',
    `Today: ${dayWithWeekday(i.today)}`,
    `Time: ${i.now} (${i.timezone})`,
    `Yesterday: ${dayWithWeekday(shiftDay(i.today, -1))}`,
    `Last 7 days: ${days(-1, -7, -1)}`,
    `Next 7 days: ${days(1, 7, 1)}`,
    '</now>',
    '<life>',
    `On: ${onLine(i.modules)}`,
    `Currency: ${i.currency ?? 'not set'}`,
    `Expense categories: ${DEFAULT_CATEGORIES.expense.join(', ')}`,
    `Income categories: ${DEFAULT_CATEGORIES.income.join(', ')}`,
    '</life>',
    '<message>',
    escapeAskTags(i.text),
    '</message>',
  ].join('\n');
}
