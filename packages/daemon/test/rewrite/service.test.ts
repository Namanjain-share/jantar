/**
 * The Rewrite job flow (U6): queued -> writing -> ready | failed |
 * cancelled, then sent; texts only in memory and only for the owner, gone
 * at sent, cancel and 30 min after the run; origins computed from hashes;
 * limits; the audit and run rows; no text in any event, row or log.
 */
import { describe, expect, it, vi } from 'vitest';
import { REWRITE_TTL_MS, RewriteJobSchema } from '@jantar/protocol';
import type { Actor, ExecResult } from '../../src/contracts.js';
import { sha256Hex } from '../../src/core/hash.js';
import { buildRewriteService, FAILURE_REASON, REWRITE_OFF_REASON, TOO_LONG_REASON } from '../../src/rewrite/service.js';
import { MAX_PROMPT_CHARS } from '../../src/writer/text.js';
import { makeCard } from '../api/fakes.js';
import { claudeJson, hangUntilAborted, makeRig, progress, runCalls, start, untilState, MARKER, OTHER_PHONE, PHONE, SID, type Rig } from './helpers.js';

const CLI: Actor = { kind: 'cli' };

describe('submit', () => {
  it('answers at once with the queued job; the run writes it and it ends ready', async () => {
    const rig = makeRig({ answer: () => ({ stdout: claudeJson('Run the tests for the daemon package.') }) });
    try {
      const r = await rig.svc.submit({ sid: SID, text: '  run the tests for the daemon package  ' }, PHONE);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.job).toMatchObject({
        sid: SID,
        deviceId: 'dev-phone',
        state: 'queued',
        model: 'opus',
        input: { hash: sha256Hex('run the tests for the daemon package'), length: 36 },
      });
      expect(r.job.id.length).toBeGreaterThan(30);
      const d = await untilState(rig, r.job.id, ['ready']);
      expect(d).toMatchObject({ state: 'ready', input: 'run the tests for the daemon package', prompt: 'Run the tests for the daemon package.' });
      expect(d.job.prompt).toEqual({
        hash: sha256Hex('Run the tests for the daemon package.'),
        length: 37,
        flags: { expanded: false, newTokens: 0, leading: null, preface: false },
      });
      expect(d.job.expiresAt).toBe(rig.ctx.clock.iso(rig.ctx.clock.now() + REWRITE_TTL_MS));
      expect(progress(rig).filter((j) => j.id === r.job.id).map((j) => j.state)).toEqual(['queued', 'writing', 'writing', 'ready']);
      for (const j of progress(rig)) RewriteJobSchema.parse(j);
    } finally {
      await rig.close();
    }
  });

  it('refuses: Rewrite off, an unknown session, nothing to rewrite, too long', async () => {
    const off = makeRig({ settings: { rewrite: { enabled: false } } });
    expect(await off.svc.submit({ sid: SID, text: 'x' }, PHONE)).toEqual({ ok: false, code: 'refused', reason: REWRITE_OFF_REASON });
    await off.close();
    const rig = makeRig();
    try {
      expect(await rig.svc.submit({ sid: 'nope', text: 'x' }, PHONE)).toMatchObject({ ok: false, code: 'not_found' });
      expect(await rig.svc.submit({ sid: SID, text: ' \n ' }, PHONE)).toMatchObject({ ok: false, code: 'refused' });
      expect(await rig.svc.submit({ sid: SID, text: 'x'.repeat(8_001) }, PHONE)).toMatchObject({ ok: false, code: 'refused' });
      expect(rig.exec.calls).toHaveLength(0);
      expect(progress(rig)).toEqual([]);
    } finally {
      await rig.close();
    }
  });

  it('at most two runs at once; the rest wait queued', async () => {
    const rig = makeRig({ answer: hangUntilAborted, svc: { maxActivePerActor: 10 } });
    try {
      const jobs = [await start(rig, 'a'), await start(rig, 'b'), await start(rig, 'c')];
      await untilState(rig, jobs[1]!.id, ['writing']);
      await new Promise((r) => setTimeout(r, 20));
      expect(runCalls(rig)).toHaveLength(2);
      expect(rig.svc.get(jobs[2]!.id, PHONE)?.state).toBe('queued');
      rig.svc.cancel(jobs[0]!.id, PHONE);
      await untilState(rig, jobs[2]!.id, ['writing']);
      expect(runCalls(rig)).toHaveLength(3);
    } finally {
      await rig.close();
    }
  });

  it('each device has at most four jobs unfinished', async () => {
    const rig = makeRig({ answer: hangUntilAborted });
    try {
      for (const t of ['a', 'b', 'c', 'd']) await start(rig, t);
      expect(await rig.svc.submit({ sid: SID, text: 'e' }, PHONE)).toMatchObject({ ok: false, code: 'rate_limited' });
      expect((await rig.svc.submit({ sid: SID, text: 'e' }, OTHER_PHONE)).ok).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it('the guards flag the written prompt (R7): new tokens, expanded, leading bang, preface', async () => {
    const rig = makeRig({
      answer: (call) => {
        const said = String(call.opts.input);
        if (said.includes('invent')) return { stdout: claudeJson('Here is the prompt: Fix it. Also update `src/new-file.ts` and add tests.') };
        if (said.includes('bang')) return { stdout: claudeJson('!rm -rf dist') };
        return { stdout: claudeJson(`Sure! Here's how it works. ${'It does many things. '.repeat(40)}`) };
      },
    });
    try {
      const inv = await untilState(rig, (await start(rig, 'invent nothing please')).id, ['ready']);
      expect(inv.prompt).toBe('Fix it. Also update `src/new-file.ts` and add tests.');
      expect(inv.job.prompt?.flags).toEqual({ expanded: false, newTokens: 1, leading: null, preface: true });
      expect(inv.newTokens).toEqual(['src/new-file.ts']);
      const bang = await untilState(rig, (await start(rig, 'bang')).id, ['ready']);
      expect(bang.job.prompt?.flags.leading).toBe('bang');
      const answer = await untilState(rig, (await start(rig, 'what does it do')).id, ['ready']);
      expect(answer.job.prompt?.flags.expanded).toBe(true);
      expect(answer.newTokens).toBeUndefined();
    } finally {
      await rig.close();
    }
  });

  it('tokens from the open card and the target the run was given are not new', async () => {
    const rig = makeRig({ answer: () => ({ stdout: claudeJson('In /synthetic/home/projects/demo-app, deny `rm -rf dist` and run `pnpm lint` instead.') }) });
    try {
      const card = makeCard({ input: { command: 'rm -rf dist' } });
      rig.ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });
      const d = await untilState(rig, (await start(rig, 'say no to that and lint instead')).id, ['ready']);
      expect(d.newTokens).toEqual(['pnpm lint']);
      expect(d.job.prompt?.flags.newTokens).toBe(1);
    } finally {
      await rig.close();
    }
  });

  it('an empty result fails "empty"; a prompt over 16,000 chars fails with a fixed sentence (Send never meets a 400)', async () => {
    const rig = makeRig({ answer: (call) => ({ stdout: claudeJson(String(call.opts.input).includes('long') ? 'w'.repeat(MAX_PROMPT_CHARS + 1) : '  ') }) });
    try {
      const empty = await untilState(rig, (await start(rig, 'umm haan')).id, ['failed']);
      expect(empty.job).toMatchObject({ failure: 'empty', reason: FAILURE_REASON.empty });
      const long = await untilState(rig, (await start(rig, 'long one')).id, ['failed']);
      expect(long.job).toMatchObject({ failure: 'failed', reason: TOO_LONG_REASON });
      expect(rig.ctx.db.rewriteRuns.list().map((r) => [r.ok, r.outcome]).sort()).toEqual([
        [false, 'empty'],
        [false, 'failed'],
      ]);
      expect(long.prompt).toBeUndefined();
      expect(long.input).toBe('long one');
    } finally {
      await rig.close();
    }
    const exact = makeRig({ answer: () => ({ stdout: claudeJson('w'.repeat(MAX_PROMPT_CHARS)) }) });
    try {
      const d = await untilState(exact, (await start(exact, 'x')).id, ['ready']);
      expect(d.prompt?.length).toBe(MAX_PROMPT_CHARS);
    } finally {
      await exact.close();
    }
  });
});

describe('flag drift with runs in flight', () => {
  it('two runs refused at once both retry without the option and end ready, with one alert', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const rig = makeRig({
      answer: async (call): Promise<Partial<ExecResult>> => {
        if (!call.args.includes('--permission-prompts')) return { stdout: claudeJson('Run the tests.') };
        await gate;
        return { code: 1, stderr: "error: unknown option '--permission-prompts'" };
      },
    });
    try {
      const a = await start(rig, 'one');
      const b = await start(rig, 'two');
      await vi.waitFor(() => expect(runCalls(rig)).toHaveLength(2));
      release();
      const [da, db] = await Promise.all([untilState(rig, a.id, ['ready', 'failed']), untilState(rig, b.id, ['ready', 'failed'])]);
      expect([da.state, db.state]).toEqual(['ready', 'ready']);
      expect(runCalls(rig).map((c) => c.args.includes('--permission-prompts'))).toEqual([true, true, false, false]);
      expect((rig.ctx.store.getState().alerts ?? []).filter((x) => x.label.startsWith('Rewrite'))).toHaveLength(1);
    } finally {
      await rig.close();
    }
  });
});

describe('Rewrite turned off at the Mac', () => {
  it('cancels every queued and writing job (runs killed, texts dropped); ready jobs stay', async () => {
    const rig = makeRig({ answer: (call) => (String(call.opts.input).includes('quick') ? { stdout: claudeJson('Done.') } : hangUntilAborted(call)), svc: { maxRunning: 1 } });
    try {
      await rig.svc.start();
      const done = await start(rig, 'quick one');
      await untilState(rig, done.id, ['ready']);
      const writing = await start(rig, 'slow one');
      const queued = await start(rig, 'slow two');
      await vi.waitFor(() => expect(runCalls(rig)).toHaveLength(2));
      await rig.ctx.settings.patch({ rewrite: { enabled: false } });
      expect(runCalls(rig)[1]?.opts.signal?.aborted).toBe(true);
      for (const j of [writing, queued]) {
        const d = rig.svc.get(j.id, PHONE);
        expect(d?.state).toBe('cancelled');
        expect(d?.input).toBeUndefined();
      }
      expect(rig.svc.get(done.id, PHONE)?.state).toBe('ready');
      await new Promise((r) => setTimeout(r, 20));
      expect(runCalls(rig)).toHaveLength(2);
      expect(rig.svc.get(writing.id, PHONE)?.state).toBe('cancelled');
    } finally {
      await rig.close();
    }
  });

  it('a queued job whose turn comes while Rewrite is off never runs', async () => {
    const rig = makeRig({ answer: hangUntilAborted, svc: { maxRunning: 1 } });
    try {
      // No start(): no settings listener, so only the check at the run's start stops it.
      const a = await start(rig, 'a');
      const b = await start(rig, 'b');
      await vi.waitFor(() => expect(runCalls(rig)).toHaveLength(1));
      await rig.ctx.settings.patch({ rewrite: { enabled: false } });
      rig.svc.cancel(a.id, PHONE);
      await vi.waitFor(() => expect(rig.svc.get(b.id, PHONE)?.state).toBe('cancelled'));
      expect(runCalls(rig)).toHaveLength(1);
    } finally {
      await rig.close();
    }
  });
});

describe('owner only (V5)', () => {
  it('V5: only the device that started a job can read or cancel it; anyone else gets null (the API: 404)', async () => {
    const rig = makeRig();
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['ready']);
      expect(rig.svc.get(job.id, OTHER_PHONE)).toBeNull();
      expect(rig.svc.get(job.id, CLI)).toBeNull();
      expect(rig.svc.cancel(job.id, OTHER_PHONE)).toBeNull();
      expect(rig.svc.originFor(job.id, SID, sha256Hex('run the tests'), OTHER_PHONE)).toBeNull();
      expect(rig.svc.get(job.id, PHONE)?.state).toBe('ready');
      expect(rig.svc.get('no-such-job', PHONE)).toBeNull();
    } finally {
      await rig.close();
    }
  });
});

describe('origin (R10) and sending', () => {
  it('R10: the origin comes from the hashes: the prompt as written, what was said, or anything else is edited', async () => {
    const rig = makeRig({ answer: () => ({ stdout: claudeJson('Run the tests.') }) });
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['ready']);
      // Each origin claims the job; releasing it (the writer refused) lets the next one ask.
      const origin = (text: string, sid = SID) => {
        const o = rig.svc.originFor(job.id, sid, sha256Hex(text), PHONE);
        rig.svc.releaseOrigin(job.id);
        return o;
      };
      expect(origin('Run the tests.')).toBe('rewrite');
      expect(origin('run the tests')).toBe('rewrite-raw');
      expect(origin('Run the tests. And lint.')).toBe('rewrite-edited');
      expect(origin('Run the tests.', 'other-session')).toBeNull();
    } finally {
      await rig.close();
    }
  });

  it('an origin claims the job: a second send gets "claimed" until markSent or releaseOrigin', async () => {
    const rig = makeRig({ answer: () => ({ stdout: claudeJson('Run the tests.') }) });
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['ready']);
      const events = progress(rig).length;
      expect(rig.svc.originFor(job.id, SID, sha256Hex('Run the tests.'), PHONE)).toBe('rewrite');
      // Whatever the text, while the first send is on its way.
      expect(rig.svc.originFor(job.id, SID, sha256Hex('Run the tests.'), PHONE)).toBe('claimed');
      expect(rig.svc.originFor(job.id, SID, sha256Hex('run the tests'), PHONE)).toBe('claimed');
      // Someone else's or another session's send still finds nothing.
      expect(rig.svc.originFor(job.id, SID, sha256Hex('Run the tests.'), OTHER_PHONE)).toBeNull();
      expect(rig.svc.originFor(job.id, 'other-session', sha256Hex('Run the tests.'), PHONE)).toBeNull();
      // The claim is not a state: the job reads ready with its texts, and no event went out.
      expect(rig.svc.get(job.id, PHONE)).toMatchObject({ state: 'ready', prompt: 'Run the tests.' });
      expect(progress(rig)).toHaveLength(events);
      // A Discard while the prompt is being typed cancels nothing: the job ends sent.
      expect(rig.svc.cancel(job.id, PHONE)).toBe('claimed');
      expect(rig.svc.get(job.id, PHONE)).toMatchObject({ state: 'ready', prompt: 'Run the tests.' });

      // The writer refused: nothing typed, the job can be sent again (edited, this time).
      rig.svc.releaseOrigin(job.id);
      expect(rig.svc.originFor(job.id, SID, sha256Hex('Run the tests. And lint.'), PHONE)).toBe('rewrite-edited');
      rig.svc.markSent(job.id, 'send-1');
      expect(rig.svc.get(job.id, PHONE)?.job).toMatchObject({ state: 'sent', sendJobId: 'send-1' });
      expect(rig.svc.originFor(job.id, SID, sha256Hex('Run the tests.'), PHONE)).toBeNull();
      // A release after the send changes nothing; one for a job that is gone is ignored.
      rig.svc.releaseOrigin(job.id);
      expect(rig.svc.originFor(job.id, SID, sha256Hex('Run the tests.'), PHONE)).toBeNull();
      expect(() => rig.svc.releaseOrigin('no-such-job')).not.toThrow();
    } finally {
      await rig.close();
    }
  });

  it('markSent: state sent with the send job, texts dropped, and the job can no longer be sent', async () => {
    const rig = makeRig();
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['ready']);
      rig.svc.markSent(job.id, 'send-1');
      const d = rig.svc.get(job.id, PHONE);
      expect(d).toMatchObject({ state: 'sent', job: { state: 'sent', sendJobId: 'send-1' } });
      expect(d?.input).toBeUndefined();
      expect(d?.prompt).toBeUndefined();
      expect(rig.svc.originFor(job.id, SID, sha256Hex('run the tests'), PHONE)).toBeNull();
      rig.svc.markSent(job.id, 'send-2');
      expect(rig.svc.get(job.id, PHONE)?.job.sendJobId).toBe('send-1');
    } finally {
      await rig.close();
    }
  });

  it('only a ready job gives an origin: queued, writing, failed and cancelled jobs are null (the send is a 404)', async () => {
    const rig = makeRig({ answer: hangUntilAborted, svc: { maxRunning: 1 } });
    try {
      const writing = await start(rig, 'run the tests');
      const queued = await start(rig, 'lint it');
      await vi.waitFor(() => expect(runCalls(rig)).toHaveLength(1));
      expect(rig.svc.originFor(writing.id, SID, sha256Hex('run the tests'), PHONE)).toBeNull();
      expect(rig.svc.originFor(queued.id, SID, sha256Hex('lint it'), PHONE)).toBeNull();
    } finally {
      await rig.close();
    }
    const failing = makeRig({ accounts: [] });
    try {
      const job = await start(failing, 'run the tests');
      await untilState(failing, job.id, ['failed']);
      expect(failing.svc.originFor(job.id, SID, sha256Hex('run the tests'), PHONE)).toBeNull();
      // A failed job is final: markSent changes nothing and emits nothing.
      const before = progress(failing).length;
      failing.svc.markSent(job.id, 'send-1');
      expect(failing.svc.get(job.id, PHONE)).toMatchObject({ state: 'failed', input: 'run the tests' });
      expect(progress(failing)).toHaveLength(before);
    } finally {
      await failing.close();
    }
  });

  it('markSent on a job still writing (not reached through the API) kills its run and the job ends sent', async () => {
    const rig = makeRig({ answer: hangUntilAborted });
    try {
      const job = await start(rig, 'run the tests');
      await vi.waitFor(() => expect(runCalls(rig)).toHaveLength(1));
      rig.svc.markSent(job.id, 'send-1');
      expect(runCalls(rig)[0]?.opts.signal?.aborted).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(rig.svc.get(job.id, PHONE)).toMatchObject({ state: 'sent', job: { sendJobId: 'send-1' } });
      expect(rig.ctx.db.audit.list().find((e) => e.action === 'rewrite.run')?.params).toMatchObject({ outcome: 'sent' });
    } finally {
      await rig.close();
    }
  });
});

describe('texts go (V8)', () => {
  it('V8: cancel drops the texts at once; the job reads cancelled and cannot be sent', async () => {
    const rig = makeRig();
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['ready']);
      expect(rig.svc.cancel(job.id, PHONE)).toMatchObject({ state: 'cancelled' });
      const d = rig.svc.get(job.id, PHONE);
      expect(d?.state).toBe('cancelled');
      expect(d?.input).toBeUndefined();
      expect(d?.prompt).toBeUndefined();
      expect(rig.svc.originFor(job.id, SID, sha256Hex('run the tests'), PHONE)).toBeNull();
      // Cancelling again changes nothing.
      expect(rig.svc.cancel(job.id, PHONE)).toMatchObject({ state: 'cancelled' });
    } finally {
      await rig.close();
    }
  });

  it('V8: 30 min after the run ended, the texts and the job are gone (get and send: null)', async () => {
    const rig = makeRig();
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['ready']);
      rig.ctx.clock.advance(REWRITE_TTL_MS - 1);
      expect(rig.svc.get(job.id, PHONE)?.prompt).toBe('Rewritten: run the tests');
      rig.ctx.clock.advance(1);
      expect(rig.svc.get(job.id, PHONE)).toBeNull();
      expect(rig.svc.originFor(job.id, SID, sha256Hex('run the tests'), PHONE)).toBeNull();
    } finally {
      await rig.close();
    }
  });

  it('a failed job is final: cancel drops its texts but leaves its state', async () => {
    const rig = makeRig({ accounts: [] });
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['failed']);
      expect(rig.svc.cancel(job.id, PHONE)).toMatchObject({ state: 'failed' });
      expect(rig.svc.get(job.id, PHONE)?.input).toBeUndefined();
    } finally {
      await rig.close();
    }
  });

  it('cancelling a queued job means it never runs', async () => {
    const rig = makeRig({ answer: hangUntilAborted, svc: { maxRunning: 1 } });
    try {
      const a = await start(rig, 'a');
      const b = await start(rig, 'b');
      expect(rig.svc.cancel(b.id, PHONE)).toMatchObject({ state: 'cancelled' });
      await vi.waitFor(() => expect(runCalls(rig)).toHaveLength(1));
      rig.svc.cancel(a.id, PHONE);
      await new Promise((r) => setTimeout(r, 20));
      expect(runCalls(rig)).toHaveLength(1);
      expect(progress(rig).filter((j) => j.id === b.id).map((j) => j.state)).toEqual(['queued', 'cancelled']);
    } finally {
      await rig.close();
    }
  });
});

describe('records and privacy (V6, A1)', () => {
  it('one rewrite.run audit row per job and one rewrite_runs row per run, with ids, model, account, ms and outcome only', async () => {
    const rig = makeRig();
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['ready']);
      const rows = rig.ctx.db.audit.list().filter((e) => e.action === 'rewrite.run');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: 'device:dev-phone',
        target: job.id,
        result: 'ok',
        params: { sid: SID, jobId: job.id, account: 7, model: 'opus', outcome: 'ready' },
      });
      expect(Object.keys(rows[0]?.params as object).sort()).toEqual(['account', 'jobId', 'model', 'ms', 'outcome', 'sid']);
      expect(rig.ctx.db.rewriteRuns.list()).toEqual([
        expect.objectContaining({ account: 7, model: 'opus', ok: true, inputTokens: 1500, outputTokens: 40, promptVersion: 'v1', outcome: 'ready' }),
      ]);
    } finally {
      await rig.close();
    }
  });

  it('RewriteJob.ms is the run itself (spawn to result); the audit row has the whole writing time', async () => {
    const rig: Rig = makeRig({
      settings: { rewrite: { enabled: true }, launch: { preLaunchArgv: ['/usr/bin/python3', '-I', '/synthetic/adopt.py', 'adopt', '{n}'] } },
      other: () => {
        rig.ctx.clock.advance(5_000);
        return { code: 0 };
      },
      answer: () => {
        rig.ctx.clock.advance(1_500);
        return { stdout: claudeJson('Run the tests.') };
      },
    });
    try {
      const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['ready']);
      expect(d.job.ms).toBe(1_500);
      expect(rig.ctx.db.rewriteRuns.list()[0]?.ms).toBe(1_500);
      expect(rig.ctx.db.audit.list().find((e) => e.action === 'rewrite.run')?.params).toMatchObject({ ms: 6_500 });
    } finally {
      await rig.close();
    }
    // No run started: no ms on the job.
    const none = makeRig({ accounts: [] });
    try {
      const d = await untilState(none, (await start(none, 'run the tests')).id, ['failed']);
      expect(d.job.ms).toBeUndefined();
    } finally {
      await none.close();
    }
  });

  it('V6/A1: no event, audit row, run row or log line carries what was said or the written prompt', async () => {
    const rig = makeRig({ answer: (call) => ({ stdout: claudeJson(`Rename the ${MARKER} helper. ${String(call.opts.input).length}`) }) });
    try {
      const ok = await start(rig, `rename the ${MARKER} helper`);
      await untilState(rig, ok.id, ['ready']);
      const failing = makeRig({ answer: () => ({ stdout: claudeJson(`${MARKER} Invalid API key`, { is_error: true }) }) });
      try {
        const bad = await start(failing, `rename the ${MARKER} helper`);
        await untilState(failing, bad.id, ['failed']);
        for (const r of [rig, failing]) {
          const replay = r.ctx.store.replay(0);
          const dump = JSON.stringify([replay, r.ctx.db.audit.list(), r.ctx.db.rewriteRuns.list(), r.ctx.log.records]);
          expect(dump).not.toContain(MARKER);
          expect(dump).not.toContain('rename the');
        }
      } finally {
        await failing.close();
      }
    } finally {
      await rig.close();
    }
  });

  it('jobs belong to their actor: a CLI job is the CLI\'s (deviceId null)', async () => {
    const rig = makeRig();
    try {
      const job = await start(rig, 'run the tests', CLI);
      expect(job.deviceId).toBeNull();
      await untilState(rig, job.id, ['ready'], CLI);
      expect(rig.svc.get(job.id, PHONE)).toBeNull();
    } finally {
      await rig.close();
    }
  });

  it('buildRewriteService (the Factories entry) gives a working service', async () => {
    const rig = makeRig();
    const svc = buildRewriteService(rig.ctx, rig.deps);
    try {
      await svc.start();
      const r = await svc.submit({ sid: SID, text: 'run the tests' }, PHONE);
      expect(r.ok).toBe(true);
      if (r.ok) await vi.waitFor(() => expect(svc.get(r.job.id, PHONE)?.state).toBe('ready'));
    } finally {
      await svc.stop();
      await rig.close();
    }
  });
});
