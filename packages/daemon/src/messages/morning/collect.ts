/**
 * The morning run's batch (0.15 Messages): what the reader has since the
 * last run, before budget.ts cuts it to size and input.ts writes it for
 * the model.
 *
 * - Lines: every page of newSince from the stored cursor (none: the last
 *   firstRunHours). A first run, or one after WhatsApp renumbered its rows
 *   (`reset`), keeps its firstRunHours window on the pages after the first;
 *   to the reader any later page is a cursor, which reads guardHours back.
 *   At most NEW_PAGES_MAX pages: the rest waits for the next run.
 * - Calls: WhatsApp's and the iPhone's from the stored cursor's time (at
 *   most guardHours back; a first or reset run, firstRunHours). A call store
 *   the reader may not open (the iPhone's without Full Disk Access) or no
 *   longer reads (`unsupported`: a WhatsApp or iOS update changed it) is
 *   left out quietly, with `waCalls: false` or `phone: false` for the run's
 *   report, so the lines still make todos; anything else fails the run.
 *   Only missed incoming calls are kept, each marked `returned` (missedCalls).
 * - `waiting`: a 1:1 whose last line in the batch is theirs, within
 *   waitingDays, with nothing from the owner to that person since (under
 *   either of their ids: the reader's lastFromMe).
 * - `tier` (budget.ts fills in its order): 1 a waiting 1:1, or a group with
 *   a new line that mentions or answers the owner (the reader's mentionsMe
 *   and replyToMe, wherever his line is); 2 any other 1:1; 3 any other
 *   group; 4 a busy group (busyGroupMessages new lines, or busyGroupMembers
 *   members, or archived).
 *
 * Nothing here logs: the batch holds other people's words.
 */
import { MESSAGES_LIMITS } from '@jantar/protocol';
import type { Call, ChatOwner, Message } from '@jantar/protocol/messages';
import { ReaderFailure, type ReaderClient } from '../reader-client.js';
import type { ReaderCursor, ReaderError, ReaderNewSince } from '../reader-protocol.js';

/** Where the morning feed got to (stored after a run that went well). */
export type Cursor = ReaderCursor;
export type Tier = 1 | 2 | 3 | 4;

/**
 * One chat's new lines and up to READER_EARLIER_MAX before them, both
 * oldest first. `left`: new lines budget() left out (set on its `kept`).
 */
export interface BatchChat {
  chat: ChatOwner;
  messages: Message[];
  earlier: Message[];
  waiting: boolean;
  tier: Tier;
  left?: number;
}

/** A missed incoming call; `returned`: the owner wrote or called that person since, or a call with them connected. */
export type BatchCall = Call & { returned: boolean };

/**
 * Chats newest first, calls oldest first. `newestAt`: the newest line's
 * time (null with none); `waCalls`, `phone`: WhatsApp's calls, the iPhone
 * call log were read.
 */
export interface Batch {
  chats: BatchChat[];
  calls: BatchCall[];
  cursor: Cursor;
  reset: boolean;
  newestAt: string | null;
  waCalls: boolean;
  phone: boolean;
}

/** Lines asked for in one newSince call: well inside the reader's 2 s deadline. */
export const NEW_ROWS_PER_PAGE = 5_000;
/** newSince calls in one run, at most. */
export const NEW_PAGES_MAX = 20;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** lastFromMe takes this many chat keys at once (reader-protocol.ts). */
const KEYS_PER_ASK = 500;
/** Kinds that carry nothing to read (the reader sends them without text). */
const SILENT_KINDS: ReadonlySet<Message['kind']> = new Set(['system', 'reaction', 'deleted']);
/** A calls store failing so is left out of the run; any other failure fails it. */
const CALLS_LEFT_OUT: ReadonlySet<ReaderError | 'down'> = new Set(['no_access', 'unsupported']);

/** A line with something in it: not a system, reaction or deleted line, nor a skipped person's. */
export function isContent(m: Message): boolean {
  return !SILENT_KINDS.has(m.kind) && m.skippedSender !== true;
}

/** Someone else's line that mentions the owner or answers one of his (the reader marks both). */
export function aboutMe(m: Message): boolean {
  return !m.fromMe && (m.mentionsMe === true || m.replyToMe === true);
}

const isDm = (c: ChatOwner) => c.kind === 'dm';

/** A group (or community) with busyGroupMessages new lines, busyGroupMembers members, or archived. */
export function isBusy(chat: ChatOwner, newLines: number): boolean {
  return (
    !isDm(chat) &&
    (chat.archived || newLines >= MESSAGES_LIMITS.busyGroupMessages || (chat.members ?? 0) >= MESSAGES_LIMITS.busyGroupMembers)
  );
}

/** The chat's tier (see the file comment). */
export function tierOf(chat: ChatOwner, messages: readonly Message[], waiting: boolean): Tier {
  if (isDm(chat)) return waiting ? 1 : 2;
  const fresh = messages.filter(isContent);
  if (isBusy(chat, fresh.length)) return 4;
  return fresh.some(aboutMe) ? 1 : 3;
}

/** A 1:1 whose last line is theirs, within waitingDays, unanswered (`wroteAt`: the owner's last line to that person). */
function isWaiting(chat: ChatOwner, messages: readonly Message[], wroteAt: string | null | undefined, nowMs: number): boolean {
  if (!isDm(chat)) return false;
  const last = messages.filter(isContent).at(-1);
  if (!last || last.fromMe) return false;
  const at = Date.parse(last.at);
  if (at < nowMs - MESSAGES_LIMITS.waitingDays * DAY_MS) return false;
  return !(typeof wroteAt === 'string' && Date.parse(wroteAt) >= at);
}

/**
 * The missed incoming calls among `calls`, each marked returned: a later
 * line from the owner to that person (`wrote`: lastFromMe by chat key), a
 * later call the owner made to them, or a later call with them that
 * connected (either way). A person is their 1:1's key, else the name or
 * number shown. Also callsToReturn's rule (service.ts).
 */
export function missedCalls(calls: readonly Call[], wrote: Readonly<Record<string, string | null>>): BatchCall[] {
  const person = (c: Call) => c.chatKey ?? `who:${c.who}`;
  const after = (iso: string | null | undefined, ms: number) => typeof iso === 'string' && Date.parse(iso) >= ms;
  return calls
    .filter((c) => c.incoming && c.missed)
    .map((c) => {
      const at = Date.parse(c.at);
      const returned =
        (c.chatKey !== undefined && after(wrote[c.chatKey], at)) ||
        calls.some((o) => (!o.incoming || !o.missed) && person(o) === person(c) && after(o.at, at));
      return { ...c, returned };
    });
}

/** One calls store's calls since `since`; `read: false` when it is left out (CALLS_LEFT_OUT). */
async function callsFrom(reader: ReaderClient, op: 'waCalls' | 'phoneCalls', since: string): Promise<{ calls: Call[]; read: boolean }> {
  try {
    return { calls: (await reader.call(op, { since })).calls, read: true };
  } catch (e) {
    if (e instanceof ReaderFailure && CALLS_LEFT_OUT.has(e.code)) return { calls: [], read: false };
    throw e;
  }
}

/** lastFromMe for `keys`, KEYS_PER_ASK at a time. */
async function lastFromMe(reader: ReaderClient, keys: readonly string[]): Promise<Record<string, string | null>> {
  const wrote: Record<string, string | null> = {};
  for (let i = 0; i < keys.length; i += KEYS_PER_ASK) Object.assign(wrote, await reader.call('lastFromMe', { chatKeys: keys.slice(i, i + KEYS_PER_ASK) }));
  return wrote;
}

interface Gathered {
  chat: ChatOwner;
  messages: Message[];
  earlier: Message[];
  seen: Set<string>;
}

/**
 * The batch since `cursor` (null: the first run), as of `now`. Throws the
 * reader's ReaderFailure, but for a calls store it may not or can't read.
 */
export async function collect(reader: ReaderClient, cursor: Cursor | null, now: Date): Promise<Batch> {
  const L = MESSAGES_LIMITS;
  const nowMs = now.getTime();
  const feed = (from: Cursor | null, guardHours: number) =>
    reader.call('newSince', { cursor: from, guardHours, firstRunHours: L.firstRunHours, maxRows: NEW_ROWS_PER_PAGE });

  const chats = new Map<string, Gathered>();
  const gather = (page: ReaderNewSince) => {
    for (const c of page.chats) {
      let got = chats.get(c.chat.chatKey);
      // A chat on several pages keeps its first page's earlier lines (those before its first new one).
      if (!got) chats.set(c.chat.chatKey, (got = { chat: c.chat, messages: [], earlier: c.earlier, seen: new Set() }));
      for (const m of c.messages) {
        if (got.seen.has(m.msgKey)) continue;
        got.seen.add(m.msgKey);
        got.messages.push(m);
      }
    }
  };

  let page = await feed(cursor, L.cursorGuardHours);
  const reset = page.reset;
  const wide = cursor === null || reset;
  gather(page);
  for (let n = 1; page.truncated && n < NEW_PAGES_MAX; n++) {
    page = await feed(page.nextCursor, wide ? L.firstRunHours : L.cursorGuardHours);
    gather(page);
  }

  const fromMs = cursor === null || reset ? nowMs - L.firstRunHours * HOUR_MS : Math.max(Date.parse(cursor.at), nowMs - L.cursorGuardHours * HOUR_MS);
  const since = new Date(fromMs).toISOString();
  const wa = await callsFrom(reader, 'waCalls', since);
  const iphone = await callsFrom(reader, 'phoneCalls', since);
  const calls = [...wa.calls, ...iphone.calls].filter((c) => Date.parse(c.at) >= fromMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const gathered = [...chats.values()];
  const missedKeys = calls.flatMap((c) => (c.incoming && c.missed && c.chatKey ? [c.chatKey] : []));
  const keys = [...new Set([...gathered.filter((g) => isDm(g.chat)).map((g) => g.chat.chatKey), ...missedKeys])];
  const wrote = keys.length ? await lastFromMe(reader, keys) : {};

  const ranked = gathered.filter((g) => g.messages.length > 0).map((g) => ({ g, last: latest(g.messages) }));
  ranked.sort((a, b) => b.last.ms - a.last.ms);
  const out: BatchChat[] = ranked.map(({ g }) => {
    const waiting = isWaiting(g.chat, g.messages, wrote[g.chat.chatKey], nowMs);
    return { chat: g.chat, messages: g.messages, earlier: g.earlier, waiting, tier: tierOf(g.chat, g.messages, waiting) };
  });

  return {
    chats: out,
    calls: missedCalls(calls, wrote),
    cursor: page.nextCursor,
    reset,
    newestAt: ranked[0]?.last.at ?? null,
    waCalls: wa.read,
    phone: iphone.read,
  };
}

/** The newest of `lines` (not empty), by time. */
function latest(lines: readonly Message[]): { ms: number; at: string } {
  let best = { ms: -Infinity, at: '' };
  for (const m of lines) {
    const ms = Date.parse(m.at);
    if (ms > best.ms) best = { ms, at: m.at };
  }
  return best;
}
