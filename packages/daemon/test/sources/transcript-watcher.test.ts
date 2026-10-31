import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiError,
  assistantText,
  assistantToolUse,
  toJsonl,
  toolResult,
  userPrompt,
  type Entry,
} from '@jantar/fixtures';
import { createClaudeFilesSource, type ClaudeFilesSource } from '../../src/sources/claude-files/index.js';
import {
  createFileTranscriptReader,
  createTranscriptWatcher,
  createTranscriptWatcherWith,
  type FileTranscriptReader,
  type TranscriptWatcherImpl,
} from '../../src/sources/transcripts/index.js';
import { SID, at, sourceEnv, type SourceEnv } from './helpers.js';

interface Rig {
  env: SourceEnv;
  sessions: ClaudeFilesSource;
  reader: FileTranscriptReader;
  watcher: TranscriptWatcherImpl;
  /** Rescan session files, then poll transcripts once. */
  step(): Promise<void>;
}

async function rig(env: SourceEnv): Promise<Rig> {
  const sessions = createClaudeFilesSource(env.ctx, { watch: false, pollMs: 1e9 });
  const reader = createFileTranscriptReader(env.ctx);
  const watcher = createTranscriptWatcherWith(env.ctx, { sessions, transcripts: reader }, { pollMs: 1e9 });
  await sessions.start();
  await watcher.start();
  return {
    env,
    sessions,
    reader,
    watcher,
    async step() {
      await sessions.scan();
      await watcher.pollOnce();
    },
  };
}

async function stopRig(r: Rig): Promise<void> {
  await r.watcher.stop();
  await r.sessions.stop();
}

const DENIED =
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: Deleting the build folder is destructive. If you have a reason, ask the user.';

describe('transcript watcher: session state from the tail', () => {
  let env: SourceEnv;
  let r: Rig;
  beforeEach(async () => {
    env = await sourceEnv();
    r = await rig(env);
  });
  afterEach(async () => {
    await stopRig(r);
    await env.cleanup();
  });

  it('publishes now, lastReply, mode, away and the transcript path for live sessions', () => {
    const s = env.ctx.store.getState().sessions;
    expect(s[SID.idle]).toMatchObject({
      transcriptPath: env.home.session(SID.idle).transcriptPath,
      mode: 'default',
      lastReply: { text: 'Changelog updated and version bumped.' },
      away: 'Fixed the synthetic tests and updated the changelog.',
      now: { kind: 'said' },
    });
    expect(s[SID.busy]?.now).toEqual({ kind: 'tool', tool: 'Bash', text: 'Bash · Run tests' });
    expect(s[SID.private]?.transcriptPath).toBe(env.home.session(SID.private).transcriptPath);
  });

  it('drops a stale reply as soon as a new prompt lands', async () => {
    const cwd = env.home.session(SID.idle).cwd;
    await env.home.appendTranscript(SID.idle, [userPrompt(at(env.ctx, SID.idle, cwd), 'next thing please')]);
    await r.step();
    const s = env.ctx.store.getState().sessions[SID.idle];
    expect(s?.lastReply).toBeUndefined();
    expect(s?.now).toEqual({ kind: 'prompt', text: 'next thing please' });
  });

  it('does not re-emit when nothing changed', async () => {
    env.events.clear();
    await r.step();
    await r.step();
    expect(env.events.all).toEqual([]);
  });
});

describe('transcript watcher: Done without hooks', () => {
  let env: SourceEnv;
  let r: Rig;
  beforeEach(async () => {
    env = await sourceEnv();
    r = await rig(env);
  });
  afterEach(async () => {
    await stopRig(r);
    await env.cleanup();
  });

  const setStatus = (sid: string, status: string, offsetMs = 0) =>
    env.home.updateSessionFile(sid, { status, statusUpdatedAt: env.ctx.clock.now() + offsetMs });

  it('waits for the final reply when the session file says idle before the transcript is flushed', async () => {
    const cwd = env.home.session(SID.busy).cwd;
    env.ctx.clock.advance(5000);
    await setStatus(SID.busy, 'idle');
    await r.step();
    expect(env.events.of('session.done')).toEqual([]); // idle seen, but not quiet for 1 s yet
    env.ctx.clock.advance(300);
    await env.home.appendTranscript(SID.busy, [assistantText(at(env.ctx, SID.busy, cwd), 'All done: the login form works.')]);
    await r.step();
    expect(env.events.of('session.done')).toEqual([]);
    env.ctx.clock.advance(1100);
    await r.step();
    const done = env.events.of('session.done', SID.busy);
    expect(done).toHaveLength(1);
    expect(done[0]?.data.lastReply?.text).toBe('All done: the login form works.');
    expect(done[0]?.account).toBe(1);
    expect(env.ctx.store.getState().sessions[SID.busy]?.lastReply?.text).toBe('All done: the login form works.');
    env.ctx.clock.advance(5000);
    await r.step();
    expect(env.events.of('session.done')).toHaveLength(1);
  });

  it('never reports the previous turn’s reply for a turn that ended without one', async () => {
    const cwd = env.home.session(SID.idle).cwd;
    env.ctx.clock.advance(2000);
    await env.home.appendTranscript(SID.idle, [userPrompt(at(env.ctx, SID.idle, cwd), 'refactor the parser')]);
    await setStatus(SID.idle, 'busy');
    await r.step();
    env.ctx.clock.advance(2000);
    await env.home.appendTranscript(SID.idle, [userPrompt(at(env.ctx, SID.idle, cwd), '[Request interrupted by user]')]);
    await setStatus(SID.idle, 'idle');
    await r.step();
    env.ctx.clock.advance(5000);
    await r.step();
    expect(env.events.of('session.done')).toEqual([]);
    expect(env.ctx.store.getState().sessions[SID.idle]?.lastReply).toBeUndefined();
  });

  it('catches a turn shorter than the poll (never seen working)', async () => {
    const cwd = env.home.session(SID.idle).cwd;
    env.ctx.clock.advance(3000);
    await env.home.appendTranscript(SID.idle, [
      userPrompt(at(env.ctx, SID.idle, cwd), 'what is 2+2?'),
      assistantText(at(env.ctx, SID.idle, cwd, 500), '4'),
    ]);
    await setStatus(SID.idle, 'idle', 800);
    await r.step();
    expect(env.ctx.store.getState().sessions[SID.idle]?.status).toBe('idle');
    env.ctx.clock.advance(1200);
    await r.step();
    const done = env.events.of('session.done', SID.idle);
    expect(done).toHaveLength(1);
    expect(done[0]?.data.lastReply?.text).toBe('4');
  });

  it('says nothing about turns that ended before it started', async () => {
    env.ctx.clock.advance(10_000);
    await r.step();
    await r.step();
    expect(env.events.of('session.done')).toEqual([]);
  });

  it('leaves Done to the hooks bridge when the status comes from hooks', async () => {
    const cwd = env.home.session(SID.busy).cwd;
    env.ctx.clock.advance(5000);
    await env.home.appendTranscript(SID.busy, [assistantText(at(env.ctx, SID.busy, cwd), 'Finished.')]);
    env.ctx.store.emit({
      type: 'session.updated',
      sid: SID.busy,
      data: { patch: { status: 'idle', statusSource: 'hook', statusSince: env.ctx.clock.iso(), statusAt: env.ctx.clock.iso() } },
    });
    await r.step();
    env.ctx.clock.advance(2000);
    await r.step();
    expect(env.events.of('session.done')).toEqual([]);
  });

  it('stands down when someone else (the Stop hook) already reported the turn', async () => {
    const cwd = env.home.session(SID.busy).cwd;
    env.ctx.clock.advance(5000);
    await env.home.appendTranscript(SID.busy, [assistantText(at(env.ctx, SID.busy, cwd), 'Finished.')]);
    await setStatus(SID.busy, 'idle');
    await r.step();
    env.ctx.store.emit({ type: 'session.done', sid: SID.busy, data: { lastReply: { text: 'Finished.', at: env.ctx.clock.iso() } } });
    env.ctx.clock.advance(2000);
    await r.step();
    expect(env.events.of('session.done')).toHaveLength(1); // only the hook's
  });

  it('is quiet when the turn stopped on an API error (the alert covers it)', async () => {
    const cwd = env.home.session(SID.busy).cwd;
    env.ctx.clock.advance(5000);
    await env.home.appendTranscript(SID.busy, [
      assistantText(at(env.ctx, SID.busy, cwd), 'Working on it.'),
      apiError(at(env.ctx, SID.busy, cwd, 100), 'API Error: Rate limit reached', true),
    ]);
    await setStatus(SID.busy, 'idle', 200);
    await r.step();
    env.ctx.clock.advance(2000);
    await r.step();
    expect(env.events.of('session.done')).toEqual([]);
    expect(env.events.of('alert.limit', SID.busy)).toHaveLength(1);
    expect(env.ctx.store.getState().sessions[SID.busy]?.errorLast).toBe('API Error: Rate limit reached');
  });
});

describe('transcript watcher: alerts', () => {
  let env: SourceEnv;
  let r: Rig;
  beforeEach(async () => {
    env = await sourceEnv();
    r = await rig(env);
  });
  afterEach(async () => {
    await stopRig(r);
    await env.cleanup();
  });

  it('reports blocked, rejected, limit and API error alerts with what and why', async () => {
    const sid = SID.busy;
    const cwd = env.home.session(sid).cwd;
    const c = (ms = 0) => at(env.ctx, sid, cwd, ms);
    await env.home.appendTranscript(sid, [
      assistantToolUse(c(), 'Bash', { command: 'rm -rf build' }, 'toolu_rm'),
      toolResult(c(1), 'toolu_rm', DENIED, true),
      assistantToolUse(c(2), 'Bash', { command: 'git push --force' }, 'toolu_push'),
      toolResult(c(3), 'toolu_push', 'Permission to use Bash with command git push --force has been denied.', true),
      assistantToolUse(c(4), 'Write', { file_path: '/w/a/notes.md' }, 'toolu_w'),
      toolResult(
        c(5),
        'toolu_w',
        "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nwrite it to docs/ instead",
        true,
      ),
      toolResult(c(6), 'toolu_w', 'File does not exist.', true), // an ordinary tool error: not an alert
      apiError(c(7), 'API Error: Rate limit reached', true),
      apiError(c(8), 'API Error: 529 overloaded'),
      apiError(c(60_000), 'API Error: 529 overloaded'), // the same error a minute later: deduped
    ]);
    await r.step();
    const blocked = env.events.of('alert.blocked', sid).map((e) => e.data.alert);
    expect(blocked.map((a) => [a.what, a.why])).toEqual([
      ['auto mode: Bash · rm -rf build', 'Deleting the build folder is destructive'],
      ['deny rule: Bash · git push --force', undefined],
    ]);
    expect(blocked[0]).toMatchObject({ sid, account: 1, label: 'Blocked · alpha-app · add login form', kind: 'blocked' });
    const rejected = env.events.of('alert.rejected', sid).map((e) => e.data.alert);
    expect(rejected.map((a) => [a.what, a.why])).toEqual([['you rejected: Write · notes.md', 'write it to docs/ instead']]);
    expect(env.events.of('alert.limit', sid).map((e) => e.data.alert.why)).toEqual(['API Error: Rate limit reached']);
    expect(env.events.of('alert.error', sid).map((e) => e.data.alert.why)).toEqual(['API Error: 529 overloaded']);
    expect(env.ctx.store.getState().alerts).toHaveLength(5);
  });

  it('backfills at most 256 KB and only the last hour, and never repeats an alert after a restart', async () => {
    const sid = SID.idle;
    const cwd = env.home.session(sid).cwd;
    const old = (ms: number) => at(env.ctx, sid, cwd, ms);
    await stopRig(r);
    const filler: Entry[] = Array.from({ length: 40 }, (_, i) =>
      toolResult(old(-30_000 + i), `toolu_f${i}`, 'q'.repeat(8 * 1024)),
    );
    await env.home.appendTranscript(sid, [
      apiError(old(-60_000), 'API Error: too far back in the file', true),
      ...filler, // > 256 KB of noise
      apiError(old(-2 * 3600_000), 'API Error: two hours old'),
      apiError(old(-10_000), 'API Error: recent'),
    ]);
    env.events.clear();
    r = await rig(env);
    expect(env.events.of('alert.limit')).toEqual([]);
    expect(env.events.of('alert.error').map((e) => e.data.alert.why)).toEqual(['API Error: recent']);

    // a restart with the same database: the backfill finds the same alert and stays quiet
    await stopRig(r);
    env.events.clear();
    r = await rig(env);
    expect(env.events.of('alert.error')).toEqual([]);
  });

  it('reads alerts from subagent transcripts too', async () => {
    const sid = SID.busy;
    const s = env.home.session(sid);
    const sub = join(dirname(s.transcriptPath), sid, 'subagents', 'agent-a1.jsonl');
    await mkdir(dirname(sub), { recursive: true });
    await writeFile(sub, toJsonl([apiError({ ...at(env.ctx, sid, s.cwd), isSidechain: true }, 'API Error: Rate limit reached', true)]));
    await r.step();
    expect(env.events.of('alert.limit', sid)).toEqual([]); // subagent folders are listed every 20 s
    env.ctx.clock.advance(20_000);
    await r.step();
    expect(env.events.of('alert.limit', sid)).toHaveLength(1);
    await appendFile(sub, toJsonl([apiError({ ...at(env.ctx, sid, s.cwd, 700_000), isSidechain: true }, 'API Error: 500', false)]));
    await r.step();
    expect(env.events.of('alert.error', sid)).toEqual([]); // known subagent files are checked every 5 s
    env.ctx.clock.advance(5000);
    await r.step();
    expect(env.events.of('alert.error', sid)).toHaveLength(1);
  });
});

describe('transcript watcher: lifecycle', () => {
  it('stop() clears its timer, and the factory is typed for the integration step', async () => {
    const env = await sourceEnv();
    try {
      const sessions = createClaudeFilesSource(env.ctx, { watch: false });
      const transcripts = createFileTranscriptReader(env.ctx);
      const w = createTranscriptWatcher(env.ctx, { sessions, transcripts });
      await sessions.start();
      await w.start();
      await w.stop();
      await sessions.stop();
      expect(env.ctx.clock.pending()).toBe(0);
    } finally {
      await env.cleanup();
    }
  });
});
