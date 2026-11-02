/**
 * The Chat part end to end inside the daemon (spec 0.10 B6, B11.4): the
 * real exec runs the fixtures' fake claude (one login, `claude -p`), which
 * starts the real bridge from assets/chat/bridge.mjs against the real
 * dispatcher; Life's six modules on a life.db in a fake home. Every value
 * synthetic.
 *
 * Writes land with Undo; deletes are cards; reads cross modules; an init
 * line with an extra tool aborts before any call; tools outside the turn's
 * list are refused; a refused isolation option fails the turn; the queue
 * holds three; Siri's answer carries the daemon's count sentence; a restart
 * keeps the thread and fails what was running; Clear empties it; the run
 * dir and socket are gone after each run.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chatRuns, chatText, makeFakeHome, makePng, setFakeClaude, type FakeHome } from '@jantar/fixtures';
import { CHAT_QUEUE_MAX, type ChatTurn } from '@jantar/protocol';
import type { ChatService, LifeService } from '../../src/contracts.js';
import { CHAT_SENTENCES, buildChatService } from '../../src/chat/service.js';
import { FakeClock } from '../../src/core/clock.js';
import { createExecFile } from '../../src/core/exec.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';
import { LIFE_MODULE_BUILDERS } from '../../src/life/index.js';
import { buildLifeService } from '../../src/life/service.js';
import { makeFakes } from '../api/fakes.js';
import { FakeIntel, NOW, PHONE, TODAY, chatSettings, fakeMeetings } from './helpers.js';

let home: FakeHome;
let ctx: TestContext;
let life: LifeService;
let chat: ChatService;
let intel: FakeIntel;
const WAIT = { timeout: 30_000, interval: 25 };

async function boot(): Promise<void> {
  ctx = createTestContext({
    userHome: home.home,
    home: home.jantarHome,
    env: home.env,
    exec: createExecFile(),
    bins: { claude: home.bins.claude, cswap: home.bins.cswap, node: process.execPath, sips: home.bins.sips },
    accountsMode: 'single',
    settings: chatSettings(),
    clock: new FakeClock(NOW),
  });
  const f = makeFakes(ctx);
  life = buildLifeService(ctx, { sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy, notifiers: f.notifiers }, LIFE_MODULE_BUILDERS, { macZone: 'UTC', send: async () => ({ delivered: 0, failed: 0 }) });
  await life.start();
  intel = new FakeIntel();
  chat = buildChatService(ctx, {
    life,
    intel,
    meetings: fakeMeetings(() => life),
    board: { state: () => ctx.store.getState(), page: async () => ({ items: [], nextBefore: null }) },
    usage: f.usage,
    ccwLegacy: f.ccwLegacy,
    notifiers: f.notifiers,
  });
  await chat.start();
}

beforeAll(async () => {
  home = await makeFakeHome({ sessions: [] });
  await boot();
}, 30_000);
afterAll(async () => {
  await chat?.stop();
  await life?.stop();
  await home.cleanup();
});
afterEach(async () => {
  await setFakeClaude(home, {});
});

function turn(id: string): ChatTurn | undefined {
  const r = chat.list(PHONE);
  return r.ok ? r.value.turns.find((t) => t.id === id) : undefined;
}

async function ask(text: string): Promise<ChatTurn> {
  const sent = chat.send({ text }, PHONE);
  if (!sent.ok) throw new Error(sent.reason);
  return vi.waitFor(() => {
    const t = turn(sent.value.id);
    if (!t || t.state === 'queued' || t.state === 'running') throw new Error('not yet');
    return t;
  }, WAIT);
}

const runAudits = () => ctx.db.audit.list({ limit: 200 }).filter((a) => a.action === 'chat.run');

describe('a turn through the fake claude, the bridge and the dispatcher', () => {
  it('chat-write: a todo added, a café rated and a visit logged, each with Undo; the run dir and socket are gone', async () => {
    life.places.create({ name: 'Sample Dosa House' }, PHONE);
    const t = await ask(chatText('chat-write', 'add oat milk and rate the dosa place'));
    expect(t.state, t.reason).toBe('done');
    expect(t.reply).toBe('Done. todo added, cafe rated, visit logged.');
    expect(t.changes.map((c) => [c.module, c.op, c.state, c.undoable])).toEqual([
      ['todos', 'add', 'done', true],
      ['places', 'edit', 'done', true],
      ['places', 'log', 'done', true],
    ]);
    const todos = life.todos.listTodos({ done: false });
    expect(todos.ok && todos.value.todos.map((x) => x.title)).toContain('Buy oat milk');
    const places = life.places.list({ filter: 'all', sort: 'best' });
    expect(places.ok && places.value.places[0]).toMatchObject({ stars: 4, ratings: { work: 5 }, tried: true, visits: { count: 1 } });
    // Undo from another device puts the café back.
    expect(await chat.undo(t.id, 1, PHONE)).toEqual({ ok: true, value: true });
    const after = life.places.list({ filter: 'all', sort: 'best' });
    expect(after.ok && after.value.places[0]?.stars).toBeUndefined();
    expect(readdirSync(join(ctx.paths.chatDir, 'run'))).toEqual([]);
    expect(readdirSync(ctx.paths.runDir).filter((n) => n.startsWith('chat-'))).toEqual([]);
    expect(runAudits().at(-1)?.params).toMatchObject({ turnId: t.id, via: 'phone', outcome: 'ok', writes: 3, cards: 0, refused: 0, tainted: false, promptVersion: 'v1' });
  });

  it('chat-read reads across modules; the run had no built-in tool and only this turn\'s tools', async () => {
    life.food.add({ day: TODAY, name: 'Dal', kcal: 180 }, PHONE);
    const t = await ask(chatText('chat-read', 'how am I doing'));
    expect(t.state, t.reason).toBe('done');
    expect(t.reply).toMatch(/^Here is what I found: today 2026; todos_find \d+; places_find \d+; money_month 2026; sessions_find 0; accounts_usage /);
    expect(t.changes).toEqual([]);
    const run = (await chatRuns(home)).at(-1);
    expect(run?.denials).toEqual([]);
    expect(run?.calls.map((c) => c.name)).toEqual(['today', 'todos_find', 'places_find', 'money_month', 'sessions_find', 'accounts_usage']);
  });

  it('chat-delete: a Confirm card, nothing deleted; the tap deletes', async () => {
    life.todos.createTodo({ title: 'Call the bank' }, PHONE);
    const t = await ask(chatText('chat-delete'));
    expect(t.cards).toEqual([expect.objectContaining({ kind: 'confirm', module: 'todos', op: 'delete', state: 'waiting' })]);
    const still = life.todos.listTodos({ done: false });
    expect(still.ok && still.value.todos.some((x) => x.id === t.cards[0]?.ref)).toBe(true);
    expect(await chat.card(t.id, 0, PHONE)).toEqual({ ok: true, value: true });
    const gone = life.todos.listTodos({ done: false });
    expect(gone.ok && gone.value.todos.some((x) => x.id === t.cards[0]?.ref)).toBe(false);
  });

  it('chat-init-bash: the init line lists Bash, the run is aborted before any call, nothing written', async () => {
    const t = await ask(chatText('chat-init-bash'));
    expect(t).toMatchObject({ state: 'failed', reason: CHAT_SENTENCES.notIsolated, changes: [], cards: [] });
    expect(runAudits().at(-1)?.params).toMatchObject({ outcome: 'not_isolated', toolCalls: 0 });
  });

  it('chat-init-nomcp: no server connected, the run fails as not isolated', async () => {
    const t = await ask(chatText('chat-init-nomcp'));
    expect(t).toMatchObject({ state: 'failed', reason: CHAT_SENTENCES.notIsolated });
  });

  it('chat-bypass: tools outside the turn reach nothing (send_prompt, pending_decide, settings_patch, session_key)', async () => {
    const t = await ask(chatText('chat-bypass'));
    expect(t.state).toBe('done');
    expect(t.refused).toBe(4);
    const run = (await chatRuns(home)).at(-1);
    expect(run?.calls.map((c) => [c.name, c.isError, c.text])).toEqual([
      ['send_prompt', true, 'Not a tool of this turn.'],
      ['pending_decide', true, 'Not a tool of this turn.'],
      ['settings_patch', true, 'Not a tool of this turn.'],
      ['session_key', true, 'Not a tool of this turn.'],
    ]);
  });

  it('chat-refuse-option: an isolation option refused fails the turn; nothing weaker runs', async () => {
    const t = await ask(chatText('chat-refuse-option'));
    expect(t).toMatchObject({ state: 'failed', reason: CHAT_SENTENCES.notIsolated });
    expect(runAudits().at(-1)?.params).toMatchObject({ outcome: 'flags_rejected' });
  });

  it('chat-flood: 10 writes land, the rest refused, calls capped', async () => {
    const t = await ask(chatText('chat-flood'));
    expect(t.state).toBe('done');
    expect(t.changes).toHaveLength(10);
    expect(t.refused).toBeGreaterThanOrEqual(20);
  });

  it('the queue holds three unfinished turns; a fourth is refused', async () => {
    await setFakeClaude(home, { mode: 'chat-slow', slowMs: 1500 });
    const ids: string[] = [];
    for (let i = 0; i < CHAT_QUEUE_MAX; i++) {
      const r = chat.send({ text: `slow ${i}` }, PHONE);
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.value.id);
    }
    expect(chat.send({ text: 'one more' }, PHONE)).toMatchObject({ ok: false, code: 'conflict', reason: CHAT_SENTENCES.busy });
    expect(chat.cancel(ids[2] ?? '', PHONE)).toEqual({ ok: true, value: true });
    expect(turn(ids[2] ?? '')?.state).toBe('cancelled');
    await vi.waitFor(() => {
      for (const id of ids.slice(0, 2)) if (turn(id)?.state !== 'done') throw new Error('not yet');
    }, WAIT);
  }, 60_000);

  it('voice: the spoken reply and the count sentence, from the journal', async () => {
    life.places.create({ name: 'Example Café' }, PHONE);
    const r = await chat.voice(chatText('chat-write', 'by voice'), { kind: 'capture', keyId: 'synthetic-key' }, 60_000);
    expect(r.outcome).toBe('answered');
    expect(r.message).toBe('Done. todo added, cafe rated, visit logged. Added 2 and changed 1. Undo is in Jantar.');
    expect(turn(r.turnId ?? '')?.via).toBe('voice');
    const del = await chat.voice(chatText('chat-delete', 'by voice'), { kind: 'capture', keyId: 'synthetic-key' }, 60_000);
    expect(del.message).toBe('I asked you to confirm the delete. 1 to confirm in Jantar.');
  });

  it("Try again: a failed turn's photo goes with the new message; a photo sent and answered does not", async () => {
    const up = await chat.photoAdd(makePng(64, 48), PHONE);
    if (!up.ok) throw new Error(up.reason);
    const photo = up.value.id;
    const send = async (text: string) => {
      const sent = chat.send({ text, photos: [photo] }, PHONE);
      if (!sent.ok) return sent;
      return vi.waitFor(() => {
        const t = turn(sent.value.id);
        if (!t || t.state === 'queued' || t.state === 'running') throw new Error('not yet');
        return t;
      }, WAIT);
    };
    const failed = await send(chatText('chat-init-nomcp', 'what is on this bill'));
    expect(failed).toMatchObject({ state: 'failed', photos: [{ id: photo, gone: false }] });
    const again = await send(chatText('chat-photos', 'what is on this bill'));
    expect(again).toMatchObject({ state: 'done', photos: [{ id: photo, gone: false }] });
    expect((again as ChatTurn).reply).toMatch(/^I see 1 photo/);
    // The failed turn still shows it.
    expect(turn((failed as ChatTurn).id)?.photos).toEqual([expect.objectContaining({ id: photo })]);
    expect((await chat.photo(photo)).ok).toBe(true);
    expect(chat.send({ text: 'once more', photos: [photo] }, PHONE)).toMatchObject({ ok: false, reason: CHAT_SENTENCES.photoGone });
  });

  it('a restart keeps the thread; Clear empties it and the photo folder', async () => {
    const before = chat.list(PHONE);
    const n = before.ok ? before.value.turns.length : 0;
    expect(n).toBeGreaterThan(5);
    await chat.stop();
    await chat.start();
    const after = chat.list(PHONE);
    expect(after.ok && after.value.turns.length).toBe(n);
    expect(existsSync(ctx.paths.chatDb)).toBe(true);
    expect(await chat.clear(PHONE)).toEqual({ ok: true, value: true });
    const cleared = chat.list(PHONE);
    expect(cleared.ok && cleared.value.turns).toEqual([]);
    expect(chat.status()).toMatchObject({ turns: 0, photos: 0 });
    // Items Chat added stay in Life.
    const todos = life.todos.listTodos({ done: false });
    expect(todos.ok && todos.value.todos.some((x) => x.title === 'Buy oat milk')).toBe(true);
  });

  it('off: the list says why and sending is refused', async () => {
    await ctx.settings.patch({ ask: { enabled: false } });
    expect(chat.send({ text: 'hello' }, PHONE)).toMatchObject({ ok: false, code: 'forbidden', reason: CHAT_SENTENCES.off });
    const l = chat.list(PHONE);
    expect(l.ok && l.value.ready).toEqual({ ok: false, reason: CHAT_SENTENCES.off });
    await ctx.settings.patch({ ask: { enabled: true } });
  });
});
