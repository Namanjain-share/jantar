/// <reference lib="dom" />
/**
 * v0.8 Add post, the user's own flow end to end: "I send an Instagram reel,
 * it is read and saved, and later I search Intel and it finds me that reel."
 *
 * jantard in-process on a synthetic HOME (harness.ts), the BUILT web app in
 * a real headless Chromium at 390 px as the phone (paired the way a phone
 * pairs), the test standing in for the paired Chrome extension, the public
 * web as one local HTTPS server (read-net.ts: Instagram's page and its CDN,
 * every value synthetic), the headless tier in playwright-core's own
 * Chromium through the daemon's CONNECT proxy, and the fake claude's
 * stream-json read. Nothing reaches the network.
 *
 * 1. The phone: Intel, Add, a shared reel link, Standard (the default),
 *    Save: "Saved. Reading it on your Mac."
 * 2. The Mac reads it in the user's Chrome first: the extension is handed
 *    the post rebuilt on the www host while the phone's Reading strip says
 *    "Opening in Chrome"; it answers that the post needs a login.
 * 3. So the headless browser reads the post (playwright-core, no login),
 *    the reel's own video file is fetched through the guard, cookie-less,
 *    and the media helper takes its frames and reads the words on them;
 *    yt-dlp is never needed.
 * 4. Claude (the fake) is shown the frames and the cover and writes the
 *    title and summary; the item is saved, and the strip names the job by
 *    the read's title.
 * 5. The phone searches a caption word, then a word that is only in the
 *    video's frames: both find the reel. Its page shows its pictures, and
 *    Open original is the reel's own link (a new tab, no opener), which
 *    opens the original post.
 *
 * The media helper: with JANTAR_REAL_MEDIA=1 on a Mac with Command Line
 * Tools and sandbox-exec, the daemon builds the real `jantar-media` from
 * its Swift source and runs it under its sandbox profile on a synthetic
 * reel made here with AVFoundation (make-reel.swift: two scenes whose words
 * are drawn on the frames; no ffmpeg); the words found are what Apple's
 * Vision reads off those frames. That compiles Swift twice (about two
 * minutes), so by default the fixtures' fake helper stands in (it answers
 * the same words) and the suite says why.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { POST_PAGES, TINY_JPEG_DATA_URL, captureBody, perfBudgetMs, writeFakeYtDlp } from '@jantar/fixtures';
import {
  DEVICE_COOKIE,
  EXTENSION_ID,
  EXTENSION_KEY_HEADER,
  type ExtPairStartReply,
  type ExtReadNextReply,
  type IntelItem,
  type IntelJob,
  type IntelJobsResponse,
  type IntelListResponse,
  type PairStartResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { PHONE, browserReady, clean, watchConsole, type Watch } from './browser.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';
import { browserSeam, netReady, netSeam, serveSites, type Answer, type BrowserSeen, type Sites } from './read-net.js';

const run = promisify(execFile);
const SUITE = 'v08-reel-flow';
const ready = netReady(SUITE) && (await browserReady(SUITE));

/** playwright-core's own Chromium, for the headless tier (browser.ts has already checked it starts). */
const CHROMIUM = (() => {
  try {
    const p = chromium.executablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

/** Why the real media helper can't run here, or null. */
async function realMediaGap(): Promise<string | null> {
  if (process.env.JANTAR_REAL_MEDIA !== '1') return 'JANTAR_REAL_MEDIA=1 builds and runs the real Swift helper (about two minutes of compiling)';
  if (process.platform !== 'darwin') return 'the real helper needs macOS';
  if (!existsSync('/usr/bin/sandbox-exec')) return 'this Mac has no /usr/bin/sandbox-exec';
  try {
    await run('/usr/bin/xcode-select', ['-p']);
  } catch {
    return "this Mac has no Command Line Tools (xcode-select -p fails)";
  }
  return null;
}
const gap = ready ? await realMediaGap() : 'skipped';
const REAL = gap === null;
if (ready && !REAL) console.warn(`[${SUITE}] frames come from the fixtures' fake media helper: ${gap}`);

const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const REEL = POST_PAGES.instagram.url;
const REEL_SHARED = 'https://instagram.com/reel/AbC123xyz/?igsh=c3ludGhldGlj';
const VIDEO_AT = 'scontent.cdninstagram.com/v/synthetic/reel.mp4';
/** The words on the synthetic reel's two scenes (make-reel.swift), never in its caption. */
const ON_FRAMES = ['MANGO LASSI', 'SERVE COLD'];
const JPEG = Buffer.from(TINY_JPEG_DATA_URL.split(',')[1] ?? '', 'base64');
/** An mp4's ftyp box (synthetic, unplayable): what the fake helper is handed. */
const FAKE_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(4), Buffer.from('isommp41', 'latin1')]);

/** A synthetic reel made with AVFoundation (make-reel.swift, compiled in `dir` with its own module cache). */
async function makeReel(dir: string): Promise<Buffer> {
  const source = fileURLToPath(new URL('./make-reel.swift', import.meta.url));
  const env = { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: `${dir}/` };
  const bin = join(dir, 'make-reel');
  await run('/usr/bin/swiftc', ['-O', '-module-cache-path', join(dir, 'module-cache'), '-swift-version', '5', '-o', bin, source], { env, timeout: 240_000 });
  await run(bin, [join(dir, 'reel.mp4')], { env, timeout: 60_000 });
  return readFile(join(dir, 'reel.mp4'));
}

// The headless browser keeps Chrome's sandbox (chromiumSandbox: true). Ubuntu 23.10+ CI refuses the user
// namespaces that sandbox needs, so the read falls to the downloader there. Intel reading runs on the Mac
// only (servers don't read Intel), so the browser-tier cases run on the macOS job.
const browserTier = process.platform === 'darwin';

describe.skipIf(!ready)(`v0.8 a reel sent from the phone, read on the Mac, found again by search (${REAL ? 'the real media helper' : 'the fake media helper'})`, () => {
  let d: Daemon;
  let ctl: CtlClient;
  let sites: Sites;
  let work = '';
  let seed = '';
  let extKey = '';
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  let watch: Watch;
  const seen: BrowserSeen = { launches: [], contexts: [], requests: [] };

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error' || /intel/.test(r.msg))
      .slice(-30)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  /** The API as a second paired device sees it (what the phone's screens read). */
  async function get<T>(path: string): Promise<T> {
    const r = await http(d.port, 'GET', path, { cookie: seed });
    expect(r.status, `GET ${path}: ${r.text}`).toBe(200);
    return r.body as T;
  }
  const jobOf = async (id: string) => (await get<IntelJobsResponse>('/v1/intel/jobs')).jobs.find((j) => j.id === id);
  const search = async (q: string) => (await get<IntelListResponse>(`/v1/intel?q=${encodeURIComponent(q)}`)).items.map((i) => i.id);
  /** The extension's own call: its key, and its Origin on a write. */
  const ext = (method: string, path: string, body?: unknown) =>
    http(d.port, method, path, { origin: method === 'POST' ? EXT_ORIGIN : null, headers: { [EXTENSION_KEY_HEADER]: extKey }, ...(body === undefined ? {} : { body }) });
  const asks = async () => {
    const r = await ext('GET', '/v1/ext/reads/next');
    expect(r.status, r.text).toBe(200);
    return (r.body as ExtReadNextReply).job;
  };

  beforeAll(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), 'jantar-reel-')));
    const video = REAL ? await makeReel(work) : FAKE_MP4;
    sites = await serveSites((host, path): Answer | undefined => {
      const at = `${host}${path.split('?')[0]}`;
      if (at === 'www.instagram.com/reel/AbC123xyz/') return { type: 'text/html; charset=utf-8', body: POST_PAGES.instagram.html };
      if (at === VIDEO_AT) return { type: 'video/mp4', body: video };
      if (host === 'scontent.cdninstagram.com' && at.endsWith('.jpg')) return { type: 'image/jpeg', body: JPEG };
      return undefined;
    });
    d = await bootDaemon({
      home: { sessions: [] },
      fakeMediaTools: !REAL,
      intel: { net: netSeam(sites), browser: browserSeam(CHROMIUM, seen) },
      before: async (home) => {
        // yt-dlp named outright (the fake home's PATH must never find a real one); the fake helper reads the reel's words.
        await writeFakeYtDlp(home.root, join(home.root, 'yt-dlp-bin'));
        await mkdir(join(home.root, 'fake'), { recursive: true });
        await writeFile(join(home.root, 'fake', 'jantar-media.json'), JSON.stringify({ duration: 4, ocr: ON_FRAMES }));
      },
      settings: (home) => ({ intel: { enabled: true, read: true }, bins: { ytDlp: join(home.root, 'yt-dlp-bin', 'yt-dlp') } }),
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'seed', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'seed' } });
    expect(claim.status, claim.text).toBe(200);
    seed = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(seed, claim.body);

    // The paired extension, with Read saved links on.
    const code = (await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start')).code;
    const paired = await http(d.port, 'POST', '/v1/ext/pair', { body: { code }, origin: EXT_ORIGIN });
    expect(paired.status, paired.text).toBe(200);
    extKey = (paired.body as { key: string }).key;

    // The phone.
    browser = await chromium.launch();
    ctx = await browser.newContext({ viewport: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', locale: 'en-GB', serviceWorkers: 'block' });
    // The original post, as the phone's own browser would open it (answered here: nothing reaches the network).
    await ctx.route('https://www.instagram.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>The original reel</title><p>The original reel.</p>' }));
    page = await ctx.newPage();
    watch = watchConsole(page);
    const phone = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'Example phone', scopes: ['read', 'control'] });
    await page.goto(`http://127.0.0.1:${d.port}/pair#c=${phone.code}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Paired' }).waitFor();
    // Before the claim the app's first calls answer 401: expected, and over now.
    watch.errors.length = 0;
  }, perfBudgetMs(REAL ? 300_000 : 60_000));

  afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await d?.stop();
    await sites?.close();
    if (work) await rm(work, { recursive: true, force: true });
  }, perfBudgetMs(30_000));

  it.skipIf(!browserTier)('the phone saves a reel at Standard; Chrome needs a login, the headless browser reads it, the helper takes its frames; search finds it by its caption and by its frames; Open original is the reel', async () => {
    // 1. The phone: Add post, a shared link, Standard, Save.
    await page.goto(`http://127.0.0.1:${d.port}/intel`, { waitUntil: 'load' });
    // Read saved links on: the extension has asked, and there is nothing yet.
    expect(await asks()).toBeNull();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Add post' });
    await sheet.getByLabel('Link or text').fill(REEL_SHARED);
    await sheet.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved. Reading it on your Mac.').waitFor();
    const id = await eventually(async () => (await search('AbC123xyz'))[0], 10_000, 'the reel on the shelf');

    // 2. Chrome first: the post rebuilt on the www host, never the link as typed; the strip says so.
    const lease = (await eventually(asks, 30_000, 'a post for Chrome')) as NonNullable<ExtReadNextReply['job']>;
    expect(lease).toMatchObject({ url: REEL, platform: 'instagram', frames: 4 });
    expect(await jobOf(id)).toMatchObject({ state: 'fetching', tier: 'chrome', depth: 'standard', platform: 'instagram' });
    const strip = page.getByRole('region', { name: 'Reading' });
    await strip.locator(`li[data-job="${id}"]`).getByText('Opening in Chrome · Standard').waitFor();
    expect((await ext('POST', `/v1/ext/reads/${lease.id}`, { ok: false, why: 'login' })).status).toBe(200);

    // 3 and 4. The rest of the read, on the Mac, one job.
    let job: IntelJob | undefined;
    try {
      job = await eventually(async () => {
        const j = await jobOf(id);
        return j && (j.state === 'saved' || j.state === 'failed') ? j : null;
      }, REAL ? 240_000 : 90_000, 'the reel read');
    } catch (e) {
      throw new Error(`${(e as Error).message}\n${dumpLog()}`);
    }
    expect(job, `${JSON.stringify(job)}\nlaunches ${seen.launches.length}; requests:\n${seen.requests.join('\n')}\n${dumpLog()}`).toMatchObject({ state: 'saved', platform: 'instagram', depth: 'standard', tier: 'browser' });
    const item = (await get<{ item: IntelItem }>(`/v1/intel/items/${encodeURIComponent(id)}`)).item;
    expect(item).toMatchObject({ url: REEL, platform: 'instagram', type: 'reel', depth: 'standard', read: { state: 'saved', depth: 'standard', done: 'standard', tier: 'browser' } });
    expect(item.read?.notes ?? []).toEqual([]);
    expect(item.creator).toContain('example_cook');
    expect(item.caption).toContain(POST_PAGES.instagram.caption);
    // Claude's title (the fake: the caption's first words) is the job's name now too.
    expect(item.title).toMatch(/^Three ways to cook dal at home/);
    expect(job?.title).toBe(item.title);
    // Claude was shown the frames and the cover (the fake says how many pictures).
    expect(Number(/^Shown (\d+) pictures?\./.exec(item.summary ?? '')?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
    // The words on the video's frames, read on the Mac.
    for (const words of ON_FRAMES) expect(item.onScreen ?? '').toContain(words);
    expect(item.frames ?? 0).toBeGreaterThanOrEqual(1);

    // The headless tier read the page through the daemon's proxy; the daemon fetched the reel's own file once, cookie-less; yt-dlp was not needed.
    expect(seen.launches.at(-1)).toMatchObject({ headless: true, proxy: { server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) } });
    expect(seen.requests.some((r) => r.startsWith(`${REEL} `) && r.endsWith(' 200'))).toBe(true);
    expect(sites.asked(VIDEO_AT)).toBe(1);
    expect(await readFile(join(d.home.root, 'calls', 'yt-dlp.jsonl'), 'utf8').catch(() => '')).not.toContain('"-f"');
    if (REAL) {
      // The real helper: built from the repository's Swift source by the real swiftc, run under sandbox-exec.
      expect(d.media).toBeNull();
      expect(existsSync(join(d.ctx.paths.intelDir, 'bin', 'jantar-media.key'))).toBe(true);
    }

    // 5. The phone finds it again: a caption word, then a word only the frames hold (another item beside it, found by neither).
    await strip.locator(`li[data-job="${id}"]`).getByText('Saved · Standard').waitFor();
    await strip.locator(`li[data-job="${id}"]`).getByText(item.title).waitFor();
    expect(item.caption?.toLowerCase()).not.toContain('lassi');
    await callDaemon(ctl, 'POST', '/v1/intel/captures', captureBody());
    const box = page.getByLabel('Search the shelf');
    const row = page.locator('main li a', { hasText: item.title });
    for (const word of ['turmeric', 'lassi']) {
      await box.fill(word);
      await page.waitForURL(new RegExp(`[?&]q=${word}(&|$)`));
      await page.getByText('1 match', { exact: true }).waitFor();
      await row.waitFor();
      expect(await page.locator('main li a', { hasText: 'Example capture' }).count()).toBe(0);
      expect(await search(word)).toEqual([id]);
    }

    // Its page: the pictures, and Open original is the reel's own link, opening the original post.
    await row.click();
    await page.getByRole('heading', { level: 1, name: item.title }).waitFor();
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('[aria-label="Pictures"] img')];
      return imgs.length >= 1 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    });
    const original = page.getByRole('link', { name: 'Open original' });
    expect(await original.getAttribute('href')).toBe(REEL);
    expect(await original.getAttribute('target')).toBe('_blank');
    expect(await original.getAttribute('rel')).toBe('noopener noreferrer');
    const [tab] = await Promise.all([ctx.waitForEvent('page'), original.click()]);
    await tab.waitForLoadState('load');
    expect(tab.url()).toBe(REEL);
    expect(await tab.title()).toBe('The original reel');
    await tab.close();
    await clean(page, watch);
  }, perfBudgetMs(REAL ? 300_000 : 120_000));
});
