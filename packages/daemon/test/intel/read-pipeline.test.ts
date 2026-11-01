/**
 * One read, start to end (spec 2, 3, 4, 6), through the service as the
 * routes call it: save at once, one job at a time, the page tiers in order,
 * the depths, the media helper, Claude, the item's last line, Retry, Delete
 * and the hard stop.
 *
 * Everything stands in: local HTTPS servers with a test certificate for the
 * public hosts (the guard's seam; the BlockList is never relaxed), the
 * extension as calls to extNext/extResult, a fake playwright that never
 * loads, a fake ctx.exec for claude and the media helper. No network, no
 * browser, no Swift compile.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEL_READ_LIMITS, INTEL_READ_NOTES, INTEL_READ_REASONS, IntelReadReplySchema, type PageReadParsed } from '@jantar/protocol';
import type { ExecCall } from '../../src/core/testing.js';
import { READ_SENTENCES } from '../../src/intel/service.js';
import { HAVE_OPENSSL, TINY_JPEG, httpsServer, seamFor, type Handler, type TestServer } from './read-helpers.js';
import { ANSWER, HELPER_BINS, fakeClaude, fakeHelper, hangingClaude, readEnv, until, type ReadEnv } from './read-env.js';

let envs: ReadEnv[] = [];
let servers: TestServer[] = [];
let clts: string[] = [];
afterEach(async () => {
  for (const e of envs.reverse()) await e.cleanup();
  for (const s of servers) await s.close();
  for (const d of clts) rmSync(d, { recursive: true, force: true });
  envs = [];
  servers = [];
  clts = [];
});
async function env(o: Parameters<typeof readEnv>[0] = {}): Promise<ReadEnv> {
  const e = await readEnv(o);
  envs.push(e);
  return e;
}

/** A local HTTPS server answering by Host and path (query aside). */
async function site(routes: Record<string, Handler>): Promise<TestServer> {
  const s = await httpsServer((req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const path = (req.url ?? '/').split('?')[0] as string;
    const h = routes[`${host}${path}`];
    if (h) h(req, res);
    else {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><title>Not found</title></html>');
    }
  });
  servers.push(s);
  return s;
}
const html = (body: string): Handler => (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const json = (v: unknown): Handler => (_q, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v));
};
const jpeg: Handler = (_q, res) => {
  res.writeHead(200, { 'content-type': 'image/jpeg' });
  res.end(TINY_JPEG);
};
/** A file that starts like an mp4 (the helper is fake: nothing decodes it). */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]), Buffer.alloc(2048)]);
const mp4: Handler = (_q, res) => {
  res.writeHead(200, { 'content-type': 'video/mp4' });
  res.end(MP4);
};

const ARTICLE_TEXT = 'A synthetic article about example tools. '.repeat(8);
function article(extra = ''): string {
  return `<!doctype html><html><head><title>Example tools</title>
  <meta property="og:title" content="Example tools, compared">
  <meta property="og:type" content="article">
  <meta property="og:description" content="A synthetic comparison.">
  <meta name="author" content="Example Writer">
  <meta property="og:image" content="https://www.example.test/pic.jpg">
  </head><body><nav>Menu</nav><article><p>${ARTICLE_TEXT}</p><p>${extra}</p></article></body></html>`;
}

function idOf(r: Awaited<ReturnType<ReadEnv['intel']['read']>>): string {
  if (!r.ok) throw new Error(r.reason);
  return r.value.id.slice('captures:'.length);
}
function claudeCalls(e: ReadEnv): ExecCall[] {
  return e.exec.calls.filter((c) => c.file.split('/').pop() === 'claude');
}
function stdinOf(c: ExecCall): { text: string; images: number } {
  const msg = JSON.parse(c.opts.input ?? '{}') as { message: { content: { type: string; text?: string }[] } };
  return { text: msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), images: msg.message.content.filter((b) => b.type === 'image').length };
}

// ---------------------------------------------------------------- saving

describe('saving', () => {
  it('a note: saved at once, read by Claude, the last line has the answer; one audit row of counts', async () => {
    const e = await env();
    const r = await e.intel.read({ text: 'A synthetic thought about example tools' }, { via: 'cli' });
    expect(IntelReadReplySchema.parse(r.ok && r.value)).toMatchObject({ duplicate: false, queued: true, message: READ_SENTENCES.saved });
    const id = idOf(r);
    // Findable at once, pending.
    expect(e.intel.get(`captures:${id}`)).toMatchObject({ title: 'A synthetic thought about example tools', platform: 'note' });
    const jobs = await e.idle();
    expect(jobs.map((j) => j.state)).toEqual(['saved']);
    const line = e.items().get(id) as Record<string, unknown>;
    expect(line).toMatchObject({
      title: ANSWER.title,
      what_it_is: ANSWER.summary,
      why_it_matters: ANSWER.why,
      tags: ['recipe', 'dal'],
      points: ANSWER.points,
      platform: 'note',
      type: 'note',
      note: 'A synthetic thought about example tools',
      via: 'cli',
      frames: 0,
      read: { state: 'saved', depth: 'standard', done: 'standard' },
    });
    expect(line).not.toHaveProperty('url');
    const audit = e.ctx.db.audit.list().filter((a) => a.action === 'intel.read');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target: `captures:${id}`, result: 'ok', params: { depth: 'standard', done: 'standard', frames: 0, outcome: 'ok', model: 'sonnet', promptVersion: 'v1' } });
    expect(JSON.stringify(audit)).not.toContain('synthetic thought');
    expect(JSON.stringify(e.ctx.log.records)).not.toContain('synthetic thought');
  });

  it('reading off: the link is kept as a plain capture and no read starts', async () => {
    const e = await env({ intel: { read: false } });
    const r = await e.intel.read({ text: 'https://example.com/a-page later' }, { via: 'phone' });
    expect(r).toMatchObject({ ok: true, value: { duplicate: false, queued: false, message: READ_SENTENCES.savedOff } });
    const line = e.items().get(idOf(r));
    expect(line).toMatchObject({ url: 'https://example.com/a-page', platform: 'web', note: 'later', via: 'phone' });
    expect(line).not.toHaveProperty('read');
    expect(e.exec.calls).toEqual([]);
  });

  it('read-only: saved failed with the reason; the jobs say it can\'t run', async () => {
    const e = await env({ read: { readOnly: true } });
    const r = await e.intel.read({ text: 'https://example.com/a-page' }, { via: 'cli' });
    expect(r).toMatchObject({ ok: true, value: { queued: false, message: `Saved. ${INTEL_READ_REASONS.readOnly}` } });
    expect(e.items().get(idOf(r))?.read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.readOnly });
    expect(e.intel.jobs().reading).toEqual({ on: true, canRun: false, why: INTEL_READ_REASONS.readOnly });
    expect(e.intel.reread(`captures:${idOf(r)}`, undefined)).toMatchObject({ ok: false, reason: INTEL_READ_REASONS.readOnly });
  });

  it('a link that breaks the URL rules is refused and nothing is saved', async () => {
    const e = await env();
    for (const text of ['https://127.0.0.1/admin', 'look https://user:pw@example.com/', 'https://example.com:8443/x', 'https://printer.local/']) {
      expect(await e.intel.read({ text }, { via: 'cli' })).toEqual({ ok: false, code: 'invalid_request', reason: INTEL_READ_REASONS.badLink });
    }
    expect(existsSync(e.file)).toBe(false);
  });

  it('the same post shared twice is one item (canonical link)', async () => {
    const e = await env({ intel: { read: false } });
    const first = await e.intel.read({ text: 'https://instagram.com/example_cook/reel/AbC123xyz/?igsh=one' }, { via: 'cli' });
    const again = await e.intel.read({ text: 'https://www.instagram.com/example_cook/reel/AbC123xyz/?igsh=two&utm_source=ig_web_copy_link' }, { via: 'phone' });
    expect(again).toEqual({ ok: true, value: { id: first.ok ? first.value.id : '', duplicate: true, queued: false, message: READ_SENTENCES.duplicate } });
    expect(e.lines()).toHaveLength(1);
    expect(e.lines()[0]).toMatchObject({ url: 'https://www.instagram.com/example_cook/reel/AbC123xyz/', platform: 'instagram', type: 'reel', title: 'Instagram reel' });
  });

  it('over today\'s cap a save is kept failed (Retry later)', async () => {
    const e = await env({ handlers: [hangingClaude()] });
    for (let i = 0; i < INTEL_READ_LIMITS.fullPerDay; i++) e.intel.queue.push({ rid: `R${i}`, link: null, kind: { platform: 'note', type: 'note', post: null }, depth: 'full', title: 't', note: null, base: { id: `R${i}` }, userTags: [] });
    const r = await e.intel.read({ text: 'a full read too many', depth: 'full' }, { via: 'cli' });
    expect(r).toMatchObject({ ok: true, value: { queued: false, message: `Saved. ${INTEL_READ_REASONS.daily}` } });
    expect(e.items().get(idOf(r))?.read).toMatchObject({ state: 'failed', depth: 'full', reason: INTEL_READ_REASONS.daily });
  });
});

// ---------------------------------------------------------------- the tiers

describe.skipIf(!HAVE_OPENSSL)('the page tiers', () => {
  it('a web page: the browser (unavailable here), then the guarded download; Light shows Claude no picture', async () => {
    const s = await site({ 'www.example.test/a-post': html(article()), 'www.example.test/pic.jpg': jpeg });
    const seen: ExecCall[] = [];
    const e = await env({ read: { net: seamFor(s.port) }, handlers: [fakeClaude(ANSWER, seen)] });
    const id = idOf(await e.intel.read({ text: 'https://www.example.test/a-post?utm_source=x my own words', depth: 'light' }, { via: 'phone' }));
    await e.idle();
    const line = e.items().get(id) as Record<string, unknown>;
    expect(line).toMatchObject({ url: 'https://www.example.test/a-post', platform: 'web', type: 'article', creator: 'Example Writer', note: 'my own words', read: { state: 'saved', depth: 'light', done: 'light', tier: 'download' } });
    expect(String(line.caption)).toContain('A synthetic article about example tools.');
    const sent = stdinOf(seen[0] as ExecCall);
    expect(sent.images).toBe(0);
    expect(sent.text).toMatch(/<item>[\s\S]*www\.example\.test[\s\S]*<\/item>/);
    expect(sent.text).toContain('<page_text>');
    expect(sent.text).toContain('<user_note>');
    expect(sent.text).not.toContain('Menu');
  });

  it('Standard without sandbox-exec: the read goes on as Light, with the note', async () => {
    const s = await site({ 'www.example.test/a-post': html(article()), 'www.example.test/pic.jpg': jpeg });
    const e = await env({ read: { net: seamFor(s.port) } });
    const id = idOf(await e.intel.read({ text: 'https://www.example.test/a-post' }, { via: 'cli' }));
    await e.idle();
    expect(e.items().get(id)?.read).toMatchObject({ state: 'saved', depth: 'standard', done: 'light', notes: [INTEL_READ_NOTES.noSandbox] });
  });

  it('Instagram in the user\'s Chrome: the extension gets the rebuilt URL, never the link as typed', async () => {
    const seen: ExecCall[] = [];
    const e = await env({ handlers: [fakeClaude(ANSWER, seen)] });
    expect(e.intel.extNext('ext-1')).toBeNull();
    const id = idOf(await e.intel.read({ text: 'https://instagram.com/someone_else/reel/AbC123xyz/?igsh=zzz&next=https://example.com for sunday' }, { via: 'phone' }));
    const job = await until(() => e.intel.extNext('ext-1'), 5_000, 'the Chrome lease');
    expect(job).toMatchObject({ url: 'https://www.instagram.com/reel/AbC123xyz/', platform: 'instagram', frames: INTEL_READ_LIMITS.chromeFrames });
    expect(e.intel.queue.list()[0]).toMatchObject({ state: 'fetching', tier: 'chrome' });
    const read: PageReadParsed = { finalUrl: 'https://www.instagram.com/reel/AbC123xyz/', meta: [], jsonld: [], text: 'Three ways to cook dal at home', author: 'Example Cook', handle: '@example_cook', media: [], frames: [] };
    // Only the extension that took the lease may answer it.
    expect(e.intel.extResult(job.id, 'ext-2', { ok: true, page: read })).toMatchObject({ ok: false, code: 'not_found' });
    expect(e.intel.extResult(job.id, 'ext-1', { ok: true, page: read })).toEqual({ ok: true, value: true });
    await e.idle();
    expect(e.items().get(id)).toMatchObject({ caption: 'Three ways to cook dal at home', creator: 'Example Cook', read: { state: 'saved', tier: 'chrome' } });
    const sent = stdinOf(seen[0] as ExecCall);
    expect(sent.text).toMatch(/<byline>[\s\S]*Example Cook[\s\S]*<\/byline>/);
    expect(sent.text).toMatch(/<caption>[\s\S]*Three ways to cook dal[\s\S]*<\/caption>/);
  });

  it('a Chrome read that ended off the post (a login page) is never used', async () => {
    const e = await env();
    e.intel.extNext('ext-1');
    const id = idOf(await e.intel.read({ text: 'https://www.instagram.com/reel/AbC123xyz/' }, { via: 'phone' }));
    const job = await until(() => e.intel.extNext('ext-1'), 5_000, 'the Chrome lease');
    e.intel.extResult(job.id, 'ext-1', { ok: true, page: { finalUrl: 'https://www.instagram.com/accounts/login/', meta: [], jsonld: [], text: 'PLANTED-NAV-TEXT', media: [], frames: [] } });
    await e.idle();
    const line = e.items().get(id) as Record<string, unknown>;
    expect(JSON.stringify(line)).not.toContain('PLANTED-NAV-TEXT');
    expect(line.read).toMatchObject({ state: 'failed' });
    expect(claudeCalls(e)).toEqual([]);
  });

  it('a web link never goes to the user\'s Chrome', async () => {
    const s = await site({ 'www.example.test/a-post': html(article()) });
    const e = await env({ read: { net: seamFor(s.port) } });
    e.intel.extNext('ext-1');
    await e.intel.read({ text: 'https://www.example.test/a-post', depth: 'light' }, { via: 'phone' });
    await e.idle();
    expect(e.intel.extNext('ext-1')).toBeNull();
  });

  it('every tier fails: the best partial read is kept with the most specific reason, and no Claude run is spent', async () => {
    const s = await site({ 'www.reddit.com/oembed': json({ title: 'A synthetic thread', author_name: 'example_redditor' }) });
    const e = await env({ read: { net: seamFor(s.port) } });
    const id = idOf(await e.intel.read({ text: 'https://www.reddit.com/r/example/comments/abc123/a_thread/' }, { via: 'phone' }));
    await e.idle();
    expect(e.items().get(id)).toMatchObject({ title: 'A synthetic thread', creator: 'u/example_redditor', platform: 'reddit', type: 'thread', read: { state: 'failed', reason: INTEL_READ_REASONS.reddit } });
    expect(claudeCalls(e)).toEqual([]);
  });

  it('a link that resolves inside a network is refused, never fetched past the guard', async () => {
    const s = await site({ 'www.example.test/a-post': html(article()) });
    const e = await env({ read: { net: seamFor(s.port, { addrs: { 'www.example.test': ['10.0.0.7'] } }) } });
    const id = idOf(await e.intel.read({ text: 'https://www.example.test/a-post' }, { via: 'cli' }));
    await e.idle();
    expect(e.items().get(id)?.read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.blocked });
    expect(s.seen).toEqual([]);
  });

  it('a failed Read again of a saved item keeps its title and summary (never the page\'s title)', async () => {
    const s = await site({ 'www.example.test/a-post': html(article()) });
    let ok = true;
    const e = await env({
      read: { net: seamFor(s.port) },
      handlers: [(c) => (c.file.endsWith('claude') ? (ok ? { stdout: `${JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(ANSWER) })}\n` } : { code: 1, stderr: 'synthetic failure' }) : undefined)],
    });
    const id = idOf(await e.intel.read({ text: 'https://www.example.test/a-post', depth: 'light' }, { via: 'cli' }));
    await e.idle();
    expect(e.items().get(id)).toMatchObject({ title: ANSWER.title, read: { state: 'saved' } });
    ok = false;
    expect(e.intel.reread(`captures:${id}`, 'light').ok).toBe(true);
    await e.idle();
    expect(e.items().get(id)).toMatchObject({ title: ANSWER.title, what_it_is: ANSWER.summary, tags: ['recipe', 'dal'], read: { state: 'failed', depth: 'light' } });
  });

  it('a failed first read takes the page\'s own title over the pending one', async () => {
    const s = await site({ 'www.example.test/a-post': html(article()) });
    const e = await env({ read: { net: seamFor(s.port) }, handlers: [(c) => (c.file.endsWith('claude') ? { code: 1, stderr: 'synthetic failure' } : undefined)] });
    const id = idOf(await e.intel.read({ text: 'https://www.example.test/a-post', depth: 'light' }, { via: 'cli' }));
    expect(e.items().get(id)?.title).toBe('example.test/a-post');
    await e.idle();
    expect(e.items().get(id)).toMatchObject({ title: 'Example tools, compared', read: { state: 'failed' } });
  });

  it('Full: related pages only from links the user typed in the note, never from the page', async () => {
    const s = await site({
      'www.example.test/a-post': html(article('see https://www.example.test/caption-link too')),
      'www.example.test/pic.jpg': jpeg,
      'www.example.test/related': html('<html><head><title>Related page</title></head><body><article><p>Related synthetic text.</p></article></body></html>'),
      'www.example.test/caption-link': html('<p>never</p>'),
    });
    const seen: ExecCall[] = [];
    const e = await env({ read: { net: seamFor(s.port) }, handlers: [fakeClaude({ ...ANSWER, background: 'From what Claude knows.' }, seen)] });
    const id = idOf(await e.intel.read({ text: 'https://www.example.test/a-post compare with https://www.example.test/related', depth: 'full' }, { via: 'cli' }));
    await e.idle();
    const paths = s.seen.map((x) => x.path);
    expect(paths).toContain('/related');
    expect(paths).not.toContain('/caption-link');
    const sent = stdinOf(seen[0] as ExecCall);
    expect(sent.text).toMatch(/<related_page n="1">[\s\S]*Related synthetic text\.[\s\S]*<\/related_page>/);
    expect(e.items().get(id)).toMatchObject({ background: 'From what Claude knows.', read: { state: 'saved', depth: 'full' } });
  });
});

// ---------------------------------------------------------------- media

describe.skipIf(!HAVE_OPENSSL)('frames, on-screen text, speech and thumbnails (a fake helper)', () => {
  const V = 'AbCdEfGhIjK';
  const WATCH = `<html lang="en"><body><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"${V}","title":"Example video","lengthSeconds":"125","author":"Example Channel","shortDescription":"A synthetic description."}};</script></body></html>`;

  it('YouTube at Standard: its own frames, the cover, OCR on every frame, thumbnails served from the Mac', async () => {
    const s = await site({
      'www.youtube.com/oembed': json({ title: 'Example video', author_name: 'Example Channel' }),
      'www.youtube.com/watch': html(WATCH),
      [`i.ytimg.com/vi/${V}/maxresdefault.jpg`]: jpeg,
      [`i.ytimg.com/vi/${V}/hq1.jpg`]: jpeg,
      [`i.ytimg.com/vi/${V}/hq2.jpg`]: jpeg,
      [`i.ytimg.com/vi/${V}/hq3.jpg`]: jpeg,
    });
    const seen: ExecCall[] = [];
    const clt = realpathSync(e0Dir());
    const e = await env({ read: { net: seamFor(s.port) }, bins: HELPER_BINS, handlers: [fakeClaude(ANSWER, seen), ...fakeHelper(clt)] });
    const id = idOf(await e.intel.read({ text: `https://youtu.be/${V}?si=share` }, { via: 'phone' }));
    await e.idle();
    const line = e.items().get(id) as Record<string, unknown>;
    expect(line).toMatchObject({ url: `https://www.youtube.com/watch?v=${V}`, platform: 'youtube', type: 'video', creator: 'Example Channel', caption: 'A synthetic description.', on_screen: 'LINE 1\nLINE 2\nLINE 3', frames: 4, read: { state: 'saved', done: 'standard', tier: 'download' } });
    // Claude saw the cover and the three frames, each labelled by the daemon.
    const sent = stdinOf(seen[0] as ExecCall);
    expect(sent.images).toBe(4);
    const blocks = (JSON.parse(seen[0]?.opts.input ?? '{}') as { message: { content: { type: string; text?: string }[] } }).message.content;
    expect(blocks.filter((b) => b.type === 'text').map((b) => b.text)).toEqual(expect.arrayContaining(['Cover', expect.stringMatching(/^Frame 1 of 3, at \d+:\d\d$/)]));
    // The helper only ever got files inside the job dir, under sandbox-exec.
    for (const c of e.exec.calls.filter((x) => x.file === '/usr/bin/sandbox-exec')) {
      expect(c.args.join(' ')).not.toContain('https://');
      expect(c.opts.env).toEqual({ PATH: '/usr/bin:/bin', HOME: c.opts.cwd, TMPDIR: `${c.opts.cwd}/tmp/` });
    }
    // Thumbnails: on the Mac, served as JPEGs; the job dir is gone.
    expect(await e.intel.frame(`captures:${id}`, 0)).toEqual(TINY_JPEG);
    expect(await e.intel.frame(`captures:${id}`, 3)).toEqual(TINY_JPEG);
    expect(await e.intel.frame(`captures:${id}`, 4)).toBeNull();
    expect(existsSync(join(e.ctx.paths.intelDir, 'jobs', id))).toBe(false);
    expect(e.intel.get(`captures:${id}`)).toMatchObject({ frames: 4, onScreen: 'LINE 1\nLINE 2\nLINE 3' });
  });

  it('an X video at Full: the mp4 through the guard, frames from the file, OCR on all of them, on-device speech', async () => {
    const id = '1850000000000000000';
    const s = await site({
      'cdn.syndication.twimg.com/tweet-result': json({
        text: 'A synthetic post with a video',
        user: { name: 'Example Person', screen_name: 'example_person' },
        created_at: '2026-10-30T08:00:00.000Z',
        mediaDetails: [{ media_url_https: 'https://pbs.twimg.com/poster.jpg', video_info: { duration_millis: 12_000, variants: [{ content_type: 'video/mp4', bitrate: 832_000, url: 'https://video.twimg.com/vid/640x360/b.mp4' }] } }],
      }),
      'pbs.twimg.com/poster.jpg': jpeg,
      'video.twimg.com/vid/640x360/b.mp4': mp4,
    });
    const seen: ExecCall[] = [];
    const clt = realpathSync(e0Dir());
    const e = await env({ read: { net: seamFor(s.port) }, bins: HELPER_BINS, handlers: [fakeClaude(ANSWER, seen), ...fakeHelper(clt, { duration: 12 })] });
    const rid = idOf(await e.intel.read({ text: `https://x.com/example_person/status/${id}?s=20`, depth: 'full' }, { via: 'phone' }));
    await e.idle();
    const line = e.items().get(rid) as Record<string, unknown>;
    expect(line).toMatchObject({ platform: 'x', creator: 'Example Person', transcript: '[0:01] hello from a synthetic voice', frames: 7, read: { state: 'saved', depth: 'full', done: 'full', tier: 'download' } });
    const ocr = e.exec.calls.find((c) => c.args.includes('ocr')) as ExecCall;
    expect(ocr.args.slice(ocr.args.indexOf('ocr') + 1)).toHaveLength(6);
    const speech = e.exec.calls.find((c) => c.args.includes('speech')) as ExecCall;
    expect(speech.args.slice(-2)).toEqual(['en-IN', String(INTEL_READ_LIMITS.speechMaxSec)]);
    const sent = stdinOf(seen[0] as ExecCall);
    expect(sent.images).toBe(7);
    expect(sent.text).toContain('<transcript>');
    expect(sent.text).toMatch(/<item>[\s\S]*12[\s\S]*<\/item>/);
    const audit = e.ctx.db.audit.list().find((a) => a.action === 'intel.read');
    expect(audit?.params).toMatchObject({ depth: 'full', done: 'full', tier: 'download', frames: 7, transcriptChars: '[0:01] hello from a synthetic voice'.length });
    expect(JSON.stringify(e.ctx.log.records)).not.toContain('synthetic voice');
  });

  /** Where the pretend Command Line Tools live (removed after each test). */
  function e0Dir(): string {
    const d = mkdtempSync(join(tmpdir(), 'jantar-clt-'));
    clts.push(d);
    return d;
  }
});

// ---------------------------------------------------------------- Retry, Delete, the hard stop

describe('Retry, Delete and the hard stop', () => {
  it('Claude\'s answer unreadable: failed with Retry; Retry while it runs is refused; then saved', async () => {
    let answer: unknown = 'not json at all';
    const e = await env({ handlers: [(c) => (c.file.endsWith('claude') ? { stdout: `${JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: typeof answer === 'string' ? answer : JSON.stringify(answer) })}\n` } : undefined)] });
    const id = idOf(await e.intel.read({ text: 'A synthetic note to read' }, { via: 'cli' }));
    await e.idle();
    expect(e.items().get(id)?.read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.unreadable });
    answer = ANSWER;
    expect(e.intel.reread(`captures:${id}`, 'light')).toEqual({ ok: true, value: { id: `captures:${id}` } });
    expect(e.intel.reread(`captures:${id}`, 'light')).toMatchObject({ ok: false, code: 'conflict', reason: READ_SENTENCES.busy });
    await e.idle();
    expect(e.items().get(id)).toMatchObject({ title: ANSWER.title, depth: 'light', read: { state: 'saved', depth: 'light' } });
  });

  it('Retry and Delete only for this Mac\'s own items', async () => {
    const e = await env();
    expect(e.intel.reread('bot:abc', undefined)).toMatchObject({ ok: false, code: 'forbidden', reason: READ_SENTENCES.notCaptures });
    expect(await e.intel.remove('bot:abc')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(e.intel.reread('captures:01JC0000000000000000000000', undefined)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('Delete cancels the running job, writes nothing more for it, and removes its thumbnails', async () => {
    const started = { n: 0 };
    const e = await env({ handlers: [hangingClaude(started)] });
    const id = idOf(await e.intel.read({ text: 'A synthetic note to delete' }, { via: 'cli' }));
    await until(() => started.n === 1, 5_000, 'the job to reach claude');
    const media = join(e.ctx.paths.intelDir, 'media', id);
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, '0.jpg'), TINY_JPEG);
    expect(await e.intel.remove(`captures:${id}`)).toEqual({ ok: true, value: true });
    await e.idle();
    expect(readFileSync(e.file, 'utf8')).not.toContain(id);
    expect(existsSync(media)).toBe(false);
    expect(e.intel.get(`captures:${id}`)).toBeNull();
    expect(e.intel.jobs().jobs).toEqual([]);
  });

  it('the hard stop: past 8 minutes the job ends failed "The read took too long."', async () => {
    const started = { n: 0 };
    const e = await env({ handlers: [hangingClaude(started)] });
    const id = idOf(await e.intel.read({ text: 'A synthetic note that never ends' }, { via: 'cli' }));
    await until(() => started.n === 1, 5_000, 'the job to reach claude');
    e.ctx.clock.advance(INTEL_READ_LIMITS.jobMs);
    const jobs = await e.idle();
    expect(jobs[0]).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.tooLong });
    expect(e.items().get(id)?.read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.tooLong });
  });

  it('one job at a time, oldest first', async () => {
    const started = { n: 0 };
    const e = await env({ handlers: [hangingClaude(started)] });
    const ids = [];
    for (const t of ['first synthetic', 'second synthetic', 'third synthetic']) ids.push(idOf(await e.intel.read({ text: t }, { via: 'cli' })));
    await until(() => started.n === 1, 5_000, 'the first job');
    expect(e.intel.queue.counts()).toEqual({ waiting: 2, running: 1 });
    expect(e.intel.jobs().jobs.map((j) => j.id)).toEqual(ids.map((i) => `captures:${i}`));
    expect(e.intel.jobs().jobs.map((j) => j.state)).toEqual(['summarising', 'queued', 'queued']);
  });
});
