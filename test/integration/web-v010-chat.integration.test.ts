/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * v0.10 Chat in the BUILT web app (spec 0.10 B14, B15), in a real headless
 * Chromium served by jantard itself (in-process on a synthetic HOME,
 * harness.ts) with its real headers and the build's strict policy. The
 * thread is made by real turns: the fake claude through the real bridge and
 * dispatcher (a todo added, a café rated, a visit logged, a delete waiting
 * for its Confirm, a photo). Each browser pairs the way a phone does.
 *
 * - At 320 px, 390 px and 1440 px, light and dark: the empty thread, the
 *   thread with a reply, changes, a card and a photo, and the composer with
 *   two photo chips. No console message about the Content Security Policy,
 *   no console error, no data: image, `window.__pwned` never set, and
 *   nothing sticking out past the viewport's sides.
 * - /ask lands on /chat.
 * - Under a coarse pointer (the 320 px phone) every target is 44 px tall:
 *   the photo button, Send, Undo, Confirm, Dismiss.
 *
 * Every name and value is synthetic. Needs a built dist/ and a Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { chatText, makePng, perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, type ChatList, type PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { DESK, browserReady, clean, overflow, watchConsole, type Viewport, type Watch } from './browser.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const ready = await browserReady('web-v010-chat.integration');

type Who = 'p320' | 'p390' | 'desk';
const SIZES: Record<Who, Viewport> = {
  p320: { width: 320, height: 640, phone: true },
  p390: { width: 390, height: 844, phone: true },
  desk: DESK,
};
const VIEWS: ReadonlyArray<{ who: Who; scheme: 'light' | 'dark' }> = (['p320', 'p390', 'desk'] as const).flatMap((who) => [
  { who, scheme: 'light' as const },
  { who, scheme: 'dark' as const },
]);

describe.skipIf(!ready)('v0.10 Chat in Chromium, served by jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let cookie: string;
  let browser: Browser;
  const pages: Partial<Record<Who, { ctx: BrowserContext; page: Page; watch: Watch }>> = {};

  const call = (method: string, path: string, body?: unknown, raw?: Buffer) => http(d.port, method, path, { cookie, ...(body === undefined ? {} : { body }), ...(raw ? { raw } : {}) });

  async function turn(text: string, photos: string[] = []) {
    const r = await call('POST', '/v1/chat', photos.length ? { text, photos } : { text });
    expect(r.status, r.text).toBe(202);
    const id = (r.body as { id: string }).id;
    await eventually(
      async () => {
        const t = ((await call('GET', '/v1/chat')).body as ChatList).turns.find((x) => x.id === id);
        return t && t.state !== 'queued' && t.state !== 'running' ? t : null;
      },
      perfBudgetMs(30_000),
      text,
    );
  }

  async function check(page: Page, watch: Watch, what: string) {
    await page.waitForTimeout(400);
    await clean(page, watch);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned), what).toBeUndefined();
    expect(await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('data:')).length), what).toBe(0);
    expect(await overflow(page), what).toEqual([]);
  }

  async function paired(who: Who): Promise<{ ctx: BrowserContext; page: Page; watch: Watch }> {
    const vp = SIZES[who];
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.phone === true,
      hasTouch: vp.phone === true,
      colorScheme: 'light',
      locale: 'en-GB',
      timezoneId: 'UTC',
      serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    const watch = watchConsole(page);
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: who, scopes: ['read', 'control'] });
    await page.goto(`http://127.0.0.1:${d.port}/pair#c=${start.code}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Paired' }).waitFor();
    watch.errors.length = 0;
    return { ctx, page, watch };
  }

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true, places: true, timezone: 'UTC', currency: 'INR' }, ask: { enabled: true } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'seed', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'seed' } });
    expect(claim.status, claim.text).toBe(200);
    cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);
    browser = await chromium.launch();
    for (const who of ['p320', 'p390', 'desk'] as const) pages[who] = await paired(who);
  }, perfBudgetMs(120_000));

  afterAll(async () => {
    for (const p of Object.values(pages)) await p?.ctx.close();
    await browser?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('the empty thread at 320, 390 and 1440, light and dark; /ask lands on /chat', async () => {
    for (const v of VIEWS) {
      const { page, watch } = pages[v.who]!;
      await page.emulateMedia({ colorScheme: v.scheme });
      await page.goto(`http://127.0.0.1:${d.port}/ask`, { waitUntil: 'load' });
      await page.getByText('Ask Jantar anything, or tell it what to add or change.').waitFor();
      expect(new URL(page.url()).pathname).toBe('/chat');
      await check(page, watch, `empty ${v.who} ${v.scheme}`);
    }
  });

  it('a thread with a reply, changes, a card and a photo; the composer with two chips', async () => {
    await call('POST', '/v1/places', { name: 'Sample Dosa House' });
    await call('POST', '/v1/todos', { title: 'Call the bank' });
    await turn(chatText('chat-write', 'Add oat milk and rate the dosa place 4 stars'));
    await turn(chatText('chat-delete', 'delete the bank todo'));
    const up = await call('POST', '/v1/chat/photos', undefined, makePng(640, 480));
    expect(up.status, up.text).toBe(200);
    await turn(chatText('chat-photos', 'what is on this bill'), [(up.body as { id: string }).id]);
    for (const v of VIEWS) {
      const { page, watch } = pages[v.who]!;
      await page.emulateMedia({ colorScheme: v.scheme });
      await page.goto(`http://127.0.0.1:${d.port}/chat`, { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Confirm' }).waitFor();
      await page.locator('img[src^="blob:"]').first().waitFor();
      await check(page, watch, `thread ${v.who} ${v.scheme}`);
      await page.locator('input[type="file"]').setInputFiles([
        { name: 'one.png', mimeType: 'image/png', buffer: makePng(40, 30) },
        { name: 'two.png', mimeType: 'image/png', buffer: makePng(30, 40) },
      ]);
      const chips = page.getByRole('list', { name: 'Photos to send' });
      await chips.waitFor();
      await eventually(async () => ((await chips.getByRole('listitem').count()) === 2 ? true : null), perfBudgetMs(10_000), 'two chips');
      await check(page, watch, `composer ${v.who} ${v.scheme}`);
      for (let i = 0; i < 2; i++) await chips.getByRole('button', { name: 'Remove the photo' }).first().click();
    }
  });

  it('under a coarse pointer every target is 44 px tall (320 px phone)', async () => {
    const { page } = pages.p320!;
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.goto(`http://127.0.0.1:${d.port}/chat`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Confirm' }).waitFor();
    const tall = async (target: Locator, what: string) => expect((await target.boundingBox())?.height ?? 0, what).toBeGreaterThanOrEqual(44);
    await tall(page.getByRole('button', { name: 'Add a photo' }), 'photo');
    await tall(page.getByRole('button', { name: 'Send' }), 'send');
    await tall(page.getByRole('button', { name: 'Undo' }).first(), 'undo');
    await tall(page.getByRole('button', { name: 'Confirm' }), 'confirm');
    await tall(page.getByRole('button', { name: 'Dismiss' }), 'dismiss');
  });
});
