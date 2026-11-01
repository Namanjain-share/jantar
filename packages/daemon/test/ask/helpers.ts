/**
 * The Ask part on a test context, for the service, apply, runner, privacy
 * and route tests: Life's real todos, food and finance modules on an
 * in-memory life.db (a RecordingScheduler shows the pings they arm), a
 * stand-in posts module (v0.7: a Map that keeps what Ask added and ticks
 * as Life does; Posts' own rules are tested with the real module), a
 * stand-in LifeService around them whose status gives the Life zone, and
 * either the real exec against a fake home's bins (the fake claude runs as
 * a process) or a fake exec whose claude runs the test answers by hand.
 * The clock is a FakeClock at 14:05 in Asia/Kolkata on Sun 1 Nov 2026.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { FakeHome } from '@jantar/fixtures';
import { LIFE_LIMITS, SettingsSchema, type Account, type AccountId, type AskTurn, type LifeStatus, type Post, type Settings } from '@jantar/protocol';
import type { Actor, AskService, Bins, ExecFile, FinanceModule, FoodModule, IntelService, LifeCore, LifeService, PostsModule, TodosModule } from '../../src/contracts.js';
import { buildAskService } from '../../src/ask/service.js';
import { FakeClock } from '../../src/core/clock.js';
import { createExecFile } from '../../src/core/exec.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { TEST_BINS, createFakeExec, createTestContext, createTestLifeCore, type ExecCall, type TestContext, type TestContextOptions, type TestLifeCore } from '../../src/core/testing.js';
import { buildFinanceModule } from '../../src/life/finance/module.js';
import { buildFoodModule } from '../../src/life/food/module.js';
import { buildTodosModule } from '../../src/life/todos/module.js';
import { makeFakes, type FakeCcwLegacy, type FakeUsage } from '../api/fakes.js';

/** 14:05 in Asia/Kolkata, Sun 2026-11-01. */
export const NOW = '2026-11-01T08:35:00.000Z';
export const ZONE = 'Asia/Kolkata';
export const TODAY = '2026-11-01';
export const TOMORROW = '2026-11-02';
export const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
export const TABLET: Actor = { kind: 'device', deviceId: 'dev-tablet', scopes: ['read', 'control'] };
export const WAIT = { timeout: 15_000, interval: 10 };
/** What the daemon's own env may hold and a run must never inherit (synthetic values). */
export const LEAKY_ENV = { CLAUDE_CONFIG_DIR: '/synthetic/other-login', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/synthetic/secure', ANTHROPIC_API_KEY: 'sk-synthetic-key' };

/** Ask on, with todos, food, money, medicines and posts, in the Life zone, in rupees. */
export function askSettings(over: Record<string, unknown> = {}): Settings {
  const base = { ask: { enabled: true }, life: { todos: true, food: true, finance: true, medicines: true, posts: true, timezone: ZONE, currency: 'INR' } };
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = merged[k];
    merged[k] = typeof prev === 'object' && prev !== null && typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...prev, ...v } : v;
  }
  return SettingsSchema.parse(merged);
}

export interface RigOptions {
  /** Run the real exec against this fake home's bins (else a fake exec). */
  home?: FakeHome;
  /** The fake exec (default: one whose claude runs wait in `held`). */
  exec?: ExecFile;
  mode?: 'single' | 'cswap';
  settings?: Record<string, unknown>;
  readOnly?: boolean;
  clock?: FakeClock;
  bins?: Partial<Bins>;
  accounts?: Account[];
  /** v0.8: Intel's read and remove for the save card (default: not built, the API's 501). */
  intel?: Pick<IntelService, 'read' | 'remove'>;
}

/** A claude run the fake exec holds until the test answers it (an abort ends it as a killed process). */
export interface HeldRun {
  call: ExecCall;
  /** Answer with this result text (as `claude -p --output-format json` prints it). */
  answer(result: string): void;
  /** Answer with this raw stdout. */
  raw(stdout: string, extra?: { code?: number; stderr?: string }): void;
}

/** The stand-in posts module: what was added, and who added it. */
export interface StubPosts extends PostsModule {
  readonly posts: ReadonlyMap<string, Post>;
  readonly actors: ReadonlyMap<string, Actor>;
}

/**
 * Posts for Ask's tests (v0.7), before and apart from the real module:
 * create keeps the post (the cap of open posts as Life's), remove deletes
 * it (not_found when gone), each write ticks through the core. Only what
 * Ask calls.
 */
export function stubPosts(core: LifeCore): StubPosts {
  const posts = new Map<string, Post>();
  const actors = new Map<string, Actor>();
  const stub: Partial<StubPosts> = {
    name: 'posts',
    posts,
    actors,
    today: () => ({}),
    create: (body, actor) => {
      if (posts.size >= LIFE_LIMITS.openPosts) return { ok: false, code: 'conflict', reason: 'Too many posts (stub).' };
      const id = core.newId();
      const at = core.now().toISOString();
      posts.set(id, { ...body, id, kind: body.kind ?? 'post', status: body.status ?? 'idea', createdAt: at, updatedAt: at });
      actors.set(id, actor);
      core.changed();
      return { ok: true, value: { id } };
    },
    remove: (id) => {
      if (!posts.delete(id)) return { ok: false, code: 'not_found', reason: 'That post is gone.' };
      core.changed();
      return { ok: true, value: true };
    },
  };
  return notBuilt<StubPosts>('Posts', stub);
}

export interface AskRig {
  ctx: TestContext;
  core: TestLifeCore;
  life: LifeService;
  todos: TodosModule;
  food: FoodModule;
  finance: FinanceModule;
  posts: StubPosts;
  ask: AskService;
  /** The fakes the account pick reads (usage, ccw's hold list). */
  usage: FakeUsage;
  ccwLegacy: FakeCcwLegacy;
  /** Fake exec runs waiting for an answer (empty with a fake home). */
  held: HeldRun[];
  setBroken(reason: string | null): void;
  /** The owner's turn, as GET /v1/ask shows it. */
  turn(id: string, actor?: Actor): AskTurn | undefined;
  /** Wait until the turn has finished (done, failed or cancelled). */
  settled(id: string, actor?: Actor): Promise<AskTurn>;
  /** Wait until the fake exec holds `n` runs. */
  heldCount(n: number): Promise<void>;
  close(): Promise<void>;
}

/** A cswap account with `five` % of its 5-hour window used (synthetic). */
export function account(id: AccountId, five: number): Account {
  return {
    id,
    emailMasked: `a${id}***@example.com`,
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    fetchedAt: NOW,
    ageS: 0,
    windows: [
      { kind: 'five_hour', pct: five },
      { kind: 'seven_day', pct: 20 },
    ],
  };
}

/** `claude -p --output-format json`'s success line for `result`. */
export function claudeJson(result: string): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'synthetic', usage: { input_tokens: 10, output_tokens: 10 } });
}

/** An answer's result text. */
export function answerText(actions: unknown[], reply = 'Here you go.'): string {
  return JSON.stringify({ reply, actions });
}

export interface AskParts {
  core: TestLifeCore;
  life: LifeService;
  todos: TodosModule;
  food: FoodModule;
  finance: FinanceModule;
  posts: StubPosts;
  ask: AskService;
  usage: FakeUsage;
  ccwLegacy: FakeCcwLegacy;
  setBroken(reason: string | null): void;
}

/**
 * The Ask part on `ctx` (not started): Life's real todos, food and finance
 * on an in-memory life.db in ctx's Life zone, behind a stand-in LifeService
 * (`broken()` as set, `status()` from the core and ctx's settings).
 */
export function askOn(ctx: TestContext, opts: { readOnly?: boolean; intel?: Pick<IntelService, 'read' | 'remove'> } = {}): AskParts {
  const core = createTestLifeCore({ clock: ctx.clock, settings: ctx.settings.get().life });
  const f = makeFakes(ctx);
  const deps = { ctx, sessions: f.sessions, usage: f.usage, ccwLegacy: f.ccwLegacy };
  const todos = buildTodosModule(core, deps);
  const food = buildFoodModule(core, deps);
  const finance = buildFinanceModule(core, deps);
  const posts = stubPosts(core);
  let broken: string | null = null;
  const status = (): LifeStatus => {
    const s = ctx.settings.get().life;
    return {
      open: true,
      timezone: core.tz(),
      today: core.today(),
      currency: s.currency,
      lockScreenDetails: false,
      modules: { todos: s.todos, medicines: s.medicines, food: s.food, places: s.places, finance: s.finance, posts: s.posts },
      estimate: { available: false },
      backups: { last: null, count: 0 },
      push: { devices: 0, webpush: true },
    };
  };
  const life = notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => broken, status, todos, food, finance, posts });
  // v0.8: Intel's read and remove for the save card (a test's own, else not built: the API's 501).
  const intel = opts.intel ?? notBuilt<Pick<IntelService, 'read' | 'remove'>>('Reading links');
  const ask = buildAskService(ctx, { life, usage: f.usage, ccwLegacy: f.ccwLegacy, intel }, { readOnly: opts.readOnly === true });
  return {
    core,
    life,
    todos,
    food,
    finance,
    posts,
    ask,
    usage: f.usage,
    ccwLegacy: f.ccwLegacy,
    setBroken: (reason) => {
      broken = reason;
    },
  };
}

/** createTestContext options for the real exec against a fake home's bins. */
export function homeContext(h: FakeHome, opts: { settings?: Settings; clock?: FakeClock; mode?: 'single' | 'cswap'; bins?: Partial<Bins> } = {}): TestContextOptions {
  return {
    userHome: h.home,
    home: h.jantarHome,
    env: { ...h.env, ...LEAKY_ENV },
    exec: createExecFile(),
    bins: { claude: h.bins.claude, cswap: h.bins.cswap, ...opts.bins },
    accountsMode: opts.mode ?? 'single',
    settings: opts.settings ?? askSettings(),
    clock: opts.clock ?? new FakeClock(NOW),
  };
}

const temps: string[] = [];

export function cleanTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

export async function makeAskRig(opts: RigOptions = {}): Promise<AskRig> {
  const settings = askSettings(opts.settings);
  const held: HeldRun[] = [];
  const clock = opts.clock ?? new FakeClock(NOW);
  const fakeExec =
    opts.exec ??
    createFakeExec((call) => {
      if (call.file !== TEST_BINS.claude && call.file !== TEST_BINS.cswap) return undefined;
      return new Promise((resolve) => {
        const killed = () => resolve({ code: null, signal: 'SIGTERM' });
        if (call.opts.signal?.aborted) return killed();
        call.opts.signal?.addEventListener('abort', killed, { once: true });
        held.push({ call, answer: (result) => resolve({ stdout: claudeJson(result) }), raw: (stdout, extra = {}) => resolve({ stdout, ...extra }) });
      });
    });
  let ctx: TestContext;
  if (opts.home) {
    ctx = createTestContext(homeContext(opts.home, { settings, clock, ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.bins ? { bins: opts.bins } : {}) }));
  } else {
    const state = mkdtempSync(join(tmpdir(), 'jantar-ask-'));
    temps.push(state);
    ctx = createTestContext({ home: state, exec: fakeExec, accountsMode: opts.mode ?? 'single', settings, clock, ...(opts.bins ? { bins: opts.bins } : {}) });
  }
  if (opts.accounts) ctx.store.emit({ type: 'usage.updated', data: { accounts: opts.accounts, activeAccount: null, fetchedAt: NOW, source: 'cache' } });
  const parts = askOn(ctx, { readOnly: opts.readOnly === true, ...(opts.intel ? { intel: opts.intel } : {}) });
  const { core, life, todos, food, finance, posts, ask, usage, ccwLegacy } = parts;
  await ask.start();
  const turn = (id: string, actor: Actor = PHONE) => {
    const r = ask.list(actor);
    return r.ok ? r.value.turns.find((t) => t.id === id) : undefined;
  };
  return {
    ctx,
    core,
    life,
    todos,
    food,
    finance,
    posts,
    ask,
    usage,
    ccwLegacy,
    held,
    setBroken: parts.setBroken,
    turn,
    settled: async (id, actor = PHONE) => {
      let out: AskTurn | undefined;
      await vi.waitFor(() => {
        out = turn(id, actor);
        if (!out || out.state === 'queued' || out.state === 'running') throw new Error(`turn ${out?.state ?? 'gone'}`);
      }, WAIT);
      return out as AskTurn;
    },
    heldCount: async (n) => {
      await vi.waitFor(() => {
        if (held.length < n) throw new Error(`${held.length} held`);
      }, WAIT);
    },
    close: async () => {
      await ask.stop();
      core.close();
    },
  };
}

/** Send `text` as `actor`; the turn's id (throws when refused). */
export function send(rig: AskRig, text: string, actor: Actor = PHONE): string {
  const r = rig.ask.send(text, actor);
  if (!r.ok) throw new Error(`send refused: ${r.code} ${r.reason}`);
  return r.value.id;
}
