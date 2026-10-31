import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as protocol from '@jantar/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASYNC_EXIT_BUDGET_MS,
  HOOK_CLIENT_PATH,
  HOOK_CLIENT_VERSION,
  HOME_ENV,
  HOOK_TAG,
  HOOKS_SOCKET_RELATIVE,
  LEGACY_HOME_ENV,
  LEGACY_SKIP_HOOKS_ENV,
  MAX_HOOK_LINE_BYTES,
  SKIP_HOOKS_ENV,
  WAIT_FLAG,
} from '../src/index.js';
import { perfBudgetMs } from './perf.js';

// ---------------------------------------------------------------------------
// helpers

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

interface RunOptions {
  /** Leave stdin open (never send EOF). */
  keepStdinOpen?: boolean;
  /** Send this signal once the server has seen the connection. */
  killOnConnect?: { server: TestServer; signal: NodeJS.Signals };
  client?: string;
}

let dir: string;
let stateDir: string;
let sockPath: string;

function baseEnv(): Record<string, string> {
  // A synthetic HOME so a missing JANTAR_HOME could never reach a real daemon.
  return { PATH: process.env.PATH ?? '', HOME: dir, JANTAR_HOME: stateDir };
}

function runHook(args: string[], input: string, env: Record<string, string> = {}, opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [opts.client ?? HOOK_CLIENT_PATH, ...args], {
      env: { ...baseEnv(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    if (opts.killOnConnect) {
      const { server, signal } = opts.killOnConnect;
      server.onLine = () => setTimeout(() => child.kill(signal), 50);
    }
    child.stdin.write(input);
    if (!opts.keepStdinOpen) child.stdin.end();
    else setTimeout(() => child.stdin.destroy(), 5000).unref();
  });
}

interface TestServer {
  server: Server;
  lines: string[];
  connections: number;
  /** Resolves when a connection closes from the client side; value = whether a line came first. */
  closed: Promise<void>;
  onLine?: (line: string, sock: Socket) => void;
  /**
   * Resolves once `n` lines have come in. A client that does not wait for a
   * reply writes its line and exits; the line is already in the socket, but
   * this process may read it after the child's 'close' event.
   */
  received(n: number): Promise<void>;
  close(): Promise<void>;
}

/** A fake daemon on `sockPath`. `handler` decides what to do with each line. */
async function startServer(handler: (line: string, sock: Socket) => void = (_l, s) => s.end()): Promise<TestServer> {
  await mkdir(join(stateDir, 'run'), { recursive: true, mode: 0o700 });
  let resolveClosed!: () => void;
  const ts: TestServer = {
    server: createServer(),
    lines: [],
    connections: 0,
    closed: new Promise<void>((r) => (resolveClosed = r)),
    received: (n) =>
      vi.waitFor(
        () => {
          if (ts.lines.length < n) throw new Error(`${ts.lines.length} of ${n} lines came in`);
        },
        { timeout: 5000, interval: 5 },
      ),
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => ts.server.close(() => r()));
    },
  };
  const sockets = new Set<Socket>();
  ts.server.on('connection', (sock) => {
    ts.connections += 1;
    sockets.add(sock);
    let buf = '';
    let seen = false;
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1 && !seen) {
        seen = true;
        const line = buf.slice(0, nl);
        ts.lines.push(line);
        ts.onLine?.(line, sock);
        handler(line, sock);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      sockets.delete(sock);
      resolveClosed();
    });
  });
  await new Promise<void>((r) => ts.server.listen(sockPath, r));
  return ts;
}

const reply = (output: unknown) => `${JSON.stringify({ v: 1, output })}\n`;

const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

function permissionRequest(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    hook_event_name: 'PermissionRequest',
    session_id: 'synthetic-session-1',
    transcript_path: '/synthetic/project/transcript.jsonl',
    cwd: '/synthetic/project',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Run tests' },
    permission_suggestions: [],
    ...extra,
  });
}

function stopEvent(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'synthetic-session-1',
    last_assistant_message: 'All done.',
    stop_hook_active: false,
    future_field: { kept: true },
    ...extra,
  });
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'jantar-hk-')));
  stateDir = join(dir, 's');
  sockPath = join(stateDir, HOOKS_SOCKET_RELATIVE);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('package surface', () => {
  it('ships an executable client and matches the protocol constants', async () => {
    expect(existsSync(HOOK_CLIENT_PATH)).toBe(true);
    expect(statSync(HOOK_CLIENT_PATH).mode & 0o111).not.toBe(0);
    expect(WAIT_FLAG).toBe('--wait');
    expect(HOOK_TAG).toBe(protocol.HOOK_TAG);
    expect(SKIP_HOOKS_ENV).toBe(protocol.SKIP_HOOKS_ENV);
    expect(LEGACY_SKIP_HOOKS_ENV).toBe(protocol.LEGACY_SKIP_HOOKS_ENV);
    expect(HOME_ENV).toBe(protocol.HOME_ENV);
    expect(LEGACY_HOME_ENV).toBe(protocol.LEGACY_HOME_ENV);
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; dependencies?: object };
    expect(HOOK_CLIENT_VERSION).toBe(pkg.version);
    expect(pkg.dependencies ?? {}).toEqual({});
    const src = await readFile(HOOK_CLIENT_PATH, 'utf8');
    expect(src).toContain(`var VERSION = '${HOOK_CLIENT_VERSION}'`);
    // module-system neutral: no static imports/exports, no require, no import.meta
    expect(src).not.toMatch(/^\s*(import|export)\s/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/import\.meta/);
    expect(spawnSync(process.execPath, ['--check', HOOK_CLIENT_PATH]).status).toBe(0);
  });
});

describe('forwarding async events', () => {
  it('sends one tagged line, prints nothing and exits 0', async () => {
    const srv = await startServer();
    try {
      const before = Date.now();
      const r = await runHook([], stopEvent(), {
        TERM_PROGRAM: 'Apple_Terminal',
        ITERM_SESSION_ID: 'w0t0p0:SYNTHETIC',
        TMUX_PANE: '%7',
        CLAUDE_CONFIG_DIR: '/synthetic/home/.claude-swap-backup/sessions/2-profile',
        GHOSTTY_RESOURCES_DIR: '/synthetic/ghostty',
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      await srv.received(1);
      expect(srv.lines).toHaveLength(1);
      const sent = JSON.parse(srv.lines[0] as string);
      const parsed = protocol.HookPayloadSchema.parse(sent);
      expect(parsed.hook_event_name).toBe('Stop');
      expect(sent.future_field).toEqual({ kept: true });
      const tag = sent[HOOK_TAG];
      expect(Object.keys(tag)).toEqual([
        'v', 'ts', 'mono', 'ppid', 'wait', 'termProgram', 'itermSessionId', 'tmuxPane', 'claudeConfigDir', 'ghostty', 'hookVersion',
      ]);
      expect(tag).toMatchObject({
        v: 1,
        ppid: process.pid,
        wait: false,
        termProgram: 'Apple_Terminal',
        itermSessionId: 'w0t0p0:SYNTHETIC',
        tmuxPane: '%7',
        claudeConfigDir: '/synthetic/home/.claude-swap-backup/sessions/2-profile',
        ghostty: true,
        hookVersion: HOOK_CLIENT_VERSION,
      });
      expect(tag.ts).toBeGreaterThanOrEqual(before);
      expect(tag.ts).toBeLessThanOrEqual(Date.now());
      expect(tag.mono).toMatch(/^\d+$/);
    } finally {
      await srv.close();
    }
  });

  it('leaves out terminal fields that are not set', async () => {
    const srv = await startServer();
    try {
      const r = await runHook([], stopEvent());
      expect(r.code).toBe(0);
      await srv.received(1);
      const tag = JSON.parse(srv.lines[0] as string)[HOOK_TAG];
      expect(Object.keys(tag).sort()).toEqual(['hookVersion', 'mono', 'ppid', 'ts', 'v', 'wait']);
    } finally {
      await srv.close();
    }
  });

  it('orders events from separate hook processes by the monotonic stamp', async () => {
    const srv = await startServer();
    try {
      await runHook([], stopEvent({ n: 1 }));
      await srv.received(1);
      await runHook([], stopEvent({ n: 2 }));
      await srv.received(2);
      const [a, b] = srv.lines.map((l) => JSON.parse(l));
      expect(BigInt(a[HOOK_TAG].mono) < BigInt(b[HOOK_TAG].mono)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('drops tool_response when the line would be too big, and sends nothing when it still is', async () => {
    const srv = await startServer();
    try {
      const big = 'x'.repeat(MAX_HOOK_LINE_BYTES + 1000);
      const r1 = await runHook([], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: { content: big } }));
      expect(r1.code).toBe(0);
      await srv.received(1);
      expect(srv.lines).toHaveLength(1);
      const sent = JSON.parse(srv.lines[0] as string);
      expect(sent.tool_response).toBeUndefined();
      expect(sent.tool_input).toEqual({ file_path: '/a' });

      const r2 = await runHook([], JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Write', tool_input: { content: big } }));
      expect(r2.code).toBe(0);
      expect(r2.stdout).toBe('');
      expect(srv.connections).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

describe('blocking PermissionRequest (--wait)', () => {
  it('waits for the daemon and prints the exact decision JSON', async () => {
    const srv = await startServer((_line, sock) => setTimeout(() => sock.end(reply(ALLOW)), 300));
    try {
      const r = await runHook([WAIT_FLAG], permissionRequest());
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n');
      expect(r.ms).toBeGreaterThanOrEqual(300);
      expect(JSON.parse(srv.lines[0] as string)[HOOK_TAG].wait).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('accepts a reply that arrives in pieces and keeps waiting past the async deadline', async () => {
    const line = reply(ALLOW);
    const srv = await startServer((_l, sock) => {
      sock.write(line.slice(0, 10));
      setTimeout(() => sock.end(line.slice(10)), 1300);
    });
    try {
      const r = await runHook([WAIT_FLAG], permissionRequest());
      expect(r.code).toBe(0);
      expect(r.ms).toBeGreaterThanOrEqual(1300);
      expect(JSON.parse(r.stdout)).toEqual(ALLOW);
    } finally {
      await srv.close();
    }
  });

  it('prints nothing for "no decision", a closed socket or a bad reply', async () => {
    const cases: Array<(sock: Socket) => void> = [
      (s) => s.end(reply(null)),
      (s) => s.end(),
      (s) => s.destroy(),
      (s) => s.end('this is not json\n'),
      (s) => s.end(`${JSON.stringify({ v: 2, output: ALLOW })}\n`),
      (s) => s.end(`${JSON.stringify({ v: 1, output: [ALLOW] })}\n`),
      (s) => s.end('\n'),
    ];
    for (const act of cases) {
      const srv = await startServer((_l, sock) => act(sock));
      try {
        const r = await runHook([WAIT_FLAG], permissionRequest());
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        await srv.close();
      }
    }
  });

  it('returns at once with no output for a subagent request (agent_id), even if the daemon never answers', async () => {
    const srv = await startServer(() => {
      /* hold the connection open and never reply */
    });
    try {
      const r = await runHook([WAIT_FLAG], permissionRequest({ agent_id: 'agent-synthetic-1', agent_type: 'general-purpose' }));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.ms).toBeLessThan(perfBudgetMs(ASYNC_EXIT_BUDGET_MS));
      await srv.received(1);
      const sent = JSON.parse(srv.lines[0] as string);
      expect(sent.agent_id).toBe('agent-synthetic-1');
      expect(sent[HOOK_TAG].wait).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('exits 0 quietly when Claude kills it while waiting, and the daemon sees end-of-file', async () => {
    const srv = await startServer(() => {
      /* never reply */
    });
    try {
      const r = await runHook([WAIT_FLAG], permissionRequest(), {}, { killOnConnect: { server: srv, signal: 'SIGTERM' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      await srv.closed;
    } finally {
      await srv.close();
    }
  });
});

describe('failing open', () => {
  it('with the daemon down: the async hook exits 0 within 1 s and the blocking one prints nothing', async () => {
    for (const args of [[], [WAIT_FLAG]]) {
      const r = await runHook(args, args.length ? permissionRequest() : stopEvent());
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      expect(r.ms).toBeLessThan(perfBudgetMs(ASYNC_EXIT_BUDGET_MS));
    }
  });

  it('with a stale socket path (nobody listening) it still exits 0 quickly', async () => {
    await mkdir(join(stateDir, 'run'), { recursive: true });
    await writeFile(sockPath, 'not a socket');
    for (const args of [[], [WAIT_FLAG]]) {
      const r = await runHook(args, permissionRequest());
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.ms).toBeLessThan(perfBudgetMs(ASYNC_EXIT_BUDGET_MS));
    }
  });

  it('gives up on a stdin that never closes', async () => {
    const srv = await startServer();
    try {
      for (const args of [[], [WAIT_FLAG]]) {
        const r = await runHook(args, stopEvent(), {}, { keepStdinOpen: true });
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.ms).toBeLessThan(perfBudgetMs(ASYNC_EXIT_BUDGET_MS + 200));
      }
      expect(srv.connections).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('exits at once when hooks are skipped, and ignores input that is not a JSON object', async () => {
    const srv = await startServer((_l, s) => s.end(reply(ALLOW)));
    try {
      const skipped = await runHook([WAIT_FLAG], permissionRequest(), { [SKIP_HOOKS_ENV]: '1' });
      expect(skipped.code).toBe(0);
      expect(skipped.stdout).toBe('');
      // The old name's opt-out still keeps a session off the board.
      const legacy = await runHook([WAIT_FLAG], permissionRequest(), { [LEGACY_SKIP_HOOKS_ENV]: '1' });
      expect(legacy.code).toBe(0);
      expect(legacy.stdout).toBe('');
      for (const input of ['', '{', 'not json at all', '[1,2]', 'null', '"text"', '42']) {
        const r = await runHook([WAIT_FLAG], input);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('');
      }
      expect(srv.connections).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('never exits 2', async () => {
    const r = await runHook(['--unknown-flag', WAIT_FLAG], permissionRequest(), { JANTAR_HOME: join(dir, 'missing') });
    expect(r.code).toBe(0);
  });
});

describe('the installed, extensionless copy', () => {
  it('without JANTAR_HOME (as Claude runs it) it reaches the state dir it is installed in, not ~/.jantar', async () => {
    // Installed for a custom state dir: <dir>/custom/bin/jantar-hook.
    const home = join(dir, 'custom');
    await mkdir(join(home, 'bin'), { recursive: true });
    const client = join(home, 'bin', 'jantar-hook');
    await copyFile(HOOK_CLIENT_PATH, client);
    stateDir = join(dir, '.jantar'); // the default for HOME=<dir>
    sockPath = join(stateDir, HOOKS_SOCKET_RELATIVE);
    const fallback = await startServer();
    stateDir = home;
    sockPath = join(home, HOOKS_SOCKET_RELATIVE);
    const own = await startServer();
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [client], { env: { PATH: process.env.PATH ?? '', HOME: dir }, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('close', resolve);
        child.stdin.end(stopEvent());
      });
      expect(code).toBe(0);
      await own.received(1);
      expect(own.lines).toHaveLength(1);
      expect(fallback.lines).toHaveLength(0);
    } finally {
      await own.close();
      await fallback.close();
    }
  });

  it('without JANTAR_HOME it takes the old CCW_V2_HOME, as the daemon does', async () => {
    const srv = await startServer();
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const env = { PATH: process.env.PATH ?? '', HOME: dir, CCW_V2_HOME: stateDir };
        const child = spawn(process.execPath, [HOOK_CLIENT_PATH], { env, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('close', resolve);
        child.stdin.end(stopEvent());
      });
      expect(code).toBe(0);
      await srv.received(1);
      expect(srv.lines).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  // The installer copies the client to ~/.jantar/bin/jantar-hook (no extension).
  // Node then decides the module system from its surroundings; both must work.
  for (const kind of ['none', 'commonjs', 'module'] as const) {
    it(`works with ${kind === 'none' ? 'no package.json' : `"type": "${kind}"`} around it`, async () => {
      const binDir = join(dir, `copy-${kind}`, 'bin');
      await mkdir(binDir, { recursive: true });
      if (kind !== 'none') await writeFile(join(dir, `copy-${kind}`, 'package.json'), JSON.stringify({ type: kind }));
      const client = join(binDir, 'jantar-hook');
      await copyFile(HOOK_CLIENT_PATH, client);
      const srv = await startServer((_l, s) => s.end(reply(ALLOW)));
      try {
        const r = await runHook([WAIT_FLAG], permissionRequest(), {}, { client });
        expect(r.stderr).toBe('');
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual(ALLOW);
        const down = await runHook([], stopEvent(), { JANTAR_HOME: join(dir, 'missing') }, { client });
        expect(down.code).toBe(0);
        expect(down.ms).toBeLessThan(perfBudgetMs(ASYNC_EXIT_BUDGET_MS));
      } finally {
        await srv.close();
      }
    });
  }
});
