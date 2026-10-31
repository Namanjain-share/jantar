import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountsResponseSchema,
  AlertsResponseSchema,
  AuditResponseSchema,
  BurnResponseSchema,
  DecisionResponseSchema,
  ErrorBodySchema,
  HealthResponseSchema,
  MovesResponseSchema,
  MuteResponseSchema,
  OkSchema,
  PendingListResponseSchema,
  PlanResponseSchema,
  PromptAcceptedSchema,
  ScreenResponseSchema,
  SendJobResponseSchema,
  SessionResponseSchema,
  SessionsResponseSchema,
  SettingsResponseSchema,
  StateResponseSchema,
  TranscriptResponseSchema,
  UsageRefreshResponseSchema,
  VapidKeyResponseSchema,
  type Account,
} from '@jantar/protocol';
import { HOST, TEST_VAPID, h, makeApi, makeCard, makeSession, pairCookie, type TestApi } from './fakes.js';

let api: TestApi;
let cookie: string;
let admin: string;

beforeEach(async () => {
  api = await makeApi({ sessions: [makeSession(), makeSession({ sid: 'sess-bbbb-2222', status: 'working', name: 'docs', tty: undefined })] });
  cookie = (await pairCookie(api, ['read', 'control'])).cookie;
  admin = (await pairCookie(api, ['admin'], 'Mac')).cookie;
});
afterEach(async () => {
  await api.close();
});

const get = (url: string, c = cookie) => api.tcp.inject({ method: 'GET', url, headers: h(c) });
const post = (url: string, payload?: object, c = cookie, extra: Record<string, string> = {}) =>
  api.tcp.inject({ method: 'POST', url, headers: h(c, extra), ...(payload ? { payload } : {}) });

describe('read routes', () => {
  it('GET /healthz is public and minimal', async () => {
    const res = await api.tcp.inject({ method: 'GET', url: '/healthz', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(res.json())).toEqual({ ok: true, protocol: 3, daemonVersion: '0.0.0-test' });
  });

  it('GET /v1/state, /v1/sessions (board order), /v1/sessions/:sid', async () => {
    const state = StateResponseSchema.parse((await get('/v1/state')).json());
    expect(state.epoch).toBe(api.ctx.store.epoch);
    expect(Object.keys(state.state.sessions)).toHaveLength(2);

    const sessions = SessionsResponseSchema.parse((await get('/v1/sessions')).json()).sessions;
    expect(sessions.map((s) => s.sid)).toEqual(['sess-aaaa-1111', 'sess-bbbb-2222']); // idle (your turn) before working

    const card = makeCard();
    api.ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });
    const one = SessionResponseSchema.parse((await get('/v1/sessions/sess-aaaa-1111')).json());
    expect(one.pending.map((p) => p.id)).toEqual([card.id]);
    expect(one.pane).toMatchObject({ backend: 'terminal-app', tty: '/dev/ttys004' });

    const nopane = SessionResponseSchema.parse((await get('/v1/sessions/sess-bbbb-2222')).json());
    expect(nopane.pane).toBeNull();
    expect((await get('/v1/sessions/nope')).statusCode).toBe(404);
  });

  it('caches pane lookups briefly (Terminal.app lookups run osascript)', async () => {
    await get('/v1/sessions/sess-aaaa-1111');
    await get('/v1/sessions/sess-aaaa-1111');
    expect(api.fakes.terminal.calls.filter((c) => c.startsWith('findPane'))).toHaveLength(1);
    api.ctx.clock.advance(6000);
    await get('/v1/sessions/sess-aaaa-1111');
    expect(api.fakes.terminal.calls.filter((c) => c.startsWith('findPane'))).toHaveLength(2);
  });

  it('GET transcript and screen', async () => {
    const t = TranscriptResponseSchema.parse((await get('/v1/sessions/sess-aaaa-1111/transcript?limit=1')).json());
    expect(t.items).toHaveLength(1);
    expect((await get('/v1/sessions/sess-aaaa-1111/transcript?limit=999')).statusCode).toBe(400);
    expect((await get('/v1/sessions/nope/transcript')).statusCode).toBe(404);
    api.fakes.transcripts.fail = true;
    const broken = await get('/v1/sessions/sess-aaaa-1111/transcript');
    expect(broken.statusCode).toBe(503);
    expect(JSON.stringify(broken.json())).not.toContain('disk on fire');

    const screen = ScreenResponseSchema.parse((await get('/v1/sessions/sess-aaaa-1111/screen?lines=40')).json());
    expect(screen).toMatchObject({ lines: 3, backend: 'terminal-app' });
    // v0.4.2: at least 60 lines are read (the dialog parser's window); the reply shows the 40 asked for.
    expect(api.fakes.terminal.calls).toContain('readScreen:60');
    expect((await get('/v1/sessions/sess-bbbb-2222/screen')).statusCode).toBe(404); // no tab
    api.fakes.terminal.readResult = { ok: false, code: 'permission', reason: '' };
    const denied = await get('/v1/sessions/sess-aaaa-1111/screen');
    expect(denied.statusCode).toBe(503);
    expect(denied.json().error.message).toMatch(/Automation/);
  });

  it('GET accounts, plan, moves, burn (ccw absent and present)', async () => {
    const account: Account = {
      id: 2,
      emailMasked: 'a***@e***.com',
      isDefaultLogin: false,
      disabled: false,
      held: false,
      usageStatus: 'ok',
      windows: [{ kind: 'five_hour', pct: 41 }],
    };
    api.ctx.store.emit({
      type: 'usage.updated',
      data: { accounts: [account], activeAccount: 2, fetchedAt: '2026-01-15T09:59:00.000Z', source: 'cache' },
    });
    const accounts = AccountsResponseSchema.parse((await get('/v1/accounts')).json());
    expect(accounts).toMatchObject({ activeAccount: 2, source: 'cache' });
    expect(accounts.accounts[0]?.id).toBe(2);

    expect(PlanResponseSchema.parse((await get('/v1/plan')).json())).toEqual({
      source: 'none',
      next: null,
      accounts: [],
      updatedAt: null,
      ceiling: 97,
      weeklyCeiling: 95,
    });
    expect(MovesResponseSchema.parse((await get('/v1/moves')).json())).toEqual({ moves: [], source: 'none' });
    expect(BurnResponseSchema.parse((await get('/v1/burn')).json())).toEqual({ sessions: [], source: 'none' });

    api.fakes.ccwLegacy.isPresent = true;
    expect(PlanResponseSchema.parse((await get('/v1/plan')).json()).next).toBe(3);
    // the fake ccw plan names no ceiling, so ours fills in
    expect(PlanResponseSchema.parse((await get('/v1/plan')).json()).ceiling).toBe(97);
  });

  it('GET /v1/plan shows the autoswitch ceilings to read-scope devices, which cannot read settings', async () => {
    const reader = (await pairCookie(api, ['read'], 'Reader')).cookie;
    expect((await get('/v1/settings', reader)).statusCode).toBe(403);
    await api.ctx.settings.patch({ autoswitch: { ceiling: 90, weekly_ceiling: 88 } });
    const plan = PlanResponseSchema.parse((await get('/v1/plan', reader)).json());
    expect(plan).toMatchObject({ source: 'none', ceiling: 90, weeklyCeiling: 88 });
    // while ccw runs, the ceiling in force is the one its plan carries
    api.fakes.ccwLegacy.isPresent = true;
    api.fakes.ccwLegacy.planCeiling = 93;
    expect(PlanResponseSchema.parse((await get('/v1/plan', reader)).json())).toMatchObject({ source: 'ccw-legacy', ceiling: 93, weeklyCeiling: 88 });
    expect(BurnResponseSchema.parse((await get('/v1/burn')).json()).sessions[0]?.pctPerMin).toBe(0.8);
  });

  it('GET /v1/alerts reads the persisted feed, falling back to live state', async () => {
    const alert = (id: string) => ({
      id,
      ts: '2026-01-15T10:00:00.000Z',
      kind: 'limit' as const,
      sid: 'sess-aaaa-1111',
      label: 'Limit hit · demo-app · refactor',
      what: 'usage limit reached',
    });
    api.ctx.store.emit({ type: 'alert.limit', sid: 'sess-aaaa-1111', data: { alert: alert('a1') } });
    let res = AlertsResponseSchema.parse((await get('/v1/alerts')).json());
    expect(res.alerts.map((a) => a.id)).toEqual(['a1']); // from state (nothing persisted)

    const unsub = api.ctx.store.subscribe((ev) => api.ctx.db.events.append(ev));
    const ev2 = api.ctx.store.emit({ type: 'alert.error', sid: 'sess-aaaa-1111', data: { alert: { ...alert('a2'), kind: 'error' } } });
    api.ctx.store.emit({ type: 'alert.blocked', data: { alert: { ...alert('a3'), kind: 'blocked' } } });
    unsub();
    res = AlertsResponseSchema.parse((await get('/v1/alerts')).json());
    expect(res.alerts.map((a) => a.id)).toEqual(['a3', 'a2']);
    expect(res.seq).toBe(api.ctx.store.seq);
    res = AlertsResponseSchema.parse((await get(`/v1/alerts?after=${ev2.seq}`)).json());
    expect(res.alerts.map((a) => a.id)).toEqual(['a3']);
  });

  it('GET /v1/sends/:jobId', async () => {
    const r = PromptAcceptedSchema.parse((await post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'continue' })).json());
    const job = SendJobResponseSchema.parse((await get(`/v1/sends/${r.jobId}`)).json()).job;
    expect(job.id).toBe(r.jobId);
    expect((await get('/v1/sends/nope')).statusCode).toBe(404);
  });
});

describe('write routes', () => {
  it('POST prompt -> 202 {jobId}; not found -> 404; refused -> 422 with the reason', async () => {
    const res = await post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'ultracode continue' });
    expect(res.statusCode).toBe(202);
    const body = PromptAcceptedSchema.parse(res.json());
    expect(body.job.stage).toBe('queued');
    expect(api.fakes.writer.submits[0]).toMatchObject({ sid: 'sess-aaaa-1111', onDraft: 'refuse', actor: { kind: 'device' } });

    expect((await post('/v1/sessions/nope/prompt', { text: 'x' })).statusCode).toBe(404);
    const refused = await post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'refuse-me' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({ error: { code: 'refused', message: 'a card is open for this session' } });
  });

  it('POST focus', async () => {
    expect(OkSchema.parse((await post('/v1/sessions/sess-aaaa-1111/focus')).json())).toEqual({ ok: true });
    expect(api.fakes.terminal.calls).toContain('focus:ta:/dev/ttys004');
    expect((await post('/v1/sessions/sess-bbbb-2222/focus')).statusCode).toBe(404);
  });

  it('GET /v1/pending and POST decision (decided, conflict, needs_confirm)', async () => {
    const card = makeCard();
    api.ctx.store.emit({ type: 'pending.opened', sid: card.sid, data: { pending: card } });
    expect(PendingListResponseSchema.parse((await get('/v1/pending')).json()).pending).toHaveLength(1);

    const confirm = await post(`/v1/pending/${card.id}/decision`, { behavior: 'allow', suggestion: 0 });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().error.code).toBe('needs_confirm');

    const ok = await post(`/v1/pending/${card.id}/decision`, { behavior: 'allow', suggestion: 0, confirm: true });
    expect(ok.statusCode).toBe(200);
    expect(DecisionResponseSchema.parse(ok.json()).pending.state).toBe('decided');

    const twice = await post(`/v1/pending/${card.id}/decision`, { behavior: 'deny' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('conflict');
    expect((await post('/v1/pending/01JNOPEXXXXXXXXXXXXXXXXXXXzzzz/decision', { behavior: 'deny' })).statusCode).toBe(404);
    expect((await post(`/v1/pending/${card.id}/decision`, { behavior: 'deny', answers: { q: 'a' } })).statusCode).toBe(400);
  });

  it('POST /v1/usage/refresh -> 202', async () => {
    const res = await post('/v1/usage/refresh');
    expect(res.statusCode).toBe(202);
    expect(UsageRefreshResponseSchema.parse(res.json()).queued).toBe(true);
    expect(api.fakes.usage.refreshes[0]).toMatch(/^api:device:/);
  });

  it('GET/PATCH /v1/settings (admin); invalid patches are 400', async () => {
    expect(SettingsResponseSchema.parse((await get('/v1/settings', admin)).json()).settings.autoswitch.on).toBe(false);
    const patched = await api.tcp.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: h(admin),
      payload: { notify: { kinds: ['permission', 'question', 'plan', 'send-failed', 'done'] } },
    });
    expect(patched.statusCode).toBe(200);
    expect(api.ctx.settings.get().notify.kinds).toContain('done');
    const json = { ...h(admin), 'content-type': 'application/json' };
    // v0.3: remote.* is Mac-only over TCP (403, test/api/v03-api.test.ts), so the bad value is a usage one.
    for (const bad of [
      '{"notify":{"typo":1}}',
      '{"usage":{"interval_s":-1}}',
      '{"__proto__":{"polluted":true},"autoswitch":{"on":"yes"}}',
    ]) {
      const res = await api.tcp.inject({ method: 'PATCH', url: '/v1/settings', headers: json, payload: bad });
      expect(res.statusCode, bad).toBe(400);
      expect(ErrorBodySchema.parse(res.json()).error.code).toBe('invalid_request');
    }
    // A "__proto__" key is dropped while parsing, so it can neither pollute nor sneak into settings.
    const proto = await api.tcp.inject({ method: 'PATCH', url: '/v1/settings', headers: json, payload: '{"__proto__":{"polluted":true}}' });
    expect(proto.statusCode).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(api.ctx.settings.get())).not.toContain('polluted');
  });

  it('POST /v1/notify/mute', async () => {
    const res = MuteResponseSchema.parse((await post('/v1/notify/mute', { minutes: 30 })).json());
    expect(res.mutedUntil).toBe('2026-01-15T10:30:00.000Z');
    expect(api.ctx.settings.get().notify.muted_until).toBe(res.mutedUntil);
    expect(MuteResponseSchema.parse((await post('/v1/notify/mute', { minutes: 0 })).json()).mutedUntil).toBeNull();
    expect((await post('/v1/notify/mute', { minutes: 99999 })).statusCode).toBe(400);
  });

  it('push subscribe / unsubscribe and the VAPID key', async () => {
    expect(VapidKeyResponseSchema.parse((await get('/v1/push/vapid-public-key')).json()).publicKey).toBe(TEST_VAPID.publicKey);
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/send/xyz', keys: { p256dh: 'p', auth: 'a' } };
    expect((await post('/v1/push/subscribe', { subscription: sub, kinds: ['question'] })).statusCode).toBe(200);
    expect(api.ctx.db.pushSubs.list()[0]).toMatchObject({ kinds: ['question'] });
    expect((await post('/v1/push/subscribe', { subscription: { ...sub, endpoint: 'http://insecure.example/x' } })).statusCode).toBe(400);
    const del = await api.tcp.inject({ method: 'DELETE', url: '/v1/push/subscribe', headers: h(cookie), payload: { endpoint: sub.endpoint } });
    expect(del.statusCode).toBe(200);
    expect(api.ctx.db.pushSubs.list()).toHaveLength(0);
  });

  it('GET /v1/audit lists writes with redacted params (no prompt text, no codes)', async () => {
    await post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'TOP SECRET PROMPT BODY' });
    await post('/v1/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/send/SECRETPATH', keys: { p256dh: 'p', auth: 'a' } } });
    const entries = AuditResponseSchema.parse((await get('/v1/audit', admin)).json()).entries;
    const prompt = entries.find((e) => e.action === 'sendPrompt');
    expect(prompt).toMatchObject({ result: 'ok', target: 'sess-aaaa-1111', params: { textLength: 22, onDraft: 'refuse' } });
    expect(prompt?.actor).toMatch(/^device:/);
    const all = JSON.stringify(entries);
    expect(all).not.toContain('TOP SECRET');
    expect(all).not.toContain('SECRETPATH');
    expect(all).toContain('fcm.googleapis.com');
    const after = AuditResponseSchema.parse((await get(`/v1/audit?after=${prompt?.seq}&limit=1`, admin)).json()).entries;
    expect(after).toHaveLength(1);
    expect(after[0]?.seq).toBe((prompt?.seq ?? 0) + 1);
  });
});

describe('request handling', () => {
  it('validates input and never leaks internals', async () => {
    const bad = await post('/v1/sessions/sess-aaaa-1111/prompt', { text: '' });
    expect(bad.statusCode).toBe(400);
    expect(ErrorBodySchema.parse(bad.json()).error.message).toMatch(/^invalid body at text/);
    const notJson = await api.tcp.inject({ method: 'POST', url: '/v1/notify/mute', headers: { ...h(cookie), 'content-type': 'application/json' }, payload: '{nope' });
    expect(notJson.statusCode).toBe(400);
    expect(notJson.json()).toEqual({ error: { code: 'invalid_request', message: 'request body is not valid JSON' } });
    const form = await api.tcp.inject({ method: 'POST', url: '/v1/notify/mute', headers: { ...h(cookie), 'content-type': 'application/x-www-form-urlencoded' }, payload: 'minutes=5' });
    expect(form.statusCode).toBe(400);
    expect(ErrorBodySchema.parse(form.json()).error.code).toBe('invalid_request');
    const missing = await get('/v1/nothing-here');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not_found', message: 'not found' } });
  });

  it('caps bodies at 64 KB (413)', async () => {
    const res = await post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'x'.repeat(70 * 1024) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
    expect(api.fakes.writer.submits).toHaveLength(0);
  });

  it('Idempotency-Key: a retried write runs once and replays the first answer', async () => {
    const k = { 'idempotency-key': 'phone-retry-1' };
    const a = await post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'continue' }, cookie, k);
    const b = await post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'continue' }, cookie, k);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.json()).toEqual(a.json());
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(api.fakes.writer.submits).toHaveLength(1);
    expect(api.fakes.writer.submits[0]?.idempotencyKey).toBe('phone-retry-1');
    expect(api.ctx.db.audit.list().filter((e) => e.action === 'sendPrompt')).toHaveLength(1);

    const conflict = await post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'something else' }, cookie, k);
    expect(conflict.statusCode).toBe(409);
    // Concurrent duplicates wait for the first.
    const k2 = { 'idempotency-key': 'phone-retry-2' };
    const [c, d] = await Promise.all([
      post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'go' }, cookie, k2),
      post('/v1/sessions/sess-aaaa-1111/prompt', { text: 'go' }, cookie, k2),
    ]);
    expect(c.json()).toEqual(d.json());
    expect(api.fakes.writer.submits).toHaveLength(2);
    expect((await post('/v1/notify/mute', { minutes: 1 }, cookie, { 'idempotency-key': 'bad key with spaces' })).statusCode).toBe(400);
  });

  it('sends the security headers on API responses', async () => {
    const res = await get('/v1/state');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('the CLI on the control socket acts as "cli" with every scope', async () => {
    const r = await api.ctl.inject({ method: 'POST', url: '/v1/sessions/sess-aaaa-1111/prompt', payload: { text: 'from the cli' } });
    expect(r.statusCode).toBe(202);
    expect(api.fakes.writer.submits.at(-1)?.actor).toEqual({ kind: 'cli' });
    expect((await api.ctl.inject({ method: 'GET', url: '/v1/settings' })).statusCode).toBe(200);
    const status = await api.ctl.inject({ method: 'GET', url: '/ctl/status' });
    expect(status.json()).toMatchObject({ protocol: 3, counts: { sessions: 2, devices: 2 }, hooks: { sessionsWithHooks: 1 } });
    const hooks = await api.ctl.inject({ method: 'GET', url: '/ctl/hooks' });
    expect(hooks.json().sessions).toEqual([
      { sid: 'sess-aaaa-1111', folder: 'demo-app', hooks: true },
      { sid: 'sess-bbbb-2222', folder: 'demo-app', hooks: false },
    ]);
    const wait = await api.ctl.inject({ method: 'GET', url: `/ctl/sends/${r.json().jobId}/wait?timeoutMs=10` });
    expect(wait.json().job.id).toBe(r.json().jobId);
    // /ctl routes do not exist on TCP.
    expect((await get('/ctl/status')).statusCode).toBe(404);
    expect(api.ctx.db.audit.list().at(-1)).toMatchObject({ actor: 'cli', action: 'sendPrompt' });
  });
});
