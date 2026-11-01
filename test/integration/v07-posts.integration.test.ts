/**
 * v0.7 Posts end to end (spec 7): jantard in-process on a synthetic HOME
 * with the production wiring (harness.ts), on a WarpClock the test moves to
 * each post's time in the UTC Life zone; `jantar` (main() from
 * packages/cli) on the real ctl.sock; a phone paired with control, its
 * event stream open from the start and a Web Push subscription (Web Push
 * sends nothing: the harness records each payload as it would leave the
 * Mac). Nothing posts anywhere and nothing calls a network.
 *
 * 1. Off: the phone gets 403 naming `jantar life on posts`; that command
 *    turns Posts on.
 * 2. `jantar post add` twice for D1 19:30 (one with --text-file and
 *    --notes), every text field and the link marked; the phone lists both
 *    with their text.
 * 3. D1 19:30: one push, "Posts due · 2", "Tap to open · 19:30", /posts,
 *    tag posts:19:30.
 * 4. The daemon down across D1 20:00: one "Missed at 20:00" push for the
 *    post due then, after the restart.
 * 5. lock-screen-details on: a post due at D1 21:00 rings "Post on Reddit ·
 *    r/examplecode · 21:00", where only, never its title, text or notes.
 * 6. The phone marks one posted over TCP and sets a Reddit goal; `jantar
 *    post list` shows it in the week line, and `--done` lists it.
 * 7. ctl.sock has the list and an add only: PATCH, DELETE and PUT goals
 *    there are 404, and the post is unchanged.
 * 8. The sweep: LIFE_MARKER (in where, title, text, notes and link) is in
 *    no WS frame, the ring, the stored events, an audit row, a log line, a
 *    write reply (TCP or ctl.sock) or a push.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIFE_MARKER, perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, eventsSocketProtocols, type Features, type PairStartResponse, type Post, type PostsResponse, type StateResponse } from '@jantar/protocol';
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

const PHONE_PUSH = 'https://fcm.googleapis.com/fcm/send/synthetic-posts-phone';
const KEYS = { p256dh: 'BSyntheticP256dhKeyForThePostsRun', auth: 'synthetic-auth' };
const OFF_SENTENCE = 'Posts are off. Turn them on at your Mac: jantar life on posts';

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** An instant in the Life zone (UTC). */
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00.000Z`);
/** Tomorrow on the wall clock: every ring of the run lands on it, whatever the time now. */
const D1 = dayOf(Date.now() + DAY_MS);
const mark = (s: string) => `${s} ${LIFE_MARKER}`;
const LINK = `https://www.example.com/submit?m=${LIFE_MARKER}`;

interface PushSeen {
  endpoint: string;
  kind: string;
  group?: string;
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

describe('v0.7 Posts through jantard: jantar post, ctl.sock, the phone, the ring and the privacy sweep', () => {
  const clock = new WarpClock();
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let ws: WsClient | null = null;
  const frames: string[] = [];
  /** Every reply to a write, over TCP and over ctl.sock. */
  const writes: Array<{ what: string; text: string }> = [];
  /** The posts made, by name. */
  const ids: Record<string, string> = {};

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

  /** A write over ctl.sock, its reply kept for the sweep. */
  async function viaCtl(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const r = await ctl.request(method, path, body, { idempotencyKey: `k-${randomUUID()}` });
    writes.push({ what: `ctl ${method} ${path}`, text: JSON.stringify(r.body) });
    return r;
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

  async function features(): Promise<Features> {
    const r = await http(d.port, 'GET', '/v1/state', { cookie: phone });
    expect(r.status, r.text).toBe(200);
    const f = (r.body as StateResponse).state.daemon?.features;
    if (!f) throw new Error('the state carries no feature switches');
    return f;
  }

  const open = async (): Promise<Post[]> => (await ok<PostsResponse>('GET', '/v1/posts')).posts;
  const byTitle = async (title: string): Promise<Post> => {
    const p = (await open()).find((x) => x.title === title);
    if (!p) throw new Error(`no open post titled ${title}`);
    return p;
  };

  const pushes = (): PushSeen[] =>
    d.webPushes.map((p) => ({ endpoint: p.endpoint, ...(JSON.parse(p.payload) as Omit<PushSeen, 'endpoint'>) })).filter((p) => p.kind === 'life');

  /** Waits for `n` Life pushes in all; running out names the scheduler's push lines. */
  async function pushesReach(n: number, what: string): Promise<void> {
    try {
      await eventually(async () => pushes().length >= n, 15_000, what);
    } catch (e) {
      const lines = d.log.records
        .filter((r) => /^life (push|ping|sweep)/.test(r.msg))
        .slice(-20)
        .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
        .join('\n');
      throw new Error(`${(e as Error).message}\nnow ${clock.iso()}\n${lines}\n${dumpLog()}`);
    }
  }
  /** No new push for a while: the near timer and the claim are waited for. */
  const settle = () => new Promise((r) => setTimeout(r, 2_500));

  beforeAll(async () => {
    d = await bootDaemon({ clock, home: { sessions: [] }, settings: { notify: { settle_ms: 0 }, life: { timezone: 'UTC' } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'posts phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'posts phone' } });
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

  it('1. off, the phone is told the command; jantar life on posts turns Posts on', async () => {
    const off = await call('GET', '/v1/posts');
    expect(off.status).toBe(403);
    expect((off.body as { error: { message: string } }).error.message).toBe(OFF_SENTENCE);
    expect((await viaCtl('POST', '/v1/posts', { platform: 'reddit' })).status).toBe(403);
    await run('life', 'on', 'posts');
    expect((await features()).life).toBe(true);
    expect(await ok<PostsResponse>('GET', '/v1/posts')).toMatchObject({ posts: [], week: { posted: 0, goals: [] } });
  });

  it('2. jantar post add twice at one minute, one from a text file with notes; the phone lists both with their text', async () => {
    const draft = join(d.home.root, 'draft-post.md');
    await writeFile(draft, `\ufeff${mark('Synthetic draft line one.')}\r\n\r\nLine two.\r\n`, 'utf8');
    const first = await cli(
      'post', 'add', '--platform', 'reddit', '--where', mark('r/exampletools'), '--kind', 'post', '--at', `${D1} 19:30`,
      '--title', mark('Typing into Terminal from a phone'), '--text-file', draft, '--notes', mark('Flair Example. Attach one screenshot.'),
      '--link', LINK, '--status', 'ready',
    );
    expect(first.code, `${first.err}\n${dumpLog()}`).toBe(0);
    expect(first.out).toMatch(/^Added post \S+ \(ready\)/);
    const second = await cli(
      'post', 'add', '--platform', 'Instagram', '--where', mark('@example.studio'), '--kind', 'reel', '--at', `${D1} 19:30`,
      '--title', mark('Approving a prompt from the lock screen'), '--text', mark('A 30-second reel caption.'), '--link', LINK,
    );
    expect(second.code, `${second.err}\n${dumpLog()}`).toBe(0);
    expect(second.out).toMatch(/^Added post \S+ \(idea\)/);

    const reddit = await byTitle(mark('Typing into Terminal from a phone'));
    const reel = await byTitle(mark('Approving a prompt from the lock screen'));
    ids.reddit = reddit.id;
    ids.reel = reel.id;
    expect(reddit).toMatchObject({
      platform: 'reddit',
      kind: 'post',
      where: mark('r/exampletools'),
      text: `${mark('Synthetic draft line one.')}\n\nLine two.`,
      notes: mark('Flair Example. Attach one screenshot.'),
      link: LINK,
      due: { day: D1, time: '19:30' },
      status: 'ready',
    });
    expect(reel).toMatchObject({ platform: 'instagram', kind: 'reel', status: 'idea', due: { day: D1, time: '19:30' } });
  });

  it('3. at D1 19:30 one push for both: "Posts due · 2", the time only, to /posts', async () => {
    const before = pushes().length;
    clock.jumpTo(at(D1, '19:30'));
    await pushesReach(before + 1, 'the 19:30 push');
    await settle();
    const fresh = pushes().slice(before);
    expect(fresh).toEqual([expect.objectContaining({ endpoint: PHONE_PUSH, kind: 'life', group: 'care', title: 'Posts due · 2', body: 'Tap to open · 19:30', url: '/posts', tag: 'posts:19:30' })]);
  });

  it('4. the daemon down across 20:00: one "Missed at 20:00" push after the restart', async () => {
    await run('post', 'add', '--platform', 'x', '--where', mark('@example'), '--kind', 'thread', '--at', `${D1} 20:00`, '--title', mark('Launch thread'), '--text', mark('Thread text.'));
    ids.thread = (await byTitle(mark('Launch thread'))).id;
    const before = pushes().length;
    await d.restart(() => clock.jumpTo(at(D1, '20:30')));
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket after the restart');
    await pushesReach(before + 1, 'the missed 20:00 push');
    await settle();
    const fresh = pushes().slice(before);
    expect(fresh).toEqual([
      expect.objectContaining({
        endpoint: PHONE_PUSH,
        kind: 'life',
        title: 'Post due',
        body: 'Missed at 20:00 · Tap to open · 20:00',
        url: `/posts?id=${ids.thread}`,
        tag: `life:post:${ids.thread}`,
      }),
    ]);
  });

  it('5. lock-screen-details on: the push names the platform and where, never the title, text or notes', async () => {
    await run('life', 'set', 'lock-screen-details', 'on');
    try {
      await run(
        'post', 'add', '--platform', 'reddit', '--where', 'r/examplecode', '--at', `${D1} 21:00`,
        '--title', mark('Approving from the phone'), '--text', mark('Body text.'), '--notes', mark('Notes.'), '--link', LINK,
      );
      ids.details = (await byTitle(mark('Approving from the phone'))).id;
      const before = pushes().length;
      clock.jumpTo(at(D1, '21:00'));
      await pushesReach(before + 1, 'the 21:00 push');
      await settle();
      expect(pushes().slice(before)).toEqual([
        expect.objectContaining({
          endpoint: PHONE_PUSH,
          kind: 'life',
          title: 'Post due',
          body: 'Post on Reddit · r/examplecode · 21:00',
          url: `/posts?id=${ids.details}`,
          tag: `life:post:${ids.details}`,
        }),
      ]);
    } finally {
      await run('life', 'set', 'lock-screen-details', 'off');
    }
  });

  it('6. the phone marks one posted over TCP; jantar post list counts it in the week', async () => {
    expect(await ok('PATCH', `/v1/posts/${ids.reddit}`, { status: 'posted', postedUrl: 'https://www.example.com/r/exampletools/comments/synthetic' })).toEqual({ ok: true });
    expect(await ok('PUT', '/v1/posts/goals', { goals: [{ platform: 'reddit', perWeek: 6 }] })).toEqual({ ok: true });
    const listed = await ok<PostsResponse>('GET', '/v1/posts');
    expect(listed.posts.some((p) => p.id === ids.reddit)).toBe(false);
    expect(listed.week).toMatchObject({ posted: 1, goals: [{ platform: 'reddit', perWeek: 6, done: 1 }] });

    const list = await run('post', 'list');
    const [week, ...rows] = list.trimEnd().split('\n');
    expect(week).toMatch(/^This week \(.+\): 1 posted · Reddit 1\/6$/);
    expect(rows.some((r) => r.includes(ids.reel ?? '-'))).toBe(true);
    expect(rows.some((r) => r.includes(ids.reddit ?? '-'))).toBe(false);
    // The text and the notes are never in a list line.
    expect(list).not.toContain('Synthetic draft line one');
    expect(list).not.toContain('Flair Example');
    const done = await run('post', 'list', '--done');
    expect(done).toContain(ids.reddit);
  });

  it('7. ctl.sock has the list and an add only: PATCH, DELETE and PUT goals there are 404', async () => {
    const before = (await ok<PostsResponse>('GET', '/v1/posts')).posts.find((p) => p.id === ids.reel);
    expect((await viaCtl('PATCH', `/v1/posts/${ids.reel}`, { status: 'posted' })).status).toBe(404);
    expect((await viaCtl('PATCH', `/v1/posts/${ids.reel}`, { text: 'Rewritten by a script' })).status).toBe(404);
    expect((await viaCtl('DELETE', `/v1/posts/${ids.reel}`)).status).toBe(404);
    expect((await viaCtl('PUT', '/v1/posts/goals', { goals: [] })).status).toBe(404);
    expect((await ok<PostsResponse>('GET', '/v1/posts')).posts.find((p) => p.id === ids.reel)).toEqual(before);
    expect((await ok<PostsResponse>('GET', '/v1/posts')).week.goals).toHaveLength(1);
    // The list does answer there, with the owner's text (scripts may read it).
    const listed = await ctl.request<PostsResponse>('GET', '/v1/posts');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(LIFE_MARKER);
  });

  it('8. the sweep: the marker reaches no frame, event, audit row, log line, write reply or push', async () => {
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
    for (const [what, text] of Object.entries(sources)) expect(text.includes(LIFE_MARKER), what).toBe(false);
    expect(writes.length).toBeGreaterThanOrEqual(7);
    expect(pushes().length).toBeGreaterThanOrEqual(3);
    // Posts tick only as `life.changed {}`; the audit rows of their writes carry a post's id at most.
    for (const e of ring.filter((x) => x.type === 'life.changed')) expect(e.data).toEqual({});
    const postRows = audit.filter((a) => a.action.startsWith('post'));
    expect(postRows.map((a) => a.action)).toEqual(expect.arrayContaining(['postCreate', 'postUpdate', 'postGoalsSet']));
    for (const row of postRows) if (row.target) expect(Object.values(ids)).toContain(row.target);
  });
});
