/**
 * v0.9 Log a comment end to end (spec 9): jantard in-process on a synthetic
 * HOME with the production wiring (harness.ts), in the UTC Life zone;
 * `jantar` (main() from packages/cli) on the real ctl.sock; a phone paired
 * with control, its event stream open from the start and a Web Push
 * subscription (Web Push sends nothing: the harness records each payload
 * as it would leave the Mac). Nothing posts, opens a link or calls a
 * network.
 *
 * 1. Posts on; the phone sets the goal { reddit, comment, 35 }.
 * 2. `jantar post log '<share link>' --text-file <tmp>` prints its line.
 * 3. The phone's Done lists it posted, kind comment, r/exampletools, with
 *    its link and text; Today says comments { done: 1, goal: 5 }; the week
 *    goal is 1/35.
 * 4. The same link again is 409 with the sentence, from the CLI and the
 *    phone; nothing more is stored.
 * 5. `jantar post list --done` ends the row with the link, never the text.
 * 6. The phone logs one too (X, no where); Today says 2/5.
 * 7. The sweep: the text's and the link's marker reach no WS frame, event,
 *    audit row, log line, write reply or push.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIFE_MARKER, perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, eventsSocketProtocols, type PairStartResponse, type PostsResponse, type Today } from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';
import { WarpClock } from './warp-clock.js';

// The `ws` client @fastify/websocket itself depends on (the daemon's own dependency; test only).
const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url));
interface WsClient {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  once(ev: 'open', fn: () => void): void;
  close(): void;
}
const WebSocket = createRequire(daemonRequire.resolve('@fastify/websocket'))('ws') as new (url: string, protocols: string[], opts: { headers: Record<string, string> }) => WsClient;

const PHONE_PUSH = 'https://fcm.googleapis.com/fcm/send/synthetic-comments-phone';
const KEYS = { p256dh: 'BSyntheticP256dhKeyForTheCommentsRun', auth: 'synthetic-auth' };
/** The link's own marker: letters and digits only, as a Reddit share code is. */
const LINK_MARKER = 'LinkMarker7c3e';
const SHARE = `https://www.reddit.com/r/exampletools/s/${LINK_MARKER}`;
const X_LINK = 'https://x.com/example_user/status/1234567890123456789';
const LOGGED = 'You logged that link already.';

describe('v0.9 Log a comment through jantard: jantar post log, the phone, Today, the week and the privacy sweep', () => {
  const clock = new WarpClock();
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let ws: WsClient | null = null;
  const frames: string[] = [];
  /** Every reply to a write, over TCP. */
  const writes: Array<{ what: string; text: string }> = [];
  let logged = '';

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const headers: Record<string, string> = method === 'GET' ? {} : { 'idempotency-key': `k-${randomUUID()}` };
    const r = await http(d.port, method, path, { cookie: phone, headers, ...(body === undefined ? {} : { body }) });
    if (method !== 'GET') writes.push({ what: `${method} ${path}`, text: r.text });
    return r;
  }

  async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}: ${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as T;
  }

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  async function run(...argv: string[]): Promise<string> {
    const r = await cli(...argv);
    expect(r.code, `jantar ${argv.join(' ')}: ${r.err}\n${dumpLog()}`).toBe(0);
    return r.out;
  }

  const done = async (): Promise<PostsResponse> => ok<PostsResponse>('GET', '/v1/posts?done=1');
  const today = async (): Promise<Today> => ok<Today>('GET', '/v1/life/today');

  beforeAll(async () => {
    d = await bootDaemon({ clock, home: { sessions: [] }, settings: { notify: { settle_ms: 0 }, life: { timezone: 'UTC' } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'comments phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'comments phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    const secret = (claim.body as { deviceSecret: string }).deviceSecret;
    const socket = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(secret), { headers: { origin: `http://127.0.0.1:${d.port}`, cookie: phone } });
    socket.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.on('error', reject);
    });
    ws = socket;
    const sub = await http(d.port, 'POST', '/v1/push/subscribe', { cookie: phone, body: { subscription: { endpoint: PHONE_PUSH, keys: KEYS } } });
    expect(sub.status, sub.text).toBe(200);
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    ws?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. Posts on; the phone sets a Reddit comment goal of 35 a week', async () => {
    await run('life', 'on', 'posts');
    await ok('PUT', '/v1/posts/goals', { goals: [{ platform: 'reddit', kind: 'comment', perWeek: 35 }] });
    expect((await today()).posts).toEqual({ today: 0, late: 0, comments: { done: 0, goal: 5 } });
  });

  it("2. jantar post log '<share link>' --text-file logs it and prints its line", async () => {
    const said = join(d.home.root, 'said.md');
    await writeFile(said, `Answered the question first. ${LIFE_MARKER}\r\n\r\nThen one thing I did.\r\n`, 'utf8');
    const out = await run('post', 'log', SHARE, '--text-file', said);
    const m = /^Logged comment (\S+) · Reddit · r\/exampletools\n$/.exec(out);
    expect(m, out).not.toBeNull();
    logged = m?.[1] as string;
    expect(out).not.toContain(LIFE_MARKER);
    expect(out).not.toContain(LINK_MARKER);
  });

  it('3. Done lists it posted with its link and text; Today says 1/5; the week goal is 1/35', async () => {
    const list = await done();
    expect(list.posts).toHaveLength(1);
    expect(list.posts[0]).toMatchObject({
      id: logged,
      platform: 'reddit',
      kind: 'comment',
      where: 'r/exampletools',
      status: 'posted',
      postedUrl: SHARE,
      text: `Answered the question first. ${LIFE_MARKER}\n\nThen one thing I did.`,
    });
    expect(Date.parse(list.posts[0]?.postedAt ?? '')).toBeGreaterThan(0);
    expect(list.week.goals).toEqual([{ platform: 'reddit', kind: 'comment', perWeek: 35, done: 1 }]);
    expect(list.week.posted).toBe(1);
    expect((await today()).posts?.comments).toEqual({ done: 1, goal: 5 });
    // History, not a post to make: the open list stays empty and nothing rings.
    expect((await ok<PostsResponse>('GET', '/v1/posts')).posts).toEqual([]);
  });

  it('4. the same link again is 409 with the sentence, from the Mac and from the phone; nothing more is stored', async () => {
    const again = await cli('post', 'log', SHARE);
    expect(again.code).toBe(1);
    expect(again.err).toBe(`jantar post: ${LOGGED}\n`);
    const phoneAgain = await call('POST', '/v1/posts', { platform: 'reddit', kind: 'comment', status: 'posted', postedUrl: SHARE });
    expect(phoneAgain.status).toBe(409);
    expect((phoneAgain.body as { error: { message: string } }).error.message).toBe(LOGGED);
    expect((await done()).posts).toHaveLength(1);
  });

  it('5. jantar post list --done ends the row with the link, and never prints the text', async () => {
    const out = await run('post', 'list', '--done');
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toContain('Reddit comments 1/35');
    expect(lines[1]).toMatch(new RegExp(`posted {3}Reddit · r/exampletools · comment  ${logged}  ${SHARE.replace(/[.?/]/g, '\\$&')}$`));
    expect(out).not.toContain(LIFE_MARKER);
  });

  it('6. the phone logs an X comment with no where; Today says 2/5', async () => {
    const { id } = await ok<{ id: string }>('POST', '/v1/posts', { platform: 'x', kind: 'comment', status: 'posted', postedUrl: X_LINK, text: `Phone note ${LIFE_MARKER}` });
    expect((await done()).posts.map((p) => p.id)).toEqual([id, logged]);
    expect((await today()).posts?.comments).toEqual({ done: 2, goal: 5 });
    // The Reddit goal counts Reddit only.
    expect((await done()).week.goals).toEqual([{ platform: 'reddit', kind: 'comment', perWeek: 35, done: 1 }]);
  });

  it("7. the sweep: the text's and the link's markers reach no frame, event, audit row, log line, write reply or push", async () => {
    const replay = d.ctx.store.replay(0);
    const ring = replay.kind === 'events' ? replay.events : [];
    const audit = d.ctx.db.audit.list({ after: 0, limit: 100_000 });
    const sources: Record<string, string> = {
      'phone frames': frames.join('\n'),
      'event ring': JSON.stringify(ring),
      'stored events': JSON.stringify(d.ctx.db.events.since(0)),
      'audit rows': JSON.stringify(audit),
      'log lines': JSON.stringify(d.log.records),
      'write replies': JSON.stringify(writes),
      pushes: JSON.stringify(d.webPushes),
      notifications: JSON.stringify(d.pushed),
    };
    for (const [what, text] of Object.entries(sources)) {
      expect(text.includes(LIFE_MARKER), `${what}: the text`).toBe(false);
      expect(text.includes(LINK_MARKER), `${what}: the link`).toBe(false);
    }
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const e of ring.filter((x) => x.type === 'life.changed')) expect(e.data).toEqual({});
    const creates = audit.filter((a) => a.action === 'postCreate');
    expect(creates.length).toBeGreaterThanOrEqual(2);
    for (const row of creates) expect(row.params ?? {}).toEqual({});
  });
});
