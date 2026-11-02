/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * v0.10 Cafés depth in the BUILT web app (spec 0.10 A7, A8), in a real
 * headless Chromium served by jantard itself (in-process on a synthetic
 * HOME, harness.ts) with its real headers and the build's strict policy, on
 * cafés written through the API. Each browser pairs the way a phone does.
 *
 * - At 320 px, 390 px and 1440 px, light and dark: the list with filters on
 *   (and their chips), the Filters and Sort sheets, a café's screen, and its
 *   café, dish and visit sheets. No console message about the Content
 *   Security Policy, no console error, no <style> element, `window.__pwned`
 *   never set, and nothing sticking out past the viewport's sides.
 * - Grayscale: the stars are --ink like the café's name (no colour carries
 *   a rating).
 * - Under a coarse pointer (the 320 px phone) every target is 44 px tall:
 *   the rows, the bar, the filter chips, the stars, the segmented controls
 *   (their box; a segment's hit area fills it), Log visit, the dish and
 *   visit rows.
 *
 * Every name and value is synthetic. Needs a built dist/ and a Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, type PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { DESK, browserReady, clean, overflow, watchConsole, type Viewport, type Watch } from './browser.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const ready = await browserReady('web-v010-places.integration');

const DAY_MS = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

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

describe.skipIf(!ready)('v0.10 Cafés depth in Chromium, served by jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let cookie: string;
  let browser: Browser;
  const ids: Record<string, string> = {};
  const pages: Partial<Record<Who, { ctx: BrowserContext; page: Page; watch: Watch }>> = {};

  const call = (method: string, path: string, body?: unknown) => http(d.port, method, path, { cookie, ...(body === undefined ? {} : { body }) });
  async function made(name: string, path: string, body: unknown): Promise<string> {
    const r = await call('POST', path, body);
    expect(r.status, `POST ${path}: ${r.text}`).toBe(200);
    ids[name] = (r.body as { id: string }).id;
    return ids[name] as string;
  }

  async function check(page: Page, watch: Watch, what: string) {
    // Sheets and pushed screens finish sliding in first.
    await page.waitForTimeout(400);
    await clean(page, watch);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned), what).toBeUndefined();
    expect(await overflow(page), what).toEqual([]);
  }

  /** Opens a sheet with `open`, checks it, and closes it with Escape. */
  async function sheet(page: Page, watch: Watch, what: string, open: () => Promise<void>) {
    await open();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await check(page, watch, what);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
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
    // Before the claim the app's first calls answer 401: expected, and over now.
    watch.errors.length = 0;
    return { ctx, page, watch };
  }

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { places: true, timezone: 'UTC', currency: 'INR' } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'seed', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'seed' } });
    expect(claim.status, claim.text).toBe(200);
    cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);

    const cafe = await made('cafe', '/v1/places', {
      name: 'Example Café with a long name that has to wrap on a small phone',
      area: 'Old Town',
      link: 'https://maps.example.com/?q=example-cafe',
      tried: true,
      stars: 4,
      price: 2,
      again: 'yes',
      ratings: { food: 4, drinks: 5, ambience: 4, service: 4, value: 3, work: 5 },
      tags: ['wifi', 'sockets', 'quiet', 'laptops', 'specialty-coffee', 'Board games'],
      dishes: [
        { name: 'Cardamom bun', rating: 5, price: 18000, again: true, notes: 'Warm before ten.' },
        { name: 'Flat white', rating: 4, price: 22000 },
        { name: 'Sourdough toast' },
      ],
      notes: 'The window seats have sockets.',
    });
    await made('dosa', '/v1/places', { name: 'Sample Dosa House', area: 'Market Street', tried: true, stars: 5, price: 1, again: 'yes', tags: ['wifi', 'veg', 'breakfast'], dishes: [{ name: 'Ghee roast dosa', rating: 5 }] });
    await made('pizza', '/v1/places', { name: 'Placeholder Pizza', area: 'Riverside', tried: true, stars: 3, price: 4, again: 'no', tags: ['groups', 'late'] });
    await made('bakery', '/v1/places', { name: 'Fixture Bakery', area: 'Hill Lane', tried: false, price: 1, tags: ['breakfast', 'desserts'] });
    for (const [n, body] of [
      [1, { day: ago(1), spend: 45000, stars: 4, had: ['Cardamom bun', 'Flat white'], notes: 'Quiet before 11, sockets by the window. A long note that runs past two lines on a phone so it is cut short there.' }],
      [2, { day: ago(8), spend: 38000 }],
      [3, { day: ago(15), stars: 5 }],
    ] as const) {
      await made(`visit${n}`, `/v1/places/${cafe}/visits`, body);
    }
    await made('dosaVisit', `/v1/places/${ids.dosa}/visits`, { day: ago(2), spend: 30000 });

    browser = await chromium.launch();
    for (const who of ['p320', 'p390', 'desk'] as const) pages[who] = await paired(who);
  }, perfBudgetMs(120_000));

  afterAll(async () => {
    for (const p of Object.values(pages)) await p?.ctx.close();
    await browser?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('the list with filters on, its Filters and Sort sheets, at 320, 390 and 1440, light and dark', async () => {
    for (const v of VIEWS) {
      const { page, watch } = pages[v.who]!;
      const what = `the list (${v.who}, ${v.scheme})`;
      await page.emulateMedia({ colorScheme: v.scheme });
      await page.goto(`http://127.0.0.1:${d.port}/places?tags=wifi&price=2&again=1`, { waitUntil: 'load' });
      const list = page.getByRole('list', { name: 'Cafés' });
      await list.waitFor();
      await expect.poll(() => list.getByRole('listitem').count(), { message: what }).toBe(2);
      await page.getByRole('group', { name: 'Filters on' }).waitFor();
      await check(page, watch, what);
      await sheet(page, watch, `the Filters sheet (${v.who}, ${v.scheme})`, () => page.getByRole('button', { name: /^Filters/ }).click());
      await sheet(page, watch, `the Sort sheet (${v.who}, ${v.scheme})`, () => page.getByRole('button', { name: /^Sort:/ }).click());
      await page.goto(`http://127.0.0.1:${d.port}/places`, { waitUntil: 'load' });
      await expect.poll(() => page.getByRole('list', { name: 'Cafés' }).getByRole('listitem').count(), { message: what }).toBe(4);
      await check(page, watch, `the whole list (${v.who}, ${v.scheme})`);
    }
  }, perfBudgetMs(240_000));

  it("a café's screen and its café, dish and visit sheets, at 320, 390 and 1440, light and dark", async () => {
    for (const v of VIEWS) {
      const { page, watch } = pages[v.who]!;
      const at = `(${v.who}, ${v.scheme})`;
      await page.emulateMedia({ colorScheme: v.scheme });
      await page.goto(`http://127.0.0.1:${d.port}/places?id=${ids.cafe}`, { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Log visit' }).waitFor();
      await page.getByRole('region', { name: 'Ratings' }).waitFor();
      await check(page, watch, `the café screen ${at}`);
      await sheet(page, watch, `the café sheet ${at}`, async () => {
        await page.getByRole('button', { name: 'Edit' }).click();
      });
      await sheet(page, watch, `the dish sheet ${at}`, () => page.getByRole('region', { name: 'Dishes' }).getByText('Cardamom bun').click());
      await sheet(page, watch, `the visit sheet ${at}`, () => page.getByRole('region', { name: /^Visits/ }).getByRole('button').first().click());
      await sheet(page, watch, `Log visit ${at}`, () => page.getByRole('button', { name: 'Log visit' }).click());
    }
  }, perfBudgetMs(240_000));

  it('a café opened from the list; Edit with More ratings open at 320 px fits', async () => {
    const { page, watch } = pages.p320!;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`http://127.0.0.1:${d.port}/places`, { waitUntil: 'load' });
    await page.getByText('Sample Dosa House').click();
    await page.getByRole('heading', { level: 1, name: 'Sample Dosa House' }).waitFor();
    await check(page, watch, 'a café opened from the list');
    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'More ratings' }).click();
    await dialog.getByRole('radiogroup', { name: 'Work rating' }).waitFor();
    await check(page, watch, 'the café sheet with More ratings');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });

  it('in grayscale no colour carries a rating: every star is --ink, like the name', async () => {
    const { page } = pages.p390!;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`http://127.0.0.1:${d.port}/places?id=${ids.cafe}`, { waitUntil: 'load' });
    await page.getByRole('region', { name: 'Ratings' }).waitFor();
    const colours = await page.evaluate(() => {
      const ink = getComputedStyle(document.querySelector('h1') as Element).color;
      const stars = [...document.querySelectorAll('[role="img"][aria-label$="of 5"] svg')].map((s) => getComputedStyle(s).color);
      return { ink, stars: [...new Set(stars)], n: stars.length };
    });
    expect(colours.n).toBeGreaterThan(10);
    expect(colours.stars).toEqual([colours.ink]);
  });

  it('under a coarse pointer every target is 44 px tall (320 px phone)', async () => {
    const { page } = pages.p320!;
    // Sizes are read on a still screen: with reduced motion a screen only fades in.
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const tall = async (target: Locator, what: string) => {
      await target.waitFor();
      expect((await target.boundingBox())?.height ?? 0, what).toBeGreaterThanOrEqual(44);
    };
    const all = async (targets: Locator, what: string) => {
      await targets.first().waitFor();
      const n = await targets.count();
      expect(n, what).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) await tall(targets.nth(i), `${what} ${i}`);
    };
    try {
      await page.goto(`http://127.0.0.1:${d.port}/places?tags=wifi`, { waitUntil: 'load' });
      await all(page.getByRole('list', { name: 'Cafés' }).getByRole('button'), 'a café row');
      await tall(page.getByRole('button', { name: /^Sort:/ }), 'Sort');
      await tall(page.getByRole('button', { name: /^Filters/ }), 'Filters');
      await tall(page.getByRole('button', { name: 'Search cafés' }), 'Search');
      await all(page.getByRole('group', { name: 'Filters on' }).getByRole('button', { name: /^Take off/ }), 'a filter chip');
      await page.getByRole('button', { name: /^Filters/ }).click();
      const filters = page.getByRole('dialog');
      await all(filters.getByRole('group', { name: 'Tags' }).getByRole('button'), 'a tag chip');
      // A segment is 38 px inside its 44 px box; its hit area takes in the box's padding (Segmented's ::before).
      await tall(filters.getByRole('group', { name: 'Price up to' }), 'the price segments');
      await page.keyboard.press('Escape');
      await filters.waitFor({ state: 'detached' });

      await page.goto(`http://127.0.0.1:${d.port}/places?id=${ids.cafe}`, { waitUntil: 'load' });
      await tall(page.getByRole('button', { name: 'Log visit' }), 'Log visit');
      await all(page.getByRole('region', { name: 'Dishes' }).getByRole('button', { name: /Cardamom|Flat|Sourdough/ }), 'a dish row');
      await all(page.getByRole('region', { name: /^Visits/ }).getByRole('list').getByRole('button'), 'a visit row');
      await page.getByRole('button', { name: 'Edit' }).click();
      const edit = page.getByRole('dialog');
      await all(edit.getByRole('radiogroup', { name: 'Stars' }).getByRole('radio'), 'a star');
      await tall(edit.getByRole('group', { name: 'Price' }), 'the price levels');
      await tall(edit.getByRole('group', { name: 'Would go again' }), 'would go again');
      await all(edit.getByRole('group', { name: 'Tags' }).getByRole('button'), 'a tag');
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'detached' });
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
  }, perfBudgetMs(120_000));
});
