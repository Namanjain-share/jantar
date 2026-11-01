/**
 * v0.6: `jantar node` on a synthetic HOME. At the Mac: pair, list, revoke
 * against an in-memory daemon. On a server: join (the hub guard of S24 runs
 * first; L1's real pairWithHub checks a real Ed25519 signature through a
 * fake fetch, so a wrong key or a refusal leaves nothing behind), access,
 * status and leave, with systemctl and loginctl as fakes (never the real
 * systemd, and also a systemctl that can't run), leave then join again over
 * a stopped daemon's real jantar.db, and the real hooks installer writing
 * into the fake config dirs. Also `jantar new --node`. No network, no real
 * daemon, no real Claude.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onCommand, type ExecHandler } from '@jantar/daemon/core/testing';
import { openSqliteFile } from '@jantar/daemon/db/sqlite';
import { pairWithHub } from '@jantar/daemon/link/join';
import { generateKeyPair, privateKeyPem, readNodeFile, signPair, writeNodeFile } from '@jantar/daemon/link/keys';
import type { NodeFile } from '@jantar/daemon';
import { FLEET_HUB_URL, FLEET_SECRET, NODE_IDS, linuxHome, makeFakeHome, nodeSession, writeHomeLayout, type FakeHome } from '@jantar/fixtures';
import { V03_LAUNCH_FLAGS, emptyState, errorBody, launchFlagArgs, type FileRoot, type LaunchJob, type LaunchPreview, type NodeRow, type State } from '@jantar/protocol';
import { encodeJoinToken } from '@jantar/protocol/node-link';
import { createNodeCommand, hubRecordsIn, type NodeCommandDeps } from '../src/commands/node.js';
import newSession from '../src/commands/new.js';
import { EXIT } from '../src/command.js';
import type { CtlClient } from '../src/ctl.js';
import { loadHooksCli } from '../src/commands/hooks.js';
import type { CtlStatusView } from '../src/lib/doctor.js';
import { plistPath } from '../src/lib/launchd.js';
import { unitPath } from '../src/lib/systemd.js';
import { argsOf, contextFor, fail, fakeCtl, fakePackages, fakeSettings, ok, testDeps, T0, type CtlCall, type Handler } from './helpers.js';

const SYSTEMCTL = '/usr/bin/systemctl';
const LOGINCTL = '/usr/bin/loginctl';
const CLIENT_ID = '3f2a9c71d0e4b8a6c5f1e2d3b4a59687.access';
const SECRET_ENV = 'JANTAR_CF_ACCESS_CLIENT_SECRET';
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

/**
 * The Mac that made the line: a real hub key pair; `fetch` answers the claim
 * as the hub's /v1/node/pair does, signed with that key (or, `sign: 'wrong'`,
 * another one: an impostor at the same address).
 */
function fakeHub(o: { sign?: 'right' | 'wrong'; status?: number; jantarBody?: boolean } = {}) {
  const hub = generateKeyPair();
  const impostor = generateKeyPair();
  const claims: { url: string; headers: Record<string, string>; body: Record<string, unknown>; redirect?: RequestInit['redirect'] }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    claims.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body, ...(init?.redirect ? { redirect: init.redirect } : {}) });
    if (o.status !== undefined && o.status !== 201) {
      const text = o.jantarBody === false ? '<html>Access denied</html>' : JSON.stringify(errorBody('unauthorized', 'not valid'));
      return new Response(text, { status: o.status });
    }
    const key = o.sign === 'wrong' ? impostor.privateKey : hub.privateKey;
    const sig = signPair(key, NODE_IDS.build1, String(body.publicKey));
    return new Response(JSON.stringify({ nodeId: NODE_IDS.build1, name: 'build-1', sig }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const line = encodeJoinToken({ url: FLEET_HUB_URL, code: randomBytes(16).toString('base64url'), hubKey: hub.publicKey });
  return { hub, line, claims, fetch: fetchFn };
}

/** node.json for a server that already joined. */
function nodeFile(over: Partial<NodeFile> = {}): NodeFile {
  return {
    v: 1,
    url: FLEET_HUB_URL,
    nodeId: NODE_IDS.build1,
    name: 'build-1',
    hubKey: generateKeyPair().publicKey,
    privateKey: privateKeyPem(generateKeyPair().privateKey),
    cfAccess: { clientId: CLIENT_ID, clientSecret: FLEET_SECRET },
    ...over,
  };
}

/** The server's own state once linked: two sessions, one in a tmux pane. */
function serverState(): State {
  const state = emptyState();
  state.sessions = {
    s1: nodeSession({ sid: 's1', paneId: '%3' }),
    // As a Linux daemon has it: `ps -o tty=` prints "pts/4" (tmux says "/dev/pts/4").
    s2: nodeSession({ sid: 's2', tty: 'pts/4', configDir: '/home/sam/.claude-work', account: 1 }),
  };
  state.daemon = { protocol: 3, daemonVersion: '0.6.0', webHash: null, accountsMode: 'dirs' };
  return state;
}

const LINKED: NonNullable<CtlStatusView['node']> = { name: 'build-1', hubHost: 'jantar.example.com', link: 'linked', lastClose: null, accessRefused: 0 };

/**
 * A stopped daemon's jantar.db, made by the daemon's own module: `devices`
 * live phones, `pushes` push subscriptions and `servers` live servers, plus a
 * revoked phone and a removed server (which never count).
 */
function stoppedDb(file: string, o: { devices?: number; pushes?: number; servers?: number } = {}): void {
  const db = openSqliteFile(file);
  const at = iso(0);
  const device = db.raw.prepare('INSERT INTO devices (id, name, key_hash, scopes, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  device.run('dev-revoked', 'old phone', 'hash-revoked', '[]', at, at, at);
  for (let n = 0; n < (o.devices ?? 0); n++) device.run(`dev-${n}`, `phone ${n}`, `hash-${n}`, '[]', at, at, null);
  const push = db.raw.prepare('INSERT INTO push_subs (endpoint, device_id, json, created_at) VALUES (?, ?, ?, ?)');
  for (let n = 0; n < (o.pushes ?? 0); n++) push.run(`https://push.example.com/${n}`, 'dev-0', '{}', at);
  const node = db.raw.prepare('INSERT INTO nodes (id, name, public_key, os, version, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  node.run('01JF1EETN0DEREV0KED0000000', 'old-1', 'A'.repeat(43), 'linux', '0.6.0', at, null, at);
  for (let n = 0; n < (o.servers ?? 0); n++) node.run(`01JF1EETN0DE0000000000000${n}`, `build-${n}`, 'B'.repeat(43), 'linux', '0.6.0', at, null, null);
  db.close();
}

// ---------------------------------------------------------------------------

describe('jantar node at the Mac', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  function mac(routes: Record<string, Handler | ReturnType<typeof ok>> = {}) {
    const ctl = fakeCtl({ 'GET /ctl/status': ok({ role: 'hub', daemonVersion: '0.6.0', nodes: { paired: 2, online: 1 } }), ...routes });
    const { ctx, io } = contextFor(home, { ctl });
    return { ctx, io, ctl, node: createNodeCommand() };
  }

  const tokens = (names: string[]) => ({
    tokens: names.map((name, n) => ({ name, token: `jn1.synthetic-line-${n + 1}`, expiresAt: new Date(T0 + 10 * 60_000).toISOString() })),
  });

  it('pair: one single-use line per server, through the control socket', async () => {
    const { ctx, io, ctl, node } = mac({ 'POST /v1/machines/pair': ok(tokens(['build-1', 'build-2', 'build-3']), 201) });
    expect(await node.run(['pair', '--name', 'build', '--count', '3'], ctx), io.stderr).toBe(EXIT.ok);
    const post = ctl.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ name: 'build', count: 3 });
    expect(post?.opts.idempotencyKey).toBeTruthy();
    expect(io.stdout).toBe(
      'Run one line on each server within 10 minutes. Each works once.\n' +
        '  build-1  jantar node join jn1.synthetic-line-1\n' +
        '  build-2  jantar node join jn1.synthetic-line-2\n' +
        '  build-3  jantar node join jn1.synthetic-line-3\n',
    );
  });

  it('pair: one line, --json, and the daemon refusing while Fleet is off', async () => {
    const one = mac({ 'POST /v1/machines/pair': ok(tokens(['node-1']), 201) });
    expect(await one.node.run(['pair'], one.ctx)).toBe(EXIT.ok);
    expect(one.ctl.calls.find((c) => c.method === 'POST')?.body).toEqual({});
    expect(one.io.stdout).toBe('Run this line on the server within 10 minutes. It works once.\n  node-1  jantar node join jn1.synthetic-line-1\n');

    const json = mac({ 'POST /v1/machines/pair': ok(tokens(['web']), 201) });
    expect(await json.node.run(['pair', '--name', 'web', '--json'], json.ctx)).toBe(EXIT.ok);
    expect(JSON.parse(json.io.stdout)).toEqual(tokens(['web']));

    const off = mac({ 'POST /v1/machines/pair': fail('forbidden', 'Fleet is off. Turn it on at your Mac: jantar fleet on', 403) });
    expect(await off.node.run(['pair'], off.ctx)).toBe(EXIT.failed);
    expect(off.io.stderr).toBe('jantar node pair: Fleet is off. Turn it on at your Mac: jantar fleet on\n');
  });

  it('pair: refuses a name or count the hub would refuse, before asking it', async () => {
    for (const argv of [['--name', 'mac'], ['--name', 'Build_1'], ['--count', '21'], ['--count', '0']]) {
      const { ctx, io, ctl, node } = mac();
      expect(await node.run(['pair', ...argv], ctx)).toBe(EXIT.usage);
      expect(io.stderr).toMatch(/--name|--count/);
      expect(ctl.calls.some((c) => c.method === 'POST')).toBe(false);
    }
  });

  it('list: OS and terminal, online or since when, the version against the Mac\'s, read-only and Access refusals', async () => {
    const rows = [
      row(),
      row({ id: NODE_IDS.build2, name: 'build-2', os: 'wsl', version: '0.5.9', sessions: 1, problem: 'version' }),
      row({ id: NODE_IDS.win1, name: 'win-1', os: 'windows', backend: 'none', sessions: 1, readOnly: true }),
      row({ id: NODE_IDS.big, name: 'build-3', online: false, accessRefused: 2, lastClose: { code: 1006, at: iso(3_600_000) } }),
      row({ id: NODE_IDS.mini1, name: 'mini-1', os: 'macos', backend: null, online: false, lastSeenAt: null }),
      row({ id: '01JF1EETN0DEREV0KED0000000', name: 'old-1', online: false, revokedAt: iso(86_400_000) }),
    ];
    const { ctx, io, node } = mac({ 'GET /v1/machines': ok({ machines: rows }) });
    expect(await node.run(['list'], ctx), io.stderr).toBe(EXIT.ok);
    const lines = io.stdout.split('\n');
    expect(lines[0]).toMatch(/^ {2}build-1 {2}Linux · tmux +online · 3 sessions {2}· {2}Jantar 0\.6\.0$/);
    expect(lines[1]).toMatch(/^ {2}build-2 {2}Linux \(WSL\) · tmux +online · 1 session {2}· {2}Jantar 0\.5\.9 · Mac has 0\.6\.0$/);
    expect(lines[2]).toBe('           build-2 runs an older link version: update Jantar there');
    expect(lines[3]).toMatch(/win-1 +Windows · watch +online · 1 session {2}· {2}Jantar 0\.6\.0 {2}· {2}read-only$/);
    expect(lines[4]).toMatch(/build-3 +Linux · tmux +offline for 1h .*· {2}2 Access refusals while away$/);
    expect(lines[5]).toMatch(/mini-1 +macOS · \? +never linked/);
    expect(io.stdout).not.toContain('old-1');

    const all = mac({ 'GET /v1/machines': ok({ machines: rows }) });
    expect(await all.node.run(['list', '--all'], all.ctx)).toBe(EXIT.ok);
    expect(all.io.stdout).toMatch(/old-1 .*removed 24h ago/);

    const json = mac({ 'GET /v1/machines': ok({ machines: rows }) });
    expect(await json.node.run(['list', '--json'], json.ctx)).toBe(EXIT.ok);
    expect(JSON.parse(json.io.stdout).machines.map((r: NodeRow) => r.name)).toEqual(['build-1', 'build-2', 'win-1', 'build-3', 'mini-1']);

    const none = mac({ 'GET /v1/machines': ok({ machines: [] }) });
    expect(await none.node.run(['list'], none.ctx)).toBe(EXIT.ok);
    expect(none.io.stdout).toBe('No paired servers. Pair one: jantar node pair --name <name>\n');
  });

  it('revoke: by name, through DELETE /v1/machines/:id; an unknown name changes nothing', async () => {
    const { ctx, io, ctl, node } = mac({
      'GET /v1/machines': ok({ machines: [row(), row({ id: NODE_IDS.build2, name: 'build-2' })] }),
      [`DELETE /v1/machines/${NODE_IDS.build2}`]: ok({ machine: row({ id: NODE_IDS.build2, name: 'build-2', online: false, revokedAt: iso(0) }) }),
    });
    expect(await node.run(['revoke', 'build-2'], ctx), io.stderr).toBe(EXIT.ok);
    const del = ctl.calls.find((c) => c.method === 'DELETE');
    expect(del?.path).toBe(`/v1/machines/${NODE_IDS.build2}`);
    expect(del?.opts.idempotencyKey).toBeTruthy();
    expect(io.stdout).toBe(
      'Removed build-2: its link is closed and its sessions left the board.\n' +
        'To pair it again: jantar node leave on build-2, then jantar node pair --name build-2 here and join with the new line.\n',
    );

    const missing = mac({ 'GET /v1/machines': ok({ machines: [row()] }) });
    expect(await missing.node.run(['revoke', 'build-9'], missing.ctx)).toBe(EXIT.failed);
    expect(missing.io.stderr).toBe('jantar node revoke: no paired server named "build-9" (see: jantar node list)\n');
    expect(missing.ctl.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it("each server verb refuses at the Mac with one sentence; a Linux machine that never joined says so", async () => {
    for (const verb of ['status', 'access', 'leave']) {
      const { ctx, io, node } = mac();
      expect(await node.run([verb], ctx)).toBe(EXIT.failed);
      expect(io.stderr).toBe('This Mac is the hub. Pair servers with jantar node pair.\n');
    }
    const { ctx, io } = contextFor(home, { deps: testDeps({ platform: 'linux' }) });
    expect(await createNodeCommand().run(['status'], ctx)).toBe(EXIT.failed);
    expect(io.stderr).toBe('This machine is not a server yet: run jantar node join <line from jantar node pair at the Mac>.\n');
    // And the hub's verbs there: the hub is a Mac (never the local daemon's "Fleet is off" or an empty list).
    for (const argv of [['pair'], ['list'], ['revoke', 'build-1']]) {
      const linux = contextFor(home, { deps: testDeps({ platform: 'linux' }) });
      expect(await createNodeCommand().run(argv, linux.ctx)).toBe(EXIT.failed);
      expect(linux.io.stderr).toBe('The hub is a Mac: run this there. This machine joins it with jantar node join <line from the Mac>.\n');
    }
  });

  it('refuses an unknown action and a missing name', async () => {
    const { ctx, io, node } = mac();
    expect(await node.run(['rename', 'x'], ctx)).toBe(EXIT.usage);
    expect(io.stderr).toContain('unknown action "rename"');
    const two = mac();
    expect(await two.node.run(['revoke'], two.ctx)).toBe(EXIT.usage);
    expect(two.io.stderr).toContain('revoke needs a server name');
  });
});

// ---------------------------------------------------------------------------

describe('jantar node join on a Linux server', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
    await writeHomeLayout(home.home, linuxHome());
  });
  afterEach(async () => {
    await home.cleanup();
  });

  /**
   * A server. `before`: the daemon already running here (a hub's
   * /ctl/status), or down. `systemctl --user restart` brings it up as a node
   * whose link is `link`.
   */
  async function server(
    o: {
      before?: Partial<CtlStatusView>;
      link?: CtlStatusView['node'];
      hub?: ReturnType<typeof fakeHub>;
      answers?: string[];
      env?: Record<string, string>;
      platform?: NodeJS.Platform;
      deps?: Partial<NodeCommandDeps>;
      /** Tried before the usual systemctl and loginctl fakes. */
      handlers?: ExecHandler[];
      bins?: Record<string, string | null>;
    } = {},
  ) {
    const hub = o.hub ?? fakeHub();
    const locations = await fakePackages(home.root);
    const daemon = { up: o.before !== undefined };
    const s = fakeSettings();
    const routes: Record<string, Handler | ReturnType<typeof ok>> = {
      ...s.routes,
      'GET /healthz': ok({ ok: true, protocol: 3, daemonVersion: '0.6.0' }),
      'GET /ctl/status': ok({ role: 'hub', pairedDevices: 0, pushSubscriptions: 0, nodes: { paired: 0, online: 0 }, publicUrl: null, ...o.before }),
    };
    const deps = testDeps({
      platform: o.platform ?? 'linux',
      uid: 1000,
      locations,
      ...(o.bins ? { bins: o.bins } : {}),
      handlers: [
        ...(o.handlers ?? []),
        onCommand(SYSTEMCTL, { stdout: 'systemd 252 (252.22-1~deb12u1)\n' }, ['--version']),
        onCommand(
          SYSTEMCTL,
          (call) => {
            if (call.args[1] === 'restart') {
              daemon.up = true;
              routes['GET /ctl/status'] = ok({ role: 'node', pairedDevices: 0, pushSubscriptions: 0, nodes: { paired: 0, online: 0 }, mode: { readOnly: false }, node: o.link === undefined ? LINKED : o.link });
              routes['GET /v1/state'] = ok({ state: serverState() });
            }
            return { code: 0 };
          },
          ['--user'],
        ),
        onCommand(LOGINCTL, { code: 0 }, ['enable-linger']),
      ],
    });
    const live = fakeCtl(routes);
    const down = fakeCtl({}, { down: true });
    const ctl: CtlClient = { ...live, request: <T>(...a: Parameters<CtlClient['request']>) => (daemon.up ? live : down).request<T>(...a) };
    const secretQuestions: string[] = [];
    const node = createNodeCommand({
      pairWithHub: (line, opts) => pairWithHub(line, { ...opts, fetch: hub.fetch }),
      loadHooks: () => loadHooksCli(),
      readText: async () => '6.1.0-18-amd64\n',
      askSecret: async (q) => {
        secretQuestions.push(q);
        return FLEET_SECRET;
      },
      linkWaitMs: 3000,
      ...o.deps,
    });
    const { ctx, io } = contextFor({ env: { ...home.env, USER: 'sam', ...o.env } }, { deps, ctl, ioOptions: o.answers ? { answers: o.answers } : {} });
    return { ctx, io, deps, hub, node, live, s, secretQuestions, daemon, unit: unitPath(ctx.paths) };
  }

  /** Nothing of a join is on disk: no key, no unit, no settings, no systemctl. */
  async function nothingWritten(t: Awaited<ReturnType<typeof server>>): Promise<void> {
    expect(existsSync(t.ctx.paths.nodeDir)).toBe(false);
    expect(existsSync(t.unit)).toBe(false);
    expect(existsSync(t.ctx.paths.configFile)).toBe(false);
    expect(t.deps.exec.calls).toEqual([]);
  }

  it('pairs, writes node.json 0600 only after the signature checks, starts the unit, installs the hooks, and says what works (0.2)', async () => {
    const t = await server({ answers: [CLIENT_ID] });
    expect(await t.node.run(['join', t.hub.line, '--hooks'], t.ctx), t.io.stderr).toBe(EXIT.ok);

    // The claim: the hub's pairing route, the Access token, the server's own new key, no redirect.
    expect(t.hub.claims).toHaveLength(1);
    const claim = t.hub.claims[0]!;
    expect(claim.url).toBe(`${FLEET_HUB_URL}/v1/node/pair`);
    expect(claim.redirect).toBe('error');
    expect(claim.headers['CF-Access-Client-Id']).toBe(CLIENT_ID);
    expect(claim.headers['CF-Access-Client-Secret']).toBe(FLEET_SECRET);
    expect(claim.body).toMatchObject({ os: 'linux', proto: 1 });
    expect(t.io.questions).toEqual(['Cloudflare Access client id (empty if the door has no Access): ']);
    expect(t.secretQuestions).toEqual(['Cloudflare Access client secret: ']);

    // node.json: the hub's key pinned, this server's private key, 0600 in a 0700 dir.
    const saved = await readNodeFile(t.ctx.paths.nodeFile);
    expect(saved).toMatchObject({ v: 1, url: FLEET_HUB_URL, nodeId: NODE_IDS.build1, name: 'build-1', hubKey: t.hub.hub.publicKey, cfAccess: { clientId: CLIENT_ID, clientSecret: FLEET_SECRET } });
    expect(String(claim.body.publicKey)).toHaveLength(43);
    expect((await stat(t.ctx.paths.nodeFile)).mode & 0o777).toBe(0o600);
    expect((await stat(t.ctx.paths.nodeDir)).mode & 0o777).toBe(0o700);

    // On tmux, Escape and Clear draft stay off until they are checked there; the binaries recorded.
    const config = JSON.parse(await readFile(t.ctx.paths.configFile, 'utf8'));
    expect(config.controls).toMatchObject({ escapeVerified: false, clearVerified: false });
    expect(config.bins.node).toBe(t.deps.nodePath);

    // The unit, started; lingering on.
    const unit = await readFile(t.unit, 'utf8');
    expect(unit).toContain('KillMode=process\n');
    expect(unit).not.toContain('--read-only');
    expect(argsOf(t.deps.exec.calls, SYSTEMCTL)).toEqual([['--version'], ['--user', 'daemon-reload'], ['--user', 'enable', 'jantar.service'], ['--user', 'restart', 'jantar.service']]);
    expect(argsOf(t.deps.exec.calls, LOGINCTL)).toEqual([['enable-linger', 'sam']]);

    // --hooks: the hooks installer once per config dir (not the scratch dir without a login).
    for (const dir of ['.claude', '.claude-work']) {
      expect(await readFile(join(home.home, dir, 'settings.json'), 'utf8')).toContain(t.ctx.paths.hookBin);
    }
    expect(existsSync(join(home.home, '.claude-scratch', 'settings.json'))).toBe(false);

    expect(t.io.stdout).toBe(
      'Paired with https://jantar.example.com as build-1.\n' +
        'Service: systemd user unit jantar.service, started. Lingering is on, so it keeps running after you log out.\n' +
        'Linked. 2 Claude sessions here (1 in tmux) on 2 accounts: claude (~/.claude), work (~/.claude-work).\n' +
        'Hooks: installed in ~/.claude/settings.json and ~/.claude-work/settings.json.\n' +
        "Sessions outside tmux show on the phone with their cards, but Jantar can't type into them.\n" +
        'Starting sessions from the phone is off here: jantar launch on, then jantar folders add-root <dir>.\n',
    );
    // The secret: never printed, never an argument of anything run.
    expect(`${t.io.stdout}${t.io.stderr}`).not.toContain(FLEET_SECRET);
    expect(JSON.stringify(t.deps.exec.calls)).not.toContain(FLEET_SECRET);
  });

  it('--read-only goes into the unit; --no-service runs nothing and prints the daemon line; the secret can come from the environment', async () => {
    const ro = await server({ env: { [SECRET_ENV]: FLEET_SECRET } });
    expect(await ro.node.run(['join', ro.hub.line, '--cf-access-client-id', CLIENT_ID, '--read-only'], ro.ctx), ro.io.stderr).toBe(EXIT.ok);
    expect(await readFile(ro.unit, 'utf8')).toMatch(/^ExecStart=\S+ \S+ --read-only$/m);
    expect(ro.io.stdout).toContain('Read-only: the daemon runs with --read-only (watch only).');
    expect(ro.io.stdout).toContain("Watch-only (--read-only): the phone can't send anything here.\n");
    expect(ro.io.stdout).not.toContain('Starting sessions');
    expect(ro.secretQuestions).toEqual([]);
    expect(ro.hub.claims[0]?.headers['CF-Access-Client-Secret']).toBe(FLEET_SECRET);

    await home.cleanup();
    home = await makeFakeHome({ sessions: [] });
    const ns = await server({ answers: [''] });
    expect(await ns.node.run(['join', ns.hub.line, '--no-service'], ns.ctx), ns.io.stderr).toBe(EXIT.ok);
    expect(ns.deps.exec.calls).toEqual([]);
    expect(existsSync(ns.unit)).toBe(false);
    expect((await readNodeFile(ns.ctx.paths.nodeFile))?.cfAccess).toBeNull();
    expect(ns.hub.claims[0]?.headers['CF-Access-Client-Id']).toBeUndefined();
    expect(ns.io.stdout).toContain(`Service: not installed (--no-service). Start the daemon yourself: ${ns.deps.nodePath} ${ns.deps.locations.daemonBin}\n`);
  });

  it('writes nothing when the answer is not signed by the Mac that made the line', async () => {
    const t = await server({ hub: fakeHub({ sign: 'wrong' }), answers: [''] });
    expect(await t.node.run(['join', t.hub.line], t.ctx)).toBe(EXIT.failed);
    expect(t.io.stderr).toBe(
      'Not joined. The server at that address is not the Mac that made this line: nothing was saved. Someone else may answer at that address and have used the line: at the Mac, run jantar node revoke <name> for the name it was made for.\n',
    );
    expect(t.io.stdout).toBe('');
    await nothingWritten(t);
  });

  it('writes nothing on a refused, used or mistyped line, and hints at Access when the door refused without a token', async () => {
    const used = await server({ hub: fakeHub({ status: 401 }), answers: [''] });
    expect(await used.node.run(['join', used.hub.line], used.ctx)).toBe(EXIT.failed);
    expect(used.io.stderr).toBe(
      'Not joined. This join line is not valid (used, expired or mistyped): make a new one at the Mac with jantar node pair. Nothing was saved on this machine.\n',
    );
    await nothingWritten(used);

    // Access refused the claim: this join again with the right token (the line still works), never jantar node access.
    const access = await server({ hub: fakeHub({ status: 403, jantarBody: false }), answers: [''] });
    expect(await access.node.run(['join', access.hub.line], access.ctx)).toBe(EXIT.failed);
    expect(access.io.stderr).toBe(
      'Not joined. This door has Cloudflare Access: run jantar node join <line> --cf-access-client-id <id> (the secret is asked hidden, or set JANTAR_CF_ACCESS_CLIENT_SECRET). Nothing was saved on this machine.\n',
    );
    await nothingWritten(access);
    const wrong = await server({ hub: fakeHub({ status: 403, jantarBody: false }), answers: [CLIENT_ID] });
    expect(await wrong.node.run(['join', wrong.hub.line], wrong.ctx)).toBe(EXIT.failed);
    expect(wrong.io.stderr).toBe(
      "Not joined. Cloudflare Access refused this server's service token (wrong, expired or revoked): run jantar node join <line> again with the right --cf-access-client-id; the secret is asked hidden. Nothing was saved on this machine.\n",
    );
    expect(wrong.io.stderr).not.toContain('jantar node access');
    await nothingWritten(wrong);

    const typo = await server();
    expect(await typo.node.run(['join', 'jn1.not-a-line!'], typo.ctx)).toBe(EXIT.failed);
    expect(typo.io.stderr).toBe('Not joined: the join line is mistyped. Nothing was saved on this machine. Make a new line at the Mac: jantar node pair\n');
    expect(typo.hub.claims).toEqual([]);
    await nothingWritten(typo);

    const pasted = await server();
    expect(await pasted.node.run(['join', 'node join'], pasted.ctx)).toBe(EXIT.failed);
    expect(pasted.io.stderr).toBe('Not joined: a join line starts with jn1. Nothing was saved on this machine. Make a new line at the Mac: jantar node pair\n');
  });

  it('S24: refuses a machine with phones, push subscriptions, servers or a front door of its own, before claiming anything', async () => {
    const cases: [Partial<CtlStatusView>, string][] = [
      [{ pairedDevices: 2 }, 'This machine already has 2 paired phones: it looks like a hub.'],
      [{ pushSubscriptions: 1 }, 'This machine already has 1 push subscription: it looks like a hub.'],
      [{ nodes: { paired: 3, online: 1 } }, 'This machine already has 3 paired servers: it looks like a hub.'],
      [{ publicUrl: 'https://phone.example.com' }, 'This machine already has a front door for phones (https://phone.example.com): it looks like a hub.'],
      [{ pairedDevices: 1, pushSubscriptions: 2 }, 'This machine already has 1 paired phone and 2 push subscriptions: it looks like a hub.'],
    ];
    for (const [before, sentence] of cases) {
      const t = await server({ before });
      expect(await t.node.run(['join', t.hub.line], t.ctx)).toBe(EXIT.failed);
      expect(t.io.stderr).toBe(`${sentence} Joining makes it a server and its phones lose it. Pass --replace-hub to do it anyway.\n`);
      expect(t.hub.claims).toEqual([]);
      expect(t.live.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /ctl/status']);
      expect(existsSync(t.ctx.paths.nodeDir)).toBe(false);
    }
  });

  it('S24: with the daemon down, its jantar.db (read-only) with phones, push subscriptions or servers, one it can\'t read, or a publicUrl counts as a hub', async () => {
    const cases: [{ devices?: number; pushes?: number; servers?: number }, string][] = [
      [{ devices: 2 }, 'This machine already has 2 paired phones: it looks like a hub.'],
      [{ devices: 1, pushes: 1 }, 'This machine already has 1 paired phone and 1 push subscription: it looks like a hub.'],
      [{ servers: 3 }, 'This machine already has 3 paired servers: it looks like a hub.'],
    ];
    for (const [records, sentence] of cases) {
      const t = await server();
      stoppedDb(t.ctx.paths.dbFile, records);
      const before = await readdir(t.ctx.paths.home);
      expect(await t.node.run(['join', t.hub.line], t.ctx)).toBe(EXIT.failed);
      expect(t.io.stderr).toBe(`${sentence} Joining makes it a server and its phones lose it. Pass --replace-hub to do it anyway.\n`);
      expect(t.hub.claims).toEqual([]);
      // Read only: no -wal or -shm left beside it, the database as it was.
      expect(await readdir(t.ctx.paths.home)).toEqual(before);
      expect(hubRecordsIn(t.ctx.paths.dbFile)).toEqual({ devices: records.devices ?? 0, pushes: records.pushes ?? 0, servers: records.servers ?? 0 });
      await home.cleanup();
      home = await makeFakeHome({ sessions: [] });
    }

    const db = await server();
    await mkdir(db.ctx.paths.home, { recursive: true });
    await writeFile(db.ctx.paths.dbFile, 'synthetic');
    expect(await db.node.run(['join', db.hub.line], db.ctx)).toBe(EXIT.failed);
    expect(db.io.stderr).toBe(
      `This machine has Jantar's database (${db.ctx.paths.dbFile}), join can't read it, and its daemon is not running, so join can't tell whether phones use this machine. Joining makes it a server and its phones lose it. Pass --replace-hub to do it anyway.\n`,
    );
    expect(db.hub.claims).toEqual([]);

    await home.cleanup();
    home = await makeFakeHome({ sessions: [] });
    const door = await server();
    await writeFile(door.ctx.paths.configFile, JSON.stringify({ version: 2, remote: { mode: 'cloudflare', publicUrl: 'https://phone.example.com', allowedOrigins: ['https://phone.example.com'] } }));
    expect(await door.node.run(['join', door.hub.line], door.ctx)).toBe(EXIT.failed);
    expect(door.io.stderr).toContain('This machine already has a front door for phones (https://phone.example.com): it looks like a hub.');
    expect(door.hub.claims).toEqual([]);
  });

  it('S24: --replace-hub says it once, then joins', async () => {
    const t = await server({ before: { pairedDevices: 2 }, answers: [''] });
    expect(await t.node.run(['join', t.hub.line, '--replace-hub'], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(t.io.stderr).toBe('Warning: This machine already has 2 paired phones: it looks like a hub. Joining makes it a server and its phones lose it. Going on (--replace-hub).\n');
    expect(t.hub.claims).toHaveLength(1);
    expect(await readNodeFile(t.ctx.paths.nodeFile)).not.toBeNull();
    // The running daemon took the settings (its restart then makes it a node).
    expect(t.s.patches).toContainEqual({ controls: { escapeVerified: false, clearVerified: false } });
  });

  it('refuses a second join, and a daemon that already says it is a server', async () => {
    const t = await server();
    await writeNodeFile(t.ctx.paths, nodeFile());
    expect(await t.node.run(['join', t.hub.line], t.ctx)).toBe(EXIT.failed);
    expect(t.io.stderr).toBe('This machine is already build-1 of https://jantar.example.com: jantar node leave first.\n');
    expect(t.hub.claims).toEqual([]);

    await home.cleanup();
    home = await makeFakeHome({ sessions: [] });
    // node.json gone (by hand, or a Windows task still running) while the daemon runs as a server: stop it, not "leave" (which says "not a server yet").
    const d = await server({ before: { role: 'node' } });
    expect(await d.node.run(['join', d.hub.line], d.ctx)).toBe(EXIT.failed);
    expect(d.io.stderr).toBe(
      "This machine's daemon still runs as a server, though its key is gone: stop it (jantar uninstall, or end the jantard you started), then join again.\n",
    );
  });

  it('leave, then join with a new line (revoke\'s and closeFix\'s path): the stopped daemon\'s jantar.db holds no phones, so the join goes on', async () => {
    const t = await server({ answers: [''] });
    await writeNodeFile(t.ctx.paths, nodeFile());
    await mkdir(join(home.home, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(t.unit, '[Service]\n');
    // A server's daemon keeps a jantar.db too (no phones, pushes or servers in it).
    stoppedDb(t.ctx.paths.dbFile);
    expect(await t.node.run(['leave', '--yes'], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(existsSync(t.ctx.paths.nodeDir)).toBe(false);
    expect(existsSync(t.ctx.paths.dbFile)).toBe(true);

    expect(await t.node.run(['join', t.hub.line], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(t.io.stderr).toBe('');
    expect(t.hub.claims).toHaveLength(1);
    expect(await readNodeFile(t.ctx.paths.nodeFile)).toMatchObject({ name: 'build-1', hubKey: t.hub.hub.publicKey });
  });

  it('with no systemctl here: pairs, gives the daemon\'s own line (never join --no-service), and leave, then a new join, still work', async () => {
    const missing = onCommand(SYSTEMCTL, { code: null, spawnError: 'spawn /usr/bin/systemctl ENOENT' });
    const t = await server({ answers: [''], handlers: [missing] });
    expect(await t.node.run(['join', t.hub.line, '--read-only'], t.ctx)).toBe(EXIT.failed);
    expect(t.io.stdout).toContain('Paired with https://jantar.example.com as build-1.\n');
    expect(t.io.stderr).toBe(
      'Service: not started: systemctl --user daemon-reload: spawn /usr/bin/systemctl ENOENT\n' +
        `Inside WSL, turn systemd on ([boot] systemd=true in /etc/wsl.conf, then wsl --shutdown) and run jantar install again. Elsewhere, run the daemon yourself: ${t.deps.nodePath} ${t.deps.locations.daemonBin} --read-only\n`,
    );
    expect(t.io.stderr).not.toContain('--no-service');
    // The hinted next step is the daemon's line (run by hand, so not here); this machine is a server now.
    expect(await t.node.run(['status'], t.ctx)).toBe(EXIT.ok);

    const out = t.io.stdout.length;
    expect(await t.node.run(['leave', '--yes'], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(t.io.stdout.slice(out)).toMatch(
      /^Daemon: systemd does not run here \(spawn \/usr\/bin\/systemctl ENOENT\), so the unit never ran; stop a jantard you started yourself\.\nService: removed .*jantar\.service\nLeft: this machine is no longer build-1 of jantar\.example\.com/,
    );
    expect(existsSync(t.ctx.paths.nodeDir)).toBe(false);
    expect(existsSync(t.unit)).toBe(false);

    const again = fakeHub();
    const t2 = await server({ answers: [''], handlers: [missing], hub: again });
    expect(await t2.node.run(['join', again.line, '--no-service'], t2.ctx), t2.io.stderr).toBe(EXIT.ok);
    expect(again.claims).toHaveLength(1);
  });

  it('WSL without systemd (systemctl there, systemd not the init): the same next step', async () => {
    const wsl = onCommand(SYSTEMCTL, { code: 1, stderr: "System has not been booted with systemd as init system (PID 1). Can't operate.\nFailed to connect to bus: Host is down\n" }, ['--user']);
    const t = await server({ answers: [''], handlers: [wsl] });
    expect(await t.node.run(['join', t.hub.line], t.ctx)).toBe(EXIT.failed);
    expect(t.io.stderr).toContain('[boot] systemd=true in /etc/wsl.conf');
    expect(t.io.stderr).toContain(`Elsewhere, run the daemon yourself: ${t.deps.nodePath} ${t.deps.locations.daemonBin}\n`);
    expect(await t.node.run(['leave', '--yes'], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(t.io.stdout).toContain("Daemon: systemd does not run here (System has not been booted with systemd as init system (PID 1). Can't operate.)");
    expect(existsSync(t.ctx.paths.nodeDir)).toBe(false);
  });

  it('an unbuilt daemon: the hint names the read-only choice, so the install it suggests can\'t be refused', async () => {
    const t = await server({ answers: [''] });
    await rm(join(t.deps.locations.daemonBin, '..', '..', 'dist'), { recursive: true });
    expect(await t.node.run(['join', t.hub.line], t.ctx)).toBe(EXIT.failed);
    expect(t.io.stderr).toMatch(/^Service: not installed: the daemon is not built .* Then: jantar install --no-read-only\n$/);
  });

  it('counts a session in tmux by its pane\'s tty before the daemon\'s tick gives it a paneId', async () => {
    const tmux = onCommand('/usr/bin/tmux', { stdout: '/dev/pts/3\n/dev/pts/4\n' }, ['list-panes', '-a', '-F', '#{pane_tty}']);
    const t = await server({ answers: [''], bins: { tmux: '/usr/bin/tmux' }, handlers: [tmux] });
    expect(await t.node.run(['join', t.hub.line], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(t.io.stdout).toContain('Linked. 2 Claude sessions here (2 in tmux) on 2 accounts');
    expect(t.io.stdout).not.toContain('outside tmux');
  });

  it('without --hooks: names the dirs that have them already (a leave keeps them), and hints only for the rest', async () => {
    const t = await server({ answers: [''] });
    await writeFile(join(t.ctx.paths.userHome, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: t.ctx.paths.hookBin }] }] } }));
    expect(await t.node.run(['join', t.hub.line, '--no-service'], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(t.io.stdout).toContain(
      'Hooks: already in ~/.claude/settings.json; not installed in ~/.claude-work/settings.json (cards need them): jantar hooks install --apply, with --settings <dir>/settings.json for each other config dir.\n',
    );
  });

  it('without a terminal: no secret prompt, so a token id needs the secret from the environment', async () => {
    const t = await server({ deps: { askSecret: undefined } });
    expect(await t.node.run(['join', t.hub.line, '--cf-access-client-id', CLIENT_ID], t.ctx)).toBe(EXIT.usage);
    expect(t.io.stderr).toContain(`the Access client secret comes from a hidden prompt (a terminal) or ${SECRET_ENV}, never a flag`);
    expect(t.hub.claims).toEqual([]);
    await nothingWritten(t);
  });

  it('says what to do when the link does not come up in time', async () => {
    const t = await server({ answers: [''], link: { name: 'build-1', hubHost: 'jantar.example.com', link: 'waiting', lastClose: { code: 4403, at: iso(1000) }, accessRefused: 0 } });
    expect(await t.node.run(['join', t.hub.line], t.ctx)).toBe(EXIT.ok);
    expect(t.io.stdout).toMatch(/^Not linked yet \(.+\)\. jantar node status says more; .+\.\n/m);
    expect(t.io.stdout).not.toContain('Linked.');
  });
});

describe('jantar node join on native Windows (preview)', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
    await writeHomeLayout(home.home, linuxHome());
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('pairs, prints the Scheduled Task lines to run, and runs nothing', async () => {
    const hub = fakeHub();
    const deps = testDeps({ platform: 'win32', locations: await fakePackages(home.root) });
    const { ctx, io } = contextFor(home, { deps, ioOptions: { answers: [''] } });
    const node = createNodeCommand({ pairWithHub: (line, opts) => pairWithHub(line, { ...opts, fetch: hub.fetch }), readText: async () => null, linkWaitMs: 0 });
    expect(await node.run(['join', hub.line], ctx), io.stderr).toBe(EXIT.ok);
    expect(hub.claims[0]?.body.os).toBe('windows');
    expect(deps.exec.calls).toEqual([]);
    expect(io.stdout).toContain('Service: on Windows, Jantar runs as a task at logon. In Command Prompt (cmd.exe, Run as administrator), run:\n');
    expect(io.stdout).toContain('  schtasks /Create /TN Jantar /SC ONLOGON /RL LIMITED /F /TR ');
    expect(io.stdout).toContain('--log-files');
    expect(io.stdout).toContain('  schtasks /Run /TN Jantar\n');
    expect(io.stdout).toContain('Windows: the phone shows these sessions and answers their cards; prompts and the screen need WSL2 (jantar doctor).\n');
    // No tmux here: Escape and Clear draft are left as they are.
    expect(JSON.parse(await readFile(ctx.paths.configFile, 'utf8')).controls?.escapeVerified ?? true).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('jantar node access, status and leave on a server', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
    await writeHomeLayout(home.home, linuxHome());
  });
  afterEach(async () => {
    await home.cleanup();
  });

  async function joined(o: { link?: CtlStatusView['node'] | 'down'; answers?: string[]; env?: Record<string, string>; systemctl?: Parameters<typeof onCommand>[1] } = {}) {
    const locations = await fakePackages(home.root);
    const deps = testDeps({
      platform: 'linux',
      uid: 1000,
      locations,
      bins: { tmux: '/usr/bin/tmux' },
      handlers: [onCommand('/usr/bin/tmux', { stdout: 'tmux 3.3a\n' }, ['-V']), onCommand(SYSTEMCTL, o.systemctl ?? { code: 0 }, ['--user'])],
    });
    const s = fakeSettings();
    const ctl =
      o.link === 'down'
        ? fakeCtl({}, { down: true })
        : fakeCtl({
            ...s.routes,
            'GET /ctl/status': ok({ role: 'node', mode: { readOnly: false }, node: o.link ?? LINKED }),
            'GET /v1/state': ok({ state: serverState() }),
          });
    const { ctx, io } = contextFor({ env: { ...home.env, USER: 'sam', ...o.env } }, { deps, ctl, ioOptions: o.answers ? { answers: o.answers } : {} });
    const file = nodeFile();
    await writeNodeFile(ctx.paths, file);
    const node = createNodeCommand({ askSecret: async () => 'synthetic-new-secret-2', readText: async () => null });
    return { ctx, io, deps, file, node, unit: unitPath(ctx.paths) };
  }

  it('access: a new id and secret in node.json (the key unchanged); with no service installed it says to restart jantard', async () => {
    const t = await joined({ answers: ['8b1e4d2c9f0a7e6d5c4b3a2918070605.access'] });
    expect(await t.node.run(['access'], t.ctx)).toBe(EXIT.failed);
    const after = await readNodeFile(t.ctx.paths.nodeFile);
    expect(after?.cfAccess).toEqual({ clientId: '8b1e4d2c9f0a7e6d5c4b3a2918070605.access', clientSecret: 'synthetic-new-secret-2' });
    expect(after?.privateKey).toBe(t.file.privateKey);
    expect(after?.nodeId).toBe(t.file.nodeId);
    expect((await stat(t.ctx.paths.nodeFile)).mode & 0o777).toBe(0o600);
    expect(t.io.questions).toEqual([`Cloudflare Access client id [${CLIENT_ID}]: `]);
    expect(t.deps.exec.calls).toEqual([]);
    expect(t.io.stderr).toBe('The service did not restart (the systemd unit is not installed (jantar install)): restart jantard so it reads the new token.\n');
    expect(`${t.io.stdout}${t.io.stderr}`).not.toContain('synthetic-new-secret-2');
  });

  it('access: keeps the id when the answer is empty; restarts an installed unit', async () => {
    const t = await joined({ answers: [''], env: { [SECRET_ENV]: 'synthetic-env-secret-3' } });
    await mkdir(join(home.home, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(t.unit, '[Service]\nExecStart=/opt/synthetic/node/bin/node /synthetic/jantard.mjs\n');
    expect(await t.node.run(['access'], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect((await readNodeFile(t.ctx.paths.nodeFile))?.cfAccess).toEqual({ clientId: CLIENT_ID, clientSecret: 'synthetic-env-secret-3' });
    expect(argsOf(t.deps.exec.calls, SYSTEMCTL)).toEqual([['--user', 'restart', 'jantar.service']]);
    expect(t.io.stdout).toBe(`Access token replaced for build-1 (client id ${CLIENT_ID}).\nRestarted jantar.service.\nThe link comes back on its own: jantar node status.\n`);
    expect(t.io.stdout).not.toContain('synthetic-env-secret-3');
  });

  it('status: the hub host and token id (never the secret or key), the link, tmux, accounts, hooks, read-only, starting', async () => {
    const t = await joined();
    await writeFile(join(home.home, '.claude-work', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${t.ctx.paths.hookBin}"` }] }] } }));
    expect(await t.node.run(['status'], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(t.io.stdout).toBe(
      `build-1, a server of jantar.example.com (Cloudflare Access client id ${CLIENT_ID})\n` +
        'Link:      linked\n' +
        'Terminal:  tmux 3.3a · 1 pane with Claude of 2 sessions\n' +
        'Accounts:  2 accounts: claude (~/.claude), work (~/.claude-work)\n' +
        'Hooks:     ~/.claude no, ~/.claude-work yes\n' +
        'Read-only: no\n' +
        'Starting:  off (jantar launch on, then jantar folders add-root <dir>)\n',
    );
    const json = await joined();
    expect(await json.node.run(['status', '--json'], json.ctx)).toBe(EXIT.ok);
    const j = JSON.parse(json.io.stdout);
    expect(j).toMatchObject({ name: 'build-1', hub: 'jantar.example.com', cfAccessClientId: CLIENT_ID, daemon: true, tmux: '3.3a', sessions: 2, panes: 1, accountsMode: 'dirs' });
    for (const out of [t.io.stdout, json.io.stdout]) {
      expect(out).not.toContain(FLEET_SECRET);
      expect(out).not.toContain('PRIVATE KEY');
    }
  });

  it('status: removed at the hub, and the daemon down', async () => {
    const removed = await joined({ link: { name: 'build-1', hubHost: 'jantar.example.com', link: 'waiting', lastClose: { code: 4401, at: iso(60_000) }, accessRefused: 0 } });
    expect(await removed.node.run(['status'], removed.ctx)).toBe(EXIT.ok);
    expect(removed.io.stdout).toContain('           -> Removed from the hub: run jantar node leave, then jantar node join with a new line\n');

    const down = await joined({ link: 'down' });
    expect(await down.node.run(['status'], down.ctx)).toBe(EXIT.ok);
    expect(down.io.stdout).toContain('Link:      the daemon is not running, so the phone shows this server offline (start it: jantar install)\n');
    expect(down.io.stdout).toContain('Read-only: unknown (daemon down)\n');
  });

  it('leave: stops and removes the unit, deletes the key, and says what stays (the Mac\'s row, the hooks)', async () => {
    const t = await joined();
    await mkdir(join(home.home, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(t.unit, '[Service]\n');
    await writeFile(join(home.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: t.ctx.paths.hookBin }] }] } }));
    expect(await t.node.run(['leave', '--yes'], t.ctx), t.io.stderr).toBe(EXIT.ok);
    expect(argsOf(t.deps.exec.calls, SYSTEMCTL)).toEqual([['--user', 'disable', '--now', 'jantar.service'], ['--user', 'daemon-reload']]);
    expect(existsSync(t.unit)).toBe(false);
    expect(existsSync(t.ctx.paths.nodeDir)).toBe(false);
    expect(t.io.stdout).toBe(
      `Daemon: stopped\nService: removed ${t.unit}\n` +
        'Left: this machine is no longer build-1 of jantar.example.com, and its key is deleted.\n' +
        'The Mac still lists build-1 until you remove it there: jantar node revoke build-1 (or Remove under Devices on an admin phone).\n' +
        "Claude's hooks here still call Jantar (they fail open): ~/.claude/settings.json. Remove them with jantar hooks uninstall --apply (--settings <file> for each other config dir).\n",
    );
  });

  it('leave: with no unit, systemctl is not asked; with one systemctl can\'t reach, the key is still deleted and the stop line printed', async () => {
    const none = await joined({ systemctl: { code: null, spawnError: 'spawn /usr/bin/systemctl ENOENT' } });
    expect(await none.node.run(['leave', '--yes'], none.ctx), none.io.stderr).toBe(EXIT.ok);
    expect(none.deps.exec.calls).toEqual([]);
    expect(none.io.stdout).toMatch(/^Service: not installed\nLeft: /);
    expect(existsSync(none.ctx.paths.nodeDir)).toBe(false);

    const bus = await joined({ systemctl: { code: 1, stderr: 'Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined\n' } });
    await mkdir(join(home.home, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(bus.unit, '[Service]\n');
    expect(await bus.node.run(['leave', '--yes'], bus.ctx), bus.io.stderr).toBe(EXIT.ok);
    expect(bus.io.stdout).toContain(
      'Daemon: not stopped (systemctl --user: Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined). If it still runs, stop it as sam in a login shell: systemctl --user stop jantar.service\n',
    );
    expect(existsSync(bus.unit)).toBe(false);
    expect(existsSync(bus.ctx.paths.nodeDir)).toBe(false);
  });

  it('access on a Mac server: the LaunchAgent is restarted (bootout, then bootstrap)', async () => {
    const LAUNCHCTL = '/bin/launchctl';
    const deps = testDeps({ platform: 'darwin', uid: 501, handlers: [onCommand(LAUNCHCTL, { code: 0 })] });
    const { ctx, io } = contextFor({ env: home.env }, { deps, ioOptions: { answers: [''] } });
    await writeNodeFile(ctx.paths, nodeFile());
    await mkdir(join(ctx.paths.userHome, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plistPath(ctx.paths), '<plist/>\n');
    const node = createNodeCommand({ askSecret: async () => 'synthetic-new-secret-4', readText: async () => null });
    expect(await node.run(['access'], ctx), io.stderr).toBe(EXIT.ok);
    expect(argsOf(deps.exec.calls, LAUNCHCTL).map((a) => a[0])).toEqual(['bootout', 'bootstrap']);
    expect(io.stdout).toContain('Restarted the LaunchAgent.\nThe link comes back on its own: jantar node status.\n');
  });

  it('leave: asks first, and without a terminal or a yes changes nothing', async () => {
    const no = await joined({ answers: ['n'] });
    expect(await no.node.run(['leave'], no.ctx)).toBe(EXIT.ok);
    expect(no.io.questions[0]).toContain('Leave? This machine stops being build-1 of jantar.example.com');
    expect(no.io.stdout).toBe('Still build-1 of jantar.example.com.\n');
    expect(existsSync(no.ctx.paths.nodeFile)).toBe(true);

    const tty = await joined();
    expect(await tty.node.run(['leave'], tty.ctx)).toBe(EXIT.failed);
    expect(tty.io.stdout).toBe('Still build-1 of jantar.example.com (not a terminal; add --yes to leave).\n');
    expect(tty.deps.exec.calls).toEqual([]);
    expect(existsSync(tty.ctx.paths.nodeFile)).toBe(true);
  });

  it('the Mac\'s verbs refuse on a server, naming it', async () => {
    for (const verb of [['pair'], ['list'], ['revoke', 'build-2']]) {
      const t = await joined();
      expect(await t.node.run(verb, t.ctx)).toBe(EXIT.failed);
      expect(t.io.stderr).toBe('This machine is build-1, a node of https://jantar.example.com: pair servers at the hub.\n');
    }
  });
});

// ---------------------------------------------------------------------------

describe('jantar new --node', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });

  const LAUNCH_ID = '01JSYNTHLAUNCH000000000000';
  const AT = iso(0);
  const ROOT: FileRoot = { id: 'r.code', kind: 'configured', label: 'code', display: '~/code', home: false, path: '/home/sam/code' };

  function hubCtl() {
    const flags = { ...V03_LAUNCH_FLAGS, permission: 'manual' as const };
    const preview: LaunchPreview = {
      root: 'r.code',
      path: 'api-server',
      display: '~/code/api-server',
      account: { pick: 1, source: 'auto', reason: 'the default login' },
      accounts: [],
      flags,
      defaults: flags,
      args: launchFlagArgs(flags),
      command: `cd -- /home/sam/code/api-server && env CLAUDE_CONFIG_DIR=/home/sam/.claude-work /home/sam/.local/bin/claude ${launchFlagArgs(flags).join(' ')} --session-id <session id> --name fix-tests`,
      name: 'fix-tests',
      warnings: [],
    };
    const job: LaunchJob = {
      id: LAUNCH_ID,
      createdAt: AT,
      updatedAt: AT,
      actor: 'cli',
      rootId: 'r.code',
      folder: '/home/sam/code/api-server',
      display: '~/code/api-server',
      account: 1,
      accountSource: 'auto',
      requested: 'auto',
      flags,
      dangerous: false,
      name: 'fix-tests',
      sid: '0b4e7c4e-3333-4333-8333-000000000003',
      stage: 'queued',
      steps: [{ at: AT, stage: 'queued', detail: 'Queued' }],
      node: NODE_IDS.build1,
    };
    return fakeCtl({
      'GET /v1/machines': ok({ machines: [row()] }),
      'GET /v1/folders/roots': ok({ roots: [ROOT] }),
      'GET /v1/launch/preview': ok(preview),
      'POST /v1/launches': ok({ job }, 202),
    });
  }

  it('sends ?node= on every folders and launch call, takes the server\'s own path and defaults, and names the server', async () => {
    const ctl = hubCtl();
    const { ctx, io } = contextFor(home, { ctl });
    expect(await newSession.run(['/home/sam/code/api-server/', '--node', 'build-1', '--name', 'fix-tests', '--no-wait'], ctx), io.stderr).toBe(EXIT.ok);
    const sent = ctl.calls.filter((c: CtlCall) => c.path.startsWith('/v1/folders') || c.path.startsWith('/v1/launch'));
    expect(sent.map((c) => c.path.split('?')[0])).toEqual(['/v1/folders/roots', '/v1/launch/preview', '/v1/launches']);
    for (const c of sent) expect(new URL(`http://ctl${c.path}`).searchParams.get('node')).toBe(NODE_IDS.build1);
    expect(new URL(`http://ctl${sent[1]!.path}`).searchParams.get('path')).toBe('api-server');
    // The Mac's own settings are not the server's: never read for the picks.
    expect(ctl.calls.some((c) => c.path === '/v1/settings')).toBe(false);
    expect(sent[2]?.body).toMatchObject({ root: 'r.code', path: 'api-server', account: 'auto', name: 'fix-tests', flags: { permission: 'manual' } });
    expect(io.stderr).toContain('Starting fix-tests in ~/code/api-server on account 1 on build-1');
  });

  it('refuses a folder that is not an absolute path there, and a server that is not paired', async () => {
    const rel = hubCtl();
    const a = contextFor(home, { ctl: rel });
    expect(await newSession.run(['code/api-server', '--node', 'build-1'], a.ctx)).toBe(EXIT.usage);
    expect(a.io.stderr).toContain("with --node, give the folder's absolute path on build-1");

    const b = contextFor(home, { ctl: hubCtl() });
    expect(await newSession.run(['/home/sam/code/api-server', '--node', 'build-9'], b.ctx)).toBe(EXIT.failed);
    expect(b.io.stderr).toContain('no paired server named "build-9"');
  });
});
