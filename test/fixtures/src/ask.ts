/**
 * Ask fixtures (v0.5.3): what the phone sends, with a marker to plant for
 * the privacy sweep, and the synthetic medicine name a reminder may carry
 * (never a real one). The fake claude's Ask modes are in
 * runtime/fake-claude.mjs (ASK_MODES).
 *
 *   await post('/v1/ask', { text: askText('todo add buy milk', { marked: true }) });
 */

/** Planted in what the phone sends: it may come back only in the owner's GET /v1/ask, never in an event, audit row, log line, write reply or file. */
export const ASK_MARKER = 'SYNTHETIC-ASK-TEXT-DO-NOT-LOG';

/** A made-up medicine for "remind me at 6 to take …". */
export const ASK_MEDICINE = 'Examplocin';

/** The ask-ok messages the fake claude knows, one per kind of card. */
export const ASK_MESSAGES = {
  todo: 'todo add call the bank',
  daily: 'remind me every day at 09:00 to stretch',
  timed: 'remind me to call the plumber at 17:00',
  medicine: `remind me at 6 to take ${ASK_MEDICINE}`,
  meal: 'had 2 rotis and dal',
  food: 'ate pizza 300 kcal',
  money: 'spent 250 on lunch',
  calories: 'calories left?',
  due: "what's due today?",
  meds: 'did I take my meds',
  post: 'reel tomorrow 7pm about the launch',
  chat: 'hello there',
} as const;

/** `text`, with ASK_MARKER after it when `marked`. */
export function askText(text: string, opts: { marked?: boolean } = {}): string {
  return opts.marked ? `${text} ${ASK_MARKER}` : text;
}
