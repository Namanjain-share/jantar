/**
 * 0.15 Messages: what the phone's screens say, worked out from the daemon's
 * answers (no React here). Times are on the Life clock when its zone is
 * known, else the phone's own. Every name, message and draft is other
 * people's words: shown as text, never as markup, and never put in a URL
 * except the Open in WhatsApp link the owner taps himself.
 */
import { CLI_NAME } from '@jantar/protocol';
import type { ChatKind, MessagesStatus, MorningRun, MorningTrigger, ReadLogEntry, ReadVia } from '@jantar/protocol/messages';

/** How many chats the skip list's search shows. */
export const SKIP_SEARCH_LIMIT = 20;
/** The longest name the search sends (the daemon's `q` cap). */
export const SEARCH_MAX_CHARS = 100;
/** How many read-log rows the settings show. */
export const READS_SHOWN = 50;
/** The newest chats asked for once to name the read log's rows (the most one answer holds). */
export const NAMES_LIMIT = 200;
/** The skip list's search waits this long after typing stops (as Meetings' does). */
export const SEARCH_DEBOUNCE_MS = 300;
/** While a run is going, Today asks again this often (the run itself sends no tick). */
export const RUNNING_POLL_MS = 10_000;

/** Said when Messages is turned on (the CLI says it too). */
export const DATA_NOTE = "The morning run sends other people's messages to Claude under your account.";
/** The skip list's one way back: the Mac's command (a phone never widens what Jantar reads). */
export const REMOVE_AT_MAC = `Remove at the Mac: ${CLI_NAME} messages skip remove <chat>`;
export const NO_RUN = 'No morning run yet. Set a morning time in Settings, or Run now.';
export const RUNNING = 'The morning run is going now.';
export const UNDONE = "This morning was undone: its open todos are gone and its drafts dismissed.";

export const KIND_WORD: Record<ChatKind, string> = { dm: '1:1', group: 'Group', community: 'Community' };
export const VIA_WORD: Record<ReadVia, string> = { mcp: 'Claude session', cli: 'Terminal', phone: 'Phone', morning: 'Morning run' };
const TRIGGER_WORD: Record<MorningTrigger, string> = { timer: 'at the morning time', now: 'Run now', dry: 'a dry run' };

/** A 1:1's number as the daemon sends it: digits only, else nothing (never a link built from anything else). */
const DIGITS = /^\d{1,20}$/;

/** Open in WhatsApp: the chat with its number and the draft typed in (he presses send); null without a number. */
export function waLink(phone: string | undefined, draft: string): string | null {
  return phone && DIGITS.test(phone) ? `https://wa.me/${phone}?text=${encodeURIComponent(draft)}` : null;
}

function parts(ms: number, tz: string | null | undefined, date: boolean): Intl.DateTimeFormatPart[] {
  const o: Intl.DateTimeFormatOptions = { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(date ? { day: 'numeric', month: 'short' } : {}) };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...o, ...(tz ? { timeZone: tz } : {}) }).formatToParts(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-GB', o).formatToParts(new Date(ms));
  }
}

/** "Fri 07:58", or with `date` "Fri 13 Nov 07:58": an instant on the Life clock (the phone's when `tz` is unknown). */
export function whenText(iso: string, tz?: string | null, opts: { date?: boolean } = {}): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const p = parts(ms, tz, opts.date === true);
  const get = (t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? '';
  const time = `${get('hour')}:${get('minute')}`;
  return opts.date ? `${get('weekday')} ${get('day')} ${get('month')} ${time}` : `${get('weekday')} ${time}`;
}

/** A todo's due as Life keeps it (a day on the Life clock, maybe a time): "Fri 16 Jan 17:00". */
export function dueText(due: { day: string; time?: string | undefined } | undefined): string {
  if (!due) return '';
  const ms = Date.parse(`${due.day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return '';
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(ms)).replace(',', '');
  return due.time ? `${day} ${due.time}` : day;
}

/** How fresh a run's WhatsApp data was: the line, and whether it is the stale warning. */
export function freshness(run: Pick<MorningRun, 'stale' | 'newestAt'>, tz?: string | null): { stale: boolean; text: string } {
  const upTo = run.newestAt ? whenText(run.newestAt, tz) : null;
  if (run.stale) return { stale: true, text: `WhatsApp wasn't open and synced in time, so this run read what the Mac had${upTo ? `: up to ${upTo}` : ''}.` };
  return { stale: false, text: upTo ? `WhatsApp data up to ${upTo}` : 'No WhatsApp messages found on the Mac.' };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "Last run Fri 08:00 · 3 chats · 12 messages · 2 calls". */
export function runLine(run: MorningRun, tz?: string | null): string {
  const c = run.counts;
  return `Last run ${whenText(run.at, tz)} · ${plural(c.chats, 'chat')} · ${plural(c.messages, 'message')} · ${plural(c.calls, 'call')}`;
}

/** The report's head: "Fri 08:00 · at the morning time". */
export function runWhen(run: MorningRun, tz?: string | null): string {
  return `${whenText(run.at, tz)} · ${TRIGGER_WORD[run.trigger]}`;
}

/** "a, b and c". */
function and(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What a run read and made, in two sentences. */
export function runCounts(run: MorningRun): string {
  const c = run.counts;
  const read = `Read ${and([plural(c.chats, 'chat'), plural(c.messages, 'message'), plural(c.calls, 'missed call')])}.`;
  const made = `Made ${and([plural(c.todos, 'todo'), plural(c.replies, 'reply draft'), plural(c.callbacks, 'call-back')])}.`;
  return `${read} ${made}`;
}

/** What a run couldn't do, one sentence each (none when it did everything). */
export function runNotes(run: MorningRun): string[] {
  const out: string[] = [];
  if (run.waCalls === false) out.push("WhatsApp calls weren't read.");
  if (run.phoneCalls === false) out.push("The iPhone call log wasn't read.");
  if (run.lifeRefused === 'limit') out.push("Life's open-todo limit stopped the rest of the todos and call-backs.");
  if (run.lifeRefused === 'life_refused') out.push('Life refused the rest of the todos and call-backs (Todos off, or the WhatsApp project gone).');
  return out;
}

/** Whether Undo this morning has something to undo: a real run that went well and made something. */
export function canUndo(run: MorningRun | null): run is MorningRun {
  if (!run || run.state !== 'ok' || run.trigger === 'dry') return false;
  return run.counts.todos + run.counts.replies + run.counts.callbacks > 0;
}

const READER_SAYS: Record<Exclude<MessagesStatus['reader']['state'], 'ok'>, string> = {
  down: `Messages can't read WhatsApp right now: the reader isn't running. At the Mac: ${CLI_NAME} messages status`,
  no_access: `Messages can't read WhatsApp right now. At the Mac: ${CLI_NAME} messages setup`,
  not_installed: `The reader isn't set up on this Mac. At the Mac: ${CLI_NAME} messages setup`,
  update_needed: `The reader changed in this release. At the Mac: ${CLI_NAME} messages setup`,
  unsupported: 'This WhatsApp version stores chats differently; Messages needs an update.',
};

/** The reader's problem as the daemon says it (its fixed sentence), or null when it reads. */
export function readerLine(status: MessagesStatus | null): string | null {
  if (!status) return null;
  if (status.reader.detail) return status.reader.detail;
  return status.reader.state === 'ok' ? null : READER_SAYS[status.reader.state];
}

/** A read-log row in words: what was read (a chat's name, or the kind of read) and how much. */
export function readWords(e: ReadLogEntry, names: ReadonlyMap<string, string>): { what: string; count: string } {
  const chat = e.chatKey ? (names.get(e.chatKey) ?? 'A chat') : null;
  switch (e.op) {
    case 'chats':
      return { what: 'Chat list', count: plural(e.count, 'chat') };
    case 'search':
      return { what: chat ? `Search in ${chat}` : 'Search', count: `${e.count.toLocaleString()} found` };
    case 'media':
      return { what: chat ?? 'A chat', count: plural(e.count, 'picture') };
    case 'calls':
      return { what: 'Calls to return', count: plural(e.count, 'call') };
    case 'morning':
      return chat ? { what: chat, count: plural(e.count, 'message') } : { what: 'Missed calls', count: plural(e.count, 'call') };
    case 'readByName':
      if (!chat) return { what: 'A name two chats share', count: 'nothing read' };
      return { what: chat, count: plural(e.count, 'message') };
    default:
      return { what: chat ?? e.op, count: plural(e.count, 'message') };
  }
}

/** The read-log row's second line: "Fri 13 Nov 07:30 · Claude session · example-app". */
export function readWho(e: ReadLogEntry, tz?: string | null): string {
  return [whenText(e.at, tz, { date: true }), VIA_WORD[e.via], e.folder].filter(Boolean).join(' · ');
}
