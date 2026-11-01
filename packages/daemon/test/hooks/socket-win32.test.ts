/**
 * v0.6 native Windows (preview): the hooks socket on a named pipe, tested
 * here with a pipe name and a Unix socket standing in for the pipe (real
 * pipes run only on windows-latest, test/windows). A pipe is no file: the
 * daemon makes no dir for it, sets no mode, probes or removes no stale file.
 *
 * Pipe names are machine-wide, so another user could create the daemon's
 * first: on a pipe the daemon writes a fresh key to its key file and answers
 * each client's nonce with hookProof before it reads the event.
 *
 * The pipe names and the proof are pinned to the same values as the hook
 * client's test (packages/hook/test/pipe-name.test.ts), so the daemon and the
 * client agree; one case runs the real client against this socket.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_CLIENT_PATH, WAIT_FLAG } from '@jantar/hook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPipePath, pipePath, resolvePaths } from '../../src/config.js';
import { HOOKS_KEY_FILE, hookProof, listenHookSocket, type HookConn, type HookSocketServer } from '../../src/hooks/socket.js';
import { createTestContext } from '../../src/core/testing.js';
import { send, waitFor } from './helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, chmod: vi.fn(real.chmod), lstat: vi.fn(real.lstat), mkdir: vi.fn(real.mkdir), unlink: vi.fn(real.unlink) };
});

/** pipePath('C:\\Users\\Sam\\.jantar', kind), as the hook client names it too. */
const HOOKS_PIPE = '\\\\.\\pipe\\jantar-191e58ea65b102a5-hooks';
const CTL_PIPE = '\\\\.\\pipe\\jantar-191e58ea65b102a5-ctl';
const PIPE_PREFIX = '\\\\.\\pipe\\';
/** hookProof(key 'ab' x 32, nonce 'cd' x 32), as the hook client's test pins it. */
const PINNED_PROOF = 'd8c046f81eeb84e8f69d43830d6bcab36a230c2defd7748184cec9cfea296b55';
const NONCE = 'cd'.repeat(32);

let dir: string;
let servers: HookSocketServer[];

/** Where the stand-in Unix socket for `pipe` lives. */
const standIn = (pipe: string) => join(dir, pipe.slice(PIPE_PREFIX.length));

/** The fs calls the socket made for anything but the temp dir's own setup. */
function fsCalls(): string[] {
  const out: string[] = [];
  for (const name of ['chmod', 'lstat', 'mkdir', 'unlink'] as const) {
    for (const args of vi.mocked(fs[name]).mock.calls) out.push(`${name} ${String(args[0])}`);
  }
  return out;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jw-'));
  servers = [];
  // Node on Windows listens on the pipe itself; here the pipe name maps to a Unix socket.
  const listen = Server.prototype.listen;
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
    const [first, ...rest] = args;
    const path = typeof first === 'string' && isPipePath(first) ? standIn(first) : first;
    return (listen as (...a: unknown[]) => Server).call(this, path, ...rest);
  });
  for (const name of ['chmod', 'lstat', 'mkdir', 'unlink'] as const) vi.mocked(fs[name]).mockClear();
});

afterEach(async () => {
  for (const s of servers) await s.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

async function listen(path: string, onLine: (conn: HookConn, line: string) => void = () => {}, keyFile?: string): Promise<HookSocketServer> {
  const ctx = createTestContext();
  const s = await listenHookSocket({ path, log: ctx.log, onLine, ...(keyFile ? { keyFile } : {}) });
  servers.push(s);
  return s;
}

/** Connect to `path`, write `first`, call `then` on the first reply line, and collect everything until the far side closes (or `ms`). */
function talk(path: string, first: string, opts: { then?: (sock: Socket, firstReply: string) => void; ms?: number } = {}): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect({ path });
    let got = '';
    let replied = false;
    const t = setTimeout(() => sock.destroy(), opts.ms ?? 2000);
    sock.on('data', (c) => {
      got += c.toString('utf8');
      const nl = got.indexOf('\n');
      if (!replied && nl !== -1) {
        replied = true;
        opts.then?.(sock, got.slice(0, nl));
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(t);
      resolve(got);
    });
    sock.on('connect', () => sock.write(first));
  });
}

const helloLine = (nonce: string) => `${JSON.stringify({ v: 1, hello: nonce })}\n`;

describe('the hooks pipe (win32 names)', () => {
  it('the daemon names the pipes the hook client asks for, for every spelling of the state dir', () => {
    for (const home of ['C:\\Users\\Sam\\.jantar', 'c:/users/sam/.jantar/', 'C:\\USERS\\SAM\\.JANTAR\\\\', 'C:\\Users\\Sam\\work\\..\\.jantar']) {
      expect(pipePath(home, 'hooks'), home).toBe(HOOKS_PIPE);
      expect(pipePath(home, 'ctl'), home).toBe(CTL_PIPE);
    }
    const paths = resolvePaths({ platform: 'win32', env: { JANTAR_HOME: 'C:\\Users\\Sam\\.jantar' }, home: 'C:\\Users\\Sam\\.jantar' });
    // resolve() on this host makes a POSIX path of it; the name still comes from pipePath of that home.
    expect(paths.hooksSock).toBe(pipePath(paths.home, 'hooks'));
    expect(isPipePath(paths.hooksSock)).toBe(true);
  });

  it('listens with no dir, mode, stale-file probe or inode, and takes one event per connection', async () => {
    const lines: string[] = [];
    const s = await listen(HOOKS_PIPE, (conn, line) => {
      lines.push(line);
      conn.reply('{"v":1,"output":null}\n');
    });
    expect(s.path).toBe(HOOKS_PIPE);
    expect(fsCalls()).toEqual([]);
    const sent = send(standIn(HOOKS_PIPE), { hook_event_name: 'Stop' }, { keepOpen: true });
    expect(await sent.reply).toBe('{"v":1,"output":null}\n');
    expect(lines).toEqual(['{"hook_event_name":"Stop"}']);
    await waitFor(() => s.connections() === 0, 3000, 'the connection to close');
    await s.close();
    expect(fsCalls()).toEqual([]);
  });

  it('a second daemon on the same pipe is refused, as a live socket is, and the error says it may be posing as one', async () => {
    await listen(HOOKS_PIPE);
    await expect(listen(HOOKS_PIPE)).rejects.toThrow(`another process is already listening on ${HOOKS_PIPE}`);
    await expect(listen(HOOKS_PIPE)).rejects.toThrow(/posing as one/);
  });

  it('a socket path still gets its 0700 dir, 0600 mode and stale-file check', async () => {
    const path = join(dir, 'run', 'hooks.sock');
    const s = await listen(path);
    const calls = fsCalls();
    expect(calls).toContain(`mkdir ${join(dir, 'run')}`);
    expect(calls).toContain(`chmod ${path}`);
    expect(calls).toContain(`lstat ${path}`);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    const lstats = () => fsCalls().filter((c) => c === `lstat ${path}`).length;
    const before = lstats();
    await s.close();
    // On close it checks the file is still its own before removing it (libuv may have removed it already).
    expect(lstats()).toBe(before + 1);
  });
});

describe('the hooks pipe proves itself with the key (win32 names)', () => {
  it('the proof is the HMAC the hook client checks (pinned)', () => {
    expect(hookProof(Buffer.from('ab'.repeat(32), 'hex'), NONCE)).toBe(PINNED_PROOF);
    expect(HOOKS_KEY_FILE).toBe('hooks.key');
  });

  it('writes a fresh key each start, answers the hello with its proof, then takes the event', async () => {
    const keyFile = join(dir, 'run', HOOKS_KEY_FILE);
    const lines: string[] = [];
    const s = await listen(
      HOOKS_PIPE,
      (conn, line) => {
        lines.push(line);
        conn.reply('{"v":1,"output":null}\n');
      },
      keyFile,
    );
    const key = (await readFile(keyFile, 'utf8')).trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const got = await talk(standIn(HOOKS_PIPE), helloLine(NONCE), { then: (sock) => sock.write('{"hook_event_name":"PermissionRequest"}\n') });
    expect(got).toBe(`{"v":1,"mac":"${hookProof(Buffer.from(key, 'hex'), NONCE)}"}\n{"v":1,"output":null}\n`);
    expect(lines).toEqual(['{"hook_event_name":"PermissionRequest"}']);

    // An async client may send its event right behind the hello and half-close.
    const sent = send(standIn(HOOKS_PIPE), null, { raw: `${helloLine(NONCE)}{"hook_event_name":"Stop"}` });
    await sent.closed;
    await waitFor(() => lines.length === 2, 3000, 'the async event');
    expect(lines[1]).toBe('{"hook_event_name":"Stop"}');

    await s.close();
    await listen(HOOKS_PIPE, () => {}, keyFile);
    expect((await readFile(keyFile, 'utf8')).trim()).not.toBe(key);
  });

  it('a connection that opens with anything but a hello is closed unheard', async () => {
    const lines: string[] = [];
    await listen(HOOKS_PIPE, (_c, line) => lines.push(line), join(dir, 'run', HOOKS_KEY_FILE));
    for (const first of ['{"hook_event_name":"PermissionRequest"}\n', helloLine('not-hex'), '{"v":2,"hello":"cd"}\n', 'x\n']) {
      expect(await talk(standIn(HOOKS_PIPE), first), first).toBe('');
    }
    // Half-closed without a newline: no event either.
    const sent = send(standIn(HOOKS_PIPE), null, { raw: '{"hook_event_name":"Stop"}' });
    await sent.closed;
    expect(lines).toEqual([]);
  });

  it("a refused second daemon leaves the first one's key alone", async () => {
    const keyFile = join(dir, 'run', HOOKS_KEY_FILE);
    await listen(HOOKS_PIPE, () => {}, keyFile);
    const key = await readFile(keyFile, 'utf8');
    await expect(listen(HOOKS_PIPE, () => {}, keyFile)).rejects.toThrow(/already listening/);
    expect(await readFile(keyFile, 'utf8')).toBe(key);
  });

  it('a socket path ignores the key file: no key, no hello, the event as before', async () => {
    const path = join(dir, 'run', 'hooks.sock');
    const keyFile = join(dir, 'run', HOOKS_KEY_FILE);
    const lines: string[] = [];
    await listen(path, (_c, line) => lines.push(line), keyFile);
    await expect(readFile(keyFile)).rejects.toThrow(/ENOENT/);
    const sent = send(path, { hook_event_name: 'Stop' });
    await sent.closed;
    await waitFor(() => lines.length === 1, 3000, 'the event');
    expect(lines).toEqual(['{"hook_event_name":"Stop"}']);
  });

  it('the real hook client, "on Windows", proves the pipe and prints the decision', async () => {
    const keyFile = join(dir, 'run', HOOKS_KEY_FILE);
    const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    const lines: string[] = [];
    await listen(
      HOOKS_PIPE,
      (conn, line) => {
        lines.push(line);
        conn.reply(`${JSON.stringify({ v: 1, output: allow })}\n`);
      },
      keyFile,
    );
    // process.platform 'win32', node:path win32, the pipe name to its stand-in, the key file to this one.
    const preload = join(dir, 'as-windows.cjs');
    await writeFile(
      preload,
      `'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
Object.defineProperty(process, 'platform', { value: 'win32' });
const builtin = process.getBuiltinModule.bind(process);
const keyFs = { ...fs, readFileSync: (f, ...r) => fs.readFileSync(String(f).endsWith('\\\\run\\\\hooks.key') ? process.env.FAKE_KEY_FILE : f, ...r) };
process.getBuiltinModule = (id) => (id === 'node:path' ? path.win32 : id === 'node:fs' ? keyFs : builtin(id));
const connect = net.createConnection;
net.createConnection = function (opts, ...rest) {
  if (opts && typeof opts.path === 'string' && opts.path.startsWith(${JSON.stringify(PIPE_PREFIX)})) {
    opts = { ...opts, path: path.join(process.env.FAKE_PIPE_DIR, opts.path.slice(${PIPE_PREFIX.length})) };
  }
  return connect.call(this, opts, ...rest);
};
`,
    );
    const input = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'synthetic-session-1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const r = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', preload, HOOK_CLIENT_PATH, WAIT_FLAG], {
        env: { PATH: process.env.PATH ?? '', HOME: dir, JANTAR_HOME: 'c:/users/sam/.jantar/', FAKE_PIPE_DIR: dir, FAKE_KEY_FILE: keyFile },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(input);
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(allow);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ tool_name: 'Bash', _jantar: { wait: true } });
  });
});
