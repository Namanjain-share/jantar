/**
 * A morning batch for the run and apply tests (0.15 Messages), as collect()
 * would give it on the synthetic fixture's chats: Asha Test waiting on the
 * deck, Ravi Test's injection, Group One with a reply to the owner, a
 * mention and an image, a "Mom" 1:1 that says "ok", Ravi's two missed calls
 * and Asha's returned one. Synthetic keys, fake numbers, invented names.
 */
import type { ChatOwner, Message } from '@jantar/protocol/messages';
import { budget } from '../../src/messages/morning/budget.js';
import { tierOf, type Batch, type BatchCall, type BatchChat } from '../../src/messages/morning/collect.js';
import { morningInput, type RefMap } from '../../src/messages/morning/input.js';
import { FIXTURE_TEXT } from './fixture.js';

/** Sat 08:30 in the Life zone. */
export const NOW = new Date('2026-11-14T03:00:00.000Z');
export const TZ = 'Asia/Kolkata';
export const TODAY = '2026-11-14';

export const chatKey = (n: number) => `c${'ab'.repeat(7)}${n.toString(16).padStart(2, '0')}`;
export const callKey = (n: number) => `k${'cd'.repeat(7)}${n.toString(16).padStart(2, '0')}`;

export function chat(n: number, name: string, o: Partial<ChatOwner> = {}): ChatOwner {
  return { chatKey: chatKey(n), name, kind: 'dm', lastAt: '2026-11-13T20:00:00.000Z', unread: 0, lastFromMe: false, archived: false, ...o };
}

let stanza = 0;
export function line(c: ChatOwner, at: string, o: Partial<Message> = {}): Message {
  stanza += 1;
  return { msgKey: `${c.chatKey}.3EB0M${stanza}`, at, fromMe: false, sender: o.fromMe ? 'Me' : c.name, kind: 'text', text: `line ${stanza}`, ...o };
}

export function bc(c: ChatOwner, messages: Message[], o: { earlier?: Message[]; waiting?: boolean } = {}): BatchChat {
  const waiting = o.waiting ?? false;
  return { chat: c, messages, earlier: o.earlier ?? [], waiting, tier: tierOf(c, messages, waiting) };
}

export function batchOf(chats: BatchChat[], calls: BatchCall[] = []): Batch {
  return { chats, calls, cursor: { pk: 42, at: '2026-11-13T20:00:00.000Z' }, reset: false, newestAt: '2026-11-13T20:00:00.000Z', waCalls: true, phone: true };
}

export function sample() {
  const asha = chat(1, 'Asha Test', { phone: '919990000001' });
  const ravi = chat(2, 'Ravi Test', { phone: '919990000002' });
  const group = chat(3, 'Group One', { kind: 'group', members: 4 });
  const mom = chat(4, 'Mom', { phone: '919990000003' });
  const at = (hhmm: string) => `2026-11-13T${hhmm}:00.000Z`;
  const l = {
    sure: line(asha, at('09:40'), { fromMe: true, text: 'Sure, send me the outline' }),
    deck: line(asha, at('18:00'), { text: FIXTURE_TEXT.deck }),
    callMe: line(asha, at('18:05'), { text: 'Call me at 6pm about it' }),
    onMyWay: line(ravi, at('09:10'), { fromMe: true, text: 'On my way' }),
    injection: line(ravi, at('19:00'), { text: FIXTURE_TEXT.injection }),
    agenda: line(group, at('12:00'), { fromMe: true, text: 'Agenda for Saturday is in the doc.' }),
    reply: line(group, at('12:30'), { sender: 'Asha Test', text: 'Looks good' }),
    mention: line(group, at('19:30'), { sender: 'Ravi Test', mentionsMe: true, text: '@Me can you check?' }),
    invoice: line(group, at('19:45'), { sender: 'Neel Test', kind: 'image', text: undefined, caption: FIXTURE_TEXT.caption, media: { kind: 'image', bytes: 2_048, local: true } }),
    ok: line(mom, at('08:05'), { text: 'ok' }),
  };
  l.reply = { ...l.reply, replyTo: l.agenda.msgKey, replyToMe: true };
  const calls: Record<'ashaWa' | 'raviWa' | 'raviPhone', BatchCall> = {
    ashaWa: { callKey: callKey(1), at: at('09:30'), who: 'Asha Test', chatKey: asha.chatKey, via: 'whatsapp', incoming: true, missed: true, video: false, durationS: 0, returned: true },
    raviWa: { callKey: callKey(2), at: at('10:00'), who: 'Ravi Test', chatKey: ravi.chatKey, via: 'whatsapp', incoming: true, missed: true, video: false, durationS: 0, returned: false },
    raviPhone: { callKey: callKey(3), at: at('11:00'), who: 'Ravi Test', chatKey: ravi.chatKey, via: 'phone', incoming: true, missed: true, video: false, durationS: 0, returned: false },
  };
  const batch = batchOf(
    [
      bc(group, [l.agenda, l.reply, l.mention, l.invoice]),
      bc(ravi, [l.onMyWay, l.injection], { waiting: true }),
      bc(asha, [l.sure, l.deck, l.callMe], { waiting: true }),
      bc(mom, [l.ok], { waiting: true }),
    ],
    [calls.ashaWa, calls.raviWa, calls.raviPhone],
  );
  return { asha, ravi, group, mom, l, calls, batch };
}

/** What the model reads of `batch`: budget's kept batch, the input and its ids. */
export function prepared(batch: Batch): { kept: Batch; text: string; refs: RefMap } {
  const { kept } = budget(batch);
  const { text, refs } = morningInput(kept, { now: NOW, tz: TZ, ownerName: 'me' });
  return { kept, text, refs };
}

/** The input's id for a reader key (an m, c or k id). */
export function idFor(refs: RefMap, key: string): string {
  for (const map of [refs.m, refs.c, refs.k]) for (const [id, k] of map) if (k === key) return id;
  throw new Error(`no id for ${key}`);
}
