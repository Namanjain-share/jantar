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

/** 0.11: a daemon from 0.11 on takes the "Looking at" chip as `context`; an older one gets its words at the start of the message. */
export function takesContext(daemonVersion: string | undefined | null): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(daemonVersion ?? '');
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > 0 || b >= 11;
}

/** The chip's words, as an older daemon gets them at the start of the message. */
export const lookingWords = (label: string) => `Looking at: ${label}.`;

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
  sentAgain: 'Sent again.',
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

// ---------------------------------------------------------------------------
// 0.11 (build plan 2.2): the history column and This chat, from the loaded turns only.

/** The Confirm card's button, named by its verb (open question 11): the daemon's op, else "Confirm". */
const VERBS: Record<string, string> = { delete: 'Delete', stop: 'Stop', summarize: 'Summarize', reread: 'Re-read' };

export function confirmVerb(op: string): string {
  return VERBS[op] ?? CHAT_COPY.confirm;
}

/** YYYY-MM-DD of an instant on this device's clock. */
export function dayOf(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
}

/** "Today", "Yesterday", "Fri 30 Oct". */
export function dayName(day: string, nowMs: number): string {
  const today = dayOf(new Date(nowMs).toISOString());
  const yesterday = dayOf(new Date(nowMs - 86_400_000).toISOString());
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
}

export interface ChatDay {
  day: string;
  turns: ChatTurn[];
}

/** The turns by day, newest day first and newest turn first in each. */
export function byDay(turns: readonly ChatTurn[]): ChatDay[] {
  const out: ChatDay[] = [];
  for (const t of [...turns].sort((a, b) => b.at.localeCompare(a.at))) {
    const day = dayOf(t.at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.turns.push(t);
    else out.push({ day, turns: [t] });
  }
  return out;
}

/** HH:MM of an instant on this device's clock. */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
}

/** A history row's mono line: "photo · 2 added · 13:02". */
export function turnMeta(t: ChatTurn): string {
  const parts: string[] = [];
  const photos = t.photos.length;
  if (photos) parts.push(photos === 1 ? 'photo' : `${photos} photos`);
  const added = t.changes.filter((c) => c.state === 'done').length;
  if (added) parts.push(`${added} ${added === 1 ? 'change' : 'changes'}`);
  if (unfinished(t)) parts.push('working');
  parts.push(timeOfDay(t.at));
  return parts.join(' · ');
}

/** A Confirm or Do-it card of the turn still waits for a tap. */
export const waitsForTap = (t: ChatTurn) => t.cards.some((c) => c.state === 'waiting');

/** The search: every word somewhere in what was said, the reply, a change or a card (any case). */
export function matches(t: ChatTurn, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [t.text, t.reply ?? '', ...t.changes.map((c) => c.label), ...t.cards.map((c) => c.label)].join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The changes still inside the Undo window, newest first. */
export function undoableChanges(turns: readonly ChatTurn[], nowMs: number): { turn: ChatTurn; change: ChatChange }[] {
  return [...turns]
    .sort((a, b) => b.at.localeCompare(a.at))
    .flatMap((turn) => [...turn.changes].reverse().filter((c) => undoable(c, turn, nowMs)).map((change) => ({ turn, change })));
}

/** The photos in the loaded turns, newest first (a removed one is left out). */
export function photosOf(turns: readonly ChatTurn[]): { turn: ChatTurn; photo: ChatTurn['photos'][number] }[] {
  return [...turns].sort((a, b) => b.at.localeCompare(a.at)).flatMap((turn) => turn.photos.filter((p) => !p.gone).map((photo) => ({ turn, photo })));
}

/** The first line of what was said ("A photo" with none). */
export function firstLine(t: ChatTurn): string {
  const line = t.text.split('\n').find((l) => l.trim())?.trim();
  return line ?? (t.photos.length ? 'A photo' : 'A message');
}
