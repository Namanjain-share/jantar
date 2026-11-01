/**
 * v0.6 native Windows (preview): the hook client reaches the daemon's named
 * pipe, tested here with `win32` injected (real pipes run only on
 * windows-latest, test/windows).
 *
 * The client runs as Claude runs it, with one preload that makes Node look
 * like Windows to it: `process.platform` is 'win32', `node:path` is
 * path.win32, and `net.createConnection` writes the pipe name it was asked
 * for to a log, then connects to a Unix socket standing in for that pipe.
 *
 * The daemon names its pipes with config.ts pipePath; this package does not
 * depend on the daemon, so both sides are pinned to the same names here and
 * in packages/daemon/test/hooks/socket-win32.test.ts.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASYNC_EXIT_BUDGET_MS, HOOK_CLIENT_PATH, HOOK_TAG, WAIT_FLAG } from '../src/index.js';
import { perfBudgetMs } from './perf.js';

/** pipePath('C:\\Users\\Sam\\.jantar', kind) in packages/daemon/src/config.ts. */
const HOOKS_PIPE = '\\\\.\\pipe\\jantar-191e58ea65b102a5-hooks';
const PIPE_PREFIX = '\\\\.\\pipe\\';

/** Every way a user or a service line might spell that one state dir. */
const SPELLINGS = [
  'C:\\Users\\Sam\\.jantar',
  'c:/users/sam/.jantar/',
  'C:\\Users\\Sam\\.jantar\\',
  'C:/users/Sam/.jantar',
  'C:\\USERS\\SAM\\.JANTAR\\\\',
  'C:\\Users\\Sam\\work\\..\\.jantar',
  'C:\\Users\\Sam\\.\\.jantar',
];

const PRELOAD = `'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
Object.defineProperty(process, 'platform', { value: 'win32' });
const builtin = process.getBuiltinModule.bind(process);
process.getBuiltinModule = (id) => (id === 'node:path' || id === 'path' ? path.win32 : builtin(id));
const connect = net.createConnection;
net.createConnection = function (opts, ...rest) {
  if (opts && typeof opts.path === 'string' && opts.path.startsWith(${JSON.stringify(PIPE_PREFIX)})) {
    fs.appendFileSync(process.env.FAKE_PIPE_LOG, opts.path + '\\n');
    opts = { ...opts, path: path.join(process.env.FAKE_PIPE_DIR, opts.path.slice(${PIPE_PREFIX.length})) };
  }
  return connect.call(this, opts, ...rest);
};
`;

let dir: string;
let preload: string;
let pipeLog: string;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run the real client "on Windows" with JANTAR_HOME spelled `home`. */
function runOnWindows(args: string[], input: string, home: string): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, HOOK_CLIENT_PATH, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, JANTAR_HOME: home, FAKE_PIPE_DIR: dir, FAKE_PIPE_LOG: pipeLog },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** The pipe names the client asked for, in order. */
async function pipesAsked(): Promise<string[]> {
  const text = await readFile(pipeLog, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean);
}

/** A daemon on the Unix socket that stands in for `pipe`; `handler` sees each line. */
async function fakeDaemon(pipe: string, handler: (line: string, sock: Socket) => void): Promise<{ server: Server; lines: string[] }> {
  const lines: string[] = [];
  const server = createServer((sock) => {
    let buf = '';
    let seen = false;
    sock.on('error', () => {});
    sock.on('data', (c) => {
      if (seen) return;
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      seen = true;
      const line = buf.slice(0, nl);
      lines.push(line);
      handler(line, sock);
    });
  });
  await new Promise<void>((r) => server.listen(join(dir, pipe.slice(PIPE_PREFIX.length)), r));
  return { server, lines };
}

const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

function permissionRequest(): string {
  return JSON.stringify({
    hook_event_name: 'PermissionRequest',
    session_id: 'synthetic-session-1',
    transcript_path: 'C:\\Users\\Sam\\.claude\\projects\\C--Users-Sam-app\\synthetic.jsonl',
    cwd: 'C:\\Users\\Sam\\app',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
}

const stopEvent = () => JSON.stringify({ hook_event_name: 'Stop', session_id: 'synthetic-session-1', last_assistant_message: 'Done.' });

beforeEach(async () => {
  // Short: the stand-in sockets live here, under macOS's 104-byte socket path limit.
  dir = await mkdtemp(join(tmpdir(), 'jp-'));
  preload = join(dir, 'as-windows.cjs');
  pipeLog = join(dir, 'pipes.log');
  await writeFile(preload, PRELOAD);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the hook client on Windows (win32 injected)', () => {
  it("asks for the daemon's hooks pipe, the same name for every spelling of the state dir", async () => {
    for (const home of SPELLINGS) {
      const r = await runOnWindows([], stopEvent(), home);
      expect(r.code, home).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    }
    const asked = await pipesAsked();
    expect(asked).toEqual(SPELLINGS.map(() => HOOKS_PIPE));
    // Another state dir is another pipe.
    await runOnWindows([], stopEvent(), 'C:\\Users\\Sam\\.jantar-test');
    const other = (await pipesAsked()).at(-1);
    expect(other).toMatch(/^\\\\\.\\pipe\\jantar-[0-9a-f]{16}-hooks$/);
    expect(other).not.toBe(HOOKS_PIPE);
  });

  it('with the pipe absent it exits 0 at once and prints nothing, waiting or not', async () => {
    for (const args of [[], [WAIT_FLAG]]) {
      const r = await runOnWindows(args, args.length ? permissionRequest() : stopEvent(), SPELLINGS[1] as string);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      expect(r.ms).toBeLessThan(perfBudgetMs(ASYNC_EXIT_BUDGET_MS));
    }
    expect(await pipesAsked()).toEqual([HOOKS_PIPE, HOOKS_PIPE]);
  });

  it('sends the tagged event over the pipe and prints the decision a waiting run gets back', async () => {
    const daemon = await fakeDaemon(HOOKS_PIPE, (line, sock) => {
      if (JSON.parse(line)[HOOK_TAG].wait) sock.end(`${JSON.stringify({ v: 1, output: ALLOW })}\n`);
    });
    try {
      const r = await runOnWindows([WAIT_FLAG], permissionRequest(), 'c:/users/sam/.jantar/');
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual(ALLOW);
      const async = await runOnWindows([], stopEvent(), 'C:\\Users\\Sam\\.jantar');
      expect(async.code).toBe(0);
      expect(async.stdout).toBe('');
      await expect.poll(() => daemon.lines.length).toBe(2);
      const [held, stop] = daemon.lines.map((l) => JSON.parse(l));
      expect(held.tool_name).toBe('Bash');
      expect(held[HOOK_TAG]).toMatchObject({ v: 1, wait: true });
      expect(stop.hook_event_name).toBe('Stop');
      expect(stop[HOOK_TAG].wait).toBe(false);
    } finally {
      await close(daemon.server);
    }
  });

  it('prints nothing when the daemon closes the pipe without a decision', async () => {
    const daemon = await fakeDaemon(HOOKS_PIPE, (_line, sock) => sock.end());
    try {
      const r = await runOnWindows([WAIT_FLAG], permissionRequest(), SPELLINGS[0] as string);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    } finally {
      await close(daemon.server);
    }
  });
});

describe('the hook client off Windows', () => {
  it('loads no node:crypto and connects to <state dir>/run/hooks.sock, as before', async () => {
    const watch = join(dir, 'watch.cjs');
    const log = join(dir, 'loaded.log');
    await writeFile(
      watch,
      `'use strict';
const fs = require('node:fs');
const net = require('node:net');
const builtin = process.getBuiltinModule.bind(process);
process.getBuiltinModule = (id) => (fs.appendFileSync(${JSON.stringify(log)}, 'module ' + id + '\\n'), builtin(id));
const connect = net.createConnection;
net.createConnection = function (opts, ...rest) {
  fs.appendFileSync(${JSON.stringify(log)}, 'path ' + opts.path + '\\n');
  return connect.call(this, opts, ...rest);
};
`,
    );
    const state = join(dir, 's');
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', watch, HOOK_CLIENT_PATH], {
        env: { PATH: process.env.PATH ?? '', HOME: dir, JANTAR_HOME: state },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(stopEvent());
    });
    expect(code).toBe(0);
    const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    expect(lines).toEqual(['module node:net', 'module node:os', 'module node:path', `path ${join(state, 'run', 'hooks.sock')}`]);
  });
});
