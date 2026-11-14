/**
 * 0.15 Messages' test fixtures: the status, the Today answer (a morning run,
 * reply drafts, call-backs), the skip list, the read log and `api.request`
 * answering the Messages routes by path. Every name, number and chat here is
 * made up: the approved fakes ("Asha Test", "Ravi Test", "Group One", the
 * 9199900000xx numbers).
 */
import { vi } from 'vitest';
import type { LifeStatus, Todo } from '@jantar/protocol';
import type {
  Draft,
  MessagesStatus,
  MessagesTodayResponse,
  MorningRun,
  ReadLogEntry,
  SkipEntry,
} from '@jantar/protocol/messages';
import { ApiError, type Api, type ApiRequest, type ApiRoute } from '../../src/lib/api.js';
import { fakeApi, stateWith } from '../helpers.js';

export const IDS = {
  run: '01JMSGRVN00000000000000001',
  draftAsha: '01JMSGDRAFT000000000000AS1',
  draftGroup: '01JMSGDRAFT000000000000GR1',
  todo: '01JMSGT0D00000000000000001',
  callback: '01JMSGT0D0000000000000CB01',
  asha: 'c00000000000000a1',
  ravi: 'c00000000000000b2',
  group: 'c00000000000000c3',
} as const;

/** Asha's fake number (the fixture's 1:1 with a known number). */
export const ASHA_PHONE = '919990000001';

/** Messages on, with Life (its todos) on too. */
export const ON = stateWith({ features: { messages: true, life: true } });

export function status(over: Partial<MessagesStatus> = {}): MessagesStatus {
  return {
    enabled: true,
    reader: { state: 'ok' },
    whatsapp: { found: true, running: true, newestAt: '2026-01-15T07:58:00.000Z', schemaOk: true },
    phone: { readable: true },
    skipped: 1,
    morning: { at: '08:00', lastRunAt: '2026-01-15T08:00:00.000Z' },
    ...over,
  };
}

export function run(over: Partial<MorningRun> = {}): MorningRun {
  return {
    id: IDS.run,
    at: '2026-01-15T08:00:00.000Z',
    trigger: 'timer',
    state: 'ok',
    stale: false,
    newestAt: '2026-01-15T07:58:00.000Z',
    counts: { chats: 3, messages: 12, calls: 2, todos: 1, replies: 2, callbacks: 1, dropped: 0 },
    dropped: [],
    todoIds: [IDS.todo],
    summary: 'Asha Test asked for the deck by Friday. Group One wants the invoice checked.',
    ...over,
  };
}

export function draft(id: string, over: Partial<Draft> = {}): Draft {
  return {
    id,
    runId: IDS.run,
    chatKey: IDS.asha,
    chatName: 'Asha Test',
    phone: ASHA_PHONE,
    theyAsked: 'Can you send the deck by Friday 5pm?',
    draft: 'Sure, sending it by Friday 5pm & before the call?',
    at: '2026-01-14T21:04:00.000Z',
    state: 'open',
    ...over,
  };
}

export function today(over: Partial<MessagesTodayResponse> = {}): MessagesTodayResponse {
  return {
    run: run(),
    made: null,
    drafts: [draft(IDS.draftAsha), draft(IDS.draftGroup, { chatKey: IDS.group, chatName: 'Group One', phone: undefined, theyAsked: 'Can you check the invoice?', draft: 'Checking it now.' })],
    callbacks: [{ todoId: IDS.callback, who: 'Ravi Test', at: '2026-01-15T11:00:00.000Z' }],
    ...over,
  };
}

export function skipEntry(chatKey: string, name: string, over: Partial<SkipEntry> = {}): SkipEntry {
  return { chatKey, name, kind: 'dm', addedAt: '2026-01-10T09:00:00.000Z', ...over };
}

export function readEntry(over: Partial<ReadLogEntry> = {}): ReadLogEntry {
  return { at: '2026-01-15T07:30:00.000Z', via: 'mcp', pid: 4242, folder: 'example-app', op: 'read', chatKey: IDS.asha, count: 3, ...over };
}

/** Life status with Todos on (the todos the morning made are Life's). */
export const LIFE_STATUS: LifeStatus = {
  open: true,
  timezone: 'UTC',
  today: '2026-01-15',
  currency: null,
  lockScreenDetails: false,
  modules: { todos: true, medicines: false, food: false, places: false, finance: false, posts: false, work: false },
  estimate: { available: false },
  backups: { last: null, count: 0 },
  push: { devices: 1, webpush: true },
};

export const TODO: Todo = { id: IDS.todo, title: 'Send the deck to Asha Test', priority: 'normal', due: { day: '2026-01-16', time: '17:00' }, from: 'messages', createdAt: '2026-01-15T08:00:00.000Z', updatedAt: '2026-01-15T08:00:00.000Z' };

type Answer = (init: ApiRequest) => unknown;

/** `api.request` for Messages' routes: each answer by "METHOD /path/pattern" (a function gets the request); any other is the daemon's 501. */
export function messagesRequest(answers: Record<string, unknown>) {
  const fn = vi.fn(async (route: ApiRoute, init: ApiRequest = {}): Promise<unknown> => {
    const key = `${route.method} ${route.path}`;
    if (!(key in answers)) throw new ApiError('not_implemented', 'not built yet', 501);
    const a = answers[key];
    const v = typeof a === 'function' ? (a as Answer)(init) : a;
    if (v instanceof Error) throw v;
    return v;
  });
  return fn as typeof fn & Api['request'];
}

/** The calls made to one route: their params, query and body. */
export function requested(api: Api, method: string, path: string): ApiRequest[] {
  const calls = (api.request as unknown as ReturnType<typeof vi.fn>).mock.calls as [ApiRoute, ApiRequest | undefined][];
  return calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init ?? {});
}

/** A fake API whose Messages routes answer the defaults here, and `answers` over them. */
export function messagesApi(answers: Record<string, unknown> = {}, over: Partial<Api> = {}) {
  return fakeApi({
    request: messagesRequest({
      'GET /v1/messages/status': status(),
      'GET /v1/messages/today': today(),
      'GET /v1/messages/prefs': { morningAt: '08:00', callbackAt: '11:00' },
      'GET /v1/messages/skip': { skip: [skipEntry(IDS.ravi, 'Ravi Test')] },
      'GET /v1/messages/reads': { reads: [] },
      'GET /v1/messages/chats': { chats: [], total: 0 },
      ...answers,
    }),
    lifeStatus: vi.fn(async () => LIFE_STATUS),
    todosList: vi.fn(async () => ({ today: '2026-01-15', todos: [TODO] })),
    ...over,
  });
}
