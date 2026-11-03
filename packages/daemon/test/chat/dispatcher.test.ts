/**
 * The per-run MCP server (spec 0.10 B6.3, B6.5), driven by a test client on
 * its socket: a wrong or missing token closes the connection and fails the
 * turn; a second connection is refused; initialize and tools/list answer at
 * once while tools/call waits for the init check; an abort answers held
 * calls with an error; a tool outside the turn is -32602; the socket is
 * 0600 and gone after close.
 */
import { mkdtempSync, realpathSync, rmSync, statSync, existsSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher, type DispatcherFailure } from '../../src/chat/dispatcher.js';
import { FakeClock } from '../../src/core/clock.js';
import { chatRig, type ChatRig } from './helpers.js';

let rig: ChatRig | undefined;
const opened: Dispatcher[] = [];
let dir = '';
afterEach(async () => {
  for (const d of opened.splice(0)) await d.close();
  await rig?.close();
  rig = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'synthetic-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function setup() {
  rig = await chatRig();
  dir = realpathSync(mkdtempSync(join('/tmp', 'jcd-')));
  const fails: DispatcherFailure[] = [];
  const { tools } = rig.turn();
  const clock = new FakeClock('2026-11-02T10:00:00.000Z');
  const list = (await import('../../src/chat/tools.js')).toolsFor(rig.ctx.settings.get(), rig.deps);
  const d = new Dispatcher({ path: join(dir, 'c.sock'), token: TOKEN, tools, list, clock, version: '0.0.0-test', onFail: (w) => fails.push(w) });
  opened.push(d);
  await d.listen();
  return { d, fails, path: join(dir, 'c.sock'), clock, tools };
}

/** A client: send lines, read answers by id. */
function client(path: string) {
  const c = net.connect(path);
  c.setEncoding('utf8');
  let rest = '';
  const answers = new Map<number, unknown>();
  const waiters = new Map<number, (v: unknown) => void>();
  let closed = false;
  c.on('data', (chunk: string) => {
    rest += chunk;
    let at = rest.indexOf('\n');
    while (at >= 0) {
      const m = JSON.parse(rest.slice(0, at)) as { id: number };
      rest = rest.slice(at + 1);
      at = rest.indexOf('\n');
      answers.set(m.id, m);
      waiters.get(m.id)?.(m);
    }
  });
  c.on('close', () => (closed = true));
  c.on('error', () => {});
  let n = 0;
  return {
    send: (line: string) => c.write(`${line}\n`),
    request(method: string, params: Record<string, unknown> = {}) {
      n += 1;
      const id = n;
      c.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve as (v: unknown) => void));
    },
    closed: () => closed,
    end: () => c.destroy(),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('Dispatcher', () => {
  it('the socket is 0600; a wrong token closes it and fails the turn', async () => {
    const { path, fails } = await setup();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const c = client(path);
    c.send(JSON.stringify({ token: 'wrong' }));
    // 0.12.1: wait for the close itself (a loaded runner took longer than settle's 50 ms), at most 5 s.
    for (let i = 0; i < 100 && !c.closed(); i++) await settle();
    expect(c.closed()).toBe(true);
    expect(fails).toEqual(['not_isolated']);
  });

  it('one connection only; initialize and tools/list at once; tools/call waits for the init check', async () => {
    const { d, path } = await setup();
    const c = client(path);
    c.send(JSON.stringify({ token: TOKEN }));
    const init = await c.request('initialize', { protocolVersion: '2025-06-18' });
    expect(init).toMatchObject({ result: { serverInfo: { name: 'jantar' } } });
    const second = client(path);
    second.send(JSON.stringify({ token: TOKEN }));
    // 0.12.1: wait for the refusal's close itself, at most 5 s (a fixed 50 ms can be too short on a busy runner).
    for (let i = 0; i < 100 && !second.closed(); i++) await settle();
    expect(second.closed()).toBe(true);
    expect(d.refusedConnections).toBe(1);
    const list = (await c.request('tools/list')) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toContain('places_find');
    let answered = false;
    const call = c.request('tools/call', { name: 'today', arguments: {} }).then((r) => {
      answered = true;
      return r;
    });
    await settle();
    expect(answered).toBe(false);
    d.release();
    expect(await call).toMatchObject({ result: { content: [{ type: 'text' }] } });
  });

  it('an abort answers held calls with an error; a tool outside the turn is -32602', async () => {
    const { d, path, tools } = await setup();
    const c = client(path);
    c.send(JSON.stringify({ token: TOKEN }));
    expect(await c.request('tools/call', { name: 'send_prompt', arguments: { sid: 'x', text: 'y' } })).toMatchObject({ error: { code: -32602, message: 'Not a tool of this turn.' } });
    expect(tools.counts.refused).toBe(1);
    const held = c.request('tools/call', { name: 'today', arguments: {} });
    await settle();
    d.abort();
    expect(await held).toMatchObject({ error: { code: -32000 } });
  });

  it('a call held past the hold time fails the run', async () => {
    const { path, fails, clock } = await setup();
    const c = client(path);
    c.send(JSON.stringify({ token: TOKEN }));
    const held = c.request('tools/call', { name: 'today', arguments: {} });
    await settle();
    clock.advance(10_001);
    expect(await held).toMatchObject({ error: { code: -32000 } });
    expect(fails).toEqual(['not_isolated']);
  });

  it('close removes the socket', async () => {
    const { d, path } = await setup();
    await d.close();
    expect(existsSync(path)).toBe(false);
  });
});
