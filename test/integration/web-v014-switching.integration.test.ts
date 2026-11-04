/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * 0.14.0 Switching rules on a phone and an iPad, in the BUILT web app, in a
 * real headless Chromium served by jantard itself (in-process on a synthetic
 * HOME with the legacy ccw tool's files, harness.ts). Each browser pairs the
 * way a phone does, with read and control.
 *
 * - switch.json starts with a weekly ramp for account 02 (the usual week), so
 *   its row says "cap 75%" (the fake cswap's weekly reset is three days off:
 *   day 5 of the week).
 * - At 320 x 568 and 390 x 844 with touch, and on an iPad (1024 x 1366, touch,
 *   the Home Screen app's safe areas): Accounts, then the Switching rules
 *   sheet from its button, each checked: a clean console, nothing sideways,
 *   no target wholly on screen under 44 x 44, nothing that stays put in the
 *   bottom 24 px (on the iPad, nor under its status bar), the chrome of the
 *   size.
 * - At 390: account 01's weekly cap turned on (the usual week), its day 5
 *   raised to 80, Save, the receipt, then the fake home's switch.json read
 *   back: 01's ramp as saved, 02's left as it was, every other key as it was,
 *   the old file in switch.json.prev; and back on Accounts, 01 says "cap 80%".
 *
 * A step that changes the Mac (the Save) runs in onPaired (browser.ts): a
 * page that loses its coarse pointer gets it back in place; if it won't,
 * `reset` puts switch.json back and the steps run again as the same device.
 * Run it with JANTAR_TOUCH_DROP=every as well. Needs a built dist/ and
 * Playwright's Chromium. Every name and address is made up (example.com).
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { perfBudgetMs } from '@jantar/fixtures';
import type { PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { under44 } from '../../packages/web/test/layout-metric.js';
import { IPAD_UA, browserReady, clean, launchBrowser, onPaired, overflow, touchPage, watchConsole, type Rerun, type StorageState, type Viewport, type Watch } from './browser.js';
import { bootDaemon, type Daemon } from './harness.js';
import { eventually } from './http.js';
import { probeLayout, type Probe } from './layout-probe.js';

const ready = await browserReady('web-v014-switching.integration');

type Who = 'p320' | 'p390' | 'ipad';
const IPAD_INSETS = { top: 24, bottom: 20 };
const SIZES: Record<Who, Viewport> = {
  p320: { width: 320, height: 568, phone: true },
  p390: { width: 390, height: 844, phone: true },
  ipad: { width: 1024, height: 1366, touch: true, insets: IPAD_INSETS },
};
const WHO: readonly Who[] = ['p320', 'p390', 'ipad'];

const USUAL = { days: [50, 50, 50, 50, 75, 85, 95], last_hour: 100 };
const SAVED = 'Saved. ccw uses it within a minute.';

interface Opened {
  ctx: BrowserContext;
  page: Page;
  watch: Watch;
}

describe.skipIf(!ready)('0.14.0 Switching rules on a phone and an iPad, in Chromium, served by jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let browser: Browser;
  /** switch.json as the suite seeded it (with 02's ramp). */
  let seeded = '';
  const pages: Partial<Record<Who, Opened>> = {};
  const base = () => `http://127.0.0.1:${d.port}`;
  const switchJson = () => d.ctx.paths.ccwSwitchJson;

  beforeAll(async () => {
    d = await bootDaemon({
      home: { ccw: true, sessions: [] },
      before: async (home) => {
        const file = join(home.paths.ccwDir, 'switch.json');
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        await writeFile(file, JSON.stringify({ ...raw, weekly_ramp: { '2': USUAL } }, null, 2));
      },
    });
    seeded = await readFile(switchJson(), 'utf8');
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'ctl.sock');
    browser = await launchBrowser();
    for (const who of WHO) pages[who] = await paired(who);
  }, perfBudgetMs(120_000));

  afterAll(async () => {
    for (const p of Object.values(pages)) await p?.ctx.close().catch(() => undefined);
    await browser?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  /** A context paired as a phone (or an iPad) scanning the Mac's code; or, with `state`, that device again in a new one. */
  async function paired(who: Who, state?: StorageState): Promise<Opened> {
    const vp = SIZES[who];
    const ipad = vp.touch === true;
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      ...(ipad ? { userAgent: IPAD_UA } : {}),
      colorScheme: 'light',
      reducedMotion: 'reduce',
      locale: 'en-GB',
      timezoneId: 'UTC',
      serviceWorkers: 'block',
      ...(state ? { storageState: state } : {}),
    });
    if (ipad) {
      await ctx.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true });
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true });
      });
    }
    const page = touchPage(await ctx.newPage());
    await safeAreas(page, vp.insets);
    const watch = watchConsole(page);
    if (state) return { ctx, page, watch };
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: `phone ${who}`, scopes: ['read', 'control'] });
    await page.goto(`${base()}/pair#c=${start.code}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Paired' }).waitFor();
    watch.errors.length = 0; // the 401s before the claim
    return { ctx, page, watch };
  }

  const insetSessions = new WeakMap<Page, CDPSession>();
  /** The iPad's safe areas on `page`, set (again: a dropped touch can take them along) and seen in effect. */
  async function safeAreas(page: Page, insets: Viewport['insets']) {
    if (!insets) return;
    let cdp = insetSessions.get(page);
    if (!cdp) {
      cdp = await page.context().newCDPSession(page);
      insetSessions.set(page, cdp);
    }
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: insets.top, bottom: insets.bottom, left: 0, right: 0 } });
    const seen = await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.paddingTop = 'env(safe-area-inset-top, 0px)';
      el.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
      document.documentElement.append(el);
      const cs = getComputedStyle(el);
      const out = { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) };
      el.remove();
      return out;
    });
    expect(seen, `the iPad's safe areas on ${page.url()}`).toEqual(insets);
  }

  const on = (who: Who, what: string, steps: (o: Opened) => Promise<void>, rerun: Rerun = {}) =>
    onPaired(what, () => pages[who]!, async (state) => (pages[who] = await paired(who, state)), steps, rerun);

  /** A sheet finishes moving (reduced motion: it fades), then a beat for the layout. */
  async function settle(page: Page) {
    await page.evaluate(() => void ((window as unknown as { __jantarStill?: number }).__jantarStill = 0));
    await page
      .waitForFunction(
        () => {
          const w = window as unknown as { __jantarStill?: number };
          const moving =
            document.querySelector('[data-starting-style], [data-ending-style]') !== null ||
            document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
          w.__jantarStill = moving ? 0 : (w.__jantarStill ?? 0) + 1;
          return w.__jantarStill >= 2;
        },
        null,
        { timeout: 5_000, polling: 50 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(150);
  }

  /** The usual checks on one screen (web-v013-phone's): console, sideways, 44 x 44, the bottom 24 px, the iPad's status bar, the chrome. */
  async function check(o: Opened, who: Who, what: string) {
    const { page, watch } = o;
    const at = `${what} (${who})`;
    await settle(page);
    await clean(page, watch, at);
    await safeAreas(page, SIZES[who].insets);
    expect(await page.evaluate(() => document.querySelectorAll('[data-chrome]').length), `${at}: the app's shell`).toBe(1);
    const sideways = await overflow(page, at);
    const p: Probe = await page.evaluate(probeLayout);
    const problems: string[] = [];
    if (p.chrome !== (who === 'ipad' ? 'touch' : 'phone')) problems.push(`the ${p.chrome ?? 'no'} chrome`);
    problems.push(...sideways.map((s) => `sideways: ${s}`), ...p.sideways.map((s) => `sideways: ${s}`));
    problems.push(...under44(p.whole).map((t) => `under 44 x 44: ${t.name} (${t.w}x${t.h})`));
    problems.push(...p.fixed.filter((t) => t.y + t.h > p.vh - 24).map((t) => `in the bottom 24 px: ${t.name} (${t.x},${t.y} ${t.w}x${t.h})`));
    const insets = SIZES[who].insets;
    if (insets) problems.push(...p.fixed.filter((t) => t.y < insets.top).map((t) => `under the status bar: ${t.name} (${t.x},${t.y} ${t.w}x${t.h})`));
    if (p.whole.length === 0) problems.push('no target measured');
    if (problems.length) {
      const file = join(tmpdir(), `jantar-web-v014-${who}-${what.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
      await page.screenshot({ path: file }).catch(() => undefined);
      problems.push(`(the page: ${file})`);
    }
    expect(problems, at).toEqual([]);
  }

  /** Accounts, with the plan in (02's cap on its row). */
  async function accounts(page: Page) {
    await page.goto(`${base()}/accounts`, { waitUntil: 'load' });
    await page.getByRole('heading', { level: 1, name: 'Accounts' }).waitFor({ state: 'attached' });
    await page.getByRole('main').getByText('cap 75%').first().waitFor();
  }

  async function openSheet(page: Page) {
    await page.getByRole('button', { name: 'Switching rules' }).tap();
    const sheet = page.getByRole('dialog', { name: 'Switching rules' });
    await sheet.getByRole('form', { name: 'Switching rules' }).waitFor();
    return sheet;
  }

  it('shows the cap and opens the sheet at 320 and on an iPad, with touch', async () => {
    for (const who of ['p320', 'ipad'] as const) {
      await on(who, `Switching rules (${who})`, async (o) => {
        await accounts(o.page);
        await check(o, who, 'Accounts with a weekly cap');
        const sheet = await openSheet(o.page);
        // 02's ramp is on, as switch.json has it
        expect(await sheet.getByRole('group', { name: '02 team-b' }).getByRole('textbox', { name: '02 team-b day 5' }).inputValue()).toBe('75');
        await check(o, who, 'the Switching rules sheet');
        // the steppers of a ramp, further down, in view and checked there too
        await sheet.getByRole('button', { name: 'Fill the usual week for 02 team-b' }).scrollIntoViewIfNeeded();
        await check(o, who, 'the Switching rules sheet, scrolled to a ramp');
      });
    }
    expect(await readFile(switchJson(), 'utf8')).toBe(seeded); // looking changes nothing
  }, perfBudgetMs(180_000));

  it('at 390 with touch: a day value changed and saved lands in switch.json', async () => {
    let saved = false;
    await on(
      'p390',
      'Switching rules, a Save (p390)',
      async (o) => {
        const { page } = o;
        await accounts(page);
        await check(o, 'p390', 'Accounts with a weekly cap');
        const sheet = await openSheet(page);
        await check(o, 'p390', 'the Switching rules sheet');
        const one = sheet.getByRole('group', { name: '01', exact: true });
        await one.getByText('Weekly cap by day').tap();
        const day5 = one.getByRole('textbox', { name: '01 day 5' });
        await day5.waitFor();
        expect(await day5.inputValue()).toBe('75'); // turned on, it starts from the usual week
        await one.getByRole('button', { name: 'Raise 01 day 5' }).tap();
        expect(await day5.inputValue()).toBe('80');
        await check(o, 'p390', 'the sheet with a ramp turned on');
        await sheet.getByRole('button', { name: 'Save', exact: true }).tap();
        await sheet.getByText(SAVED).waitFor();
        saved = true;
        await check(o, 'p390', 'the sheet after Save');

        const file = JSON.parse(await readFile(switchJson(), 'utf8')) as Record<string, unknown>;
        const before = JSON.parse(seeded) as Record<string, unknown>;
        expect(file.weekly_ramp).toEqual({ '1': { days: [50, 50, 50, 50, 80, 85, 95], last_hour: 100 }, '2': USUAL });
        for (const k of Object.keys(before)) if (k !== 'weekly_ramp') expect(file[k], k).toEqual(before[k]);
        expect(Object.keys(file)).toEqual(Object.keys(before));
        expect(await readFile(`${switchJson()}.prev`, 'utf8')).toBe(seeded);

        // Close, and Accounts reads the new cap from the plan: 01 is on day 5 of its week too (its row, opened).
        await sheet.getByRole('button', { name: 'Close', exact: true }).tap();
        await sheet.waitFor({ state: 'hidden' });
        await page.getByRole('main').getByRole('button', { name: '01', exact: true }).tap();
        await page.getByRole('main').getByText(/^cap 80% · 85% /).waitFor();
        await check(o, 'p390', 'Accounts after the Save');
      },
      {
        // Put switch.json back as seeded before the steps run again in a new context.
        reset: async () => {
          if (saved) await writeFile(switchJson(), seeded);
          saved = false;
        },
      },
    );
    expect(existsSync(`${switchJson()}.prev`)).toBe(true);
  }, perfBudgetMs(180_000));
});
