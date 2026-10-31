/**
 * One headless Rewrite run (U5, U6; spec 4.3 "Command", minus pre-warm):
 *
 *   <bins.cswap> run --share-history <N> -- -p --output-format json
 *     --model <m> [--fallback-model <f>] --effort <e> --max-turns 1 --max-budget-usd 1.00
 *     --tools "" --disallowedTools "mcp__*" --strict-mcp-config --disable-slash-commands
 *     --no-session-persistence --setting-sources local --settings '{"disableAllHooks":true}'
 *     --permission-mode dontAsk --permission-prompts none
 *     --system-prompt-file <rewriteDir>/system-v1.md
 *
 * through `ctx.exec` (argv only, never a shell), with the context on stdin
 * (what the user said is never in argv), an empty 0700 cwd, and an env
 * without the variables that would pick another login or a raw API key,
 * plus the switches that turn hooks, CLAUDE.md, auto memory, the git
 * snapshot and background tasks off. JSON output, because `claude -p`
 * prints a failure (a missing login, say) as its result: the result counts
 * only when `is_error` is false, the subtype is "success" and the result is
 * a string. Error text is read to classify a failure, never shown or logged.
 *
 * Flag drift (spec 4.3, narrowed by U6): a claude that refuses an option
 * names it on stderr. Only DROPPABLE_OPTIONS may then be left out; the
 * isolation options are never dropped, so a refusal of one (or of anything
 * else) ends the job flags_rejected and nothing weaker runs.
 *
 * v0.4: this is the shared runner. Rewrite and Ask Claude (life/food) run
 * the same code with their own run dir and system prompt (`prepareRunDir`
 * options) and the same refused-option loop (`runDroppingRefused`). On a Mac
 * with one Claude login (accounts mode "single") the run is
 * `<bins.claude> -p ...` directly, with the same flags, env and stdin.
 */
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import type { AccountId, RewriteModel } from '@jantar/protocol';
import type { DaemonContext, ExecResult, Paths } from '../contracts.js';
import { CSWAP_SCRUB_ENV, scrubEnv } from '../core/exec.js';

/** Bump with the system prompt's text; audit rows and jobs record it. */
export const PROMPT_VERSION = 'v1';
export const SYSTEM_PROMPT_FILE = `system-${PROMPT_VERSION}.md`;

/** Never inherited: another account's config dir, a raw API key, or a token that would bypass the picked login. */
export const REWRITE_SCRUB_ENV: readonly string[] = [
  ...CSWAP_SCRUB_ENV,
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

export const REWRITE_ENV: Readonly<Record<string, string>> = {
  JANTAR_SKIP_HOOKS: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
};

/** Captured output per stream: a written prompt is at most 16,000 chars, so JSON never comes near this. */
const RUN_MAX_BUFFER = 1024 * 1024;
/** `ctx.exec`'s own timeout, a backstop behind the clock timer that aborts the run. */
const EXEC_GRACE_MS = 5_000;

/**
 * cswap runs claude from PATH, and under launchd PATH is node's dir and the
 * system dirs only (cli/src/lib/launchd.ts), never ~/.local/bin, so cswap
 * would stop at "'claude' was not found on PATH". The claude the daemon
 * resolved (`bins.claude`, absolute) leads PATH for the run.
 */
export function rewriteEnv(env: Readonly<Record<string, string | undefined>>, claude: string | null = null): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...scrubEnv(env, REWRITE_SCRUB_ENV), ...REWRITE_ENV };
  if (claude && isAbsolute(claude)) {
    const dir = dirname(claude);
    out.PATH = [dir, ...(env.PATH ?? '').split(delimiter).filter((p) => p && p !== dir)].join(delimiter);
  }
  return out;
}

/** cswap's own options (before `--`); everything after `--` goes to claude. */
export const CSWAP_OPTIONS: readonly string[] = ['--share-history'];

/** What every run needs as it is: JSON output and the model the user picked. */
export const CORE_OPTIONS: readonly string[] = ['--output-format', '--model'];

/**
 * Options a run can do without, left out once claude refused one (until
 * the daemon restarts): without them it is exactly as isolated, only less
 * tuned. Nothing else is ever dropped.
 */
export const DROPPABLE_OPTIONS: readonly string[] = ['--permission-prompts', '--effort', '--fallback-model', '--max-budget-usd'];

/**
 * The isolation of every run (U6, R1): no tools, no MCP, no slash commands
 * or skills, no user settings or hooks, no persistence, one turn, our
 * system prompt. Never dropped: a claude that refuses one of these ends the
 * job flags_rejected.
 */
export const ISOLATION_OPTIONS: readonly string[] = [
  '--tools',
  '--disallowedTools',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--setting-sources',
  '--settings',
  '--max-turns',
  '--permission-mode',
  '--system-prompt-file',
];

/**
 * A runaway guard only: with one turn and no tools there is no runaway, and
 * Opus (U5) reading a full context (24,000 chars, more tokens in
 * Devanagari) and writing up to 16,000 chars can pass the spec's 0.25.
 */
export const MAX_BUDGET_USD = '1.00';

export interface RunFlags {
  /** The account cswap runs on; null for a direct `claude -p` run (single-account mode). */
  account: AccountId | null;
  model: RewriteModel;
  fallbackModel: RewriteModel;
  effort: string;
  systemPromptFile: string;
  /** Options claude refused before: left out when they are in DROPPABLE_OPTIONS, ignored otherwise. */
  dropped?: ReadonlySet<string>;
}

/** Which program a run starts: cswap (`run --share-history N -- -p ...`) or claude itself (`-p ...`). */
export type RunVia = { cswap: string } | { claude: string };

/** The argv after `<bins.cswap>` (default), or after `<bins.claude>` with via 'claude'. */
export function rewriteArgv(f: RunFlags, via: 'cswap' | 'claude' = 'cswap'): string[] {
  const options: string[][] = [
    ['--output-format', 'json'],
    ['--model', f.model],
    // claude refuses a fallback equal to the model ("Rewrite with Sonnet" with fallback sonnet).
    ...(f.fallbackModel !== f.model ? [['--fallback-model', f.fallbackModel]] : []),
    ['--effort', f.effort],
    ['--max-turns', '1'],
    ['--max-budget-usd', MAX_BUDGET_USD],
    ['--tools', ''],
    ['--disallowedTools', 'mcp__*'],
    ['--strict-mcp-config'],
    ['--disable-slash-commands'],
    ['--no-session-persistence'],
    ['--setting-sources', 'local'],
    ['--settings', '{"disableAllHooks":true}'],
    ['--permission-mode', 'dontAsk'],
    ['--permission-prompts', 'none'],
    ['--system-prompt-file', f.systemPromptFile],
  ];
  const dropped = f.dropped ?? new Set<string>();
  const kept = options.filter(([name]) => !(name !== undefined && dropped.has(name) && DROPPABLE_OPTIONS.includes(name)));
  if (via === 'claude') return ['-p', ...kept.flat()];
  if (f.account === null) throw new Error('a cswap run needs an account');
  return ['run', '--share-history', String(f.account), '--', '-p', ...kept.flat()];
}

/** Which program refused `option`: cswap reads only its own options, the rest go to claude. */
export function refusedBy(option: string | null): 'cswap' | 'claude' | null {
  if (option === null) return null;
  return CSWAP_OPTIONS.includes(option) ? 'cswap' : 'claude';
}

/** How one run ended. */
export type RunOutcome =
  | { kind: 'ok'; result: string; inputTokens: number | null; outputTokens: number | null }
  /** Cancelled, sent meanwhile, or the daemon stopping. */
  | { kind: 'cancelled' }
  | { kind: 'timeout' }
  /** cswap could not be started at all, or claude is not there behind it. */
  | { kind: 'unavailable' }
  /** cswap or claude refused an option before any JSON: the option, when it is one of ours, else null. */
  | { kind: 'flags'; option: string | null }
  /** A startup, login or usage-limit failure on this account: another account may work. */
  | { kind: 'account' }
  /** The run itself failed (is_error, a non-success result, no result): never retried. */
  | { kind: 'model'; inputTokens: number | null; outputTokens: number | null };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The result message of `--output-format json` (one object; an array of messages or JSON lines are taken too). */
export function parseResult(stdout: string): Obj | null {
  const pick = (v: unknown): Obj | null => {
    if (Array.isArray(v)) return [...v].reverse().find((m): m is Obj => isObj(m) && m.type === 'result') ?? null;
    return isObj(v) && (v.type === 'result' || 'is_error' in v || 'subtype' in v) ? v : null;
  };
  const text = stdout.trim();
  if (!text) return null;
  try {
    return pick(JSON.parse(text));
  } catch {
    /* JSON lines, or noise before the JSON */
  }
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    try {
      const found = pick(JSON.parse(line));
      if (found) return found;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// Login, token and limit failures belong to the account, not to the request.
const ACCOUNT_FAILURE =
  /invalid api key|\/login|log ?in again|not logged in|authenticat|unauthori[sz]ed|oauth|token (?:has )?(?:expired|revoked)|relogin|credit balance|usage limit|limit reached|rate.?limit/i;

// claude (commander): "error: unknown option '--x'"; argparse-style tools: "unrecognized arguments: --x".
const DRIFT = /(?:unknown|unrecognized) (?:option|argument)s?:?\s*['"‘]?(--[\w-]+)?/i;

/** Every option a run passes, the only ones a refusal is read as. */
const OUR_OPTIONS: ReadonlySet<string> = new Set([...CSWAP_OPTIONS, ...CORE_OPTIONS, ...DROPPABLE_OPTIONS, ...ISOLATION_OPTIONS]);

// cswap execs claude: a claude that is not there is exit 127, "command not found" or ENOENT naming claude.
const CLAUDE_MISSING = /command not found|no such file or directory\W+(?:[^\s'"]*\/)?claude(?![\w./-])/i;

/** The refused option, when stderr names one of ours. */
export function refusedOption(stderr: string): string | null {
  const name = DRIFT.exec(stderr)?.[1];
  return name !== undefined && OUR_OPTIONS.has(name) ? name : null;
}

function tokens(r: Obj): { inputTokens: number | null; outputTokens: number | null } {
  const u = isObj(r.usage) ? r.usage : null;
  const n = (k: string) => (u && typeof u[k] === 'number' ? (u[k] as number) : 0);
  if (!u) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens'),
    outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
  };
}

function errorText(r: Obj): string {
  const parts: string[] = [];
  if (typeof r.result === 'string') parts.push(r.result);
  if (typeof r.subtype === 'string') parts.push(r.subtype);
  if (Array.isArray(r.errors)) for (const e of r.errors) parts.push(typeof e === 'string' ? e : JSON.stringify(e) ?? '');
  return parts.join('\n').slice(0, 4_000);
}

/** Classify one finished exec. `aborted`: cancelled from outside; `timedOut`: our timer fired. */
export function classifyRun(res: ExecResult, how: { aborted: boolean; timedOut: boolean }): RunOutcome {
  if (how.timedOut || res.timedOut) return { kind: 'timeout' };
  if (how.aborted) return { kind: 'cancelled' };
  if (res.spawnError) return { kind: 'unavailable' };
  const r = parseResult(res.stdout);
  if (!r) {
    if (DRIFT.test(res.stderr)) return { kind: 'flags', option: refusedOption(res.stderr) };
    if (res.code === 127 || CLAUDE_MISSING.test(res.stderr)) return { kind: 'unavailable' };
    // Killed from outside (OOM, a SIGKILL): not the account's fault, and not worth a second account.
    if (res.signal) return { kind: 'model', inputTokens: null, outputTokens: null };
    return res.code === 0 ? { kind: 'model', inputTokens: null, outputTokens: null } : { kind: 'account' };
  }
  if (r.is_error === true || r.subtype !== 'success' || typeof r.result !== 'string') {
    if (ACCOUNT_FAILURE.test(errorText(r))) return { kind: 'account' };
    return { kind: 'model', ...tokens(r) };
  }
  return { kind: 'ok', result: r.result, ...tokens(r) };
}

export interface RunDir {
  /** The empty 0700 working dir of every run. */
  cwd: string;
  /** The 0600 copy of the system prompt. */
  systemPromptFile: string;
}

/** Where a kind of run keeps its files: its own dir, and its system prompt under paths.assetsDir. */
export interface RunDirOptions {
  /** The run's dir (0700): its empty work/ cwd and the prompt copy live here. */
  dir: string;
  /** The prompt's path under paths.assetsDir, e.g. "food/estimate-v1.md". */
  asset: string;
}

/**
 * <dir> (0700) with an empty work/ (0700) and the system prompt copied from
 * the package (0600), rewritten only when its text changed. Default:
 * Rewrite's own (<rewriteDir>, assets/rewrite/system-v1.md); Ask Claude
 * passes { dir: paths.foodEstimateDir, asset: 'food/estimate-v1.md' }.
 */
export async function prepareRunDir(paths: Pick<Paths, 'rewriteDir' | 'assetsDir'>, opts?: RunDirOptions): Promise<RunDir & { workEntries: number }> {
  const dir = opts?.dir ?? paths.rewriteDir;
  const asset = opts?.asset ?? join('rewrite', SYSTEM_PROMPT_FILE);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const cwd = join(dir, 'work');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await chmod(cwd, 0o700);
  const text = await readFile(join(paths.assetsDir, asset), 'utf8');
  const systemPromptFile = join(dir, basename(asset));
  const current = await readFile(systemPromptFile, 'utf8').catch(() => null);
  if (current !== text) {
    const tmp = `${systemPromptFile}.${process.pid}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, systemPromptFile);
  }
  await chmod(systemPromptFile, 0o600);
  return { cwd, systemPromptFile, workEntries: (await readdir(cwd)).length };
}

export interface ExecRewrite {
  /** cswap (`run --share-history N -- -p`), or claude itself in single-account mode. */
  via: RunVia;
  flags: RunFlags;
  /** The context message (stdin). */
  input: string;
  cwd: string;
  timeoutMs: number;
  /** Aborts the run (cancel, sent meanwhile, daemon stop). */
  signal: AbortSignal;
}

/** Run once; the clock timer aborts it at `timeoutMs` (exec then sends SIGTERM, and SIGKILL a second later). */
export async function execRewrite(ctx: Pick<DaemonContext, 'exec' | 'clock' | 'env' | 'bins'>, r: ExecRewrite): Promise<{ outcome: RunOutcome; ms: number }> {
  const started = ctx.clock.now();
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  if (r.signal.aborted) ac.abort();
  else r.signal.addEventListener('abort', onAbort, { once: true });
  const timer = ctx.clock.setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, r.timeoutMs);
  let res: ExecResult;
  const [file, argv] = 'cswap' in r.via ? [r.via.cswap, rewriteArgv(r.flags, 'cswap')] : [r.via.claude, rewriteArgv(r.flags, 'claude')];
  try {
    res = await ctx.exec(file, argv, {
      cwd: r.cwd,
      env: rewriteEnv(ctx.env, ctx.bins.claude),
      input: r.input,
      timeoutMs: r.timeoutMs + EXEC_GRACE_MS,
      maxBuffer: RUN_MAX_BUFFER,
      signal: ac.signal,
    });
  } finally {
    ctx.clock.clearTimeout(timer);
    r.signal.removeEventListener('abort', onAbort);
  }
  return { outcome: classifyRun(res, { aborted: r.signal.aborted, timedOut }), ms: Math.max(0, ctx.clock.now() - started) };
}

/**
 * The refused-option loop, shared by Rewrite and Ask Claude: run once
 * without the options already `learned`; when claude (or cswap) refuses one
 * the run can do without (DROPPABLE_OPTIONS) and this attempt still passed
 * it, learn it and run once more without it. Any other refusal stands (the
 * caller ends the job flags_rejected). At most one extra run per droppable
 * option. `learned` is the caller's own set, kept for the daemon's life;
 * `onRefused` hears every refusal (for its one alert per option).
 */
export async function runDroppingRefused(
  once: (dropped: ReadonlySet<string>) => Promise<{ outcome: RunOutcome; ms: number }>,
  learned: Set<string>,
  onRefused?: (option: string | null) => void,
  signal?: AbortSignal,
): Promise<{ outcome: RunOutcome; ms: number }> {
  // What this attempt leaves out, read once: another run may learn more meanwhile.
  let used: ReadonlySet<string> = new Set(learned);
  let r = await once(used);
  while (r.outcome.kind === 'flags') {
    const refused = r.outcome.option;
    const droppable = refused !== null && DROPPABLE_OPTIONS.includes(refused);
    if (droppable) learned.add(refused);
    onRefused?.(refused);
    if (refused === null || !droppable || used.has(refused) || signal?.aborted) break;
    used = new Set([...used, ...learned, refused]);
    r = await once(used);
  }
  return r;
}
