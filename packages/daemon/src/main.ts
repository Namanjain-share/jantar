/**
 * jantard entry point (bin/jantard.mjs).
 *
 *   jantard [--port <n>] [--home <dir>] [--no-terminal] [--read-only]
 *
 * Builds the daemon with daemon.ts (context, db, every source, the hooks
 * socket, writer, notifications, API and control socket), then runs until
 * SIGINT or SIGTERM and stops everything in reverse order. Normally started
 * by launchd (`jantar install`); it can also be run by hand in a terminal.
 */
import { resolve } from 'node:path';
import { DAEMON_NAME, HOME_ENV } from '@jantar/protocol';
import { legacyHomeWarning, legacyStateDirRefusal, resolvePaths, socketPathOk, type Env } from './config.js';
import type { RunningDaemon, DaemonOptions } from './daemon.js';
import { DAEMON_VERSION } from './version.js';

export const USAGE = `usage: ${DAEMON_NAME} [options]

Runs the Jantar daemon (normally started by launchd: jantar install).

Options:
  --port <n>      TCP port on 127.0.0.1 (default: settings remote.port, 7420)
  --home <dir>    state dir (default: $${HOME_ENV} or ~/.jantar)
  --no-terminal   turn the Terminal.app backend off (no osascript; no screen
                  peek, focus or sending)
  --read-only     only observe: refuse sending, focus, answering cards, the
                  cswap poller and settings changes
  -v, --version   print the version and exit
  -h, --help      print this help and exit
`;

export interface DaemonFlags {
  port?: number;
  home?: string;
  noTerminal: boolean;
  readOnly: boolean;
  help: boolean;
  version: boolean;
}

export type ParsedFlags = { ok: true; flags: DaemonFlags } | { ok: false; error: string };

/** Parse jantard's argv. Pure. */
export function parseDaemonArgs(argv: readonly string[]): ParsedFlags {
  const flags: DaemonFlags = { noTerminal: false, readOnly: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string | null => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i += 1;
      return next;
    };
    const noValue = () => inline === undefined;
    switch (name) {
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '-v':
      case '--version':
        flags.version = true;
        break;
      case '--no-terminal':
        if (!noValue()) return { ok: false, error: '--no-terminal takes no value' };
        flags.noTerminal = true;
        break;
      case '--read-only':
        if (!noValue()) return { ok: false, error: '--read-only takes no value' };
        flags.readOnly = true;
        break;
      case '--port': {
        const v = value();
        if (v === null || !/^\d{1,5}$/.test(v) || Number(v) > 65_535) {
          return { ok: false, error: '--port needs a number from 0 to 65535 (0 picks a free port)' };
        }
        flags.port = Number(v);
        break;
      }
      case '--home': {
        const v = value();
        if (!v) return { ok: false, error: '--home needs a directory' };
        flags.home = v;
        break;
      }
      default:
        return { ok: false, error: `unknown option: ${arg}` };
    }
  }
  return { ok: true, flags };
}

/** The bits of `process` main() uses (tests pass a fake). */
export interface MainProcess {
  readonly env: Env;
  readonly pid: number;
  on(event: 'SIGINT' | 'SIGTERM', fn: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', fn: () => void): unknown;
}

export interface MainDeps {
  proc?: MainProcess;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Default: daemon.ts startDaemon (loaded lazily so --help never loads Fastify). */
  start?: (opts: DaemonOptions) => Promise<RunningDaemon>;
  /** How long a graceful stop may take before main gives up. Default 15 s. */
  stopTimeoutMs?: number;
}

/** Exit codes. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/**
 * Run the daemon until SIGINT / SIGTERM. Resolves with the exit code once
 * everything has stopped (or at once for --help, --version and bad flags).
 */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const proc: MainProcess = deps.proc ?? process;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));

  const parsed = parseDaemonArgs(argv);
  if (!parsed.ok) {
    err(`${DAEMON_NAME}: ${parsed.error}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { flags } = parsed;
  if (flags.version) {
    out(`${DAEMON_NAME} ${DAEMON_VERSION}\n`);
    return EXIT.ok;
  }
  if (flags.help) {
    out(USAGE);
    return EXIT.ok;
  }

  const env: Record<string, string | undefined> = { ...proc.env };
  if (flags.home) env[HOME_ENV] = resolve(flags.home);
  const paths = resolvePaths({ env });
  for (const sock of [paths.hooksSock, paths.ctlSock]) {
    if (!socketPathOk(sock)) {
      err(`${DAEMON_NAME}: the state dir ${paths.home} is too deep: ${sock} is longer than macOS allows for a Unix socket (103 bytes). Use a shorter --home.\n`);
      return EXIT.usage;
    }
  }
  const legacyDir = legacyStateDirRefusal(paths);
  if (legacyDir) {
    err(`${DAEMON_NAME}: ${legacyDir}\n`);
    return EXIT.usage;
  }

  const start = deps.start ?? (await import('./daemon.js')).startDaemon;
  const opts: DaemonOptions = { env, readOnly: flags.readOnly };
  if (flags.noTerminal) opts.terminal = false;
  if (flags.port !== undefined) opts.port = flags.port;

  // A signal during startup is honoured as soon as the daemon is up.
  let signalled: string | null = null;
  let onSignal: (sig: string) => void = (sig) => {
    signalled = sig;
  };
  const sigint = () => onSignal('SIGINT');
  const sigterm = () => onSignal('SIGTERM');
  proc.on('SIGINT', sigint);
  proc.on('SIGTERM', sigterm);
  const detach = () => {
    proc.off('SIGINT', sigint);
    proc.off('SIGTERM', sigterm);
  };

  let daemon: RunningDaemon;
  try {
    daemon = await start(opts);
  } catch (e) {
    detach();
    err(`${DAEMON_NAME}: could not start: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.failed;
  }
  const legacyHome = legacyHomeWarning(env);
  if (legacyHome) daemon.ctx.log.warn(legacyHome);

  const stopTimeoutMs = deps.stopTimeoutMs ?? 15_000;
  return new Promise<number>((resolveExit) => {
    let stopping = false;
    onSignal = (sig) => {
      if (stopping) {
        // Second signal: stop waiting for a clean shutdown.
        detach();
        resolveExit(EXIT.failed);
        return;
      }
      stopping = true;
      daemon.ctx.log.info('stopping', { signal: sig });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), stopTimeoutMs);
        timer.unref?.();
      });
      Promise.race([daemon.stop().then(() => 'stopped' as const), timeout]).then(
        (how) => {
          clearTimeout(timer);
          detach();
          if (how === 'timeout') daemon.ctx.log.error('graceful stop timed out', { timeoutMs: stopTimeoutMs });
          resolveExit(how === 'stopped' ? EXIT.ok : EXIT.failed);
        },
        (e: unknown) => {
          clearTimeout(timer);
          detach();
          daemon.ctx.log.error('stop failed', { error: String(e) });
          resolveExit(EXIT.failed);
        },
      );
    };
    if (signalled) onSignal(signalled);
  });
}
