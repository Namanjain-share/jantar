/**
 * Acceptance gate for the data sources: on a synthetic
 * HOME with three cswap profiles and fake cswap / ps / lsof on PATH, the four
 * sources started in the integration order give every session the right
 * account, drop the reused pid, skip sdk-cli, and leave Claude's, cswap's and
 * ccw's files exactly as they were.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_SIDS, SECRET_MARKER, assistantText } from '@jantar/fixtures';
import { startServices } from '../../src/lifecycle.js';
import { createCcwLegacySource } from '../../src/sources/ccw-legacy.js';
import { createSessionSource } from '../../src/sources/claude-files.js';
import { createUsageSource } from '../../src/sources/cswap.js';
import { createTranscriptReader, createTranscriptWatcher } from '../../src/sources/transcripts.js';
import { SID, at, sourceEnv, type SourceEnv } from './helpers.js';

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const st = await stat(p);
        out[p] = `${st.size}:${st.mtimeMs}:${st.mode}:${createHash('sha256').update(await readFile(p)).digest('hex')}`;
      } else if (e.isSymbolicLink()) out[p] = 'symlink';
    }
  };
  await walk(dir);
  return out;
}

describe('all four sources on a synthetic home', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv({ home: { ccw: true } });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('start in the integration order, publish the right state, and touch nothing they read', async () => {
    const watched = [env.home.paths.claudeHome, env.home.paths.cswapRoot, env.home.paths.ccwDir];
    const before = await Promise.all(watched.map(tree));

    const ccwLegacy = createCcwLegacySource(env.ctx, {});
    const sessions = createSessionSource(env.ctx, {});
    const transcripts = createTranscriptReader(env.ctx, {});
    const transcriptWatcher = createTranscriptWatcher(env.ctx, { sessions, transcripts });
    const usage = createUsageSource(env.ctx, { ccwLegacy });
    const stop = await startServices(
      [
        ['ccwLegacy', ccwLegacy],
        ['sessions', sessions],
        ['transcriptWatcher', transcriptWatcher],
        ['usage', usage],
      ],
      env.ctx.log,
    );

    const state = env.ctx.store.getState();
    expect(Object.keys(state.sessions).sort()).toEqual([...DEFAULT_LIVE_SIDS].sort());
    expect(Object.fromEntries(Object.values(state.sessions).map((s) => [s.sid, s.account]))).toEqual({
      [SID.busy]: 1,
      [SID.idle]: 2,
      [SID.waiting]: 3,
      [SID.private]: 4,
    });
    expect(state.sessions[SID.reused]).toBeUndefined();
    expect(state.sessions[SID.sdk]).toBeUndefined();
    expect(state.sessions[SID.crashed]).toBeUndefined();
    expect(state.sessions[SID.idle]?.lastReply?.text).toBe('Changelog updated and version bumped.');
    expect(state.sessions[SID.private]?.transcriptPath).toBe(env.home.session(SID.private).transcriptPath);
    expect(Object.keys(state.accounts)).toEqual(['1', '2', '3', '4']);
    expect(state.accounts['3']?.held).toBe(true); // ccw's hold list while ccw runs
    expect(JSON.stringify(state)).not.toContain(SECRET_MARKER);
    for (const a of ['alpha@example.com', 'bravo@example.com', 'charlie@example.org', 'delta@example.net']) {
      expect(JSON.stringify(state)).not.toContain(a);
    }

    // ccw's bot is not running here, so ours is the one cswap poller, env scrubbed
    expect(usage.isPolling()).toBe(true);
    const plan = await ccwLegacy.plan();
    expect(plan.source).toBe('ccw-legacy');
    expect(plan.accounts.map((a) => a.id)).toEqual([1, 2, 3, 4]);

    // a turn ends without hooks: Done with the new reply
    const cwd = env.home.session(SID.busy).cwd;
    env.ctx.clock.advance(5000);
    await env.home.updateSessionFile(SID.busy, { status: 'idle', statusUpdatedAt: env.ctx.clock.now() });
    await env.home.appendTranscript(SID.busy, [assistantText(at(env.ctx, SID.busy, cwd), 'Login form done.')]);
    await sessions.scan();
    await (transcriptWatcher as unknown as { pollOnce(): Promise<void> }).pollOnce();
    env.ctx.clock.advance(1500);
    await (transcriptWatcher as unknown as { pollOnce(): Promise<void> }).pollOnce();
    expect(env.events.of('session.done', SID.busy).map((e) => e.data.lastReply?.text)).toEqual(['Login form done.']);

    await stop();
    expect(env.ctx.clock.pending()).toBe(0);

    // read-only: everything we watched is byte-for-byte what the test itself left there
    const after = await Promise.all(watched.map(tree));
    const changedByTest = new Set([env.home.session(SID.busy).file, env.home.session(SID.busy).transcriptPath]);
    for (let i = 0; i < watched.length; i++) {
      const b = before[i] as Record<string, string>;
      const a = after[i] as Record<string, string>;
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      for (const k of Object.keys(b)) if (!changedByTest.has(k)) expect(a[k]).toBe(b[k]);
    }
    // nothing was written under the fake home except our own state dir (which the sources don't use)
    const calls = await env.home.calls('cswap');
    expect(calls.every((c) => c.env.CLAUDE_CONFIG_DIR === undefined)).toBe(true);
  });
});
