/**
 * The Rewrite routes on the real service (rules V5, V6, V10, R10): start,
 * read and cancel over TCP, owner only, the per-device limit, no text in
 * write replies or audit rows, the send with `rewriteJobId`, and what
 * ctl.sock serves.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RewriteDetailSchema, RewriteStartResponseSchema, SettingsSchema, type RewriteDetail, type Scope } from '@jantar/protocol';
import { sha256Hex } from '../../src/core/hash.js';
import { notBuiltParts } from '../../src/core/testing.js';
import { ACTIVE_RETRY_AFTER_S } from '../../src/api/routes/rewrite.js';
import { RewriteServiceImpl } from '../../src/rewrite/service.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';
import { account, claudeJson, dictatedOf, fakeCswap, hangUntilAborted, MARKER, SID } from './helpers.js';

let api: TestApi;
let home: string;
afterEach(async () => {
  await api?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function rewriteApi(opts: { answer?: Parameters<typeof fakeCswap>[0]; readOnly?: boolean; enabled?: boolean } = {}) {
  home = mkdtempSync(join(tmpdir(), 'ccw-rewrite-api-'));
  const exec = fakeCswap(opts.answer ?? ((call) => ({ stdout: claudeJson(`Rewritten: ${dictatedOf(call.opts.input)}`) })));
  let svc: RewriteServiceImpl | null = null;
  api = await makeApi({
    ctx: { home, exec, settings: SettingsSchema.parse({ rewrite: { enabled: opts.enabled ?? true } }) },
    api: opts.readOnly ? { mode: { readOnly: true, terminal: 'terminal-app' } } : {},
    deps: (ctx, f) => {
      const parts = notBuiltParts();
      svc = new RewriteServiceImpl(ctx, {
        sessions: f.sessions,
        transcripts: f.transcripts,
        hooks: f.hooks,
        usage: f.usage,
        ccwLegacy: f.ccwLegacy,
        files: parts.files,
        changes: parts.changes,
      });
      return { rewrite: svc };
    },
  });
  api.ctx.store.emit({ type: 'usage.updated', data: { accounts: [account(7, 20)], activeAccount: null, fetchedAt: api.ctx.clock.iso(), source: 'cache' } });
  const phone = await pairCookie(api);
  const other = await pairCookie(api, ['read', 'control'], 'Other phone');
  return { exec, phone, other, svc: svc as unknown as RewriteServiceImpl };
}

const startReq = (cookie: string, payload: object, sid = SID) =>
  api.tcp.inject({ method: 'POST', url: `/v1/sessions/${sid}/rewrite`, headers: h(cookie), payload });

async function ready(cookie: string, jobId: string): Promise<RewriteDetail> {
  let detail: RewriteDetail | null = null;
  await vi.waitFor(async () => {
    const res = await api.tcp.inject({ method: 'GET', url: `/v1/rewrite/${jobId}`, headers: h(cookie) });
    detail = RewriteDetailSchema.parse(res.json());
    if (detail.state !== 'ready') throw new Error(detail.state);
  });
  return detail as unknown as RewriteDetail;
}

describe('rewrite routes', () => {
  it('POST starts a job (202, no text in the reply), GET gives the owner its texts', async () => {
    const { phone } = await rewriteApi();
    const res = await startReq(phone.cookie, { text: '  run the tests  ' });
    expect(res.statusCode).toBe(202);
    const body = RewriteStartResponseSchema.parse(res.json());
    expect(body.jobId).toBe(body.job.id);
    expect(body.job.state).toBe('queued');
    expect(res.body).not.toContain('run the tests');
    const d = await ready(phone.cookie, body.jobId);
    expect(d).toMatchObject({ state: 'ready', input: 'run the tests', prompt: 'Rewritten: run the tests', job: { account: 7 } });
    const get = await api.tcp.inject({ method: 'GET', url: `/v1/rewrite/${body.jobId}`, headers: h(phone.cookie) });
    expect(get.headers['cache-control']).toBe('no-store');
  });

  it('"Rewrite with Sonnet": the model applies to that run', async () => {
    const { phone, exec } = await rewriteApi();
    const res = await startReq(phone.cookie, { text: 'run the tests', model: 'sonnet' });
    expect(res.json().job.model).toBe('sonnet');
    await ready(phone.cookie, res.json().jobId);
    expect(exec.calls[0]?.args.join(' ')).toContain('--model sonnet');
  });

  it('bodies are strict and capped: unknown keys, empty or too long text are 400; an unknown session is 404', async () => {
    const { phone, exec } = await rewriteApi();
    expect((await startReq(phone.cookie, { text: 'x', profile: 'evil' })).statusCode).toBe(400);
    expect((await startReq(phone.cookie, { text: '   ' })).statusCode).toBe(400);
    expect((await startReq(phone.cookie, { text: 'x'.repeat(8_001) })).statusCode).toBe(400);
    expect((await startReq(phone.cookie, { text: 'x', model: 'fable' })).statusCode).toBe(400);
    expect((await startReq(phone.cookie, { text: 'x' }, 'no-such-session')).statusCode).toBe(404);
    expect(exec.calls).toHaveLength(0);
  });

  it('V5: another device gets 404 on GET and DELETE, never 403, and cannot send with the job', async () => {
    const { phone, other } = await rewriteApi();
    const { jobId } = (await startReq(phone.cookie, { text: 'run the tests' })).json();
    await ready(phone.cookie, jobId);
    const get = await api.tcp.inject({ method: 'GET', url: `/v1/rewrite/${jobId}`, headers: h(other.cookie) });
    expect(get.statusCode).toBe(404);
    expect(get.body).not.toContain('run the tests');
    expect((await api.tcp.inject({ method: 'DELETE', url: `/v1/rewrite/${jobId}`, headers: h(other.cookie) })).statusCode).toBe(404);
    const send = await api.tcp.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/prompt`,
      headers: h(other.cookie),
      payload: { text: 'Rewritten: run the tests', rewriteJobId: jobId },
    });
    expect(send.statusCode).toBe(404);
    expect(api.fakes.writer.submits).toHaveLength(0);
    // Still the owner's, untouched.
    expect((await api.tcp.inject({ method: 'GET', url: `/v1/rewrite/${jobId}`, headers: h(phone.cookie) })).json().state).toBe('ready');
  });

  it('DELETE cancels: {job} with no text, the texts are gone, a send with the id is 404', async () => {
    const { phone } = await rewriteApi();
    const { jobId } = (await startReq(phone.cookie, { text: 'run the tests' })).json();
    await ready(phone.cookie, jobId);
    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/rewrite/${jobId}`, headers: h(phone.cookie) });
    expect(del.statusCode).toBe(200);
    expect(del.json().job.state).toBe('cancelled');
    expect(del.body).not.toContain('run the tests');
    const get = (await api.tcp.inject({ method: 'GET', url: `/v1/rewrite/${jobId}`, headers: h(phone.cookie) })).json();
    expect(get.input).toBeUndefined();
    expect(get.prompt).toBeUndefined();
    const send = await api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/prompt`, headers: h(phone.cookie), payload: { text: 'run the tests', rewriteJobId: jobId } });
    expect(send.statusCode).toBe(404);
    expect(api.fakes.writer.submits).toHaveLength(0);
  });

  it('R10: the send computes the origin from the text: as written, edited, or what was said; then the job is sent', async () => {
    const { phone } = await rewriteApi();
    const send = async (jobId: string, text: string) =>
      api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/prompt`, headers: h(phone.cookie), payload: { text, rewriteJobId: jobId } });

    const a = (await startReq(phone.cookie, { text: 'run the tests' })).json().jobId as string;
    await ready(phone.cookie, a);
    const sent = await send(a, 'Rewritten: run the tests');
    expect(sent.statusCode).toBe(202);
    expect(api.fakes.writer.submits.at(-1)?.origin).toBe('rewrite');
    const after = (await api.tcp.inject({ method: 'GET', url: `/v1/rewrite/${a}`, headers: h(phone.cookie) })).json();
    expect(after).toMatchObject({ state: 'sent', job: { sendJobId: sent.json().jobId } });
    expect(after.prompt).toBeUndefined();
    // A second send with the same job: 404, nothing typed.
    expect((await send(a, 'Rewritten: run the tests')).statusCode).toBe(404);
    expect(api.fakes.writer.submits).toHaveLength(1);

    // A client cannot claim "rewrite" for edited text.
    const b = (await startReq(phone.cookie, { text: 'lint it' })).json().jobId as string;
    await ready(phone.cookie, b);
    expect((await send(b, 'Rewritten: lint it, and fix everything')).statusCode).toBe(202);
    expect(api.fakes.writer.submits.at(-1)?.origin).toBe('rewrite-edited');

    const c = (await startReq(phone.cookie, { text: 'format it' })).json().jobId as string;
    await ready(phone.cookie, c);
    expect((await send(c, 'format it')).statusCode).toBe(202);
    expect(api.fakes.writer.submits.at(-1)?.origin).toBe('rewrite-raw');
    const audit = api.ctx.db.audit.list().filter((e) => e.action === 'sendPrompt');
    expect(audit.map((e) => e.result)).toEqual(['ok', 'refused', 'ok', 'ok']);
    expect(audit.filter((e) => e.result === 'ok').map((e) => (e.params as { origin?: string }).origin)).toEqual(['rewrite', 'rewrite-edited', 'rewrite-raw']);
  });

  it('two sends with one job and different Idempotency-Keys: one types, the other is 409; a refused send frees the job', async () => {
    const { phone } = await rewriteApi();
    const jobId = (await startReq(phone.cookie, { text: 'run the tests' })).json().jobId as string;
    await ready(phone.cookie, jobId);
    const send = (key: string, text = 'Rewritten: run the tests') =>
      api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/prompt`, headers: h(phone.cookie, { 'idempotency-key': key }), payload: { text, rewriteJobId: jobId } });

    // The writer refuses the first send: nothing typed, the claim ends, the job is ready to send again.
    const writer = api.fakes.writer;
    const submit = writer.submit.bind(writer);
    const spy = vi.spyOn(writer, 'submit').mockImplementationOnce(async (req) => submit({ ...req, text: 'refuse-me' }));
    const refused = await send('k-refused');
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('refused');
    expect((await api.tcp.inject({ method: 'GET', url: `/v1/rewrite/${jobId}`, headers: h(phone.cookie) })).json().state).toBe('ready');

    // Now the writer takes its time: a second send while the first is on its way types nothing.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    spy.mockImplementationOnce(async (req) => {
      await held;
      return submit(req);
    });
    const first = send('k-1');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const second = await send('k-2');
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toEqual({ code: 'conflict', message: 'This prompt is already being sent.' });
    release();
    const ok = await first;
    expect(ok.statusCode).toBe(202);
    // One prompt typed in all, the job sent with it; a later send with the id finds nothing.
    expect(writer.submits.filter((s) => s.text !== 'refuse-me').map((s) => s.idempotencyKey)).toEqual(['k-1']);
    const after = (await api.tcp.inject({ method: 'GET', url: `/v1/rewrite/${jobId}`, headers: h(phone.cookie) })).json();
    expect(after).toMatchObject({ state: 'sent', job: { sendJobId: ok.json().jobId } });
    expect((await send('k-3')).statusCode).toBe(404);
    expect(spy).toHaveBeenCalledTimes(2);
    // The same key again is the first reply, replayed, not a third send.
    const replay = await send('k-1');
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('V10: a 7th start in a minute from one device is 429 with retry-after; another device is not affected', async () => {
    const { phone, other } = await rewriteApi({ answer: () => ({ stdout: claudeJson('ok') }) });
    for (let i = 0; i < 6; i++) {
      const res = await startReq(phone.cookie, { text: `note ${i}` });
      expect(res.statusCode, res.body).toBe(202);
      await ready(phone.cookie, res.json().jobId);
    }
    const seventh = await startReq(phone.cookie, { text: 'note 7' });
    expect(seventh.statusCode).toBe(429);
    expect(Number(seventh.headers['retry-after'])).toBeGreaterThan(0);
    expect((await startReq(other.cookie, { text: 'note' })).statusCode).toBe(202);
    api.ctx.clock.advance(60_000);
    expect((await startReq(phone.cookie, { text: 'note 8' })).statusCode).toBe(202);
  });

  it("a 5th unfinished job from one device is 429 with retry-after too (the service's cap)", async () => {
    const { phone } = await rewriteApi({ answer: hangUntilAborted });
    for (let i = 0; i < 4; i++) expect((await startReq(phone.cookie, { text: `note ${i}` })).statusCode).toBe(202);
    const fifth = await startReq(phone.cookie, { text: 'note 5' });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.headers['retry-after']).toBe(String(ACTIVE_RETRY_AFTER_S));
    expect(fifth.json().error.message).toBe('Wait for your other rewrites to finish.');
  });

  it('V6/A1: write replies, the idempotency replay and audit rows carry no text', async () => {
    const { phone } = await rewriteApi({ answer: () => ({ stdout: claudeJson(`Rename the ${MARKER} helper.`) }) });
    const payload = { text: `rename the ${MARKER} helper` };
    const first = await api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/rewrite`, headers: h(phone.cookie, { 'idempotency-key': 'k-1' }), payload });
    const replay = await api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/rewrite`, headers: h(phone.cookie, { 'idempotency-key': 'k-1' }), payload });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().jobId).toBe(first.json().jobId);
    const jobId = first.json().jobId as string;
    await ready(phone.cookie, jobId);
    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/rewrite/${jobId}`, headers: h(phone.cookie) });
    for (const r of [first, replay, del]) expect(r.body).not.toContain(MARKER);
    const audit = api.ctx.db.audit.list();
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['rewriteStart', 'rewrite.run', 'rewriteCancel']));
    expect(audit.find((e) => e.action === 'rewriteStart')?.params).toEqual({ jobId, model: 'opus', inputLength: payload.text.length });
    expect(audit.find((e) => e.action === 'rewriteCancel')?.params).toEqual({ sid: SID, state: 'cancelled' });
    const replayEvents = api.ctx.store.replay(0);
    expect(JSON.stringify([audit, replayEvents, api.ctx.log.records])).not.toContain(MARKER);
  });

  it('DELETE while a send holds the job (the prompt is being typed) is 409 and cancels nothing', async () => {
    const { phone, svc } = await rewriteApi({ answer: () => ({ stdout: claudeJson('Run the tests.') }) });
    const { jobId } = (await startReq(phone.cookie, { text: 'run the tests' })).json();
    await ready(phone.cookie, jobId);
    const actor = { kind: 'device' as const, deviceId: phone.deviceId, scopes: ['read', 'control'] as Scope[] };
    expect(svc.originFor(jobId, SID, sha256Hex('Run the tests.'), actor)).toBe('rewrite');
    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/rewrite/${jobId}`, headers: h(phone.cookie) });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toEqual({ code: 'conflict', message: 'This prompt is already being sent.' });
    svc.markSent(jobId, 'send-1');
    expect(svc.get(jobId, actor)?.job).toMatchObject({ state: 'sent', sendJobId: 'send-1' });
  });

  it('ctl.sock serves only GET (and the CLI owns no job: 404); start and cancel are not served there', async () => {
    const { phone } = await rewriteApi();
    const { jobId } = (await startReq(phone.cookie, { text: 'run the tests' })).json();
    await ready(phone.cookie, jobId);
    expect((await api.ctl.inject({ method: 'POST', url: `/v1/sessions/${SID}/rewrite`, payload: { text: 'x' } })).statusCode).toBe(404);
    expect((await api.ctl.inject({ method: 'DELETE', url: `/v1/rewrite/${jobId}` })).statusCode).toBe(404);
    const get = await api.ctl.inject({ method: 'GET', url: `/v1/rewrite/${jobId}` });
    expect(get.statusCode).toBe(404);
    expect(get.body).not.toContain('run the tests');
  });

  it('read-only daemon: starts are refused before the service; Rewrite off: 403 with the sentence', async () => {
    const ro = await rewriteApi({ readOnly: true });
    const res = await startReq(ro.phone.cookie, { text: 'run the tests' });
    expect(res.statusCode).toBe(403);
    expect(ro.exec.calls).toHaveLength(0);
    await api.close();
    rmSync(home, { recursive: true, force: true });

    const off = await rewriteApi({ enabled: false });
    const r2 = await startReq(off.phone.cookie, { text: 'run the tests' });
    expect(r2.statusCode).toBe(403);
    expect(r2.json().error.message).toBe('Rewrite is off. Turn it on at your Mac: jantar rewrite on');
  });
});
