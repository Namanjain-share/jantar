/**
 * The morning run's input (0.15 Messages): the message on the run's stdin,
 * written from budget.ts's `kept` batch, and the short ids it cites.
 *
 *   Today: Sat 2026-11-14
 *   Time: 08:30 (Asia/Kolkata)
 *   Last 7 days: Fri 2026-11-13, Thu 2026-11-12, ...
 *   Next 7 days: Sun 2026-11-15, Mon 2026-11-16, ...
 *
 *   <chat id="c1" name="Asha Test" kind="dm" waiting="yes">
 *   <m at="Thu 14:30" from="Asha Test" earlier="yes">Are we still on?</m>
 *   <m id="m1" at="Fri 23:30" from="Asha Test">Can you send the deck by Friday 5pm?</m>
 *   </chat>
 *   <chat id="c2" name="Group One" kind="group" members="4" left="4996">
 *   <m id="m2" at="Fri 18:00" from="me">Agenda for Saturday is in the doc.</m>
 *   <m id="m3" at="Fri 18:30" from="Asha Test" to_me="yes" reply="m2">Looks good</m>
 *   </chat>
 *   <call id="k1" at="Fri 15:30" who="Ravi Test" via="whatsapp" missed="yes" chat="c3"/>
 *
 * - Ids: `c` a chat, `m` a new line, `k` a call not returned, numbered in
 *   order; RefMap maps each back to the reader's key, and an answer citing
 *   any other is dropped (apply). Lines from before this run
 *   (`earlier="yes"`) have no id: context only.
 * - Times in the Life zone: a weekday and HH:MM within the last six days,
 *   with the date when older. `from="me"` is the owner; `to_me`: the line
 *   mentions or answers him; `reply`: the line it answers, when shown;
 *   `left`: new lines the budget left out.
 * - Names and text are data: control and bidi characters out, any of
 *   MORNING_TAGS inside escaped however it is spelled (rewrite/context.ts
 *   tagEscaper: "</chat>" becomes "<\/chat>"), an attribute on one line with
 *   its quotes as &quot;. Nothing here is logged.
 */
import { dayKeyOf, daysBetween, hhmmOf, shiftDay, weekdayOf } from '@jantar/life-core';
import type { Message } from '@jantar/protocol/messages';
import { tagEscaper } from '../../rewrite/context.js';
import { CONTROL, LINE_END } from '../../rewrite/guards.js';
import { lineBody } from './budget.js';
import { aboutMe, ownerKeys, type Batch, type BatchCall, type BatchChat } from './collect.js';

/** Every tag of the input and the answer: escaped inside any data. */
export const MORNING_TAGS = ['chat', 'm', 'call', 'summary', 'data'] as const;

/** The input's short ids, each to the reader's key: m17 a message, c3 a chat, k2 a call. */
export interface RefMap {
  m: Map<string, string>;
  c: Map<string, string>;
  k: Map<string, string>;
}

export interface MorningInputOptions {
  now: Date;
  /** The Life zone. */
  tz: string;
  /** How the owner's own lines are signed. */
  ownerName: 'me';
}

const escapeTags = tagEscaper(MORNING_TAGS);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** A time this many days back or fewer shows its weekday only. */
const WEEKDAY_ONLY_DAYS = 6;
/** The days listed each side of today. */
const DAYS_AROUND = 7;

/** A line's text as data. */
function text(s: string): string {
  return escapeTags(s.replace(LINE_END, '\n').replace(CONTROL, ''));
}

/** A name as an attribute's value. */
function attr(s: string): string {
  return escapeTags(s.replace(LINE_END, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim()).replace(/"/g, '&quot;');
}

const dayWithWeekday = (day: string) => `${WEEKDAYS[weekdayOf(day)]} ${day}`;

/** The days from `today` + `from` to + `to`, by `step`. */
function days(today: string, from: number, to: number, step: number): string {
  const out: string[] = [];
  for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(dayWithWeekday(shiftDay(today, n)));
  return out.join(', ');
}

/** The input; refs maps its ids back to the reader's keys. */
export function morningInput(batch: Batch, opts: MorningInputOptions): { text: string; refs: RefMap } {
  const refs: RefMap = { m: new Map(), c: new Map(), k: new Map() };
  const today = dayKeyOf(opts.now, opts.tz);
  const when = (iso: string) => {
    const at = new Date(iso);
    const day = dayKeyOf(at, opts.tz);
    const age = daysBetween(day, today);
    return `${age >= 0 && age <= WEEKDAY_ONLY_DAYS ? WEEKDAYS[weekdayOf(day)] : dayWithWeekday(day)} ${hhmmOf(at, opts.tz)}`;
  };
  /** Ids given so far, by message key (a reply cites its line's). */
  const ids = new Map<string, string>();
  const chatIds = new Map<string, string>();

  const line = (m: Message, mine: ReadonlySet<string>, id: string | null) => {
    const a = [...(id ? [`id="${id}"`] : []), `at="${when(m.at)}"`, `from="${m.fromMe ? opts.ownerName : attr(m.sender)}"`];
    if (!id) a.push('earlier="yes"');
    else {
      if (aboutMe(m, mine)) a.push('to_me="yes"');
      const parent = m.replyTo ? ids.get(m.replyTo) : undefined;
      if (parent) a.push(`reply="${parent}"`);
    }
    return `<m ${a.join(' ')}>${text(lineBody(m))}</m>`;
  };

  const chat = (bc: BatchChat, id: string): string[] => {
    const c = bc.chat;
    const a = [`id="${id}"`, `name="${attr(c.name)}"`, `kind="${c.kind}"`];
    if (bc.waiting) a.push('waiting="yes"');
    if (c.kind !== 'dm' && c.members !== undefined) a.push(`members="${c.members}"`);
    if (c.archived) a.push('archived="yes"');
    if (bc.left) a.push(`left="${bc.left}"`);
    const mine = ownerKeys([...bc.earlier, ...bc.messages]);
    const out = [`<chat ${a.join(' ')}>`, ...bc.earlier.map((m) => line(m, mine, null))];
    for (const m of bc.messages) {
      const mid = `m${refs.m.size + 1}`;
      refs.m.set(mid, m.msgKey);
      ids.set(m.msgKey, mid);
      out.push(line(m, mine, mid));
    }
    out.push('</chat>');
    return out;
  };

  const call = (c: BatchCall, id: string) => {
    const a = [`id="${id}"`, `at="${when(c.at)}"`, `who="${attr(c.who)}"`, `via="${c.via}"`, `missed="${c.missed ? 'yes' : 'no'}"`];
    if (c.video) a.push('video="yes"');
    const chatId = c.chatKey ? chatIds.get(c.chatKey) : undefined;
    if (chatId) a.push(`chat="${chatId}"`);
    return `<call ${a.join(' ')}/>`;
  };

  const out = [
    `Today: ${dayWithWeekday(today)}`,
    `Time: ${hhmmOf(opts.now, opts.tz)} (${opts.tz})`,
    `Last ${DAYS_AROUND} days: ${days(today, -1, -DAYS_AROUND, -1)}`,
    `Next ${DAYS_AROUND} days: ${days(today, 1, DAYS_AROUND, 1)}`,
    '',
  ];
  for (const bc of batch.chats) {
    const id = `c${refs.c.size + 1}`;
    refs.c.set(id, bc.chat.chatKey);
    chatIds.set(bc.chat.chatKey, id);
    out.push(...chat(bc, id));
  }
  const calls = batch.calls.filter((c) => !c.returned);
  for (const c of calls) {
    const id = `k${refs.k.size + 1}`;
    refs.k.set(id, c.callKey);
    out.push(call(c, id));
  }
  if (batch.chats.length === 0 && calls.length === 0) out.push('Nothing new since the last run.');
  return { text: out.join('\n'), refs };
}
