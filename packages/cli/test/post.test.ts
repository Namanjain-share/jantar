/**
 * jantar post (v0.7) against an in-memory daemon, with text files in a temp
 * folder: `add` turns flags into a PostBody (enum names in any case, `--at`
 * with a day and a time or a day alone, a real day only), reads
 * `--text-file` once (a BOM dropped, CRLF made LF, an empty file refused),
 * refuses what PostBodySchema refuses with one plain sentence on one line,
 * and a body over the daemon's limit before sending, and says when a time
 * already gone in the Life zone won't ring; `list` prints the week line and
 * one line per post, never the text or notes (only `--json` does), with
 * `--done` times in the Life zone and each posted link. `log` (v0.9) sends
 * a posted comment with its link, the platform and where read from the
 * link (`--where` overrides), and refuses a link that is not a whole https
 * one before sending. The daemon's 403, 409 and 429 sentences reach the
 * user as they are. Synthetic values only.
 */
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST_TEXT_MAX, type Post, type PostsResponse } from '@jantar/protocol';
import post, { TEXT_FILE_MAX_BYTES } from '../src/commands/post.js';
import { EXIT } from '../src/command.js';
import { contextFor, fail, fakeCtl, ok, type CtlCall, type Handler } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state' };
const ID = '01JSYNTHPOST00000000000000';
const MARKER = 'POST-TEXT-MARKER-91c2';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jantar-post-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function daemon(routes: Record<string, Handler | ReturnType<typeof ok>> = {}) {
  return fakeCtl({ 'POST /v1/posts': () => ok({ id: ID }), ...routes });
}

async function run(args: string[], ctl = daemon()) {
  const c = contextFor({ env: ENV }, { ctl });
  const code = await post.run(args, c.ctx);
  return { code, out: c.io.stdout, err: c.io.stderr, sent: ctl.calls.filter((x: CtlCall) => x.method === 'POST') };
}

describe('post add', () => {
  it('turns the flags into a body (any case), with an idempotency key, and says what it added', async () => {
    const r = await run([
      'add',
      '--platform', 'Reddit',
      '--where', 'r/exampletools',
      '--kind', 'POST',
      '--at', '2026-11-02 19:30',
      '--title', 'Typing into Terminal from a phone',
      '--text', 'Synthetic body.\n\nA second paragraph.',
      '--notes', 'Flair: Example',
      '--link', 'https://www.example.com/submit',
      '--status', 'Ready',
    ]);
    expect(r.err).toBe('');
    expect(r.code).toBe(EXIT.ok);
    expect(r.sent).toEqual([
      {
        method: 'POST',
        path: '/v1/posts',
        body: {
          platform: 'reddit',
          where: 'r/exampletools',
          kind: 'post',
          due: { day: '2026-11-02', time: '19:30' },
          title: 'Typing into Terminal from a phone',
          text: 'Synthetic body.\n\nA second paragraph.',
          notes: 'Flair: Example',
          link: 'https://www.example.com/submit',
          status: 'ready',
        },
        opts: { idempotencyKey: expect.any(String) },
      },
    ]);
    expect(r.out).toBe(`Added post ${ID} (ready) · Reddit · r/exampletools · 2026-11-02 19:30\n`);
  });

  it('only --platform is needed; --at with a day alone; empty values add nothing', async () => {
    const r = await run(['add', '--platform', 'instagram', '--at', '2026-11-03', '--where', ' ', '--notes', '']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.sent[0]?.body).toEqual({ platform: 'instagram', due: { day: '2026-11-03' } });
    expect(r.out).toBe(`Added post ${ID} (idea) · Instagram · 2026-11-03\n`);
  });

  it('refuses a bad --at shape, an unknown platform, kind or status, a missing platform, both text flags and another action\'s flag: usage, nothing sent', async () => {
    for (const bad of [
      ['add', '--platform', 'reddit', '--at', '2026-11-02 7pm'],
      ['add', '--platform', 'reddit', '--at', 'tomorrow'],
      ['add', '--platform', 'reddit', '--at', '2026/11/02'],
      ['add', '--platform', 'reddit', '--at', '2026-11-02 19:30:00'],
      ['add', '--platform', 'myspace'],
      ['add', '--platform', 'reddit', '--kind', 'tweet'],
      ['add', '--platform', 'reddit', '--status', 'posted'],
      ['add', '--where', 'r/exampletools'],
      ['add', '--platform', 'reddit', '--text', 'a', '--text-file', join(dir, 'x.md')],
      ['add', '--platform', 'reddit', '--done'],
      ['add', '--platform', 'reddit', 'extra'],
      ['list', '--platform', 'reddit'],
      ['list', 'extra'],
      ['frob'],
      [],
    ]) {
      const r = await run(bad);
      expect(r.code, bad.join(' ')).toBe(EXIT.usage);
      expect(r.sent, bad.join(' ')).toEqual([]);
    }
  });

  it('a day or time that does not exist is one plain sentence, exit 1', async () => {
    for (const at of ['2026-13-01 10:00', '2026-11-02 24:00', '2026-11-31 19:30', '2027-02-29', '2026-04-00 10:00']) {
      const r = await run(['add', '--platform', 'reddit', '--at', at]);
      expect(r.code, at).toBe(EXIT.failed);
      expect(r.err).toBe('jantar post: --at must be a real day, and a time from 00:00 to 23:59\n');
      expect(r.sent).toEqual([]);
    }
  });

  it('a time already gone in the Life zone is added, and the line says it will not ring', async () => {
    // T0 is 10:00 UTC on 15 Jan 2026: 15:30 in Asia/Kolkata.
    const zone = (timezone: string) => daemon({ 'GET /v1/life/status': ok({ timezone }) });
    const gone = await run(['add', '--platform', 'reddit', '--at', '2026-01-15 15:00'], zone('Asia/Kolkata'));
    expect(gone.code).toBe(EXIT.ok);
    expect(gone.sent).toHaveLength(1);
    expect(gone.out).toBe(`Added post ${ID} (idea) · Reddit · 2026-01-15 15:00 (that time has passed: it won't ring)\n`);
    expect((await run(['add', '--platform', 'reddit', '--at', '2026-01-14 19:30'], zone('Asia/Kolkata'))).out).toContain("it won't ring");
    // Ahead, or a minute ago (it still rings): nothing said. In UTC 15:00 is ahead.
    for (const [at, tz] of [['2026-01-15 16:00', 'Asia/Kolkata'], ['2026-01-15 15:29', 'Asia/Kolkata'], ['2026-01-15 15:00', 'UTC']] as const) {
      expect((await run(['add', '--platform', 'reddit', '--at', at], zone(tz))).out, `${at} ${tz}`).toBe(`Added post ${ID} (idea) · Reddit · ${at}\n`);
    }
    // A day alone never rings; no zone from the daemon: nothing said either way.
    expect((await run(['add', '--platform', 'reddit', '--at', '2026-01-14'], zone('Asia/Kolkata'))).out).toBe(`Added post ${ID} (idea) · Reddit · 2026-01-14\n`);
  });

  it('--where and --title with a newline, a control or a bidi character are refused with the sentence, on one line', async () => {
    for (const [flag, sentence] of [
      ['--where', '--where must be one line of 1 to 80 characters'],
      ['--title', '--title must be one line of 1 to 300 characters'],
    ] as const) {
      for (const value of ['r/example\nmore', 'ring\u0007', 'abc‮def']) {
        const r = await run(['add', '--platform', 'reddit', flag, value]);
        expect(r.code, `${flag} ${JSON.stringify(value)}`).toBe(EXIT.failed);
        expect(r.err).toBe(`jantar post: ${sentence}\n`);
        expect(r.sent).toEqual([]);
      }
    }
    expect((await run(['add', '--platform', 'reddit', '--where', 'r/'.padEnd(81, 'x')])).err).toBe('jantar post: --where must be one line of 1 to 80 characters\n');
  });

  it('--link must be https; --notes at most 2,000 characters', async () => {
    for (const link of ['http://www.example.com/submit', 'javascript:alert(1)', 'www.example.com']) {
      const r = await run(['add', '--platform', 'reddit', '--link', link]);
      expect(r.code, link).toBe(EXIT.failed);
      expect(r.err).toBe('jantar post: --link must be a whole https link\n');
    }
    const notes = await run(['add', '--platform', 'reddit', '--notes', 'n'.repeat(2001)]);
    expect(notes.code).toBe(EXIT.failed);
    expect(notes.err).toBe('jantar post: --notes must be at most 2,000 characters\n');
    expect((await run(['add', '--platform', 'reddit', '--notes', 'n'.repeat(2000)])).code).toBe(EXIT.ok);
  });

  it('--text-file: read once, a BOM dropped and CRLF made LF; missing, a folder, too long and over 1 MB are refused', async () => {
    const file = join(dir, 'reddit-example.md');
    await writeFile(file, '﻿First line\r\n\r\nSecond line\r\n');
    const r = await run(['add', '--platform', 'reddit', '--text-file', file]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.sent[0]?.body).toEqual({ platform: 'reddit', text: 'First line\n\nSecond line' });

    // An empty file (or only spaces) is refused: a wrong draft in a batch is seen.
    for (const empty of ['', ' \r\n\n  ', '﻿']) {
      await writeFile(join(dir, 'empty.md'), empty);
      const none = await run(['add', '--platform', 'reddit', '--text-file', join(dir, 'empty.md')]);
      expect(none.code).toBe(EXIT.failed);
      expect(none.err).toMatch(/^jantar post: --text-file .*empty\.md is empty\n$/);
      expect(none.sent).toEqual([]);
    }

    const missing = await run(['add', '--platform', 'reddit', '--text-file', join(dir, 'nope.md')]);
    expect(missing.code).toBe(EXIT.failed);
    expect(missing.err).toMatch(/^jantar post: cannot read --text-file .*nope\.md: there is no such file\n$/);
    await mkdir(join(dir, 'folder.md'));
    expect((await run(['add', '--platform', 'reddit', '--text-file', join(dir, 'folder.md')])).err).toMatch(/is not a file\n$/);

    const long = join(dir, 'long.md');
    await writeFile(long, 'x'.repeat(POST_TEXT_MAX + 1));
    const tooLong = await run(['add', '--platform', 'reddit', '--text-file', long]);
    expect(tooLong.code).toBe(EXIT.failed);
    expect(tooLong.err).toBe('jantar post: the text must be at most 20,000 characters\n');
    await writeFile(long, 'x'.repeat(POST_TEXT_MAX));
    expect((await run(['add', '--platform', 'reddit', '--text-file', long])).code).toBe(EXIT.ok);

    const big = join(dir, 'big.md');
    await writeFile(big, '');
    await truncate(big, TEXT_FILE_MAX_BYTES + 1);
    const huge = await run(['add', '--platform', 'reddit', '--text-file', big]);
    expect(huge.code).toBe(EXIT.failed);
    expect(huge.err).toMatch(/is over 1 MB; a post's text is at most 20,000 characters\n$/);
  });

  it('a body over 64 KB once sent (20,000 Devanagari characters and 2,000 of notes) is refused before sending', async () => {
    const file = join(dir, 'hindi.md');
    await writeFile(file, 'क'.repeat(POST_TEXT_MAX));
    const r = await run(['add', '--platform', 'instagram', '--text-file', file, '--notes', 'ख'.repeat(2000)]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toBe('jantar post: This post is 65 KB once sent; the most is 64 KB. Shorten the text or the notes.\n');
    expect(r.sent).toEqual([]);
    // The text alone fits.
    expect((await run(['add', '--platform', 'instagram', '--text-file', file])).code).toBe(EXIT.ok);
  });

  it("the daemon's sentences reach the user as they are: posts off (403) and the hourly limit (429)", async () => {
    const off = await run(['add', '--platform', 'reddit'], daemon({ 'POST /v1/posts': fail('forbidden', 'Posts are off. Turn them on at your Mac: jantar life on posts', 403) }));
    expect(off.code).toBe(EXIT.failed);
    expect(off.err).toBe('jantar post: Posts are off. Turn them on at your Mac: jantar life on posts\n');
    const limited = 'Scripts and Claude sessions added 30 posts this hour. Add more on the phone, or try again later.';
    const many = await run(['add', '--platform', 'reddit'], daemon({ 'POST /v1/posts': fail('rate_limited', limited, 429) }));
    expect(many.code).toBe(EXIT.failed);
    expect(many.err).toBe(`jantar post: ${limited}\n`);
    const down = contextFor({ env: ENV }, { ctl: fakeCtl({}, { down: true }) });
    expect(await post.run(['add', '--platform', 'reddit'], down.ctx)).toBe(EXIT.daemonDown);
  });
});

describe('post list', () => {
  const stamp = '2026-11-01T10:00:00.000Z';
  const base = { status: 'idea' as const, createdAt: stamp, updatedAt: stamp };
  const posts: Post[] = [
    { ...base, id: '01JSYNTHPOST0000000000000A', platform: 'reddit', kind: 'post', where: 'r/exampletools', title: 'Typing into Terminal from a phone without answering the wrong prompt', text: MARKER, notes: MARKER, link: 'https://www.example.com/submit', due: { day: '2026-11-02', time: '19:30' } },
    { ...base, id: '01JSYNTHPOST0000000000000B', platform: 'reddit', kind: 'comment', where: 'r/examplecode · weekly thread', due: { day: '2026-11-03', time: '19:30' }, status: 'ready' },
    { ...base, id: '01JSYNTHPOST0000000000000C', platform: 'instagram', kind: 'reel', due: { day: '2026-11-04' }, text: MARKER },
    { ...base, id: '01JSYNTHPOST0000000000000D', platform: 'x', kind: 'thread' },
  ];
  const reply = (over: Partial<PostsResponse> = {}): PostsResponse => ({
    today: '2026-11-02',
    week: { from: '2026-11-02', to: '2026-11-08', posted: 2, goals: [{ platform: 'instagram', kind: 'reel', perWeek: 3, done: 1 }, { platform: 'reddit', perWeek: 6, done: 2 }] },
    posts,
    ...over,
  });

  it('prints the week line, then one line per post: when, status, where and kind, the title clipped, the id; never text or notes', async () => {
    const ctl = fakeCtl({ 'GET /v1/posts': () => ok(reply()) });
    const r = await run(['list'], ctl);
    expect(r.code).toBe(EXIT.ok);
    expect(ctl.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/posts?done=0']);
    expect(r.out.split('\n')).toEqual([
      'This week (2 Nov to 8 Nov): 2 posted · Reels 1/3 · Reddit 2/6',
      '2026-11-02 19:30  idea   Reddit · r/exampletools · post  Typing into Terminal from a phone without answering the wro…  01JSYNTHPOST0000000000000A',
      '2026-11-03 19:30  ready  Reddit · r/examplecode · weekly thread · comment  01JSYNTHPOST0000000000000B',
      '2026-11-04        idea   Instagram · reel  01JSYNTHPOST0000000000000C',
      '-                 idea   X · thread  01JSYNTHPOST0000000000000D',
      '',
    ]);
    expect(r.out).not.toContain(MARKER);
  });

  it('with nothing posted and no goal; and an empty list says how to add one', async () => {
    const r = await run(['list'], fakeCtl({ 'GET /v1/posts': () => ok(reply({ week: { from: '2026-10-26', to: '2026-11-01', posted: 0, goals: [] }, posts: [] })) }));
    expect(r.out).toBe('This week (26 Oct to 1 Nov): nothing posted yet · no weekly goal\nNothing to post yet. Add one: jantar post add --platform <p>\n');
  });

  it('--done asks for posted and skipped, and shows when each was posted', async () => {
    const postedAt = new Date(2026, 10, 2, 19, 41).toISOString();
    const done: Post[] = [
      { ...base, id: '01JSYNTHPOST0000000000000E', platform: 'reddit', kind: 'post', where: 'r/exampletools', status: 'posted', postedAt, postedUrl: 'https://www.example.com/p/1' },
      { ...base, id: '01JSYNTHPOST0000000000000F', platform: 'instagram', kind: 'story', status: 'skipped', updatedAt: new Date(2026, 10, 1, 9, 5).toISOString() },
    ];
    const ctl = fakeCtl({ 'GET /v1/posts': () => ok(reply({ posts: done })) });
    const r = await run(['list', '--done'], ctl);
    expect(ctl.calls[0]?.path).toBe('/v1/posts?done=1');
    expect(r.out.split('\n').slice(1)).toEqual([
      '2026-11-02 19:41  posted   Reddit · r/exampletools · post  01JSYNTHPOST0000000000000E  https://www.example.com/p/1',
      '2026-11-01 09:05  skipped  Instagram · story  01JSYNTHPOST0000000000000F',
      '',
    ]);
  });

  it('--done ends a posted row with its whole link (a control character printed as a space), and never prints text or notes', async () => {
    const long = `https://www.reddit.com/r/exampletools/comments/1abc2de/comment/kx9y8z7/?utm_source=share&utm_medium=web3x&utm_name=${'a'.repeat(120)}`;
    const done: Post[] = [
      { ...base, id: '01JSYNTHPOST0000000000000G', platform: 'reddit', kind: 'comment', where: 'r/exampletools', status: 'posted', postedAt: '2026-11-02T15:44:00.000Z', postedUrl: long, text: MARKER, notes: MARKER },
      { ...base, id: '01JSYNTHPOST0000000000000H', platform: 'x', kind: 'comment', status: 'posted', postedAt: '2026-11-02T15:40:00.000Z', postedUrl: 'https://x.com/example_user/status/1\u001b[31mred' },
    ];
    const r = await run(['list', '--done'], fakeCtl({ 'GET /v1/posts': () => ok(reply({ posts: done })), 'GET /v1/life/status': ok({ timezone: 'UTC' }) }));
    expect(r.out.split('\n').slice(1)).toEqual([
      `2026-11-02 15:44  posted   Reddit · r/exampletools · comment  01JSYNTHPOST0000000000000G  ${long}`,
      '2026-11-02 15:40  posted   X · comment  01JSYNTHPOST0000000000000H  https://x.com/example_user/status/1red',
      '',
    ]);
    expect(r.out).not.toContain(MARKER);
    expect(r.out).not.toContain('\u001b');
  });

  it('a list without --done never prints a link', async () => {
    const r = await run(['list'], fakeCtl({ 'GET /v1/posts': () => ok(reply()) }));
    expect(r.out).not.toContain('https://');
  });

  it('--done shows the times in the Life zone, not the Mac\'s', async () => {
    const done: Post[] = [{ ...base, id: '01JSYNTHPOST0000000000000E', platform: 'reddit', kind: 'post', status: 'posted', postedAt: '2026-11-02T14:11:00.000Z' }];
    const ctl = fakeCtl({ 'GET /v1/posts': () => ok(reply({ posts: done })), 'GET /v1/life/status': ok({ timezone: 'Asia/Kolkata' }) });
    const r = await run(['list', '--done'], ctl);
    expect(r.out.split('\n')[1]).toBe('2026-11-02 19:41  posted   Reddit · post  01JSYNTHPOST0000000000000E');
  });

  it('--json prints the reply as it came, text and notes included, for scripts', async () => {
    const r = await run(['list', '--json'], fakeCtl({ 'GET /v1/posts': () => ok(reply()) }));
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.out)).toEqual(reply());
  });

  it('posts off: the daemon sentence, exit 1', async () => {
    const r = await run(['list'], fakeCtl({ 'GET /v1/posts': fail('forbidden', 'Posts are off. Turn them on at your Mac: jantar life on posts', 403) }));
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toBe('jantar post: Posts are off. Turn them on at your Mac: jantar life on posts\n');
  });
});

describe('post log', () => {
  const SHARE = 'https://www.reddit.com/r/exampletools/s/AbCdEf1234';

  it('sends a posted comment with its link, the platform and where read from the link, and says what it logged', async () => {
    const rows: [string, Record<string, unknown>, string][] = [
      [
        'https://www.reddit.com/r/exampletools/comments/1abc2de/comment/kx9y8z7/?utm_source=share&utm_medium=web3x',
        { platform: 'reddit', where: 'r/exampletools' },
        'Reddit · r/exampletools',
      ],
      [SHARE, { platform: 'reddit', where: 'r/exampletools' }, 'Reddit · r/exampletools'],
      ['https://redd.it/1abc2de', { platform: 'reddit' }, 'Reddit'],
      ['https://x.com/example_user/status/1234567890123456789', { platform: 'x' }, 'X'],
      ['https://forum.example.org/t/1#post-2', { platform: 'other', where: 'forum.example.org' }, 'Other · forum.example.org'],
    ];
    for (const [link, place, said] of rows) {
      const r = await run(['log', `  ${link} `]);
      expect(r.err, link).toBe('');
      expect(r.code, link).toBe(EXIT.ok);
      expect(r.sent, link).toEqual([
        { method: 'POST', path: '/v1/posts', body: { ...place, kind: 'comment', status: 'posted', postedUrl: link }, opts: { idempotencyKey: expect.any(String) } },
      ]);
      expect(r.out, link).toBe(`Logged comment ${ID} · ${said}\n`);
    }
  });

  it('--where overrides the link; --text and --text-file give what was written', async () => {
    const over = await run(['log', SHARE, '--where', 'r/examplecode', '--text', '  What I wrote.  ']);
    expect(over.sent[0]?.body).toEqual({ platform: 'reddit', kind: 'comment', status: 'posted', postedUrl: SHARE, where: 'r/examplecode', text: 'What I wrote.' });
    expect(over.out).toBe(`Logged comment ${ID} · Reddit · r/examplecode\n`);
    const x = await run(['log', 'https://x.com/example_user/status/1234567890123456789', '--where', '@example_studio']);
    expect(x.sent[0]?.body).toMatchObject({ platform: 'x', where: '@example_studio' });
    const file = join(dir, 'said.md');
    await writeFile(file, '\ufeffFirst line\r\n\r\nSecond line\r\n');
    const fromFile = await run(['log', SHARE, '--text-file', file]);
    expect(fromFile.code).toBe(EXIT.ok);
    expect(fromFile.sent[0]?.body).toMatchObject({ text: 'First line\n\nSecond line' });
    // An empty --where keeps the link's.
    expect((await run(['log', SHARE, '--where', ' '])).sent[0]?.body).toMatchObject({ where: 'r/exampletools' });
  });

  it('a missing link, both text flags or another action\'s flag is usage; nothing sent', async () => {
    for (const bad of [
      ['log'],
      ['log', SHARE, '--text', 'a', '--text-file', join(dir, 'x.md')],
      ['log', SHARE, '--platform', 'reddit'],
      ['log', SHARE, '--kind', 'post'],
      ['log', SHARE, '--done'],
      ['log', SHARE, '--status', 'ready'],
    ]) {
      const r = await run(bad);
      expect(r.code, bad.join(' ')).toBe(EXIT.usage);
      expect(r.sent, bad.join(' ')).toEqual([]);
    }
    expect((await run(['log'])).err).toContain("log needs the link to your comment, in quotes: jantar post log 'https://…'");
  });

  it('a link that is not a whole https link is one sentence, exit 1, nothing sent', async () => {
    for (const link of ['http://www.reddit.com/r/exampletools/s/AbCdEf1234', 'www.reddit.com/r/exampletools', 'reddit.com/r/exampletools', 'javascript:alert(1)', '', ' ']) {
      const r = await run(['log', link]);
      expect(r.code, link).toBe(EXIT.failed);
      expect(r.err, link).toBe("jantar post: The link must be a whole https link. Put it in quotes: jantar post log 'https://…'\n");
      expect(r.sent, link).toEqual([]);
    }
    // A bad --where is the add's sentence.
    const where = await run(['log', SHARE, '--where', 'r/example\ntools']);
    expect(where.code).toBe(EXIT.failed);
    expect(where.err).toBe('jantar post: --where must be one line of 1 to 80 characters\n');
    expect(where.sent).toEqual([]);
  });

  it("the daemon's sentences reach the user as they are: the same link twice (409) and the hourly limit (429)", async () => {
    const twice = await run(['log', SHARE], daemon({ 'POST /v1/posts': fail('conflict', 'You logged that link already.', 409) }));
    expect(twice.code).toBe(EXIT.failed);
    expect(twice.err).toBe('jantar post: You logged that link already.\n');
    const limited = 'Scripts and Claude sessions added 30 posts this hour. Add more on the phone, or try again later.';
    const many = await run(['log', SHARE], daemon({ 'POST /v1/posts': fail('rate_limited', limited, 429) }));
    expect(many.code).toBe(EXIT.failed);
    expect(many.err).toBe(`jantar post: ${limited}\n`);
  });
});
