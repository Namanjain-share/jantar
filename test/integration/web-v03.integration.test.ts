/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The v0.3 screens of the BUILT web app in a real headless Chromium, under
 * the daemon's real headers plus the build's strict <meta> policy (spec 6
 * W2, 8.1 "CSP and visual"; direction.md rules 16 and 27):
 *
 * - every screen loads with no console message about the Content Security
 *   Policy, no console error and no <style> element, and nothing on it
 *   sticks out past a 390 px phone;
 * - the start sheet with the flags picker (the command line follows the
 *   picks; the hold starts a launch with structured flags only), the trust
 *   card, the Rewrite sheet (review, then Send with the job id), the
 *   control bar with its two lazy menus, and the Screen tab's Picture | Text;
 * - the Files viewer on a .ts (Prism in its worker), a .md with a <script>,
 *   an <img onerror> and a javascript: link, an .html, an .svg with a
 *   <script> (source, then a blob: preview), a PDF (pdf.js and its worker,
 *   with the standard fonts it fetches from this origin) and an .ipynb with
 *   HTML, JavaScript and PNG outputs. Nothing in them runs: `__pwned`
 *   stays unset;
 * - the lazy chunks: /files, /new, the session Files tab and the Board
 *   row's menu;
 * - in grayscale, the board's six states and the two ghost rows (a launch
 *   at its trust dialog, one still opening) stay apart: by glyph shape and
 *   rail word, and for the ghosts, which share the Starting rail, by the
 *   stage words on their second line.
 *
 * Every v0.3 route answers from web-fixture-v03.ts. Needs a built dist/ and
 * a Chromium (browser.ts says how).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { DESK, DIST, PHONE, browserReady, clean, grayscale, grayscaleKey, overflow, pageOpener, type Viewport, type Watch } from './browser.js';
import { PATHS, webFixtureV03, type WebFixtureV03 } from './web-fixture-v03.js';
import { serveWebApp, type WebServer } from './web-server.js';

const ready = await browserReady('web-v03.integration');

const DARK_PHONE: Viewport = { ...PHONE, scheme: 'dark' };

const filesPath = (rel: string) => `/files?root=r.work&path=${encodeURIComponent(rel)}`;

describe.skipIf(!ready)('the v0.3 screens in Chromium', () => {
  let server: WebServer;
  let browser: Browser;
  let pages: ReturnType<typeof pageOpener>;
  let fixture: WebFixtureV03;
  const open = (path: string, o: Viewport) => pages.open(path, o);

  beforeAll(async () => {
    browser = await chromium.launch();
    // A real PNG for the terminal screenshot, the notebook's image output and the Markdown's image.
    const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
    const p = await ctx.newPage();
    await p.setContent('<body style="margin:0;background:#1e1e2e;color:#e6e1d6;font:16px monospace"><pre style="margin:16px">> fix the login redirect\n\n  Grep(Set-Cookie)\n  Found 2 files</pre></body>');
    const png = await p.screenshot({ type: 'png' });
    await ctx.close();
    fixture = webFixtureV03(png);
    server = await serveWebApp(DIST, () => fixture);
    pages = pageOpener(browser, () => server.base);
  }, 30_000);

  afterAll(async () => {
    await pages?.close();
    await browser?.close().catch(() => undefined);
    await server?.close();
  }, 30_000);

  /** Clean console, no <style>, nothing ran, nothing past the sides of the viewport. */
  async function check(page: Page, watch: Watch) {
    // Sheets and pushed screens finish sliding in first.
    await page.waitForTimeout(500);
    await clean(page, watch);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
    expect(await overflow(page)).toEqual([]);
  }

  /** The v0.3 paths the fixture had no answer for (a screen asked for something it should not). */
  const v03Misses = () => server.misses.filter((m) => /\/v1\/(files|folders|launch|rewrite|sessions\/[^/]+\/(changes|screenshot|keys|mode|command|rewrite))/.test(m));

  it('the start sheet: the command line follows the flag picks, and the hold sends structured flags', async () => {
    for (const vp of [DARK_PHONE, DESK]) {
      const { page, watch } = await open('/new?root=r.work&path=api-server&start=1', vp);
      const command = page.locator('[data-command]');
      await expect.poll(() => command.textContent()).toContain('--dangerously-skip-permissions --chrome --effort ultracode');
      await page.getByText("Claude won't ask before running commands in this session.").waitFor();
      await check(page, watch);

      await page.getByRole('radiogroup', { name: 'Permissions' }).getByRole('radio', { name: 'Plan' }).click();
      await page.getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'high', exact: true }).click();
      await expect.poll(() => command.textContent()).toContain('--permission-mode plan --chrome --effort high');
      await page.getByText('An account move restarts it with ultracode effort').first().waitFor();
      expect(await page.getByText("Claude won't ask before running commands in this session.").count()).toBe(0);
      await check(page, watch);
    }

    // Hold to start (1.2 s for plan): one POST with the picks as data, and the receipt takes over.
    const { page, watch } = await open('/new?root=r.work&path=api-server&start=1', DARK_PHONE);
    await page.getByRole('radiogroup', { name: 'Permissions' }).getByRole('radio', { name: 'Plan' }).click();
    await expect.poll(() => page.locator('[data-command]').textContent()).toContain('--permission-mode plan');
    const hold = page.getByRole('button', { name: 'Hold to start' });
    await hold.hover();
    await page.mouse.down();
    await page.waitForTimeout(1_600);
    await page.mouse.up();
    await page.waitForURL(/launch=/);
    await page.locator('[data-step="opening"]').first().waitFor();
    const start = server.writes.filter((w) => w.method === 'POST' && w.path === '/v1/launches');
    expect(start).toHaveLength(1);
    expect(Object.keys(start[0]!.body as object).sort()).toEqual(['account', 'flags', 'path', 'root']);
    expect((start[0]!.body as { flags: unknown }).flags).toEqual({ permission: 'plan', chrome: true, effort: 'ultracode', model: 'default' });
    await check(page, watch);
    expect(v03Misses()).toEqual([]);
  });

  it('the trust card: a ghost row on the board opens the receipt with the dialog as a card', async () => {
    const { page, watch } = await open('/', DARK_PHONE);
    const ghost = page.locator(`[data-launch="${fixture.dialogLaunch}"]`);
    await ghost.waitFor();
    expect(await ghost.textContent()).toMatch(/Do you trust|trust/i);
    await check(page, watch);
    await ghost.click();
    await page.getByRole('button', { name: 'Yes, proceed' }).waitFor();
    await page.getByRole('button', { name: 'No, exit' }).waitFor();
    await page.getByLabel('The window on the Mac').waitFor();
    await check(page, watch);

    const desk = await open(`/new?root=r.work&launch=${fixture.dialogLaunch}`, DESK);
    await desk.page.getByRole('button', { name: 'Yes, proceed' }).waitFor();
    await check(desk.page, desk.watch);
    // Nothing is answered without a tap.
    expect(server.writes.filter((w) => w.path.endsWith('/answer'))).toEqual([]);
    expect(v03Misses()).toEqual([]);
  });

  it('the Rewrite sheet: what was said, the written prompt to review, then Send with the job id', async () => {
    const said = 'fix the login redirect loop, the cookie thing, and add a test';
    const { page, watch } = await open(`/s/${encodeURIComponent(fixture.workSid)}`, PHONE);
    const box = page.getByPlaceholder(/Send a prompt to/);
    await box.fill(said);
    await page.getByRole('button', { name: 'Rewrite as a prompt' }).click();
    const sheet = page.getByRole('dialog', { name: /Rewrite for/ });
    await sheet.waitFor();
    await expect.poll(() => sheet.locator('textarea').inputValue()).toBe(fixture.v03.rewrite.prompt);
    await sheet.getByText(said).waitFor();
    await sheet.getByRole('list', { name: 'Not in what you said' }).waitFor();
    await check(page, watch);

    await sheet.getByRole('button', { name: 'Send', exact: true }).click();
    // The receipt shows for a moment, then the sheet closes on its own.
    await sheet.waitFor({ state: 'detached', timeout: 5_000 });
    const sent = server.writes.filter((w) => w.method === 'POST' && w.path.endsWith('/prompt'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ text: fixture.v03.rewrite.prompt, onDraft: 'refuse', rewriteJobId: 'rw-e2e-0001' });
    await check(page, watch);
    expect(v03Misses()).toEqual([]);
  });

  it('the control bar: the mode chip and the commands menu (both lazy) under the CSP', async () => {
    for (const vp of [PHONE, { ...DESK, scheme: 'dark' as const }]) {
      const { page, watch } = await open(`/s/${encodeURIComponent(fixture.workSid)}`, vp);
      await page.getByRole('group', { name: 'Controls' }).waitFor();
      // The chip says the session's own mode.
      const chip = page.getByRole('button', { name: 'Permission mode: Accept edits' });
      await chip.waitFor();
      await check(page, watch);

      await chip.click();
      await page.getByRole('menu', { name: 'Permission modes' }).waitFor();
      await check(page, watch);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Commands' }).click();
      await page.getByRole('menu', { name: 'Slash commands' }).waitFor();
      await check(page, watch);
      await page.keyboard.press('Escape');
      // Looking is not pressing.
      expect(server.writes.filter((w) => /\/(keys|mode|command)$/.test(w.path))).toEqual([]);
    }
    expect(v03Misses()).toEqual([]);
  });

  it("the Screen tab's Picture | Text: the screenshot through a blob: URL, then the text peek", async () => {
    const { page, watch } = await open(`/s/${encodeURIComponent(fixture.workSid)}?view=screen`, DARK_PHONE);
    const choice = page.getByRole('group', { name: 'Show the screen as' });
    await choice.waitFor();
    const img = page.locator('img[src^="blob:"]').first();
    await img.waitFor();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByText(/captured/).first().waitFor();
    await check(page, watch);

    await choice.getByRole('button', { name: 'Text' }).click();
    await page.getByText('Grep(Set-Cookie)').waitFor();
    await check(page, watch);
    expect(v03Misses()).toEqual([]);
  });

  describe('the Files viewer', () => {
    it('a .ts file: highlighted by Prism in its worker', async () => {
      for (const vp of [PHONE, DESK]) {
        const { page, watch } = await open(filesPath(PATHS.ts), vp);
        await page.getByText('cookieHeader').first().waitFor();
        await page.locator('.tk-kw').first().waitFor({ timeout: 10_000 });
        expect(await page.locator('.tk-kw').count()).toBeGreaterThan(3);
        await check(page, watch);
      }
    });

    it('a .md with a <script>, an <img onerror> and a javascript: link: all text, nothing runs', async () => {
      const { page, watch } = await open(filesPath(PATHS.md), DARK_PHONE);
      await page.getByRole('heading', { name: 'Release notes (synthetic)' }).waitFor();
      await page.getByText("<script>window.__pwned = 'md-script'</script>").waitFor();
      expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
      // Its own image comes from the Mac (img-src 'self'), not from the document, and only after a tap.
      expect(await page.getByRole('img', { name: 'The screen' }).count()).toBe(0);
      await page.getByRole('button', { name: 'Show images' }).click();
      const img = page.getByRole('img', { name: 'The screen' });
      await img.waitFor();
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.querySelectorAll('script:not([src])').length)).toBe(0);
      await check(page, watch);

      await page.getByRole('group', { name: 'Show the Markdown as' }).getByRole('button', { name: 'Source' }).click();
      await page.getByText('# Release notes (synthetic)').waitFor();
      await check(page, watch);
    });

    it('an .html file: shown as highlighted source', async () => {
      const { page, watch } = await open(filesPath(PATHS.html), PHONE);
      await page.getByText('Synthetic page').first().waitFor();
      await page.locator('.tk-tag').first().waitFor({ timeout: 10_000 });
      await check(page, watch);
    });

    it('an .svg with a <script>: source first, then a blob: preview in which nothing runs', async () => {
      const { page, watch } = await open(filesPath(PATHS.svg), DARK_PHONE);
      await page.getByText("window.__pwned = 'svg-script'").first().waitFor();
      await check(page, watch);
      await page.getByRole('group', { name: 'Show the SVG as' }).getByRole('button', { name: 'Preview' }).click();
      const img = page.locator('img[src^="blob:"]');
      await img.waitFor();
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(240);
      await check(page, watch);
    });

    it('a PDF: pdf.js and its worker draw it, with the standard fonts from this origin', async () => {
      for (const vp of [PHONE, DESK]) {
        const { page, watch } = await open(filesPath(PATHS.pdf), vp);
        await page.getByRole('button', { name: 'Open', exact: true }).click();
        const canvas = page.locator('canvas').first();
        await canvas.waitFor({ timeout: 15_000 });
        // Ink on the page: the text was drawn (as paths, from the font files).
        await expect
          .poll(
            () =>
              canvas.evaluate((el) => {
                const c = el as HTMLCanvasElement;
                const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
                if (!d) return 0;
                let ink = 0;
                for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 0 && d[i]! < 128 && d[i + 1]! < 128 && d[i + 2]! < 128) ink += 1;
                return ink;
              }),
            { timeout: 15_000 },
          )
          .toBeGreaterThan(200);
        await check(page, watch);
      }
      const assets = server.requests.filter((r) => r.startsWith('GET /assets/'));
      expect(assets.some((r) => /\/pdf\.worker\.min-[^/]+\.mjs$/.test(r))).toBe(true);
      expect(assets.some((r) => /\/LiberationSans-Regular-[^/]+\.ttf$/.test(r))).toBe(true);
      expect(assets.some((r) => /\/FoxitSerif-[^/]+\.pfb$/.test(r))).toBe(true);
    });

    it('an .ipynb: code highlighted, the PNG output shown, HTML and JavaScript outputs only labelled', async () => {
      const { page, watch } = await open(filesPath(PATHS.ipynb), PHONE);
      await page.getByRole('heading', { name: 'Weekly numbers' }).waitFor();
      await page.locator('.tk-kw').first().waitFor({ timeout: 10_000 });
      const img = page.locator('img[src^="blob:"]').first();
      await img.waitFor();
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      expect(await page.locator('b', { hasText: 'bold' }).count()).toBe(0);
      await check(page, watch);
    });
  });

  it('the lazy chunks: /files and /new from the nav, the session Files tab, and the Board row menu', async () => {
    const { page, watch } = await open('/', DESK);
    const row = page.locator(`[data-sid="${fixture.workSid}"]`);
    await row.waitFor();
    // The your-turn row says how many files it changed (Files is on).
    expect(await row.locator('[data-files]').textContent()).toBe('4 files');

    await page.getByRole('link', { name: 'Files' }).first().click();
    await page.getByRole('group', { name: 'Files list' }).getByRole('button', { name: 'Changed' }).waitFor();
    await page.getByText('cookies.ts').first().waitFor();
    await check(page, watch);

    await page.goto(`${server.base}/`);
    await row.waitFor();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New session here' }).click();
    await page.waitForURL(/\/new\?/);
    expect(new URL(page.url()).searchParams.get('root')).toBe(`s.${fixture.workSid}`);
    await page.locator('[data-command]').waitFor();
    await check(page, watch);

    const tab = await open(`/s/${encodeURIComponent(fixture.workSid)}?view=files`, PHONE);
    await tab.page.getByText('cookies.ts').first().waitFor();
    await tab.page.getByText('cookies.ts').first().click();
    await tab.page.getByText('cookieHeader').first().waitFor();
    await check(tab.page, tab.watch);
    // On a phone the open file has the screen (spec 5.2.3): no control bar or composer below the code.
    expect(await tab.page.getByRole('group', { name: 'Controls' }).count()).toBe(0);
    const code = await tab.page.locator('[data-scroller]').first().boundingBox();
    expect(code?.height ?? 0).toBeGreaterThanOrEqual(PHONE.height * 0.5);
    expect(v03Misses()).toEqual([]);
  });

  it('in grayscale, the six states and the two ghost rows stay apart by glyph shape plus the rail word', async () => {
    const { page } = await open('/', DESK);
    await page.locator('[data-sid]').nth(14).waitFor();
    await page.locator('[data-launch]').nth(1).waitFor();
    await grayscale(page);
    const seen = new Map<string, string>();
    const rows: Array<[string, string]> = [
      ...['needs', 'turn', 'working', 'compacting', 'stale', 'ended'].map((st): [string, string] => [st, `[data-sid][data-glyph="${st}"]`]),
      ['trust dialog', `[data-launch="${fixture.dialogLaunch}"]`],
      ['opening', `[data-launch="${fixture.openingLaunch}"]`],
    ];
    for (const [what, selector] of rows) {
      const row = page.locator(selector).first();
      let key = await grayscaleKey(row);
      // Ghost rows share the Starting rail; a dialog turns the glyph needs-you and line 2 says what
      // Claude asks, so their stage reads in words there ("Claude asks: …", "opening a window").
      if (selector.startsWith('[data-launch')) key += `|${await row.locator('.type-mono span span').first().textContent()}`;
      expect(seen.get(key), `${what} looks the same as ${seen.get(key)} in grayscale`).toBeUndefined();
      seen.set(key, what);
    }
    expect(seen.size).toBe(8);
  });
});
