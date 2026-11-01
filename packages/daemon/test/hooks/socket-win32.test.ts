/**
 * v0.6 native Windows (preview): the hooks socket on a named pipe, tested
 * here with a pipe name and a Unix socket standing in for the pipe (real
 * pipes run only on windows-latest, test/windows). A pipe is no file: the
 * daemon makes no dir for it, sets no mode, probes or removes no stale file.
 *
 * The pipe names are pinned to the same values as the hook client's test
 * (packages/hook/test/pipe-name.test.ts), so the daemon and the client agree.
 */
import * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPipePath, pipePath, resolvePaths } from '../../src/config.js';
import { listenHookSocket, type HookConn, type HookSocketServer } from '../../src/hooks/socket.js';
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

async function listen(path: string, onLine: (conn: HookConn, line: string) => void = () => {}): Promise<HookSocketServer> {
  const ctx = createTestContext();
  const s = await listenHookSocket({ path, log: ctx.log, onLine });
  servers.push(s);
  return s;
}

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

  it('a second daemon on the same pipe is refused, as a live socket is', async () => {
    await listen(HOOKS_PIPE);
    await expect(listen(HOOKS_PIPE)).rejects.toThrow(`another process is already listening on ${HOOKS_PIPE}`);
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
