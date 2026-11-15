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
 *   report, so the lines still make todos; anything else fails the run (a
 *   reader of another build too). callsToReturn (service.ts) does the same.
 *   Only missed incoming calls are kept, each marked `returned` (missedCalls).
 * - `waiting`: a 1:1 whose last line in the batch is theirs, within
 *   waitingDays, with nothing from the owner to that person since (under
 *   either of their ids: the reader's lastFromMe).
 * - A 1:1 still waiting with nothing new (the reader's waiting list, by the
 *   same rule on its last dmContext lines) comes too: tier 1, no new line,
 *   those lines as `earlier` (stillWaiting), so Today keeps them waiting.
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
import { READER_CHATS_MAX, READER_KEYS_MAX, type ReaderCursor, type ReaderError, type ReaderNewSince } from '../reader-protocol.js';
import { READER_MISMATCH } from '../says.js';

/** Where the morning feed got to (stored after a run that went well). */
export type Cursor = ReaderCursor;
export type Tier = 1 | 2 | 3 | 4;

/**
 * One chat's new lines and up to READER_EARLIER_MAX before them, both
 * oldest first (a 1:1 still waiting: none new, its last dmContext lines
 * earlier). Set on budget()'s `kept`: `left`, the new lines it left out;
 * `waitsOn`, a 1:1 still waiting's keys of every line it waits on, kept or
 * not (apply's duplicate check).
 */
export interface BatchChat {
  chat: ChatOwner;
  messages: Message[];
  earlier: Message[];
  waiting: boolean;
  tier: Tier;
  left?: number;
  waitsOn?: string[];
}

/** A missed incoming call; `returned`: the owner wrote or called that person since, or a call with them connected. */
export type BatchCall = Call & { returned: boolean };

/**
 * Chats newest first, calls oldest first. `newestAt`: the newest line's
 * time (null with none); `waCalls`, `phone`: WhatsApp's calls, the iPhone
 * call log were read; `wroteAt`: by chat key, when the owner last wrote
 * there as far as the run knows (lastFromMe, or his newest line in it).
 */
export interface Batch {
  chats: BatchChat[];
  calls: BatchCall[];
  cursor: Cursor;
  reset: boolean;
  newestAt: string | null;
  waCalls: boolean;
  phone: boolean;
  wroteAt: Record<string, string>;
}

/** Lines asked for in one newSince call: well inside the reader's 2 s deadline. */
export const NEW_ROWS_PER_PAGE = 5_000;
/** newSince calls in one run, at most. */
export const NEW_PAGES_MAX = 20;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
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

/** Where the lines a waiting 1:1 waits on start in `lines` (oldest first): just after the owner's last content line, else 0. */
export function openFrom(lines: readonly Message[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.fromMe && isContent(lines[i]!)) return i + 1;
  return 0;
}

/** A waiting 1:1 with no new line since the last run: what it waits on is in its earlier lines. */
export function stillWaiting(bc: BatchChat): boolean {
  return bc.waiting && bc.messages.length === 0;
}

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

/** One calls store's calls since `since`; `read: false` when it is left out (CALLS_LEFT_OUT; never a reader of another build). */
export async function callsFrom(reader: ReaderClient, op: 'waCalls' | 'phoneCalls', since: string): Promise<{ calls: Call[]; read: boolean }> {
  try {
    return { calls: (await reader.call(op, { since })).calls, read: true };
  } catch (e) {
    if (e instanceof ReaderFailure && CALLS_LEFT_OUT.has(e.code) && e.detail !== READER_MISMATCH) return { calls: [], read: false };
    throw e;
  }
}

/** lastFromMe for `keys`, READER_KEYS_MAX at a time. */
async function lastFromMe(reader: ReaderClient, keys: readonly string[]): Promise<Record<string, string | null>> {
  const wrote: Record<string, string | null> = {};
  for (let i = 0; i < keys.length; i += READER_KEYS_MAX) Object.assign(wrote, await reader.call('lastFromMe', { chatKeys: keys.slice(i, i + READER_KEYS_MAX) }));
  return wrote;
}

/**
 * The reader's waiting 1:1s but those in `skip` (already in the batch), each
 * with its last dmContext lines; one skipped or gone since is left out.
 */
async function waitingList(reader: ReaderClient, skip: ReadonlySet<string>): Promise<{ chat: ChatOwner; lines: Message[] }[]> {
  const out: { chat: ChatOwner; lines: Message[] }[] = [];
  for (const chat of (await reader.call('chats', { waiting: true, limit: READER_CHATS_MAX })).chats) {
    if (!isDm(chat) || skip.has(chat.chatKey)) continue;
    try {
      out.push({ chat, lines: (await reader.call('read', { chatKey: chat.chatKey, limit: MESSAGES_LIMITS.dmContext })).messages });
    } catch (e) {
      if (e instanceof ReaderFailure && e.code === 'not_found') continue;
      throw e;
    }
  }
  return out;
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

  // A chat with nothing to read in its new lines (system lines only) may still be waiting: as one with none.
  const said = new Set([...chats.values()].filter((g) => g.messages.some(isContent)).map((g) => g.chat.chatKey));
  const quiet = await waitingList(reader, said);
  const quietKeys = new Set(quiet.map((q) => q.chat.chatKey));
  const gathered = [...chats.values()].filter((g) => g.messages.length > 0 && !quietKeys.has(g.chat.chatKey));
  const missedKeys = calls.flatMap((c) => (c.incoming && c.missed && c.chatKey ? [c.chatKey] : []));
  const keys = [...new Set([...gathered.filter((g) => isDm(g.chat)).map((g) => g.chat.chatKey), ...quietKeys, ...missedKeys])];
  const wrote = keys.length ? await lastFromMe(reader, keys) : {};

  const out: { bc: BatchChat; ms: number }[] = gathered.map((g) => {
    const waiting = isWaiting(g.chat, g.messages, wrote[g.chat.chatKey], nowMs);
    return { bc: { chat: g.chat, messages: g.messages, earlier: g.earlier, waiting, tier: tierOf(g.chat, g.messages, waiting) }, ms: latest(g.messages).ms };
  });
  for (const q of quiet) {
    if (!isWaiting(q.chat, q.lines, wrote[q.chat.chatKey], nowMs)) continue;
    out.push({ bc: { chat: q.chat, messages: [], earlier: q.lines, waiting: true, tier: 1 }, ms: latest(q.lines).ms });
  }
  out.sort((a, b) => b.ms - a.ms);
  // The newest line is the newest new one.
  const fresh = [...chats.values()].filter((g) => g.messages.length > 0).map((g) => latest(g.messages));
  const newest = fresh.length ? fresh.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
  const wroteAt: Record<string, string> = {};
  for (const [k, at] of Object.entries(wrote)) if (typeof at === 'string') wroteAt[k] = at;
  for (const g of chats.values()) {
    const mine = latest(g.messages.filter((m) => m.fromMe && isContent(m)));
    const known = wroteAt[g.chat.chatKey];
    if (mine.at && (known === undefined || mine.ms > Date.parse(known))) wroteAt[g.chat.chatKey] = mine.at;
  }

  return {
    chats: out.map((o) => o.bc),
    calls: missedCalls(calls, wrote),
    cursor: page.nextCursor,
    reset,
    newestAt: newest?.at ?? null,
    waCalls: wa.read,
    phone: iphone.read,
    wroteAt,
  };
}

/** The newest of `lines` by time (none: at -Infinity, ''). */
function latest(lines: readonly Message[]): { ms: number; at: string } {
  let best = { ms: -Infinity, at: '' };
  for (const m of lines) {
    const ms = Date.parse(m.at);
    if (ms > best.ms) best = { ms, at: m.at };
  }
  return best;
}
