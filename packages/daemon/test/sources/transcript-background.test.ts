/**
 * v0.6.1: background work from the main transcript. The scanner on its own
 * (launches, ends, Claude's turn_duration count, the process start, expiry,
 * caps, malformed rows, privacy), then the watcher publishing it as
 * `background`. Every id, folder, name and word is made up.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentLaunched,
  assistantToolUse,
  monitorStarted,
  queueOperation,
  shellLaunched,
  systemRow,
  taskNotification,
  taskNotificationTurn,
  taskStopped,
  toJsonl,
  toolResultWith,
  turnDuration,
  workflowLaunched,
  type Entry,
  type EntryContext,
} from '@jantar/fixtures';
import { backgroundRunning, type SessionBackground } from '@jantar/protocol';
import { createClaudeFilesSource, type ClaudeFilesSource } from '../../src/sources/claude-files/index.js';
import { BACKGROUND_MAX_AGE_MS, BackgroundScanner } from '../../src/sources/transcripts/background.js';
import {
  createFileTranscriptReader,
  createTranscriptWatcherWith,
  type TranscriptWatcherImpl,
} from '../../src/sources/transcripts/index.js';
import { SID, at, sourceEnv, type SourceEnv } from './helpers.js';

const SESSION = '00000000-0000-4000-8000-0000000000aa';
const CWD = '/tmp/demo/web-app';
const T = Date.parse('2026-03-04T10:00:00.000Z');
const START = T - 3_600_000;
const iso = (ms: number) => new Date(T + ms).toISOString();
const ctx = (ms = 0, over: Partial<EntryContext> = {}): EntryContext => ({ sessionId: SESSION, cwd: CWD, at: iso(ms), ...over });

const W1 = 'wdemoaaaa';
const W2 = 'wdemobbbb';
const A1 = 'a0123456789abcdef';
const B1 = 'bdemobbbb';
const B2 = 'bdemocccc';
const M1 = 'bdemodddd';

let n = 0;
/** A launch: the tool_use and its result row. */
function launch(ms: number, result: unknown, opts: { isError?: boolean; over?: Partial<EntryContext> } = {}): Entry[] {
  const id = `toolu_demo${++n}`;
  return [
    assistantToolUse(ctx(ms, opts.over), 'Workflow', { script: 'synthetic' }, id),
    toolResultWith(ctx(ms + 1, opts.over), id, 'Synthetic launch result', result, opts.isError),
  ];
}
const enqueue = (ms: number, text: string) => queueOperation(ctx(ms), 'enqueue', text);

function scanned(entries: readonly unknown[], procStart: number | null = START): BackgroundScanner {
  const sc = new BackgroundScanner();
  for (const e of entries) sc.scan(e as Entry, procStart);
  return sc;
}
const snap = (sc: BackgroundScanner, now = T + 60_000, procStart: number | null = START): SessionBackground => sc.snapshot(procStart, now);

describe('BackgroundScanner', () => {
  it('a workflow launch counts with its name and start; its queued notification ends it', () => {
    const sc = scanned(launch(0, workflowLaunched(W1, 'demo-sweep')));
    expect(snap(sc)).toEqual({ workflows: 1, since: iso(1), names: ['demo-sweep'] });
    sc.scan(enqueue(60_000, taskNotification(W1, 'completed')), START);
    expect(snap(sc)).toEqual({});
  });

  it('completed, failed, killed and stopped each end a task; a notification with no status (a monitor event) ends nothing', () => {
    for (const status of ['completed', 'failed', 'killed', 'stopped'] as const) {
      const sc = scanned([...launch(0, workflowLaunched(W1, 'demo-sweep')), enqueue(5000, taskNotification(W1, status))]);
      expect(snap(sc), status).toEqual({});
    }
    const sc = scanned([...launch(0, monitorStarted(M1, 600_000, false)), enqueue(5000, taskNotification(M1))]);
    expect(snap(sc)).toEqual({ monitors: 1 });
  });

  it('an agent launch counts, and the task-notification turn alone ends it', () => {
    const sc = scanned(launch(0, agentLaunched(A1)));
    expect(snap(sc)).toEqual({ agents: 1, since: iso(1) });
    sc.scan(taskNotificationTurn(ctx(9000), taskNotification(A1, 'completed')), START);
    expect(snap(sc)).toEqual({});
  });

  it('a resumed agent counts again', () => {
    const sc = scanned([
      ...launch(0, agentLaunched(A1)),
      enqueue(1000, taskNotification(A1, 'completed')),
      ...launch(2000, { success: true, message: 'Synthetic', resumedAgentId: A1 }),
    ]);
    expect(snap(sc)).toEqual({ agents: 1, since: iso(2001) });
  });

  it('shells, run in the background or moved there on a timeout, are only a quiet count', () => {
    const sc = scanned([...launch(0, shellLaunched(B1)), ...launch(10, shellLaunched(B2, { timedOut: true }))]);
    const background = snap(sc);
    expect(background).toEqual({ shells: 2 });
    expect(backgroundRunning({ status: 'idle', background })).toBe(0);
  });

  it('a monitor expires at launch + timeoutMs; a persistent one stays until TaskStop', () => {
    const sc = scanned(launch(0, monitorStarted(M1, 300_000, false)));
    expect(snap(sc, T + 300_000)).toEqual({ monitors: 1 });
    expect(snap(sc, T + 300_001)).toEqual({});
    const p = scanned(launch(0, monitorStarted(M1, 300_000, true)));
    expect(snap(p, T + 10 * 3_600_000)).toEqual({ monitors: 1 });
    p.scan(toolResultWith(ctx(20_000), 'toolu_stop', '{}', taskStopped(M1, 'local_bash')), START);
    expect(snap(p)).toEqual({});
  });

  it('TaskStop ends a workflow that has no notification', () => {
    const sc = scanned([...launch(0, workflowLaunched(W1, 'demo-sweep')), toolResultWith(ctx(5000), 'toolu_stop', '{}', taskStopped(W1, 'local_workflow'))]);
    expect(snap(sc)).toEqual({});
  });

  it('a notification for an id never launched in the main chain changes nothing, and a sidechain launch is ignored', () => {
    const sc = scanned([
      ...launch(0, workflowLaunched(W1, 'demo-sweep')),
      enqueue(1000, taskNotification('bdemozzzz', 'completed')),
      ...launch(2000, shellLaunched(B1), { over: { isSidechain: true } }),
    ]);
    expect(snap(sc)).toEqual({ workflows: 1, since: iso(1), names: ['demo-sweep'] });
  });

  it('a restart: rows before the process start are ignored, a later start prunes, an orphan batch ends only its ids', () => {
    const old = scanned(launch(-10_000, workflowLaunched(W1, 'demo-sweep')), T - 5000);
    expect(snap(old, T, T - 5000)).toEqual({});

    const sc = scanned([...launch(0, workflowLaunched(W1, 'demo-sweep')), ...launch(10, agentLaunched(A1))]);
    expect(snap(sc, T + 1000, T + 500)).toEqual({});

    const batch = scanned([
      ...launch(0, shellLaunched(B1)),
      ...launch(10, shellLaunched(B2)),
      ...launch(20, shellLaunched('bdemoeeee')),
      ...launch(30, workflowLaunched(W1, 'demo-sweep')),
      enqueue(1000, taskNotification([B1, B2, '__orphan_summary__:shell'], 'stopped')),
    ]);
    expect(snap(batch)).toEqual({ workflows: 1, shells: 1, since: iso(31), names: ['demo-sweep'] });
  });

  it('turn_duration: a count with no launch read is an unnamed floor, a 0 drops unended launches, a lower count keeps the newest', () => {
    const floor = scanned([turnDuration(ctx(5000), { workflows: 1, agents: 1 }), turnDuration(ctx(9000), { workflows: 2, agents: 1 })]);
    expect(snap(floor)).toEqual({ workflows: 2, agents: 1, since: iso(5000) });
    floor.scan(turnDuration(ctx(20_000)), START);
    expect(snap(floor)).toEqual({});

    const stopped = scanned([...launch(0, workflowLaunched(W1, 'demo-sweep')), turnDuration(ctx(5000))]);
    expect(snap(stopped)).toEqual({});

    const lower = scanned([
      ...launch(0, workflowLaunched(W1, 'demo-older')),
      ...launch(100, workflowLaunched(W2, 'demo-sweep')),
      turnDuration(ctx(5000), { workflows: 1 }),
    ]);
    expect(snap(lower)).toEqual({ workflows: 1, since: iso(101), names: ['demo-sweep'] });

    const both = scanned([...launch(0, workflowLaunched(W1, 'demo-sweep')), turnDuration(ctx(5000), { workflows: 2 })]);
    expect(snap(both)).toEqual({ workflows: 2, since: iso(1), names: ['demo-sweep'] });
  });

  it('agents_killed ends the agents launched before it', () => {
    const sc = scanned([
      ...launch(0, agentLaunched(A1)),
      ...launch(10, workflowLaunched(W1, 'demo-sweep')),
      systemRow(ctx(1000), 'agents_killed'),
      ...launch(2000, agentLaunched('a1111111111111111')),
    ]);
    expect(snap(sc)).toEqual({ workflows: 1, agents: 1, since: iso(11), names: ['demo-sweep'] });
  });

  it('ages out after 24 h, and keeps the newest 64 tasks of 70', () => {
    const sc = scanned(launch(0, workflowLaunched(W1, 'demo-sweep')));
    expect(snap(sc, T + BACKGROUND_MAX_AGE_MS)).toMatchObject({ workflows: 1 });
    expect(snap(sc, T + BACKGROUND_MAX_AGE_MS + 2)).toEqual({});

    const ids = Array.from({ length: 70 }, (_, i) => `bdemo${String(i).padStart(4, '0')}`);
    const many = scanned(ids.flatMap((id, i) => launch(i * 10, shellLaunched(id))));
    expect(snap(many)).toEqual({ shells: 64 });
    many.scan(enqueue(5000, taskNotification(ids[0]!, 'completed')), START); // dropped already
    expect(snap(many)).toEqual({ shells: 64 });
    many.scan(enqueue(5000, taskNotification(ids[69]!, 'completed')), START);
    expect(snap(many)).toEqual({ shells: 63 });
  });

  it('names: the first line, clipped to 80, newest first, at most 3', () => {
    const sc = scanned([
      ...launch(0, workflowLaunched('wdemo0001', 'demo-one')),
      ...launch(10, workflowLaunched('wdemo0002', '\n  demo-two  \nsecond line')),
      ...launch(20, workflowLaunched('wdemo0003', 'x'.repeat(100))),
      ...launch(30, workflowLaunched('wdemo0004', 'demo-four')),
      ...launch(40, workflowLaunched('wdemo0005', '   ')),
    ]);
    const names = snap(sc).names ?? [];
    expect(snap(sc).workflows).toBe(5);
    expect(names).toEqual(['demo-four', `${'x'.repeat(79)}…`, 'demo-two']);
    expect(names[1]).toHaveLength(80);
  });

  it('malformed rows add nothing and never throw', () => {
    const bad: unknown[] = [
      null,
      42,
      'text',
      [],
      {},
      { type: 'user', timestamp: iso(0), toolUseResult: 'Error: synthetic failure' },
      { type: 'user', timestamp: iso(0), toolUseResult: { status: 'async_launched', taskType: 'local_workflow', taskId: 123 } },
      { type: 'user', timestamp: iso(0), toolUseResult: { status: 'async_launched', taskType: 'local_workflow' } },
      { type: 'user', timestamp: iso(0), toolUseResult: { status: 'async_launched', taskType: 'local_workflow', taskId: W1, error: 'synthetic' } },
      { type: 'user', timestamp: iso(0), toolUseResult: { taskId: M1, timeoutMs: Number.NaN } },
      { type: 'user', timestamp: iso(0), toolUseResult: { status: 'async_launched', agentId: 7, description: 'x' } },
      { type: 'user', timestamp: iso(0), toolUseResult: { backgroundTaskId: B1 } },
      launch(0, workflowLaunched(W2, 'demo-sweep'), { isError: true })[1],
      { type: 'user', toolUseResult: workflowLaunched(W1, 'demo-sweep') },
      { type: 'user', timestamp: 'not a time', toolUseResult: workflowLaunched(W1, 'demo-sweep') },
      { type: 'queue-operation', operation: 'enqueue', timestamp: iso(0), content: { not: 'text' } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: iso(0), content: '<task-notification><task-id>x</task-id><status>completed</status>' },
      { type: 'user', timestamp: iso(0), origin: { kind: 'task-notification' }, message: { content: 5 } },
      { type: 'system', subtype: 'turn_duration', timestamp: iso(0), pendingWorkflowCount: 'two', pendingBackgroundAgentCount: -3 },
    ];
    const sc = new BackgroundScanner();
    for (const e of bad) expect(() => sc.scan(e as Entry, START)).not.toThrow();
    expect(snap(sc)).toEqual({});
    // and an unclosed notification ends nothing
    const kept = scanned([...launch(0, shellLaunched(B1)), enqueue(10, `<task-notification><task-id>${B1}</task-id><status>completed</status>`)]);
    expect(snap(kept)).toEqual({ shells: 1 });
  });

  it('never keeps a description, prompt, command, summary or stop message', () => {
    const MARK = 'ZEBRAMARKER';
    const sc = scanned([
      ...launch(0, { ...workflowLaunched(W1, 'demo-sweep'), summary: `${MARK} summary`, scriptPath: `/tmp/${MARK}.js` }),
      ...launch(10, { ...agentLaunched(A1), description: `${MARK} description`, prompt: `${MARK} prompt` }),
      ...launch(20, { ...shellLaunched(B1), stdout: MARK }),
      ...launch(30, { ...monitorStarted(M1, 600_000, true), command: `${MARK} command` }),
      enqueue(40, taskNotification('bdemozzzz', 'completed', `${MARK} summary`)),
      toolResultWith(ctx(50), 'toolu_stop', MARK, { ...taskStopped(B2, 'local_bash'), message: `Successfully stopped task: ${B2} (${MARK})`, command: MARK }),
    ]);
    const out = JSON.stringify(snap(sc));
    expect(out).not.toContain(MARK);
    for (const id of [W1, A1, B1, M1]) expect(out).not.toContain(id);
    expect(snap(sc)).toEqual({ workflows: 1, agents: 1, shells: 1, monitors: 1, since: iso(1), names: ['demo-sweep'] });
  });
});

// ---------------------------------------------------------------------------
// The watcher

interface Rig {
  sessions: ClaudeFilesSource;
  watcher: TranscriptWatcherImpl;
  step(): Promise<void>;
}

async function rig(env: SourceEnv): Promise<Rig> {
  const sessions = createClaudeFilesSource(env.ctx, { watch: false, pollMs: 1e9 });
  const reader = createFileTranscriptReader(env.ctx);
  const watcher = createTranscriptWatcherWith(env.ctx, { sessions, transcripts: reader }, { pollMs: 1e9 });
  await sessions.start();
  await watcher.start();
  return {
    sessions,
    watcher,
    async step() {
      await sessions.scan();
      await watcher.pollOnce();
    },
  };
}

describe('transcript watcher: background work', () => {
  let env: SourceEnv;
  let r: Rig;
  beforeEach(async () => {
    env = await sourceEnv();
    r = await rig(env);
  });
  afterEach(async () => {
    await r.watcher.stop();
    await r.sessions.stop();
    await env.cleanup();
  });

  const sid = SID.idle;
  const c = (ms = 0) => at(env.ctx, sid, env.home.session(sid).cwd, ms);
  const patches = (s: string = sid) =>
    env.events
      .of('session.updated', s)
      .filter((e) => 'background' in e.data.patch)
      .map((e) => e.data.patch.background);
  const rows = (ms: number, toolUseId: string, result: unknown): Entry[] => [
    assistantToolUse(c(ms), 'Workflow', { script: 'synthetic' }, toolUseId),
    toolResultWith(c(ms + 1), toolUseId, 'Synthetic launch result', result),
  ];

  it('publishes what runs, then one patch to {} when it ends; a session with none gets nothing', async () => {
    await env.home.appendTranscript(sid, [
      ...rows(0, 'toolu_w', workflowLaunched(W1, 'demo-sweep')),
      ...rows(10, 'toolu_b', shellLaunched(B1)),
      turnDuration(c(20), { workflows: 1 }),
    ]);
    await r.step();
    const since = new Date(env.ctx.clock.now() + 1).toISOString();
    expect(patches()).toEqual([{ workflows: 1, shells: 1, since, names: ['demo-sweep'] }]);
    expect(env.ctx.store.getState().sessions[sid]?.background).toEqual({ workflows: 1, shells: 1, since, names: ['demo-sweep'] });

    await env.home.appendTranscript(sid, [
      queueOperation(c(60_000), 'enqueue', taskNotification(W1, 'completed')),
      queueOperation(c(60_001), 'enqueue', taskNotification(B1, 'completed')),
    ]);
    await r.step();
    await r.step();
    expect(patches()).toEqual([{ workflows: 1, shells: 1, since, names: ['demo-sweep'] }, {}]);
    expect(env.ctx.store.getState().sessions[sid]?.background).toEqual({});

    for (const other of [SID.busy, SID.waiting, SID.private]) expect(patches(other)).toEqual([]);
  });

  it('a new process start in the session file clears it', async () => {
    await env.home.appendTranscript(sid, rows(0, 'toolu_w', workflowLaunched(W1, 'demo-sweep')));
    await r.step();
    expect(env.ctx.store.getState().sessions[sid]?.background).toMatchObject({ workflows: 1 });
    env.ctx.clock.advance(5000);
    await env.home.updateSessionFile(sid, { startedAt: env.ctx.clock.now() });
    await r.step();
    expect(env.ctx.store.getState().sessions[sid]?.background).toEqual({});
  });

  it("a monitor's expiry publishes with no transcript change", async () => {
    await env.home.appendTranscript(sid, rows(0, 'toolu_m', monitorStarted(M1, 300_000, false)));
    await r.step();
    expect(patches()).toEqual([{ monitors: 1 }]);
    env.ctx.clock.advance(300_002);
    await r.step();
    expect(patches()).toEqual([{ monitors: 1 }, {}]);
  });

  it("a subagent transcript's launches never count", async () => {
    const s = env.home.session(sid);
    const sub = join(dirname(s.transcriptPath), sid, 'subagents', 'agent-a1.jsonl');
    await mkdir(dirname(sub), { recursive: true });
    await writeFile(sub, toJsonl(rows(0, 'toolu_sub', workflowLaunched(W1, 'demo-sweep'))));
    await r.step();
    env.ctx.clock.advance(20_000);
    await r.step();
    expect(patches()).toEqual([]);
    expect(env.ctx.store.getState().sessions[sid]?.background).toBeUndefined();
  });
});
