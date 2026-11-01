/**
 * W3-W6 (v0.6 native Windows, preview): a node on a Windows profile, for
 * real, linked to a hub in this process on 127.0.0.1.
 *
 * - W3: a node-mode daemon on a temp %USERPROFILE% with session files in
 *   .claude\sessions and .claude-work\sessions: both discovered (no `ps`
 *   on Windows), accounts `dirs`, transcripts from the C--Users-... dirs.
 * - W4: the node links to the hub; its sessions show there; a card the
 *   real hook client holds on the node's pipe is answered by a phone on
 *   the hub (a forwarded decidePending).
 * - W5: a prompt to a Windows session is refused with the watch-only line;
 *   the hub's view of the node has controls and launch off.
 * - W6: `jantar node status` on the node, over its ctl pipe.
 *
 * Synthetic names only; the hub's door is plain http on loopback.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantText, encodeProjectDir, timeline, toJsonl, userPrompt, windowsHome, writeHomeLayout } from '@jantar/fixtures';
import {
  DEVICE_COOKIE,
  FLEET_COPY,
  type MachinesPairReply,
  type PairStartResponse,
  type PendingRequest,
  type SessionsResponse,
  type StateResponse,
  type TranscriptResponse,
} from '@jantar/protocol';
import { DAEMON_VERSION, memoryLogger } from '@jantar/daemon';
import { resolvePaths } from '@jantar/daemon/config';
import { startDaemon, type RunningDaemon } from '@jantar/daemon/daemon';
import { installHookClient } from '@jantar/daemon/hooks/installer';
import { pairWithHub } from '@jantar/daemon/link/join';
import { writeNodeFile } from '@jantar/daemon/link/keys';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { cookieFrom, http, rememberSecret } from '../integration/http.js';
import { WINDOWS, envWithout, freePort, permissionRequest, run, until } from './helpers.js';

const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const CLI = fileURLToPath(new URL('../../packages/cli/bin/jantar.mjs', import.meta.url));

describe.skipIf(!WINDOWS)('W3-W6: a native Windows node', () => {
  let root: string;
  let profile: string;
  let nodeState: string;
  let hub: RunningDaemon | undefined;
  let node: RunningDaemon | undefined;
  let hubCtl: CtlClient;
  let nodeCtl: CtlClient;
  let port: number;
  let nodeName: string;
  let nodeId: string;
  let cookie: string;
  /** Stands in for the second account's Claude: a live process whose pid the session file names. */
  let other: ChildProcess | undefined;

  async function session(configDir: string, sid: string, pid: number, cwd: string, said: string): Promise<void> {
    const start = Date.now() - 60_000;
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(configDir, 'sessions', `${pid}.json`),
      JSON.stringify({ pid, sessionId: sid, cwd, startedAt: start, kind: 'interactive', entrypoint: 'cli', status: 'idle', version: '2.1.310', name: 'synthetic', updatedAt: start, statusUpdatedAt: start }),
    );
    const t = timeline(start + 1000, sid, cwd);
    const dir = join(configDir, 'projects', encodeProjectDir(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sid}.jsonl`), toJsonl([userPrompt(t.next(), 'list the files'), assistantText(t.next(), said)]));
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'jantar-w3-'));

    // The hub, Fleet on, its door on loopback.
    const hubHome = join(root, 'hub');
    const hubState = join(hubHome, '.jantar');
    port = await freePort();
    await mkdir(hubState, { recursive: true });
    await writeFile(
      join(hubState, 'config.json'),
      JSON.stringify({ remote: { port, publicUrl: `http://127.0.0.1:${port}` }, usage: { poller: 'off' }, notify: { settle_ms: 0 }, fleet: { enabled: true } }),
    );
    hub = await startDaemon({ env: { ...envWithout(), HOME: hubHome, USERPROFILE: hubHome, JANTAR_HOME: hubState }, terminal: false, rotateLogs: false, log: memoryLogger() });
    hubCtl = createCtlClient(hub.ctx.paths.ctlSock);

    // The node's profile: two accounts, one live session each.
    profile = join(root, 'profile');
    nodeState = join(profile, '.jantar');
    await writeHomeLayout(profile, windowsHome());
    other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true });
    await session(join(profile, '.claude'), SID_A, process.pid, join(profile, 'app'), 'Three files.');
    await session(join(profile, '.claude-work'), SID_B, other.pid!, join(profile, 'code', 'scripts'), 'Done.');

    // Pair it as `jantar node pair` and `jantar node join` do, then start it.
    const made = await callDaemon<MachinesPairReply>(hubCtl, 'POST', '/v1/machines/pair', { name: 'win-ci', count: 1 });
    const token = made.tokens[0]!;
    nodeName = token.name;
    const paired = await pairWithHub(token.token, { os: 'windows', version: DAEMON_VERSION, cfAccess: null });
    if (!paired.ok) throw new Error(`pairing failed: ${paired.reason}`);
    nodeId = paired.node.nodeId;
    const nodeEnv = { ...envWithout(), HOME: profile, USERPROFILE: profile, JANTAR_HOME: nodeState };
    await writeNodeFile(resolvePaths({ env: nodeEnv }), paired.node);
    node = await startDaemon({ env: nodeEnv, rotateLogs: false, log: memoryLogger() });
    nodeCtl = createCtlClient(node.ctx.paths.ctlSock);

    // A phone paired with the hub.
    const start = await callDaemon<PairStartResponse>(hubCtl, 'POST', '/v1/pair/start', { name: 'windows ci', scopes: ['read', 'control'] });
    const claim = await http(port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'windows ci phone' } });
    expect(claim.status, claim.text).toBe(200);
    cookie = cookieFrom(claim, DEVICE_COOKIE)!;
    rememberSecret(cookie, claim.body);
  }, 120_000);

  afterAll(async () => {
    await node?.stop().catch(() => undefined);
    await hub?.stop().catch(() => undefined);
    other?.kill();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }, 60_000);

  it('W3: discovers both sessions without ps, on dirs accounts, with their transcripts', async () => {
    let sessions: SessionsResponse['sessions'] = [];
    await until(
      async () => {
        sessions = (await callDaemon<SessionsResponse>(nodeCtl, 'GET', '/v1/sessions')).sessions;
        return [SID_A, SID_B].every((sid) => sessions.some((s) => s.sid === sid));
      },
      30_000,
      'both sessions on the node',
    );
    const a = sessions.find((s) => s.sid === SID_A)!;
    const b = sessions.find((s) => s.sid === SID_B)!;
    expect(a).toMatchObject({ configDir: join(profile, '.claude'), account: 0, entrypoint: 'cli' });
    expect(b).toMatchObject({ configDir: join(profile, '.claude-work'), account: 1 });
    const state = await callDaemon<StateResponse>(nodeCtl, 'GET', '/v1/state');
    expect(state.state.daemon?.accountsMode).toBe('dirs');
    const page = await callDaemon<TranscriptResponse>(nodeCtl, 'GET', `/v1/sessions/${SID_A}/transcript`);
    expect(JSON.stringify(page)).toContain('Three files.');
  });

  it("W4: the node's sessions show on the hub, and a phone there answers a card held on the node's pipe", async () => {
    await until(
      async () => {
        const st = (await callDaemon<StateResponse>(hubCtl, 'GET', '/v1/state')).state;
        const mine = Object.values(st.sessions).filter((s) => s.node === nodeId).map((s) => s.sid);
        return st.nodes?.[nodeId]?.online === true && mine.includes(SID_A) && mine.includes(SID_B);
      },
      60_000,
      "the node's sessions on the hub",
    );

    const hookBin = (await installHookClient({ hookBin: resolvePaths({ env: { HOME: profile, JANTAR_HOME: nodeState } }).hookBin })).path;
    const client = run(process.execPath, [hookBin, '--wait'], { env: envWithout(), input: permissionRequest(SID_A, join(profile, 'app')) });
    let card: PendingRequest | undefined;
    await until(
      async () => {
        const st = (await callDaemon<StateResponse>(hubCtl, 'GET', '/v1/state')).state;
        card = Object.values(st.pending).find((p) => p.sid === SID_A && p.state === 'open');
        return card !== undefined;
      },
      30_000,
      "the node's card on the hub",
    );
    const res = await http(port, 'POST', `/v1/pending/${encodeURIComponent(card!.id)}/decision`, { body: { behavior: 'allow' }, cookie });
    expect(res.status, res.text).toBe(200);
    const r = await client;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('W5: a prompt to a Windows session gets the watch-only line; the node has controls and launch off', async () => {
    const res = await http(port, 'POST', `/v1/sessions/${SID_A}/prompt`, { body: { text: 'hello' }, cookie });
    expect(res.status, res.text).toBeGreaterThanOrEqual(400);
    expect((res.body as { error: { message: string } }).error.message).toBe(FLEET_COPY.watchOnlyWindows(nodeName));
    const st = (await callDaemon<StateResponse>(hubCtl, 'GET', '/v1/state')).state;
    expect(st.nodes?.[nodeId]).toMatchObject({ name: nodeName, os: 'windows', backend: 'none' });
    expect(st.nodes?.[nodeId]?.features).toMatchObject({ controls: false, launch: false });
  });

  it('W6: jantar node status answers over the ctl pipe', async () => {
    const r = await run(process.execPath, [CLI, 'node', 'status'], { env: { ...envWithout(), HOME: profile, USERPROFILE: profile, JANTAR_HOME: nodeState } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(nodeName);
    expect(r.stdout).toContain('127.0.0.1');
  });
});
