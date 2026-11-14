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
 *   most guardHours back; a first or reset run, firstRunHours). An iPhone
 *   call log the reader may not open (no Full Disk Access) is left out
 *   quietly, with `phone: false`. Only missed incoming calls are kept, each
 *   marked `returned` (missedCalls).
 * - `waiting`: a 1:1 whose last line in the batch is theirs, within
 *   waitingDays, with nothing from the owner to that person since (under
 *   either of their ids: the reader's lastFromMe).
 * - `tier` (budget.ts fills in its order): 1 a waiting 1:1, or a group with
 *   a new line that mentions or answers the owner; 2 any other 1:1; 3 any
 *   other group; 4 a busy group (busyGroupMessages new lines, or
 *   busyGroupMembers members, or archived).
 *
 * Nothing here logs: the batch holds other people's words.
 */
import { MESSAGES_LIMITS } from '@jantar/protocol';
import type { Call, ChatOwner, Message } from '@jantar/protocol/messages';
import { ReaderFailure, type ReaderClient } from '../reader-client.js';
import type { ReaderCursor, ReaderNewSince } from '../reader-protocol.js';

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

/** Chats newest first, calls oldest first. `newestAt`: the newest line's time (null with none); `phone`: the iPhone call log was read. */
export interface Batch {
  chats: BatchChat[];
  calls: BatchCall[];
  cursor: Cursor;
  reset: boolean;
  newestAt: string | null;
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

/** A line with something in it: not a system, reaction or deleted line, nor a skipped person's. */
export function isContent(m: Message): boolean {
  return !SILENT_KINDS.has(m.kind) && m.skippedSender !== true;
}

/** Someone else's line that mentions the owner or answers one of his (`mine`: his lines' keys). */
export function aboutMe(m: Message, mine: ReadonlySet<string>): boolean {
  return !m.fromMe && (m.mentionsMe === true || (m.replyTo !== undefined && mine.has(m.replyTo)));
}

/** The owner's lines' keys among `lines`. */
export function ownerKeys(lines: readonly Message[]): Set<string> {
  return new Set(lines.filter((m) => m.fromMe).map((m) => m.msgKey));
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
export function tierOf(chat: ChatOwner, messages: readonly Message[], earlier: readonly Message[], waiting: boolean): Tier {
  if (isDm(chat)) return waiting ? 1 : 2;
  const fresh = messages.filter(isContent);
  if (isBusy(chat, fresh.length)) return 4;
  const mine = ownerKeys([...earlier, ...messages]);
  return fresh.some((m) => aboutMe(m, mine)) ? 1 : 3;
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
 * reader's ReaderFailure, but for an iPhone call log it may not read.
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
  const wa = await reader.call('waCalls', { since });
  let phone = true;
  const iphone = await reader.call('phoneCalls', { since }).catch((e: unknown) => {
    if (e instanceof ReaderFailure && e.code === 'no_access') {
      phone = false;
      return { calls: [] as Call[] };
    }
    throw e;
  });
  const calls = [...wa.calls, ...iphone.calls].filter((c) => Date.parse(c.at) >= fromMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const gathered = [...chats.values()];
  const missedKeys = calls.flatMap((c) => (c.incoming && c.missed && c.chatKey ? [c.chatKey] : []));
  const keys = [...new Set([...gathered.filter((g) => isDm(g.chat)).map((g) => g.chat.chatKey), ...missedKeys])];
  const wrote = keys.length ? await lastFromMe(reader, keys) : {};

  const ranked = gathered.filter((g) => g.messages.length > 0).map((g) => ({ g, last: latest(g.messages) }));
  ranked.sort((a, b) => b.last.ms - a.last.ms);
  const out: BatchChat[] = ranked.map(({ g }) => {
    const waiting = isWaiting(g.chat, g.messages, wrote[g.chat.chatKey], nowMs);
    return { chat: g.chat, messages: g.messages, earlier: g.earlier, waiting, tier: tierOf(g.chat, g.messages, g.earlier, waiting) };
  });

  return {
    chats: out,
    calls: missedCalls(calls, wrote),
    cursor: page.nextCursor,
    reset,
    newestAt: ranked[0]?.last.at ?? null,
    phone,
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
