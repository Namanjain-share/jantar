/**
 * The real `jantard` executable (packages/daemon/bin/jantard.mjs, which loads
 * the compiled dist/): flags, startup on a synthetic HOME, and a clean stop
 * on SIGTERM that leaves no socket and no process behind.
 *
 * Needs `pnpm -r build` first (CI builds before testing); skipped otherwise.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { makeFakeHome, perfBudgetMs, type FakeHome } from '@jantar/fixtures';
import { callDaemon, createCtlClient } from '../../packages/cli/src/index.js';
import { fakeBinsSettings, freePort } from './harness.js';
import { eventually, http } from './http.js';

const DAEMON_BIN = fileURLToPath(new URL('../../packages/daemon/bin/jantard.mjs', import.meta.url));
const DIST_MAIN = fileURLToPath(new URL('../../packages/daemon/dist/main.js', import.meta.url));
const built = existsSync(DIST_MAIN);
if (!built) console.warn('[integration] jantard binary tests skipped: run `pnpm -r build` first');

function exitOf(child: ChildProcess, ms: number): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const t = setTimeout(() => reject(new Error(`jantard did not exit within ${ms} ms`)), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

describe.skipIf(!built)('the jantard binary', () => {
  let home: FakeHome | undefined;
  let child: ChildProcess | undefined;

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await home?.cleanup();
  });

  it('answers --version and --help, and rejects unknown flags', () => {
    const v = spawnSync(process.execPath, [DAEMON_BIN, '--version'], { encoding: 'utf8' });
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/^jantard \d+\.\d+\.\d+/);
    const h = spawnSync(process.execPath, [DAEMON_BIN, '--help'], { encoding: 'utf8' });
    expect(h.status).toBe(0);
    for (const flag of ['--port', '--home', '--no-terminal', '--read-only']) expect(h.stdout).toContain(flag);
    const bad = spawnSync(process.execPath, [DAEMON_BIN, '--bogus'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unknown option: --bogus');
  });

  it('starts with --home/--port/--no-terminal/--read-only and stops cleanly on SIGTERM', async () => {
    home = await makeFakeHome({ now: Date.now() });
    // --home must win over $JANTAR_HOME
    const stateDir = join(home.root, 'st');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const settings = { usage: { poller: 'off' }, bins: fakeBinsSettings(home) };
    await writeFile(join(stateDir, 'config.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    const port = await freePort();

    let stderr = '';
    child = spawn(process.execPath, [DAEMON_BIN, '--no-terminal', '--read-only', '--port', String(port), '--home', stateDir], {
      env: { ...home.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.stdout?.resume();

    const ctlSock = join(stateDir, 'run', 'ctl.sock');
    const hooksSock = join(stateDir, 'run', 'hooks.sock');
    const ctl = createCtlClient(ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 20_000, `the control socket (stderr: ${stderr.slice(-500)})`);
    expect(existsSync(hooksSock)).toBe(true);
    expect(existsSync(join(home.jantarHome, 'run', 'ctl.sock'))).toBe(false);

    expect((await http(port, 'GET', '/healthz')).status).toBe(200);
    expect((await http(port, 'GET', '/v1/state')).status).toBe(401);
    const st = await callDaemon<{ api: { port: number }; mode: { readOnly: boolean; terminal: string } }>(ctl, 'GET', '/ctl/status');
    expect(st.api.port).toBe(port);
    expect(st.mode).toEqual({ readOnly: true, terminal: 'off' });

    child.kill('SIGTERM');
    const exit = await exitOf(child, 15_000);
    expect(exit, stderr.slice(-2000)).toEqual({ code: 0, signal: null });
    expect(existsSync(ctlSock)).toBe(false);
    expect(existsSync(hooksSock)).toBe(false);
    expect(stderr).toContain('"msg":"jantard started"');
    expect(stderr).toContain('"msg":"jantard stopped"');
    expect(stderr).not.toContain('uncaught exception');
    expect(stderr).not.toContain('unhandled rejection');
    expect(await home.calls('osascript')).toEqual([]);
  }, perfBudgetMs(60_000));
});
