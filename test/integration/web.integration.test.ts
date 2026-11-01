/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The BUILT web app in a real headless Chromium (direction.md section 6
 * "CSP regression test", rules 16, 18, 27 and 29):
 *
 * - CSP: Board, Session with the permission dock open (desktop and phone
 *   sheet), the Cmd-K palette and the Pair dialog load under the daemon's
 *   real headers plus the build's strict <meta> policy, with no console
 *   message about the Content Security Policy and no <style> element.
 * - Density gates on the 15-session / 11-account fixture: 12+ full ledger
 *   rows at 1440x900, the first phone row within 140 px of the top at
 *   390x844, every account row visible at 1440x900 without scrolling.
 * - Status never by colour alone: in grayscale, the six glyph states stay
 *   apart by glyph shape plus the rail word.
 * - theme-color matches the page background in both themes.
 *
 * The v0.3 screens have their own suite (web-v03.integration.test.ts).
 * Needs a built dist/ and a Chromium (browser.ts says how).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { perfBudgetMs } from '@jantar/fixtures';
import { DIST, browserReady, clean, grayscale, grayscaleKey, pageOpener } from './browser.js';
import { webFixture } from './web-fixture.js';
import { serveWebApp, type WebServer } from './web-server.js';

const ready = await browserReady('web.integration');

describe.skipIf(!ready)('the built web app in Chromium', () => {
  let server: WebServer;
  let browser: Browser;
  let pages: ReturnType<typeof pageOpener>;
  const fixture = webFixture();
  const open: ReturnType<typeof pageOpener>['open'] = (path, o) => pages.open(path, o);

  beforeAll(async () => {
    server = await serveWebApp(DIST, () => fixture);
    browser = await chromium.launch();
    pages = pageOpener(browser, () => server.base);
  }, perfBudgetMs(30_000));

  afterAll(async () => {
    await pages?.close();
    await browser?.close().catch(() => undefined);
    await server?.close();
  }, perfBudgetMs(30_000));

  it('Board: no CSP violation, and 12+ full ledger rows at 1440x900', async () => {
    const { page, watch } = await open('/', { width: 1440, height: 900 });
    await page.locator('[data-sid]').nth(14).waitFor();
    await page.waitForTimeout(400);
    const full = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-sid]')];
      const list = rows[0]?.parentElement;
      if (!list) return 0;
      const box = list.getBoundingClientRect();
      return rows.filter((r) => {
        const b = r.getBoundingClientRect();
        return b.height > 0 && b.top >= box.top - 0.5 && b.bottom <= Math.min(box.bottom, window.innerHeight) + 0.5;
      }).length;
    });
    expect(full).toBeGreaterThanOrEqual(12);
    await clean(page, watch);
  });

  it('Board on a phone: the first row starts within 140 px of the top at 390x844', async () => {
    const { page, watch } = await open('/', { width: 390, height: 844, phone: true, scheme: 'dark' });
    await page.locator('[data-sid]').first().waitFor();
    const top = await page.evaluate(() => document.querySelector('[data-sid]')!.getBoundingClientRect().top);
    expect(top).toBeLessThanOrEqual(140);
    await clean(page, watch);
  });

  it('Session with the permission dock open: no CSP violation (desktop and phone sheet)', async () => {
    for (const vp of [
      { width: 1440, height: 900 },
      { width: 390, height: 844, phone: true, scheme: 'dark' as const },
    ]) {
      const { page, watch } = await open(`/s/${encodeURIComponent(fixture.permissionSid)}`, vp);
      // v0.4.2: Claude's own words; `exact` keeps it off "Yes, and … for this session".
      await page.getByRole('button', { name: 'Yes', exact: true }).waitFor();
      await page.waitForTimeout(500);
      await clean(page, watch);
    }
  });

  it('the Cmd-K palette: no CSP violation', async () => {
    const { page, watch } = await open('/', { width: 1440, height: 900, scheme: 'dark' });
    await page.locator('[data-sid]').first().waitFor();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('dialog').waitFor();
    await page.keyboard.type('infra');
    await page.waitForTimeout(300);
    expect(await page.getByRole('option').count()).toBeGreaterThan(0);
    await clean(page, watch);
  });

  it('the Pair dialog: no CSP violation', async () => {
    const { page, watch } = await open('/devices', { width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Show pairing code' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pair a device' });
    await dialog.waitFor();
    await dialog.locator('svg').first().waitFor();
    await page.waitForTimeout(300);
    await clean(page, watch);
  });

  it('Accounts: all 11 accounts show at 1440x900 without scrolling', async () => {
    const { page, watch } = await open('/accounts', { width: 1440, height: 900, scheme: 'dark' });
    // One rowgroup per account: its first row is the account; a second row is
    // the reason in words, open for an account that runs out before its reset.
    const rows = page.locator('[role="table"][aria-label="Accounts"] [role="rowgroup"] > [role="row"]:first-child');
    await rows.nth(10).waitFor();
    const visible = await rows.evaluateAll((els) => els.filter((e) => {
      const b = e.getBoundingClientRect();
      return b.height > 0 && b.top >= 0 && b.bottom <= window.innerHeight;
    }).length);
    expect(visible).toBe(11);
    await clean(page, watch);
  });

  it('in grayscale, the six states stay apart by glyph shape plus the rail word', async () => {
    const { page } = await open('/', { width: 1440, height: 900 });
    await page.locator('[data-sid]').nth(14).waitFor();
    await grayscale(page);
    const seen = new Map<string, string>();
    for (const st of ['needs', 'turn', 'working', 'compacting', 'stale', 'ended']) {
      const key = await grayscaleKey(page.locator(`[data-sid][data-glyph="${st}"]`).first());
      expect(seen.get(key), `${st} looks the same as ${seen.get(key)} in grayscale`).toBeUndefined();
      seen.set(key, st);
    }
    expect(seen.size).toBe(6);
  });

  it('theme-color matches the page background in both themes', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const { page } = await open('/', { width: 390, height: 844, phone: true, scheme });
      await page.locator('[data-sid]').first().waitFor();
      const r = await page.evaluate((s) => {
        const meta = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].find((m) => (m.media || '').includes(s));
        const probe = document.createElement('i');
        probe.style.color = meta?.content ?? '';
        document.body.append(probe);
        const want = getComputedStyle(probe).color;
        probe.remove();
        return { want, bg: getComputedStyle(document.body).backgroundColor };
      }, scheme);
      expect(r.bg).toBe(r.want);
    }
  });
});
