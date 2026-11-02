/**
 * v0.10 Chat (spec 0.10 B5, B2): every schema's bounds, the route table
 * (phase, scopes, ctl flags, the Siri door's body limit) and the settings.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_KEY_PREFIX,
  CHAT_PHOTOS_MAX,
  CHAT_PHOTO_MAX_BYTES,
  CHAT_TEXT_MAX,
  CHAT_VOICE_TEXT_MAX,
  CaptureChatBodySchema,
  CaptureChatReplySchema,
  ChatCardSchema,
  ChatChangeSchema,
  ChatItemParamsSchema,
  ChatKeySchema,
  ChatListSchema,
  ChatSendBodySchema,
  ChatTurnSchema,
  MAC_ONLY_SETTING_GROUPS,
  ROUTES,
  SettingsSchema,
  type RouteDef,
  type RouteName,
} from '../src/index.js';

const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

describe('v0.10 Chat schemas', () => {
  it('a message needs text or a photo, at most 4 photos, no unknown key', () => {
    expect(ChatSendBodySchema.safeParse({ text: 'Add oat milk to my list' }).success).toBe(true);
    expect(ChatSendBodySchema.safeParse({ text: '', photos: [ULID] }).success).toBe(true);
    expect(ChatSendBodySchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(ChatSendBodySchema.safeParse({ text: '', photos: [] }).success).toBe(false);
    expect(ChatSendBodySchema.safeParse({ text: 'x', photos: Array(CHAT_PHOTOS_MAX + 1).fill(ULID) }).success).toBe(false);
    expect(ChatSendBodySchema.safeParse({ text: 'x', extra: 1 }).success).toBe(false);
    expect(ChatSendBodySchema.safeParse({ text: 'x'.repeat(CHAT_TEXT_MAX + 1) }).success).toBe(false);
    expect(ChatSendBodySchema.safeParse({ text: 'x', photos: ['../../etc/passwd'] }).success).toBe(false);
  });

  it('the Siri door: strict, trimmed, 1 to 1000 characters; the reply is one message', () => {
    expect(CaptureChatBodySchema.parse({ text: '  How many calories today?  ' })).toEqual({ text: 'How many calories today?' });
    expect(CaptureChatBodySchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(CaptureChatBodySchema.safeParse({ text: 'x'.repeat(CHAT_VOICE_TEXT_MAX + 1) }).success).toBe(false);
    expect(CaptureChatBodySchema.safeParse({ text: 'x', photos: [] }).success).toBe(false);
    expect(CaptureChatReplySchema.safeParse({ message: 'x'.repeat(601) }).success).toBe(false);
  });

  it('changes, cards and turns', () => {
    const change = { n: 0, module: 'todos', op: 'add', ref: ULID, label: 'Todo · Buy oat milk', state: 'done', undoable: true };
    expect(ChatChangeSchema.parse(change)).toEqual(change);
    expect(ChatChangeSchema.safeParse({ ...change, module: 'sessions' }).success).toBe(false);
    expect(ChatChangeSchema.safeParse({ ...change, label: 'x'.repeat(161) }).success).toBe(false);
    const card = { n: 0, kind: 'confirm', module: 'places', op: 'delete', ref: ULID, label: 'Delete café Example Café and its 3 visits?', state: 'waiting' };
    expect(ChatCardSchema.parse(card)).toEqual(card);
    expect(ChatCardSchema.safeParse({ ...card, kind: 'run' }).success).toBe(false);
    const turn = { id: ULID, at: '2026-11-02T10:00:00.000Z', via: 'voice', text: 'x', photos: [], state: 'done', changes: [change], cards: [card], tainted: false, refused: 0 };
    expect(ChatTurnSchema.parse(turn)).toEqual(turn);
    expect(ChatListSchema.parse({ turns: [turn], older: null, ready: { ok: true }, keepDays: 30 }).turns).toHaveLength(1);
    expect(ChatItemParamsSchema.parse({ id: ULID, n: '3' })).toEqual({ id: ULID, n: 3 });
  });

  it('a chat key has its own prefix', () => {
    expect(CHAT_KEY_PREFIX).toBe('jchat_');
    expect(ChatKeySchema.safeParse(`jchat_${'A'.repeat(43)}`).success).toBe(true);
    expect(ChatKeySchema.safeParse(`jcap_${'A'.repeat(43)}`).success).toBe(false);
  });
});

describe('v0.10 Chat routes', () => {
  const chat = (Object.entries(ROUTES) as [RouteName, RouteDef][]).filter(([name]) => name.startsWith('chat') || name === 'captureChat');

  it('every chat route is phase v0.10, with the scopes and ctl flags of the spec', () => {
    const want: Record<string, [string, string, boolean, boolean]> = {
      chatList: ['GET /v1/chat', 'control', false, false],
      chatSend: ['POST /v1/chat', 'control', false, false],
      chatClear: ['DELETE /v1/chat', 'control', true, false],
      chatStatus: ['GET /v1/chat/status', 'admin', true, true],
      chatCancel: ['DELETE /v1/chat/turns/:id', 'control', false, false],
      chatUndo: ['POST /v1/chat/turns/:id/changes/:n/undo', 'control', false, false],
      chatCard: ['POST /v1/chat/turns/:id/cards/:n', 'control', false, false],
      chatCardDismiss: ['POST /v1/chat/turns/:id/cards/:n/dismiss', 'control', false, false],
      chatPhotoAdd: ['POST /v1/chat/photos', 'control', false, false],
      chatPhoto: ['GET /v1/chat/photos/:id', 'control', false, false],
      chatPhotoDelete: ['DELETE /v1/chat/photos/:id', 'control', false, false],
      chatKeyAdd: ['POST /v1/chat/keys', 'admin', true, true],
      chatKeyList: ['GET /v1/chat/keys', 'admin', true, true],
      chatKeyRevoke: ['POST /v1/chat/keys/revoke', 'admin', true, true],
      captureChat: ['POST /v1/capture/chat', 'capture', false, false],
    };
    expect(chat.map(([n]) => n).sort()).toEqual(Object.keys(want).sort());
    for (const [name, def] of chat) {
      const [path, scope, ctl, localOnly] = want[name]!;
      expect(`${def.method} ${def.path}`, name).toBe(path);
      expect(def.phase, name).toBe('v0.10');
      expect(def.scope, name).toBe(scope);
      expect(def.ctl, name).toBe(ctl);
      expect(def.localOnly === true, name).toBe(localOnly);
    }
  });

  it('the phone routes sit behind the ask switch; the photo upload takes raw bytes; the door has an 8 KB body limit', () => {
    for (const [name, def] of chat) if (def.scope === 'control') expect(def.feature, name).toBe('ask');
    expect(ROUTES.chatPhotoAdd.rawBody).toEqual({ maxBytes: CHAT_PHOTO_MAX_BYTES });
    expect(ROUTES.chatPhoto.rawResponse).toBe(true);
    expect(ROUTES.captureChat.bodyLimit).toBe(8 * 1024);
    expect((ROUTES.captureChat as RouteDef).feature).toBeUndefined();
    expect(ROUTES.chatSend.status).toBe(202);
  });
});

describe('v0.10 settings', () => {
  it('ask keeps its name and Mac-only group; keepDays 1-365 (30), voiceModel (sonnet)', () => {
    const s = SettingsSchema.parse({});
    expect(s.ask).toEqual({ enabled: false, keepDays: 30, voiceModel: 'sonnet' });
    expect(SettingsSchema.safeParse({ ask: { keepDays: 0 } }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ask: { keepDays: 366 } }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ask: { voiceModel: 'gpt' } }).success).toBe(false);
    expect(SettingsSchema.parse({ ask: { enabled: true } }).ask.keepDays).toBe(30);
    expect(MAC_ONLY_SETTING_GROUPS).toContain('ask');
  });
});
