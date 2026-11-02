/**
 * v0.8 Intel reads links, end to end (spec 17, lane C): jantard in-process
 * on a synthetic HOME (harness.ts), `jantar` on the real ctl.sock, a paired
 * phone, a stand-in for the paired Chrome extension, the public web as one
 * local HTTPS server (read-net.ts: a throwaway certificate, Intel's net seam,
 * playwright-core's own Chromium for the headless tier through the daemon's
 * CONNECT proxy), the fake claude's stream-json read, the fake yt-dlp, and
 * the media helper's tools as the fixtures' fakes (the daemon builds,
 * keys and runs its helper as on a Mac; nothing compiles Swift). Every page,
 * creator and link is synthetic; nothing reaches the network.
 *
 * 1. Off: the phone is told the command; `jantar intel read on` turns it on
 *    and builds the helper once.
 * 2. The phone saves an article at Standard: on the shelf at once (found by
 *    its link), then read in the headless browser through the proxy: a
 *    thumbnail, the on-screen text, Claude's title and summary; found by a
 *    word of the page and of the screen; the same link again is "Already
 *    saved."
 * 3. `jantar intel save` of an Instagram reel (a share link) at Light, read
 *    in the user's Chrome: the extension is handed the post's URL rebuilt
 *    on the www host, never the link as typed, and its read is the item.
 * 4. A reel at Standard that Chrome can't read (login): the headless
 *    browser reads the page (never the signed-in name around the post), the
 *    post's video file 404s, so yt-dlp's single file gives the frames.
 * 5. Ask: "save this: <link>" is one save card at once, no Claude run; Add
 *    saves and reads it.
 * 6. The Shortcut's door (G13) in each remote.mode: 404 in loopback and
 *    lan, open in tailscale and cloudflare with a key made at the Mac;
 *    Origin 403, no key 401; the same sentence for a new link, a duplicate
 *    and reading off; 404 with Intel off.
 * 7. A link that is not found is failed with its plain reason; Retry reads
 *    it once the page is back; Read again at Light.
 * 8. Delete: gone from the shelf, its text gone from captures.jsonl (the
 *    compaction) and its thumbnails gone.
 * 9. A restart while a read hangs: the item is failed "Stopped before it
 *    finished. Retry." and nothing reads it again.
 * 10. `jantar mcp` (its server in-process, from source, on ctl.sock):
 *    intel_search finds a read item by a word of its page, with its
 *    platform and creator; intel_get labels what was read as page text.
 * 11. The sweep (G12): POST_MARKER (in a link, a page, Chrome's read, the
 *    on-screen text and a note) and the Shortcut key reach no log line,
 *    audit row, event, error sentence or file outside intel/.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { POST_MARKER, POST_PAGES, SIGNED_IN_MARKER, TINY_JPEG_DATA_URL, perfBudgetMs, writeFakeYtDlp } from '@jantar/fixtures';
import {
  CAPTURE_KEY_HEADER,
  CAPTURE_SAVED_SENTENCE,
  DEVICE_COOKIE,
  EXTENSION_ID,
  EXTENSION_KEY_HEADER,
  INTEL_READ_REASONS,
  type AskList,
  type ExtPairStartReply,
  type ExtReadNextReply,
  type IntelItem,
  type IntelJob,
  type IntelJobsResponse,
  type IntelListResponse,
  type IntelReadReply,
  type IntelReadStatus,
  type PairStartResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { MCP_SAYS, createMcpServer } from '../../packages/cli/src/commands/mcp.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';
import { browserSeam, netReady, netSeam, serveSites, type Answer, type BrowserSeen, type Sites } from './read-net.js';

const ready = netReady('v08-intel-read');
/** playwright-core's own Chromium for the headless tier; without it that tier can't start and the download reads. */
const CHROMIUM = (() => {
  try {
    const p = chromium.executablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();
if (ready && !CHROMIUM) console.warn('[v08-intel-read] no Chromium for playwright-core: the headless tier is passed over');
const PAGE_TIER = CHROMIUM ? 'browser' : 'download';

const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const PUBLIC = 'https://jantar.example.com';
const PUBLIC_HOST = 'jantar.example.com';
const JPEG = Buffer.from(TINY_JPEG_DATA_URL.split(',')[1] ?? '', 'base64');

const ARTICLE = 'https://www.example.com/articles/dal-at-home';
const ARTICLE_WORDS = 'Soak the lentils overnight, then pressure cook them with turmeric and a pinch of hing.';
const GARDEN = 'https://www.example.com/articles/garden-notes';
const LATER = 'https://www.example.com/articles/coming-soon';
const LATER_WORDS = 'Compost bins fill faster in the monsoon than anyone expects.';
const SLOW = 'https://www.example.com/articles/never-loads';
const SHORTCUT_LINK = 'https://www.example.com/articles/from-the-share-sheet';
const REEL = POST_PAGES.instagram.url;
const REEL_SHARED = 'https://instagram.com/reel/AbC123xyz/?igsh=c3ludGhldGlj';
const REEL_TWO = 'https://www.instagram.com/reel/Zz9Yy8Xx7/';

const articleHtml = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta property="og:title" content="${title}">` +
  '<meta property="og:image" content="https://www.example.com/img/cover.jpg">' +
  '<meta name="author" content="Example Cook">' +
  `</head><body><nav>Home Recipes</nav><article><h1>${title}</h1><p>${body}</p>` +
  '<p>This synthetic article goes on for long enough to count as a real read of a web page, with a second paragraph about rice, ghee and cumin seeds.</p></article></body></html>';

const html = (body: string): Answer => ({ type: 'text/html; charset=utf-8', body });
const jpeg = (): Answer => ({ type: 'image/jpeg', body: JPEG });

// The headless browser keeps Chrome's sandbox (chromiumSandbox: true). Ubuntu 23.10+ CI refuses the user
// namespaces that sandbox needs, so the read falls to the downloader there. Intel reading runs on the Mac
// only (servers don't read Intel), so the browser-tier cases run on the macOS job.
const browserTier = process.platform === 'darwin';

describe.skipIf(!ready)('v0.8 Intel reads links through jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let sites: Sites;
  let phone = '';
  let extKey = '';
  let shortcutKey = '';
  let laterBack = false;
  const browser: BrowserSeen = { launches: [], contexts: [], requests: [] };
  /** Every reply to a write (phone, ctl.sock, the extension, the door), kept for the sweep. */
  const writes: Array<{ what: string; text: string }> = [];
  /** Items made, by name. */
  const ids: Record<string, string> = {};

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error' || /intel/.test(r.msg))
      .slice(-30)
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
    expect(r.status, `${method} ${path}: ${r.text}\n${dumpLog()}`).toBeLessThan(300);
    return r.body as T;
  }

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    writes.push({ what: `jantar ${argv[0]} ${argv[1] ?? ''}`, text: `${io.stdout}\n${io.stderr}` });
    return { code, out: io.stdout, err: io.stderr };
  }

  async function run(...argv: string[]): Promise<string> {
    const r = await cli(...argv);
    expect(r.code, `jantar ${argv.join(' ')}: ${r.err}\n${dumpLog()}`).toBe(0);
    return r.out;
  }

  /** The extension's own calls: its key, and its Origin on a write. */
  const ext = (method: string, path: string, body?: unknown) =>
    http(d.port, method, path, { origin: method === 'POST' ? EXT_ORIGIN : null, headers: { [EXTENSION_KEY_HEADER]: extKey }, ...(body === undefined ? {} : { body }) });

  /** The Shortcut's call through the public door. */
  const door = (body: unknown, headers: Record<string, string> = {}) =>
    http(d.port, 'POST', '/v1/capture/save', { origin: null, body, headers: { host: PUBLIC_HOST, [CAPTURE_KEY_HEADER]: shortcutKey, ...headers } });

  const item = async (id: string) => (await ok<{ item: IntelItem }>('GET', `/v1/intel/items/${encodeURIComponent(id)}`)).item;
  const search = async (q: string) => (await ok<IntelListResponse>('GET', `/v1/intel?q=${encodeURIComponent(q)}`)).items.map((i) => i.id);
  const jobs = async () => ok<IntelJobsResponse>('GET', '/v1/intel/jobs');

  /** The read job for `id` once it is saved or failed (ended after `since`, for a later read of the same item). */
  async function finished(id: string, what: string, since = ''): Promise<IntelJob> {
    try {
      return await eventually(
        async () => (await jobs()).jobs.find((j) => j.id === id && (j.state === 'saved' || j.state === 'failed') && (j.endedAt ?? '') > since),
        90_000,
        what,
      );
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${JSON.stringify((await call('GET', '/v1/intel/jobs')).body)}\n${dumpLog()}`);
    }
  }

  /** What the extension is handed when it asks (null: nothing waiting). */
  const asks = async () => {
    const r = await ext('GET', '/v1/ext/reads/next');
    expect(r.status, r.text).toBe(200);
    return (r.body as ExtReadNextReply).job;
  };
  /** The next post the daemon hands Chrome. */
  const leased = () => eventually(asks, 30_000, 'a post for Chrome') as Promise<NonNullable<ExtReadNextReply['job']>>;

  beforeAll(async () => {
    sites = await serveSites((host, path) => {
      const at = `${host}${path.split('?')[0]}`;
      if (at === 'www.example.com/articles/dal-at-home') return html(articleHtml('Dal at home, three ways', `${ARTICLE_WORDS} ${POST_MARKER}`));
      if (at === 'www.example.com/articles/garden-notes') return html(articleHtml('Garden notes for a small balcony', 'Tomatoes want six hours of sun and a deep pot; basil grows beside them.'));
      if (at === 'www.example.com/articles/from-the-share-sheet') return html(articleHtml('Saved from the share sheet', 'A synthetic page shared from a phone, about folding bicycles and short commutes.'));
      if (at === 'www.example.com/articles/coming-soon') return laterBack ? html(articleHtml('Compost in the monsoon', LATER_WORDS)) : undefined;
      if (at === 'www.example.com/articles/never-loads') return { hold: true };
      if (/^www\.example\.com\/img\/\w+\.jpg$/.test(at)) return jpeg();
      if (at === 'www.instagram.com/reel/AbC123xyz/' || at === 'www.instagram.com/reel/Zz9Yy8Xx7/') return html(POST_PAGES.instagram.html);
      // The post's pictures load; its video file does not (the reader then hands the post to yt-dlp).
      if (host === 'scontent.cdninstagram.com' && path.split('?')[0]?.endsWith('.jpg')) return jpeg();
      return undefined;
    });
    d = await bootDaemon({
      home: { sessions: [] },
      fakeMediaTools: true,
      intel: { net: netSeam(sites), browser: browserSeam(CHROMIUM, browser) },
      before: async (home) => {
        await writeFakeYtDlp(home.root, join(home.root, 'yt-dlp-bin'));
        // What the fake helper reads on screen: the marker too, to prove it stays inside intel/.
        await mkdir(join(home.root, 'fake'), { recursive: true });
        await writeFile(join(home.root, 'fake', 'jantar-media.json'), JSON.stringify({ ocr: [`SCREEN TEXT ${POST_MARKER}`, 'Pressure cooker whistle count'] }));
      },
      // yt-dlp named outright: the fake home's PATH must never find a real one.
      settings: (home) => ({ intel: { enabled: true }, bins: { ytDlp: join(home.root, 'yt-dlp-bin', 'yt-dlp') } }),
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'reads phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'reads phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
    await sites?.close();
  }, perfBudgetMs(30_000));

  it('1. off, the phone is told the command; jantar intel read on turns it on and builds the helper once', async () => {
    const off = await call('POST', '/v1/intel/reads', { text: ARTICLE });
    expect(off.status).toBe(403);
    expect((off.body as { error: { message: string } }).error.message).toBe(INTEL_READ_REASONS.off);
    await run('intel', 'read', 'on');
    const helper = join(d.ctx.paths.intelDir, 'bin', 'jantar-media');
    await eventually(async () => existsSync(`${helper}.key`), 30_000, 'the helper built by the fake swiftc');
    const status = await callDaemon<IntelReadStatus>(ctl, 'GET', '/v1/intel/read/status');
    expect(status).toMatchObject({ on: true, canRun: true, clt: { found: true }, helper: { built: true }, ytdlp: { found: true } });
    const builds = (await readFile(join(d.home.root, 'calls', 'swiftc.jsonl'), 'utf8')).split('\n').filter((l) => l.includes('"-o"'));
    expect(builds).toHaveLength(1);
  });

  it.skipIf(!browserTier)('2. the phone saves an article at Standard: on the shelf at once, read in the headless browser, found by its words and its screen text', async () => {
    const saved = await ok<IntelReadReply>('POST', '/v1/intel/reads', { text: `${ARTICLE}?utm_source=share&ref=feed&id=${POST_MARKER} for the weekend ${POST_MARKER}`, depth: 'standard' });
    expect(saved).toMatchObject({ duplicate: false, queued: true, message: 'Saved. Reading it on your Mac.' });
    ids.article = saved.id;
    // On the shelf at once, by its link, before the read ends.
    expect(await search('dal-at-home')).toContain(saved.id);

    const job = await finished(saved.id, 'the article read');
    expect(job, dumpLog()).toMatchObject({ state: 'saved', platform: 'web', depth: 'standard', tier: PAGE_TIER });
    const got = await item(saved.id);
    expect(got).toMatchObject({
      url: `${ARTICLE}?id=${POST_MARKER}`,
      platform: 'web',
      creator: 'Example Cook',
      depth: 'standard',
      note: `for the weekend ${POST_MARKER}`,
      read: { state: 'saved', depth: 'standard', done: 'standard', tier: PAGE_TIER },
    });
    // Claude's answer (the fake: the caption's first words; how many pictures it was shown).
    expect(got.title).toMatch(/^Dal at home, three ways/);
    expect(got.summary).toMatch(/^Shown \d+ pictures?\./);
    expect(got.caption).toContain(ARTICLE_WORDS);
    expect(got.onScreen).toContain('Pressure cooker whistle count');
    expect(got.frames).toBeGreaterThanOrEqual(1);
    // The thumbnails, numbered from 0; past the last, none.
    const thumb = await http(d.port, 'GET', `/v1/intel/items/${encodeURIComponent(saved.id)}/frames/0`, { cookie: phone });
    expect(thumb.status, thumb.text).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    expect((await http(d.port, 'GET', `/v1/intel/items/${encodeURIComponent(saved.id)}/frames/${got.frames ?? 0}`, { cookie: phone })).status).toBe(404);

    // Found by a word of the page and a word read off the screen.
    expect(await search('turmeric')).toContain(saved.id);
    expect(await search('whistle')).toContain(saved.id);
    // The same link again (another share's tracking) is already there: nothing written.
    expect(await ok<IntelReadReply>('POST', '/v1/intel/reads', { text: `${ARTICLE}?id=${POST_MARKER}&utm_medium=social` })).toMatchObject({ id: saved.id, duplicate: true, queued: false, message: 'Already saved.' });

    if (CHROMIUM) {
      // The headless tier: the daemon's options, its page through the daemon's proxy to the stand-in server.
      expect(browser.launches.at(-1)).toMatchObject({ headless: true, proxy: { server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) } });
      expect(browser.launches.at(-1)).not.toHaveProperty('channel');
      expect(browser.contexts.at(-1)).toEqual({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 } });
      expect(browser.requests.some((r) => r.startsWith(`${ARTICLE}?id=`) && r.endsWith(' 200'))).toBe(true);
    }
  });

  it('3. jantar intel save of a shared Instagram link at Light: Chrome is handed the post rebuilt on the www host, and its read is the item', async () => {
    const code = (await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start')).code;
    const paired = await http(d.port, 'POST', '/v1/ext/pair', { body: { code }, origin: EXT_ORIGIN });
    expect(paired.status, paired.text).toBe(200);
    extKey = (paired.body as { key: string }).key;
    // Read saved links on: the extension asks, and there is nothing yet.
    expect(await asks()).toBeNull();

    const out = await run('intel', 'save', REEL_SHARED, '--depth', 'light');
    expect(out).toContain('Saved');
    const job = await leased();
    expect(job).toMatchObject({ url: REEL, platform: 'instagram', frames: 0 });
    const caption = `${POST_PAGES.instagram.caption} ${POST_MARKER}`;
    const posted = await ext('POST', `/v1/ext/reads/${job.id}`, {
      ok: true,
      page: { finalUrl: REEL, title: 'Example Cook on Instagram', meta: [], jsonld: [], text: caption, author: 'example_cook', media: [], frames: [] },
    });
    writes.push({ what: 'POST /v1/ext/reads/:id', text: posted.text });
    expect(posted.status, posted.text).toBe(200);

    const id = (await search('AbC123xyz'))[0] as string;
    ids.reel = id;
    expect((await finished(id, 'the reel read in Chrome')).tier).toBe('chrome');
    const got = await item(id);
    expect(got).toMatchObject({ url: REEL, platform: 'instagram', type: 'reel', depth: 'light', read: { state: 'saved', tier: 'chrome', done: 'light' } });
    expect(got.creator).toContain('example_cook');
    expect(got.caption).toContain(POST_PAGES.instagram.caption);
    expect(await search('pressure cook')).toContain(id);
  });

  it.skipIf(!browserTier)("4. a reel Chrome can't read (login): the headless browser reads the post, its video 404s, yt-dlp's single file gives the frames", async () => {
    const saved = await ok<IntelReadReply>('POST', '/v1/intel/reads', { text: REEL_TWO, depth: 'standard' });
    ids.reelTwo = saved.id;
    const job = await leased();
    expect(job).toMatchObject({ url: REEL_TWO, platform: 'instagram', frames: 4 });
    expect((await ext('POST', `/v1/ext/reads/${job.id}`, { ok: false, why: 'login' })).status).toBe(200);

    const done = await finished(saved.id, 'the reel read past Chrome');
    expect(done.state, dumpLog()).toBe('saved');
    const got = await item(saved.id);
    expect(got.caption).toContain(POST_PAGES.instagram.caption);
    expect(JSON.stringify(got)).not.toContain(SIGNED_IN_MARKER);
    expect(got.frames).toBeGreaterThanOrEqual(1);
    // yt-dlp: the platform's own extractor, one single-file format, through the daemon's proxy, no cookies.
    const calls = (await readFile(join(d.home.root, 'calls', 'yt-dlp.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { args: string[] }).args);
    const video = calls.find((a) => a.includes('-f'));
    expect(video, JSON.stringify(calls)).toBeDefined();
    expect(video).toEqual(expect.arrayContaining(['--ignore-config', '--no-cookies', '--no-cookies-from-browser', '--use-extractors', 'Instagram', '--no-playlist']));
    expect(video?.[(video?.indexOf('--proxy') ?? -2) + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(video?.[(video?.indexOf('-f') ?? -2) + 1]).not.toContain('+');
    expect(video?.at(-1)).toBe(REEL_TWO);
    for (const a of calls) expect(a.join(' ')).not.toMatch(/ffmpeg|--cookies |--cookies-from-browser |--exec/);
  });

  it('5. Ask: "save this: <link>" is one save card at once, no Claude run; Add saves and reads it', async () => {
    await run('ask', 'on');
    await run('life', 'on', 'todos');
    const claudeRuns = async () => (await readFile(join(d.home.root, 'calls', 'claude.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const before = await claudeRuns();
    await ok('POST', '/v1/ask', { text: `save this: ${GARDEN}` });
    const turn = (await ok<AskList>('GET', '/v1/ask')).turns.at(-1);
    expect(turn).toMatchObject({ state: 'done', reply: 'Save this to Intel?', cards: [{ state: 'proposed', action: { type: 'save' } }] });
    expect(await claudeRuns()).toBe(before);
    await ok('POST', `/v1/ask/turns/${turn?.id}/actions/0`, {});
    const added = (await ok<AskList>('GET', '/v1/ask')).turns.at(-1)?.cards[0];
    expect(added).toMatchObject({ state: 'added' });
    const id = added?.ref as string;
    ids.garden = id;
    expect((await finished(id, 'the Ask save read')).state).toBe('saved');
    expect(await item(id)).toMatchObject({ url: GARDEN, fields: expect.arrayContaining([{ key: 'via', value: 'ask' }]) });
  });

  it('6. the Shortcut door (G13): 404 in loopback and lan, open in tailscale and cloudflare; Origin 403, no key 401; one sentence always; 404 with Intel off', async () => {
    const made = await run('intel', 'shortcut', 'add', '--name', 'iPhone');
    shortcutKey = /\b(jcap_[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(made)?.[1] ?? '';
    expect(shortcutKey).not.toBe('');
    expect(made).toContain('The door is closed');

    for (const mode of ['loopback', 'lan'] as const) {
      await d.ctx.settings.patch({ remote: { mode } });
      const res = await door({ text: SHORTCUT_LINK }, mode === 'loopback' ? { host: `127.0.0.1:${d.port}` } : {});
      expect(res.status, `${mode}: ${res.text}`).toBe(404);
      expect(res.text).not.toContain(CAPTURE_SAVED_SENTENCE);
    }

    const replies: string[] = [];
    for (const mode of ['tailscale', 'cloudflare'] as const) {
      await d.ctx.settings.patch({ remote: { mode, publicUrl: PUBLIC } });
      const res = await door({ text: `${SHORTCUT_LINK} shared from the ${mode} door`, depth: 'light' });
      expect(res.status, `${mode}: ${res.text}`).toBe(202);
      replies.push(res.text);
      expect((await door({ text: SHORTCUT_LINK }, { origin: PUBLIC })).status).toBe(403);
      expect((await door({ text: SHORTCUT_LINK }, { [CAPTURE_KEY_HEADER]: '' })).status).toBe(401);
      expect((await door({ text: SHORTCUT_LINK }, { [CAPTURE_KEY_HEADER]: `jcap_${'B'.repeat(43)}` })).status).toBe(401);
    }
    // A new link (tailscale), then the same link (cloudflare: a duplicate): byte-identical.
    expect(replies[0]).toBe(JSON.stringify({ message: CAPTURE_SAVED_SENTENCE }));
    expect(replies[1]).toBe(replies[0]);
    const id = (await search('from-the-share-sheet'))[0] as string;
    ids.shortcut = id;
    expect((await finished(id, 'the Shortcut save read')).state).toBe('saved');
    expect((await item(id)).fields).toEqual(expect.arrayContaining([{ key: 'via', value: 'shortcut' }]));

    // Reading off: the same sentence, the link kept as a plain capture.
    await run('intel', 'read', 'off');
    const offReply = await door({ url: 'https://www.example.com/articles/read-later' });
    expect(offReply.status).toBe(202);
    expect(offReply.text).toBe(replies[0]);
    expect(await search('read-later')).toHaveLength(1);
    await run('intel', 'read', 'on');

    // Intel off: no door at all.
    await d.ctx.settings.patch({ intel: { enabled: false } });
    expect((await door({ text: SHORTCUT_LINK })).status).toBe(404);
    await d.ctx.settings.patch({ intel: { enabled: true } });
    await d.ctx.settings.patch({ remote: { mode: 'loopback', publicUrl: null } });
    for (const r of replies) writes.push({ what: 'POST /v1/capture/save', text: r });
  });

  it('7. not found is failed with its plain reason; Retry reads it once the page is back; Read again at Light', async () => {
    const saved = await ok<IntelReadReply>('POST', '/v1/intel/reads', { text: LATER });
    ids.later = saved.id;
    const failed = await finished(saved.id, 'the read of a missing page');
    expect(failed).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.notFound });
    expect((await item(saved.id)).read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.notFound });

    laterBack = true;
    expect(await ok<{ id: string }>('POST', `/v1/intel/items/${encodeURIComponent(saved.id)}/read`, {})).toEqual({ id: saved.id });
    const retried = await finished(saved.id, 'the retry', failed.endedAt);
    expect(retried.state, dumpLog()).toBe('saved');
    expect((await item(saved.id)).caption).toContain(LATER_WORDS);

    await ok('POST', `/v1/intel/items/${encodeURIComponent(saved.id)}/read`, { depth: 'light' });
    const again = await finished(saved.id, 'the read again at Light', retried.endedAt);
    expect(again).toMatchObject({ state: 'saved', depth: 'light' });
    expect((await item(saved.id)).read).toMatchObject({ state: 'saved', depth: 'light' });
  });

  it('8. Delete: gone from the shelf, its words gone from captures.jsonl, its thumbnails gone', async () => {
    const id = ids.later as string;
    const rid = id.slice('captures:'.length);
    const captures = join(d.ctx.paths.intelDir, 'captures.jsonl');
    expect(await readFile(captures, 'utf8')).toContain(LATER_WORDS);
    await ok('DELETE', `/v1/intel/items/${encodeURIComponent(id)}`);
    expect((await call('GET', `/v1/intel/items/${encodeURIComponent(id)}`)).status).toBe(404);
    expect(await search('compost')).not.toContain(id);
    const file = await readFile(captures, 'utf8');
    expect(file).not.toContain(LATER_WORDS);
    expect(file).not.toContain(rid);
    expect(existsSync(join(d.ctx.paths.intelDir, 'media', rid))).toBe(false);
    // The others are still there (the article exists where test 2 runs: the macOS job).
    if (ids.article) expect(await search('turmeric')).toContain(ids.article);
  });

  it('9. a restart while a read hangs: failed "Stopped before it finished. Retry." and nothing reads it again', async () => {
    const saved = await ok<IntelReadReply>('POST', '/v1/intel/reads', { text: SLOW, depth: 'light' });
    await eventually(async () => sites.asked('www.example.com/articles/never-loads') > 0, 30_000, 'the hanging page asked for');
    await d.restart();
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket after the restart');
    const asked = sites.asked('www.example.com/articles/never-loads');
    expect((await item(saved.id)).read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.stopped });
    await new Promise((r) => setTimeout(r, 2_000));
    expect(sites.asked('www.example.com/articles/never-loads')).toBe(asked);
    expect((await jobs()).jobs.filter((j) => j.state !== 'saved' && j.state !== 'failed')).toEqual([]);
  });

  it.skipIf(!browserTier)('10. jantar mcp: intel_search finds a read item by a word of its page; intel_get labels what was read as page text', async () => {
    const mcp = createMcpServer({ ctl, folder: null, randomId: () => randomUUID() });
    let n = 0;
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const lines = await mcp.onLine(JSON.stringify({ jsonrpc: '2.0', id: (n += 1), method, params }));
      return JSON.parse(lines[0] ?? 'null') as { result?: { content?: { text: string }[]; isError?: boolean } };
    };
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await rpc('tools/call', { name, arguments: args });
      expect(r.result?.isError, JSON.stringify(r)).toBeFalsy();
      return JSON.parse(r.result?.content?.[0]?.text ?? 'null') as Record<string, unknown>;
    };
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'example-client', version: '1.0.0' } });
    const found = await tool('intel_search', { query: 'turmeric' });
    expect(found.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: ids.article, platform: 'web', creator: 'Example Cook' })]));
    const full = await tool('intel_get', { id: ids.article });
    expect(full).toMatchObject({ depth: 'standard', read: { state: 'saved' }, from_the_page: { label: MCP_SAYS.pageText, platform: 'web', creator: 'Example Cook' } });
    const page = full.from_the_page as { caption: string; on_screen: string };
    expect(page.caption).toContain(ARTICLE_WORDS);
    expect(page.on_screen).toContain('Pressure cooker whistle count');
    const reel = await tool('intel_get', { id: ids.reel });
    expect(reel).toMatchObject({ type: 'reel', from_the_page: { platform: 'instagram' } });
  });

  it('11. the sweep (G12): the marker and the Shortcut key reach no log line, audit row, event, reply or file outside intel/', async () => {
    const replay = d.ctx.store.replay(0);
    const sources: Record<string, string> = {
      'event ring': JSON.stringify(replay.kind === 'events' ? replay.events : []),
      'stored events': JSON.stringify(d.ctx.db.events.since(0)),
      'audit rows': JSON.stringify(d.ctx.db.audit.list({ after: 0, limit: 100_000 })),
      'log lines': JSON.stringify(d.log.records),
      // `jantar intel shortcut add` shows the key once, on purpose; every other reply never.
      'write replies': JSON.stringify(writes.filter((w) => !w.what.startsWith('jantar intel shortcut'))),
      pushes: JSON.stringify(d.webPushes),
    };
    for (const [what, text] of Object.entries(sources)) {
      expect(text.includes(POST_MARKER), what).toBe(false);
      expect(text.includes(shortcutKey), what).toBe(false);
    }
    // Every file the daemon keeps outside intel/ (the database and its journal, settings, keys, logs).
    const outside: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (p === d.ctx.paths.intelDir) continue;
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && (await stat(p)).size < 64 * 1024 * 1024) {
          const bytes = await readFile(p);
          if (bytes.includes(POST_MARKER) || bytes.includes(shortcutKey)) outside.push(relative(d.home.jantarHome, p));
        }
      }
    };
    await walk(d.home.jantarHome);
    expect(outside).toEqual([]);
    // Inside intel/ the items keep what was read.
    expect(await readFile(join(d.ctx.paths.intelDir, 'captures.jsonl'), 'utf8')).toContain(POST_MARKER);
  });
});
