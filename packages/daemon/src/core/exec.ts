import { spawn } from 'node:child_process';
import type { ExecFile, ExecOptions, ExecResult } from '../contracts.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const KILL_GRACE_MS = 1000;

/**
 * The real `ExecFile`: spawn with argv only (`shell: false`), optional stdin,
 * timeout with SIGTERM then SIGKILL, capped output. Never rejects.
 */
export function createExecFile(defaults: { env?: Readonly<Record<string, string | undefined>> } = {}): ExecFile {
  return (file, args, opts = {}) => runExec(file, args, { env: defaults.env, ...opts });
}

function runExec(file: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let truncated = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;

    const finish = (r: Omit<ExecResult, 'durationMs' | 'stdout' | 'stderr' | 'timedOut' | 'truncated'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        ...r,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd: opts.cwd,
        env: cleanEnv(opts.env ?? process.env),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        spawnError: (e as Error).message,
        durationMs: Date.now() - started,
      });
      return;
    }

    let killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    if (opts.signal) {
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (b: Buffer) => {
      if (outLen + b.length > maxBuffer) {
        truncated = true;
        const room = maxBuffer - outLen;
        if (room > 0) out.push(b.subarray(0, room));
        outLen = maxBuffer;
      } else {
        out.push(b);
        outLen += b.length;
      }
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (errLen + b.length > maxBuffer) {
        truncated = true;
        const room = maxBuffer - errLen;
        if (room > 0) err.push(b.subarray(0, room));
        errLen = maxBuffer;
      } else {
        err.push(b);
        errLen += b.length;
      }
    });
    child.on('error', (e) => finish({ code: null, signal: null, spawnError: e.message }));
    child.on('close', (code, signal) => finish({ code, signal: signal ?? null }));

    child.stdin?.on('error', () => {
      /* the child may exit before reading stdin */
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function cleanEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Variables cswap must never inherit (they make cswap treat a profile as the active login). */
export const CSWAP_SCRUB_ENV = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] as const;

/** A copy of `env` without `keys`. */
export function scrubEnv(
  env: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const k of keys) delete out[k];
  return out;
}

/** `env` with LC_ALL=C (stable `ps` / `lsof` output whatever the user's locale). */
export function cLocale(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return { ...env, LC_ALL: 'C', LANG: 'C' };
}
