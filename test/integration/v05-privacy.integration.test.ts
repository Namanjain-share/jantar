/**
 * The v0.5 privacy sweep (spec rules MP1, MP4, MP5) through jantard end to
 * end: the daemon booted with the production wiring on a synthetic HOME,
 * Meetings and Todos on, a phone paired with control and a shared screen
 * with read only, each with its event stream (WS /v1/events) open from the
 * start, and the extension's side spoken over HTTP the way its worker
 * speaks it.
 *
 * MEETING_MARKER is planted in everything a meeting holds: the name and the
 * people typed in the assign sheet, every caption line and its speaker, a
 * screenshot (markerJpeg(), the marker in a JPEG comment), and, through the
 * fake claude echoing it, the summary, its decisions and its action items
 * (which then become todos). The phone renames the meeting with it, Adds
 * and Removes an item, and asks for a summary of a meeting whose run fails
 * with the marker on claude's stderr (meeting-bad-json, MP5). Refusals that
 * could echo it are made too: lines for an ended meeting, a "screenshot"
 * that is a PNG holding it.
 *
 * Afterwards the marker, and any piece of the marked picture's base64, is in
 * no WS frame (either device), the event ring, the stored events, an audit
 * row, a log line, a write reply (what the idempotency cache keeps) or an
 * error reply. Meetings emit only `life.changed {}`. The shared screen is
 * refused every meeting read (403) and its frames name no meeting.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEETING_MARKER, claudeCalls, extLinesBody, extOpenBody, extShotBody, markerJpeg, perfBudgetMs, projectBody, setFakeClaude } from '@jantar/fixtures';
import {
  DEVICE_COOKIE,
  EXTENSION_ID,
  EXTENSION_KEY_HEADER,
  eventsSocketProtocols,
  type ExtPairStartReply,
  type MeetingDetail,
  type PairStartResponse,
  type TodosResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';

// The `ws` client @fastify/websocket itself depends on (the daemon's own dependency; test only).
const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url));
interface WsClient {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  once(ev: 'open', fn: () => void): void;
  close(): void;
}
const WebSocket = createRequire(daemonRequire.resolve('@fastify/websocket'))('ws') as new (url: string, protocols: string[], opts: { headers: Record<string, string> }) => WsClient;

const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const PICTURE = markerJpeg();
/** Every 24-character piece of the marked picture's base64, a quarter of its length apart. */
const PICTURE_PIECES = (() => {
  const b64 = PICTURE.toString('base64');
  const step = Math.max(1, Math.floor(b64.length / 16));
  const out: string[] = [];
  for (let i = 0; i + 24 <= b64.length; i += step) out.push(b64.slice(i, i + 24));
  return out;
})();

describe('v0.5 privacy sweep: no meeting text, name or picture leaves the daemon', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let key = '';
  let projectId = '';
  const devices: Record<'phone' | 'screen', { cookie: string; ws: WsClient; frames: string[] }> = {} as never;
  /** Every reply to a write: the idempotency cache keeps them. */
  const writes: Array<{ what: string; text: string }> = [];
  /** Every reply that refused something. */
  const refusals: Array<{ what: string; status: number; text: string }> = [];
  const meetings: string[] = [];
  const clients = { kept: randomUUID(), failing: randomUUID() };

  function keep(what: string, method: string, r: HttpResult): HttpResult {
    if (method !== 'GET') writes.push({ what, text: r.text });
    if (r.status >= 400) refusals.push({ what, status: r.status, text: r.text });
    return r;
  }

  const phone = async (method: string, path: string, body?: unknown) =>
    keep(`${method} ${path}`, method, await http(d.port, method, path, { cookie: devices.phone.cookie, headers: method === 'GET' ? {} : { 'idempotency-key': `k-${randomUUID()}` }, ...(body === undefined ? {} : { body }) }));
  const extension = async (method: 'GET' | 'POST', path: string, body?: unknown) =>
    keep(`ext ${method} ${path}`, method, await http(d.port, method, path, { origin: method === 'POST' ? EXT_ORIGIN : null, headers: { [EXTENSION_KEY_HEADER]: key }, ...(body === undefined ? {} : { body }) }));

  async function device(name: string, scopes: string[]): Promise<{ cookie: string; ws: WsClient; frames: string[] }> {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name } });
    expect(claim.status, claim.text).toBe(200);
    const cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols((claim.body as { deviceSecret: string }).deviceSecret), {
      headers: { origin: `http://127.0.0.1:${d.port}`, cookie },
    });
    ws.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.on('error', reject);
    });
    await eventually(async () => frames.some((f) => f.includes('"kind":"snapshot"')), 5_000, 'the snapshot');
    return { cookie, ws, frames };
  }

  /** A marked call: opened, its captions, a keep-alive, the marked picture, ended. */
  async function call(client: string): Promise<string> {
    const opened = await extension('POST', `/v1/ext/meetings/${client}`, extOpenBody({ projectId, autoTodos: true, at: Date.now() - 60_000 }, { marked: true }));
    expect(opened.status, opened.text).toBe(200);
    const id = (opened.body as { id: string }).id;
    const now = Date.now();
    const lines = extLinesBody(24, { marked: true, nonce: client.slice(0, 8) }).lines.map((l, i) => ({ ...l, at: now - 50_000 + i * 1_000 }));
    expect((await extension('POST', `/v1/ext/meetings/${client}/lines`, { lines })).status).toBe(200);
    expect((await extension('POST', `/v1/ext/meetings/${client}/lines`, { lines: [] })).status).toBe(200);
    expect((await extension('POST', `/v1/ext/meetings/${client}/shots`, extShotBody(PICTURE, { at: Date.now() }))).status).toBe(200);
    expect((await extension('POST', `/v1/ext/meetings/${client}/end`, { reason: 'user', at: Date.now() })).status).toBe(200);
    meetings.push(id);
    return id;
  }

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true }, meetings: { enabled: true } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    devices.phone = await device('Example phone', ['read', 'control']);
    devices.screen = await device('Example shared screen', ['read']);
    const code = (await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start')).code;
    const claim = await http(d.port, 'POST', '/v1/ext/pair', { body: { code }, origin: EXT_ORIGIN });
    expect(claim.status, claim.text).toBe(200);
    key = (claim.body as { key: string }).key;
    const made = await phone('POST', '/v1/projects', projectBody({ name: 'Example launch' }));
    projectId = (made.body as { id: string }).id;
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    for (const dv of Object.values(devices)) dv?.ws.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. a marked call: its summary, items as todos, the phone reading and editing it', async () => {
    const id = await call(clients.kept);
    const done = await eventually(async () => {
      const m = (await phone('GET', `/v1/meetings/${id}`)).body as MeetingDetail;
      if (m.summary.state === 'failed') throw new Error(`the summary failed: ${m.summary.reason ?? ''}`);
      return m.summary.state === 'done' && m.summary.items.every((i) => i.todoId) ? m : null;
    }, 30_000, 'the summary and its todos');
    // The marker was in play everywhere a meeting keeps text.
    expect(done.meeting.name).toContain(MEETING_MARKER);
    expect(done.meeting.people).toContain(MEETING_MARKER);
    expect(done.lines.every((l) => l.text.includes(MEETING_MARKER) && l.speaker.includes(MEETING_MARKER))).toBe(true);
    expect(done.summary.text).toContain(MEETING_MARKER);
    expect(done.summary.decisions.join(' ')).toContain(MEETING_MARKER);
    expect(done.summary.items.map((i) => i.title).join(' ')).toContain(MEETING_MARKER);
    const todos = ((await phone('GET', '/v1/todos')).body as TodosResponse).todos.filter((t) => t.projectId === projectId);
    expect(todos.map((t) => t.title).join(' ')).toContain(MEETING_MARKER);
    const shot = await http(d.port, 'GET', `/v1/meetings/${id}/shots/${done.shots[0]!.id}`, { cookie: devices.phone.cookie });
    expect(Buffer.from(shot.text, 'latin1').includes(Buffer.from(MEETING_MARKER))).toBe(true);

    expect((await phone('GET', `/v1/meetings?q=${encodeURIComponent(MEETING_MARKER)}`)).status).toBe(200);
    expect((await phone('PATCH', `/v1/meetings/${id}`, { name: `Renamed ${MEETING_MARKER}`, people: `Alex ${MEETING_MARKER}` })).status).toBe(200);
    expect((await phone('DELETE', `/v1/meetings/${id}/items/0/todo`)).status).toBe(200);
    expect((await phone('POST', `/v1/meetings/${id}/items/0/todo`)).status).toBe(200);
    // Refusals that could have echoed it.
    expect((await extension('POST', `/v1/ext/meetings/${clients.kept}/lines`, extLinesBody(1, { marked: true }))).status).toBe(404);
    const png = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(MEETING_MARKER)]).toString('base64')}`;
    const other = randomUUID();
    expect((await extension('POST', `/v1/ext/meetings/${other}`, extOpenBody({ at: Date.now() }, { marked: true }))).status).toBe(200);
    expect((await extension('POST', `/v1/ext/meetings/${other}/shots`, { key: randomUUID(), at: Date.now(), image: png })).status).toBe(400);
    expect((await phone('POST', `/v1/meetings/${id}/summary`)).status).toBe(409);
  }, perfBudgetMs(60_000));

  it('2. MP5: a summary that fails with the marker on stderr leaves only codes and counts in the log', async () => {
    await setFakeClaude(d.home, { mode: 'meeting-bad-json' });
    const id = await call(clients.failing);
    const failed = await eventually(async () => {
      const m = (await phone('GET', `/v1/meetings/${id}`)).body as MeetingDetail;
      return m.summary.state === 'failed' ? m : null;
    }, 30_000, 'the failed summary');
    expect(failed.summary.reason).toBe('The summary did not work. Try again.');
    // Try again from the phone, failing the same way.
    await setFakeClaude(d.home, { mode: 'meeting-bad-json' });
    expect((await phone('POST', `/v1/meetings/${id}/summary`)).status).toBe(200);
    await eventually(async () => ((await phone('GET', `/v1/meetings/${id}`)).body as MeetingDetail).summary.state === 'failed', 30_000, 'Try again to fail');
    // The runs were logged (by outcome), and claude did write the marker where the daemon could have copied it.
    expect(d.log.records.filter((r) => r.msg === 'meetings: a summary did not work')).toHaveLength(2);
    const calls = await claudeCalls(d.home);
    expect(calls.filter((c) => c.stdin.includes(MEETING_MARKER)).length).toBeGreaterThanOrEqual(3);
  }, perfBudgetMs(90_000));

  it('3. MP4: the shared screen reads no meeting, and its stream names none', async () => {
    for (const path of ['/v1/meetings', `/v1/meetings/${meetings[0]}`, `/v1/meetings/${meetings[0]}/shots/00000000000000000000000000`]) {
      const r = await http(d.port, 'GET', path, { cookie: devices.screen.cookie });
      expect(r.status, path).toBe(403);
    }
    // It heard the ticks, and nothing else of them.
    await eventually(async () => devices.screen.frames.some((f) => f.includes('life.changed')), 5_000, 'a tick on the shared screen');
    for (const id of meetings) expect(devices.screen.frames.join('\n')).not.toContain(id);
  });

  it('4. the sweep: no marker or piece of the picture in a frame, the ring, the stored events, the audit, a log line, a write reply or a refusal', async () => {
    const replay = d.ctx.store.replay(0);
    expect(replay.kind).toBe('events');
    const ring = replay.kind === 'events' ? replay.events : [];
    const sources: Record<string, string> = {
      'phone frames': devices.phone.frames.join('\n'),
      'shared screen frames': devices.screen.frames.join('\n'),
      'event ring': JSON.stringify(ring),
      'stored events': JSON.stringify(d.ctx.db.events.since(0)),
      'audit rows': JSON.stringify(d.ctx.db.audit.list({ after: 0, limit: 100_000 })),
      'log lines': JSON.stringify(d.log.records),
      'write replies': JSON.stringify(writes),
      refusals: JSON.stringify(refusals),
    };
    for (const [what, text] of Object.entries(sources)) {
      expect(text.includes(MEETING_MARKER), what).toBe(false);
      for (const piece of PICTURE_PIECES) expect(text.includes(piece), `${what}: the picture's base64`).toBe(false);
    }
    expect(writes.length).toBeGreaterThan(10);
    expect(refusals.length).toBeGreaterThanOrEqual(3);

    // Meetings tick only as `life.changed {}`, and never name a meeting on either stream.
    const meetingEvents = ring.filter((e) => e.type === 'life.changed');
    expect(meetingEvents.length).toBeGreaterThan(0);
    for (const e of meetingEvents) expect(e.data).toEqual({});
    for (const id of meetings) {
      expect(sources['phone frames']!.includes(id), 'a meeting id in the phone frames').toBe(false);
      expect(sources['event ring']!.includes(id), 'a meeting id in the ring').toBe(false);
    }
    // The audit holds what was done to which meeting, as counts.
    const audit = d.ctx.db.audit.list({ after: 0, limit: 100_000 }).filter((a) => a.action.startsWith('meeting') || a.action.startsWith('ext'));
    expect(audit.length).toBeGreaterThan(0);
  });
});
