/**
 * Ask's run (spec 3.1, 3.5; 12.1 and 12.2 "runner"), through the real exec
 * against a fake home: the fake claude (its Ask mode, picked by the prompt
 * file's name) runs as a process and records its argv, stdin, env and cwd.
 *
 * - argv is Rewrite's isolation argv with assistant-v2.md and Rewrite's
 *   model and fallback (opus and sonnet; a changed rewrite.model is
 *   followed at the next run); the message is on stdin only; the env holds
 *   no other login or API key; the cwd is the empty work/ under the run dir.
 * - Never a kept or held account; one login runs claude directly.
 * - No runner, an auth error, an empty answer, a timeout (FakeClock), a
 *   Cancel (the signal is recorded) and a refused option (learned once).
 * - Every fake mode gives its cards, drops and flags.
 */
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_MESSAGES, claudeCalls, claudeSignals, makeFakeHome, processAlive, type FakeHome } from '@jantar/fixtures';
import { ASK_REPLY_MAX, AskTurnSchema } from '@jantar/protocol';
import { ASK_SENTENCES } from '../../src/ask/answer.js';
import { askInput } from '../../src/ask/input.js';
import { ASK_TIMEOUT_MS } from '../../src/ask/service.js';
import { rewriteArgv } from '../../src/rewrite/run.js';
import { LEAKY_ENV, PHONE, TODAY, TOMORROW, WAIT, account, cleanTemps, makeAskRig, send, type AskRig, type RigOptions } from './helpers.js';

let home: FakeHome | undefined;
let rig: AskRig | undefined;
beforeEach(async () => {
  home = await makeFakeHome({ sessions: [] });
});
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  await home?.cleanup();
  home = undefined;
  cleanTemps();
});

async function realRig(opts: Omit<RigOptions, 'home'> = {}): Promise<AskRig> {
  rig = await makeAskRig({ ...opts, home: home as FakeHome });
  return rig;
}

function setMode(mode: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join((home as FakeHome).root, 'fake', 'claude.json'), JSON.stringify({ mode, ...extra }));
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

/** Send and wait for the end. */
async function ask(r: AskRig, text: string) {
  return r.settled(send(r, text));
}

describe('the run is isolated like Rewrite, the message is on stdin only', () => {
  it("single mode: `claude -p` with Rewrite's isolation flags, assistant-v2.md, opus and sonnet at low effort", async () => {
    const r = await realRig();
    const t = await ask(r, ASK_MESSAGES.todo);
    expect(t).toMatchObject({ state: 'done', cards: [{ action: { type: 'todo', title: 'call the bank' }, state: 'proposed' }] });
    const calls = await claudeCalls(home as FakeHome);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({ via: 'claude', account: null });
    const promptFile = join(r.ctx.paths.askDir, 'assistant-v2.md');
    expect(call.args).toEqual(rewriteArgv({ account: null, model: 'opus', fallbackModel: 'sonnet', effort: 'low', systemPromptFile: promptFile }, 'claude'));
    expect(flag(call.args, '--tools')).toBe('');
    expect(flag(call.args, '--disallowedTools')).toBe('mcp__*');
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) expect(call.args).toContain(f);
    expect(flag(call.args, '--settings')).toBe('{"disableAllHooks":true}');
    expect(flag(call.args, '--max-turns')).toBe('1');
    expect(flag(call.args, '--max-budget-usd')).toBe('1.00');
    // The prompt is a file, the asset byte for byte; the message is stdin only.
    const asset = readFileSync(join(r.ctx.paths.assetsDir, 'ask', 'assistant-v2.md'), 'utf8');
    expect(readFileSync(promptFile, 'utf8')).toBe(asset);
    expect(asset.startsWith('You turn one message from the user into suggestions for their own Life app')).toBe(true);
    expect(call.args.join('\n')).not.toContain('call the bank');
    expect(call.stdin).toBe(
      askInput({ today: TODAY, now: '14:05', timezone: 'Asia/Kolkata', currency: 'INR', modules: { todos: true, food: true, finance: true, medicines: true, posts: true }, text: ASK_MESSAGES.todo }),
    );
    for (const k of Object.keys(LEAKY_ENV)) expect(call.envKeys, k).not.toContain(k);
    expect(realpathSync(call.cwd)).toBe(realpathSync(join(r.ctx.paths.askDir, 'work')));
    expect(statSync(r.ctx.paths.askDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(r.ctx.paths.askDir, 'work')).mode & 0o777).toBe(0o700);
    expect(statSync(promptFile).mode & 0o777).toBe(0o600);
    expect(await (home as FakeHome).calls('cswap')).toEqual([]);
  });

  it('a changed rewrite.model is followed at the next run (the fallback left out when it is the same)', async () => {
    const r = await realRig();
    expect((await ask(r, ASK_MESSAGES.todo)).state).toBe('done');
    expect((await r.ctx.settings.patch({ rewrite: { model: 'haiku' } })).ok).toBe(true);
    expect((await ask(r, ASK_MESSAGES.todo)).state).toBe('done');
    expect((await r.ctx.settings.patch({ rewrite: { model: 'sonnet' } })).ok).toBe(true);
    expect((await ask(r, ASK_MESSAGES.todo)).state).toBe('done');
    const calls = await claudeCalls(home as FakeHome);
    expect(calls.map((c) => [flag(c.args, '--model'), flag(c.args, '--fallback-model'), flag(c.args, '--effort')])).toEqual([
      ['opus', 'sonnet', 'low'],
      ['haiku', 'sonnet', 'low'],
      ['sonnet', undefined, 'low'],
    ]);
    expect(r.ctx.db.audit.list().filter((a) => a.action === 'ask.run').map((a) => (a.params as { model: string }).model)).toEqual(['opus', 'haiku', 'sonnet']);
  });

  it('cswap mode: `cswap run --share-history N -- -p` on the most room, never a kept or held account', async () => {
    const r = await realRig({ mode: 'cswap', settings: { accounts: { kept: [3] }, autoswitch: { hold: [4] } }, accounts: [account(2, 50), account(3, 0), account(4, 0), account(5, 99)] });
    expect((await ask(r, ASK_MESSAGES.todo)).state).toBe('done');
    const runs = (await (home as FakeHome).calls('cswap')).filter((c) => c.args[0] === 'run');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args).toEqual(rewriteArgv({ account: 2, model: 'opus', fallbackModel: 'sonnet', effort: 'low', systemPromptFile: join(r.ctx.paths.askDir, 'assistant-v2.md') }, 'cswap'));
    for (const k of Object.keys(LEAKY_ENV)) expect(runs[0]?.envKeys, k).not.toContain(k);
    const [call] = await claudeCalls(home as FakeHome);
    expect(call).toMatchObject({ via: 'cswap', account: 2 });
  });

  it('only kept and held accounts have room: the turn fails "no account", and nothing runs', async () => {
    const r = await realRig({ mode: 'cswap', settings: { accounts: { kept: [3] }, autoswitch: { hold: [4] } }, accounts: [account(3, 0), account(4, 0), account(2, 99)] });
    const t = await ask(r, ASK_MESSAGES.todo);
    expect(t).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.noAccount });
    expect(await claudeCalls(home as FakeHome)).toEqual([]);
    expect(r.ctx.db.audit.list().find((a) => a.action === 'ask.run')?.params).toMatchObject({ outcome: 'no_account', account: null });
  });
});

describe('failures, each with its fixed sentence', () => {
  it('claude gone between the send and the run: "Ask needs Claude Code on this Mac."', async () => {
    const r = await realRig();
    const id = send(r, ASK_MESSAGES.todo);
    (r.ctx.bins as { claude: string | null }).claude = null;
    expect(await r.settled(id)).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.noRunner });
    expect(r.ctx.db.audit.list().find((a) => a.action === 'ask.run')?.params).toMatchObject({ outcome: 'unavailable' });
  });

  it('an auth error and an empty answer', async () => {
    const r = await realRig();
    setMode('auth-error');
    expect(await ask(r, ASK_MESSAGES.todo)).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.failed });
    setMode('empty');
    expect(await ask(r, ASK_MESSAGES.todo)).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.unreadable });
    expect(r.ctx.db.audit.list().filter((a) => a.action === 'ask.run').map((a) => [(a.params as { outcome: string }).outcome, a.result])).toEqual([
      ['failed', 'failed'],
      ['unreadable', 'failed'],
    ]);
  });

  it('a timeout (the FakeClock passes 90 s): "Claude took too long", and the process is gone', async () => {
    const r = await realRig();
    setMode('slow');
    const id = send(r, ASK_MESSAGES.todo);
    await vi.waitFor(async () => expect(await claudeCalls(home as FakeHome)).toHaveLength(1), WAIT);
    await vi.waitFor(() => expect(r.ctx.clock.pending()).toBeGreaterThan(0), WAIT);
    r.ctx.clock.advance(ASK_TIMEOUT_MS);
    expect(await r.settled(id)).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.timeout });
    const [call] = await claudeCalls(home as FakeHome);
    await vi.waitFor(() => expect(processAlive(call!.pid)).toBe(false), WAIT);
    expect(r.ctx.db.audit.list().find((a) => a.action === 'ask.run')?.params).toMatchObject({ outcome: 'timeout', ms: ASK_TIMEOUT_MS });
  });

  it('Cancel kills the run: the signal is on record and the turn says Cancelled.', async () => {
    const r = await realRig();
    setMode('slow');
    const id = send(r, ASK_MESSAGES.todo);
    await vi.waitFor(async () => expect(await claudeCalls(home as FakeHome)).toHaveLength(1), WAIT);
    expect(r.ask.cancel(id, PHONE).ok).toBe(true);
    expect(r.turn(id)).toMatchObject({ state: 'cancelled', reason: ASK_SENTENCES.cancelled });
    await vi.waitFor(async () => expect((await claudeSignals(home as FakeHome)).map((s) => s.signal)).toContain('SIGTERM'), WAIT);
    await vi.waitFor(() => expect(r.ctx.db.audit.list().find((a) => a.action === 'ask.run')?.params).toMatchObject({ outcome: 'cancelled' }), WAIT);
  });

  it('a refused droppable option is learned once: the run goes again without it, and so does every later one', async () => {
    const r = await realRig();
    setMode('ask-refuse-option');
    expect((await ask(r, ASK_MESSAGES.todo)).state).toBe('done');
    expect((await ask(r, ASK_MESSAGES.food)).state).toBe('done');
    const calls = await claudeCalls(home as FakeHome);
    expect(calls.map((c) => c.args.includes('--permission-prompts'))).toEqual([true, false, false]);
    expect(r.ctx.log.records.filter((l) => l.msg === 'ask: claude refused an option').map((l) => l.fields)).toEqual([
      { part: 'ask', option: '--permission-prompts', dropped: true },
    ]);
  });
});

describe("every fake mode's cards", () => {
  it('ask-ok: each kind of message', async () => {
    const r = await realRig();
    expect((await ask(r, ASK_MESSAGES.daily)).cards).toEqual([{ action: { type: 'todo', title: 'stretch', due: { day: TOMORROW, time: '09:00' }, repeat: 'daily' }, state: 'proposed' }]);
    expect((await ask(r, ASK_MESSAGES.timed)).cards).toEqual([{ action: { type: 'todo', title: 'call the plumber', due: { day: TODAY, time: '17:00' } }, state: 'proposed' }]);
    expect((await ask(r, ASK_MESSAGES.medicine)).cards).toEqual([{ action: { type: 'todo', title: 'Take Examplocin', due: { day: TODAY, time: '18:00' } }, state: 'proposed' }]);
    expect((await ask(r, ASK_MESSAGES.meal)).cards.map((c) => c.action)).toEqual([
      { type: 'food', day: TODAY, name: 'Roti', kcal: 240 },
      { type: 'food', day: TODAY, name: 'Dal', kcal: 180 },
    ]);
    expect((await ask(r, ASK_MESSAGES.money)).cards.map((c) => c.action)).toEqual([{ type: 'money', kind: 'expense', amount: 25000, category: 'Food', note: 'lunch', day: TODAY }]);
    expect((await ask(r, ASK_MESSAGES.calories)).cards.map((c) => c.action)).toEqual([{ type: 'show', what: 'calories' }]);
    expect((await ask(r, ASK_MESSAGES.due)).cards.map((c) => c.action)).toEqual([{ type: 'show', what: 'due' }]);
    expect((await ask(r, ASK_MESSAGES.meds)).cards.map((c) => c.action)).toEqual([{ type: 'show', what: 'meds' }]);
    expect((await ask(r, ASK_MESSAGES.post)).cards).toEqual([
      { action: { type: 'post', platform: 'instagram', kind: 'reel', title: 'About the launch', due: { day: TOMORROW, time: '19:00' } }, state: 'proposed' },
    ]);
    expect(await ask(r, ASK_MESSAGES.chat)).toMatchObject({ state: 'done', cards: [], dropped: 0, reply: `Ask can suggest todos, reminders, food and money. For: ${ASK_MESSAGES.chat}` });
    expect((await ask(r, 'remind me to call mum')).cards).toEqual([]);
  });

  it('ask-fence reads as ask-ok; bad JSON, prose and a non-object are unreadable', async () => {
    const r = await realRig();
    setMode('ask-fence');
    expect((await ask(r, ASK_MESSAGES.todo)).cards).toHaveLength(1);
    for (const mode of ['ask-bad-json', 'ask-answer', 'ask-not-object']) {
      setMode(mode);
      expect(await ask(r, ASK_MESSAGES.todo), mode).toMatchObject({ state: 'failed', reason: ASK_SENTENCES.unreadable, cards: [] });
    }
  });

  it('unknown types, extra fields, too many, bad values', async () => {
    const r = await realRig();
    setMode('ask-unknown-type');
    expect(await ask(r, 'x')).toMatchObject({ state: 'done', dropped: 5, cards: [{ action: { type: 'todo', title: 'Call the bank' } }] });
    setMode('ask-extra-field');
    expect(await ask(r, 'x')).toMatchObject({ state: 'done', dropped: 4, cards: [], reply: 'Four things.' });
    setMode('ask-too-many');
    const many = await ask(r, 'x');
    expect([many.cards.length, many.dropped]).toEqual([10, 5]);
    setMode('ask-bad-values');
    const bad = await ask(r, 'x');
    expect(bad.dropped).toBe(13);
    expect(bad.cards).toEqual([
      { action: { type: 'todo', title: 'Stretch', due: { day: TODAY, time: '00:00' } }, state: 'proposed', flag: 'past_time' },
      { action: { type: 'todo', title: 'Water the plants', due: { day: '2026-11-08', time: '00:00' }, repeat: 'weekly' }, state: 'proposed' },
    ]);
  });

  it('a long reply is cut to 500 with its "…", controls gone, the link kept as text; the turn parses', async () => {
    const r = await realRig();
    setMode('ask-long-reply');
    const t = await ask(r, 'x');
    expect(t.reply).toHaveLength(ASK_REPLY_MAX);
    expect(t.reply?.endsWith('…')).toBe(true);
    expect(t.reply).not.toMatch(/[‮\u0007]/);
    expect(t.reply).toContain('[bank](https://bank.example)');
    expect(AskTurnSchema.safeParse(t).success).toBe(true);
  });

  it('a reply that claims it added something: only a proposed card, and Life is unchanged until Add', async () => {
    const r = await realRig();
    setMode('ask-claims');
    const t = await ask(r, 'x');
    expect(t).toMatchObject({ reply: 'Done! I added 50000 to your expenses.', cards: [{ state: 'proposed', action: { type: 'money', amount: 5_000_000, category: 'Other' } }] });
    const month = r.finance.month('2026-11');
    expect(month.ok && month.value.entries).toEqual([]);
    expect(r.ask.add(t.id, 0, undefined, PHONE).ok).toBe(true);
    const after = r.finance.month('2026-11');
    expect(after.ok && after.value.spent).toBe(5_000_000);
  });
});
