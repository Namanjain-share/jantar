/**
 * `jantard --read-only --no-terminal` end to end on a synthetic HOME: the
 * daemon observes everything (sessions, accounts, cards) and acts on
 * nothing. Every refused action is checked over the real sockets, and the
 * scripted terminal and the fake osascript must never be touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_SIDS } from '@jantar/fixtures';
import {
  DEVICE_COOKIE,
  type PairStartResponse,
  type PendingListResponse,
  type PendingRequest,
  type SessionsResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, hookTag, http, rememberSecret, sendHook } from './http.js';

const [SID_ALPHA, SID_BRAVO, SID_CHARLIE] = DEFAULT_LIVE_SIDS;

describe('jantard --read-only --no-terminal', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let cookie: string;

  beforeAll(async () => {
    d = await bootDaemon({ readOnly: true, noTerminal: true, settings: { usage: { poller: 'on' } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    // Pairing only changes Jantar's own state, so it stays allowed.
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'ro', scopes: ['read', 'control'] });
    const res = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'read-only phone' } });
    expect(res.status, res.text).toBe(200);
    cookie = cookieFrom(res, DEVICE_COOKIE) as string;
    expect(cookie).toBeTruthy();
    rememberSecret(cookie, res.body);
  }, 30_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  it('reports its mode on /ctl/status and in `jantar status`', async () => {
    const st = await callDaemon<{ mode: { readOnly: boolean; terminal: string }; usage: { polling: boolean } }>(ctl, 'GET', '/ctl/status');
    expect(st.mode).toEqual({ readOnly: true, terminal: 'off' });
    expect(st.usage.polling).toBe(false);
    const io = memoryIo(d.home.env);
    expect(await main(['status'], { io, context: { paths: d.ctx.paths, ctl } }), io.stderr).toBe(0);
    expect(io.stdout).toContain('read-only');
    expect(io.stdout).toContain('terminal off');
  });

  it('still discovers every live session with its account', async () => {
    const sessions = await eventually(async () => {
      const r = await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions');
      return DEFAULT_LIVE_SIDS.every((sid) => r.sessions.some((s) => s.sid === sid)) ? r.sessions : null;
    }, 15_000, 'the live sessions');
    for (const sid of DEFAULT_LIVE_SIDS) {
      expect(sessions.find((s) => s.sid === sid)?.account).toBe(d.home.session(sid).account);
    }
    expect((await http(d.port, 'GET', '/v1/state', { cookie })).status).toBe(200);
  });

  it('forces the cswap poller off even when config.json turns it on', async () => {
    const s = await callDaemon<{ settings: { usage: { poller: string } } }>(ctl, 'GET', '/v1/settings');
    expect(s.settings.usage.poller).toBe('off');
    const refresh = await http(d.port, 'POST', '/v1/usage/refresh', { cookie });
    expect(refresh.status).toBe(403);
    expect(d.parts.usage.requestRefresh('test').queued).toBe(false);
    expect((await d.home.calls('cswap')).filter((c) => c.args.includes('list'))).toEqual([]);
  });

  it('refuses prompts from a device and from `jantar send`', async () => {
    const s = d.home.session(SID_BRAVO);
    const res = await http(d.port, 'POST', `/v1/sessions/${s.sid}/prompt`, { body: { text: 'hello' }, cookie });
    expect(res.status).toBe(403);
    expect(res.text).toContain('read-only');

    const io = memoryIo(d.home.env);
    const code = await main(['send', s.sid.slice(0, 8), 'hello there', '--no-wait'], { io, context: { paths: d.ctx.paths, ctl } });
    expect(code).not.toBe(0);
    expect(io.stderr).toContain('read-only');

    // even a caller that reaches the writer directly is refused
    const direct = await d.parts.writer.submit({ sid: s.sid, text: 'hello', onDraft: 'refuse', actor: { kind: 'system' } });
    expect(direct.ok).toBe(false);
  });

  it('refuses focus, settings changes and mute; the screen peek needs a terminal', async () => {
    const s = d.home.session(SID_ALPHA);
    expect((await http(d.port, 'POST', `/v1/sessions/${s.sid}/focus`, { cookie })).status).toBe(403);
    const screen = await http(d.port, 'GET', `/v1/sessions/${s.sid}/screen`, { cookie });
    expect(screen.status).toBe(501);
    expect(screen.text).toContain('--no-terminal');
    expect((await http(d.port, 'POST', '/v1/notify/mute', { body: { minutes: 5 }, cookie })).status).toBe(403);
    const patch = await ctl.request('PATCH', '/v1/settings', { notify: { webpush: false } });
    expect(patch.status).toBe(403);
    expect(await d.ctx.settings.patch({ notify: { webpush: false } })).toMatchObject({ ok: false });
  });

  it('does not hold a blocking PermissionRequest: the session shows as waiting, with no card to answer', async () => {
    const s = d.home.session(SID_CHARLIE);
    const t0 = Date.now();
    const conn = sendHook(
      d.ctx.paths.hooksSock,
      {
        hook_event_name: 'PermissionRequest',
        session_id: s.sid,
        transcript_path: s.transcriptPath,
        cwd: s.cwd,
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'make synthetic', description: 'Build' },
        _jantar: hookTag(s.pid, true, s.configDir),
      },
      true,
    );
    try {
      // "no decision" at once: Claude falls back to asking in the terminal
      expect(await conn.reply).toEqual({ v: 1, output: null });
      expect(Date.now() - t0).toBeLessThan(5000);
      const session = await eventually(async () => {
        const r = await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions');
        const x = r.sessions.find((y) => y.sid === s.sid);
        return x?.status === 'waiting' ? x : null;
      }, 10_000, 'the session to show as waiting');
      expect(session.waitingFor).toBe('permission');
      const pending = await callDaemon<PendingListResponse>(ctl, 'GET', '/v1/pending');
      expect(pending.pending.filter((p: PendingRequest) => p.sid === s.sid)).toEqual([]);

      // answering is refused up front, whatever the id
      const res = await http(d.port, 'POST', '/v1/pending/01JZZZZZZZZZZZZZZZZZZZZZZZ/decision', { body: { behavior: 'allow' }, cookie });
      expect(res.status).toBe(403);
      expect(res.text).toContain('read-only');
      const direct = await d.parts.hooks.decide('01JZZZZZZZZZZZZZZZZZZZZZZZ', { behavior: 'allow' }, { kind: 'system' });
      expect(direct).toMatchObject({ ok: false, code: 'forbidden' });
    } finally {
      conn.close();
    }
  }, 30_000);

  it('never typed, pressed Enter, focused or ran osascript', async () => {
    expect(d.terminal.events).toEqual({ typed: [], enters: [], focused: [] });
    expect(await d.home.calls('osascript')).toEqual([]);
  });
});

describe('jantard --no-terminal (not read-only)', () => {
  let d: Daemon;
  let ctl: CtlClient;

  beforeAll(async () => {
    d = await bootDaemon({ noTerminal: true });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
  }, 30_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  it('answers 501 for the screen peek, focus and prompts, and the writer finds no tab', async () => {
    const s = await eventually(async () => {
      const r = await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions');
      return r.sessions.find((x) => x.sid === SID_BRAVO);
    }, 15_000, 'a live session');
    const st = await callDaemon<{ mode: { readOnly: boolean; terminal: string } }>(ctl, 'GET', '/ctl/status');
    expect(st.mode).toEqual({ readOnly: false, terminal: 'off' });
    expect((await ctl.request('GET', `/v1/sessions/${s.sid}/screen`)).status).toBe(501);
    expect((await ctl.request('POST', `/v1/sessions/${s.sid}/focus`)).status).toBe(501);
    expect((await ctl.request('POST', `/v1/sessions/${s.sid}/prompt`, { text: 'hello' })).status).toBe(501);
    const direct = await d.parts.writer.submit({ sid: s.sid, text: 'hello', onDraft: 'refuse', actor: { kind: 'system' } });
    if (direct.ok) {
      const job = await d.parts.writer.wait(direct.job.id, 20_000);
      expect(['failed', 'refused']).toContain(job?.stage);
    } else {
      expect(direct.code).toBe('refused');
    }
    expect(d.terminal.events).toEqual({ typed: [], enters: [], focused: [] });
    expect(await d.home.calls('osascript')).toEqual([]);
  }, 40_000);
});
