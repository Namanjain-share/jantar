/**
 * v0.5.3 Ask shapes: protocol and settings versions unchanged, the Mac-only
 * Ask switch and its feature flag, the seven routes (control, behind the
 * switch, never on ctl.sock, write replies ids or ok), the card form at its
 * edges (Life's own field schemas, strict objects, four types only), a turn
 * whose cut reply (500 with the "…") still parses, and the limits.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ASK_APPLY_WITHIN_MS,
  ASK_CARDS_MAX,
  ASK_KEEP_DAYS,
  ASK_REPLY_MAX,
  ASK_TEXT_MAX,
  ASK_TURNS_KEPT,
  AskActionSchema,
  AskAddBodySchema,
  AskCardParamsSchema,
  AskCardSchema,
  AskListSchema,
  AskSendBodySchema,
  AskTurnSchema,
  AskWriteActionSchema,
  FeaturesSchema,
  FoodBodySchema,
  IdReplySchema,
  MAC_ONLY_SETTING_GROUPS,
  MoneyBodySchema,
  NO_FEATURES,
  OkReplySchema,
  PROTOCOL_VERSION,
  ROUTES,
  SETTINGS_VERSION,
  SettingsSchema,
  TodoBodySchema,
  applySettingsPatch,
  defaultSettings,
  macOnlyGroupIn,
  settingsFeatures,
  type AskTurn,
  type RouteDef,
  type RouteName,
} from '../src/index.js';

const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const DAY = '2026-11-01';

const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];
// The Mac's own v0.5.3 routes (folder todos, the test push) are in v053.test.ts.
const v053 = routes.filter(([, r]) => r.phase === 'v0.5.3' && r.feature === 'ask');
const names = (list: [RouteName, RouteDef][]) => list.map(([n]) => n).sort();

describe('v0.5.3 versions, settings and switches', () => {
  it('keeps protocol 3 and settings version 2', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(SETTINGS_VERSION).toBe(2);
  });

  it('Ask is off by default, a Mac-only group, and a feature flag an older daemon leaves off', () => {
    expect(defaultSettings().ask).toEqual({ enabled: false });
    expect(MAC_ONLY_SETTING_GROUPS).toContain('ask');
    expect(macOnlyGroupIn({ ask: { enabled: true } })).toBe('ask');
    expect(settingsFeatures(SettingsSchema.parse({ ask: { enabled: true } })).ask).toBe(true);
    expect(settingsFeatures(defaultSettings()).ask).toBe(false);
    expect(NO_FEATURES.ask).toBe(false);
    const { ask: _gone, ...older } = NO_FEATURES;
    expect(FeaturesSchema.parse(older).ask).toBe(false);
    // An older config without the group gets it off; an unknown key inside it is refused like every other setting.
    const { ask: _none, ...oldConfig } = defaultSettings();
    expect(SettingsSchema.parse(oldConfig).ask).toEqual({ enabled: false });
    expect(applySettingsPatch(defaultSettings(), { ask: { model: 'opus' } }).ok).toBe(false);
    expect(applySettingsPatch(defaultSettings(), { ask: { enabled: true } })).toMatchObject({ ok: true, settings: { ask: { enabled: true } } });
  });

  it('the limits', () => {
    expect([ASK_TEXT_MAX, ASK_REPLY_MAX, ASK_CARDS_MAX, ASK_TURNS_KEPT, ASK_KEEP_DAYS]).toEqual([1000, 500, 10, 30, 7]);
    // Add and Undo share one window: a day.
    expect(ASK_APPLY_WITHIN_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('v0.5.3 routes', () => {
  it('are the seven Ask routes, under /v1/ask, control scope (reads too), behind the switch, never on ctl.sock', () => {
    expect(names(v053)).toEqual(['askAdd', 'askCancel', 'askClear', 'askList', 'askSend', 'askSkip', 'askUndo']);
    for (const [name, r] of v053) {
      expect(r.path.startsWith('/v1/ask'), name).toBe(true);
      expect(r.scope, name).toBe('control');
      expect(r.feature, name).toBe('ask');
      expect(r.ctl, name).toBe(false);
      expect(r.localOnly, name).toBeUndefined();
      expect(r.rawBody, name).toBeUndefined();
      expect(r.summary.length, name).toBeGreaterThan(5);
      if (r.method === 'GET') expect(r.body, name).toBeUndefined();
    }
    // Nothing else sits behind the Ask switch.
    expect(names(routes.filter(([, r]) => r.feature === 'ask'))).toEqual(names(v053));
  });

  it('methods, paths and status', () => {
    const at = (n: RouteName) => `${ROUTES[n].method} ${ROUTES[n].path}`;
    expect(at('askList')).toBe('GET /v1/ask');
    expect(at('askSend')).toBe('POST /v1/ask');
    expect(at('askClear')).toBe('DELETE /v1/ask');
    expect(at('askCancel')).toBe('DELETE /v1/ask/turns/:id');
    expect(at('askAdd')).toBe('POST /v1/ask/turns/:id/actions/:n');
    expect(at('askSkip')).toBe('POST /v1/ask/turns/:id/actions/:n/skip');
    expect(at('askUndo')).toBe('DELETE /v1/ask/turns/:id/actions/:n');
    expect(ROUTES.askSend.status).toBe(202);
    expect(names(v053.filter(([, r]) => r.status !== undefined))).toEqual(['askSend']);
  });

  it('write replies are ids or ok, never text; the list is the one reply with text', () => {
    const ALLOWED: z.ZodType[] = [IdReplySchema, OkReplySchema];
    for (const [name, r] of v053) {
      if (r.method === 'GET') continue;
      expect(ALLOWED.includes(r.response as z.ZodType), name).toBe(true);
    }
    expect(ROUTES.askSend.response).toBe(IdReplySchema);
    expect(ROUTES.askAdd.response).toBe(IdReplySchema);
    expect(ROUTES.askList.response).toBe(AskListSchema);
  });
});

describe('the card form', () => {
  const todo = { type: 'todo' as const, title: 'Call the bank', due: { day: DAY, time: '17:00' }, repeat: 'daily' as const, priority: 'high' as const, projectId: ID, notes: 'x' };
  const food = { type: 'food' as const, day: DAY, name: 'Roti', kcal: 240 };
  const money = { type: 'money' as const, kind: 'expense' as const, amount: 25000, category: 'Food', note: 'lunch', day: DAY };

  it('takes the four types, strict, and nothing else', () => {
    for (const a of [todo, food, money, { type: 'show', what: 'due' }, { type: 'show', what: 'calories' }, { type: 'show', what: 'meds' }]) {
      expect(AskActionSchema.safeParse(a).success, JSON.stringify(a)).toBe(true);
    }
    for (const bad of [
      { type: 'shell', command: 'touch x' },
      { type: 'settings', patch: {} },
      { type: 'medicine', name: 'Examplocin', taken: true },
      { type: 'intel', url: 'https://example.com' },
      { type: 'show', what: 'bills' },
      { type: 'show', what: 'spent' },
      { ...todo, id: ID },
      { ...food, save: true },
      { ...money, billId: ID },
      { ...todo, repeat: 'hourly' },
    ]) {
      expect(AskActionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // A show card is never a write.
    expect(AskWriteActionSchema.safeParse({ type: 'show', what: 'due' }).success).toBe(false);
  });

  it("uses Life's own field limits", () => {
    const ok = (a: unknown) => AskActionSchema.safeParse(a).success;
    expect(ok({ ...todo, title: 'x'.repeat(200) })).toBe(true);
    expect(ok({ ...todo, title: 'x'.repeat(201) })).toBe(false);
    expect(ok({ ...todo, title: '   ' })).toBe(false);
    expect(ok({ ...todo, notes: 'x'.repeat(2001) })).toBe(false);
    expect(ok({ ...todo, due: { day: DAY, time: '25:00' } })).toBe(false);
    expect(ok({ ...food, kcal: 10_001 })).toBe(false);
    expect(ok({ ...food, kcal: 1.5 })).toBe(false);
    expect(ok({ ...food, name: 'x'.repeat(81) })).toBe(false);
    expect(ok({ ...money, amount: 0 })).toBe(false);
    expect(ok({ ...money, amount: 1e12 + 1 })).toBe(false);
    expect(ok({ ...money, note: 'x'.repeat(201) })).toBe(false);
    expect(ok({ ...money, category: 'x'.repeat(25) })).toBe(false);
    // What Add builds from a card passes Life's own bodies.
    expect(TodoBodySchema.safeParse({ title: todo.title, due: todo.due, repeat: { freq: 'daily' } }).success).toBe(true);
    expect(FoodBodySchema.safeParse({ day: food.day, name: food.name, kcal: food.kcal }).success).toBe(true);
    const { type: _m, ...moneyBody } = money;
    expect(MoneyBodySchema.safeParse(moneyBody).success).toBe(true);
  });

  it('a card: proposed, added (with the item it made) or skipped, with one flag at most', () => {
    expect(AskCardSchema.parse({ action: todo, state: 'added', ref: ID, flag: 'past_time' })).toMatchObject({ state: 'added', ref: ID });
    expect(AskCardSchema.safeParse({ action: todo, state: 'undone' }).success).toBe(false);
    expect(AskCardSchema.safeParse({ action: todo, state: 'proposed', flag: 'later' }).success).toBe(false);
  });
});

describe('turns and bodies', () => {
  const turn = (over: Partial<AskTurn> = {}): AskTurn => ({ id: ID, at: '2026-11-01T08:35:00.000Z', text: 'todo add call the bank', state: 'done', cards: [], dropped: 0, ...over });

  it('a reply cut to 500 with its "…" parses; 501 does not', () => {
    const cut = `${'x'.repeat(ASK_REPLY_MAX - 1)}…`;
    expect(cut.length).toBe(ASK_REPLY_MAX);
    expect(AskTurnSchema.safeParse(turn({ reply: cut })).success).toBe(true);
    expect(AskTurnSchema.safeParse(turn({ reply: `${cut}x` })).success).toBe(false);
  });

  it('at most ten cards a turn; dropped is a count', () => {
    const card = { action: { type: 'show' as const, what: 'due' as const }, state: 'proposed' as const };
    expect(AskTurnSchema.safeParse(turn({ cards: Array.from({ length: ASK_CARDS_MAX }, () => card) })).success).toBe(true);
    expect(AskTurnSchema.safeParse(turn({ cards: Array.from({ length: ASK_CARDS_MAX + 1 }, () => card) })).success).toBe(false);
    expect(AskTurnSchema.safeParse(turn({ dropped: -1 })).success).toBe(false);
    expect(AskListSchema.parse({ ready: false, reason: 'Ask needs Claude Code on this Mac.', turns: [turn()] }).turns).toHaveLength(1);
  });

  it('send: trimmed, 1 to 1000 characters, strict', () => {
    expect(AskSendBodySchema.parse({ text: '  todo add milk  ' })).toEqual({ text: 'todo add milk' });
    expect(AskSendBodySchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(AskSendBodySchema.safeParse({ text: 'x'.repeat(ASK_TEXT_MAX) }).success).toBe(true);
    expect(AskSendBodySchema.safeParse({ text: 'x'.repeat(ASK_TEXT_MAX + 1) }).success).toBe(false);
    expect(AskSendBodySchema.safeParse({ text: 'hi', model: 'opus' }).success).toBe(false);
  });

  it('add: an edit is a write action or nothing; params name a turn and a card 0 to 9', () => {
    expect(AskAddBodySchema.parse({})).toEqual({});
    expect(AskAddBodySchema.safeParse({ edit: { type: 'food', day: DAY, name: 'Dal', kcal: 180 } }).success).toBe(true);
    expect(AskAddBodySchema.safeParse({ edit: { type: 'show', what: 'due' } }).success).toBe(false);
    expect(AskAddBodySchema.safeParse({ skip: true }).success).toBe(false);
    expect(AskCardParamsSchema.parse({ id: ID, n: '9' })).toEqual({ id: ID, n: 9 });
    expect(AskCardParamsSchema.safeParse({ id: ID, n: '10' }).success).toBe(false);
    expect(AskCardParamsSchema.safeParse({ id: ID, n: '-1' }).success).toBe(false);
    expect(AskCardParamsSchema.safeParse({ id: 'not-an-id', n: '0' }).success).toBe(false);
  });
});
