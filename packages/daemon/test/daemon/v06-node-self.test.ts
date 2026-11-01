/**
 * v0.6 Fleet, daemon.ts's wiring of a node's link (wave 2): what a node says
 * of itself in its `auth` frame comes from how it was started. A node run
 * `--read-only` (`jantar node join --read-only`) reports readOnly, so the
 * hub's NodeView and Machines row, and the phone's canType, treat it as
 * watch-only (spec 3.1); its backend follows its terminal (off: none). The
 * daemon is real, on a fake home whose node.json came from a real pairing
 * with a test hub over loopback.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { FakeClock } from '../../src/core/clock.js';
import { memoryLogger } from '../../src/core/log.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon.js';
import { pairWithHub } from '../../src/link/join.js';
import { writeNodeFile } from '../../src/link/keys.js';
import { cleanup, onCleanup, startHub } from '../link/harness.js';

let home: FakeHome | null = null;
let daemon: RunningDaemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  await cleanup();
  await home?.cleanup();
  home = null;
});

async function bootNode(opts: { readOnly: boolean }) {
  const hub = await startHub();
  const r = await pairWithHub(await hub.token('build-1'), { os: 'linux', version: '0.6.0', cfAccess: null });
  if (!r.ok) throw new Error(r.reason);
  home = await makeFakeHome({ sessions: [] });
  const nodeDir = join(home.jantarHome, 'node');
  await writeNodeFile({ nodeDir, nodeFile: join(nodeDir, 'node.json') }, r.node);
  daemon = await startDaemon({
    env: home.env,
    log: memoryLogger(),
    usePath: true,
    proc: home.probe,
    port: 0,
    rotateLogs: false,
    clock: new FakeClock(Date.parse('2026-11-01T10:00:00.000Z')),
    readOnly: opts.readOnly,
    terminal: false,
  });
  onCleanup(async () => {
    await daemon?.stop();
    daemon = null;
  });
  await vi.waitFor(() => expect(hub.links[0]?.snapshots).toHaveLength(1), { timeout: 10_000 });
  return hub.links[0]!.link.info;
}

describe('v0.6: what a node daemon reports of itself', () => {
  it('a --read-only node is watch-only on the hub; with its terminal off its backend is none', async () => {
    expect(await bootNode({ readOnly: true })).toMatchObject({ readOnly: true, backend: 'none' });
  });

  it('a node started as usual is not', async () => {
    expect(await bootNode({ readOnly: false })).toMatchObject({ readOnly: false, backend: 'none' });
  });
});
