/**
 * Ask on the phone (v0.5.3 spec 1): the page's fixed words, what a card
 * says (its kind, its day in words, its flag), which cards Add all covers,
 * and when a turn is too old to Add or Undo. Pure functions over the card
 * form (protocol ask.ts) and day keys on the Life clock. The reply and the
 * user's words are only ever shown as text.
 */
import { ASK_APPLY_WITHIN_MS, type AskAction, type AskFlag, type AskShowWhat, type AskTodoAction, type AskTurn } from '@jantar/protocol';
import { dayLabel, shiftDayKey } from '../life/shared/DayNav.js';

/** Under the box, always (spec 1 and 7: what `jantar ask on`, the docs and SECURITY.md list too). */
export const PRIVACY =
  'Sent to Claude on your account: only what you type here (medicine names or amounts you type do go), the date, time and time zone, ' +
  'which Life parts are on, the currency code and the fixed category names. Your saved lists, medicines and money stay on the Mac. ' +
  'Nothing is added until you tap Add.';

/** The empty page's chips: a tap fills the box, never sends. */
export const EXAMPLES: readonly string[] = ['todo add call the bank', 'remind me to stretch at 6 pm', 'had 2 rotis and dal', 'spent 250 on lunch', 'calories left?'];

export const ASK_COPY = {
  empty: 'Tell Ask what to add, or ask about today.',
  asking: 'Asking Claude…',
  cancelled: 'Cancelled.',
  failed: "Claude couldn't answer. Try again.",
  notReady: "Ask can't run right now.",
  wait: 'Wait for the answer, or cancel it.',
  stale: 'Over a day old. Ask again.',
  clear: "Forget this phone's Ask history? Items you added stay in Life.",
  nothingDue: 'Nothing due today.',
  /** Under a repeating todo's Due in Edit while its day is cleared (Save waits for one). */
  repeatNeedsDay: 'A repeat needs a day.',
} as const;

/** A card's flag, worded on the phone (the daemon sends only the code). */
export const FLAG_TEXT: Readonly<Record<AskFlag, string>> = {
  past_time: "That time has passed, so it won't ring.",
  no_time: "No time, so it won't ring. Edit to add one.",
  no_project: 'No project by that name. It will be added without one.',
};

export const REPEAT_TEXT: Readonly<Record<NonNullable<AskTodoAction['repeat']>, string>> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};

/** A show card whose module is off now (today's reply leaves its part out). */
export const SHOW_OFF: Readonly<Record<AskShowWhat, string>> = {
  due: 'Todos are off.',
  calories: 'Food is off.',
  meds: 'Medicines are off.',
};

/** The kind on a card's first line. */
export function kindLabel(a: AskAction): string {
  switch (a.type) {
    case 'todo':
      return a.due?.time ? 'Reminder' : 'Todo';
    case 'food':
      return 'Food';
    case 'money':
      return a.kind === 'income' ? 'Income' : 'Expense';
    case 'show':
      return 'Now';
  }
}

/** "Today", "Tomorrow, Mon 2 Nov", "Yesterday, Sat 31 Oct", else "Sat 7 Nov". */
export function dayWords(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === shiftDayKey(today, 1)) return `Tomorrow, ${dayLabel(day)}`;
  if (day === shiftDayKey(today, -1)) return `Yesterday, ${dayLabel(day)}`;
  return dayLabel(day);
}

/** "Today · 17:00", "Tomorrow, Mon 2 Nov", "Sat 7 Nov · 09:00". */
export function dueWords(due: { day: string; time?: string | undefined }, today: string): string {
  const d = dayWords(due.day, today);
  return due.time ? `${d} · ${due.time}` : d;
}

/** "1 suggestion was left out.", "3 suggestions were left out." */
export function droppedText(n: number): string {
  return n === 1 ? '1 suggestion was left out.' : `${n} suggestions were left out.`;
}

/** Add, Edit and Undo work on a turn at most a day old (the daemon refuses older ones too). */
export function fresh(turn: Pick<AskTurn, 'at'>, nowMs: number): boolean {
  const at = Date.parse(turn.at);
  return Number.isFinite(at) && nowMs - at <= ASK_APPLY_WITHIN_MS;
}

/** Waiting for its answer: only one per device, and Send waits for it. */
export function unfinished(turn: Pick<AskTurn, 'state'>): boolean {
  return turn.state === 'queued' || turn.state === 'running';
}

/**
 * The cards "Add all N" adds, in order: the proposed todo and food cards of
 * a finished turn at most a day old, when there are two or more. Money and
 * show cards are never among them.
 */
export function addAllCards(turn: AskTurn, nowMs: number): number[] {
  if (turn.state !== 'done' || !fresh(turn, nowMs)) return [];
  const ns = turn.cards.flatMap((c, n) => (c.state === 'proposed' && (c.action.type === 'todo' || c.action.type === 'food') ? [n] : []));
  return ns.length >= 2 ? ns : [];
}
