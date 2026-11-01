/**
 * v0.6 native Windows (preview): the hook client reaches the daemon's named
 * pipe, tested here with `win32` injected (real pipes run only on
 * windows-latest, test/windows).
 *
 * The client runs as Claude runs it, with one preload that makes Node look
 * like Windows to it: `process.platform` is 'win32', `node:path` is
 * path.win32, `net.createConnection` writes the pipe name it was asked for
 * to a log, then connects to a Unix socket standing in for that pipe, and
 * `fs.readFileSync` of <state dir>\run\hooks.key reads $FAKE_KEY_FILE.
 *
 * Any user can create a pipe of the daemon's name, so the client sends its
 * event only once the pipe's owner has answered a nonce with the HMAC of
 * the daemon's key (hookProof in packages/daemon/src/hooks/socket.ts).
 *
 * The daemon names its pipes with config.ts pipePath; this package does not
 * depend on the daemon, so both sides are pinned to the same names and the
 * same proof here and in packages/daemon/test/hooks/socket-win32.test.ts.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASYNC_EXIT_BUDGET_MS, HOOK_CLIENT_PATH, HOOK_TAG, WAIT_FLAG } from '../src/index.js';
import { perfBudgetMs } from './perf.js';

/** pipePath('C:\\Users\\Sam\\.jantar', kind) in packages/daemon/src/config.ts. */
const HOOKS_PIPE = '\\\\.\\pipe\\jantar-191e58ea65b102a5-hooks';
const PIPE_PREFIX = '\\\\.\\pipe\\';

/** The daemon's hooks key (synthetic), and another one (a stale file, or another user's). */
const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'ef'.repeat(32);
/** hookProof(KEY, 'cd' x 32) in packages/daemon/src/hooks/socket.ts. */
const PINNED_PROOF = 'd8c046f81eeb84e8f69d43830d6bcab36a230c2defd7748184cec9cfea296b55';

/** The daemon's answer to a nonce: hex HMAC-SHA256 of `jantar-hooks-v1 <nonce>` under the key. */
const proofOf = (key: string, nonce: string) => createHmac('sha256', Buffer.from(key, 'hex')).update(`jantar-hooks-v1 ${nonce}`).digest('hex');

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
const keyFs = {
  ...fs,
  readFileSync(file, ...rest) {
    if (typeof file === 'string' && file.endsWith('\\\\run\\\\hooks.key')) {
      fs.appendFileSync(process.env.FAKE_PIPE_LOG, 'key ' + file + '\\n');
      file = process.env.FAKE_KEY_FILE;
    }
    return fs.readFileSync(file, ...rest);
  },
};
process.getBuiltinModule = (id) => (id === 'node:path' || id === 'path' ? path.win32 : id === 'node:fs' ? keyFs : builtin(id));
// Node before 22.3 has no getBuiltinModule: the client then loads its modules with import().
if (process.env.FAKE_NO_BUILTIN) process.getBuiltinModule = undefined;
const connect = net.createConnection;
net.createConnection = function (opts, ...rest) {
  if (opts && typeof opts.path === 'string' && opts.path.startsWith(${JSON.stringify(PIPE_PREFIX)})) {
    fs.appendFileSync(process.env.FAKE_PIPE_LOG, opts.path + '\\n');
    opts = { ...opts, path: path.join(process.env.FAKE_PIPE_DIR, opts.path.slice(${PIPE_PREFIX.length})) };
  }
  return connect.call(this, opts, ...rest);
};
require('node:module').syncBuiltinESMExports();
`;

let dir: string;
let preload: string;
let pipeLog: string;
let keyFile: string;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run the real client "on Windows" with JANTAR_HOME spelled `home`; `env` adds to (or replaces) the fake's settings. */
function runOnWindows(args: string[], input: string, home: string, env: Record<string, string> = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, HOOK_CLIENT_PATH, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, JANTAR_HOME: home, FAKE_PIPE_DIR: dir, FAKE_PIPE_LOG: pipeLog, FAKE_KEY_FILE: keyFile, ...env },
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

/** What the client asked for, in order: the pipe names, and (`key`) the key files it read. */
async function asked(what: 'pipe' | 'key' = 'pipe'): Promise<string[]> {
  const text = await readFile(pipeLog, 'utf8').catch(() => '');
  const lines = text.split('\n').filter(Boolean);
  return what === 'pipe' ? lines.filter((l) => l.startsWith(PIPE_PREFIX)) : lines.filter((l) => l.startsWith('key ')).map((l) => l.slice(4));
}
const pipesAsked = () => asked('pipe');

/**
 * A daemon on the Unix socket that stands in for `pipe`. Holding `key` it
 * answers each connection's hello with the proof, as jantard does, and
 * `handler` sees the next line; with `key` null (a pipe another user made)
 * `handler` sees the first line, whatever it is.
 */
async function fakeDaemon(
  pipe: string,
  handler: (line: string, sock: Socket) => void,
  key: string | null = KEY,
): Promise<{ server: Server; lines: string[]; hellos: string[] }> {
  const lines: string[] = [];
  const hellos: string[] = [];
  const server = createServer((sock) => {
    let buf = '';
    let proven = key === null;
    let seen = false;
    sock.on('error', () => {});
    sock.on('data', (c) => {
      if (seen) return;
      buf += c.toString('utf8');
      for (let nl = buf.indexOf('\n'); nl !== -1 && !seen; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!proven && key !== null) {
          proven = true;
          hellos.push(line);
          sock.write(`${JSON.stringify({ v: 1, mac: proofOf(key, (JSON.parse(line) as { hello: string }).hello) })}\n`);
          continue;
        }
        seen = true;
        lines.push(line);
        handler(line, sock);
      }
    });
  });
  await new Promise<void>((r) => server.listen(join(dir, pipe.slice(PIPE_PREFIX.length)), r));
  return { server, lines, hellos };
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
  keyFile = join(dir, 'hooks.key');
  await writeFile(preload, PRELOAD);
  await writeFile(keyFile, `${KEY}\n`);
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
    expect(await pipesAsked()).toEqual(SPELLINGS.map(() => HOOKS_PIPE));
    // Each spelling's own <state dir>\run\hooks.key, one file to Windows.
    expect((await asked('key')).map((k) => k.toLowerCase())).toEqual(SPELLINGS.map(() => 'c:\\users\\sam\\.jantar\\run\\hooks.key'));
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
      // Each connection opened with a fresh nonce, before the event.
      expect(daemon.hellos).toHaveLength(2);
      for (const h of daemon.hellos) expect(h).toMatch(/^\{"v":1,"hello":"[0-9a-f]{64}"\}$/);
      expect(daemon.hellos[0]).not.toBe(daemon.hellos[1]);
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

describe('the hook client on Windows: only the holder of the key gets the event', () => {
  it('the proof is the one jantard gives (pinned)', () => {
    expect(proofOf(KEY, 'cd'.repeat(32))).toBe(PINNED_PROOF);
  });

  it("a pipe someone else made, answering 'allow', gets only a nonce and no decision is printed", async () => {
    const squat = await fakeDaemon(
      HOOKS_PIPE,
      (_line, sock) => sock.end(`${JSON.stringify({ v: 1, mac: 'ab'.repeat(32) })}\n${JSON.stringify({ v: 1, output: ALLOW })}\n`),
      null,
    );
    try {
      for (const args of [[WAIT_FLAG], []]) {
        const r = await runOnWindows(args, args.length ? permissionRequest() : stopEvent(), SPELLINGS[0] as string);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.stderr).toBe('');
      }
      await expect.poll(() => squat.lines.length).toBe(2);
      for (const l of squat.lines) expect(l).toMatch(/^\{"v":1,"hello":"[0-9a-f]{64}"\}$/);
    } finally {
      await close(squat.server);
    }
  });

  it('a pipe whose owner holds another key (a stale file, another user) gets no event and no decision', async () => {
    const other = await fakeDaemon(HOOKS_PIPE, (_line, sock) => sock.end(`${JSON.stringify({ v: 1, output: ALLOW })}\n`), OTHER_KEY);
    try {
      const r = await runOnWindows([WAIT_FLAG], permissionRequest(), SPELLINGS[0] as string);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(other.hellos).toHaveLength(1);
      expect(other.lines).toEqual([]);
    } finally {
      await close(other.server);
    }
  });

  it('with no key (or a bad one) it sends nothing, prints nothing and exits 0', async () => {
    const daemon = await fakeDaemon(HOOKS_PIPE, (_line, sock) => sock.end(`${JSON.stringify({ v: 1, output: ALLOW })}\n`));
    try {
      await writeFile(join(dir, 'short.key'), 'abc\n');
      for (const file of [join(dir, 'missing.key'), join(dir, 'short.key')]) {
        const r = await runOnWindows([WAIT_FLAG], permissionRequest(), SPELLINGS[0] as string, { FAKE_KEY_FILE: file });
        expect(r.code).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.stderr).toBe('');
        expect(r.ms).toBeLessThan(perfBudgetMs(ASYNC_EXIT_BUDGET_MS));
      }
      expect(await pipesAsked()).toEqual([]);
      expect(daemon.hellos).toEqual([]);
    } finally {
      await close(daemon.server);
    }
  });

  it('on a Node without getBuiltinModule it loads node:crypto and node:fs with import() and still proves the pipe', async () => {
    // A state dir this host can hold (path is POSIX here), so the key is a real file.
    const home = join(dir, 's');
    await mkdir(join(home, 'run'), { recursive: true });
    await writeFile(join(home, 'run', 'hooks.key'), KEY);
    const env = { FAKE_NO_BUILTIN: '1' };
    // The first run, with no daemon, names the pipe.
    expect((await runOnWindows([], stopEvent(), home, env)).code).toBe(0);
    const [pipe] = await pipesAsked();
    expect(pipe).toMatch(/^\\\\\.\\pipe\\jantar-[0-9a-f]{16}-hooks$/);
    const daemon = await fakeDaemon(pipe as string, (_line, sock) => sock.end(`${JSON.stringify({ v: 1, output: ALLOW })}\n`));
    try {
      const r = await runOnWindows([WAIT_FLAG], permissionRequest(), home, env);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual(ALLOW);
      expect(daemon.hellos).toHaveLength(1);
      expect(JSON.parse(daemon.lines[0] as string).tool_name).toBe('Bash');
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
