/**
 * v0.6 Fleet (lane L4): the node runs the hub's calls (node/executor.ts).
 *
 * - S2: only NODE_ROUTES, the path built from the route name; anything else
 *   is 404 and a bad path param 400, with nothing run.
 * - The call reaches the node's own API as the phone (`hub.<deviceId>` is
 *   the link transport's business): method, path and query from the route,
 *   the idempotency key, the JSON body, or an upload's bytes.
 * - A reply too large for the link is a 500; nothing of a call is logged.
 * - A call still running when the hub gives up on it (30 s, 60 s for a
 *   launch or an upload) is a 504, so it never holds a place of the 16.
 */
import { describe, expect, it } from 'vitest';
import { FLEET_SECRET } from '@jantar/fixtures';
import type { NodeCallActor, NodeCallRequest } from '@jantar/protocol/node-link';
import { NODE_LIMITS } from '@jantar/protocol/node-link';
import type { LinkInjector, LinkRequest, LinkResponse } from '../../src/contracts.js';
import { createTestContext } from '../../src/core/testing.js';
import { createExecutor } from '../../src/node/executor.js';

const S1 = '7a1c0000-0000-4000-8000-000000000001';
const PHONE: NodeCallActor = { deviceId: 'dev-1', deviceName: 'Sam phone', scopes: ['read', 'control'] };

function rig(answer: (req: LinkRequest) => Promise<LinkResponse> = async () => ({ status: 200, body: { ok: true } })) {
  const ctx = createTestContext();
  const calls: LinkRequest[] = [];
  const injector: LinkInjector = {
    inject: (req) => {
      calls.push(req);
      return answer(req);
    },
  };
  return { ctx, calls, exec: createExecutor(ctx, injector) };
}

const call = (route: string, params: Record<string, string> = {}, more: Partial<NodeCallRequest> = {}): NodeCallRequest =>
  ({ id: 'c1', route, params, query: {}, actor: PHONE, ...more }) as NodeCallRequest;

describe('S2: only NODE_ROUTES, built from the route name', () => {
  it('a route outside NODE_ROUTES, a prototype name or a path-like name is 404 and nothing runs', async () => {
    const { exec, calls } = rig();
    for (const route of ['getSettings', 'pairStart', 'lifeToday', 'events', 'machinesPair', 'constructor', '__proto__', '/v1/settings', '../v1/settings', 'getTranscript/../x', '']) {
      const r = await exec.run(call(route, { sid: S1 }));
      expect(r.status, route).toBe(404);
      expect(r.body, route).toEqual({ error: { code: 'not_found', message: 'not found' } });
    }
    expect(calls).toEqual([]);
  });

  it('path params: exactly the route own, each an id; `../`, a slash, a missing or an extra one is 400 and nothing runs', async () => {
    const { exec, calls } = rig();
    const bad: [string, Record<string, string>][] = [
      ['getTranscript', { sid: '../../etc' }],
      ['getTranscript', { sid: 'a/b' }],
      ['getTranscript', { sid: '..' }],
      ['getTranscript', { sid: '' }],
      ['getTranscript', {}],
      ['getTranscript', { sid: S1, evil: 'x' }],
      ['uploadDelete', { sid: S1 }],
      ['uploadDelete', { sid: S1, id: '%2e%2e' }],
      ['foldersRoots', { sid: S1 }],
      ['decidePending', { id: 'x'.repeat(81) }],
    ];
    for (const [route, params] of bad) {
      const r = await exec.run(call(route, params));
      expect(r.status, `${route} ${JSON.stringify(params)}`).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('the path comes from the route, the query is only a query string, and the call carries the phone and its key', async () => {
    const { exec, calls } = rig();
    await exec.run(call('getTranscript', { sid: S1 }, { query: { limit: '5', before: '../x' } }));
    await exec.run(call('foldersList', {}, { query: { root: '../../etc', path: '/etc' } }));
    await exec.run(call('sendPrompt', { sid: S1 }, { body: { text: 'run the tests', onDraft: 'refuse' }, idem: 'dev-1:k-1' }));
    await exec.run(call('uploadDelete', { sid: S1, id: '01jfz8x8y3t0v5g9wqk2m4n6pr' }));
    expect(calls).toEqual([
      { method: 'GET', url: `/v1/sessions/${S1}/transcript?limit=5&before=..%2Fx`, actor: PHONE },
      { method: 'GET', url: '/v1/folders?root=..%2F..%2Fetc&path=%2Fetc', actor: PHONE },
      { method: 'POST', url: `/v1/sessions/${S1}/prompt`, actor: PHONE, idem: 'dev-1:k-1', body: { text: 'run the tests', onDraft: 'refuse' } },
      { method: 'DELETE', url: `/v1/sessions/${S1}/uploads/01jfz8x8y3t0v5g9wqk2m4n6pr`, actor: PHONE },
    ]);
  });
});

describe('uploads and replies', () => {
  it("an upload's bytes become its raw body; bytes for a route that takes none are 400", async () => {
    const { exec, calls } = rig(async () => ({ status: 201, body: { upload: { id: 'u1' } } }));
    const bytes = Buffer.from('notes from the phone\n');
    expect((await exec.run(call('uploadCreate', { sid: S1 }, { query: { ext: 'txt' } }), bytes)).status).toBe(201);
    expect(calls[0]?.raw?.equals(bytes)).toBe(true);
    expect(calls[0]?.body).toBeUndefined();
    // No bytes at all: an empty body, which the node's own handler refuses as it would on a Mac.
    await exec.run(call('uploadCreate', { sid: S1 }, { query: { ext: 'txt' } }));
    expect(calls[1]?.raw?.length).toBe(0);
    const r = await exec.run(call('sendPrompt', { sid: S1 }, { body: { text: 'x', onDraft: 'refuse' } }), bytes);
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(2);
  });

  it('the reply goes back as the node answered it; one too large for the link is a 500', async () => {
    const big = { items: [{ text: 'z'.repeat(NODE_LIMITS.bulkToHubBytes) }] };
    const { exec } = rig(async (req) => (req.url.includes('screen') ? { status: 409, body: { error: { code: 'conflict', message: 'busy' } } } : { status: 200, body: big }));
    expect(await exec.run(call('getScreen', { sid: S1 }))).toEqual({ status: 409, body: { error: { code: 'conflict', message: 'busy' } } });
    expect(await exec.run(call('getTranscript', { sid: S1 }))).toEqual({ status: 500, body: { error: { code: 'internal', message: 'reply too large for the link' } } });
  });

  it('a call that fails inside the node is a 500, and no line names what it carried', async () => {
    const { exec, ctx } = rig(async () => {
      throw new Error(`boom ${FLEET_SECRET}`);
    });
    const r = await exec.run(call('sendPrompt', { sid: S1 }, { body: { text: FLEET_SECRET, onDraft: 'refuse' }, idem: 'dev-1:k-2' }));
    expect(r).toEqual({ status: 500, body: { error: { code: 'internal', message: 'internal error' } } });
    expect(JSON.stringify(ctx.log.records)).not.toContain(FLEET_SECRET);
    expect(ctx.log.records.some((x) => x.level === 'error')).toBe(true);
  });

  it('a call that hangs is a 504 when the hub gives up on it (60 s for a launch), and no timer is left', async () => {
    const { exec, ctx } = rig(() => new Promise<LinkResponse>(() => {}));
    const short = exec.run(call('getScreen', { sid: S1 }));
    const long = exec.run(call('launchStart', {}, { body: { root: 'r.code', path: 'api-server', account: 'auto' } }));
    let longDone = false;
    void long.then(() => (longDone = true));
    ctx.clock.advance(NODE_LIMITS.callTimeoutMs);
    expect(await short).toEqual({ status: 504, body: { error: { code: 'node_timeout', message: 'timed out' } } });
    await Promise.resolve();
    expect(longDone).toBe(false);
    ctx.clock.advance(NODE_LIMITS.longCallTimeoutMs - NODE_LIMITS.callTimeoutMs);
    expect((await long).status).toBe(504);
    expect(ctx.clock.pending()).toBe(0);
    // One that answers in time clears its timer.
    const quick = rig();
    await quick.exec.run(call('getScreen', { sid: S1 }));
    expect(quick.ctx.clock.pending()).toBe(0);
  });
});
