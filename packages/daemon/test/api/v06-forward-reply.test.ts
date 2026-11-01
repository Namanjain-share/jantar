/**
 * v0.6 Fleet, what the hub's API adds to a forwarded call on its way back
 * (wave 2): the link carries no headers, so a forwarded 429 gets the
 * spec's `retry-after: 2` here; and the CLI's `jantar send` to a paired
 * server's session waits on the job the node re-emits (`send.progress` in
 * the hub's store), which the hub's own writer never had.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeSendJob } from '@jantar/fixtures';
import { SettingsSchema, errorBody, type Session } from '@jantar/protocol';
import type { FleetService } from '../../src/contracts.js';
import { offFleet } from '../../src/modes.js';
import { h, makeApi, makeSession, pairCookie, type TestApi } from './fakes.js';

const NODE = '01JF1EETN0DEBV11D1000000A1';
const SID = 'node-sess-1';

const nodeSession = (over: Partial<Session> = {}): Session => makeSession({ sid: SID, node: NODE, tty: '/dev/pts/3', ...over });

function fleetAnswering(status: number, body: unknown): FleetService {
  return {
    ...offFleet(),
    target: (_route, params) => (params.sid === SID ? { nodeId: NODE, name: 'build-1' } : null),
    forward: async () => ({ status, body }),
  };
}

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

describe('v0.6: a forwarded reply on its way back', () => {
  it('a 429 (too many calls waiting on that server) asks the phone to wait 2 s; other replies get no retry-after', async () => {
    const busy = errorBody('rate_limited', 'build-1 has too many calls waiting; try again in a few seconds');
    api = await makeApi({ sessions: [nodeSession()], deps: () => ({ fleet: fleetAnswering(429, busy) }) });
    const { cookie } = await pairCookie(api, ['read', 'control']);
    const res = await api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/prompt`, headers: h(cookie), payload: { text: 'hi' } });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.json()).toEqual(busy);
    await api.close();

    api = await makeApi({ sessions: [nodeSession()], deps: () => ({ fleet: fleetAnswering(202, { jobId: 'job-1' }) }) });
    const c2 = await pairCookie(api, ['read', 'control']);
    const ok = await api.tcp.inject({ method: 'POST', url: `/v1/sessions/${SID}/prompt`, headers: h(c2.cookie), payload: { text: 'hi' } });
    expect(ok.statusCode).toBe(202);
    expect(ok.headers['retry-after']).toBeUndefined();
  });

  it("jantar send to a server's session waits on the job the node re-emits, until it ends", async () => {
    api = await makeApi({ sessions: [nodeSession()], ctx: { settings: SettingsSchema.parse({ fleet: { enabled: true } }) } });
    const job = makeSendJob({ id: 'job-node-1', sid: SID, stage: 'typed' });
    api.ctx.store.emit({ type: 'send.progress', sid: SID, data: { job } });
    const waiting = api.ctl.inject({ method: 'GET', url: `/ctl/sends/${job.id}/wait?timeoutMs=60000` });
    // The node reports it proven: the hub's store gets it as a send.progress.
    setTimeout(() => api.ctx.store.emit({ type: 'send.progress', sid: SID, data: { job: { ...job, stage: 'proven' } } }), 20);
    const res = await waiting;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job: { id: job.id, stage: 'proven' } });
    // A job neither the writer nor the store has is still not found.
    expect((await api.ctl.inject({ method: 'GET', url: '/ctl/sends/job-nowhere/wait?timeoutMs=10' })).statusCode).toBe(404);
  });
});
