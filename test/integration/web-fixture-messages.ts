/**
 * Synthetic 0.15 Messages for the 0.12 layout matrix
 * (web-v011-layout.integration.test.ts): Messages on, a morning run from an
 * hour ago with its summary (the day's one run that made something, so
 * Today shows its Undo), two replies waiting (a 1:1 with a number, so
 * Open in WhatsApp shows, and a group, Copy only), a call-back, the todos it
 * made (two of the Life fixture's own), a busy group left out for size, the
 * times, a skip list of one, and a read log of four. Enough for Today and its
 * settings; every other Messages read answers as an empty one would.
 *
 * `withMessages(fixture)` turns Messages on in the fixture's state and
 * answers the Messages routes before the fixture's own answer. Every DTO is
 * parsed with its protocol schema here, so the fixture can't drift from
 * them. Every name and number is made up (the approved fakes: "Asha Test",
 * "Ravi Test", "Group One", 9199900000xx).
 */
import {
  MessagesChatsResponseSchema,
  MessagesPrefsSchema,
  MessagesReadsResponseSchema,
  MessagesSkipListSchema,
  MessagesStatusSchema,
  MessagesTodayResponseSchema,
} from '@jantar/protocol/messages';
import type { AnsweringFixture } from './browser.js';
import { lid } from './web-fixture-v04.js';

const MIN = 60_000;

/** What withMessages needs of a fixture: its clock and zone, its state, and its answer (browser.ts AnsweringFixture). */
type Answering = AnsweringFixture & { state: { state: unknown } };

const KEYS = { asha: 'c00000000000000a1', ravi: 'c00000000000000b2', group: 'c00000000000000c3', old: 'c00000000000000d4' } as const;
const RUN = '01JX0RVNAAAAAAAAAAAAAAAAA1';

export function messagesData(now: number) {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const run = {
    id: RUN,
    at: iso(60),
    trigger: 'timer',
    state: 'ok',
    stale: false,
    newestAt: iso(62),
    counts: { chats: 9, messages: 141, calls: 3, todos: 2, replies: 2, callbacks: 1, dropped: 43 },
    dropped: [{ chatName: 'Group One', kept: 6, left: 43 }],
    todoIds: [lid(205), lid(201)],
    summary: 'Asha Test asked for the deck by Friday 5pm. Group One wants the invoice checked before the call. Ravi Test called twice and left no message.',
  };
  const status = MessagesStatusSchema.parse({
    enabled: true,
    reader: { state: 'ok' },
    whatsapp: { found: true, running: true, newestAt: iso(3), schemaOk: true },
    phone: { readable: true },
    skipped: 1,
    morning: { at: '08:00', lastRunAt: run.at },
  });
  const today = MessagesTodayResponseSchema.parse({
    run,
    // The day's runs that made something: this one went well and made todos (its own Undo on Today).
    made: [run],
    drafts: [
      {
        id: '01JX0DRAFTAAAAAAAAAAAAAAA1',
        runId: RUN,
        chatKey: KEYS.asha,
        chatName: 'Asha Test',
        phone: '919990000001',
        theyAsked: 'Can you send the deck by Friday 5pm?',
        draft: "Yes, I'll send the deck by Friday 5pm. Anything you want me to add to it first?",
        at: iso(11 * 60),
        state: 'open',
      },
      {
        id: '01JX0DRAFTAAAAAAAAAAAAAAA2',
        runId: RUN,
        chatKey: KEYS.group,
        chatName: 'Group One',
        theyAsked: 'Can you check the invoice?',
        draft: 'Checking it this morning, will reply here by noon.',
        at: iso(9 * 60),
        state: 'open',
      },
    ],
    callbacks: [{ todoId: lid(202), who: 'Ravi Test', at: iso(-120) }],
  });
  const prefs = MessagesPrefsSchema.parse({ morningAt: '08:00', callbackAt: '11:00' });
  const skip = MessagesSkipListSchema.parse({ skip: [{ chatKey: KEYS.old, name: 'Old Group', kind: 'group', addedAt: iso(3 * 24 * 60) }] });
  const reads = MessagesReadsResponseSchema.parse({
    reads: [
      { at: iso(20), via: 'mcp', pid: 4242, folder: 'example-app', op: 'read', chatKey: KEYS.asha, count: 30 },
      { at: iso(45), via: 'phone', op: 'chats', count: 20 },
      { at: iso(60), via: 'morning', op: 'morning', chatKey: KEYS.group, count: 6 },
      { at: iso(26 * 60), via: 'cli', op: 'search', count: 2 },
    ],
  });
  const chat = (chatKey: string, name: string, kind: 'dm' | 'group', minutesAgo: number) => ({ chatKey, name, kind, lastAt: iso(minutesAgo), unread: 0, lastFromMe: false, archived: false });
  const chats = MessagesChatsResponseSchema.parse({ chats: [chat(KEYS.asha, 'Asha Test', 'dm', 30), chat(KEYS.group, 'Group One', 'group', 40), chat(KEYS.ravi, 'Ravi Test', 'dm', 300)], total: 3 });
  return { status, today, prefs, skip, reads, chats };
}

/** `f` with Messages on and its routes answered; the fixture's other answers are unchanged. */
export function withMessages<F extends Answering>(f: F): F {
  const daemon = (f.state.state as { daemon: { features: Record<string, unknown> } }).daemon;
  daemon.features = { ...daemon.features, messages: true };
  const data = messagesData(f.now);
  const theirs = f.v04.answer;
  const answer: AnsweringFixture['v04']['answer'] = (method, url, body) => {
    const path = url.pathname;
    if (method === 'GET' && path === '/v1/messages/status') return { status: 200, body: data.status };
    if (method === 'GET' && path === '/v1/messages/today') return { status: 200, body: data.today };
    if (method === 'GET' && path === '/v1/messages/prefs') return { status: 200, body: data.prefs };
    if (method === 'GET' && path === '/v1/messages/skip') return { status: 200, body: data.skip };
    if (method === 'GET' && path === '/v1/messages/reads') return { status: 200, body: data.reads };
    if (method === 'GET' && path === '/v1/messages/chats') return { status: 200, body: data.chats };
    if (path.startsWith('/v1/messages')) return { status: 404, body: { error: { code: 'not_found', message: 'not in the Messages fixture' } } };
    return theirs(method, url, body);
  };
  return { ...f, v04: { ...f.v04, answer } } as F;
}
