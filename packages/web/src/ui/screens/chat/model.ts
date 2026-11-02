/**
 * Chat on the phone (v0.10, spec 0.10 B14): the page's fixed words, what a
 * change and a card say, and which turns still wait. The reply and the
 * user's words are only ever shown as text. Changes and cards come from the
 * Mac's journal, never from the reply.
 */
import { CHAT_UNDO_WITHIN_MS, type ChatChange, type ChatTurn } from '@jantar/protocol';

/** Under the box, always: one line. */
export const PRIVACY_SHORT = 'Sent to Claude on your account.';

/** "What's sent" (the same as `jantar chat on`, docs/assistant.md and SECURITY.md). */
export const PRIVACY =
  'What you type and the photos you send go to Claude through Claude Code on your account, with the date, time and zone, ' +
  'the last messages of this chat, and whatever Chat looks up to answer: your todos, medicines, food, cafés, money, posts, ' +
  'Intel shelf, meetings, and your sessions, waiting prompts and usage (read only), for the parts that are on. ' +
  'Chat adds and changes things at once and shows each change with Undo; it never deletes without your tap, and never types into a session. ' +
  'History stays on the Mac.';

/** The empty thread's examples: a tap fills the box, never sends (synthetic). */
export const EXAMPLES: readonly string[] = ['Add oat milk to my list', 'How many calories today?', 'Rate Example Café 4 stars, great Wi-Fi'];

export const CHAT_COPY = {
  empty: 'Ask Jantar anything, or tell it what to add or change.',
  working: 'Working…',
  notReady: "Chat can't run right now.",
  wait: 'Wait for an answer, or stop one.',
  clear: 'Clear chat? Its messages, photos and Undo go. What it added stays.',
  photoGone: 'Photo removed',
  undoConflict: "That changed after Chat's edit; change it back by hand.",
  siri: 'Siri',
  earlier: 'Earlier',
  doIt: 'Do it',
  confirm: 'Confirm',
  dismiss: 'Dismiss',
  tryAgain: 'Try again',
  stop: 'Stop',
} as const;

/** A change's state word, as the row says it. */
export function changeWord(c: Pick<ChatChange, 'op' | 'state'>): string {
  if (c.state === 'undone') return 'Undone';
  if (c.op === 'add' || c.op === 'save' || c.op === 'todo') return 'Added';
  if (c.op === 'log' || c.op === 'paid') return 'Logged';
  if (c.op === 'done') return 'Done';
  return 'Changed';
}

export const unfinished = (t: Pick<ChatTurn, 'state'>) => t.state === 'queued' || t.state === 'running';

/** Undo shows while the change is Chat's and the turn is under a day old. */
export function undoable(c: Pick<ChatChange, 'state' | 'undoable'>, turn: Pick<ChatTurn, 'at'>, nowMs: number): boolean {
  return c.state === 'done' && c.undoable && nowMs - Date.parse(turn.at) < CHAT_UNDO_WITHIN_MS;
}
