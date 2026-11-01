/**
 * v0.6 Fleet in one process (wave 2): a hub and a node, each the production
 * wiring (startDaemon) on its own synthetic HOME, linked over real `ws` on
 * loopback with the real pairing and handshake. The hub's front door is
 * plain http on 127.0.0.1 (the loopback allowance); the node runs the
 * scripted terminal. Everything at the hub goes through its control socket,
 * as the `jantar` CLI does.
 *
 * 1. `node pair` at the hub, `pairWithHub` on the node: the node links, binds
 *    no TCP port, and its sessions are on the hub's board with their node.
 * 2. A read for a node's session is forwarded and answered by the node.
 * 3. `jantar send` at the hub types into the node's session once and is
 *    proven there; the hub's wait follows the node's re-emitted job.
 * 4. Fleet off closes the link 4403 and takes the node off the board; on
 *    again, the node is back without a new join.
 * 5. Revoke: 4401, its sessions leave the board, and the node says so.
 *
 * The Docker suite (test/docker, JANTAR_FLEET_E2E=1) runs the same story
 * across real Linux containers with tmux and the fake interactive Claude.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_SIDS } from '@jantar/fixtures';
import type { MachinesPairReply, MachinesResponse, NodeRow, StateResponse, TranscriptResponse } from '@jantar/protocol';
import { NODE_CLOSE } from '@jantar/protocol/node-link';
import { pairWithHub } from '../../packages/daemon/src/link/join.js';
import { writeNodeFile } from '../../packages/daemon/src/link/keys.js';
import { callDaemon, createCtlClient, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, freePort, type Daemon } from './harness.js';
import { eventually } from './http.js';

const [, SID_BRAVO] = DEFAULT_LIVE_SIDS;

describe('a hub and a node in one process', () => {
  let hub: Daemon;
  let node: Daemon;
  let hubCtl: CtlClient;
  let nodeCtl: CtlClient;
  let nodeId = '';

  const dumpLogs = () =>
    [hub, node]
      .flatMap((d, i) =>
        (d?.log.records ?? []).filter((r) => r.level === 'warn' || r.level === 'error').map((r) => `${i ? 'node' : 'hub'} ${r.level} ${r.msg} ${JSON.stringify(r.fields)}`),
      )
      .slice(-30)
      .join('\n');
  const machine = async (): Promise<NodeRow | undefined> => (await callDaemon<MachinesResponse>(hubCtl, 'GET', '/v1/machines')).machines.find((m) => m.id === nodeId);
  const hubState = async () => (await callDaemon<StateResponse>(hubCtl, 'GET', '/v1/state')).state;
  const nodeSids = async () =>
    Object.values((await hubState()).sessions)
      .filter((s) => s.node === nodeId && s.status !== 'ended')
      .map((s) => s.sid)
      .sort();
  const nodeLink = async () => ((await callDaemon<{ node?: { link: string; lastClose: { code: number } | null } }>(nodeCtl, 'GET', '/ctl/status')).node ?? null);

  beforeAll(async () => {
    const port = await freePort();
    // The hub: Fleet on, its front door on loopback http; no sessions of its own, so every one on the board is the node's.
    hub = await bootDaemon({
      home: { sessions: [] },
      // Join lines name an https door only, but for the tests' loopback one.
      env: { JANTAR_TEST_LOOPBACK_DOOR: '1' },
      settings: { remote: { port, publicUrl: `http://127.0.0.1:${port}` }, fleet: { enabled: true } },
    });
    hubCtl = createCtlClient(hub.ctx.paths.ctlSock);
    const pair = await callDaemon<MachinesPairReply>(hubCtl, 'POST', '/v1/machines/pair', { name: 'build-1' });
    const token = pair.tokens[0]!.token;
    node = await bootDaemon({
      // A short retry, so Fleet coming back on is seen in seconds (the Docker run does the same).
      env: { JANTAR_NODE_RETRY_CAP_MS: '300' },
      before: async (home) => {
        const r = await pairWithHub(token, { os: 'linux', version: '0.6.0', cfAccess: null });
        if (!r.ok) throw new Error(r.reason);
        nodeId = r.node.nodeId;
        const nodeDir = join(home.jantarHome, 'node');
        await writeNodeFile({ nodeDir, nodeFile: join(nodeDir, 'node.json') }, r.node);
      },
    });
    nodeCtl = createCtlClient(node.ctx.paths.ctlSock);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
    await hub?.stop();
  });

  it("links: the node binds no TCP port, and its sessions are on the hub's board with their node", async () => {
    expect(node.running.mode.role).toBe('node');
    expect(node.running.address()).toBeNull();
    await eventually(async () => (await machine())?.online === true, 20_000, `the node never linked\n${dumpLogs()}`);
    expect(await machine()).toMatchObject({ name: 'build-1', online: true, readOnly: false, revokedAt: null });
    const local = Object.values(node.ctx.store.getState().sessions)
      .filter((s) => s.status !== 'ended')
      .map((s) => s.sid)
      .sort();
    expect(local.length).toBeGreaterThan(0);
    await eventually(async () => JSON.stringify(await nodeSids()) === JSON.stringify(local), 20_000, "the node's sessions");
    expect((await hubState()).nodes?.[nodeId]).toMatchObject({ name: 'build-1', online: true });
    expect(await nodeLink()).toMatchObject({ link: 'linked' });
  }, 60_000);

  it("a read of a node's session is forwarded and answered by the node", async () => {
    const page = await callDaemon<TranscriptResponse>(hubCtl, 'GET', `/v1/sessions/${SID_BRAVO}/transcript`);
    expect(page.items.length).toBeGreaterThan(0);
  }, 30_000);

  it("`jantar send` at the hub types into the node's session once, and the hub's wait sees it proven", async () => {
    const s = node.home.session(SID_BRAVO);
    const text = 'please run the synthetic test suite on the server';
    const io = memoryIo(hub.home.env);
    const code = await main(['send', s.sid.slice(0, 8), text, '--timeout', '45'], { io, context: { paths: hub.ctx.paths, ctl: hubCtl } });
    expect(code, `${io.stderr}\n${dumpLogs()}`).toBe(0);
    expect(io.stdout).toContain('proven by the transcript');
    expect(node.terminal.events.typed.filter((t) => t.paneId.endsWith(s.tty)).map((t) => t.text).join('')).toBe(text);
    expect(hub.terminal.events.typed).toEqual([]);
  }, 60_000);

  it('Fleet off closes the link 4403 and takes the node off the board; on again, it is back without a new join', async () => {
    await callDaemon(hubCtl, 'PATCH', '/v1/settings', { fleet: { enabled: false } });
    await eventually(async () => (await nodeSids()).length === 0 && (await machine())?.online === false, 20_000, 'off the board');
    expect((await machine())?.lastClose?.code).toBe(NODE_CLOSE.fleetOff);
    await callDaemon(hubCtl, 'PATCH', '/v1/settings', { fleet: { enabled: true } });
    await eventually(async () => (await machine())?.online === true && (await nodeSids()).length > 0, 30_000, `back on the board\n${dumpLogs()}`);
  }, 90_000);

  it('revoke: the link closes 4401, its sessions leave the board, and the node is told', async () => {
    await callDaemon(hubCtl, 'DELETE', `/v1/machines/${nodeId}`);
    await eventually(async () => (await nodeSids()).length === 0, 20_000, 'off the board');
    expect(await machine()).toMatchObject({ online: false, lastClose: { code: NODE_CLOSE.unknown } });
    expect((await machine())?.revokedAt).toBeTruthy();
    await eventually(async () => (await nodeLink())?.lastClose?.code === NODE_CLOSE.unknown, 20_000, 'the node heard 4401');
    expect((await hubState()).nodes?.[nodeId]).toBeUndefined();
  }, 60_000);
});
