/**
 * W1 (v0.6 native Windows, preview): the hooks pipe, for real.
 *
 * The daemon's hooks bridge listens on pipePath(state dir, 'hooks'). The
 * real hook client, started exactly as the installer's exec-form entry says
 * (node.exe plus the installed copy, no shell, no JANTAR_HOME), and the
 * repo's client given the state dir in another spelling, each send a held
 * PermissionRequest and print the decision an in-process control device
 * makes. With the daemon down the client exits 0 at once and prints
 * nothing. The pipe's DACL lets no other user write to it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSession } from '@jantar/fixtures';
import { HOOK_CLIENT_PATH } from '@jantar/hook';
import type { Actor } from '@jantar/daemon';
import { ensureStateDirs, pipePath, resolvePaths } from '@jantar/daemon/config';
import { createTestContext } from '@jantar/daemon/core/testing';
import { createHooksBridge } from '@jantar/daemon/hooks/index';
import { desiredGroup, installHookClient, type ExecHookCommand } from '@jantar/daemon/hooks/installer';
import { listenHookSocket } from '@jantar/daemon/hooks/socket';
import { WINDOWS, envWithout, noSessions, noTranscripts, permissionRequest, run, until } from './helpers.js';

const SID = '11111111-1111-4111-8111-111111111111';
const DEVICE: Actor = { kind: 'device', deviceId: 'dev-windows-ci', scopes: ['read', 'control'] };

describe.skipIf(!WINDOWS)('W1: the hooks pipe on Windows', () => {
  let root: string;
  let state: string;
  let hookBin: string;
  let bridge: ReturnType<typeof createHooksBridge>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'jantar-w1-'));
    state = join(root, '.jantar');
    const paths = resolvePaths({ env: { HOME: root, USERPROFILE: root, JANTAR_HOME: state } });
    expect(paths.hooksSock).toBe(pipePath(state, 'hooks'));
    await ensureStateDirs(paths);
    hookBin = (await installHookClient({ hookBin: paths.hookBin })).path;
    const ctx = createTestContext({ paths, userHome: root });
    bridge = createHooksBridge(ctx, { sessions: noSessions(), transcripts: noTranscripts() }, { reorderMs: 0, resolveTty: false });
    await bridge.start();
    // A live interactive session the daemon knows, so its PermissionRequest is held.
    const session = makeSession({ sid: SID, pid: process.pid, status: 'working', statusSource: 'hook', configDir: join(root, '.claude'), cwd: join(root, 'app') });
    ctx.store.emit({ type: 'session.added', sid: SID, data: { session } });
  });

  afterAll(async () => {
    await bridge?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const openCards = () => bridge.open().filter((c) => c.state === 'open');

  /** Wait for the one open card, answer it, and return the client's result. */
  async function answer(client: Promise<Awaited<ReturnType<typeof run>>>, behavior: 'allow' | 'deny') {
    await until(() => openCards().length === 1, 20_000, 'the card to open');
    const card = openCards()[0]!;
    expect(card).toMatchObject({ sid: SID, kind: 'permission', tool: 'PowerShell', state: 'open' });
    const r = await bridge.decide(card.id, { behavior }, DEVICE);
    expect(r.ok).toBe(true);
    return client;
  }

  it('the installed client, run as the exec-form entry says, prints the decision', async () => {
    const hook = desiredGroup('PermissionRequest', { node: process.execPath, hookBin }).hooks[0] as ExecHookCommand;
    expect(hook).toMatchObject({ command: process.execPath, args: [hookBin, '--wait'], onFailure: 'continue' });
    const client = run(hook.command, hook.args, { env: envWithout(), input: permissionRequest(SID, join(root, 'app')) });
    const r = await answer(client, 'allow');
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('the client given the state dir in another spelling reaches the same pipe', async () => {
    const spelled = `${state.toUpperCase().replace(/\\/g, '/')}/`;
    const input = permissionRequest(SID, join(root, 'app'), 'Get-Date');
    const client = run(process.execPath, [HOOK_CLIENT_PATH, '--wait'], { env: { ...envWithout(), JANTAR_HOME: spelled }, input });
    const r = await answer(client, 'deny');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it("no other user can write to the pipe: the DACL's broad entries are read only", async (ctx) => {
    const pipe = pipePath(join(root, 'acl'), 'hooks');
    const server = await listenHookSocket({ path: pipe, log: createTestContext().log, onLine: () => {} });
    try {
      // Windows PowerShell reads a pipe's security descriptor like a file's.
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$acl = Get-Acl -LiteralPath $env:JANTAR_PIPE',
        '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
        "ConvertTo-Json -Compress -InputObject @($rules | ForEach-Object { @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [int64]$_.FileSystemRights.value__ } })",
      ].join('; ');
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, JANTAR_PIPE: pipe } });
      let rules: Array<{ sid: string; allow: boolean; rights: number }> = [];
      try {
        rules = JSON.parse(r.stdout) as typeof rules;
      } catch {
        rules = [];
      }
      if (r.code !== 0 || rules.length === 0) ctx.skip(`this runner could not read the pipe's DACL: ${r.stderr.trim().slice(0, 200)}`);
      // Everyone, anonymous, network, authenticated users, Users.
      const broad = new Set(['S-1-1-0', 'S-1-5-7', 'S-1-5-2', 'S-1-5-11', 'S-1-5-32-545']);
      // FILE_WRITE_DATA, FILE_APPEND_DATA, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE.
      const WRITE = 0x2 | 0x4 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
      for (const rule of rules) {
        if (rule.allow && broad.has(rule.sid)) expect((rule.rights >>> 0) & WRITE, `${rule.sid} may write`).toBe(0);
      }
    } finally {
      await server.close();
    }
  });

  it('with the daemon down the client exits 0 at once and prints nothing, waiting or not', async () => {
    await bridge.stop();
    for (const args of [[hookBin], [hookBin, '--wait']]) {
      const r = await run(process.execPath, args, { env: envWithout(), input: permissionRequest(SID, join(root, 'app')) });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      expect(r.ms).toBeLessThan(5000);
    }
  });
});
