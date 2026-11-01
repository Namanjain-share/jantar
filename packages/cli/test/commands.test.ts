/**
 * status, send, pair, open, remote and hooks against an in-memory control
 * socket and a fake exec. Nothing here opens a browser or runs tailscale.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onCommand } from '@jantar/daemon/core/testing';
import { makeAccount, makeAlert, makeFakeHome, makePending, makeSendJob, makeSession, type FakeHome } from '@jantar/fixtures';
import { defaultSettings, emptyState, type SendJob, type State } from '@jantar/protocol';
import hooks, { createHooksCommand, loadHooksCli, translateHooksArgs, type HooksCliDeps } from '../src/commands/hooks.js';
import open, { boundBaseUrl, localPairUrl } from '../src/commands/open.js';
import pair, { isLoopbackUrl, scopesFor } from '../src/commands/pair.js';
import remote from '../src/commands/remote.js';
import send from '../src/commands/send.js';
import status from '../src/commands/status.js';
import { EXIT } from '../src/command.js';
import { T0, contextFor, fail, fakeCtl, fakePackages, ok, testDeps, type CtlCall } from './helpers.js';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
const SID_C = '33333333-3333-4333-8333-333333333333';
const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };

function boardState(): State {
  const s = emptyState();
  s.seq = 42;
  s.daemon = { protocol: 1, daemonVersion: '0.1.0', webHash: null };
  s.sessions[SID_A] = makeSession({ sid: SID_A, status: 'working', now: { kind: 'tool', tool: 'Bash', text: 'npm test' } });
  s.sessions[SID_B] = makeSession({
    sid: SID_B,
    account: 2,
    folder: 'bravo-api',
    name: 'fix flaky tests',
    status: 'idle',
    statusSince: '2026-01-15T09:59:00.000Z',
    lastReply: { text: 'All green.\u001b[2J\u0007 Done', at: '2026-01-15T09:59:00.000Z' },
  });
  s.sessions[SID_C] = makeSession({ sid: SID_C, account: 3, folder: 'charlie-web', name: 'refactor header', status: 'waiting' });
  s.pending.p1 = makePending({ id: '01JSYNTHETICPENDING00000000AAAAAAAAAAAAAAAA', sid: SID_C, input: { command: 'rm -rf build' } });
  s.accounts['1'] = makeAccount({ id: 1, alias: undefined, emailMasked: 'a***@e***.com', isDefaultLogin: true });
  s.accounts['2'] = makeAccount({ id: 2, held: true });
  s.activeAccount = 1;
  s.usage = { fetchedAt: '2026-01-15T09:58:00.000Z', source: 'cache' };
  s.alerts = [makeAlert({ what: 'usage limit reached' })];
  return s;
}

describe('jantar status', () => {
  it('prints the board with "needs you" first, accounts and alerts', async () => {
    const ctl = fakeCtl({ 'GET /v1/state': ok({ seq: 42, epoch: 'e1', state: boardState() }) });
    const { ctx, io } = contextFor({ env: ENV }, { ctl });
    expect(await status.run([], ctx)).toBe(EXIT.ok);
    const out = io.stdout;
    expect(out).toContain('jantard 0.1.0 (protocol 1) · seq 42');
    expect(out).toContain('3 live sessions · 1 needs you');
    const iC = out.indexOf('Permission · charlie-web · refactor header');
    const iB = out.indexOf('Done · bravo-api · fix flaky tests');
    const iA = out.indexOf('Working · alpha-app · add login form');
    expect(iC).toBeGreaterThan(0);
    expect(iC).toBeLessThan(iB);
    expect(iB).toBeLessThan(iA);
    expect(out).toContain('Bash: rm -rf build');
    expect(out).toContain('Bash: npm test');
    expect(out).toContain('#1   a***@e***.com  [default login]');
    expect(out).toContain('team-b (b***@e***.com)  [held]');
    expect(out).toContain('5h 42% (resets in 2h)');
    expect(out).toContain('usage limit reached');
    // transcript text never carries escape sequences to the terminal
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
    expect(out).toContain('All green. Done');
  });

  it('says what a session runs in the background (v0.6.1): working with a workflow, a quiet tag with shells only', async () => {
    const st = emptyState();
    st.seq = 7;
    st.sessions[SID_A] = makeSession({
      sid: SID_A,
      account: 3,
      folder: 'web-app',
      name: 'fix-login',
      status: 'idle',
      statusSource: 'hook',
      subagentsRunning: 1,
      background: { workflows: 1, shells: 6, since: new Date(T0 - 52 * 60_000).toISOString(), names: ['demo-sweep'] },
    });
    st.sessions[SID_B] = makeSession({ sid: SID_B, account: 3, folder: 'docs', name: 'typo', status: 'idle', background: { shells: 6 } });
    const ctl = fakeCtl({ 'GET /v1/state': ok({ seq: 7, epoch: 'e', state: st }) });
    const { ctx, io } = contextFor({ env: ENV }, { ctl });
    expect(await status.run([], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain(`  * Working · web-app · fix-login  (acct 3, ${SID_A.slice(0, 8)})\n      1 workflow running · 52m · demo-sweep · 6 shells\n`);
    expect(io.stdout).toContain(`  > Done · docs · typo  (acct 3, ${SID_B.slice(0, 8)})  [6 shells]`);
    // the Done session comes first ("your turn"), the one waiting on its workflow with the working ones
    expect(io.stdout.indexOf('Done · docs')).toBeLessThan(io.stdout.indexOf('Working · web-app'));
  });

  it('--json prints the state response', async () => {
    const ctl = fakeCtl({ 'GET /v1/state': ok({ seq: 1, epoch: 'e', state: emptyState() }) });
    const { ctx, io } = contextFor({ env: ENV }, { ctl });
    expect(await status.run(['--json'], ctx)).toBe(EXIT.ok);
    expect(JSON.parse(io.stdout)).toMatchObject({ seq: 1, epoch: 'e' });
  });

  it('exits 3 when the daemon is down', async () => {
    const { ctx, io } = contextFor({ env: ENV });
    expect(await status.run([], ctx)).toBe(EXIT.daemonDown);
    expect(io.stderr).toContain('not running');
  });
});

describe('jantar send', () => {
  const sessions = () => [
    makeSession({ sid: SID_A, folder: 'alpha-app', name: 'add login form' }),
    makeSession({ sid: SID_B, folder: 'bravo-api', name: 'fix flaky tests', status: 'idle' }),
    makeSession({ sid: '22229999-2222-4222-8222-222222222222', folder: 'bravo-web', name: 'other' }),
  ];

  function sendCtl(stages: Array<Partial<SendJob>>, accept: Partial<SendJob> = { stage: 'queued' }) {
    let polls = 0;
    const job = (over: Partial<SendJob>) => makeSendJob({ id: 'job-1', sid: SID_B, ...over });
    return fakeCtl({
      'GET /v1/sessions': ok({ sessions: sessions() }),
      [`POST /v1/sessions/${SID_B}/prompt`]: ok({ jobId: 'job-1', job: job(accept) }, 202),
      'GET /v1/sends/job-1': () => ok({ job: job(stages[Math.min(polls++, stages.length - 1)] ?? {}) }),
    });
  }

  it('queues the prompt and waits for the transcript proof', async () => {
    const ctl = sendCtl([{ stage: 'typed' }, { stage: 'enter' }, { stage: 'proven', proof: { kind: 'user', at: '2026-01-15T10:00:05.000Z' } }]);
    const { ctx, io } = contextFor({ env: ENV }, { ctl });
    expect(await send.run(['bravo-api', 'please', 'run', 'the', 'tests'], ctx)).toBe(EXIT.ok);
    const post = ctl.calls.find((c) => c.method === 'POST') as CtlCall;
    expect(post.path).toBe(`/v1/sessions/${SID_B}/prompt`);
    expect(post.body).toEqual({ text: 'please run the tests', onDraft: 'refuse' });
    expect(post.opts.idempotencyKey).toBeTruthy();
    expect(io.stderr).toContain('typed');
    expect(io.stderr).toContain('enter');
    expect(io.stdout).toContain('Prompt sent · bravo-api · fix flaky tests: proven by the transcript (user at 2026-01-15T10:00:05.000Z)');
  });

  it('resolves sessions by id prefix and refuses ambiguous matches', async () => {
    const ctl = sendCtl([{ stage: 'proven', proof: { kind: 'queued_command', at: '2026-01-15T10:00:05.000Z' } }]);
    const a = contextFor({ env: ENV }, { ctl });
    expect(await send.run(['22222222', 'hi'], a.ctx)).toBe(EXIT.ok);

    const b = contextFor({ env: ENV }, { ctl });
    expect(await send.run(['2222', 'hi'], b.ctx)).toBe(EXIT.usage);
    expect(b.io.stderr).toContain('matches 2 sessions');

    const c = contextFor({ env: ENV }, { ctl });
    expect(await send.run(['nope', 'hi'], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toContain('no live session matches');
  });

  it('reads the prompt from stdin with "-" and passes --replace', async () => {
    const ctl = sendCtl([{ stage: 'proven-merged', proof: { kind: 'user', at: '2026-01-15T10:00:05.000Z' } }]);
    const { ctx, io } = contextFor({ env: ENV }, { ctl, ioOptions: { stdin: 'line one\nline two\n' } });
    expect(await send.run([SID_B, '-', '--replace'], ctx)).toBe(EXIT.ok);
    expect(ctl.calls.find((c) => c.method === 'POST')?.body).toEqual({ text: 'line one\nline two', onDraft: 'replace' });
    expect(io.stdout).toContain('extra text in front');
  });

  it('is loud when the prompt was not sent', async () => {
    const refused = fakeCtl({
      'GET /v1/sessions': ok({ sessions: sessions() }),
      [`POST /v1/sessions/${SID_B}/prompt`]: fail('refused', 'a permission dialog is open', 422),
    });
    const a = contextFor({ env: ENV }, { ctl: refused });
    expect(await send.run([SID_B, 'hi'], a.ctx)).toBe(EXIT.failed);
    expect(a.io.stderr).toContain('Prompt NOT sent · bravo-api · fix flaky tests: a permission dialog is open');

    const failed = sendCtl([{ stage: 'typed' }, { stage: 'failed', reason: 'not proven after 12 Enter presses' }]);
    const b = contextFor({ env: ENV }, { ctl: failed });
    expect(await send.run([SID_B, 'hi'], b.ctx)).toBe(EXIT.failed);
    expect(b.io.stderr).toContain('Prompt NOT sent');
    expect(b.io.stderr).toContain('not proven after 12 Enter presses');
  });

  it('gives up waiting after --timeout without claiming success', async () => {
    const ctl = sendCtl([{ stage: 'enter' }]);
    const { ctx, io } = contextFor({ env: ENV }, { ctl });
    expect(await send.run([SID_B, 'hi', '--timeout', '3'], ctx)).toBe(EXIT.failed);
    expect(io.stderr).toContain('NOT proven yet');
    expect(io.stdout).not.toContain('Prompt sent');
  });

  it('--no-wait returns once queued; rejects empty or missing text', async () => {
    const ctl = sendCtl([{ stage: 'proven' }]);
    const a = contextFor({ env: ENV }, { ctl });
    expect(await send.run([SID_B, 'hi', '--no-wait'], a.ctx)).toBe(EXIT.ok);
    expect(ctl.calls.some((c) => c.path === '/v1/sends/job-1')).toBe(false);
    expect(await send.run([SID_B], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.usage);
    expect(await send.run([SID_B, '   '], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.usage);
    expect(await send.run([SID_B, 'x', '--timeout', '0'], contextFor({ env: ENV }, { ctl }).ctx)).toBe(EXIT.usage);
  });
});

describe('jantar pair / open', () => {
  const pairRes = (url: string) => ok({ code: 'c'.repeat(22), url, expiresAt: '2026-01-15T10:10:00.000Z' });

  it('pair asks for read + control by default and draws a QR code', async () => {
    const ctl = fakeCtl({ 'POST /v1/pair/start': pairRes(`https://mac.tailnet-0000.ts.net/pair#c=${'c'.repeat(22)}`) });
    const { ctx, io } = contextFor({ env: ENV }, { ctl });
    expect(await pair.run(['--name', 'phone'], ctx)).toBe(EXIT.ok);
    expect(ctl.calls[0]?.body).toEqual({ scopes: ['read', 'control'], name: 'phone' });
    expect(io.stdout).toMatch(/[▀▄█]/);
    expect(io.stdout).toContain('https://mac.tailnet-0000.ts.net/pair#c=');
    expect(io.stdout).toContain('expires in 10m');
    expect(io.stderr).toBe('');
  });

  it('pair warns when the link only works on this Mac, and supports --json / --no-qr', async () => {
    const ctl = fakeCtl({ 'POST /v1/pair/start': pairRes(`http://127.0.0.1:7420/pair#c=${'c'.repeat(22)}`) });
    const a = contextFor({ env: ENV }, { ctl });
    expect(await pair.run(['--no-qr', '--admin'], a.ctx)).toBe(EXIT.ok);
    expect(ctl.calls[0]?.body).toEqual({ scopes: ['read', 'control', 'admin'] });
    expect(a.io.stdout).not.toMatch(/[▀▄█]/);
    expect(a.io.stderr).toContain('jantar remote setup');

    const b = contextFor({ env: ENV }, { ctl });
    expect(await pair.run(['--json'], b.ctx)).toBe(EXIT.ok);
    expect(JSON.parse(b.io.stdout).url).toContain('/pair#c=');

    expect(scopesFor({ 'read-only': true })).toEqual(['read']);
    expect(() => scopesFor({ admin: true, 'read-only': true })).toThrow();
    expect(isLoopbackUrl('http://localhost:7420/pair')).toBe(true);
    expect(isLoopbackUrl('https://mac.tailnet-0000.ts.net/pair')).toBe(false);
  });

  it('open builds a loopback one-time link and opens it with /usr/bin/open', async () => {
    const ctl = fakeCtl({
      'POST /v1/pair/start': pairRes(`https://mac.tailnet-0000.ts.net/pair#c=${'c'.repeat(22)}`),
      'GET /v1/settings': ok({ settings: { remote: { host: '127.0.0.1', port: 7444 } } }),
    });
    const deps = testDeps({ bins: { open: '/usr/bin/open' }, handlers: [onCommand('/usr/bin/open', { code: 0 })] });
    const { ctx, io } = contextFor({ env: ENV }, { ctl, deps });
    expect(await open.run([], ctx)).toBe(EXIT.ok);
    expect(ctl.calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'This Mac', scopes: ['read', 'control', 'admin'] });
    expect(deps.exec.calls).toHaveLength(1);
    expect(deps.exec.calls[0]?.file).toBe('/usr/bin/open');
    expect(deps.exec.calls[0]?.args).toEqual([`http://127.0.0.1:7444/pair#c=${'c'.repeat(22)}`]);
    expect(io.stdout).toContain('Opened http://127.0.0.1:7444');

    const printed = contextFor({ env: ENV }, { ctl, deps: testDeps() });
    expect(await open.run(['--print', '--no-admin'], printed.ctx)).toBe(EXIT.ok);
    expect(printed.io.stdout.trim()).toBe(`http://127.0.0.1:7444/pair#c=${'c'.repeat(22)}`);
    expect(localPairUrl('http://127.0.0.1:7420', 'http://x/pair#c=abc')).toBe('http://127.0.0.1:7420/pair#c=abc');
  });

  it('open links to the port the daemon listens on, not the settings\' port', async () => {
    const ctl = fakeCtl({
      'GET /ctl/status': ok({ api: { host: '127.0.0.1', port: 62337 }, publicUrl: null }),
      'POST /v1/pair/start': pairRes(`http://127.0.0.1:62337/pair#c=${'c'.repeat(22)}`),
      'GET /v1/settings': ok({ settings: { remote: { host: '127.0.0.1', port: 7420 } } }),
    });
    const printed = contextFor({ env: ENV }, { ctl, deps: testDeps() });
    expect(await open.run(['--print'], printed.ctx)).toBe(EXIT.ok);
    expect(printed.io.stdout.trim()).toBe(`http://127.0.0.1:62337/pair#c=${'c'.repeat(22)}`);
    expect(ctl.calls.some((c) => c.path === '/v1/settings')).toBe(false);

    // A wildcard bind is reached on loopback; a phone's public URL never decides the local link.
    const wild = fakeCtl({
      'GET /ctl/status': ok({ api: { host: '0.0.0.0', port: 7491 }, publicUrl: 'https://mac.tailnet-0000.ts.net' }),
      'POST /v1/pair/start': pairRes(`https://mac.tailnet-0000.ts.net/pair#c=${'c'.repeat(22)}`),
    });
    const w = contextFor({ env: ENV }, { ctl: wild, deps: testDeps() });
    expect(await open.run(['--print'], w.ctx)).toBe(EXIT.ok);
    expect(w.io.stdout.trim()).toBe(`http://127.0.0.1:7491/pair#c=${'c'.repeat(22)}`);
    expect(boundBaseUrl({ host: '::1', port: 7420 })).toBe('http://[::1]:7420');

    // Not on TCP at all: no link and no pairing code spent.
    const none = fakeCtl({ 'GET /ctl/status': ok({ api: null }), 'POST /v1/pair/start': pairRes(`http://127.0.0.1:7420/pair#c=${'c'.repeat(22)}`) });
    const n = contextFor({ env: ENV }, { ctl: none, deps: testDeps() });
    expect(await open.run(['--print'], n.ctx)).toBe(EXIT.failed);
    expect(n.io.stderr).toMatch(/not listening on TCP/);
    expect(none.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('open prints the link when the browser cannot be opened', async () => {
    const ctl = fakeCtl({ 'POST /v1/pair/start': pairRes(`http://127.0.0.1:7420/pair#c=${'c'.repeat(22)}`) });
    const deps = testDeps({ bins: { open: '/usr/bin/open' }, handlers: [onCommand('/usr/bin/open', { code: 1, stderr: 'no browser' })] });
    const { ctx, io } = contextFor({ env: ENV }, { ctl, deps });
    expect(await open.run([], ctx)).toBe(EXIT.failed);
    expect(io.stdout).toContain('/pair#c=');
  });
});

describe('jantar remote', () => {
  let home: FakeHome;
  beforeEach(async () => {
    home = await makeFakeHome({ sessions: [] });
  });
  afterEach(async () => {
    await home.cleanup();
  });
  const TS = '/opt/synthetic/bin/tailscale';
  const running = onCommand(TS, { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tailnet-0000.ts.net.' } }) }, ['status', '--json']);

  it('setup prints the Tailscale Serve steps and runs nothing but status', async () => {
    const deps = testDeps({ bins: { tailscale: TS }, handlers: [running, onCommand(TS, { stdout: '{}' }, ['serve', 'status', '--json'])] });
    const { ctx, io } = contextFor(home, { deps });
    expect(await remote.run(['setup'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain(`${TS} serve --bg --https=443 http://127.0.0.1:7420`);
    expect(io.stdout).toContain(`${TS} serve https / http://127.0.0.1:7420`);
    expect(io.stdout).toContain('never use Funnel');
    expect(io.stdout).toContain('connected as mac.tailnet-0000.ts.net');
    expect(deps.exec.calls.map((c) => c.args)).toEqual([['status', '--json'], ['serve', 'status', '--json']]);
  });

  it('setup --apply runs tailscale serve and points pairing links at the tailnet URL', async () => {
    const deps = testDeps({
      bins: { tailscale: TS },
      handlers: [running, onCommand(TS, { stdout: '{}' }, ['serve', 'status', '--json']), onCommand(TS, { code: 0 }, ['serve', '--bg'])],
    });
    const { ctx, io } = contextFor(home, { deps });
    expect(await remote.run(['setup', '--apply'], ctx)).toBe(EXIT.ok);
    expect(deps.exec.calls.at(-1)?.args).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:7420']);
    const config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.remote).toMatchObject({ mode: 'tailscale', publicUrl: 'https://mac.tailnet-0000.ts.net', allowedOrigins: ['https://mac.tailnet-0000.ts.net'] });
    expect(io.stdout).toContain('Pairing links now use https://mac.tailnet-0000.ts.net');
  });

  it('setup --apply goes through the daemon when it runs, and refuses Funnel or a foreign Serve config', async () => {
    const patched: unknown[] = [];
    const ctl = fakeCtl({
      'GET /healthz': ok({ ok: true, protocol: 1, daemonVersion: '0.1.0' }),
      'GET /v1/settings': ok({ settings: defaultSettings() }),
      'PATCH /v1/settings': (call) => {
        patched.push(call.body);
        return ok({ settings: { remote: { mode: 'tailscale', publicUrl: 'https://mac.tailnet-0000.ts.net' } } });
      },
    });
    const serving = { Web: { 'mac.tailnet-0000.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7420' } } } } };
    const deps = testDeps({ bins: { tailscale: TS }, handlers: [running, onCommand(TS, { stdout: JSON.stringify(serving) }, ['serve', 'status', '--json'])] });
    const a = contextFor(home, { deps, ctl });
    expect(await remote.run(['setup', '--apply'], a.ctx)).toBe(EXIT.ok);
    expect(patched).toEqual([{ remote: { mode: 'tailscale', publicUrl: 'https://mac.tailnet-0000.ts.net', allowedOrigins: ['https://mac.tailnet-0000.ts.net'] } }]);
    expect(deps.exec.calls.some((c) => c.args[1] === '--bg')).toBe(false);
    expect(existsSync(join(home.jantarHome, 'config.json'))).toBe(false);

    const funnel = { ...serving, AllowFunnel: { 'mac.tailnet-0000.ts.net:443': true } };
    const fDeps = testDeps({ bins: { tailscale: TS }, handlers: [running, onCommand(TS, { stdout: JSON.stringify(funnel) }, ['serve', 'status', '--json'])] });
    const f = contextFor(home, { deps: fDeps });
    expect(await remote.run(['setup', '--apply'], f.ctx)).toBe(EXIT.failed);
    expect(f.io.stderr).toContain('Funnel');

    const other = { Web: { 'mac.tailnet-0000.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
    const oDeps = testDeps({ bins: { tailscale: TS }, handlers: [running, onCommand(TS, { stdout: JSON.stringify(other) }, ['serve', 'status', '--json'])] });
    const o = contextFor(home, { deps: oDeps });
    expect(await remote.run(['setup', '--apply'], o.ctx)).toBe(EXIT.failed);
    expect(o.io.stderr).toContain('Not replacing it');
    expect(oDeps.exec.calls.some((c) => c.args[1] === '--bg')).toBe(false);
  });

  it('setup --cloudflare prints the quick tunnel fallback', async () => {
    const { ctx, io } = contextFor(home, { deps: testDeps({ bins: { cloudflared: '/opt/synthetic/bin/cloudflared' } }) });
    expect(await remote.run(['setup', '--cloudflare'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('/opt/synthetic/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:7420');
    expect(io.stdout).toContain('changes every time');
    expect(await remote.run(['setup', '--cloudflare', '--apply'], contextFor(home).ctx)).toBe(EXIT.usage);
  });

  it('url sets and clears the public URL, validating it', async () => {
    const { ctx } = contextFor(home);
    expect(await remote.run(['url', 'https://abc-def.trycloudflare.com'], ctx)).toBe(EXIT.ok);
    let config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.remote).toMatchObject({ mode: 'cloudflare', publicUrl: 'https://abc-def.trycloudflare.com' });
    expect(await remote.run(['url', '--clear'], contextFor(home).ctx)).toBe(EXIT.ok);
    config = JSON.parse(await readFile(join(home.jantarHome, 'config.json'), 'utf8'));
    expect(config.remote).toMatchObject({ mode: 'loopback', publicUrl: null, allowedOrigins: [] });
    for (const bad of ['http://mac.example.com', 'https://mac.example.com/app', 'https://u:p@mac.example.com', 'nope']) {
      const c = contextFor(home);
      expect(await remote.run(['url', bad], c.ctx)).toBe(EXIT.usage);
    }
    expect(await remote.run(['frob'], contextFor(home).ctx)).toBe(EXIT.usage);
  });

  it('status shows the remote settings and tools', async () => {
    const deps = testDeps({ bins: { tailscale: TS }, handlers: [running, onCommand(TS, { stdout: '{}' }, ['serve', 'status', '--json'])] });
    const { ctx, io } = contextFor(home, { deps });
    expect(await remote.run(['status'], ctx)).toBe(EXIT.ok);
    expect(io.stdout).toContain('Mode:          loopback');
    expect(io.stdout).toContain('connected as mac.tailnet-0000.ts.net');
    const j = contextFor(home, { deps });
    expect(await remote.run(['status', '--json'], j.ctx)).toBe(EXIT.ok);
    expect(JSON.parse(j.io.stdout).tailscale.running).toBe(true);
  });
});

describe('jantar hooks (wrapper around the hooks installer)', () => {
  it('is a dry run unless --apply or --yes is given', () => {
    expect(translateHooksArgs(['install'])).toEqual(['install', '--dry-run']);
    expect(translateHooksArgs(['uninstall', '--settings', '/tmp/x.json'])).toEqual(['uninstall', '--settings', '/tmp/x.json', '--dry-run']);
    expect(translateHooksArgs(['--settings', 'install', 'uninstall'])).toEqual(['--settings', 'install', 'uninstall', '--dry-run']);
    expect(translateHooksArgs(['install', '--apply'])).toEqual(['install']);
    expect(translateHooksArgs(['install', '--yes'])).toEqual(['install', '--yes']);
    expect(translateHooksArgs(['install', '--apply', '-y'])).toEqual(['install', '-y']);
    expect(translateHooksArgs(['install', '--dry-run'])).toEqual(['install', '--dry-run']);
    expect(translateHooksArgs(['status', '--json'])).toEqual(['status', '--json']);
    expect(() => translateHooksArgs(['install', '--apply', '--dry-run'])).toThrow(/exclude/);
    expect(() => translateHooksArgs(['install', '--yes', '-n'])).toThrow(/exclude/);
  });

  it('stays a dry run when the subcommand comes after `--` (H5)', () => {
    // After `--` everything is an argument to the installer, so --dry-run must go before it.
    expect(translateHooksArgs(['--', 'install'])).toEqual(['--dry-run', '--', 'install']);
    expect(translateHooksArgs(['--', 'uninstall'])).toEqual(['--dry-run', '--', 'uninstall']);
    expect(translateHooksArgs(['--settings', '/tmp/x.json', '--', 'install'])).toEqual(['--settings', '/tmp/x.json', '--dry-run', '--', 'install']);
    // Flags after `--` are not flags: they cannot turn the dry run off.
    expect(translateHooksArgs(['--', 'install', '--yes'])).toEqual(['--dry-run', '--', 'install', '--yes']);
    expect(translateHooksArgs(['--', 'install', '--apply'])).toEqual(['--dry-run', '--', 'install', '--apply']);
    // Before `--` they still are.
    expect(translateHooksArgs(['--apply', '--', 'install'])).toEqual(['--', 'install']);
    expect(translateHooksArgs(['--yes', '--', 'install'])).toEqual(['--yes', '--', 'install']);
    expect(translateHooksArgs(['--', 'status'])).toEqual(['--', 'status']);
  });

  it('passes the context through and turns io.ask answers into yes/no', async () => {
    const seen: Array<{ args: readonly string[]; deps: HooksCliDeps }> = [];
    const cmd = createHooksCommand(async () => ({
      ok: true,
      run: async (args, deps) => {
        seen.push({ args, deps });
        return deps.ask ? ((await deps.ask('Write? ')) ? 0 : 1) : 0;
      },
    }));
    const a = contextFor({ env: ENV }, { ioOptions: { answers: ['yes'] } });
    expect(await cmd.run(['install', '--apply'], a.ctx)).toBe(EXIT.ok);
    expect(seen[0]?.args).toEqual(['install']);
    expect(seen[0]?.deps.paths).toBe(a.ctx.paths);
    expect(seen[0]?.deps.now?.().toISOString()).toBe('2026-01-15T10:00:00.000Z');
    const b = contextFor({ env: ENV }, { ioOptions: { answers: ['n'] } });
    expect(await cmd.run(['install', '--apply'], b.ctx)).toBe(EXIT.failed);
    const c = contextFor({ env: ENV });
    expect(await cmd.run(['status'], c.ctx)).toBe(EXIT.ok);
    expect(seen[2]?.deps.ask).toBeUndefined();
  });

  it('reports a missing installer and bad flags', async () => {
    const missing = createHooksCommand(async () => ({ ok: false, reason: 'the hooks installer is not available in this build' }));
    const a = contextFor({ env: ENV });
    expect(await missing.run(['status'], a.ctx)).toBe(EXIT.failed);
    expect(a.io.stderr).toContain('not available');
    expect(await hooks.run(['install', '--apply', '--dry-run'], contextFor({ env: ENV }).ctx)).toBe(EXIT.usage);
    const help = contextFor({ env: ENV });
    expect(await hooks.run(['--help'], help.ctx)).toBe(EXIT.ok);
    expect(help.io.stdout).toContain('--apply');
    expect((await loadHooksCli('@jantar/daemon/hooks/not-a-module')).ok).toBe(false);
  });

  describe('with the real hooks installer, on a synthetic HOME', async () => {
    const real = await loadHooksCli();
    let home: FakeHome;
    beforeEach(async () => {
      home = await makeFakeHome({ sessions: [] });
    });
    afterEach(async () => {
      await home.cleanup();
    });

    it.skipIf(!real.ok)('shows the diff and writes nothing by default', async () => {
      const before = await readFile(home.paths.claudeSettings, 'utf8');
      const { ctx, io } = contextFor(home);
      expect(await hooks.run(['install'], ctx)).toBe(EXIT.ok);
      expect(io.stdout).toContain('Dry run: nothing was written.');
      expect(io.stdout).toContain(join(home.jantarHome, 'bin', 'jantar-hook'));
      expect(io.stdout).toMatch(/^\+.*PermissionRequest/m);
      expect(await readFile(home.paths.claudeSettings, 'utf8')).toBe(before);
      expect(existsSync(join(home.jantarHome, 'bin', 'jantar-hook'))).toBe(false);
    });

    it.skipIf(!real.ok)('`hooks -- install` is a dry run too: no question, nothing written, even with a "y" ready (H5)', async () => {
      const before = await readFile(home.paths.claudeSettings, 'utf8');
      const { ctx, io } = contextFor(home, { ioOptions: { answers: ['y'] } });
      expect(await hooks.run(['--', 'install'], ctx)).toBe(EXIT.ok);
      expect(io.stdout).toContain('Dry run: nothing was written.');
      expect(io.questions).toEqual([]);
      expect(await readFile(home.paths.claudeSettings, 'utf8')).toBe(before);
      expect(existsSync(join(home.jantarHome, 'bin', 'jantar-hook'))).toBe(false);
    });

    it.skipIf(!real.ok)('--apply on a copy asks, writes, keeps other keys, and uninstall removes only ours', async () => {
      const dir = join(home.root, 'copy');
      await mkdir(dir, { recursive: true });
      const copy = join(dir, 'settings.json');
      const original = await readFile(home.paths.claudeSettings, 'utf8');
      await writeFile(copy, original);

      const no = contextFor(home, { ioOptions: { answers: ['n'] } });
      expect(await hooks.run(['install', '--apply', '--settings', copy], no.ctx)).toBe(EXIT.failed);
      expect(await readFile(copy, 'utf8')).toBe(original);

      const yes = contextFor(home, { ioOptions: { answers: ['y'] } });
      expect(await hooks.run(['install', '--apply', '--settings', copy], yes.ctx)).toBe(EXIT.ok);
      expect(yes.io.questions[0]).toContain('settings.json');
      const installed = JSON.parse(await readFile(copy, 'utf8'));
      expect(installed.cleanupPeriodDays).toBe(3650);
      expect(JSON.stringify(installed.hooks.PreToolUse)).toContain('synthetic-tool hook claude');
      expect(JSON.stringify(installed.hooks.PermissionRequest)).toContain('--wait');
      expect(existsSync(join(home.jantarHome, 'bin', 'jantar-hook'))).toBe(true);
      // the real ~/.claude/settings.json of the fake home was not touched
      expect(await readFile(home.paths.claudeSettings, 'utf8')).toBe(original);

      const st = contextFor(home);
      expect(await hooks.run(['status', '--settings', copy], st.ctx)).toBe(EXIT.ok);
      expect(st.io.stdout).toContain('Hooks: installed');

      const un = contextFor(home);
      expect(await hooks.run(['uninstall', '--yes', '--settings', copy], un.ctx)).toBe(EXIT.ok);
      expect(JSON.parse(await readFile(copy, 'utf8'))).toEqual(JSON.parse(original));
    });
  });
});
