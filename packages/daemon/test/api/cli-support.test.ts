import { afterEach, describe, expect, it } from 'vitest';
import type { SendJob } from '@jantar/protocol';
import { CLI_EXIT, cliOpenUrl, cliPair, cliSend, cliStatus, resolveSession, type CtlRequester } from '../../src/api/cli-support.js';
import { HOST, ORIGIN, makeApi, makeSession, type TestApi } from './fakes.js';

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

/** Same shape as the CLI's createCtlClient(), backed by inject on the ctl app. */
function requester(a: TestApi): CtlRequester {
  return {
    async request(method, path, body, opts) {
      const res = await a.ctl.inject({
        method: method as 'GET',
        url: path,
        headers: opts?.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {},
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    },
  };
}

function io() {
  const o = { out: '', err: '' };
  return { o, io: { out: (t: string) => void (o.out += t), err: (t: string) => void (o.err += t) } };
}

describe('CLI support', () => {
  it('pair prints a QR and a one-time link; --admin grants admin', async () => {
    api = await makeApi();
    const { o, io: out } = io();
    expect(await cliPair(requester(api), out, { renderQr: async (t) => `[QR ${t.length}]` })).toBe(CLI_EXIT.ok);
    expect(o.out).toMatch(/^\[QR \d+\]\n/);
    expect(o.out).toMatch(/http:\/\/127\.0\.0\.1:7420\/pair#c=[A-Za-z0-9_-]{22}/);
    expect(o.out).toContain('Grants read and control.');
    expect(o.out).toContain('only works on this Mac');

    const j = io();
    expect(await cliPair(requester(api), j.io, { admin: true, json: true })).toBe(CLI_EXIT.ok);
    const code = JSON.parse(j.o.out).code as string;
    const claim = await api.tcp.inject({ method: 'POST', url: '/v1/pair/claim', headers: { host: HOST, origin: ORIGIN }, payload: { code, name: 'Mac' } });
    // admin implies launch (v0.3 scope chain: admin > launch > control > read).
    expect(claim.json().device.scopes).toEqual(['read', 'control', 'launch', 'admin']);
  });

  it('open builds a loopback admin pairing link', async () => {
    api = await makeApi();
    // /ctl/status reports the TCP address; inject has none, so pretend we listen on 7420.
    const real = requester(api);
    const ctl: CtlRequester = {
      async request<T>(method: string, path: string, body?: unknown, opts?: { idempotencyKey?: string; timeoutMs?: number }) {
        const r = await real.request<T>(method, path, body, opts);
        if (path === '/ctl/status') return { ...r, body: { ...(r.body as object), api: { host: '127.0.0.1', port: 7420 } } as T };
        return r;
      },
    };
    const url = await cliOpenUrl(ctl, io().io);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:7420\/pair#c=[A-Za-z0-9_-]{22}$/);
    const unbound = io();
    expect(await cliOpenUrl(real, unbound.io)).toBeNull();
    expect(unbound.o.err).toContain('not listening');
  });

  it('status prints the board, your turn first', async () => {
    api = await makeApi({ sessions: [makeSession({ status: 'working', sid: 'sess-work-0001', name: 'build' }), makeSession()] });
    const { o, io: out } = io();
    expect(await cliStatus(requester(api), out, { now: Date.parse('2026-01-15T10:05:00.000Z') })).toBe(CLI_EXIT.ok);
    const lines = o.out.split('\n');
    expect(lines[0]).toBe('Sessions (2)');
    expect(lines[1]).toContain('Done · demo-app · refactor  [acct 2]  5m  sess-aaaa-1111');
    expect(lines[2]).toContain('Working · demo-app · build');
    expect(o.out).toMatch(/hooks in 1\/2 session\(s\)/);
    const j = io();
    await cliStatus(requester(api), j.io, { json: true });
    expect(JSON.parse(j.o.out).daemon.protocol).toBe(3);
  });

  it('send resolves the session, then waits for proof', async () => {
    api = await makeApi();
    const ctl = requester(api);
    let out = io();
    // The fake writer leaves jobs queued: not proven -> failure exit, and it says so.
    expect(await cliSend(ctl, out.io, 'refactor', 'continue', { timeoutMs: 10 })).toBe(CLI_EXIT.failed);
    expect(out.o.err).toContain('not proven yet (stage queued)');

    // Now the transcript proves every prompt.
    api.fakes.writer.wait = async (id: string) => ({ ...(api.fakes.writer.jobs.get(id) as SendJob), stage: 'proven' });
    out = io();
    expect(await cliSend(ctl, out.io, 'sess-aaaa', 'continue', { idempotencyKey: 'k1', timeoutMs: 10 })).toBe(CLI_EXIT.ok);
    expect(api.fakes.writer.submits.at(-1)?.idempotencyKey).toBe('k1');

    out = io();
    expect(await cliSend(ctl, out.io, 'refactor', 'refuse-me')).toBe(CLI_EXIT.failed);
    expect(out.o.err).toContain('a card is open for this session (refused)');
    out = io();
    expect(await cliSend(ctl, out.io, 'nothing', 'x')).toBe(CLI_EXIT.failed);
    expect(await cliSend(ctl, out.io, '', 'x')).toBe(CLI_EXIT.usage);
    out = io();
    expect(await cliSend(ctl, out.io, 'refactor', 'x', { wait: false })).toBe(CLI_EXIT.ok);
    expect(out.o.out).toMatch(/^queued \(job /);
  });

  it('resolveSession: exact, unique prefix, name or folder; ambiguous is an error', () => {
    const a = makeSession({ sid: 'abcd-1111', name: 'one', folder: 'proj' });
    const b = makeSession({ sid: 'abcd-2222', name: 'two', folder: 'proj' });
    expect(resolveSession([a, b], 'abcd-2222')).toMatchObject({ ok: true, session: { sid: 'abcd-2222' } });
    expect(resolveSession([a, b], 'abcd-1')).toMatchObject({ ok: true, session: { sid: 'abcd-1111' } });
    expect(resolveSession([a, b], 'TWO')).toMatchObject({ ok: true, session: { sid: 'abcd-2222' } });
    expect(resolveSession([a, b], 'abcd')).toMatchObject({ ok: false });
    expect(resolveSession([a, b], 'proj')).toMatchObject({ ok: false });
    expect(resolveSession([a, b], 'abc')).toMatchObject({ ok: false }); // too short for a prefix
  });
});
