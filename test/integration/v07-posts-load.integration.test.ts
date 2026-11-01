/**
 * v0.7 Posts: one row of the main session's load (spec 12.3), as it runs
 * after deploy. jantard in-process on a synthetic HOME (harness.ts), the
 * Life zone Asia/Kolkata and a WarpClock; `jantar` (main() from
 * packages/cli) on the real ctl.sock; a phone paired with control and a
 * Web Push subscription (the harness records each payload instead of
 * sending it).
 *
 * `jantar post add` gets a long draft in --text-file (several thousand
 * characters, paragraphs, Markdown, curly quotes and dashes), a title past
 * the list's 60 characters, --at at 19:30 IST, notes, an https link and
 * --status ready. `jantar post list` shows the row, the phone reads the
 * text back exactly, nothing rings at 19:29, and at 19:30 IST one push
 * leaves, with no title, text or notes in it. Synthetic text only;
 * nothing posts anywhere.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, type PairStartResponse, type PostsResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';
import { WarpClock } from './warp-clock.js';

const PHONE_PUSH = 'https://fcm.googleapis.com/fcm/send/synthetic-posts-load-phone';
const KEYS = { p256dh: 'BSyntheticP256dhKeyForThePostsLoad', auth: 'synthetic-auth' };

/** Tomorrow's day (UTC); 19:30 IST on it is always ahead of now. */
const D1 = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
/** An instant on D1's wall clock in Asia/Kolkata (+05:30, no daylight saving). */
const ist = (hhmm: string) => Date.parse(`${D1}T${hhmm}:00.000+05:30`);

const TITLE = 'Typing into an example terminal from a phone without answering the wrong prompt';
const PARAGRAPH =
  'I run a handful of example sessions on one Mac and read most things on my phone — the one that needs me is usually ' +
  'waiting in a tab I’m not looking at. This is a “synthetic” paragraph for the load test, with `code` and **bold**.';
/** About 9,000 characters, like the longest launch draft. */
const DRAFT = Array.from({ length: 36 }, (_, i) => `${i % 6 === 0 ? `## Part ${i / 6 + 1}\n\n` : ''}${PARAGRAPH}`).join('\n\n');
const NOTES = 'Flair: Example. Re-read the sidebar first. Stay around for the first hour.';
const LINK = 'https://www.example.com/r/exampletools/submit';

describe('v0.7 Posts: the main session loads a long ready draft at 19:30 IST, lists it, and the phone is pinged then', () => {
  const clock = new WarpClock();
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';

  async function run(...argv: string[]): Promise<string> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    expect(code, `jantar ${argv.slice(0, 2).join(' ')}: ${io.stderr}`).toBe(0);
    return io.stdout;
  }

  const lifePushes = () =>
    d.webPushes.map((p) => ({ endpoint: p.endpoint, ...(JSON.parse(p.payload) as { kind: string }) })).filter((p) => p.kind === 'life');

  beforeAll(async () => {
    d = await bootDaemon({ clock, home: { sessions: [] }, settings: { notify: { settle_ms: 0 }, life: { timezone: 'Asia/Kolkata' } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'load phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'load phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    const sub = await http(d.port, 'POST', '/v1/push/subscribe', { cookie: phone, body: { subscription: { endpoint: PHONE_PUSH, keys: KEYS } } });
    expect(sub.status, sub.text).toBe(200);
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('adds, lists and rings one post as spec 12.3 loads it', async () => {
    expect(DRAFT.length).toBeGreaterThan(8_000);
    await run('life', 'on', 'posts');
    const draft = join(d.home.root, 'reddit-example-body.md');
    await writeFile(draft, `${DRAFT}\n`, 'utf8');

    const added = await run(
      'post', 'add', '--platform', 'reddit', '--where', 'r/exampletools', '--kind', 'post', '--at', `${D1} 19:30`,
      '--title', TITLE, '--text-file', draft, '--notes', NOTES, '--link', LINK, '--status', 'ready',
    );
    const id = /^Added post (\S+) \(ready\) · Reddit · r\/exampletools · (\S+ \S+)\n$/.exec(added);
    expect(id?.[2], added).toBe(`${D1} 19:30`);
    const postId = id?.[1] as string;

    // The list: the week line, then the row with the title clipped to 60 and no text or notes.
    const [week, ...rows] = (await run('post', 'list')).trimEnd().split('\n');
    expect(week).toMatch(/^This week \(\d+ \w{3} to \d+ \w{3}\): nothing posted yet · no weekly goal$/);
    expect(rows).toEqual([`${D1} 19:30  ready  Reddit · r/exampletools · post  ${TITLE.slice(0, 59)}…  ${postId}`]);

    // The phone has the whole text, exactly as the file had it (the final newline trimmed).
    const phoneList = await http(d.port, 'GET', '/v1/posts', { cookie: phone });
    expect(phoneList.status, phoneList.text).toBe(200);
    expect((phoneList.body as PostsResponse).posts).toEqual([
      expect.objectContaining({ id: postId, platform: 'reddit', kind: 'post', where: 'r/exampletools', title: TITLE, text: DRAFT, notes: NOTES, link: LINK, status: 'ready', due: { day: D1, time: '19:30' } }),
    ]);

    // 19:29 IST: nothing yet. 19:30 IST: one push for it.
    clock.jumpTo(ist('19:29'));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(lifePushes()).toEqual([]);
    clock.jumpTo(ist('19:30'));
    await eventually(async () => lifePushes().length >= 1, 15_000, 'the 19:30 IST push');
    await new Promise((r) => setTimeout(r, 1_500));
    expect(lifePushes()).toEqual([
      expect.objectContaining({ endpoint: PHONE_PUSH, kind: 'life', title: 'Post due', body: 'Tap to open · 19:30', url: `/posts?id=${postId}`, tag: `life:post:${postId}` }),
    ]);
    const sent = JSON.stringify(d.webPushes);
    for (const secret of [TITLE, PARAGRAPH.slice(0, 40), NOTES]) expect(sent).not.toContain(secret);
  });
});
