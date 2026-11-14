/**
 * The morning run's budget (0.15 Messages): what of a batch (collect.ts)
 * goes to the model, about `maxTokens` (MESSAGES_LIMITS.morningTokens) by
 * an estimate of UTF-8 bytes / 3, so Hinglish, Devanagari and emoji cost
 * what they weigh.
 *
 * - Only lines with something in them: system, reaction and deleted lines
 *   and a skipped person's placeholders go. Each line is cut at
 *   perMessageChars (chat/text.ts cut(): never inside a surrogate pair);
 *   a non-text line is a short mark ("[image: invoice]", "[voice 0:42]").
 * - Filled in this order, each step newest first, until the next piece
 *   doesn't fit; nothing after it goes in, so a lower tier never takes the
 *   place of a higher one:
 *   0. the missed calls not returned (a line each);
 *   1. the waiting 1:1s (their last dmContext lines, earlier ones counted),
 *      then in every group the windows of mentionWindow lines each side of
 *      a new line that mentions or answers the owner (busy groups too);
 *   2. the other 1:1s (their last dmContext lines);
 *   3. the other groups (their last smallGroupContext lines), those of at
 *      most smallGroupMembers first;
 *   4. the busy groups: a count of their new lines only (the chat's `left`).
 * - `kept` holds the chats in that order, each line oldest first with the
 *   chat's `left`; `dropped` every chat with new lines left out, most first.
 *
 * The estimate counts each line in input.ts's markup at its longest (ids,
 * times, attributes), plus HEADER_TOKENS for the lines before the first chat.
 */
import { MESSAGES_LIMITS } from '@jantar/protocol';
import type { ChatOwner, Message } from '@jantar/protocol/messages';
import { cut } from '../../chat/text.js';
import { aboutMe, isContent, ownerKeys, type Batch, type BatchCall, type BatchChat } from './collect.js';

/** The estimate's rate: a token per this many UTF-8 bytes. */
export const BYTES_PER_TOKEN = 3;
/** input.ts's lines before the first chat (the day, the time and zone, the days around), at most. */
export const HEADER_TOKENS = 150;

/** About how many tokens `s` costs: its UTF-8 bytes / BYTES_PER_TOKEN, rounded up. */
export function estimateTokens(s: string): number {
  return Math.ceil(Buffer.byteLength(s, 'utf8') / BYTES_PER_TOKEN);
}

/** A chat left out, in part or whole: its new lines kept and left out. */
export interface Dropped {
  chatName: string;
  kept: number;
  left: number;
}

// input.ts's markup at its longest, for the estimate.
const LINE_FRAME = '<m id="m00000" at="Wed 2026-11-11 00:00" from="" to_me="yes" reply="m00000"></m>\n';
const CHAT_FRAME = '<chat id="c0000" name="" kind="community" waiting="yes" members="00000" archived="yes" left="000000">\n</chat>\n';
const CALL_FRAME = '<call id="k00000" at="Wed 2026-11-11 00:00" who="" via="whatsapp" missed="yes" video="yes" chat="c0000"/>\n';
/** A mark's own characters: "[", ": " and "]". */
const MARK_CHARS = 4;
const MINUTE_S = 60;
const HOUR_S = 3_600;

/** "0:42", "1:02:05". */
function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / HOUR_S);
  const m = Math.floor((s % HOUR_S) / MINUTE_S);
  return h > 0 ? `${h}:${two(m)}:${two(s % MINUTE_S)}` : `${m}:${two(s % MINUTE_S)}`;
}

/** "[head]" or "[head: detail]", the detail cut so the whole stays within perMessageChars. */
function mark(head: string, detail: string | undefined): string {
  return detail ? `[${head}: ${cut(detail, MESSAGES_LIMITS.perMessageChars - head.length - MARK_CHARS)}]` : `[${head}]`;
}

/**
 * A line as the model reads it: its text, or a mark for what it holds
 * ("[image: caption]", "[voice 0:42]", "[document: name.pdf]",
 * "[location]", "[contact]", "[sticker]"), at most perMessageChars.
 */
export function lineBody(m: Message): string {
  const text = m.text?.trim() || undefined;
  const caption = m.caption?.trim() || undefined;
  const timed = (head: string) => (m.media?.durationS ? `${head} ${clock(m.media.durationS)}` : head);
  let body: string;
  switch (m.kind) {
    case 'text':
    case 'link':
      body = text ?? '[message]';
      break;
    case 'video':
    case 'voice':
      body = mark(timed(m.kind), caption ?? text);
      break;
    case 'document':
      body = mark(m.kind, m.media?.fileName?.trim() || caption || text);
      break;
    case 'image':
    case 'gif':
    case 'sticker':
    case 'location':
    case 'contact':
    case 'poll':
    case 'call':
      body = mark(m.kind, caption ?? text);
      break;
    default:
      body = text ?? '[message]';
  }
  return cut(body, MESSAGES_LIMITS.perMessageChars);
}

/** A line as kept: its text and caption cut at perMessageChars. */
function trimmed(m: Message): Message {
  const max = MESSAGES_LIMITS.perMessageChars;
  return { ...m, ...(m.text !== undefined ? { text: cut(m.text, max) } : {}), ...(m.caption !== undefined ? { caption: cut(m.caption, max) } : {}) };
}

const lineTokens = (m: Message) => estimateTokens(LINE_FRAME + m.sender + lineBody(m));
const chatTokens = (c: ChatOwner) => estimateTokens(CHAT_FRAME + c.name);
const callTokens = (c: BatchCall) => estimateTokens(CALL_FRAME + c.who);
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
  const mine = ownerKeys(p.pool);
  const out: number[] = [];
  for (let a = p.pool.length - 1; a >= p.firstNew; a--) {
    if (!aboutMe(p.pool[a]!, mine)) continue;
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
    if (fresh.length === 0) return [];
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
  for (const c of batch.calls) {
    if (c.returned) continue;
    if (!fits(callTokens(c))) break;
    calls.push(c);
  }
  const dms = plans.filter((p) => isDm(p.bc.chat));
  const groups = plans.filter((p) => !isDm(p.bc.chat));
  for (const p of dms) if (p.bc.tier === 1) newest(p, L.dmContext);
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

  const chats: BatchChat[] = [];
  const dropped: Dropped[] = [];
  for (const p of plans) {
    const at = [...p.taken].sort((a, b) => a - b);
    const earlier = at.filter((i) => i < p.firstNew).map((i) => p.pool[i]!);
    const messages = at.filter((i) => i >= p.firstNew).map((i) => p.pool[i]!);
    const left = p.pool.length - p.firstNew - messages.length;
    if (p.shown) chats.push({ ...p.bc, messages, earlier, left });
    if (left > 0) dropped.push({ chatName: p.bc.chat.name, kept: messages.length, left });
  }
  dropped.sort((a, b) => b.left - a.left);
  return { kept: { ...batch, chats, calls }, dropped };
}
