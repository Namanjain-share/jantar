/**
 * End to end: jantard in-process on a synthetic HOME (3 cswap profiles plus
 * the default login, fake cswap / ps / osascript / lsof on PATH, a random
 * port), booted with the production wiring (startDaemon, the same function
 * main.ts runs) and driven over its real sockets:
 *
 * 1. sessions appear with the right accounts (reused pid, sdk-cli and dead
 *    sessions dropped);
 * 2. a PermissionRequest hook round-trips through POST /v1/pending/:id/decision
 *    from a paired device (and never through ctl.sock);
 * 3. an AskUserQuestion answered from the "phone" reaches the real hook client;
 * 4. `jantar send` is proven against the synthetic transcript.
 *
 * read-only.integration.test.ts covers `--read-only` / `--no-terminal`, and
 * binary.integration.test.ts the real `jantard` executable.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_SIDS, SECRET_MARKER } from '@jantar/fixtures';
import { HOOK_CLIENT_PATH } from '@jantar/hook';
import {
  DEVICE_COOKIE,
  type AccountsResponse,
  type AuditResponse,
  type PairStartResponse,
  type PendingListResponse,
  type PendingRequest,
  type SessionsResponse,
  type StateResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, loadFactories, type Daemon } from './harness.js';
import { cookieFrom, eventually, hookTag, http, rememberSecret, sendHook } from './http.js';

const [SID_ALPHA, SID_BRAVO, SID_CHARLIE, SID_DOCS] = DEFAULT_LIVE_SIDS;
const DROPPED = [
  '44444444-4444-4444-8444-444444444444', // sdk-cli
  '55555555-5555-4555-8555-555555555555', // reused pid
  '66666666-6666-4666-8666-666666666666', // crashed (pid dead)
];

describe('wiring', () => {
  it('has every factory docs/LAYOUT.md promises', async () => {
    const load = await loadFactories();
    expect(load.missing).toEqual([]);
  });
});

describe('jantard end to end on a synthetic HOME', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let cookie: string | undefined;

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-30)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  beforeAll(async () => {
    d = await bootDaemon();
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
  }, 30_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  async function pairDevice(): Promise<string> {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'integration', scopes: ['read', 'control'] });
    expect(start.url).toContain('/pair#c=');
    const res = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'integration phone' } });
    expect(res.status, res.text).toBe(200);
    const c = cookieFrom(res, DEVICE_COOKIE);
    expect(c).toBeTruthy();
    rememberSecret(c as string, res.body);
    // single use
    const again = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'second phone' } });
    expect(again.status).toBeGreaterThanOrEqual(400);
    return c as string;
  }

  async function openCard(sid: string, tool: string): Promise<PendingRequest> {
    return eventually(async () => {
      const r = await callDaemon<PendingListResponse>(ctl, 'GET', '/v1/pending');
      return r.pending.find((p) => p.sid === sid && p.tool === tool && p.state === 'open');
    }, 10_000, `an open ${tool} card for ${sid}`);
  }

  it('discovers the live sessions on every profile, each on its own account', async () => {
    const sessions = await eventually(async () => {
      const r = await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions');
      return DEFAULT_LIVE_SIDS.every((sid) => r.sessions.some((s) => s.sid === sid)) ? r.sessions : null;
    }, 15_000, 'the four live sessions');
    const sids = sessions.map((s) => s.sid);
    for (const sid of DROPPED) expect(sids, `${sid} should be dropped`).not.toContain(sid);
    for (const sid of DEFAULT_LIVE_SIDS) {
      const s = sessions.find((x) => x.sid === sid);
      const fake = d.home.session(sid);
      expect(s?.account, `account of ${sid}`).toBe(fake.account);
      expect(s?.configDir).toBe(fake.configDir);
      expect(s?.folder).toBe(fake.project);
    }
    // the transcript kept in a profile's own projects/ dir is found too
    expect(sessions.find((s) => s.sid === SID_DOCS)?.account).toBe(4);
  });

  it('serves cswap accounts masked, and no route leaks secrets', async () => {
    const accounts = await eventually(async () => {
      const r = await callDaemon<AccountsResponse>(ctl, 'GET', '/v1/accounts');
      return r.accounts.length >= 4 ? r : null;
    }, 10_000, 'accounts');
    expect(accounts.accounts.map((a) => a.id).sort()).toEqual([1, 2, 3, 4]);
    // fresh cache (the fake home runs at the real current time): account 2's 5-hour window is 88 %
    const two = accounts.accounts.find((a) => a.id === 2);
    expect(two?.alias).toBe('team-b');
    expect(two?.windows.find((w) => w.kind === 'five_hour')?.pct).toBe(88);
    expect(accounts.accounts.find((a) => a.id === 3)?.disabled).toBe(true);
    const state = await ctl.request('GET', '/v1/state');
    const text = JSON.stringify(state.body) + JSON.stringify(accounts);
    expect(text).not.toContain(SECRET_MARKER);
    for (const a of d.home.accounts) expect(text).not.toContain(a.email);
  });

  it('needs a paired device on TCP: 401 without a cookie, 403 for a foreign Origin', async () => {
    expect((await http(d.port, 'GET', '/v1/state')).status).toBe(401);
    cookie = await pairDevice();
    expect((await http(d.port, 'GET', '/v1/state', { cookie })).status).toBe(200);
    const foreign = await http(d.port, 'POST', '/v1/notify/mute', { body: { minutes: 1 }, cookie, origin: 'https://evil.example.com' });
    expect(foreign.status).toBe(403);
    // SEC-2: a cookie replayed without its device secret can still read, but not write.
    expect((await http(d.port, 'GET', '/v1/state', { cookie, noSecret: true })).status).toBe(200);
    const replayed = await http(d.port, 'POST', '/v1/notify/mute', { body: { minutes: 1 }, cookie, noSecret: true });
    expect(replayed.status).toBe(401);
  });

  it('round-trips a PermissionRequest through /v1/pending decision', async () => {
    cookie ??= await pairDevice();
    const s = d.home.session(SID_CHARLIE);
    const toolInput = { command: 'npm run build', description: 'Build the synthetic app' };
    const conn = sendHook(
      d.ctx.paths.hooksSock,
      {
        hook_event_name: 'PermissionRequest',
        session_id: s.sid,
        transcript_path: s.transcriptPath,
        cwd: s.cwd,
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: toolInput,
        permission_suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }], behavior: 'allow', destination: 'session' },
        ],
        _jantar: hookTag(s.pid, true, s.configDir),
      },
      true,
    );
    try {
      const card = await openCard(s.sid, 'Bash');
      expect(card.kind).toBe('permission');
      expect(card.id.length).toBeGreaterThanOrEqual(26);
      const path = `/v1/pending/${encodeURIComponent(card.id)}/decision`;

      // the control socket never takes approvals (self-approval guard)
      const viaCtl = await ctl.request('POST', path, { behavior: 'allow' });
      expect(viaCtl.status).toBeGreaterThanOrEqual(400);
      // nor does TCP without a device, or with a foreign Origin
      expect((await http(d.port, 'POST', path, { body: { behavior: 'allow' } })).status).toBe(401);
      expect((await http(d.port, 'POST', path, { body: { behavior: 'allow' }, cookie, origin: 'https://evil.example.com' })).status).toBe(403);

      const res = await http(d.port, 'POST', path, { body: { behavior: 'allow' }, cookie });
      expect(res.status, res.text).toBe(200);
      expect(['decided', 'confirmed']).toContain((res.body as { pending: PendingRequest }).pending.state);

      const reply = (await conn.reply) as { v: number; output: { hookSpecificOutput: { hookEventName: string; decision: { behavior: string } } } };
      expect(reply.v).toBe(1);
      expect(reply.output.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
      expect(reply.output.hookSpecificOutput.decision.behavior).toBe('allow');

      // single use
      expect((await http(d.port, 'POST', path, { body: { behavior: 'deny' }, cookie })).status).toBe(409);

      // PostToolUse confirms the approval and the card leaves the open list
      await sendHook(
        d.ctx.paths.hooksSock,
        {
          hook_event_name: 'PostToolUse',
          session_id: s.sid,
          cwd: s.cwd,
          tool_name: 'Bash',
          tool_input: toolInput,
          tool_use_id: 'toolu_integration_1',
          tool_response: { stdout: 'built' },
          _jantar: hookTag(s.pid, false, s.configDir),
        },
        false,
      ).reply;
      await eventually(async () => {
        const st = await callDaemon<StateResponse>(ctl, 'GET', '/v1/state');
        const p = st.state.pending[card.id];
        return !p || p.state !== 'open' ? true : null;
      }, 10_000, 'the card to close');

      const audit = await callDaemon<AuditResponse>(ctl, 'GET', '/v1/audit');
      expect(audit.entries.some((e) => e.actor.startsWith('device:') && /decid|pending/i.test(e.action))).toBe(true);
    } finally {
      conn.close();
    }
  }, 30_000);

  it('answers an AskUserQuestion through the real hook client', async () => {
    cookie ??= await pairDevice();
    const s = d.home.session(SID_ALPHA);
    const questions = [
      { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false },
      { question: 'Which features?', header: 'Features', options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }], multiSelect: true },
    ];
    const child = spawn(process.execPath, [HOOK_CLIENT_PATH, '--wait'], {
      env: { HOME: d.home.home, JANTAR_HOME: d.home.jantarHome, PATH: d.home.env.PATH, LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    child.stdin.end(
      JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: s.sid,
        transcript_path: s.transcriptPath,
        cwd: s.cwd,
        permission_mode: 'default',
        tool_name: 'AskUserQuestion',
        tool_input: { questions },
      }),
    );
    try {
      const card = await openCard(s.sid, 'AskUserQuestion');
      expect(card.kind).toBe('question');
      expect(card.questions?.map((q) => q.question)).toEqual(['Which database?', 'Which features?']);

      // gate 7: the phone is told "<folder> needs you" (direction.md 5.8), and tapping opens this card
      const push = await eventually(async () => d.pushed.find((n) => n.pendingId === card.id), 10_000, 'the question push');
      const session = d.ctx.store.getState().sessions[s.sid];
      expect(push.kind).toBe('question');
      expect(push.title).toBe(`${session?.folder} needs you`);
      expect(push.url).toBe(`/s/${encodeURIComponent(s.sid)}?card=${encodeURIComponent(card.id)}`);
      const res = await http(d.port, 'POST', `/v1/pending/${encodeURIComponent(card.id)}/decision`, {
        body: { behavior: 'allow', answers: { 'Which database?': 'Postgres', 'Which features?': ['Auth', 'Billing'] } },
        cookie,
      });
      expect(res.status, res.text).toBe(200);
      expect(await exited).toBe(0);
      const out = JSON.parse(stdout.trim()) as { hookSpecificOutput: { decision: { behavior: string; updatedInput: { questions: unknown; answers: unknown } } } };
      expect(out.hookSpecificOutput.decision.behavior).toBe('allow');
      expect(out.hookSpecificOutput.decision.updatedInput.answers).toEqual({ 'Which database?': 'Postgres', 'Which features?': 'Auth,Billing' });
      expect(out.hookSpecificOutput.decision.updatedInput.questions).toEqual(questions);
      // ... and the audit log shows the answer, by the device, without the answer text
      const audit = await callDaemon<AuditResponse>(ctl, 'GET', '/v1/audit');
      const entries = audit.entries.filter((e) => e.target === card.id);
      expect(entries.some((e) => e.actor.startsWith('device:') && e.result === 'ok')).toBe(true);
      expect(JSON.stringify(entries)).not.toContain('Postgres');
    } finally {
      child.kill();
    }
  }, 30_000);

  it('sends a prompt with `jantar send` and proves it from the transcript', async () => {
    const s = d.home.session(SID_BRAVO);
    const text = 'please run the synthetic test suite';
    const before = await d.home.transcriptSize(s.sid);
    const io = memoryIo(d.home.env);
    const code = await main(['send', s.sid.slice(0, 8), text, '--timeout', '45'], { io, context: { paths: d.ctx.paths, ctl } });
    expect(code, `${io.stderr}\n${dumpLog()}`).toBe(0);
    expect(io.stdout).toContain('Prompt sent · bravo-api · fix flaky tests: proven by the transcript');

    // typed once, into bravo's tab, and recorded exactly once in its transcript
    expect(d.terminal.events.typed.filter((t) => t.paneId.endsWith(s.tty)).map((t) => t.text).join('')).toBe(text);
    expect(d.terminal.events.enters.filter((e) => e.submitted === text)).toHaveLength(1);
    const after = await d.home.transcriptSize(s.sid);
    expect(after).toBeGreaterThan(before);

    const state = await callDaemon<StateResponse>(ctl, 'GET', '/v1/state');
    const job = Object.values(state.state.sends).find((j) => j.sid === s.sid);
    expect(job?.stage).toBe('proven');
    expect(job?.proof?.kind).toBe('user');
    expect(job?.textLength).toBe(text.length);
    // the send job keeps a hash and a length, never the prompt itself
    expect(JSON.stringify(job)).not.toContain(text);
    expect(job?.textHash).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('`jantar status` reads the live daemon', async () => {
    const io = memoryIo(d.home.env);
    expect(await main(['status'], { io, context: { paths: d.ctx.paths, ctl } }), io.stderr).toBe(0);
    expect(io.stdout).toContain('bravo-api');
    expect(io.stdout).toContain('Accounts: 4');
  });

  const webBuilt = existsSync(fileURLToPath(new URL('../../packages/web/dist/index.html', import.meta.url)));

  it.skipIf(!webBuilt)('serves the built web app: shell, client routes, service worker, strict headers', async () => {
    const html = { accept: 'text/html' };
    const root = await http(d.port, 'GET', '/', { headers: html, origin: null });
    expect(root.status).toBe(200);
    expect(String(root.headers['content-type'])).toContain('text/html');
    expect(String(root.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(String(root.headers['content-security-policy'])).toContain("script-src 'self'");
    expect(root.headers['cache-control']).toBe('no-cache');
    // client routes a push or a pairing link opens get the app shell
    for (const path of [`/s/${SID_ALPHA}?card=01ABC`, '/pair', '/accounts', '/alerts', '/devices']) {
      const r = await http(d.port, 'GET', path, { headers: html, origin: null });
      expect(r.status, path).toBe(200);
      expect(r.text, path).toBe(root.text);
    }
    const sw = await http(d.port, 'GET', '/sw.js', { origin: null });
    expect(sw.status).toBe(200);
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect((await http(d.port, 'GET', '/manifest.webmanifest', { origin: null })).status).toBe(200);
    // the API never falls back to the shell
    expect((await http(d.port, 'GET', '/v1/nope', { headers: html, origin: null })).status).toBeGreaterThanOrEqual(400);
  });

  it('never scripted Terminal.app', async () => {
    expect(await d.home.calls('osascript')).toEqual([]);
  });
});
