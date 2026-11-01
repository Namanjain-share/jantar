/**
 * v0.6 Fleet: a daemon whose state dir holds node/node.json starts as a node.
 * It binds no TCP port; its control socket answers with its role; Changes,
 * Rewrite, Life, Intel, Meetings and pushes are stand-ins that open no file
 * and start no timer, even with their switches on in its config; its
 * daemon.version offers none of the Mac's parts. The same home without
 * node.json is a hub and opens life.db and meetings.db (so the test would see
 * a node that did).
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIFE_DB_FILE, MEETINGS_DB_FILE, type Settings } from '@jantar/protocol';
import { makeFakeHome, type FakeHome } from '@jantar/fixtures';
import { ctlStatus } from '../../src/api/ctl-routes.js';
import type { ApiServerImpl } from '../../src/api/server.js';
import { ApiError } from '../../src/api/errors.js';
import { FakeClock } from '../../src/core/clock.js';
import { memoryLogger } from '../../src/core/log.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon.js';
import { NODE_PART_OFF } from '../../src/modes.js';

let home: FakeHome | null = null;
let daemon: RunningDaemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  await home?.cleanup();
  home = null;
});

/** Every switch a hub could have on, in the machine's own config. */
function everythingOn(h: FakeHome): Partial<Settings> & Record<string, unknown> {
  return {
    usage: { poller: 'off' },
    bins: { node: process.execPath, cswap: h.bins.cswap, ps: h.bins.ps, osascript: h.bins.osascript, lsof: h.bins.lsof, claude: join(h.root, 'nowhere', 'claude'), tmux: join(h.root, 'nowhere', 'tmux') },
    files: { enabled: true },
    rewrite: { enabled: true },
    screenshots: { enabled: true },
    life: { todos: true, medicines: true },
    intel: { enabled: true },
    meetings: { enabled: true },
    ask: { enabled: true },
    fleet: { enabled: true },
    launch: { enabled: true },
  } as Partial<Settings> & Record<string, unknown>;
}

async function boot(asNode: boolean, clock: FakeClock): Promise<RunningDaemon> {
  home = await makeFakeHome({ sessions: [] });
  await writeFile(join(home.jantarHome, 'config.json'), `${JSON.stringify(everythingOn(home), null, 2)}\n`, { mode: 0o600 });
  if (asNode) {
    await mkdir(join(home.jantarHome, 'node'), { recursive: true, mode: 0o700 });
    await writeFile(join(home.jantarHome, 'node', 'node.json'), '{}\n', { mode: 0o600 });
  }
  daemon = await startDaemon({ env: home.env, log: memoryLogger(), usePath: true, proc: home.probe, port: 0, rotateLogs: false, clock });
  return daemon;
}

describe('v0.6: a node-mode daemon', () => {
  it('binds no TCP port and says it is a node', async () => {
    const d = await boot(true, new FakeClock(Date.parse('2026-11-01T10:00:00.000Z')));
    expect(d.mode.role).toBe('node');
    expect(d.address()).toBeNull();
    const api = d.parts.api as ApiServerImpl;
    expect(api.tcpApp()).toBeNull();
    // The link app the hub's calls run through is there.
    expect(api.link()).not.toBeNull();
    const status = ctlStatus(api.services, () => d.address());
    expect(status).toMatchObject({ role: 'node', api: null, node: { link: 'off', accessRefused: 0 }, nodes: { paired: 0, online: 0 } });
  });

  it("opens no life.db or meetings.db and offers none of the Mac's parts, whatever its config says", async () => {
    const d = await boot(true, new FakeClock(Date.parse('2026-11-01T10:00:00.000Z')));
    expect(existsSync(join(home!.jantarHome, LIFE_DB_FILE))).toBe(false);
    expect(existsSync(join(home!.jantarHome, MEETINGS_DB_FILE))).toBe(false);
    const features = d.ctx.store.getState().daemon?.features;
    expect(features).toMatchObject({ files: false, rewrite: false, screenshots: false, screenshotSelect: false, life: false, intel: false, meetings: false, ask: false, fleet: false, launch: true });
    expect(d.parts.notifiers).toEqual([]);
    expect(d.parts.ccwLegacy.present()).toBe(false);
  });

  it('runs stand-ins for the hub-only parts: they answer 501 on the Mac, and start no timer', async () => {
    const clock = new FakeClock(Date.parse('2026-11-01T10:00:00.000Z'));
    const d = await boot(true, clock);
    const before = clock.pending();
    for (const part of [d.parts.changes, d.parts.rewrite, d.parts.life, d.parts.intel, d.parts.meetings, d.parts.ask, d.parts.notifications, d.parts.fleet]) {
      await part.start();
      await part.stop();
    }
    expect(clock.pending()).toBe(before);
    const off = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof ApiError ? `${e.code}: ${e.message}` : String(e);
      }
      return 'answered';
    };
    expect(off(() => d.parts.life.status())).toBe(`not_implemented: ${NODE_PART_OFF}`);
    expect(off(() => d.parts.meetings.status())).toBe(`not_implemented: ${NODE_PART_OFF}`);
    expect(off(() => d.parts.intel.list({ limit: 10 } as never))).toBe(`not_implemented: ${NODE_PART_OFF}`);
    // v0.5.3's Ask is the Mac's too: no headless Claude run on a server.
    expect(off(() => d.parts.ask.list({ kind: 'cli' }))).toBe(`not_implemented: ${NODE_PART_OFF}`);
    expect(d.parts.life.broken()).toBeNull();
    expect(d.parts.meetings.broken()).toBeNull();
    expect(d.parts.rewrite.originFor('j', 's', 'h', { kind: 'cli' })).toBeNull();
    // The hub's Fleet part is not here: nothing targets a server, nothing pairs.
    expect(d.parts.fleet.target('sendPrompt', { sid: 'x' }, {})).toBeNull();
    expect(d.parts.fleet.list()).toEqual([]);
  });

  it('the same home without node.json is a hub (and opens what a node never does)', async () => {
    const d = await boot(false, new FakeClock(Date.parse('2026-11-01T10:00:00.000Z')));
    expect(d.mode.role).toBe('hub');
    expect(d.address()?.port).toBeGreaterThan(0);
    expect(existsSync(join(home!.jantarHome, LIFE_DB_FILE))).toBe(true);
    expect(existsSync(join(home!.jantarHome, MEETINGS_DB_FILE))).toBe(true);
    expect(d.ctx.store.getState().daemon?.features).toMatchObject({ files: true, life: true, meetings: true, ask: true, fleet: true });
    expect(d.parts.nodeLink.status().state).toBe('off');
  });
});
