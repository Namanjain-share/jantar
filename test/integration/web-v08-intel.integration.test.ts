/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * v0.8 Intel reading links on the phone, end to end in the BUILT web app:
 * a real headless Chromium at 390 px (playwright-core's own, a fresh temp
 * profile) against the synthetic v0.8 fixture (web-fixture-v08.ts,
 * 'intel-read'), served with the daemon's real headers (web-server.ts) and
 * its /v1 answers routed in the browser as the screenshot script does.
 * Nothing here runs a daemon, reads a home or reaches the network.
 *
 * First the fixture itself: every route the phone calls answers with a
 * body its schema accepts (a thumbnail with JPEG bytes), the reel has every
 * field a Full read writes, and nothing in it is real (example.com links,
 * made-up creators). Then the screens:
 *
 * 1. The shelf, light and dark: the Reading strip lists the reads on their
 *    way, the one that failed (its fixed reason, Retry, Change depth) and
 *    the reel saved ten minutes ago, but not the video saved three hours
 *    ago; the reel's row shows its first picture; Retry posts to the item's
 *    read route at its depth.
 * 2. Add post: the text and the depth go to POST /v1/intel/reads with an
 *    Idempotency-Key, the sheet closes and says the Mac is reading it; the
 *    reel's own link is "Already saved." with Open.
 * 3. The reel's page, light and dark: four pictures from the frames route
 *    (one opens larger), Open original (https, a new tab, no opener, no
 *    referrer), "Read at Full", the labelled parts, the transcript folded
 *    until asked for, Claude's background labelled; Delete after a second
 *    tap leaves for the shelf.
 *
 * Everywhere: no console message about the Content Security Policy, no
 * console error, no <style> element, nothing past the sides at 390 px.
 * Needs a built dist/ and a Chromium (browser.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { perfBudgetMs } from '@jantar/fixtures';
import {
  INTEL_READ_REASONS,
  IntelItemResponseSchema,
  IntelJobsResponseSchema,
  IntelListResponseSchema,
  IntelReadReplySchema,
  IntelRereadReplySchema,
  OkReplySchema,
  StateSchema,
} from '@jantar/protocol';
import { DIST, PHONE, browserReady, clean, overflow, watchConsole, type Watch } from './browser.js';
import { DAL_URL, READ_IDS, webFixtureV08, type V08Answer, type WebFixtureV08 } from './web-fixture-v08.js';
import { serveWebApp, type WebServer } from './web-server.js';

const BASE = 'http://127.0.0.1:1';
/** What this browser learned when it paired (ui/screens/devices/local.ts): the shelf's writes need control. */
const DEVICE = { id: 'dev2', name: 'iPhone', scopes: ['read', 'control'] };

describe('webFixtureV08', () => {
  const f = webFixtureV08({ variant: 'intel-read' });
  const answer = f.v04.answer as V08Answer;
  const ask = (method: string, path: string, body?: unknown) => answer(method, new URL(path, BASE), body === undefined ? null : Buffer.from(JSON.stringify(body)));
  const id = encodeURIComponent(READ_IDS.dal);

  it('answers every route the phone calls with a body its schema accepts', () => {
    expect(StateSchema.safeParse(f.state.state).success).toBe(true);
    expect(f.state.state.daemon?.features).toMatchObject({ intel: true, intelRead: true });
    const parse = (schema: { safeParse: (v: unknown) => { success: boolean } }, reply: { status: number; body: unknown } | null, what: string) => {
      expect(reply?.status, what).toBe(200);
      expect(schema.safeParse(reply?.body).success, what).toBe(true);
    };
    parse(IntelListResponseSchema, ask('GET', '/v1/intel'), 'intelList');
    parse(IntelJobsResponseSchema, ask('GET', '/v1/intel/jobs'), 'intelJobs');
    parse(IntelItemResponseSchema, ask('GET', `/v1/intel/items/${id}`), 'intelGet');
    parse(IntelReadReplySchema, ask('POST', '/v1/intel/reads', { text: 'https://www.example.com/p/1', depth: 'light' }), 'intelRead');
    parse(IntelRereadReplySchema, ask('POST', `/v1/intel/items/${id}/read`, { depth: 'full' }), 'intelReread');
    parse(OkReplySchema, ask('DELETE', `/v1/intel/items/${id}`), 'intelDelete');
    for (let n = 0; n < 4; n++) {
      const pic = ask('GET', `/v1/intel/items/${id}/frames/${n}`);
      expect(pic?.status).toBe(200);
      expect(pic?.type).toBe('image/jpeg');
      expect(pic?.bytes?.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    }
    expect(ask('GET', `/v1/intel/items/${id}/frames/4`)?.status).toBe(404);
    // The reel's own link is already on the shelf.
    expect((ask('POST', '/v1/intel/reads', { text: DAL_URL })?.body as { duplicate: boolean }).duplicate).toBe(true);
    // The other variants are web-fixture-v051.ts's, unchanged: no reading there.
    const plain = webFixtureV08();
    expect(plain.v08).toBeNull();
    expect(plain.state.state.daemon?.features?.intelRead).toBeFalsy();
  });

  it('holds a reel read at Full with every field, and reads in each state', () => {
    const dal = f.v08!.items.find((x) => x.id === READ_IDS.dal)!;
    expect(dal).toMatchObject({ creator: '@example_cook', platform: 'instagram', depth: 'full', frames: 4, read: { state: 'saved', done: 'full' } });
    for (const k of ['caption', 'onScreen', 'transcript', 'background', 'note', 'points', 'summary', 'why'] as const) expect(dal[k], k).toBeTruthy();
    expect(f.v08!.jobs.jobs.map((j) => j.state).sort()).toEqual(['failed', 'frames', 'queued', 'saved', 'saved']);
    expect(f.v08!.jobs.jobs.find((j) => j.state === 'failed')?.reason).toBe(INTEL_READ_REASONS.login);
  });

  it('holds nothing real: links on example.com, made-up creators', () => {
    const text = JSON.stringify([f.v08, ask('GET', '/v1/intel')?.body]);
    for (const m of text.matchAll(/https?:\/\/([^/"\s\\]+)/g)) expect(m[1]).toMatch(/(^|\.)example\.com$/);
    expect(text).not.toMatch(/\/Users\/(?!you\/)/);
    for (const x of f.v08!.items) if (x.creator) expect(x.creator).toMatch(/^(@example_\w+|Example [A-Z][a-z]+( [A-Z][a-z]+)?)$/);
  });
});

const ready = await browserReady('web-v08-intel.integration');

describe.skipIf(!ready)('v0.8 Intel reading links in Chromium at 390 px: the Reading strip, Add post, a read item', () => {
  let server: WebServer;
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  let fixture: WebFixtureV08;
  /** The writes the page sent, in order (routed in the browser, so the server never sees them). */
  let writes: Array<{ method: string; path: string; body: unknown; key: string | undefined }> = [];

  beforeAll(async () => {
    fixture = webFixtureV08({ variant: 'intel-read' });
    server = await serveWebApp(DIST, () => fixture);
    browser = await chromium.launch();
  }, perfBudgetMs(30_000));

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.close();
  }, perfBudgetMs(30_000));

  async function open(path: string, scheme: 'light' | 'dark' = 'light'): Promise<{ page: Page; watch: Watch }> {
    const ctx = await browser.newContext({
      viewport: { width: PHONE.width, height: PHONE.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: scheme,
      locale: 'en-GB',
      timezoneId: fixture.timezone,
      serviceWorkers: 'block',
    });
    contexts.push(ctx);
    await ctx.clock.setFixedTime(fixture.now);
    await ctx.addInitScript((device) => localStorage.setItem('jantar:device', JSON.stringify(device)), DEVICE);
    // The event stream: accepted and kept quiet, as a running daemon's.
    await ctx.routeWebSocket((url) => url.pathname === '/v1/events', () => undefined);
    await ctx.route(
      (url) => url.pathname.startsWith('/v1/'),
      async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const body = req.postDataBuffer();
        if (req.method() !== 'GET') {
          writes.push({ method: req.method(), path: url.pathname, body: body?.length ? JSON.parse(body.toString('utf8')) : undefined, key: req.headers()['idempotency-key'] });
        }
        const reply = (fixture.v04.answer as V08Answer)(req.method(), url, body);
        if (!reply) return route.continue();
        if (reply.bytes) return route.fulfill({ status: reply.status, contentType: reply.type, body: reply.bytes });
        return route.fulfill({ status: reply.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(reply.body) });
      },
    );
    const page = await ctx.newPage();
    const watch = watchConsole(page);
    await page.goto(`${server.base}${path}`, { waitUntil: 'load' });
    return { page, watch };
  }

  /** Clean console, no <style>, nothing past the sides of the phone. */
  async function check(page: Page, watch: Watch, what: string) {
    await page.waitForTimeout(300);
    await clean(page, watch);
    expect(await overflow(page), what).toEqual([]);
  }

  /** Every <img> under `selector` has its bytes (decoded, with a size). */
  const loaded = (page: Page, selector: string, n: number) =>
    page.waitForFunction(
      ([sel, want]) => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>(`${sel} img`)];
        return imgs.length >= want && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      [selector, n] as const,
      { timeout: perfBudgetMs(10_000) },
    );

  it('the shelf, light and dark: the Reading strip, the reel row with its picture, Retry at its depth', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      writes = [];
      const { page, watch } = await open('/intel', scheme);
      const strip = page.getByRole('region', { name: 'Reading' });
      await strip.waitFor();
      const rows = strip.locator('li[data-job]');
      expect(await rows.count(), scheme).toBe(4);
      const states = await rows.evaluateAll((els) => els.map((el) => el.querySelector('p')?.textContent?.trim()));
      expect(states).toEqual(['Looking at frames · Standard', 'Waiting · Light', 'Saved · Full', "Couldn't read · Standard"]);
      const failed = strip.locator(`li[data-job="${READ_IDS.failed}"]`);
      await failed.getByText(INTEL_READ_REASONS.login, { exact: true }).waitFor();
      // The reel's row: its first picture, and who made it.
      const reel = page.locator('main li a', { hasText: 'Three ways to cook dal at home' });
      await reel.getByText(/^Instagram · @example_cook · /).waitFor();
      await loaded(page, `main a[href="/intel?item=${encodeURIComponent(READ_IDS.dal)}"]`, 1);
      await check(page, watch, `shelf ${scheme}`);
      if (scheme === 'light') {
        await failed.getByRole('button', { name: 'Retry' }).click();
        await expect.poll(() => writes.map((w) => [w.method, w.path, JSON.stringify(w.body)])).toEqual([['POST', `/v1/intel/items/${encodeURIComponent(READ_IDS.failed)}/read`, '{"depth":"standard"}']]);
        expect(writes[0]!.key).toMatch(/\S{16,}/);
      }
    }
  });

  it('Add post: the text and the depth with an Idempotency-Key; the sheet closes and says so; the reel is "Already saved."', async () => {
    writes = [];
    const { page, watch } = await open('/intel');
    await page.getByRole('region', { name: 'Reading' }).waitFor();
    const add = page.getByRole('button', { name: 'Add', exact: true });
    await add.click();
    const sheet = page.getByRole('dialog', { name: 'Add post' });
    await sheet.waitFor();
    await sheet.getByText('A reel, video, post, article, PDF or any link, or just text.').waitFor();
    await sheet.getByLabel('Link or text').fill('https://www.example.com/reel/Qw3rTy12345/ the paneer one');
    await sheet.getByRole('group', { name: 'Depth' }).getByRole('button', { name: 'Full' }).click();
    await sheet.getByText('Standard, plus what is said and links in your note').waitFor();
    expect(await overflow(page), 'the sheet').toEqual([]);
    await sheet.getByRole('button', { name: 'Save' }).click();
    await sheet.waitFor({ state: 'hidden' });
    await page.getByText('Saved. Reading it on your Mac.').waitFor();
    const save = writes.filter((w) => w.path === '/v1/intel/reads');
    expect(save.map((w) => w.body)).toEqual([{ text: 'https://www.example.com/reel/Qw3rTy12345/ the paneer one', depth: 'full' }]);
    expect(save[0]!.key).toMatch(/\S{16,}/);

    await add.click();
    await sheet.waitFor();
    await sheet.getByLabel('Link or text').fill(DAL_URL);
    await sheet.getByRole('button', { name: 'Save' }).click();
    await sheet.getByText('Already saved.', { exact: true }).waitFor();
    expect(await sheet.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(`/intel?item=${encodeURIComponent(READ_IDS.dal)}`);
    await sheet.getByRole('button', { name: 'Read again as Standard' }).waitFor();
    await check(page, watch, 'Add post');
  });

  it("the reel's page, light and dark: pictures, Open original, the read, the parts, the transcript folded; Delete after a second tap", async () => {
    for (const scheme of ['light', 'dark'] as const) {
      writes = [];
      const { page, watch } = await open(`/intel?item=${encodeURIComponent(READ_IDS.dal)}`, scheme);
      await page.getByRole('heading', { level: 1, name: 'Three ways to cook dal at home' }).waitFor();
      await loaded(page, '[aria-label="Pictures"]', 4);
      await page.getByText('@example_cook · Instagram · ', { exact: false }).waitFor();
      const original = page.getByRole('link', { name: 'Open original' });
      expect(await original.getAttribute('href')).toBe(DAL_URL);
      expect(await original.getAttribute('target')).toBe('_blank');
      expect(await original.getAttribute('rel')).toBe('noopener noreferrer');
      await page.getByText('Read at Full', { exact: true }).waitFor();
      const headings = await page.locator('article h2').allTextContents();
      expect(headings).toEqual(['What it is', 'Key points', 'Caption', 'On screen', 'Why it matters', 'Transcript', 'From Claude, not from the post', 'Your note']);
      expect(await page.getByText('[0:00] Three ways to make dal', { exact: false }).count()).toBe(0);
      await check(page, watch, `item ${scheme}`);
      if (scheme === 'dark') continue;
      await page.getByRole('button', { name: 'Transcript' }).click();
      await page.getByText('[0:00] Three ways to make dal', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Picture 2 of 4' }).click();
      const view = page.getByRole('dialog', { name: 'Picture 2 of 4' });
      await view.waitFor();
      await loaded(page, '[role="dialog"]', 1);
      await page.keyboard.press('Escape');
      await view.waitFor({ state: 'hidden' });
      await check(page, watch, 'the larger picture');
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      expect(writes.filter((w) => w.method === 'DELETE')).toEqual([]);
      await page.getByRole('button', { name: 'Delete for good' }).click();
      await page.getByRole('region', { name: 'Reading' }).waitFor();
      expect(writes.filter((w) => w.method === 'DELETE').map((w) => w.path)).toEqual([`/v1/intel/items/${encodeURIComponent(READ_IDS.dal)}`]);
      expect(new URL(page.url()).pathname).toBe('/intel');
    }
  });
});
