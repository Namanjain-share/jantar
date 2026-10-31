/**
 * Rewrite test rig: a test context on a temp state dir (the run dir and the
 * system prompt copy are real files there), synthetic accounts and a
 * session in the store, the API fakes for the other parts, and a fake
 * `cswap run ... -- -p` that answers like `claude -p --output-format json`.
 * Nothing real runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { SettingsSchema, type Account, type RewriteDetail } from '@jantar/protocol';
import type { Actor, ExecResult } from '../../src/contracts.js';
import { createFakeExec, createTestContext, notBuiltParts, type ExecCall, type TestContext } from '../../src/core/testing.js';
import { RewriteServiceImpl, type RewriteDeps, type RewriteOptions } from '../../src/rewrite/service.js';
import { FakeCcwLegacy, FakeHooks, FakeSessions, FakeTranscripts, FakeUsage, makeSession, T0 } from '../api/fakes.js';

export const SID = 'sess-aaaa-1111';
/** The rig's synthetic settings accounts.kept: 3 and 5 have the most room, so a pick that forgets them is caught. */
export const KEPT = [3, 5];
export const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
export const OTHER_PHONE: Actor = { kind: 'device', deviceId: 'dev-other', scopes: ['read', 'control'] };
/** Put in dictated text and model output: must never reach events, audit rows, logs or write replies. */
export const MARKER = 'SYNTHETIC-DICTATION-MARKER';

export function account(id: number, five = 10, over: Partial<Account> = {}): Account {
  return {
    id,
    emailMasked: `a${id}***@example.com`,
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    fetchedAt: T0,
    ageS: 0,
    windows: [
      { kind: 'five_hour', pct: five },
      { kind: 'seven_day', pct: 20 },
    ],
    ...over,
  };
}

/** `claude -p --output-format json` stdout. */
export function claudeJson(result: unknown, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1800,
    num_turns: 1,
    result,
    session_id: 'synthetic-session',
    total_cost_usd: 0.01,
    usage: { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 40 },
    ...over,
  });
}

/** The dictated text block of a context message. */
export function dictatedOf(stdin: string | undefined): string {
  const m = /<dictated_text>\n([\s\S]*)\n<\/dictated_text>\s*$/.exec(stdin ?? '');
  return m?.[1] ?? '';
}

export type Answer = Partial<ExecResult> | Promise<Partial<ExecResult>>;

/** A fake cswap: `run ...` calls go to `answer`; anything else (adopt) to `other`. */
export function fakeCswap(answer: (call: ExecCall) => Answer, other?: (call: ExecCall) => Answer | undefined) {
  return createFakeExec((call) => {
    if (call.file === '/fake/bin/cswap' && call.args[0] === 'run') return answer(call);
    return other?.(call);
  });
}

/** Answers "Rewritten: <what was said>". */
export const echoAnswer = (call: ExecCall): Answer => ({ stdout: claudeJson(`Rewritten: ${dictatedOf(call.opts.input)}`) });

/** Never answers until the run is aborted (cancel, timeout, stop), like a hung claude. */
export function hangUntilAborted(call: ExecCall): Promise<Partial<ExecResult>> {
  return new Promise((resolve) => {
    const s = call.opts.signal;
    const done = () => resolve({ code: null, signal: 'SIGTERM', stdout: '', stderr: '' });
    if (!s) return;
    if (s.aborted) done();
    else s.addEventListener('abort', done, { once: true });
  });
}

export interface Rig {
  ctx: TestContext;
  exec: ReturnType<typeof fakeCswap>;
  svc: RewriteServiceImpl;
  deps: RewriteDeps;
  transcripts: FakeTranscripts;
  hooks: FakeHooks;
  ccw: FakeCcwLegacy;
  home: string;
  setAccounts(accounts: Account[]): void;
  close(): Promise<void>;
}

export function makeRig(
  opts: {
    answer?: (call: ExecCall) => Answer;
    other?: (call: ExecCall) => Answer | undefined;
    settings?: unknown;
    accounts?: Account[];
    deps?: Partial<RewriteDeps>;
    svc?: RewriteOptions;
    env?: Record<string, string | undefined>;
  } = {},
): Rig {
  const home = mkdtempSync(join(tmpdir(), 'ccw-rewrite-'));
  const exec = fakeCswap(opts.answer ?? echoAnswer, opts.other);
  // The roster's emptiest accounts (3 and 5) are kept for other work, unless a test sets its own accounts.
  const settings = SettingsSchema.parse({ accounts: { kept: KEPT }, ...((opts.settings as Record<string, unknown> | undefined) ?? { rewrite: { enabled: true } }) });
  const ctx = createTestContext({ home, exec, settings, ...(opts.env ? { env: opts.env } : {}) });
  ctx.store.emit({ type: 'session.added', sid: SID, data: { session: makeSession() } });
  const setAccounts = (accounts: Account[]) =>
    ctx.store.emit({ type: 'usage.updated', data: { accounts, activeAccount: null, fetchedAt: T0, source: 'cache' } });
  setAccounts(opts.accounts ?? [account(3, 0), account(5, 0), account(7, 30), account(9, 50)]);
  const transcripts = new FakeTranscripts();
  const hooks = new FakeHooks(ctx);
  const ccw = new FakeCcwLegacy();
  const parts = notBuiltParts();
  const deps: RewriteDeps = {
    sessions: new FakeSessions(),
    transcripts,
    hooks,
    usage: new FakeUsage(),
    ccwLegacy: ccw,
    files: parts.files,
    changes: parts.changes,
    ...opts.deps,
  };
  const svc = new RewriteServiceImpl(ctx, deps, opts.svc);
  return {
    ctx,
    exec,
    svc,
    deps,
    transcripts,
    hooks,
    ccw,
    home,
    setAccounts,
    async close() {
      await svc.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Wait until the job reaches a state the test names (real timers; the fake exec answers at once). */
export async function untilState(rig: Rig, jobId: string, states: RewriteDetail['state'][], actor: Actor = PHONE): Promise<RewriteDetail> {
  let d: RewriteDetail | null = null;
  await vi.waitFor(
    () => {
      d = rig.svc.get(jobId, actor);
      if (!d || !states.includes(d.state)) throw new Error(`job is ${d?.state ?? 'gone'}`);
    },
    { timeout: 3000, interval: 5 },
  );
  return d as unknown as RewriteDetail;
}

/** Submit and expect it to be accepted. */
export async function start(rig: Rig, text: string, actor: Actor = PHONE, model?: 'opus' | 'sonnet' | 'haiku') {
  const r = await rig.svc.submit({ sid: SID, text, ...(model ? { model } : {}) }, actor);
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.reason}`);
  return r.job;
}

/** Every rewrite.progress job emitted so far. */
export function progress(rig: Rig) {
  const r = rig.ctx.store.replay(0);
  if (r.kind !== 'events') throw new Error('expected events');
  return r.events.filter((e) => e.type === 'rewrite.progress').map((e) => (e.data as { job: { id: string; state: string } }).job);
}

/** The cswap run calls so far. */
export function runCalls(rig: Rig): ExecCall[] {
  return rig.exec.calls.filter((c) => c.args[0] === 'run');
}
