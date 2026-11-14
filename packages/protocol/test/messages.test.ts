/**
 * 0.15 Messages (protocol): the morning answer's schema, the switch and its
 * Mac-only settings group, the route table (phase, switch, ctl flags), the
 * `messages` todo source, the keys and the two new error codes.
 */
import { expect, test } from 'vitest';
import * as index from '../src/index.js';
import {
  ERROR_STATUS,
  MAC_ONLY_SETTING_GROUPS,
  MESSAGES_LIMITS,
  NO_FEATURES,
  SettingsSchema,
  TodoFromSchema,
  settingsFeatures,
  type RouteDef,
} from '../src/index.js';
import {
  CallKeySchema,
  ChatKeySchema,
  MESSAGES_ROUTES,
  MessagesChatsQuerySchema,
  MessagesPrefsPatchSchema,
  MessagesPrefsSchema,
  MorningAnswerSchema,
  MorningRunSchema,
  MsgKeySchema,
} from '../src/messages.js';

test('MorningAnswerSchema refuses extra keys and bad refs', () => {
  expect(MorningAnswerSchema.safeParse({ summary: 'x', todos: [{ title: 't', ref: 'x9' }], replies: [], callbacks: [] }).success).toBe(false);
  expect(MorningAnswerSchema.safeParse({ summary: 'x', todos: [], replies: [], callbacks: [], extra: 1 }).success).toBe(false);
  expect(MorningAnswerSchema.safeParse({ summary: 'ok', todos: [{ title: 'Send deck', ref: 'm17', due_day: '2026-11-15' }], replies: [], callbacks: [{ ref: 'k2', who: 'Asha Test', why: 'missed' }] }).success).toBe(true);
});
test('a run report keeps which calls it could not read, and a Life refusal apart from its limit', () => {
  const run = {
    id: '01JMRNNGRN0000000000000001',
    at: '2026-11-14T03:00:00.000Z',
    trigger: 'dry',
    state: 'ok',
    stale: false,
    newestAt: null,
    counts: { chats: 0, messages: 0, calls: 0, todos: 0, replies: 0, callbacks: 0, dropped: 0 },
    dropped: [],
    todoIds: [],
    preview: { todos: [], callbacks: [], replies: [], dropped: [{ kind: 'todo', ref: 'm1', why: 'life_refused' }] },
  };
  expect(MorningRunSchema.parse({ ...run, waCalls: false, phoneCalls: false })).toMatchObject({ waCalls: false, phoneCalls: false });
  expect(MorningRunSchema.parse(run)).not.toHaveProperty('waCalls');
  // A real run Life stopped taking todos from: its limit, or another refusal.
  expect(MorningRunSchema.parse({ ...run, trigger: 'now', lifeRefused: 'limit' }).lifeRefused).toBe('limit');
  expect(MorningRunSchema.parse({ ...run, trigger: 'now', lifeRefused: 'life_refused' }).lifeRefused).toBe('life_refused');
  expect(MorningRunSchema.safeParse({ ...run, lifeRefused: 'duplicate' }).success).toBe(false);
  expect(MorningRunSchema.parse(run)).not.toHaveProperty('lifeRefused');
});
test('messages is a Mac-only group and a feature', () => {
  expect(MAC_ONLY_SETTING_GROUPS).toContain('messages');
  expect(settingsFeatures(SettingsSchema.parse({ messages: { enabled: true } })).messages).toBe(true);
});
test('every messages route is v0.15 and behind the switch except status', () => {
  for (const [name, r] of Object.entries<RouteDef>(MESSAGES_ROUTES)) {
    expect(r.phase).toBe('v0.15');
    expect(r.feature).toBe(name === 'messagesStatus' ? undefined : 'messages');
  }
});
test('TodoFromSchema accepts messages', () => expect(TodoFromSchema.parse('messages')).toBe('messages'));
test('MsgKeySchema ties a message to its chat key', () => {
  expect(MsgKeySchema.safeParse('c0123456789abcdef.3EB0A1B2C3').success).toBe(true);
  expect(MsgKeySchema.safeParse('c0123.3EB0').success).toBe(false);
});

test('the switch is off by default, and off for a client until the daemon says otherwise', () => {
  expect(SettingsSchema.parse({}).messages.enabled).toBe(false);
  expect(settingsFeatures(SettingsSchema.parse({})).messages).toBe(false);
  expect(NO_FEATURES.messages).toBe(false);
});

test('chat and call keys have their own prefixes', () => {
  expect(ChatKeySchema.safeParse('c0123456789abcdef').success).toBe(true);
  expect(ChatKeySchema.safeParse('k0123456789abcdef').success).toBe(false);
  expect(CallKeySchema.safeParse('k0123456789abcdef').success).toBe(true);
  expect(CallKeySchema.safeParse('c0123456789abcdef').success).toBe(false);
  expect(MsgKeySchema.safeParse('c0123456789abcdef.../x').success).toBe(false);
});

test('the reader-down and not-an-image errors', () => {
  expect(ERROR_STATUS.messages_unavailable).toBe(503);
  expect(ERROR_STATUS.not_an_image).toBe(415);
});

test('the CLI and jantar mcp reach what they need on ctl.sock; the phone keeps the rest', () => {
  const ctl = Object.entries<RouteDef>(MESSAGES_ROUTES).filter(([, r]) => r.ctl).map(([n]) => n).sort();
  expect(ctl).toEqual([
    'messagesCalls', 'messagesChats', 'messagesMedia', 'messagesMorningRun', 'messagesRead', 'messagesReadByName',
    'messagesSearch', 'messagesSkipAdd', 'messagesSkipList', 'messagesSkipRemove', 'messagesSkipReset', 'messagesStatus',
  ]);
  for (const r of Object.values<RouteDef>(MESSAGES_ROUTES)) {
    expect(r.scope).toBe('control');
    expect(r.path.startsWith('/v1/messages/')).toBe(true);
  }
  expect(MESSAGES_ROUTES.messagesMedia.rawResponse).toBe(true);
});

test('queries stay inside the limits', () => {
  expect(MessagesChatsQuerySchema.parse({})).toEqual({ limit: 30 });
  expect(MessagesChatsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  expect(MESSAGES_ROUTES.messagesRead.query.safeParse({ limit: String(MESSAGES_LIMITS.readMax + 1) }).success).toBe(false);
  expect(MESSAGES_ROUTES.messagesSearch.query.safeParse({ q: 'deck', limit: String(MESSAGES_LIMITS.searchMax + 1) }).success).toBe(false);
  expect(MESSAGES_ROUTES.messagesRead.query.parse({}).limit).toBe(50);
});

test('morning prefs: off until a time is set, call-backs at 11:00; a patch fills nothing in', () => {
  expect(MessagesPrefsSchema.parse({})).toEqual({ morningAt: null, callbackAt: '11:00' });
  expect(MessagesPrefsPatchSchema.parse({ morningAt: '07:30' })).toEqual({ morningAt: '07:30' });
  expect(MessagesPrefsPatchSchema.safeParse({ morningAt: '7:30' }).success).toBe(false);
  expect(MessagesPrefsPatchSchema.safeParse({ morningAt: null, x: 1 }).success).toBe(false);
});

test("Messages' shapes are the subpath's only, never the package index's", () => {
  expect('MESSAGES_ROUTES' in index).toBe(false);
  expect('MorningAnswerSchema' in index).toBe(false);
});
