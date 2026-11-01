/**
 * v0.5.3 Ask end to end (spec 12.4): jantard in-process on a synthetic HOME
 * with the production wiring (harness.ts), Todos, Food, Finance and
 * Medicines on in the UTC Life zone, a phone paired with control and admin
 * (its event stream open from the start), a second control device and a
 * read-only one, `jantar` (main() from packages/cli) on the real ctl.sock,
 * and the fake claude answering through the fake cswap in its Ask modes.
 * Nothing runs claude, cswap or osascript for real.
 *
 * 0. The switch: off, the phone is refused with the sentence naming
 *    `jantar ask on`; that command turns it on (features.ask). A read-only
 *    device reads nothing.
 * 1. "todo add buy milk <marker>": one run (an Idempotency-Key replay gets
 *    the same turn), Add, the todo in GET /v1/todos, Undo, gone. Another
 *    device sees none of it.
 * 2. "remind me at 6 to take Examplocin" (the user's word order, a
 *    synthetic name): one reminder card at the next 6 o'clock, not a
 *    refusal and not past its time (unless the run was told 05:59 or
 *    17:59 and the minute turned before the parse); Add; the todo has
 *    that time.
 * 3. "spent 250 on lunch": Add; GET /v1/money shows 25000.
 * 4. "had 2 rotis and dal": two food cards; Add each in order (as Add all
 *    does); Today's kcal grows by their sum.
 * 5. A run that fails with the marker on claude's stderr: a fixed sentence.
 * 6. Clear forgets this phone's history; items added stay in Life.
 * 7. `jantar ask off` forgets every turn (seen after `jantar ask on`).
 * 8. The fake's calls: the isolation argv, the message on stdin only, and
 *    none of the Claude config and API key variables planted in the
 *    daemon's environment.
 * 9. The sweep: the marker is in no WS frame, the ring, the stored events,
 *    an audit row, a log line, a write reply or a refusal, and in no file
 *    under the Jantar home. life.db keeps what the phone added (the
 *    lunch's note; maybe the undone todo's title too, its row freed but
 *    not overwritten), so the marker there proves nothing either way: the
 *    check is that no message as typed, and no text of a turn that was
 *    never added, is in it. The fake's reply ends "For: <message>", so a
 *    stored turn or reply would fail the message check too.
 * 10. A `--read-only` daemon refuses sending (403) and says Ask can't run.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASK_SENTENCES } from '@jantar/daemon/ask/answer';
import { rewriteArgv } from '@jantar/daemon/rewrite/run';
import { ASK_MARKER, claudeCalls, setFakeClaude, type ClaudeCall } from '@jantar/fixtures';
import {
  DEVICE_COOKIE,
  eventsSocketProtocols,
  type AskList,
  type AskTurn,
  type Features,
  type MoneyMonth,
  type PairStartResponse,
  type StateResponse,
  type Today,
  type TodosResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';

// The `ws` client @fastify/websocket itself depends on (the daemon's own dependency; test only).
const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url));
interface WsClient {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  once(ev: 'open', fn: () => void): void;
  close(): void;
}
const WebSocket = createRequire(daemonRequire.resolve('@fastify/websocket'))('ws') as new (url: string, protocols: string[], opts: { headers: Record<string, string> }) => WsClient;

const LIFE = { todos: true, food: true, finance: true, medicines: true, timezone: 'UTC', currency: 'INR' };
const OFF_SENTENCE = 'Ask is off. Turn it on at your Mac: jantar ask on';
/** Planted in the daemon's environment (synthetic values): no Ask run may inherit them. */
const LEAKY_ENV = { CLAUDE_CONFIG_DIR: '/synthetic/ask-other-login', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/synthetic/ask-secure', ANTHROPIC_API_KEY: 'sk-synthetic-key' };
/** Messages as typed. Those holding the marker are never added whole anywhere: only a card's title or name is. */
const SAY = {
  milk: `todo add buy milk ${ASK_MARKER}`,
  reminder: 'remind me at 6 to take Examplocin',
  lunch: `spent 250 on lunch ${ASK_MARKER}`,
  meal: 'had 2 rotis and dal',
  broken: `todo add call the plumber ${ASK_MARKER}`,
  chat: `hello there ${ASK_MARKER}`,
} as const;

describe('v0.5.3 Ask through jantard: the phone, the CLI, the fake claude and the privacy sweep', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let tablet = '';
  let reader = '';
  let ws: WsClient | null = null;
  const frames: string[] = [];
  /** Every reply to a write (none may carry text), and every refusal. */
  const writes: Array<{ what: string; text: string }> = [];
  const refusals: Array<{ what: string; status: number; text: string }> = [];
  /** Turns whose cards were never added: none of their text may reach life.db. */
  const neverAdded: string[] = [];

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function call(cookie: string, method: string, path: string, body?: unknown, key = `k-${randomUUID()}`): Promise<HttpResult> {
    const r = await http(d.port, method, path, { cookie, headers: method === 'GET' ? {} : { 'idempotency-key': key }, ...(body === undefined ? {} : { body }) });
    if (method !== 'GET') writes.push({ what: `${method} ${path}`, text: r.text });
    if (r.status >= 400) refusals.push({ what: `${method} ${path}`, status: r.status, text: r.text });
    return r;
  }
  const fromPhone = (method: string, path: string, body?: unknown, key?: string) => call(phone, method, path, body, key);

  async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fromPhone(method, path, body);
    expect(r.status, `${method} ${path}: ${r.text}\n${dumpLog()}`).toBe(method === 'POST' && path === '/v1/ask' ? 202 : 200);
    return r.body as T;
  }

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  async function features(): Promise<Features> {
    const r = await http(d.port, 'GET', '/v1/state', { cookie: phone });
    expect(r.status, r.text).toBe(200);
    const f = (r.body as StateResponse).state.daemon?.features;
    if (!f) throw new Error('the state carries no feature switches');
    return f;
  }

  async function pair(name: string, scopes: string[]): Promise<{ cookie: string; secret: string }> {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name } });
    expect(claim.status, claim.text).toBe(200);
    const cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);
    return { cookie, secret: (claim.body as { deviceSecret: string }).deviceSecret };
  }

  /** Send `text` and wait until its turn is done; a failed turn fails the test with its sentence. */
  async function ask(text: string): Promise<AskTurn> {
    const { id } = await ok<{ id: string }>('POST', '/v1/ask', { text });
    return eventually(async () => {
      const t = (await ok<AskList>('GET', '/v1/ask')).turns.find((x) => x.id === id);
      if (t?.state === 'failed' || t?.state === 'cancelled') throw new Error(`the turn ended ${t.state}: ${t.reason ?? ''}\n${dumpLog()}`);
      return t?.state === 'done' ? t : null;
    }, 30_000, `the answer to "${text}"`);
  }

  const add = (turn: AskTurn, n: number) => ok<{ id: string }>('POST', `/v1/ask/turns/${turn.id}/actions/${n}`, {});
  const turnNow = async (id: string): Promise<AskTurn | undefined> => (await ok<AskList>('GET', '/v1/ask')).turns.find((t) => t.id === id);
  const askRuns = async (): Promise<ClaudeCall[]> => (await claudeCalls(d.home)).filter((c) => c.args.some((a) => a.endsWith('assistant-v1.md')));

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: LIFE }, env: LEAKY_ENV });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const p = await pair('Example phone', ['read', 'control', 'admin']);
    phone = p.cookie;
    tablet = (await pair('Example tablet', ['read', 'control'])).cookie;
    reader = (await pair('Example shared screen', ['read'])).cookie;
    const socket = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(p.secret), { headers: { origin: `http://127.0.0.1:${d.port}`, cookie: phone } });
    socket.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.on('error', reject);
    });
    ws = socket;
    await eventually(async () => frames.some((f) => f.includes('"kind":"snapshot"')), 5_000, 'the snapshot');
  }, 60_000);

  afterAll(async () => {
    ws?.close();
    await d?.stop();
  }, 30_000);

  it('0. off, the phone is told the command; jantar ask on turns Ask on; a read-only device reads nothing', async () => {
    expect((await features()).ask).toBe(false);
    const off = await fromPhone('GET', '/v1/ask');
    expect(off.status).toBe(403);
    expect((off.body as { error: { message: string } }).error.message).toBe(OFF_SENTENCE);
    // A phone, an admin one too, can never turn it on itself.
    expect((await fromPhone('PATCH', '/v1/settings', { ask: { enabled: true } })).status).toBe(403);

    const on = await cli('ask', 'on');
    expect(on.code, `${on.err}\n${dumpLog()}`).toBe(0);
    expect(on.out).toContain('Ask is on. The phone shows Ask.');
    expect(on.out).toContain('(model opus, as Rewrite)');
    expect(on.out).not.toContain(ASK_SENTENCES.noModules);
    expect((await features()).ask).toBe(true);
    expect(await ok<AskList>('GET', '/v1/ask')).toEqual({ ready: true, turns: [] });
    const status = await cli('ask', 'status');
    expect(status.out).toBe("Ask: on\nModel: opus (Rewrite's model; change it with jantar rewrite model <m>)\n");

    expect((await call(reader, 'GET', '/v1/ask')).status).toBe(403);
    expect((await call(reader, 'POST', '/v1/ask', { text: 'todo add anything' })).status).toBe(403);
  });

  it('1. todo add: one run per Idempotency-Key, Add puts it in Todos, Undo takes it out; another device sees none of it', async () => {
    const before = (await askRuns()).length;
    const key = `k-${randomUUID()}`;
    const first = await fromPhone('POST', '/v1/ask', { text: SAY.milk }, key);
    expect(first.status, `${first.text}\n${dumpLog()}`).toBe(202);
    const again = await fromPhone('POST', '/v1/ask', { text: SAY.milk }, key);
    expect(again.status).toBe(202);
    const id = (first.body as { id: string }).id;
    expect((again.body as { id: string }).id).toBe(id);
    const turn = await eventually(async () => {
      const t = await turnNow(id);
      if (t?.state === 'failed') throw new Error(`the turn failed: ${t.reason ?? ''}\n${dumpLog()}`);
      return t?.state === 'done' ? t : null;
    }, 30_000, 'the todo answer');
    expect((await askRuns()).length).toBe(before + 1);

    expect(turn.text).toBe(SAY.milk);
    expect(turn.cards).toHaveLength(1);
    const card = turn.cards[0]!;
    expect(card.state).toBe('proposed');
    expect(card.action.type).toBe('todo');
    expect(card.action.type === 'todo' && card.action.title).toContain('buy milk');

    // Another control device has its own (empty) history, and can't touch this one.
    expect(((await call(tablet, 'GET', '/v1/ask')).body as AskList).turns).toEqual([]);
    expect((await call(tablet, 'POST', `/v1/ask/turns/${id}/actions/0`, {})).status).toBe(404);
    expect((await call(tablet, 'DELETE', `/v1/ask/turns/${id}/actions/0`)).status).toBe(404);

    const { id: todoId } = await add(turn, 0);
    const listed = (await ok<TodosResponse>('GET', '/v1/todos')).todos.find((t) => t.id === todoId);
    expect(listed?.title).toContain('buy milk');
    expect(await turnNow(id)).toMatchObject({ cards: [{ state: 'added', ref: todoId }] });
    // Added once only.
    expect((await fromPhone('POST', `/v1/ask/turns/${id}/actions/0`, {})).status).toBe(409);

    expect(await ok('DELETE', `/v1/ask/turns/${id}/actions/0`)).toEqual({ ok: true });
    expect((await ok<TodosResponse>('GET', '/v1/todos')).todos.some((t) => t.id === todoId)).toBe(false);
    const undone = await turnNow(id);
    expect(undone?.cards[0]?.state).toBe('proposed');
    expect(undone?.cards[0]?.ref).toBeUndefined();
  }, 60_000);

  it('2. "remind me at 6 to take Examplocin": one reminder at the next 6 o\'clock, added with that time', async () => {
    const turn = await ask(SAY.reminder);
    expect(turn.cards).toHaveLength(1);
    const card = turn.cards[0]!;
    if (card.action.type !== 'todo') throw new Error(`a ${card.action.type} card, not a todo`);
    expect(card.action.title).toContain('Examplocin');
    // The next 6 o'clock after the time the run was told (its <now> block).
    const [run] = (await askRuns()).filter((c) => c.stdin.includes(SAY.reminder));
    const told = /^Time: (\d\d):(\d\d)/m.exec(run?.stdin ?? '');
    const today = /^Today: \w{3} (\d{4}-\d\d-\d\d)$/m.exec(run?.stdin ?? '');
    if (!told || !today) throw new Error('the run was not told the time');
    const now = `${told[1]}:${told[2]}`;
    const tomorrow = new Date(Date.parse(`${today[1]}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const expected = now < '06:00' ? { day: today[1], time: '06:00' } : now < '18:00' ? { day: today[1], time: '18:00' } : { day: tomorrow, time: '06:00' };
    expect(card.action.due).toEqual(expected);
    // Told 05:59 or 17:59, the minute may turn before the parse, which then flags the card past_time.
    if (now !== '05:59' && now !== '17:59') expect(card.flag).toBeUndefined();
    expect(card.action.repeat).toBeUndefined();

    const { id } = await add(turn, 0);
    const todo = (await ok<TodosResponse>('GET', '/v1/todos')).todos.find((t) => t.id === id);
    expect(todo?.title).toContain('Examplocin');
    expect(todo?.due).toEqual(expected);
  }, 60_000);

  it('3. "spent 250 on lunch": Add puts 25000 hundredths in this month', async () => {
    const before = await ok<MoneyMonth>('GET', '/v1/money');
    const turn = await ask(SAY.lunch);
    expect(turn.cards).toHaveLength(1);
    const card = turn.cards[0]!;
    if (card.action.type !== 'money') throw new Error(`a ${card.action.type} card, not money`);
    expect(card.action).toMatchObject({ kind: 'expense', amount: 25000, category: 'Food' });
    // Nothing is added until the tap.
    expect((await ok<MoneyMonth>('GET', '/v1/money')).spent).toBe(before.spent);
    const { id } = await add(turn, 0);
    const after = await ok<MoneyMonth>('GET', '/v1/money');
    expect(after.entries.find((e) => e.id === id)).toMatchObject({ kind: 'expense', amount: 25000, category: 'Food' });
    expect(after.spent).toBe(before.spent + 25000);
  }, 60_000);

  it('4. "had 2 rotis and dal": two food cards, added one after the other as Add all does; Today counts them', async () => {
    const before = await ok<Today>('GET', '/v1/life/today');
    const turn = await ask(SAY.meal);
    expect(turn.cards.map((c) => c.action.type)).toEqual(['food', 'food']);
    let sum = 0;
    for (const [n, c] of turn.cards.entries()) {
      if (c.action.type !== 'food') throw new Error('not a food card');
      sum += c.action.kcal;
      await add(turn, n);
    }
    expect(sum).toBeGreaterThan(0);
    expect((await turnNow(turn.id))?.cards.map((c) => c.state)).toEqual(['added', 'added']);
    const after = await ok<Today>('GET', '/v1/life/today');
    expect(after.food?.kcal).toBe((before.food?.kcal ?? 0) + sum);
  }, 60_000);

  it('5. a run that fails with the marker on claude\'s stderr ends in a fixed sentence', async () => {
    await setFakeClaude(d.home, { mode: 'ask-bad-json' });
    try {
      const { id } = await ok<{ id: string }>('POST', '/v1/ask', { text: SAY.broken });
      neverAdded.push(SAY.broken);
      const failed = await eventually(async () => {
        const t = await turnNow(id);
        return t?.state === 'failed' ? t : null;
      }, 30_000, 'the failed turn');
      expect(failed.reason).toBe("Claude's answer couldn't be read. Try again.");
      expect(failed.cards).toEqual([]);
      expect(failed.reply).toBeUndefined();
    } finally {
      await setFakeClaude(d.home, {});
    }
    // And a plain chat message: a reply, no card.
    const chat = await ask(SAY.chat);
    neverAdded.push(SAY.chat);
    expect(chat.cards).toEqual([]);
    expect(chat.reply ?? '').not.toBe('');
  }, 60_000);

  it('6. Clear forgets this phone\'s history; what was added stays in Life', async () => {
    const todos = (await ok<TodosResponse>('GET', '/v1/todos')).todos.length;
    expect((await ok<AskList>('GET', '/v1/ask')).turns.length).toBeGreaterThanOrEqual(5);
    expect(await ok('DELETE', '/v1/ask')).toEqual({ ok: true });
    expect((await ok<AskList>('GET', '/v1/ask')).turns).toEqual([]);
    expect((await ok<TodosResponse>('GET', '/v1/todos')).todos).toHaveLength(todos);
  });

  it('7. jantar ask off forgets every turn, and Ask comes back empty', async () => {
    const turn = await ask(SAY.chat);
    expect((await ok<AskList>('GET', '/v1/ask')).turns.map((t) => t.id)).toEqual([turn.id]);
    const off = await cli('ask', 'off');
    expect(off.code, off.err).toBe(0);
    expect(off.out).toBe('Ask is off. Its history is forgotten; items you added stay in Life.\n');
    expect((await features()).ask).toBe(false);
    expect((await fromPhone('GET', '/v1/ask')).status).toBe(403);
    expect((await fromPhone('POST', `/v1/ask/turns/${turn.id}/actions/0`, {})).status).toBe(403);
    expect((await cli('ask', 'on')).code).toBe(0);
    expect(await ok<AskList>('GET', '/v1/ask')).toEqual({ ready: true, turns: [] });
  }, 60_000);

  it('8. each run had the isolation argv, Rewrite\'s model at low effort, and the message on stdin only', async () => {
    const runs = await askRuns();
    expect(runs.length).toBeGreaterThanOrEqual(7);
    const settings = d.ctx.settings.get();
    const held = new Set<number>([...settings.accounts.kept, ...settings.autoswitch.hold]);
    for (const run of runs) {
      const promptFile = run.args[run.args.indexOf('--system-prompt-file') + 1] ?? '';
      expect(basename(promptFile)).toBe('assistant-v1.md');
      expect(promptFile).toContain(join('ask', 'assistant-v1.md'));
      expect(run.args).toEqual(rewriteArgv({ account: run.account, model: 'opus', fallbackModel: 'sonnet', effort: 'low', systemPromptFile: promptFile }, 'claude'));
      expect(run.cwd.endsWith(join('ask', 'work'))).toBe(true);
      expect(run.args.join(' ')).not.toContain(ASK_MARKER);
      expect(run.envMarkers).toEqual([]);
      // cswap may set CLAUDE_CONFIG_DIR to the account's own folder; never to the planted one.
      expect(run.envKeys).not.toContain('ANTHROPIC_API_KEY');
      expect(run.envKeys).not.toContain('CLAUDE_SECURESTORAGE_CONFIG_DIR');
      expect(run.env.CLAUDE_CONFIG_DIR).not.toBe(LEAKY_ENV.CLAUDE_CONFIG_DIR);
      if (run.account !== null) expect(held.has(run.account)).toBe(false);
      expect(run.stdin).toContain('<message>');
    }
    for (const said of Object.values(SAY)) {
      expect(runs.some((r) => r.stdin.includes(said)), said).toBe(true);
    }
    const cswap = (await d.home.calls('cswap')).filter((c) => c.args[0] === 'run');
    for (const c of cswap) {
      expect(c.args.join(' ')).not.toContain(ASK_MARKER);
      expect(c.envMarkers).toEqual([]);
      for (const k of Object.keys(LEAKY_ENV)) expect(c.envKeys, k).not.toContain(k);
    }
  });

  it('9. the sweep: the marker reaches no frame, event, audit row, log line, write reply, refusal or file', async () => {
    const replay = d.ctx.store.replay(0);
    const ring = replay.kind === 'events' ? replay.events : [];
    const audit = d.ctx.db.audit.list({ after: 0, limit: 100_000 });
    const sources: Record<string, string> = {
      'phone frames': frames.join('\n'),
      'event ring': JSON.stringify(ring),
      'stored events': JSON.stringify(d.ctx.db.events.since(0)),
      'audit rows': JSON.stringify(audit),
      'log lines': JSON.stringify(d.log.records),
      'write replies': JSON.stringify(writes),
      refusals: JSON.stringify(refusals),
    };
    for (const [what, text] of Object.entries(sources)) expect(text.includes(ASK_MARKER), what).toBe(false);
    expect(writes.length).toBeGreaterThan(15);
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    // Ask ticks only as `life.changed {}`.
    expect(ring.some((e) => e.type.startsWith('ask'))).toBe(false);
    for (const e of ring.filter((x) => x.type === 'life.changed')) expect(e.data).toEqual({});
    // One audit row per run, counts only.
    const runs = audit.filter((a) => a.action === 'ask.run');
    expect(runs.length).toBeGreaterThanOrEqual(7);
    expect(runs.some((a) => (a.params as { outcome?: string }).outcome === 'unreadable')).toBe(true);

    // Files: the marker is in none outside life.db; in life.db, no message as typed and nothing of a turn never added.
    const files = await walk(d.home.jantarHome);
    expect(files.map((f) => basename(f))).toEqual(expect.arrayContaining(['config.json', 'jantar.db', 'life.db', 'assistant-v1.md']));
    const life = (f: string) => /^life\b.*\.db(-wal|-shm)?$/.test(basename(f));
    let inLife = false;
    for (const f of files) {
      const bytes = await readFile(f);
      if (life(f)) inLife ||= bytes.includes(ASK_MARKER);
      else expect(bytes.includes(ASK_MARKER), f).toBe(false);
      for (const said of [...Object.values(SAY).filter((s) => s.includes(ASK_MARKER)), ...neverAdded]) {
        expect(bytes.includes(said), `${f}: "${said}"`).toBe(false);
      }
    }
    // Life keeps what you add, so the marker is in life.db (the lunch's note from 3 at least): the sweep reads the real files.
    // Which rows hold it is not checked; the message checks above are what hold there.
    expect(inLife).toBe(true);
    // Ask's own folder holds the prompt copy and an empty work folder, nothing else.
    expect(files.filter((f) => f.includes(`${join(d.home.jantarHome, 'ask')}/`)).map((f) => basename(f))).toEqual(['assistant-v1.md']);
  });
});

describe('v0.5.3 Ask under jantard --read-only', () => {
  let d: Daemon;
  let phone = '';

  beforeAll(async () => {
    d = await bootDaemon({ readOnly: true, noTerminal: true, home: { sessions: [] }, settings: { life: LIFE, ask: { enabled: true } } });
    const ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'ro', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'read-only phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
  }, 60_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  it('10. refuses sending with 403, says why, and runs nothing', async () => {
    const sent = await http(d.port, 'POST', '/v1/ask', { cookie: phone, body: { text: 'todo add buy milk' }, headers: { 'idempotency-key': 'k-ro-1' } });
    expect(sent.status, sent.text).toBe(403);
    expect(sent.text).toContain('read-only');
    const list = await http(d.port, 'GET', '/v1/ask', { cookie: phone });
    expect(list.status, list.text).toBe(200);
    expect(list.body).toEqual({ ready: false, reason: "Ask can't run while Jantar is read-only.", turns: [] });
    expect(await claudeCalls(d.home)).toEqual([]);
  });
});

/** Every file under `dir`, recursively (sockets and other non-files left out). */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
