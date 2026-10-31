/**
 * The meeting summary (spec 4.9; MS1, MS2, MS3, MS5, MS6 and MP3's summary
 * part; WP-SU). The run goes through the shared runner against the fake
 * claude's meetings mode (its prompt file is summary-v1.md) on a fake home
 * with the real exec, or against a fake exec whose runs wait for the test:
 *
 * - MS1: Rewrite's isolation argv with our prompt file (never its text or
 *   the transcript); the transcript on stdin only; no other login or API key
 *   in the env; `claude -p` with one login, `cswap run ... -- -p` with many.
 * - MS2: never a kept or held account; single mode is account 0.
 * - MS3: prose, broken JSON, 31 items, a 2,001-character summary, is_error,
 *   nothing, and the 180 s timeout: `failed` with the fixed sentence, nothing
 *   partial kept, the process gone.
 * - MS5: under --read-only nothing runs and the status says why.
 * - MS6: one run at a time, oldest first; a start marks what a restart left
 *   queued or running failed and runs nothing; Try again runs it.
 * - MP3: a summary ticks once per state change, and emits nothing itself.
 *
 * Plus the queue's rules for Summarize and Try again, stop() (while the run
 * goes, picks its account or makes its dir), a run that throws, a meeting
 * deleted or meetings.db closed while its run goes (a delete stops it), the
 * run dir, the audit row (counts only), a refused droppable option learned
 * once, and an owner or a list left out that never costs the notes.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEETING_MARKER, MEETING_T0, claudeCalls, claudeSignals, makeFakeHome, processAlive, transcriptLines, type FakeHome } from '@jantar/fixtures';
import { MEETING_SUMMARY_MIN_CHARS, type Account, type AccountId, type MeetingSummary } from '@jantar/protocol';
import type { Actor, Bins, CcwLegacySource, ExecResult, MeetingRecord, MeetingSummaries } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createExecFile } from '../../src/core/exec.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { TEST_BINS, createFakeExec, createTestMeetingsCore, type ExecCall, type TestMeetingsCore } from '../../src/core/testing.js';
import { summaryInput } from '../../src/meetings/input.js';
import {
  MEETING_SUMMARY_TIMEOUT_MS,
  NO_MEETING,
  SUMMARY_SENTENCES,
  buildSummaries,
  parseSummary,
} from '../../src/meetings/summary.js';
import { READ_ONLY_SUMMARIES } from '../../src/modes.js';
import { rewriteArgv } from '../../src/rewrite/run.js';

const PHONE: Actor = { kind: 'device', deviceId: 'dev-phone', scopes: ['read', 'control'] };
const NOW = '2026-10-30T11:00:00.000Z';
const EXT = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
/** What the daemon's own env may hold and a run must never inherit (synthetic values). */
const LEAKY_ENV = { CLAUDE_CONFIG_DIR: '/synthetic/other-login', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/synthetic/secure', ANTHROPIC_API_KEY: 'sk-synthetic-key' };
const NEVER_INHERITED = Object.keys(LEAKY_ENV);
/** Long enough for a few fake claude processes on a busy Mac. */
const WAIT = { timeout: 30_000, interval: 20 };

let home: FakeHome | undefined;
let core: TestMeetingsCore | undefined;
let summaries: MeetingSummaries | undefined;
const temps: string[] = [];
beforeEach(() => {
  home = undefined;
});
afterEach(async () => {
  summaries?.stop();
  summaries = undefined;
  core?.close();
  core = undefined;
  await home?.cleanup();
  home = undefined;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function account(id: AccountId, five: number): Account {
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

interface RigOptions {
  mode?: 'single' | 'cswap';
  kept?: AccountId[];
  accounts?: Account[];
  bins?: Partial<Bins>;
  readOnly?: boolean;
}

/** The summaries on a fake home with the real exec: the fake claude (or cswap) runs as a process. */
async function rig(opts: RigOptions = {}): Promise<{ core: TestMeetingsCore; summaries: MeetingSummaries }> {
  home = await makeFakeHome();
  core = createTestMeetingsCore({
    clock: new FakeClock(NOW),
    settings: { accounts: { kept: opts.kept ?? [] } },
    readOnly: opts.readOnly ?? false,
    ctx: {
      userHome: home.home,
      home: home.jantarHome,
      env: { ...home.env, ...LEAKY_ENV },
      exec: createExecFile(),
      bins: { claude: home.bins.claude, cswap: home.bins.cswap, ...opts.bins },
      accountsMode: opts.mode ?? 'single',
    },
  });
  if (opts.accounts) core.ctx.store.emit({ type: 'usage.updated', data: { accounts: opts.accounts, activeAccount: null, fetchedAt: NOW, source: 'cache' } });
  summaries = buildSummaries(core);
  return { core, summaries };
}

const CLAUDE_JSON = (result: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'synthetic', usage: { input_tokens: 10, output_tokens: 10 } });
const GOOD = JSON.stringify({
  summary: 'The team moved the launch to Friday.',
  decisions: ['Launch moves to Friday.'],
  actionItems: [{ title: 'Send the revised quote', owner: 'Sam' }, { title: 'Book the review room' }],
});

/** A claude run held by the test: answer it, end it another way, or it ends as a killed process does when its signal aborts. */
interface Held {
  call: ExecCall;
  answer(stdout: string): void;
  exit(r: Partial<ExecResult>): void;
}

/** The summaries on a fake exec (single mode unless given, a temp state dir): every claude run waits in `held` until the test answers it. */
function heldRig(opts: { readOnly?: boolean; mode?: 'single' | 'cswap' } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'jantar-summary-'));
  temps.push(state);
  const held: Held[] = [];
  const exec = createFakeExec((call) => {
    if (call.file !== TEST_BINS.claude) return undefined;
    return new Promise((resolve) => {
      const killed = () => resolve({ code: null, signal: 'SIGTERM', stdout: '', stderr: '' });
      if (call.opts.signal?.aborted) return killed();
      call.opts.signal?.addEventListener('abort', killed, { once: true });
      held.push({ call, answer: (stdout) => resolve({ stdout }), exit: resolve });
    });
  });
  core = createTestMeetingsCore({ clock: new FakeClock(NOW), readOnly: opts.readOnly ?? false, ctx: { home: state, exec, accountsMode: opts.mode ?? 'single' } });
  summaries = buildSummaries(core);
  return { core, summaries, exec, held };
}

/** `c` with some of its parts replaced, for summaries built over it. */
const coreWith = (c: TestMeetingsCore, parts: Partial<TestMeetingsCore>) => Object.assign(Object.create(c) as TestMeetingsCore, parts);

/** An ended meeting (Weekly sync, people Sam and Priya) with `lines` caption lines; its id. */
function meeting(c: TestMeetingsCore, opts: { lines?: number; marked?: boolean; ended?: boolean; summary?: MeetingSummary; record?: Partial<MeetingRecord> } = {}): string {
  const id = c.newId();
  const start = new Date(MEETING_T0).toISOString();
  c.meetings.create({
    id,
    extId: EXT,
    clientId: randomUUID(),
    startedAt: start,
    endedAt: opts.ended === false ? null : new Date(MEETING_T0 + 3_600_000).toISOString(),
    lastAt: start,
    projectId: null,
    record: {
      name: opts.marked ? `Weekly sync ${MEETING_MARKER}` : 'Weekly sync',
      site: 'meet',
      people: 'Sam, Priya',
      autoTodos: false,
      notes: true,
      summary: opts.summary ?? { state: 'none', decisions: [], items: [] },
      ...opts.record,
    },
  });
  const n = opts.lines ?? 20;
  if (n > 0) c.meetings.upsertLines(id, transcriptLines(n, { marked: opts.marked ?? false }));
  return id;
}

const summaryOf = (c: TestMeetingsCore, id: string) => c.meetings.get(id)?.record.summary;
const stateOf = (c: TestMeetingsCore, id: string) => summaryOf(c, id)?.state;
const waitState = (c: TestMeetingsCore, id: string, state: MeetingSummary['state']) => vi.waitFor(() => expect(stateOf(c, id)).toBe(state), WAIT);
const failedWith = (reason: string): MeetingSummary => ({ state: 'failed', reason, decisions: [], items: [] });

function setMode(mode: string): void {
  writeFileSync(join((home as FakeHome).root, 'fake', 'claude.json'), JSON.stringify({ mode }));
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

const summaryAudit = (c: TestMeetingsCore) => c.ctx.db.audit.list().filter((a) => a.action === 'meeting.summary');

describe('MS1: the run is isolated like Rewrite, the transcript is on stdin only', () => {
  it("single mode: `claude -p` with Rewrite's isolation flags and our prompt file, no other login or key in the env", { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig();
    const id = meeting(core, { lines: 20 });
    summaries.enqueue(id);
    await waitState(core, id, 'done');

    const calls = await claudeCalls(home as FakeHome);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({ via: 'claude', account: null });
    const promptFile = join(core.ctx.paths.meetingSummaryDir, 'summary-v1.md');
    expect(call.args).toEqual(rewriteArgv({ account: null, model: 'sonnet', fallbackModel: 'haiku', effort: 'medium', systemPromptFile: promptFile }, 'claude'));
    expect(flag(call.args, '--tools')).toBe('');
    expect(flag(call.args, '--disallowedTools')).toBe('mcp__*');
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) expect(call.args).toContain(f);
    expect(flag(call.args, '--setting-sources')).toBe('local');
    expect(flag(call.args, '--settings')).toBe('{"disableAllHooks":true}');
    expect(flag(call.args, '--permission-mode')).toBe('dontAsk');
    expect(flag(call.args, '--max-turns')).toBe('1');
    expect(flag(call.args, '--system-prompt-file')).toBe(promptFile);
    expect([flag(call.args, '--model'), flag(call.args, '--fallback-model'), flag(call.args, '--effort')]).toEqual(['sonnet', 'haiku', 'medium']);

    // The prompt is a file (Appendix A, byte for byte), never argv; the transcript is stdin only.
    const asset = readFileSync(join(core.ctx.paths.assetsDir, 'meetings', 'summary-v1.md'), 'utf8');
    expect(readFileSync(promptFile, 'utf8')).toBe(asset);
    expect(asset.startsWith('You write the notes of a meeting for the person who kept them.')).toBe(true);
    expect(asset.endsWith('"owner" at most 60 and may be left out.\n')).toBe(true);
    const argv = call.args.join('\n');
    expect(argv).not.toContain('You write the notes');
    expect(argv).not.toContain('Line 1 about the launch');
    expect(argv).not.toContain('Weekly sync');
    const row = core.meetings.get(id)!;
    expect(call.stdin).toBe(summaryInput({ name: 'Weekly sync', startedAt: row.startedAt, people: 'Sam, Priya' }, core.meetings.lines(id), 'UTC'));
    expect(call.stdin).toContain('[10:00] Sam: Line 1 about the launch');
    for (const k of NEVER_INHERITED) expect(call.envKeys, k).not.toContain(k);
    expect(realpathSync(call.cwd)).toBe(realpathSync(join(core.ctx.paths.meetingSummaryDir, 'work')));
    // Its own dirs, 0700, and the prompt copy 0600.
    expect(statSync(core.ctx.paths.meetingSummaryDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(core.ctx.paths.meetingSummaryDir, 'work')).mode & 0o777).toBe(0o700);
    expect(statSync(promptFile).mode & 0o777).toBe(0o600);
    expect(await (home as FakeHome).calls('cswap')).toEqual([]);

    // The fake's meeting-ok answer, checked and kept.
    expect(summaryOf(core, id)).toEqual({
      state: 'done',
      text: 'Sam opened the meeting; 20 lines were said.',
      decisions: ['Launch moves to Friday.', 'Keep the current hosting.'],
      items: [
        { title: 'Send the revised quote', owner: 'Sam' },
        { title: 'Book the review room', owner: 'Priya' },
      ],
      at: NOW,
    });
  });

  it("lines said at one moment go in the page's own order, not by their ids as text", { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig();
    // One scan saw ten turns at once (Start mid-call): `<nonce>-10` must not come before `<nonce>-2`.
    const id = meeting(core, { lines: 0 });
    core.meetings.upsertLines(
      id,
      transcriptLines(10).map((l) => ({ ...l, at: MEETING_T0 })),
    );
    summaries.enqueue(id);
    await waitState(core, id, 'done');
    const stdin = (await claudeCalls(home as FakeHome))[0]?.stdin ?? '';
    const order = [...stdin.matchAll(/Line (\d+) about/g)].map((m) => Number(m[1]));
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('cswap mode: `cswap run --share-history N -- -p ...` on the picked account', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig({ mode: 'cswap', kept: [3], accounts: [account(2, 10), account(3, 0), account(4, 99)] });
    const id = meeting(core);
    summaries.enqueue(id);
    await waitState(core, id, 'done');
    const runs = (await (home as FakeHome).calls('cswap')).filter((c) => c.args[0] === 'run');
    expect(runs).toHaveLength(1);
    const promptFile = join(core.ctx.paths.meetingSummaryDir, 'summary-v1.md');
    expect(runs[0]?.args).toEqual(rewriteArgv({ account: 2, model: 'sonnet', fallbackModel: 'haiku', effort: 'medium', systemPromptFile: promptFile }, 'cswap'));
    for (const k of NEVER_INHERITED) expect(runs[0]?.envKeys, k).not.toContain(k);
    const [call] = await claudeCalls(home as FakeHome);
    expect(call).toMatchObject({ via: 'cswap', account: 2 });
    expect(call?.stdin).toContain('<meeting_transcript>');
  });

  it('empties its work folder before a run', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig();
    const work = join(core.ctx.paths.meetingSummaryDir, 'work');
    mkdirSync(join(work, 'left-behind'), { recursive: true });
    writeFileSync(join(work, 'stray.txt'), 'x');
    const id = meeting(core);
    summaries.enqueue(id);
    await waitState(core, id, 'done');
    expect(() => statSync(join(work, 'stray.txt'))).toThrow();
    expect(() => statSync(join(work, 'left-behind'))).toThrow();
  });
});

describe('MS2: never a kept or held account', () => {
  it('kept [3, 5] with every other account full: failed with the no-account sentence, and nothing runs', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig({ mode: 'cswap', kept: [3, 5], accounts: [account(3, 0), account(5, 0), account(2, 99), account(4, 100)] });
    const id = meeting(core);
    summaries.enqueue(id);
    await waitState(core, id, 'failed');
    expect(summaryOf(core, id)).toEqual(failedWith(SUMMARY_SENTENCES.noAccount));
    expect(await (home as FakeHome).calls('cswap')).toEqual([]);
    expect(await claudeCalls(home as FakeHome)).toEqual([]);
    expect(summaryAudit(core).map((a) => a.params)).toMatchObject([{ account: null, outcome: 'no_account' }]);
  });

  it('held accounts (autoswitch, rewrite.excludeAccounts) are passed over too', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig({ mode: 'cswap', accounts: [account(2, 0), account(3, 5), account(4, 10)] });
    expect((await core.ctx.settings.patch({ autoswitch: { hold: [2] }, rewrite: { excludeAccounts: [3] } })).ok).toBe(true);
    const id = meeting(core);
    summaries.enqueue(id);
    await waitState(core, id, 'done');
    expect((await claudeCalls(home as FakeHome))[0]?.account).toBe(4);
  });

  it('single mode: `claude -p` on account 0 with no cswap, whatever accounts.kept says', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig({ mode: 'single', kept: [0, 3] });
    const id = meeting(core);
    summaries.enqueue(id);
    await waitState(core, id, 'done');
    expect(await (home as FakeHome).calls('cswap')).toEqual([]);
    expect(summaryAudit(core).map((a) => a.params)).toMatchObject([{ account: 0, outcome: 'ok' }]);
  });
});

describe('MS3: anything but a valid answer is failed, nothing partial is kept, the process is gone', () => {
  it.each(['meeting-answer', 'meeting-bad-json', 'meeting-too-many', 'meeting-long', 'auth-error', 'empty'])('%s', { timeout: 60_000 }, async (mode) => {
    const { core, summaries } = await rig();
    setMode(mode);
    const id = meeting(core);
    summaries.enqueue(id);
    await waitState(core, id, 'failed');
    expect(summaryOf(core, id)).toEqual(failedWith(SUMMARY_SENTENCES.failed));
    const calls = await claudeCalls(home as FakeHome);
    expect(calls).toHaveLength(1);
    for (const c of calls) expect(processAlive(c.pid), `pid ${c.pid}`).toBe(false);
  });

  it('a run past 180 s is ended: failed, the process got SIGTERM and is gone', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig();
    setMode('slow');
    const id = meeting(core);
    summaries.enqueue(id);
    await vi.waitFor(async () => expect(await claudeCalls(home as FakeHome)).toHaveLength(1), WAIT);
    expect(stateOf(core, id)).toBe('running');
    core.clock.advance(MEETING_SUMMARY_TIMEOUT_MS - 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(stateOf(core, id)).toBe('running');
    core.clock.advance(1);
    await waitState(core, id, 'failed');
    expect(summaryOf(core, id)).toEqual(failedWith(SUMMARY_SENTENCES.failed));
    const [call] = await claudeCalls(home as FakeHome);
    expect(processAlive(call!.pid)).toBe(false);
    expect((await claudeSignals(home as FakeHome)).map((s) => s.signal)).toContain('SIGTERM');
    expect(summaryAudit(core)[0]?.params).toMatchObject({ outcome: 'timeout', ms: MEETING_SUMMARY_TIMEOUT_MS });
  });

  it('one code fence around the JSON is fine', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig();
    setMode('meeting-fence');
    const id = meeting(core);
    summaries.enqueue(id);
    await waitState(core, id, 'done');
    expect(summaryOf(core, id)?.text).toBe('Sam opened the meeting; 20 lines were said.');
  });

  it('parseSummary keeps only the checked fields, trimmed, and refuses anything else', () => {
    expect(parseSummary('{"summary":" Short. ","decisions":[],"actionItems":[{"title":"Do it","owner":"","x":1}],"more":1}')).toEqual({
      text: 'Short.',
      decisions: [],
      items: [{ title: 'Do it' }],
    });
    expect(parseSummary('```\n{"summary":"S","decisions":["D"],"actionItems":[]}\n```')).toEqual({ text: 'S', decisions: ['D'], items: [] });
    expect(parseSummary('Here: {"summary":"S","decisions":[],"actionItems":[]}')).toBeNull();
    expect(parseSummary('{"summary":"","decisions":[],"actionItems":[]}')).toBeNull();
    expect(parseSummary('{"summary":"S","decisions":[],"actionItems":[{"title":"  "}]}')).toBeNull();
    expect(parseSummary(`{"summary":"S","decisions":["${'d'.repeat(301)}"],"actionItems":[]}`)).toBeNull();
    expect(parseSummary('{"summary":"S","decisions":null,"actionItems":[]}')).toBeNull();
    expect(parseSummary(JSON.stringify({ summary: 'S', decisions: Array.from({ length: 21 }, () => 'D'), actionItems: [] }))).toBeNull();
    expect(parseSummary(JSON.stringify({ summary: 'S', decisions: [], actionItems: [{ title: 't'.repeat(201) }] }))).toBeNull();
    expect(parseSummary(JSON.stringify({ summary: 'S', decisions: [], actionItems: [{ title: 'T', owner: 7 }] }))).toBeNull();
    expect(parseSummary('[]')).toBeNull();
  });

  it('a list left out is an empty one: the summary is kept', () => {
    expect(parseSummary('{"summary":"S","actionItems":[]}')).toEqual({ text: 'S', decisions: [], items: [] });
    expect(parseSummary('{"summary":"S","decisions":["D"]}')).toEqual({ text: 'S', decisions: ['D'], items: [] });
    expect(parseSummary('{"summary":"S"}')).toEqual({ text: 'S', decisions: [], items: [] });
  });

  it('an owner never costs the notes: null or blank is left out, a long one is cut to 60 (never half a surrogate pair)', () => {
    const items = [
      { title: 'A', owner: null },
      { title: 'B', owner: '   ' },
      { title: 'C', owner: ` ${'o'.repeat(61)}` },
      { title: 'D', owner: `${'o'.repeat(59)}\u{1F600}` },
      { title: 'E', owner: `${'o'.repeat(58)}  x` },
    ];
    expect(parseSummary(JSON.stringify({ summary: 'S', decisions: [], actionItems: items }))?.items).toEqual([
      { title: 'A' },
      { title: 'B' },
      { title: 'C', owner: 'o'.repeat(60) },
      { title: 'D', owner: 'o'.repeat(59) },
      { title: 'E', owner: 'o'.repeat(58) },
    ]);
  });
});

describe('MS5: never under --read-only', () => {
  it('the status is unavailable with the sentence; an end leaves the summary none saying why; Summarize is refused; nothing runs', () => {
    const { core, summaries, exec } = heldRig({ readOnly: true });
    expect(summaries.status()).toEqual({ available: false, reason: READ_ONLY_SUMMARIES });
    const id = meeting(core);
    summaries.enqueue(id);
    // Past tense, so it stays true once Jantar runs without --read-only again.
    expect(summaryOf(core, id)).toEqual({ state: 'none', reason: SUMMARY_SENTENCES.readOnlyEnded, decisions: [], items: [] });
    expect(summaries.request(id, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: READ_ONLY_SUMMARIES });
    expect(stateOf(core, id)).toBe('none');
    expect(exec.calls).toEqual([]);
    expect(core.ticks).toBe(0);
  });

  it('available with Claude Code on this Mac; otherwise the no-runner sentence, and a queued summary fails with it', async () => {
    const { core, summaries, exec } = heldRig();
    expect(summaries.status()).toEqual({ available: true });
    const noClaude = buildSummaries(Object.assign(Object.create(core) as TestMeetingsCore, { ctx: { ...core.ctx, bins: { ...core.ctx.bins, claude: null } } }));
    expect(noClaude.status()).toEqual({ available: false, reason: SUMMARY_SENTENCES.noRunner });
    const id = meeting(core);
    noClaude.enqueue(id);
    await waitState(core, id, 'failed');
    expect(summaryOf(core, id)).toEqual(failedWith(SUMMARY_SENTENCES.noRunner));
    expect(exec.calls).toEqual([]);
    expect(summaryAudit(core).map((a) => a.params)).toMatchObject([{ outcome: 'unavailable', account: null }]);
  });

  it('claude gone by the time the run starts (or missing behind cswap): failed with the no-runner sentence', async () => {
    const { core, summaries, held } = heldRig();
    const id = meeting(core);
    summaries.enqueue(id);
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    held[0]!.exit({ code: 127, stdout: '', stderr: '' });
    await waitState(core, id, 'failed');
    expect(summaryOf(core, id)).toEqual(failedWith(SUMMARY_SENTENCES.noRunner));
    expect(summaryAudit(core).map((a) => a.params)).toMatchObject([{ outcome: 'unavailable', account: 0 }]);
  });
});

describe('MS6: one run at a time; nothing resumes after a restart', () => {
  it('runs one summary at a time, oldest first', async () => {
    const { core, summaries, held } = heldRig();
    const ids = [meeting(core), meeting(core), meeting(core)];
    for (const id of ids) summaries.enqueue(id);
    expect(ids.map((id) => stateOf(core, id))).toEqual(['queued', 'queued', 'queued']);
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    await new Promise((r) => setTimeout(r, 50));
    expect(held).toHaveLength(1);
    expect(ids.map((id) => stateOf(core, id))).toEqual(['running', 'queued', 'queued']);
    held[0]!.answer(CLAUDE_JSON(GOOD));
    await waitState(core, ids[0]!, 'done');
    await vi.waitFor(() => expect(held).toHaveLength(2), WAIT);
    expect(ids.map((id) => stateOf(core, id))).toEqual(['done', 'running', 'queued']);
    held[1]!.answer(CLAUDE_JSON('not json'));
    await vi.waitFor(() => expect(held).toHaveLength(3), WAIT);
    held[2]!.answer(CLAUDE_JSON(GOOD));
    await waitState(core, ids[2]!, 'done');
    expect(ids.map((id) => stateOf(core, id))).toEqual(['done', 'failed', 'done']);
    // Each run read its own meeting.
    expect(held.map((h) => h.call.opts.input)).toEqual(ids.map((id) => summaryInput({ name: 'Weekly sync', startedAt: core.meetings.get(id)!.startedAt, people: 'Sam, Priya' }, core.meetings.lines(id), 'UTC')));
  });

  it('a start marks what a restart left queued or running failed and runs nothing; Try again runs it', async () => {
    const { core, summaries, held, exec } = heldRig();
    const queued = meeting(core, { summary: { state: 'queued', decisions: [], items: [] } });
    const running = meeting(core, { summary: { state: 'running', decisions: [], items: [] } });
    const done = meeting(core, { summary: { state: 'done', text: 'Kept.', decisions: [], items: [], at: NOW } });
    summaries.start();
    expect(summaryOf(core, queued)).toEqual(failedWith(SUMMARY_SENTENCES.stopped));
    expect(summaryOf(core, running)).toEqual(failedWith(SUMMARY_SENTENCES.stopped));
    expect(stateOf(core, done)).toBe('done');
    expect(core.ticks).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(exec.calls).toEqual([]);

    expect(summaries.request(running, PHONE)).toEqual({ ok: true, value: true });
    expect(stateOf(core, running)).toBe('queued');
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    held[0]!.answer(CLAUDE_JSON(GOOD));
    await waitState(core, running, 'done');
    expect(summaryOf(core, running)).toMatchObject({ state: 'done', text: 'The team moved the launch to Friday.' });
    expect(summaryOf(core, running)?.reason).toBeUndefined();
  });

  it('stop() ends the run going and fails it and the queued ones with the stopped sentence; the killed run keeps nothing', async () => {
    const { core, summaries, held } = heldRig();
    const [a, b] = [meeting(core), meeting(core)];
    summaries.enqueue(a);
    summaries.enqueue(b);
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    const signal = held[0]!.call.opts.signal!;
    summaries.stop();
    expect(signal.aborted).toBe(true);
    expect(summaryOf(core, a)).toEqual(failedWith(SUMMARY_SENTENCES.stopped));
    expect(summaryOf(core, b)).toEqual(failedWith(SUMMARY_SENTENCES.stopped));
    await vi.waitFor(() => expect(summaryAudit(core).map((r) => r.params)).toMatchObject([{ outcome: 'cancelled' }]), WAIT);
    // The aborted run did not overwrite the stopped sentence, and nothing else ran.
    expect(summaryOf(core, a)).toEqual(failedWith(SUMMARY_SENTENCES.stopped));
    expect(held).toHaveLength(1);

    // Opened again: the next request runs.
    summaries.start();
    expect(summaries.request(b, PHONE).ok).toBe(true);
    await vi.waitFor(() => expect(held).toHaveLength(2), WAIT);
    held[1]!.answer(CLAUDE_JSON(GOOD));
    await waitState(core, b, 'done');
  });

  it("stop() while the run picks its account (ccw's hold list is slow): it keeps nothing, and the queue is free after", async () => {
    const { core, exec } = heldRig({ mode: 'cswap' });
    let asked = 0;
    let release: (v: null) => void = () => {};
    const ccwLegacy = notBuilt<CcwLegacySource>('ccw', {
      present: () => true,
      switchConfig: () => {
        asked += 1;
        return asked === 1 ? new Promise((r) => (release = r)) : Promise.resolve(null);
      },
    });
    summaries = buildSummaries(coreWith(core, { ccwLegacy }));
    const id = meeting(core);
    summaries.enqueue(id);
    await vi.waitFor(() => expect(asked).toBe(1), WAIT);
    summaries.stop();
    release(null);
    summaries.start();
    expect(summaryOf(core, id)).toEqual(failedWith(SUMMARY_SENTENCES.stopped));

    // Try again runs once the stopped run is gone (no account has room here): only its own audit row.
    expect(summaries.request(id, PHONE).ok).toBe(true);
    await waitState(core, id, 'failed');
    expect(summaryOf(core, id)).toEqual(failedWith(SUMMARY_SENTENCES.noAccount));
    expect(summaryAudit(core).map((a) => a.params)).toMatchObject([{ outcome: 'no_account' }]);
    expect(exec.calls).toEqual([]);
  });

  it('stop() just as the run dir is made: no claude starts, and the cancelled run keeps nothing', async () => {
    const { core, exec } = heldRig();
    let stopped = false;
    // The run reads ctx.paths only to make its dir.
    const ctx = Object.create(core.ctx, {
      paths: {
        get: () => {
          if (!stopped) {
            stopped = true;
            summaries?.stop();
          }
          return core.ctx.paths;
        },
      },
    }) as TestMeetingsCore['ctx'];
    summaries = buildSummaries(coreWith(core, { ctx }));
    const id = meeting(core);
    summaries.enqueue(id);
    await vi.waitFor(() => expect(summaryAudit(core).map((a) => a.params)).toMatchObject([{ outcome: 'cancelled' }]), WAIT);
    expect(stopped).toBe(true);
    expect(summaryOf(core, id)).toEqual(failedWith(SUMMARY_SENTENCES.stopped));
    expect(exec.calls).toEqual([]);
    expect(core.ctx.log.records.filter((l) => l.msg === 'meetings: a summary did not work')).toEqual([]);
  });

  it('a run that throws is failed with the fixed sentence, logged by kind only, and the queue goes on', async () => {
    const { core, held } = heldRig();
    let first = true;
    const tz = () => {
      if (!first) return 'UTC';
      first = false;
      throw new TypeError(`no zone ${MEETING_MARKER}`);
    };
    summaries = buildSummaries(coreWith(core, { tz }));
    const [a, b] = [meeting(core), meeting(core)];
    summaries.enqueue(a);
    summaries.enqueue(b);
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    expect(summaryOf(core, a)).toEqual(failedWith(SUMMARY_SENTENCES.failed));
    expect(core.ctx.log.records.find((l) => l.msg === 'meetings: a summary run failed')?.fields).toEqual({ part: 'meetings', module: 'summary', error: 'TypeError' });
    expect(JSON.stringify(core.ctx.log.records)).not.toContain(MEETING_MARKER);
    held[0]!.answer(CLAUDE_JSON(GOOD));
    await waitState(core, b, 'done');
  });

  it('a run that ends after its meeting was deleted, or after meetings.db closed, keeps nothing', async () => {
    const { core, held } = heldRig();
    let open = true;
    const gated = Object.assign(Object.create(core) as TestMeetingsCore, { store: () => (open ? core.meetings : null) });
    summaries = buildSummaries(gated);
    const [gone, closed] = [meeting(core), meeting(core)];
    summaries.enqueue(gone);
    summaries.enqueue(closed);
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    expect(core.meetings.remove(gone)).toBe(true);
    const ticks = core.ticks;
    held[0]!.answer(CLAUDE_JSON(GOOD));
    await vi.waitFor(() => expect(held).toHaveLength(2), WAIT);
    expect(core.meetings.get(gone)).toBeNull();
    expect(core.ticks).toBe(ticks + 1); // the next one's running, and nothing for the deleted one
    open = false;
    held[1]!.answer(CLAUDE_JSON(GOOD));
    await vi.waitFor(() => expect(summaryAudit(core)).toHaveLength(2), WAIT);
    await new Promise((r) => setTimeout(r, 50));
    expect(stateOf(core, closed)).toBe('running');
    expect(core.todos.created).toEqual([]);
  });
});

describe('a deleted meeting', () => {
  it("stops its run: the process is killed, nothing is kept, the next one runs; a queued one never runs", async () => {
    const { core, summaries, held } = heldRig();
    const [going, waiting, next] = [meeting(core), meeting(core), meeting(core)];
    for (const id of [going, waiting, next]) summaries.enqueue(id);
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    for (const id of [going, waiting]) {
      expect(core.meetings.remove(id)).toBe(true);
      summaries.cancel(id);
    }
    expect(held[0]!.call.opts.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(held).toHaveLength(2), WAIT);
    held[1]!.answer(CLAUDE_JSON(GOOD));
    await waitState(core, next, 'done');
    expect(summaryAudit(core).map((a) => [a.target, (a.params as { outcome?: string }).outcome])).toEqual([
      [going, 'cancelled'],
      [next, 'ok'],
    ]);
    // Another meeting's id, or one with no run, changes nothing.
    summaries.cancel(core.newId());
    expect(summaryOf(core, next)?.state).toBe('done');
  });
});

describe('Summarize and Try again', () => {
  it('allowed for an ended meeting with lines whose summary is none or failed; refused otherwise with the fixed sentences', () => {
    const { core, summaries } = heldRig();
    const none = meeting(core, { lines: 1 });
    const failed = meeting(core, { summary: failedWith(SUMMARY_SENTENCES.failed) });
    const done = meeting(core, { summary: { state: 'done', text: 'Kept.', decisions: [], items: [], at: NOW } });
    const queued = meeting(core, { summary: { state: 'queued', decisions: [], items: [] } });
    const running = meeting(core, { summary: { state: 'running', decisions: [], items: [] } });
    const open = meeting(core, { ended: false });
    const silent = meeting(core, { lines: 0 });
    expect(summaries.request(done, PHONE)).toEqual({ ok: false, code: 'conflict', reason: SUMMARY_SENTENCES.done });
    expect(summaries.request(queued, PHONE)).toEqual({ ok: false, code: 'conflict', reason: SUMMARY_SENTENCES.busy });
    expect(summaries.request(running, PHONE)).toEqual({ ok: false, code: 'conflict', reason: SUMMARY_SENTENCES.busy });
    expect(summaries.request(open, PHONE)).toEqual({ ok: false, code: 'conflict', reason: SUMMARY_SENTENCES.open });
    expect(summaries.request(silent, PHONE)).toEqual({ ok: false, code: 'conflict', reason: SUMMARY_SENTENCES.noLines });
    expect(summaries.request(core.newId(), PHONE)).toEqual({ ok: false, code: 'not_found', reason: NO_MEETING });
    expect(core.ticks).toBe(0);
    // One line is enough when asked by hand (the automatic one needs MEETING_SUMMARY_MIN_CHARS).
    expect(core.meetings.lineChars(none)).toBeLessThan(MEETING_SUMMARY_MIN_CHARS);
    expect(summaries.request(none, PHONE)).toEqual({ ok: true, value: true });
    expect(summaries.request(failed, PHONE)).toEqual({ ok: true, value: true });
    expect(summaryOf(core, failed)).toEqual({ state: 'queued', decisions: [], items: [] });
    expect(summaries.request(failed, PHONE)).toEqual({ ok: false, code: 'conflict', reason: SUMMARY_SENTENCES.busy });
  });

  it('enqueue queues only an ended meeting whose summary is none, once', () => {
    const { core, summaries } = heldRig();
    const open = meeting(core, { ended: false });
    const failed = meeting(core, { summary: failedWith(SUMMARY_SENTENCES.failed) });
    const id = meeting(core);
    summaries.enqueue(open);
    summaries.enqueue(failed);
    summaries.enqueue(core.newId());
    expect([stateOf(core, open), stateOf(core, failed)]).toEqual(['none', 'failed']);
    expect(core.ticks).toBe(0);
    summaries.enqueue(id);
    summaries.enqueue(id);
    expect(stateOf(core, id)).toBe('queued');
    expect(core.ticks).toBe(1);
  });
});

describe('MP3: a summary ticks once per state change and emits nothing itself', () => {
  it('queued, running, done: three ticks; queued, running, failed: three more; no event of its own', async () => {
    const { core, summaries, held } = heldRig();
    const id = meeting(core);
    summaries.enqueue(id);
    expect(core.ticks).toBe(1);
    await vi.waitFor(() => expect(held).toHaveLength(1), WAIT);
    expect(core.ticks).toBe(2);
    held[0]!.answer(CLAUDE_JSON(GOOD));
    await waitState(core, id, 'done');
    expect(core.ticks).toBe(3);

    const other = meeting(core);
    summaries.enqueue(other);
    await vi.waitFor(() => expect(held).toHaveLength(2), WAIT);
    held[1]!.answer(CLAUDE_JSON('prose, not JSON'));
    await waitState(core, other, 'failed');
    expect(core.ticks).toBe(6);
    const r = core.ctx.store.replay(0);
    expect(r.kind === 'events' ? r.events : []).toEqual([]);
  });
});

describe('the audit row and the logs: counts only', () => {
  it('one meeting.summary row per run with lines, characters, time, account, model and version; no text anywhere', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig();
    const id = meeting(core, { lines: 12, marked: true });
    summaries.enqueue(id);
    await waitState(core, id, 'done');
    // The fake copies the marker through: the summary keeps it, and nothing else does.
    expect(summaryOf(core, id)?.text).toContain(MEETING_MARKER);
    setMode('meeting-bad-json');
    const failed = meeting(core, { lines: 12, marked: true });
    summaries.enqueue(failed);
    await waitState(core, failed, 'failed');

    const rows = summaryAudit(core);
    const [first] = await claudeCalls(home as FakeHome);
    expect(rows.map((r) => [r.actor, r.target, r.result, r.params])).toEqual([
      ['system', id, 'ok', { lines: 12, chars: first!.stdin.length, ms: 0, account: 0, model: 'sonnet', promptVersion: 'v1', outcome: 'ok' }],
      ['system', failed, 'failed', { lines: 12, chars: first!.stdin.length, ms: 0, account: 0, model: 'sonnet', promptVersion: 'v1', outcome: 'unreadable' }],
    ]);
    const r = core.ctx.store.replay(0);
    expect(JSON.stringify([r.kind === 'events' ? r.events : [], core.ctx.db.audit.list(), core.ctx.log.records])).not.toContain(MEETING_MARKER);
    expect(core.ctx.log.records.find((l) => l.msg === 'meetings: a summary did not work')?.fields).toEqual({ part: 'meetings', module: 'summary', outcome: 'unreadable' });
  });

  it('a refused droppable option is learned once: the retry runs without it, and so does every later summary', { timeout: 60_000 }, async () => {
    const { core, summaries } = await rig();
    writeFileSync(
      join((home as FakeHome).root, 'fake', 'claude.json'),
      JSON.stringify({ rules: [{ match: { argsIncludes: ['--permission-prompts'] }, stderr: "error: unknown option '--permission-prompts'\n", code: 1 }] }),
    );
    const [a, b] = [meeting(core), meeting(core)];
    summaries.enqueue(a);
    await waitState(core, a, 'done');
    summaries.enqueue(b);
    await waitState(core, b, 'done');
    const calls = await claudeCalls(home as FakeHome);
    expect(calls.map((c) => c.args.includes('--permission-prompts'))).toEqual([true, false, false]);
    const refused = core.ctx.log.records.filter((r) => r.msg.includes('refused'));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.fields).toMatchObject({ option: '--permission-prompts', dropped: true });
  });
});
