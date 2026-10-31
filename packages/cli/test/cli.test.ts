import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePaths } from '@jantar/daemon/config';
import { COMMANDS, CtlUnavailableError, EXIT, createCtlClient, helpText, isErrorBody, main, memoryIo } from '../src/index.js';

describe('jantar command line', () => {
  it('lists every v0.1 command in help', async () => {
    const io = memoryIo();
    expect(await main(['help'], { io })).toBe(EXIT.ok);
    for (const name of ['install', 'uninstall', 'doctor', 'pair', 'remote', 'hooks', 'status', 'send', 'open', 'version']) {
      expect(io.stdout).toContain(`  ${name}`);
    }
    expect(helpText()).toMatch(/^usage: jantar <command>/);
    const bare = memoryIo();
    expect(await main([], { io: bare })).toBe(EXIT.usage);
  });

  it('prints per-command usage', async () => {
    const io = memoryIo();
    expect(await main(['help', 'hooks'], { io })).toBe(EXIT.ok);
    expect(io.stdout).toContain('jantar hooks <install|uninstall|status>');
    expect(io.stdout).toContain('--apply');
    expect(await main(['help', 'nope'], { io: memoryIo() })).toBe(EXIT.usage);
  });

  it('prints the version', async () => {
    const io = memoryIo();
    expect(await main(['--version'], { io })).toBe(EXIT.ok);
    // Protocol 3 since v0.4 (NotifyKind gained med and life).
    expect(io.stdout).toMatch(/^jantar \d+\.\d+\.\d+ \(protocol 3\)\n$/);
  });

  it('registers the v0.3 commands, built by T2: each has help and refuses a missing action', async () => {
    for (const name of ['files', 'folders', 'launch', 'devices', 'rewrite', 'controls', 'screenshots', 'new']) {
      const cmd = COMMANDS.find((c) => c.name === name);
      expect(cmd?.owner, name).toBe('T2');
      const help = memoryIo({ HOME: '/nonexistent/jantar-test-home' });
      expect(await main([name, '--help'], { io: help }), name).toBe(EXIT.ok);
      expect(help.stdout).toContain(`usage: jantar ${name} <`);
      const bare = memoryIo({ HOME: '/nonexistent/jantar-test-home' });
      expect(await main([name], { io: bare }), name).toBe(EXIT.usage);
      expect(bare.stderr).not.toContain('not implemented');
    }
    const io = memoryIo();
    expect(await main(['help'], { io })).toBe(EXIT.ok);
    expect(io.stdout).toContain('  new  ');
  });

  it('registers the v0.4 commands as stubs until their packages land: help works, a run says not built yet', async () => {
    for (const [name, owner] of [['life', 'WP-LS'], ['intel', 'WP-IN'], ['accounts', 'WP-OSS'], ['init', 'WP-OSS']] as const) {
      const cmd = COMMANDS.find((c) => c.name === name);
      expect(cmd?.owner, name).toBe(owner);
      const help = memoryIo({ HOME: '/nonexistent/jantar-test-home' });
      expect(await main([name, '--help'], { io: help }), name).toBe(EXIT.ok);
      expect(help.stdout).toContain(`usage: jantar ${name}`);
      // A stub exits 2 with "Not built yet."; the real command, once built (no `stub`), answers for itself.
      if (cmd?.stub) {
        const run = memoryIo({ HOME: '/nonexistent/jantar-test-home' });
        expect(await main([name], { io: run }), name).toBe(EXIT.usage);
        expect(run.stderr).toBe('Not built yet.\n');
      }
    }
  });

  it('rejects unknown commands with usage', async () => {
    const io = memoryIo();
    expect(await main(['frobnicate'], { io })).toBe(EXIT.usage);
    expect(io.stderr).toContain('unknown command "frobnicate"');
  });

  it('has an owner for every command', async () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // v0.1 packages A-G; the v0.3 commands belong to wave 2's T2; v0.4's to its wave-1 packages (WP-LS, WP-IN, WP-OSS).
    for (const c of COMMANDS) expect(c.owner).toMatch(/^([A-G]|T2|WP-[A-Z]+)$/);
    const io = memoryIo({ HOME: '/nonexistent/jantar-test-home' });
    const code = await main(['status'], { io });
    // either the real command (daemon down) or the scaffold stub
    expect([EXIT.notImplemented, EXIT.daemonDown, EXIT.failed]).toContain(code);
  });
});

describe('control socket client', () => {
  let dir: string;
  let server: Server;
  let socketPath: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'jantar-test-')));
    socketPath = join(dir, 'ctl.sock');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/sessions') {
          res.end(JSON.stringify({ sessions: [], echo: { method: req.method, key: req.headers['idempotency-key'] ?? null, body: body || null } }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  it('speaks JSON over HTTP on the Unix socket', async () => {
    const ctl = createCtlClient(socketPath);
    const r = await ctl.request<{ echo: unknown }>('POST', '/v1/sessions', { a: 1 }, { idempotencyKey: 'k1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ echo: { method: 'POST', key: 'k1', body: '{"a":1}' } });
    const nf = await ctl.request('GET', '/v1/nope');
    expect(nf.status).toBe(404);
    expect(isErrorBody(nf.body)).toBe(true);
  });

  it('explains when the daemon is down', async () => {
    const ctl = createCtlClient(join(dir, 'missing.sock'));
    await expect(ctl.request('GET', '/v1/state')).rejects.toBeInstanceOf(CtlUnavailableError);
    await expect(ctl.request('GET', '/v1/state')).rejects.toThrow(/not running/);
  });

  it('defaults to the control socket under JANTAR_HOME', () => {
    const paths = resolvePaths({ env: { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' } });
    expect(paths.ctlSock).toBe('/synthetic/state/run/ctl.sock');
  });
});
