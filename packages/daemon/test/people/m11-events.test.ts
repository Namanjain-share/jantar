/**
 * v0.11 People, M11 and T8 (spec 9.7.2): the two event streams.
 *
 * - `/v1/p/events` opens only for her, on her host, with her origin: 404 on
 *   his hosts, 401 without her device, 403 with any other Origin.
 * - During a scripted day of his activity (sessions, usage, his Life
 *   writes, his own sharing screens) her socket gets nothing but its hello,
 *   its first tick and heartbeats: no snapshot, no session.*, no usage.*.
 * - A tick carries counters only: no ids of his, no titles, no names.
 * - Bea's account never ticks Asha's socket.
 * - Revoke (hers and his), leave and remove close her socket with 4401.
 * - His stream never carries her id or name: her narrowing reaches it as
 *   `life.changed {}` only (C24).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonWsMessageSchema, type PersonWsMessage } from '@jantar/protocol/people';
import { WsServerMessageSchema, type WsServerMessage } from '@jantar/protocol';
import { NONE, OWNER_HOST, OWNER_ORIGIN, PEOPLE_HOST, PEOPLE_ORIGIN, credHeaders, joinPerson, linkDevice, makeFixture, onHer, type Cred, type Fixture } from './isolation-fixture.js';

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

interface Sock<M> {
  messages: M[];
  closed: { code: number } | null;
  waitFor(pred: (m: M[]) => boolean, ms?: number): Promise<void>;
  close(): void;
}

async function open<M>(path: string, host: string, origin: string, cred: Cred, parse: (v: unknown) => M): Promise<Sock<M>> {
  const messages: M[] = [];
  const sock: Sock<M> = {
    messages,
    closed: null,
    async waitFor(pred, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!pred(messages) && !sock.closed) {
        if (Date.now() > deadline) throw new Error(`timed out; have ${JSON.stringify(messages)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () => undefined,
  };
  const ws = await f.api.tcp.injectWS(path, { headers: { host, origin, ...credHeaders(cred) } }, {
    onInit: (s) => {
      s.on('message', (d: Buffer) => messages.push(parse(JSON.parse(String(d)))));
      s.on('close', (code: number) => {
        sock.closed = { code };
      });
    },
  });
  sock.close = () => ws.terminate();
  return sock;
}

const her = (cred: Cred) => open<PersonWsMessage>('/v1/p/events', PEOPLE_HOST, PEOPLE_ORIGIN, cred, (v) => PersonWsMessageSchema.parse(v));
const his = (cred: Cred) => open<WsServerMessage>('/v1/events', OWNER_HOST, OWNER_ORIGIN, cred, (v) => WsServerMessageSchema.parse(v));

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('M11: who can open her stream', () => {
  it('only her, on her host, with her origin', async () => {
    const s = await her(f.asha.full);
    await s.waitFor((m) => m.length >= 2);
    expect(s.messages.map((m) => m.kind)).toEqual(['hello', 'tick']);
    s.close();
    const refused = async (host: string, origin: string, cred: Cred) =>
      f.api.tcp.injectWS('/v1/p/events', { headers: { host, origin, ...credHeaders(cred) } }).then(
        () => 'opened',
        (e: Error) => /Unexpected server response: (\d+)/.exec(e.message)?.[1] ?? e.message,
      );
    expect(await refused(OWNER_HOST, OWNER_ORIGIN, f.asha.full)).toBe('404');
    expect(await refused('127.0.0.1:7420', 'http://127.0.0.1:7420', f.asha.full)).toBe('404');
    expect(await refused(PEOPLE_HOST, PEOPLE_ORIGIN, NONE)).toBe('401');
    expect(await refused(PEOPLE_HOST, PEOPLE_ORIGIN, f.asha.revoked)).toBe('401');
    expect(await refused(PEOPLE_HOST, PEOPLE_ORIGIN, f.eli.oldCookie)).toBe('401');
    expect(await refused(PEOPLE_HOST, OWNER_ORIGIN, f.asha.full)).toBe('403');
    expect(await refused(PEOPLE_HOST, 'https://evil.example.com', f.asha.full)).toBe('403');
    expect(await refused(PEOPLE_HOST, PEOPLE_ORIGIN, f.owner.admin)).toBe('401');
    expect(await refused(PEOPLE_HOST, PEOPLE_ORIGIN, f.bea.full)).toBe('opened');
  });

  it('Dev (ending) still opens hers; a paused person too', async () => {
    for (const cred of [f.dev.full, f.cara.full]) {
      const s = await her(cred);
      await s.waitFor((m) => m.length >= 2);
      s.close();
    }
  });
});

describe('M11 / T8: what her stream carries', () => {
  it("a scripted day of his: her socket gets heartbeats only; a tick holds counters and nothing of his", async () => {
    const s = await her(f.asha.full);
    await s.waitFor((m) => m.length >= 2);
    const start = s.messages.length;
    // His sessions and usage, and his own Life writes.
    f.api.ctx.store.emit({ type: 'session.updated', sid: 'sess-aaaa-1111', data: { patch: { mode: 'plan' } } });
    f.api.ctx.store.emit({ type: 'life.changed', data: {} });
    const t = await f.api.tcp.inject({
      method: 'POST',
      url: '/v1/todos',
      headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(f.owner.control) },
      payload: { title: 'CANARY-owner-todo' },
    });
    expect(t.statusCode).toBe(200);
    // His look at the People list and at her (a view of hers is her record, not his activity).
    await f.api.tcp.inject({ method: 'GET', url: '/v1/people', headers: { host: OWNER_HOST, ...credHeaders(f.owner.control) } });
    f.api.ctx.clock.advance(25_000);
    await settle();
    const after = s.messages.slice(start);
    expect(after.every((m) => m.kind === 'heartbeat')).toBe(true);
    expect(after.length).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(s.messages);
    expect(text).not.toMatch(/CANARY|sess-aaaa|snapshot|session\.|usage\./);
    for (const m of s.messages) {
      if (m.kind === 'tick') expect(Object.keys(m).sort()).toEqual(['alerts', 'chat', 'kind', 'life', 'me', 'plan', 'seq']);
    }
    s.close();
  });

  it("Bea's account never ticks Asha's socket; Asha's own account does", async () => {
    const s = await her(f.asha.full);
    await s.waitFor((m) => m.length >= 2);
    const n = s.messages.length;
    expect((await onHer(f.api, 'POST', '/v1/p/agreement/narrow', f.bea.full, { see: { weight: false } })).statusCode).toBe(200);
    expect((await onHer(f.api, 'PATCH', '/v1/p/prefs', f.bea.full, { lockScreen: 'all' })).statusCode).toBe(200);
    await settle();
    expect(s.messages.slice(n).filter((m) => m.kind === 'tick')).toEqual([]);
    expect((await onHer(f.api, 'PATCH', '/v1/p/prefs', f.asha.full, { lockScreen: 'all' })).statusCode).toBe(200);
    await s.waitFor((m) => m.slice(n).some((x) => x.kind === 'tick'));
    s.close();
  });
});

describe('M11: revoke, leave and remove close her socket with 4401', () => {
  it('her own revoke of the device on the socket', async () => {
    const second = await linkDevice(f.api, f.asha, 'Asha tablet');
    const s = await her(second.cred);
    await s.waitFor((m) => m.length >= 2);
    expect((await onHer(f.api, 'DELETE', `/v1/p/devices/${second.deviceId}`, f.asha.full)).statusCode).toBe(200);
    await s.waitFor(() => false, 1000).catch(() => undefined);
    expect(s.closed?.code).toBe(4401);
  });

  it("his revoke of a device of hers (not her last)", async () => {
    const second = await linkDevice(f.api, f.asha, 'Asha tablet');
    const s = await her(second.cred);
    await s.waitFor((m) => m.length >= 2);
    const r = await f.api.tcp.inject({ method: 'DELETE', url: `/v1/people/${f.asha.id}/devices/${second.deviceId}`, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(f.owner.admin) } });
    expect(r.statusCode).toBe(200);
    await s.waitFor(() => false, 1000).catch(() => undefined);
    expect(s.closed?.code).toBe(4401);
    // Her last device he can't revoke (C18).
    const last = await f.api.tcp.inject({ method: 'DELETE', url: `/v1/people/${f.asha.id}/devices/${f.asha.deviceId}`, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(f.owner.admin) } });
    expect(last.statusCode).toBe(409);
  });

  it('her leave', async () => {
    const s = await her(f.asha.full);
    await s.waitFor((m) => m.length >= 2);
    expect((await onHer(f.api, 'POST', '/v1/p/leave', f.asha.full, { data: 'keep30', confirm: 'LEAVE' })).statusCode).toBe(200);
    await s.waitFor(() => false, 1000).catch(() => undefined);
    expect(s.closed?.code).toBe(4401);
  });

  it('his remove (now) from the Mac', async () => {
    const bea2 = await joinPerson(f.api, 'Hana');
    const s = await her(bea2.full);
    await s.waitFor((m) => m.length >= 2);
    const r = await f.api.ctl.inject({ method: 'POST', url: `/v1/people/${bea2.id}/remove`, payload: { mode: 'now', forget: false } });
    expect(r.statusCode).toBe(200);
    await s.waitFor(() => false, 1000).catch(() => undefined);
    expect(s.closed?.code).toBe(4401);
  });
});

describe("M11: his stream about her", () => {
  it('her narrowing reaches his devices as life.changed {} only, with no id or name of hers', async () => {
    const s = await his(f.owner.control);
    await s.waitFor((m) => m.some((x) => x.kind === 'snapshot'));
    const n = s.messages.length;
    expect((await onHer(f.api, 'POST', '/v1/p/agreement/narrow', f.asha.full, { see: { weight: false } })).statusCode).toBe(200);
    await s.waitFor((m) => m.slice(n).some((x) => x.kind === 'event' && x.event.type === 'life.changed'));
    const after = JSON.stringify(s.messages.slice(n));
    expect(after).not.toContain(f.asha.id);
    expect(after).not.toContain('Asha');
    s.close();
  });
});

describe('M11: her Life writes and his stream', () => {
  it("tick his devices only for areas he sees; always tick hers; never tick Bea's", async () => {
    const mine = await his(f.owner.control);
    await mine.waitFor((m) => m.some((x) => x.kind === 'snapshot'));
    const hers = await her(f.asha.full);
    const beas = await her(f.bea.full);
    await hers.waitFor((m) => m.length >= 2);
    await beas.waitFor((m) => m.length >= 2);
    const lifeTicks = () => mine.messages.filter((x) => x.kind === 'event' && x.event.type === 'life.changed').length;
    // Off: her to-do and weight writes reach her stream, not his.
    expect((await onHer(f.api, 'POST', '/v1/p/agreement/narrow', f.asha.full, { see: { todos: false, weight: false } })).statusCode).toBe(200);
    await settle();
    const before = lifeTicks();
    const n = hers.messages.length;
    const nb = beas.messages.length;
    expect((await onHer(f.api, 'POST', '/v1/p/todos', f.asha.full, { title: 'Private' })).statusCode).toBe(201);
    expect((await onHer(f.api, 'PUT', '/v1/p/weights/2026-11-03', f.asha.full, { kg: 60 })).statusCode).toBe(200);
    await settle();
    expect(lifeTicks()).toBe(before);
    expect(hers.messages.slice(n).filter((x) => x.kind === 'tick').length).toBe(2);
    expect(beas.messages.slice(nb).filter((x) => x.kind === 'tick')).toEqual([]);
    // On (Bea shares her to-dos): her write ticks his stream.
    const b0 = lifeTicks();
    expect((await onHer(f.api, 'POST', '/v1/p/todos', f.bea.full, { title: 'Shared' })).statusCode).toBe(201);
    await mine.waitFor(() => lifeTicks() > b0);
    for (const s of [mine, hers, beas]) s.close();
  });
});
