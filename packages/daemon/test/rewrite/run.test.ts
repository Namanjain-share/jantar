/**
 * One headless Rewrite run (spec 4.3 "Command", rules R1, R2, R3, R5, R8):
 * the argv, the env, stdin, the run dir, how a result is read, retries,
 * flag drift (only droppable options ever go), adopt, and the timeout.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../src/contracts.js';
import {
  CORE_OPTIONS,
  CSWAP_OPTIONS,
  DROPPABLE_OPTIONS,
  ISOLATION_OPTIONS,
  classifyRun,
  parseResult,
  prepareRunDir,
  refusedOption,
  rewriteArgv,
  rewriteEnv,
} from '../../src/rewrite/run.js';
import { FAILURE_REASON } from '../../src/rewrite/service.js';
import { claudeJson, dictatedOf, hangUntilAborted, makeRig, progress, runCalls, start, untilState, MARKER, PHONE, SID, type Rig } from './helpers.js';

const res = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
  durationMs: 10,
  ...over,
});
const how = { aborted: false, timedOut: false };

describe('argv (R1) and env (R3)', () => {
  const flags = { account: 7, model: 'opus' as const, fallbackModel: 'sonnet' as const, effort: 'low', systemPromptFile: '/h/rewrite/system-v1.md' };

  it('R1: tools, MCP, slash commands, persistence and prompts are all off, with the fixed system prompt file', () => {
    expect(rewriteArgv(flags)).toEqual([
      'run', '--share-history', '7', '--',
      '-p', '--output-format', 'json',
      '--model', 'opus', '--fallback-model', 'sonnet', '--effort', 'low',
      '--max-turns', '1', '--max-budget-usd', '1.00',
      '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--disable-slash-commands',
      '--no-session-persistence', '--setting-sources', 'local', '--settings', '{"disableAllHooks":true}',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--system-prompt-file', '/h/rewrite/system-v1.md',
    ]);
  });

  it('no --fallback-model when it equals the model ("Rewrite with Sonnet")', () => {
    expect(rewriteArgv({ ...flags, model: 'sonnet' })).not.toContain('--fallback-model');
  });

  it('a dropped option leaves the argv with its value and nothing else', () => {
    const full = rewriteArgv(flags);
    const without = rewriteArgv({ ...flags, dropped: new Set(['--permission-prompts']) });
    expect(without).toEqual(full.filter((a, i) => a !== '--permission-prompts' && !(a === 'none' && full[i - 1] === '--permission-prompts')));
    expect(rewriteArgv({ ...flags, dropped: new Set(DROPPABLE_OPTIONS) }).join(' ')).not.toMatch(/--permission-prompts|--effort|--fallback-model|--max-budget-usd/);
  });

  it('U6, R1: an isolation or core option is never dropped, whatever the dropped set says', () => {
    const argv = rewriteArgv({ ...flags, dropped: new Set([...ISOLATION_OPTIONS, ...CORE_OPTIONS, ...CSWAP_OPTIONS]) });
    expect(argv).toEqual(rewriteArgv(flags));
  });

  it('every option in the argv is classified exactly once (cswap, core, droppable or isolation)', () => {
    const groups = [CSWAP_OPTIONS, CORE_OPTIONS, DROPPABLE_OPTIONS, ISOLATION_OPTIONS];
    const options = rewriteArgv(flags).filter((a) => /^--\w/.test(a));
    for (const o of options) expect(groups.filter((g) => g.includes(o)), o).toHaveLength(1);
    // And every isolation option is in the argv.
    for (const o of ISOLATION_OPTIONS) expect(options).toContain(o);
  });

  it('R3: no other login or API key in the env; hooks, CLAUDE.md, memory, git snapshot and background tasks off', () => {
    const env = rewriteEnv({
      HOME: '/h',
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/h/.claude-swap-backup/sessions/2-x',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/x',
      ANTHROPIC_API_KEY: 'sk-synthetic',
      ANTHROPIC_AUTH_TOKEN: 'synthetic',
      CLAUDE_CODE_OAUTH_TOKEN: 'synthetic',
    });
    expect(env).toEqual({
      HOME: '/h',
      PATH: '/usr/bin',
      JANTAR_SKIP_HOOKS: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
  });

  it('R3: the claude the daemon found leads PATH, since cswap runs claude from PATH (launchd has no ~/.local/bin)', () => {
    const launchd = { HOME: '/h', PATH: '/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin' };
    expect(rewriteEnv(launchd, '/h/.local/bin/claude').PATH).toBe('/h/.local/bin:/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    // already there: moved to the front once, not repeated
    expect(rewriteEnv({ PATH: '/usr/bin:/h/.local/bin' }, '/h/.local/bin/claude').PATH).toBe('/h/.local/bin:/usr/bin');
    // no claude found, or not an absolute path: PATH as it was
    expect(rewriteEnv(launchd, null).PATH).toBe(launchd.PATH);
    expect(rewriteEnv(launchd, 'claude').PATH).toBe(launchd.PATH);
  });
});

describe('reading the result', () => {
  it('takes the result object, an array of messages, or the last JSON line', () => {
    expect(parseResult(claudeJson('ok'))?.result).toBe('ok');
    expect(parseResult(JSON.stringify([{ type: 'system' }, { type: 'result', subtype: 'success', result: 'a' }]))?.result).toBe('a');
    expect(parseResult(`{"type":"system"}\n${claudeJson('b')}\n`)?.result).toBe('b');
    expect(parseResult('')).toBeNull();
    expect(parseResult('Invalid API key · Please run /login')).toBeNull();
    expect(parseResult('{"hello":1}')).toBeNull();
  });

  it('R5: is_error, a non-success subtype or a non-string result is never a prompt', () => {
    const auth = claudeJson('Invalid API key · Please run /login', { is_error: true, subtype: 'error_during_execution' });
    expect(classifyRun(res({ stdout: auth, code: 1 }), how)).toEqual({ kind: 'account' });
    expect(classifyRun(res({ stdout: claudeJson('half a prompt', { subtype: 'error_max_turns' }) }), how).kind).toBe('model');
    expect(classifyRun(res({ stdout: claudeJson('x', { is_error: true }) }), how).kind).toBe('model');
    expect(classifyRun(res({ stdout: claudeJson(null) }), how).kind).toBe('model');
    expect(classifyRun(res({ stdout: claudeJson('Claude AI usage limit reached', { is_error: true }) }), how).kind).toBe('account');
  });

  it('a clean result carries the text and the token counts', () => {
    expect(classifyRun(res({ stdout: claudeJson('Run the tests.') }), how)).toEqual({ kind: 'ok', result: 'Run the tests.', inputTokens: 1500, outputTokens: 40 });
  });

  it('no JSON: "unknown option" is flag drift, another exit a startup failure, exit 0 a model failure', () => {
    expect(classifyRun(res({ code: 1, stderr: "error: unknown option '--permission-prompts'" }), how)).toEqual({ kind: 'flags', option: '--permission-prompts' });
    expect(classifyRun(res({ code: 2, stderr: 'profile 7 needs a re-login' }), how)).toEqual({ kind: 'account' });
    expect(classifyRun(res({ code: 0, stdout: 'not json' }), how).kind).toBe('model');
    expect(classifyRun(res({ code: null, spawnError: 'ENOENT' }), how)).toEqual({ kind: 'unavailable' });
  });

  it('flag drift names the refused option only when it is one of ours', () => {
    expect(refusedOption("error: unknown option '--strict-mcp-config'")).toBe('--strict-mcp-config');
    expect(refusedOption('error: unknown option --output-format')).toBe('--output-format');
    expect(refusedOption('cswap: error: unrecognized arguments: --share-history 7')).toBe('--share-history');
    expect(refusedOption("error: unknown option '--not-ours'")).toBeNull();
    expect(refusedOption('error: unknown argument')).toBeNull();
    expect(classifyRun(res({ code: 1, stderr: "error: unknown option '--not-ours'" }), how)).toEqual({ kind: 'flags', option: null });
  });

  it('no JSON: claude missing behind cswap is "unavailable"; a run killed from outside is a model failure, not the account', () => {
    expect(classifyRun(res({ code: 127, stderr: 'cswap: line 88: claude: command not found' }), how)).toEqual({ kind: 'unavailable' });
    expect(classifyRun(res({ code: 1, stderr: "FileNotFoundError: [Errno 2] No such file or directory: 'claude'" }), how)).toEqual({ kind: 'unavailable' });
    expect(classifyRun(res({ code: 1, stderr: 'execvp: No such file or directory: /opt/homebrew/bin/claude' }), how)).toEqual({ kind: 'unavailable' });
    // A missing file of the profile is the account's.
    expect(classifyRun(res({ code: 1, stderr: "No such file or directory: '/h/.claude-swap-backup/sessions/7-x/.credentials.json'" }), how)).toEqual({ kind: 'account' });
    expect(classifyRun(res({ code: null, signal: 'SIGKILL' }), how)).toEqual({ kind: 'model', inputTokens: null, outputTokens: null });
  });

  it('a timeout or an abort wins over whatever was printed', () => {
    expect(classifyRun(res({ stdout: claudeJson('x') }), { aborted: false, timedOut: true })).toEqual({ kind: 'timeout' });
    expect(classifyRun(res({ timedOut: true }), how)).toEqual({ kind: 'timeout' });
    expect(classifyRun(res({ stdout: claudeJson('x') }), { aborted: true, timedOut: false })).toEqual({ kind: 'cancelled' });
  });
});

describe('the run dir', () => {
  it('rewriteDir and work/ are 0700 and the system prompt copy is 0600 with the package text', async () => {
    const rig = makeRig();
    try {
      const paths = rig.ctx.paths;
      const d = await prepareRunDir(paths);
      expect(statSync(paths.rewriteDir).mode & 0o777).toBe(0o700);
      expect(statSync(d.cwd).mode & 0o777).toBe(0o700);
      expect(d.cwd).toBe(join(paths.rewriteDir, 'work'));
      expect(statSync(d.systemPromptFile).mode & 0o777).toBe(0o600);
      const text = readFileSync(d.systemPromptFile, 'utf8');
      expect(text).toBe(readFileSync(join(paths.assetsDir, 'rewrite', 'system-v1.md'), 'utf8'));
      expect(d.workEntries).toBe(0);
      // Appendix A, reworded for dictated text.
      expect(text).toContain('<dictated_text>: what the user said.');
      expect(text).not.toMatch(/voice note|transcript/i);
    } finally {
      await rig.close();
    }
  });
});

describe('a run through the service', () => {
  it('R1, R2: one cswap run on the picked account; the text and context are on stdin only, never in argv', async () => {
    const rig = makeRig();
    try {
      const text = `please rename the ${MARKER} helper in send dot ts`;
      const job = await start(rig, `  ${text}\n`);
      const d = await untilState(rig, job.id, ['ready']);
      const [call] = runCalls(rig);
      expect(rig.exec.calls).toHaveLength(1);
      expect(call?.file).toBe('/fake/bin/cswap');
      expect(call?.args.slice(0, 5)).toEqual(['run', '--share-history', '7', '--', '-p']);
      for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt-file']) {
        expect(call?.args).toContain(flag);
      }
      expect(call?.args.join(' ')).toContain('--tools  --disallowedTools mcp__* --strict-mcp-config');
      expect(call?.args.join(' ')).toContain('--permission-mode dontAsk --permission-prompts none');
      expect(call?.args.at(-1)).toBe(join(rig.ctx.paths.rewriteDir, 'system-v1.md'));
      // R2: stdin carries the context with what was said (trimmed); argv and env do not.
      expect(dictatedOf(call?.opts.input)).toBe(text);
      expect(call?.opts.input).toContain('<target>\nfolder: demo-app');
      expect(JSON.stringify(call?.args)).not.toContain(MARKER);
      expect(JSON.stringify(call?.opts.env)).not.toContain(MARKER);
      expect(call?.opts.cwd).toBe(join(rig.ctx.paths.rewriteDir, 'work'));
      expect(call?.opts.env).toMatchObject({ JANTAR_SKIP_HOOKS: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
      expect(call?.opts.env?.PATH?.split(':')[0]).toBe('/fake/bin'); // bins.claude's dir
      expect(call?.opts.timeoutMs).toBeGreaterThanOrEqual(120_000);
      expect(d.prompt).toBe(`Rewritten: ${text}`);
      expect(d.job).toMatchObject({ state: 'ready', account: 7, model: 'opus', promptVersion: 'v1' });
    } finally {
      await rig.close();
    }
  });

  it('settings pick the model, effort and fallback; a per-request model applies to that run only', async () => {
    const rig = makeRig({ settings: { rewrite: { enabled: true, model: 'sonnet', effort: 'medium', fallbackModel: 'haiku' } } });
    try {
      await untilState(rig, (await start(rig, 'one')).id, ['ready']);
      await untilState(rig, (await start(rig, 'two', PHONE, 'opus')).id, ['ready']);
      const [a, b] = runCalls(rig).map((c) => c.args.join(' '));
      expect(a).toContain('--model sonnet --fallback-model haiku --effort medium');
      expect(b).toContain('--model opus --fallback-model haiku --effort medium');
    } finally {
      await rig.close();
    }
  });

  it('R5: an auth error result is never shown: the account sits out and the next one is tried once', async () => {
    const rig = makeRig({
      answer: (call) =>
        call.args[2] === '7'
          ? { code: 1, stdout: claudeJson('Invalid API key · Please run /login', { is_error: true, subtype: 'error_during_execution' }) }
          : { stdout: claudeJson('Run the tests.') },
    });
    try {
      const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['ready']);
      expect(runCalls(rig).map((c) => c.args[2])).toEqual(['7', '9']);
      expect(d.prompt).toBe('Run the tests.');
      expect(d.job.account).toBe(9);
      // 7 sits out: the next job goes straight to 9.
      await untilState(rig, (await start(rig, 'again')).id, ['ready']);
      expect(runCalls(rig).map((c) => c.args[2])).toEqual(['7', '9', '9']);
      expect(rig.ctx.db.rewriteRuns.list().map((r) => [r.account, r.ok, r.outcome]).sort()).toEqual([
        [7, false, 'failed'],
        [9, true, 'ready'],
        [9, true, 'ready'],
      ]);
    } finally {
      await rig.close();
    }
  });

  it('R5: two account failures in a row end the job failed with a fixed sentence, never the error text', async () => {
    const rig = makeRig({ answer: () => ({ code: 1, stdout: claudeJson('Invalid API key · Please run /login', { is_error: true }) }) });
    try {
      const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['failed']);
      expect(runCalls(rig)).toHaveLength(2);
      expect(d.job).toMatchObject({ failure: 'failed', reason: "The prompt writer couldn't run. Send what you said, or try again." });
      expect(d.prompt).toBeUndefined();
      expect(d.error).toBe(d.job.reason);
      expect(JSON.stringify(d)).not.toContain('Invalid API key');
      expect(JSON.stringify(progress(rig))).not.toContain('Invalid API key');
    } finally {
      await rig.close();
    }
  });

  it('a model-side failure is never retried', async () => {
    const rig = makeRig({ answer: () => ({ stdout: claudeJson('partial', { subtype: 'error_max_turns' }) }) });
    try {
      const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['failed']);
      expect(runCalls(rig)).toHaveLength(1);
      expect(d.job.failure).toBe('failed');
    } finally {
      await rig.close();
    }
  });

  it('cswap that cannot start is "unavailable"; no cswap at all runs nothing', async () => {
    const rig = makeRig({ answer: () => ({ code: null, spawnError: 'spawn /fake/bin/cswap ENOENT' }) });
    try {
      const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['failed']);
      expect(d.job.failure).toBe('unavailable');
      expect(runCalls(rig)).toHaveLength(1);
    } finally {
      await rig.close();
    }
    const none = makeRig();
    (none.ctx.bins as { cswap: string | null }).cswap = null;
    try {
      const d = await untilState(none, (await start(none, 'run the tests')).id, ['failed']);
      expect(d.job.failure).toBe('unavailable');
      expect(none.exec.calls).toHaveLength(0);
    } finally {
      await none.close();
    }
  });

  it('after a run that could not start, the run dir is prepared again (it may have been removed)', async () => {
    let first = true;
    const rig = makeRig({
      answer: (call) => {
        if (first) {
          first = false;
          return { code: null, spawnError: `spawn ENOENT (cwd ${call.opts.cwd})` };
        }
        return { stdout: claudeJson('Run the tests.') };
      },
    });
    try {
      await untilState(rig, (await start(rig, 'one')).id, ['failed']);
      rmSync(rig.ctx.paths.rewriteDir, { recursive: true, force: true });
      await untilState(rig, (await start(rig, 'two')).id, ['ready']);
      expect(existsSync(join(rig.ctx.paths.rewriteDir, 'work'))).toBe(true);
      expect(existsSync(join(rig.ctx.paths.rewriteDir, 'system-v1.md'))).toBe(true);
    } finally {
      await rig.close();
    }
  });

  it('flag drift: a refused --permission-prompts is dropped for one retry and every later run, every R1 flag kept, one alert', async () => {
    const rig = makeRig({
      answer: (call) =>
        call.args.includes('--permission-prompts') ? { code: 1, stderr: "error: unknown option '--permission-prompts'" } : { stdout: claudeJson('Run the tests.') },
    });
    try {
      const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['ready']);
      expect(d.prompt).toBe('Run the tests.');
      await untilState(rig, (await start(rig, 'again')).id, ['ready']);
      const calls = runCalls(rig);
      expect(calls.map((c) => c.args.includes('--permission-prompts'))).toEqual([true, false, false]);
      // The retry leaves out that option (and its value) only.
      const [first, retry] = calls.map((c) => c.args);
      expect(retry).toEqual(first?.filter((a, i) => a !== '--permission-prompts' && !(a === 'none' && first[i - 1] === '--permission-prompts')));
      for (const call of calls.slice(1)) {
        for (const flag of [...ISOLATION_OPTIONS, '--effort', '--fallback-model', '--max-budget-usd']) expect(call.args, flag).toContain(flag);
        expect(call.args.join(' ')).toContain('--tools  --disallowedTools mcp__* --strict-mcp-config --disable-slash-commands');
        expect(call.args.join(' ')).toContain('--setting-sources local --settings {"disableAllHooks":true} --permission-mode dontAsk');
      }
      expect(rig.ctx.db.rewriteRuns.list().map((r) => r.outcome).sort()).toEqual(['flags_rejected', 'ready', 'ready']);
      const alerts = (rig.ctx.store.getState().alerts ?? []).filter((a) => a.label.startsWith('Rewrite'));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: 'error', what: "claude refused the prompt writer's --permission-prompts" });
    } finally {
      await rig.close();
    }
  });

  it('U6: a refused --strict-mcp-config ends flags_rejected with no second run, and later jobs still pass it', async () => {
    const rig = makeRig({
      answer: (call) =>
        call.args.includes('--strict-mcp-config') ? { code: 1, stderr: "error: unknown option '--strict-mcp-config'" } : { stdout: claudeJson('Run the tests.') },
    });
    try {
      const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['failed']);
      expect(d.job).toMatchObject({ failure: 'flags_rejected', reason: FAILURE_REASON.flags_rejected });
      expect(runCalls(rig)).toHaveLength(1);
      await untilState(rig, (await start(rig, 'again')).id, ['failed']);
      expect(runCalls(rig).map((c) => c.args.includes('--strict-mcp-config'))).toEqual([true, true]);
      const alerts = (rig.ctx.store.getState().alerts ?? []).filter((a) => a.label.startsWith('Rewrite'));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ what: "claude refused the prompt writer's --strict-mcp-config", why: "Rewrite can't run without it; update Jantar on the Mac" });
      expect(rig.ctx.db.rewriteRuns.list().map((r) => r.outcome)).toEqual(['flags_rejected', 'flags_rejected']);
    } finally {
      await rig.close();
    }
  });

  it('a refused option that is not droppable, or that cannot be read, ends flags_rejected after one run', async () => {
    for (const stderr of ['error: unknown option --output-format', 'error: unknown argument', "error: unknown option '--brand-new'"]) {
      const rig = makeRig({ answer: () => ({ code: 1, stderr }) });
      try {
        const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['failed']);
        expect(runCalls(rig), stderr).toHaveLength(1);
        expect(d.job.failure).toBe('flags_rejected');
      } finally {
        await rig.close();
      }
    }
  });

  it("cswap's own refusal is named as cswap's", async () => {
    const rig = makeRig({ answer: () => ({ code: 2, stderr: 'cswap: error: unrecognized arguments: --share-history 7' }) });
    try {
      const d = await untilState(rig, (await start(rig, 'run the tests')).id, ['failed']);
      expect(d.job.failure).toBe('flags_rejected');
      expect(runCalls(rig)).toHaveLength(1);
      const alerts = (rig.ctx.store.getState().alerts ?? []).filter((a) => a.label.startsWith('Rewrite'));
      expect(alerts.map((a) => a.what)).toEqual(["cswap refused the prompt writer's --share-history"]);
    } finally {
      await rig.close();
    }
  });

  it('two droppable options refused one after the other: each is dropped in turn, one alert each', async () => {
    const rig = makeRig({
      answer: (call) => {
        for (const o of ['--permission-prompts', '--effort']) if (call.args.includes(o)) return { code: 1, stderr: `error: unknown option '${o}'` };
        return { stdout: claudeJson('Run the tests.') };
      },
    });
    try {
      await untilState(rig, (await start(rig, 'run the tests')).id, ['ready']);
      expect(runCalls(rig).map((c) => [c.args.includes('--permission-prompts'), c.args.includes('--effort')])).toEqual([
        [true, true],
        [false, true],
        [false, false],
      ]);
      const alerts = (rig.ctx.store.getState().alerts ?? []).filter((a) => a.label.startsWith('Rewrite'));
      expect(alerts.map((a) => a.what).sort()).toEqual(["claude refused the prompt writer's --effort", "claude refused the prompt writer's --permission-prompts"]);
    } finally {
      await rig.close();
    }
  });

  it('R8: no result within rewrite.timeoutS: the run is killed and the job fails with timeout', async () => {
    const rig = makeRig({ answer: hangUntilAborted });
    try {
      const job = await start(rig, 'run the tests');
      await untilState(rig, job.id, ['writing']);
      await untilRunning(rig);
      const [call] = runCalls(rig);
      expect(call?.opts.signal?.aborted).toBe(false);
      rig.ctx.clock.advance(119_999);
      expect(call?.opts.signal?.aborted).toBe(false);
      rig.ctx.clock.advance(1);
      // The run's signal is aborted: ctx.exec sends SIGTERM, then SIGKILL a second later. No process is left.
      expect(call?.opts.signal?.aborted).toBe(true);
      const d = await untilState(rig, job.id, ['failed']);
      expect(d.job).toMatchObject({ failure: 'timeout', reason: 'The prompt writer timed out. Send what you said, or try again.' });
      expect(runCalls(rig)).toHaveLength(1);
    } finally {
      await rig.close();
    }
  });

  it('rewrite.timeoutS sets the timeout', async () => {
    const rig = makeRig({ answer: hangUntilAborted, settings: { rewrite: { enabled: true, timeoutS: 10 } } });
    try {
      const job = await start(rig, 'run the tests');
      await untilRunning(rig);
      rig.ctx.clock.advance(10_000);
      expect((await untilState(rig, job.id, ['failed'])).job.failure).toBe('timeout');
    } finally {
      await rig.close();
    }
  });
});

describe('adopt', () => {
  const ADOPT = ['/usr/bin/python3', '-I', '/synthetic/adopt.py', 'adopt', '{n}'];

  it("runs launch.preLaunchArgv with {n} once per account per daemon life, before that account's first run", async () => {
    const rig = makeRig({ settings: { rewrite: { enabled: true }, launch: { preLaunchArgv: ADOPT } }, other: () => ({ code: 0 }) });
    try {
      await untilState(rig, (await start(rig, 'one')).id, ['ready']);
      await untilState(rig, (await start(rig, 'two')).id, ['ready']);
      const adopts = rig.exec.calls.filter((c) => c.file === '/usr/bin/python3');
      expect(adopts).toHaveLength(1);
      expect(adopts[0]?.args).toEqual(['-I', '/synthetic/adopt.py', 'adopt', '7']);
      expect(adopts[0]?.opts.timeoutMs).toBe(30_000);
      expect(rig.exec.calls.map((c) => c.file)).toEqual(['/usr/bin/python3', '/fake/bin/cswap', '/fake/bin/cswap']);
    } finally {
      await rig.close();
    }
  });

  it('waits to adopt while ccw restarts a session (both run cswap adopt), then adopts and runs', async () => {
    const rig = makeRig({ settings: { rewrite: { enabled: true }, launch: { preLaunchArgv: ADOPT } }, other: () => ({ code: 0 }) });
    try {
      rig.ctx.store.emit({ type: 'move.restarting', sid: 'other', data: { move: { sid: 'other', from: 3, to: 4, step: 'restarting', why: 'full', since: rig.ctx.clock.iso() } } });
      const job = await start(rig, 'one');
      for (let i = 0; i < 5; i++) {
        rig.ctx.clock.advance(1_000);
        await new Promise((r) => setImmediate(r));
      }
      expect(rig.exec.calls).toEqual([]);
      rig.ctx.store.emit({ type: 'move.cleared', sid: 'other', data: {} });
      rig.ctx.clock.advance(1_000);
      await untilState(rig, job.id, ['ready']);
      expect(rig.exec.calls.map((c) => c.file)).toEqual(['/usr/bin/python3', '/fake/bin/cswap']);
    } finally {
      await rig.close();
    }
  });

  it('a failed adopt penalises the account and the next one is tried', async () => {
    const rig = makeRig({
      settings: { rewrite: { enabled: true }, launch: { preLaunchArgv: ADOPT } },
      other: (call) => ({ code: call.args.at(-1) === '7' ? 1 : 0 }),
    });
    try {
      const d = await untilState(rig, (await start(rig, 'one')).id, ['ready']);
      expect(d.job.account).toBe(9);
      expect(runCalls(rig).map((c) => c.args[2])).toEqual(['9']);
    } finally {
      await rig.close();
    }
  });

  it('a cancel while adopt runs ends the job at once; the account is not penalised and the adopt still serves the next job', async () => {
    let finish: (r: Partial<ExecResult>) => void = () => {};
    const rig = makeRig({
      settings: { rewrite: { enabled: true }, launch: { preLaunchArgv: ADOPT } },
      other: () => new Promise<Partial<ExecResult>>((resolve) => (finish = resolve)),
    });
    try {
      const job = await start(rig, 'one');
      await vi.waitFor(() => expect(rig.exec.calls).toHaveLength(1));
      expect(rig.svc.cancel(job.id, PHONE)).toMatchObject({ state: 'cancelled' });
      await vi.waitFor(() => expect(rig.ctx.db.audit.list().filter((e) => e.action === 'rewrite.run')).toHaveLength(1));
      const next = await start(rig, 'two');
      finish({ code: 0 });
      const d = await untilState(rig, next.id, ['ready']);
      // Still 7: the cancel did not count against it, and its one adopt served both jobs.
      expect(d.job.account).toBe(7);
      expect(rig.exec.calls.filter((c) => c.file === '/usr/bin/python3')).toHaveLength(1);
      expect(rig.svc.get(job.id, PHONE)?.state).toBe('cancelled');
    } finally {
      await rig.close();
    }
  });

  it('stop() kills an adopt that is still running', async () => {
    const rig = makeRig({ settings: { rewrite: { enabled: true }, launch: { preLaunchArgv: ADOPT } }, other: hangUntilAborted });
    await start(rig, 'one');
    await vi.waitFor(() => expect(rig.exec.calls).toHaveLength(1));
    await rig.svc.stop();
    expect(rig.exec.calls[0]?.opts.signal?.aborted).toBe(true);
    expect(runCalls(rig)).toHaveLength(0);
    await rig.close();
  });
});

describe('cancel and send stop a run', () => {
  it('cancelling a writing job kills its run; the job stays cancelled', async () => {
    const rig = makeRig({ answer: hangUntilAborted });
    try {
      const job = await start(rig, 'run the tests');
      await untilRunning(rig);
      const [call] = runCalls(rig);
      expect(rig.svc.cancel(job.id, PHONE)).toMatchObject({ state: 'cancelled' });
      expect(call?.opts.signal?.aborted).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(rig.svc.get(job.id, PHONE)?.state).toBe('cancelled');
      expect(rig.ctx.db.rewriteRuns.list()[0]?.outcome).toBe('cancelled');
    } finally {
      await rig.close();
    }
  });

  it('stop() kills running runs and forgets every job', async () => {
    const rig = makeRig({ answer: hangUntilAborted });
    const job = await start(rig, 'run the tests');
    await untilRunning(rig);
    await rig.svc.stop();
    expect(runCalls(rig)[0]?.opts.signal?.aborted).toBe(true);
    expect(rig.svc.get(job.id, PHONE)).toBeNull();
    expect((await rig.svc.submit({ sid: SID, text: 'x' }, PHONE)).ok).toBe(false);
    await rig.close();
  });
});

/** Wait for the first cswap run call. */
async function untilRunning(rig: Rig): Promise<void> {
  await vi.waitFor(() => {
    if (runCalls(rig).length === 0) throw new Error('no run yet');
  });
}
