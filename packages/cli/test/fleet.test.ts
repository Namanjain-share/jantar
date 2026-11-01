/**
 * v0.6: `jantar fleet on | off | status` and the machine lines of
 * `jantar status`, against an in-memory daemon on a synthetic HOME. pmset
 * is a fake (read only); nothing touches the real Mac.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onCommand } from '@jantar/daemon/core/testing';
import { FLEET_HUB_URL, NODE_IDS, makeFakeHome, nodeViewFixture, type FakeHome } from '@jantar/fixtures';
import { emptyState, type NodeRow, type State } from '@jantar/protocol';
import fleet, { DROPPED_HINT, droppedTogether } from '../src/commands/fleet.js';
import status, { machineLines } from '../src/commands/status.js';
import { EXIT } from '../src/command.js';
import { FIXED_DOOR } from '../src/lib/doctor.js';
import { contextFor, fakeCtl, fakeSettings, ok, testDeps, T0 } from './helpers.js';

const PMSET = '/usr/bin/pmset';
const pmset = (ac: number) => onCommand(PMSET, { stdout: `Battery Power:\n sleep                1\nAC Power:\n sleep                ${ac}\n` }, ['-g', 'custom']);
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();

function row(over: Partial<NodeRow> = {}): NodeRow {
  return {
    id: NODE_IDS.build1,
    name: 'build-1',
    os: 'linux',
    backend: 'tmux',
    version: '0.6.0',
    createdAt: iso(86_400_000),
    lastSeenAt: iso(60_000),
    revokedAt: null,
    online: true,
    sessions: 3,
    readOnly: false,
    accessRefused: 0,
    lastClose: null,
    ...over,
  };
}

const CLOUDFLARE = { remote: { mode: 'cloudflare', publicUrl: FLEET_HUB_URL, allowedOrigins: [FLEET_HUB_URL] } };

describe('jantar fleet', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  function hub(settings: Record<string, unknown> = CLOUDFLARE, o: { sleep?: number; machines?: NodeRow[]; down?: boolean; platform?: NodeJS.Platform } = {}) {
    const s = fakeSettings(settings);
    const deps = testDeps({ handlers: [pmset(o.sleep ?? 0)], ...(o.platform ? { platform: o.platform } : {}) });
    const ctl = o.down
      ? fakeCtl({}, { down: true })
      : fakeCtl({
          ...s.routes,
          'GET /ctl/status': ok({ role: 'hub', daemonVersion: '0.6.0', nodes: { paired: (o.machines ?? []).length, online: 0 } }),
          'GET /v1/machines': () => ok({ machines: o.machines ?? [] }),
        });
    const { ctx, io } = contextFor(home, { deps, ctl });
    return { ctx, io, deps, s, ctl };
  }

  it('on: sets the Mac-only switch and says what the Cloudflare door needs, the expiry, the hub and the sleep', async () => {
    const { ctx, io, s, deps } = hub(CLOUDFLARE, { sleep: 10 });
    expect(await fleet.run(['on'], ctx), io.stderr).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ fleet: { enabled: true } }]);
    expect(io.stdout).toBe(
      'Fleet is on. Servers reach this Mac at https://jantar.example.com/v1/node/link\n' +
        'With Cloudflare Access in front (the setup in docs/install.md), add one Access\n' +
        'application for jantar.example.com/v1/node/* with a single Service Auth policy\n' +
        'and a service token (docs/fleet.md#cloudflare-access). Each server needs that\n' +
        "token's id and secret. Note the token's expiry date: when it lapses every server\n" +
        'goes offline at once (renew it with jantar node access on each server).\n' +
        "This Mac is the hub: while it sleeps or is off, the phone can't reach any server.\n" +
        'This Mac sleeps after 10 minutes on power: jantar doctor says how to stop that.\n' +
        'Next: jantar node pair --name <name> [--count K] here, then run each line on its server.\n',
    );
    // pmset is only read.
    expect(deps.exec.calls.map((c) => [c.file, ...c.args])).toEqual([[PMSET, '-g', 'custom']]);
  });

  it('on: no sleep line when the Mac stays awake on power; the tag and grant on Tailscale', async () => {
    const awake = hub(CLOUDFLARE, { sleep: 0 });
    expect(await fleet.run(['on'], awake.ctx)).toBe(EXIT.ok);
    expect(awake.io.stdout).not.toContain('on power');
    const ts = hub({ remote: { mode: 'tailscale', publicUrl: 'https://mac.tailnet-0000.ts.net', allowedOrigins: ['https://mac.tailnet-0000.ts.net'] } });
    expect(await fleet.run(['on'], ts.ctx)).toBe(EXIT.ok);
    expect(ts.io.stdout).toContain('Servers reach this Mac at https://mac.tailnet-0000.ts.net/v1/node/link\nTag each server tag:jantar-node');
    expect(ts.io.stdout).toContain('tcp:443 on this Mac only');
    expect(ts.io.stdout).not.toContain('Cloudflare Access');
  });

  it('on: refuses a door servers cannot keep using, with one sentence, and changes nothing', async () => {
    for (const remote of [
      {},
      { mode: 'lan', host: '0.0.0.0' },
      { mode: 'cloudflare', publicUrl: null },
      { mode: 'cloudflare', publicUrl: 'https://quiet-river-1234.trycloudflare.com' },
    ]) {
      const { ctx, io, s } = hub({ remote });
      expect(await fleet.run(['on'], ctx), JSON.stringify(remote)).toBe(EXIT.failed);
      expect(io.stderr).toBe(`${FIXED_DOOR}\n`);
      expect(s.patches).toEqual([]);
    }
  });

  it('on: refuses off a Mac, and on a server', async () => {
    const linux = hub(CLOUDFLARE, { platform: 'linux' });
    expect(await fleet.run(['on'], linux.ctx)).toBe(EXIT.failed);
    expect(linux.io.stderr).toContain('The hub is a Mac');
    expect(linux.s.patches).toEqual([]);

    await mkdir(join(home.jantarHome, 'node'), { recursive: true });
    await writeFile(join(home.jantarHome, 'node', 'node.json'), '{}\n');
    const server = hub();
    expect(await fleet.run(['on'], server.ctx)).toBe(EXIT.failed);
    expect(server.io.stderr).toContain('Fleet is turned on and off at the hub.');
    expect(server.s.patches).toEqual([]);
  });

  it('on with the daemon down: saved to config.json', async () => {
    await writeFile(join(home.jantarHome, 'config.json'), JSON.stringify({ version: 2, ...CLOUDFLARE }));
    const { ctx, io } = hub(CLOUDFLARE, { down: true });
    expect(await fleet.run(['on'], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Saved to config.json');
    expect(JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8')).fleet).toEqual({ enabled: true });
  });

  it('off: closes every link and keeps the pairings', async () => {
    const { ctx, io, s } = hub({ ...CLOUDFLARE, fleet: { enabled: true } });
    expect(await fleet.run(['off'], ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ fleet: { enabled: false } }]);
    expect(io.stdout).toBe(
      "Fleet is off. Every server's link is closed and its sessions left the board. The pairings stay: jantar fleet on brings the servers back without joining again.\n",
    );
  });

  it('status: the door, servers online, each one\'s last close and Access refusals', async () => {
    const machines = [
      row(),
      row({ id: NODE_IDS.build2, name: 'build-2', os: 'wsl', online: false, sessions: 0, lastClose: { code: 1006, at: iso(12 * 60_000) }, accessRefused: 4 }),
      row({ id: NODE_IDS.win1, name: 'win-1', os: 'windows', backend: null, online: false, sessions: 0, lastSeenAt: null }),
      row({ id: NODE_IDS.mini1, name: 'mini-1', revokedAt: iso(1000), online: false }),
    ];
    const { ctx, io } = hub({ ...CLOUDFLARE, fleet: { enabled: true } }, { machines });
    expect(await fleet.run(['status'], ctx), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toBe(
      'Fleet:   on\n' +
        'Door:    https://jantar.example.com/v1/node/link (Cloudflare)\n' +
        'Servers: 1 of 3 online\n' +
        '  build-1  online · 3 sessions\n' +
        '  build-2  offline for 12m · last: the connection dropped (1006) · 4 Cloudflare Access refusals while away\n' +
        '  win-1    never linked\n',
    );
    const json = hub({ ...CLOUDFLARE, fleet: { enabled: true } }, { machines });
    expect(await fleet.run(['status', '--json'], json.ctx)).toBe(EXIT.ok);
    expect(JSON.parse(json.io.stdout)).toMatchObject({ enabled: true, door: { url: FLEET_HUB_URL, kind: 'cloudflare' }, droppedTogether: false });
  });

  it('status: one hint when every server dropped within two minutes while the Mac stayed up', async () => {
    const machines = [
      row({ online: false, lastClose: { code: 1006, at: iso(30 * 60_000) } }),
      row({ id: NODE_IDS.build2, name: 'build-2', online: false, lastClose: { code: 1006, at: iso(29 * 60_000) } }),
      row({ id: NODE_IDS.mini1, name: 'mini-1', revokedAt: iso(1000), online: false }),
    ];
    const { ctx, io } = hub({ ...CLOUDFLARE, fleet: { enabled: true } }, { machines });
    expect(await fleet.run(['status'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain(`\n${DROPPED_HINT}\n`);
    expect(DROPPED_HINT).toBe(
      'Every server dropped at once: if you use Cloudflare Access, the service token may have expired (docs/fleet.md#rotate-the-access-token)',
    );
  });

  it('the hint needs every live server down, closed within 2 minutes, and not by the Mac itself', () => {
    const a = row({ online: false, lastClose: { code: 1006, at: iso(10 * 60_000) } });
    const b = row({ name: 'build-2', online: false, lastClose: { code: 1006, at: iso(9 * 60_000) } });
    expect(droppedTogether([a, b])).toBe(true);
    expect(droppedTogether([a])).toBe(false);
    expect(droppedTogether([a, { ...b, online: true }])).toBe(false);
    expect(droppedTogether([a, { ...b, lastClose: { code: 1006, at: iso(2 * 60_000) } }])).toBe(false);
    expect(droppedTogether([a, { ...b, lastClose: null }])).toBe(false);
    expect(droppedTogether([{ ...a, lastClose: { code: 4403, at: iso(10 * 60_000) } }, b])).toBe(false);
    expect(droppedTogether([{ ...a, lastClose: { code: 4401, at: iso(10 * 60_000) } }, b])).toBe(false);
  });

  it('status: off, a door servers cannot use, and the daemon down', async () => {
    const { ctx, io } = hub({}, { down: true });
    expect(await fleet.run(['status'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toBe('Fleet:   off (turn it on: jantar fleet on)\nDoor:    none for servers: it is loopback only\nServers: the daemon is not running (start it: jantar install)\n');
  });

  it('refuses an unknown action', async () => {
    const { ctx, io } = hub();
    expect(await fleet.run(['maybe'], ctx)).toBe(EXIT.usage);
    expect(io.stderr).toContain('usage: jantar fleet <on|off|status>');
  });
});

describe('jantar status with Fleet', () => {
  function fleetState(): State {
    const state = emptyState();
    state.sessions = {
      a: { sid: 'a', status: 'idle' } as State['sessions'][string],
      b: { sid: 'b', status: 'working', node: NODE_IDS.build1 } as State['sessions'][string],
      c: { sid: 'c', status: 'ended', node: NODE_IDS.build1 } as State['sessions'][string],
    };
    state.nodes = {
      [NODE_IDS.build1]: nodeViewFixture(),
      [NODE_IDS.win1]: nodeViewFixture({ id: NODE_IDS.win1, name: 'win-1', os: 'windows', backend: 'none', online: false, since: new Date(T0 - 5 * 60_000).toISOString() }),
    };
    return state;
  }

  it('adds one line per machine, the Mac first', () => {
    expect(machineLines(fleetState(), null, T0)).toBe(
      '\nMachines: 3\n  Mac      this Mac · 1 session\n  build-1  Linux · tmux · online · 1 session\n  win-1    Windows · watch · offline for 5m\n',
    );
  });

  it('adds nothing without servers (the v0.5 board), and on a server says whose it is', () => {
    expect(machineLines(emptyState(), null, T0)).toBe('');
    const st = { role: 'node' as const, node: { name: 'build-1', hubHost: 'jantar.example.com', link: 'linked' as const, lastClose: null, accessRefused: 0 } };
    expect(machineLines(emptyState(), st, T0)).toBe('\nThis machine is build-1, a server of jantar.example.com · linked\n');
  });

  it('prints them after the board', async () => {
    const home = await makeFakeHome({ sessions: [] });
    try {
      const ctl = fakeCtl({ 'GET /v1/state': ok({ state: fleetState() }), 'GET /ctl/status': ok({ mode: { readOnly: false, terminal: 'terminal-app' }, role: 'hub' }) });
      const { ctx, io } = contextFor(home, { ctl });
      expect(await status.run([], ctx)).toBe(EXIT.ok);
      expect(io.stdout).toContain('\nMachines: 3\n  Mac ');
    } finally {
      await home.cleanup();
    }
  });
});
