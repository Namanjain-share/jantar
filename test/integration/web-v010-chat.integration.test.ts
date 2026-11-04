/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * v0.10 Chat in the BUILT web app (spec 0.10 B14, B15), in a real headless
 * Chromium served by jantard itself (in-process on a synthetic HOME,
 * harness.ts) with its real headers and the build's strict policy. The
 * thread is made by real turns: the fake claude through the real bridge and
 * dispatcher (a todo added, a café rated, a visit logged, a delete waiting
 * for its Confirm, named Delete since 0.12, a photo). Each browser pairs the way a phone does.
 *
 * - At 320 px, 390 px and 1440 px, light and dark: the empty thread, the
 *   thread with a reply, changes, a card and a photo, and the composer with
 *   two photo chips. No console message about the Content Security Policy,
 *   no console error, no data: image, `window.__pwned` never set, and
 *   nothing sticking out past the viewport's sides.
 * - Two photos picked in the app upload (the chips finish), Send sends them
 *   and the turn has both.
 * - A photo that didn't upload: a glyph on its chip, the reason on its own
 *   line under the row (inside 320 px), Send held until × takes it off.
 * - An Undo refused at 320 px (changed since): the reason under the row at
 *   full width, the label still shown, no Undo left.
 * - /ask lands on /chat.
 * - Under a coarse pointer (the 320 px phone) every target is 44 px tall:
 *   the photo button, Send, Undo, Confirm, Dismiss; a chip's × is small to
 *   see with a 44 px hit area.
 *
 * 0.12.1: a phone's steps run in onPaired (browser.ts): a phone that loses
 * its coarse pointer (Chromium dropping Playwright's touch emulation) gets it
 * back in the same page and the steps go on; only if it won't come back is it
 * opened again as the same device and the steps run once more; twice fails,
 * saying so. Once the refused Undo was tried, it can't be taken twice: past
 * it the test fails at once.
 *
 * Every name and value is synthetic. Needs a built dist/ and a Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { chatText, makePng, perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, type ChatList, type PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { DESK, browserReady, clean, onPaired, overflow, stillTouch, touchPage, watchConsole, type Rerun, type StorageState, type Viewport, type Watch } from './browser.js';
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
    await clean(page, watch, what);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned), what).toBeUndefined();
    expect(await page.evaluate(() => [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('data:')).length), what).toBe(0);
    expect(await overflow(page, what), what).toEqual([]);
  }

  /** A context paired as a phone scanning the Mac's code would be; 0.12.1: or, with `state`, that device again in a new one. */
  async function paired(who: Who, state?: StorageState): Promise<{ ctx: BrowserContext; page: Page; watch: Watch }> {
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
      ...(state ? { storageState: state } : {}),
    });
    const page = await ctx.newPage();
    if (vp.phone) touchPage(page);
    const watch = watchConsole(page);
    if (state) return { ctx, page, watch };
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: who, scopes: ['read', 'control'] });
    await page.goto(`http://127.0.0.1:${d.port}/pair#c=${start.code}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Paired' }).waitFor();
    watch.errors.length = 0;
    return { ctx, page, watch };
  }

  /**
   * 0.12.1: `steps` on `who`'s page; a phone that drops its touch emulation gets it back in place, or else is
   * opened again as the same device and they run once more (`rerun`: unless past what can't be done twice).
   */
  const on = (who: Who, what: string, steps: (p: { page: Page; watch: Watch }) => Promise<void>, rerun: Rerun = {}) =>
    onPaired(what, () => pages[who]!, async (state) => (pages[who] = await paired(who, state)), steps, rerun);

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
      await on(v.who, `empty ${v.who} ${v.scheme}`, async ({ page, watch }) => {
        await page.emulateMedia({ colorScheme: v.scheme });
        await page.goto(`http://127.0.0.1:${d.port}/ask`, { waitUntil: 'load' });
        await page.getByText('Ask Jantar anything, or tell it what to add or change.').waitFor();
        expect(new URL(page.url()).pathname).toBe('/chat');
        await check(page, watch, `empty ${v.who} ${v.scheme}`);
      });
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
      await on(v.who, `thread ${v.who} ${v.scheme}`, async ({ page, watch }) => {
        await page.emulateMedia({ colorScheme: v.scheme });
        await page.goto(`http://127.0.0.1:${d.port}/chat`, { waitUntil: 'load' });
        await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
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
        if (v.who === 'p390' && v.scheme === 'light') {
          // Both finish uploading, then Send sends them with the message.
          await eventually(async () => ((await chips.getByLabel('Uploading').count()) === 0 ? true : null), perfBudgetMs(15_000), 'the uploads');
          expect(await page.getByText(/didn't upload/).count()).toBe(0);
          const before = ((await call('GET', '/v1/chat')).body as ChatList).turns.length;
          await page.getByRole('textbox', { name: 'A message to Chat' }).fill(chatText('chat-photos', 'what is on these'));
          await page.getByRole('button', { name: 'Send' }).click();
          const sent = await eventually(
            async () => {
              const turns = ((await call('GET', '/v1/chat')).body as ChatList).turns;
              const t = turns.at(-1);
              return turns.length > before && t && t.state === 'done' ? t : null;
            },
            perfBudgetMs(30_000),
            'the turn with two photos',
          );
          expect(sent.photos).toHaveLength(2);
          expect(sent.reply).toMatch(/^I see 2 photo/);
          await chips.waitFor({ state: 'detached' });
        } else {
          for (let i = 0; i < 2; i++) await chips.getByRole('button', { name: 'Remove the photo' }).first().click();
        }
      });
    }
  });

  it("a photo that didn't upload: its glyph, the reason under the row inside 320 px, Send held until it is removed", async () => {
    await on('p320', "a photo that didn't upload at 320", async ({ page, watch }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`http://127.0.0.1:${d.port}/chat`, { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
      const reason = 'Chat takes photos only (JPEG, PNG, WebP or GIF).';
      await page.route('**/v1/chat/photos', (r) => r.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'refused', message: reason } }) }));
      try {
        await page.getByRole('textbox', { name: 'A message to Chat' }).fill('what is on this');
        await page.locator('input[type="file"]').setInputFiles([{ name: 'one.png', mimeType: 'image/png', buffer: makePng(40, 30) }]);
        const why = page.getByText(`A photo didn't upload: ${reason} Remove it to send.`);
        await why.waitFor();
        await page.getByLabel(`A photo that didn't upload: ${reason}`).waitFor();
        expect(await page.getByRole('button', { name: 'Send' }).isDisabled()).toBe(true);
        const box = await why.boundingBox();
        expect(box?.width ?? 0, 'the reason has the row').toBeGreaterThan(240);
        // The browser logs the 422 itself; nothing else may.
        watch.errors.splice(0, watch.errors.length, ...watch.errors.filter((e) => !/status of 422/.test(e)));
        await check(page, watch, 'a failed chip at 320');
        await page.getByRole('button', { name: 'Remove the photo' }).click();
        await why.waitFor({ state: 'detached' });
        expect(await page.getByRole('button', { name: 'Send' }).isDisabled()).toBe(false);
      } finally {
        await page.unroute('**/v1/chat/photos');
        await page.getByRole('textbox', { name: 'A message to Chat' }).fill('');
      }
    });
  });

  it("an Undo refused at 320 px: the reason under the row at full width, the label still shown, no Undo left", async () => {
    const cafe = (((await call('GET', '/v1/places')).body as { places: Array<{ id: string; name: string }> }).places.find((p) => p.name === 'Sample Dosa House') as { id: string }).id;
    /** 0.12.1: the Undo was tried: refused, it leaves none to take again. */
    let tried = false;
    await on('p320', 'an Undo refused at 320', async ({ page, watch }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`http://127.0.0.1:${d.port}/chat`, { waitUntil: 'load' });
      const row = page.getByRole('list', { name: 'What Chat changed' }).first().getByRole('listitem').filter({ hasText: 'Café · Sample Dosa House' });
      await row.waitFor();
      // Asked before the Undo, which can't be taken twice.
      await stillTouch(page, 'an Undo refused at 320');
      tried = true;
      // Changed by hand after Chat's edit: Undo is refused.
      expect((await call('PATCH', `/v1/places/${cafe}`, { stars: 2 })).status).toBe(200);
      await row.getByRole('button', { name: 'Undo' }).click();
      const why = row.getByRole('alert');
      await why.waitFor();
      expect(await why.textContent()).toBe("That changed after Chat's edit; change it back by hand.");
      const label = await row.getByText(/^Café · Sample Dosa House/).boundingBox();
      expect(label?.width ?? 0, 'the label').toBeGreaterThan(100);
      expect((await why.boundingBox())?.width ?? 0, 'the reason').toBeGreaterThan(200);
      expect(await row.getByRole('button', { name: 'Undo' }).count()).toBe(0);
      // The browser logs the 409 itself; nothing else may.
      watch.errors.splice(0, watch.errors.length, ...watch.errors.filter((e) => !/status of 409/.test(e)));
      await check(page, watch, 'an Undo refused at 320');
    }, { irreversible: () => tried });
  });

  it('under a coarse pointer every target is 44 px tall (320 px phone)', async () => {
    await on('p320', '44 px under a coarse pointer at 320', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await page.goto(`http://127.0.0.1:${d.port}/chat`, { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
      await stillTouch(page, '44 px under a coarse pointer at 320');
      const tall = async (target: Locator, what: string) => expect((await target.boundingBox())?.height ?? 0, what).toBeGreaterThanOrEqual(44);
      await tall(page.getByRole('button', { name: 'Add a photo' }), 'photo');
      await tall(page.getByRole('button', { name: 'Send' }), 'send');
      await tall(page.getByRole('button', { name: 'Undo' }).first(), 'undo');
      await tall(page.getByRole('button', { name: 'Delete', exact: true }), 'confirm');
      await tall(page.getByRole('button', { name: 'Dismiss' }), 'dismiss');
      // A chip's × shows at 24 px; touch reaches it 20 px out from its middle (its ::before), inside the chip and the gap.
      await page.locator('input[type="file"]').setInputFiles([{ name: 'one.png', mimeType: 'image/png', buffer: makePng(40, 30) }]);
      const x = page.getByRole('button', { name: 'Remove the photo' });
      await x.waitFor();
      const b = (await x.boundingBox())!;
      expect(b.width).toBeLessThanOrEqual(26);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      for (const [dx, dy] of [[-20, 0], [20, 0], [0, -20], [0, 20]] as const) {
        expect(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label') ?? null, [cx + dx, cy + dy] as const), `${dx},${dy}`).toBe('Remove the photo');
      }
      await x.click();
      await x.waitFor({ state: 'detached' });
    });
  });
});
