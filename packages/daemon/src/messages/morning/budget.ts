/**
 * The morning run's budget (0.15 Messages): what of a batch (collect.ts)
 * goes to the model, about `maxTokens` (MESSAGES_LIMITS.morningTokens) by
 * an estimate of UTF-8 bytes / 3, so Hinglish, Devanagari and emoji cost
 * what they weigh.
 *
 * - Only lines with something in them: system, reaction and deleted lines
 *   and a skipped person's placeholders go. Each line is cut at
 *   perMessageChars (chat/text.ts cut(): never inside a surrogate pair);
 *   a non-text line is a short mark ("[image: invoice]", "[voice 0:42]":
 *   input.ts lineBody).
 * - Filled in this order, each step newest first, until the next piece
 *   doesn't fit; nothing after it goes in, so a lower tier never takes the
 *   place of a higher one:
 *   0. the missed calls not returned (a line each);
 *   1. the waiting 1:1s: first each one's lines since the owner's last
 *      (WAITING_FIRST at most), so a heavy morning drops context, not
 *      people; then each one with new lines gets its last dmContext lines
 *      (earlier ones counted); then in every group the windows of
 *      mentionWindow lines each side of a new line that mentions or
 *      answers the owner (busy groups too);
 *   2. the other 1:1s (their last dmContext lines);
 *   3. the other groups (their last smallGroupContext lines), those of at
 *      most smallGroupMembers first;
 *   4. the busy groups: a count of their new lines only (the chat's `left`);
 *   5. a 1:1 still waiting with nothing new: the rest of its last dmContext
 *      lines. The owner saw them on an earlier morning, so they never take
 *      the place of a new line.
 * - `kept` holds the chats in that order, each line oldest first with the
 *   chat's `left` (a 1:1 still waiting also with `waitsOn`, from all of its
 *   lines); `dropped` everything left out: first the missed calls, per
 *   person (`call`), then every chat with new lines left out, or a 1:1
 *   still waiting with lines it waits on left out (counted of those), most
 *   first. A report lists REPORT_DROPPED_MAX of them (droppedReport).
 *
 * The estimate counts each line in input.ts's markup at its longest (ids,
 * times, attributes), its name and text escaped as input.ts writes them (a
 * "<m" in a line costs its "<\m", a quote in a name its &quot;), plus
 * HEADER_TOKENS for the lines before the first chat.
 */
import { MESSAGES_LIMITS } from '@jantar/protocol';
import type { ChatOwner, Message } from '@jantar/protocol/messages';
import { cut } from '../../chat/text.js';
import { aboutMe, isContent, openFrom, stillWaiting, type Batch, type BatchCall, type BatchChat } from './collect.js';
import { dataName, dataText, fromOf, lineBody } from './input.js';

/** The estimate's rate: a token per this many UTF-8 bytes. */
export const BYTES_PER_TOKEN = 3;
/** input.ts's lines before the first chat (the day, the time and zone, the days around), at most. */
export const HEADER_TOKENS = 150;
/** A waiting 1:1's newest lines since the owner's last, at most, kept for each one before any gets more. */
export const WAITING_FIRST = 5;
/** A run report's list of what was left out, at most (`droppedMore`: how many more). */
export const REPORT_DROPPED_MAX = 50;

/** About how many tokens `s` costs: its UTF-8 bytes / BYTES_PER_TOKEN, rounded up. */
export function estimateTokens(s: string): number {
  return Math.ceil(Buffer.byteLength(s, 'utf8') / BYTES_PER_TOKEN);
}

/**
 * A chat left out, in part or whole: its new lines kept and left out (a 1:1
 * still waiting with nothing new: the lines it waits on). `call`: a
 * person's missed calls instead (`chatKey`: their 1:1, when they have one).
 */
export interface Dropped {
  chatKey?: string;
  chatName: string;
  kept: number;
  left: number;
  call?: true;
}

/** A report's list: the first REPORT_DROPPED_MAX, and how many more when there are. */
export function droppedReport(dropped: readonly Dropped[]): { dropped: Dropped[]; droppedMore?: number } {
  const more = dropped.length - REPORT_DROPPED_MAX;
  return { dropped: dropped.slice(0, REPORT_DROPPED_MAX), ...(more > 0 ? { droppedMore: more } : {}) };
}

// input.ts's markup at its longest, for the estimate.
const LINE_FRAME = '<m id="m00000" at="Wed 2026-11-11 00:00" from="" by_user="yes" earlier="yes" to_me="yes" reply="m00000"></m>\n';
const CHAT_FRAME = '<chat id="c0000" name="" kind="community" waiting="yes" members="00000" archived="yes" left="000000">\n</chat>\n';
const CALL_FRAME = '<call id="k00000" at="Wed 2026-11-11 00:00" who="" via="whatsapp" missed="yes" video="yes" chat="c0000"/>\n';
/** A line as kept: its text and caption cut at perMessageChars. */
function trimmed(m: Message): Message {
  const max = MESSAGES_LIMITS.perMessageChars;
  return { ...m, ...(m.text !== undefined ? { text: cut(m.text, max) } : {}), ...(m.caption !== undefined ? { caption: cut(m.caption, max) } : {}) };
}

const lineTokens = (m: Message) => estimateTokens(LINE_FRAME + fromOf(m) + dataText(lineBody(m)));
const chatTokens = (c: ChatOwner) => estimateTokens(CHAT_FRAME + dataName(c.name));
const callTokens = (c: BatchCall) => estimateTokens(CALL_FRAME + dataName(c.who));
const isDm = (c: ChatOwner) => c.kind === 'dm';

interface Plan {
  bc: BatchChat;
  /** Its place in `kept`: waiting 1:1s, other tier-1 chats, then tiers 2, 3, 4. */
  rank: number;
  order: number;
  /** Its content lines, earlier ones first, cut. */
  pool: Message[];
  /** The first new line's index in `pool`. */
  firstNew: number;
  taken: Set<number>;
  /** Its <chat> frame is counted. */
  shown: boolean;
}

/** The new lines of `p` (indexes in its pool) that mention or answer the owner, newest first, each with its window: itself, then one each side, two... */
function windows(p: Plan): number[] {
  const out: number[] = [];
  for (let a = p.pool.length - 1; a >= p.firstNew; a--) {
    if (!aboutMe(p.pool[a]!)) continue;
    out.push(a);
    for (let d = 1; d <= MESSAGES_LIMITS.mentionWindow; d++) {
      if (a - d >= 0) out.push(a - d);
      if (a + d < p.pool.length) out.push(a + d);
    }
  }
  return out;
}

/** What of `batch` fits `maxTokens` (see the file comment), and what was left out per chat. */
export function budget(batch: Batch, maxTokens: number = MESSAGES_LIMITS.morningTokens): { kept: Batch; dropped: Dropped[] } {
  const L = MESSAGES_LIMITS;
  const plans: Plan[] = batch.chats.flatMap((bc, order) => {
    const earlier = bc.earlier.filter(isContent).map(trimmed);
    const fresh = bc.messages.filter(isContent).map(trimmed);
    if (fresh.length === 0 && !(stillWaiting(bc) && earlier.length > 0)) return [];
    const rank = bc.tier === 1 ? (isDm(bc.chat) ? 0 : 1) : bc.tier;
    return [{ bc, rank, order, pool: [...earlier, ...fresh], firstNew: earlier.length, taken: new Set<number>(), shown: false }];
  });
  plans.sort((a, b) => a.rank - b.rank || a.order - b.order);

  let used = HEADER_TOKENS;
  let full = false;
  const fits = (cost: number): boolean => {
    if (full || used + cost > maxTokens) {
      full = true;
      return false;
    }
    used += cost;
    return true;
  };
  const take = (p: Plan, i: number): boolean => {
    if (p.taken.has(i)) return true;
    if (!fits(lineTokens(p.pool[i]!) + (p.shown ? 0 : chatTokens(p.bc.chat)))) return false;
    p.shown = true;
    p.taken.add(i);
    return true;
  };
  const newest = (p: Plan, n: number) => {
    for (let i = p.pool.length - 1; i >= Math.max(0, p.pool.length - n); i--) if (!take(p, i)) return;
  };

  const calls: BatchCall[] = [];
  // Each person's missed calls, kept and left out (a person: their 1:1, else the name shown).
  const callers = new Map<string, Dropped>();
  for (const c of batch.calls) {
    if (c.returned) continue;
    const who = c.chatKey ?? `who:${c.who}`;
    const d = callers.get(who) ?? { ...(c.chatKey ? { chatKey: c.chatKey } : {}), chatName: c.who, kept: 0, left: 0, call: true as const };
    callers.set(who, d);
    // Once one doesn't fit, none after it does.
    if (fits(callTokens(c))) {
      calls.push(c);
      d.kept += 1;
    } else d.left += 1;
  }
  const dms = plans.filter((p) => isDm(p.bc.chat));
  const groups = plans.filter((p) => !isDm(p.bc.chat));
  const waiting = dms.filter((p) => p.bc.tier === 1);
  for (const p of waiting) {
    const from = Math.max(openFrom(p.pool), p.pool.length - WAITING_FIRST);
    for (let i = p.pool.length - 1; i >= from; i--) if (!take(p, i)) break;
  }
  const quiet = (p: Plan) => stillWaiting(p.bc);
  for (const p of waiting) if (!quiet(p)) newest(p, L.dmContext);
  for (const p of groups) for (const i of windows(p)) if (!take(p, i)) break;
  for (const p of dms) if (p.bc.tier !== 1) newest(p, L.dmContext);
  const others = groups.filter((p) => p.bc.tier !== 4);
  const small = (p: Plan) => (p.bc.chat.members ?? Infinity) <= L.smallGroupMembers;
  for (const p of [...others.filter(small), ...others.filter((p) => !small(p))]) newest(p, L.smallGroupContext);
  for (const p of groups) {
    if (p.bc.tier !== 4 || p.shown) continue;
    if (!fits(chatTokens(p.bc.chat))) break;
    p.shown = true;
  }
  // Lines the owner saw on an earlier morning: only in the room left.
  for (const p of waiting) if (quiet(p)) newest(p, L.dmContext);

  const chats: BatchChat[] = [];
  const dropped: Dropped[] = [];
  for (const p of plans) {
    const at = [...p.taken].sort((a, b) => a - b);
    const earlier = at.filter((i) => i < p.firstNew).map((i) => p.pool[i]!);
    const messages = at.filter((i) => i >= p.firstNew).map((i) => p.pool[i]!);
    const left = p.pool.length - p.firstNew - messages.length;
    const waitsOn = quiet(p) ? { waitsOn: p.pool.slice(openFrom(p.pool)).map((m) => m.msgKey) } : {};
    if (p.shown) chats.push({ ...p.bc, messages, earlier, left, ...waitsOn });
    const owner = { chatKey: p.bc.chat.chatKey, chatName: p.bc.chat.name };
    if (left > 0) dropped.push({ ...owner, kept: messages.length, left });
    else if (quiet(p)) {
      // Nothing new: the lines it waits on (of its last dmContext) left out; all of them, a person dropped whole.
      const from = Math.max(openFrom(p.pool), p.pool.length - L.dmContext);
      const keptWaiting = at.filter((i) => i >= from).length;
      if (p.pool.length - from > keptWaiting) dropped.push({ ...owner, kept: keptWaiting, left: p.pool.length - from - keptWaiting });
    }
  }
  dropped.sort((a, b) => b.left - a.left);
  return { kept: { ...batch, chats, calls }, dropped: [...[...callers.values()].filter((d) => d.left > 0), ...dropped] };
}
