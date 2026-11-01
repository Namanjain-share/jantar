/**
 * The v0.3 CLI commands end to end: jantard in-process on a synthetic HOME
 * (the production wiring, startDaemon), every v0.3 switch at its default,
 * and `main()` from packages/cli talking to the daemon's real ctl.sock.
 *
 * 1. Each "turn it on at your Mac" refusal a paired phone meets names a
 *    command; that command, run as written, turns the feature on, and the
 *    phone's next request gets through.
 * 2. devices: grant launch to the phone by name (the scope applies at its
 *    next request), and take admin away from an admin device, which keeps
 *    launch and says "revoke launch too".
 * 3. folders, launch defaults and `jantar new`: a refused root, a root
 *    added, the flag picks over the Mac's defaults, a preview, then a real
 *    launch through the launcher into a scripted new window (no startup
 *    dialog) until the session is found and the launch is done.
 *
 * CliTerminal is the harness's ScriptedTerminal plus a new window that plays
 * WP-T1's LaunchScreenScript "clean" flow. Nothing runs osascript, cswap or
 * claude for real, and nothing binds port 7420.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCH_HELD,
  LAUNCH_TTY,
  LAUNCH_WINDOW_ID,
  LaunchScreenScript,
  completeLaunch,
  launchAccounts,
  parseLaunchCommand,
  perfBudgetMs,
  type FakeHome,
} from '@jantar/fixtures';
import type { OpResult, PaneTarget } from '@jantar/daemon';
import {
  DEVICE_COOKIE,
  type Features,
  type Pane,
  type PaneForeground,
  type PairStartResponse,
  type SessionsResponse,
  type SettingsResponse,
  type StateResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';
import { ScriptedTerminal } from './scripted-terminal.js';

const SID = '61616161-6161-4616-8616-616161616161';
const norm = (tty: string | undefined) => (tty ?? '').replace(/^\/dev\//, '');

class CliTerminal extends ScriptedTerminal {
  /** Every command a new window was opened with. */
  readonly opened: string[] = [];
  launch: LaunchScreenScript | null = null;
  private launched = false;

  constructor(private readonly fake: FakeHome) {
    super(fake);
  }

  private isLaunchTab(tty: string | undefined): boolean {
    return this.launch !== null && norm(tty) === norm(LAUNCH_TTY);
  }

  async openWindow(command: string): Promise<OpResult<{ tty: string; windowId: string }>> {
    this.opened.push(command);
    const { folder } = parseLaunchCommand(command);
    if (!folder) return { ok: false, code: 'failed', reason: 'no folder in the command' };
    this.launch = new LaunchScreenScript('clean', { folder, command });
    return { ok: true, tty: LAUNCH_TTY, windowId: String(LAUNCH_WINDOW_ID) };
  }

  override async findPane(target: PaneTarget): Promise<Pane | null> {
    if (this.isLaunchTab(target.tty)) {
      return { id: `terminal-app:${norm(LAUNCH_TTY)}`, backend: 'terminal-app', handle: '9:1', tty: norm(LAUNCH_TTY), foreground: 'claude', title: 'claude' };
    }
    return super.findPane(target);
  }

  override async readScreen(pane: Pane, opts: { lines?: number } = {}): Promise<OpResult<{ text: string; at: string }>> {
    if (!this.isLaunchTab(pane.tty) || !this.launch) return super.readScreen(pane, opts);
    const text = this.launch.screen();
    // Past the shell, Claude writes the session file with the typed --session-id.
    if (this.launch.state === 'ready' && !this.launched) {
      this.launched = true;
      await completeLaunch(this.fake, { command: this.opened.at(-1), startedAt: Date.now() });
    }
    return { ok: true, text, at: new Date().toISOString() };
  }

  override async foregroundOf(pane: Pane): Promise<PaneForeground> {
    if (!this.isLaunchTab(pane.tty) || !this.launch) return super.foregroundOf(pane);
    return this.launch.state === 'shell' || this.launch.state === 'claudeExited' ? 'shell' : 'claude';
  }
}

/** The command a refusal names: "... Turn it on at your Mac: jantar files on" gives ["files", "on"]. */
function namedCommand(message: string): string[] {
  const m = /\bjantar ([a-z][a-z -]*[a-z])/.exec(message);
  if (!m?.[1]) throw new Error(`no jantar command in "${message}"`);
  return m[1].split(' ');
}

describe('v0.3 CLI commands over the real control socket', () => {
  let d: Daemon;
  let terminal: CliTerminal;
  let ctl: CtlClient;
  let phone: string;

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  async function features(): Promise<Features> {
    const r = await http(d.port, 'GET', '/v1/state', { cookie: phone });
    expect(r.status, r.text).toBe(200);
    const f = (r.body as StateResponse).state.daemon?.features;
    if (!f) throw new Error('the state carries no feature switches');
    return f;
  }

  async function pair(name: string, scopes: string[]): Promise<string> {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name } });
    expect(claim.status, claim.text).toBe(200);
    const cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);
    return cookie;
  }

  beforeAll(async () => {
    d = await bootDaemon({
      home: {
        accounts: launchAccounts(),
        sessions: [{ sid: SID, pid: 61001, account: 5, project: 'demo-app', status: 'idle', tty: 'ttys041', transcript: [] }],
      },
      settings: { autoswitch: { hold: [...LAUNCH_HELD] } },
      terminal: (home) => (terminal = new CliTerminal(home)),
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => {
      const r = await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions');
      return r.sessions.some((s) => s.sid === SID);
    }, 15_000, 'the live session');
    phone = await pair('cli phone', ['read', 'control']);
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. every switch refusal names a command that turns the feature on', async () => {
    expect(await features()).toMatchObject({ files: false, launch: false, rewrite: false, controls: true, screenshots: false, screenshotSelect: false });

    const follow = async (path: string, method = 'GET', body?: unknown): Promise<string[]> => {
      const r = await http(d.port, method, path, { cookie: phone, ...(body === undefined ? {} : { body, headers: { 'idempotency-key': `k-${Math.random()}` } }) });
      expect(r.status, `${method} ${path}: ${r.text}`).toBe(403);
      const argv = namedCommand((r.body as { error: { message: string } }).error.message);
      const run = await cli(...argv);
      expect(run.code, `jantar ${argv.join(' ')}: ${run.err}\n${dumpLog()}`).toBe(0);
      return argv;
    };

    expect(await follow('/v1/files/roots')).toEqual(['files', 'on']);
    expect((await http(d.port, 'GET', '/v1/files/roots', { cookie: phone })).status).toBe(200);

    expect(await follow('/v1/folders/roots')).toEqual(['launch', 'on']);
    expect((await http(d.port, 'GET', '/v1/folders/roots', { cookie: phone })).status).toBe(200);

    expect(await follow(`/v1/sessions/${SID}/rewrite`, 'POST', { text: 'rename the helper' })).toEqual(['rewrite', 'on']);
    expect((await http(d.port, 'GET', '/v1/rewrite/no-such-job', { cookie: phone })).status).toBe(404);

    expect(await follow(`/v1/sessions/${SID}/screenshot`)).toEqual(['screenshots', 'on']);
    expect(await follow(`/v1/sessions/${SID}/screenshot?select=1`)).toEqual(['screenshots', 'allow-select']);

    expect((await cli('controls', 'off')).code).toBe(0);
    expect(await follow(`/v1/sessions/${SID}/keys`, 'POST', { key: 'clearInput' })).toEqual(['controls', 'on']);

    // Escape and Clear draft are on by default (verified on a real Mac, 30 Oct 2026).
    // v0.4's life and intel, v0.5's meetings, v0.5.3's ask and v0.6's fleet stay off here.
    expect(await features()).toEqual({ files: true, launch: true, rewrite: true, controls: true, screenshots: true, screenshotSelect: true, escape: true, clearDraft: true, life: false, intel: false, meetings: false, ask: false, fleet: false });

    // A config.json saved by 0.4.0 holds both off; the Mac switches them, and the phone sees it.
    expect((await cli('controls', 'escape', 'off')).code).toBe(0);
    expect((await cli('controls', 'clear-draft', 'off')).code).toBe(0);
    expect(await features()).toMatchObject({ escape: false, clearDraft: false });
    expect((await cli('controls', 'escape', 'on')).code).toBe(0);
    expect((await cli('controls', 'clear-draft', 'on')).code).toBe(0);
    expect(await features()).toMatchObject({ escape: true, clearDraft: true });

    // off again, from the Mac, and the phone is refused again
    expect((await cli('files', 'off')).code).toBe(0);
    expect((await http(d.port, 'GET', '/v1/files/roots', { cookie: phone })).status).toBe(403);
    expect((await cli('files', 'on')).code).toBe(0);

    // Rewrite's glossary and model land in the daemon's settings
    expect((await cli('rewrite', 'glossary', 'add', 'ccw', 'cswap')).code).toBe(0);
    expect((await cli('rewrite', 'model', 'sonnet')).code).toBe(0);
    const { settings } = await callDaemon<SettingsResponse>(ctl, 'GET', '/v1/settings');
    expect(settings.rewrite).toMatchObject({ enabled: true, model: 'sonnet', glossary: ['ccw', 'cswap'] });
  });

  it('2. devices: launch granted by name applies at the next request; demoting an admin says to revoke launch too', async () => {
    // a control device may not create folders (the launch scope): 403 before the body is read
    const before = await http(d.port, 'POST', '/v1/folders', { cookie: phone, body: {}, headers: { 'idempotency-key': 'k-folders-1' } });
    expect(before.status, before.text).toBe(403);
    // and it cannot grant itself the scope over the network
    const self = await http(d.port, 'POST', '/v1/devices/whatever/scopes', { cookie: phone, body: { add: ['launch'] } });
    expect(self.status).toBe(403);

    const list = await cli('devices', 'list');
    expect(list.code, list.err).toBe(0);
    expect(list.out).toContain('cli phone');
    expect(list.out).toContain('read + control');

    const grant = await cli('devices', 'grant', 'cli phone', 'launch');
    expect(grant.code, grant.err).toBe(0);
    expect(grant.out).toContain('cli phone now has read + control + launch.');
    const after = await http(d.port, 'POST', '/v1/folders', { cookie: phone, body: {}, headers: { 'idempotency-key': 'k-folders-2' } });
    expect(after.status, after.text).toBe(400); // past the scope check: only the empty body is wrong

    await pair('mac browser', ['read', 'control', 'admin']);
    const demote = await cli('devices', 'revoke-scope', 'mac browser', 'admin');
    expect(demote.code, demote.err).toBe(0);
    expect(demote.out).toContain('mac browser now has read + control + launch.');
    expect(demote.out).toContain("revoke launch too: jantar devices revoke-scope 'mac browser' launch");
    const launchToo = await cli('devices', 'revoke-scope', 'mac browser', 'launch');
    expect(launchToo.out).toContain('mac browser now has read + control.');
    // the three changes came from the Mac; the phone's own try was refused
    const rows = d.ctx.db.audit.list().filter((a) => a.action === 'deviceScopes');
    expect(rows.filter((a) => a.result === 'ok').map((a) => a.actor)).toEqual(['cli', 'cli', 'cli']);
    expect(rows.filter((a) => a.actor !== 'cli').every((a) => a.result === 'refused')).toBe(true);
  });

  it('3. folders, launch defaults and new: a session started over ctl.sock with the picked flags', async () => {
    const app = join(d.home.home, 'Desktop', 'work', 'app');
    await mkdir(app, { recursive: true });

    const refused = await cli('folders', 'add-root', '~/Library');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('a protected folder');
    const added = await cli('folders', 'add-root', join(d.home.home, 'Desktop', 'work'), '--id', 'work');
    expect(added.code, added.err).toBe(0);
    const roots = await cli('folders', 'roots');
    expect(roots.code, roots.err).toBe(0);
    expect(roots.out).toContain(`r.work`);
    expect(roots.out).toContain(`s.${SID}`);

    expect((await cli('launch', 'defaults', '--permission', 'acceptEdits', '--no-chrome', '--effort', 'high')).code).toBe(0);

    const preview = await cli('new', app, '--preview');
    expect(preview.code, preview.err).toBe(0);
    expect(preview.out).toContain('Start in ~/Desktop/work/app');
    expect(preview.out).toContain('  account  7 · ');
    expect(preview.out).toContain('-- --permission-mode acceptEdits --effort high --session-id <session id> --name app');
    expect(terminal.opened).toEqual([]);

    const started = await cli('new', app, '--timeout', '60');
    expect(started.code, `${started.out}\n${started.err}\n${dumpLog()}`).toBe(0);
    expect(started.out).toContain('Session started · app in ~/Desktop/work/app on account 7');
    const [command] = terminal.opened;
    expect(command).toMatch(/ -- --permission-mode acceptEdits --effort high --session-id [0-9a-f-]{36} --name app$/);
    expect(command).not.toContain('--dangerously-skip-permissions');
    expect(command).not.toContain('--chrome');
    const sessions = await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions');
    expect(sessions.sessions.some((s) => s.cwd === app && s.account === 7)).toBe(true);
    const launches = d.ctx.db.audit.list().filter((a) => a.action === 'launchStart');
    expect(launches.map((a) => a.actor)).toEqual(['cli']);
  }, perfBudgetMs(90_000));
});
