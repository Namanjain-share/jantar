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
 *   day 5 of the week), and 02 held (as the owner's is), so its closed phone
 *   row shows two flags, "held" and "cap 75%", side by side or wrapped.
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
 * - 0.14.0, 02's usage has no 5-hour window at all (cswap's usage for it has
 *   no fiveHour, as the owner's account 2: no 5-hour limit): its row says
 *   "no 5-hour limit", never "0", "88" or "no window open", at 320 and on
 *   a Mac (no 5-hour burn there either).
 * - 0.14.0, at 320 x 568 with touch: a switch.json that won't parse refuses
 *   the Save (409), and the reason and Save are both on screen; an edit
 *   asks "Discard what you changed?" before Esc, a scrim tap or a swipe
 *   down throws it away (the phone's bottom sheet too).
 * - 0.14.0, on an iPad (1024 x 1366 and 1180 x 820, touch) and a Mac (1440 x
 *   900): each account named as Accounts names it, 02's "Day 5 · now", a −
 *   or + edit that Esc asks about before throwing it away, Tab through the
 *   form never parking a field under the pinned Save row, and Save's receipt
 *   inside the viewport (the row is pinned at the sheet's foot), announced as
 *   a status; switch.json put back after each.
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

type Who = 'p320' | 'p390' | 'ipad' | 'ipad1180' | 'mac';
const IPAD_INSETS = { top: 24, bottom: 20 };
const SIZES: Record<Who, Viewport> = {
  p320: { width: 320, height: 568, phone: true },
  p390: { width: 390, height: 844, phone: true },
  ipad: { width: 1024, height: 1366, touch: true, insets: IPAD_INSETS },
  ipad1180: { width: 1180, height: 820, touch: true, insets: IPAD_INSETS },
  mac: { width: 1440, height: 900 },
};
const WHO: readonly Who[] = ['p320', 'p390', 'ipad', 'ipad1180', 'mac'];
/** A Mac: a fine pointer, no touch. */
const desk = (who: Who) => !SIZES[who].phone && !SIZES[who].touch;

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
        await writeFile(file, JSON.stringify({ ...raw, hold: [2, 3], weekly_ramp: { '2': USUAL } }, null, 2));
        // 0.14.0: 02 has no 5-hour limit: no five_hour in cswap's cache row, no fiveHour in `cswap list --json`.
        const cache = JSON.parse(readFileSync(home.paths.usageJson, 'utf8')) as { accounts: Record<string, { lastGood?: Record<string, unknown> }> };
        delete cache.accounts['2']?.lastGood?.five_hour;
        await writeFile(home.paths.usageJson, JSON.stringify(cache));
        const listFile = join(home.root, 'fake', 'cswap-list.json');
        const list = JSON.parse(readFileSync(listFile, 'utf8')) as { accounts: { number: number; usage: Record<string, unknown> | null }[] };
        delete list.accounts.find((a) => a.number === 2)?.usage?.fiveHour;
        await writeFile(listFile, JSON.stringify(list));
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
      isMobile: !desk(who),
      hasTouch: !desk(who),
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
    const page = desk(who) ? await ctx.newPage() : touchPage(await ctx.newPage());
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

  /** A finger down at (x, y), moved `by` px down in steps, and lifted: a swipe, as touch events over CDP. */
  async function swipeDown(page: Page, x: number, y: number, by: number) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + Math.round((by * i) / 12) }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await cdp.detach().catch(() => undefined);
    }
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
    const chrome = desk(who) ? 'desk' : SIZES[who].touch ? 'touch' : 'phone';
    if (p.chrome !== chrome) problems.push(`the ${p.chrome ?? 'no'} chrome`);
    problems.push(...sideways.map((s) => `sideways: ${s}`), ...p.sideways.map((s) => `sideways: ${s}`));
    // A Mac's pointer is fine and it has no home indicator: those two are a touch screen's.
    if (!desk(who)) {
      problems.push(...under44(p.whole).map((t) => `under 44 x 44: ${t.name} (${t.x},${t.y} ${t.w}x${t.h})`));
      problems.push(...p.fixed.filter((t) => t.y + t.h > p.vh - 24).map((t) => `in the bottom 24 px: ${t.name} (${t.x},${t.y} ${t.w}x${t.h})`));
    }
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
        if (who === 'p320') {
          // 0.14.0: closed, 02's row shows both its flags, held and its cap, each whole inside the row
          const row = o.page.getByRole('main').getByRole('listitem').filter({ has: o.page.getByRole('button', { name: '02 team-b', exact: true }) });
          // 0.14.0: no 5-hour limit, said, never a 5-hour number or "no window open"
          const said = (await row.innerText()).replace(/\s+/g, ' ');
          expect(said, "02's closed row").toContain('no 5-hour limit');
          expect(said, "02's closed row").not.toMatch(/no window open|\b(0|88) 5h/);
          expect(await row.getByRole('meter', { name: '02 team-b 5-hour usage' }).count()).toBe(0);
          const flags = row.locator('[data-flags]');
          expect(await flags.getByText('held', { exact: true }).isVisible()).toBe(true);
          expect(await flags.getByText('cap 75%', { exact: true }).isVisible()).toBe(true);
          const box = await row.boundingBox();
          for (const name of ['held', 'cap 75%']) {
            const tag = await flags.getByText(name, { exact: true }).boundingBox();
            expect(tag && box && tag.x >= box.x && tag.x + tag.width <= box.x + box.width + 0.5, `${name} inside the row`).toBe(true);
          }
        }
        const sheet = await openSheet(o.page);
        // 02's ramp is on, as switch.json has it
        expect(await sheet.getByRole('group', { name: '02 team-b' }).getByRole('textbox', { name: '02 team-b day 5' }).inputValue()).toBe('75');
        // held with a cap: its sessions leave at the cap
        await sheet.getByRole('group', { name: '02 team-b' }).getByText('With a weekly cap, its sessions leave once it passes the cap.').waitFor();
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
  it('0.14.0 at 320 x 568: a refused Save shows the reason and Save together; Esc, a scrim tap and a swipe ask first', async () => {
    let broken = false;
    await on(
      'p320',
      'Switching rules, a refusal and discarding (p320)',
      async (o) => {
        const { page } = o;
        await accounts(page);
        const sheet = await openSheet(page);
        const asking = page.getByRole('group', { name: 'Unsaved changes' });
        const keep = async () => {
          await asking.getByRole('button', { name: 'Keep editing' }).tap();
          await asking.waitFor({ state: 'hidden' });
          expect(await sheet.isVisible()).toBe(true);
        };

        // Unchanged, nothing asks: Esc closes at once.
        await page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'hidden' });
        await openSheet(page);

        // A + tap is an edit: Esc, a scrim tap and a swipe down each ask, in the bottom sheet.
        await sheet.getByRole('button', { name: 'Raise 5-hour limit' }).tap();
        expect(await sheet.getByRole('textbox', { name: '5-hour limit' }).inputValue()).toBe('98');
        await page.keyboard.press('Escape');
        await asking.waitFor();
        expect(await asking.innerText()).toContain('Discard what you changed?');
        await check(o, 'p320', 'the sheet asking before Esc throws an edit away');
        await keep();
        // the scrim: above the sheet's top
        const box = await page.locator('.sheet-popup').boundingBox();
        expect(box && box.y > 24, 'scrim above the sheet').toBe(true);
        await page.touchscreen.tap(160, Math.max(8, Math.round((box?.y ?? 40) / 2)));
        await asking.waitFor();
        await keep();
        // a swipe down from the grabber
        await swipeDown(page, 160, Math.round((box?.y ?? 40) + 10), 320);
        await asking.waitFor();
        await keep();
        expect(await sheet.getByRole('textbox', { name: '5-hour limit' }).inputValue()).toBe('98');

        // A switch.json that won't parse refuses the Save (409): the reason and Save, both in view.
        await writeFile(switchJson(), '{ "hold": [2, 3], ');
        broken = true;
        await sheet.getByRole('button', { name: 'Save', exact: true }).tap();
        const alert = sheet.getByRole('alert');
        await alert.waitFor();
        await settle(page);
        const seen = await page.evaluate(() => {
          const vh = window.innerHeight;
          const one = (el: Element | null) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 40), r.top + Math.min(r.height / 2, 10));
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), hit: hit !== null && (el.contains(hit) || hit.contains(el)) };
          };
          const row = document.querySelector('[data-switching-actions]');
          const save = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Save') ?? null;
          return { vh, alert: one(row?.querySelector('[role="alert"]') ?? null), save: one(save) };
        });
        const inView = (r: { top: number; bottom: number } | null) => r !== null && r.top >= 0 && r.bottom <= seen.vh;
        expect(inView(seen.alert), `the reason at ${seen.alert?.top}-${seen.alert?.bottom} in ${seen.vh}`).toBe(true);
        expect(inView(seen.save), `Save at ${seen.save?.top}-${seen.save?.bottom} in ${seen.vh}`).toBe(true);
        expect(seen.alert?.hit && seen.save?.hit, 'the reason and Save not covered').toBe(true);
        expect(await sheet.getByRole('textbox', { name: '5-hour limit' }).inputValue()).toBe('98'); // kept
        // the browser said the 409 in its console: that one is expected
        const others = o.watch.errors.filter((e) => !/status of 409/.test(e));
        o.watch.errors.length = 0;
        o.watch.errors.push(...others);
        await check(o, 'p320', 'the sheet after a refused Save');

        // Put the file back; Cancel (the form's own) closes at once, and nothing was written.
        await writeFile(switchJson(), seeded);
        broken = false;
        await sheet.getByRole('button', { name: 'Cancel', exact: true }).tap();
        await sheet.waitFor({ state: 'hidden' });
        expect(await readFile(switchJson(), 'utf8')).toBe(seeded);
      },
      {
        reset: async () => {
          if (broken) await writeFile(switchJson(), seeded);
          broken = false;
        },
      },
    );
    expect(await readFile(switchJson(), 'utf8')).toBe(seeded);
  }, perfBudgetMs(180_000));

  it('on an iPad and a Mac: names, today, Esc after a − or +, Tab clear of the pinned row, and the Save receipt in view', async () => {
    let saved = false;
    for (const who of ['ipad', 'ipad1180', 'mac'] as const) {
      await on(
        who,
        `Switching rules, in view (${who})`,
        async (o) => {
          const { page } = o;
          const tap = (l: ReturnType<Page['getByRole']>) => (desk(who) ? l.click() : l.tap());
          await accounts(page);
          if (who === 'mac') {
            // 0.14.0: 02's matrix row says it has no 5-hour limit, with no 5-hour meter or burn
            const row = page.getByRole('table', { name: 'Accounts' }).getByRole('row').filter({ has: page.getByRole('button', { name: '02 team-b', exact: true }) });
            const cells = (await row.getByRole('cell').allInnerTexts()).map((c) => c.replace(/\s+/g, ' ').trim());
            expect(cells[1], "02's 5H %").toBe('no 5-hour limit');
            expect(cells.join(' | '), "02's row").not.toMatch(/no window open|\+\d+%\/h/);
            expect(await row.getByRole('meter', { name: '02 team-b 5-hour usage' }).count()).toBe(0);
          }
          await tap(page.getByRole('button', { name: 'Switching rules' }));
          const sheet = page.getByRole('dialog', { name: 'Switching rules' });
          await sheet.getByRole('form', { name: 'Switching rules' }).waitFor();
          await check(o, who, 'the Switching rules sheet');

          // Named as Accounts names them: the number, then the alias or the masked email.
          const two = sheet.getByRole('group', { name: '02 team-b' });
          expect((await two.locator('p').first().innerText()).replace(/\s+/g, ' ')).toBe('02 team-b');
          const one = sheet.getByRole('group', { name: '01', exact: true });
          expect((await one.locator('p').first().innerText()).replace(/\s+/g, ' ')).toMatch(/^01 \S+@\S+$/);
          // 02 is on day 5 of its week (its reset is three days off), and says so once
          await two.getByText('Day 5 · now', { exact: true }).waitFor();
          expect(await two.getByText(/· now/).count()).toBe(1);

          // A + tap fires no input event, but it is an edit: Esc asks first.
          await tap(sheet.getByRole('button', { name: 'Raise 5-hour limit' }));
          expect(await sheet.getByRole('textbox', { name: '5-hour limit' }).inputValue()).toBe('98');
          await page.keyboard.press('Escape');
          await page.getByRole('group', { name: 'Unsaved changes' }).waitFor();
          await tap(page.getByRole('button', { name: 'Keep editing' }));
          await page.getByRole('group', { name: 'Unsaved changes' }).waitFor({ state: 'hidden' });

          // Tab through the form: a focused field is never under the pinned Save row.
          await sheet.getByRole('textbox', { name: '5-hour limit' }).focus();
          const parked: string[] = [];
          const trail: string[] = [];
          for (let i = 0; i < 120; i++) {
            await page.keyboard.press('Tab');
            const at = await page.evaluate(() => {
              const el = document.activeElement as HTMLElement | null;
              const row = document.querySelector('[data-switching-actions]');
              const pop = row?.closest('.sheet-popup');
              if (!el || !row || !pop || !pop.contains(el)) return { done: true, name: '', bad: '' };
              if (row.contains(el)) return { done: true, name: '', bad: '' };
              const r = el.getBoundingClientRect();
              const a = row.getBoundingClientRect();
              const p = pop.getBoundingClientRect();
              const name = el.getAttribute('aria-label') ?? (el.textContent?.trim().slice(0, 40) || el.tagName);
              if (el === pop) return { done: false, name: 'the sheet', bad: '' }; // the dialog itself, not a field
              const bad = r.bottom > a.top + 0.5 ? `under the row (${Math.round(r.bottom)} > ${Math.round(a.top)})` : r.top < p.top - 0.5 ? 'above the sheet' : '';
              return { done: false, name, bad };
            });
            if (at.done) break;
            trail.push(at.name);
            if (at.bad) parked.push(`${at.name}: ${at.bad}`);
          }
          expect(parked, `${who}: Tab ${trail.join(' > ')}`).toEqual([]);

          // Save: its receipt is in the pinned row, inside the viewport, as a status.
          await tap(sheet.getByRole('button', { name: 'Save', exact: true }));
          saved = true;
          const receipt = sheet.getByText(SAVED, { exact: true });
          await receipt.waitFor();
          expect(JSON.parse(await readFile(switchJson(), 'utf8'))).toMatchObject({ ceiling: 98 });
          const seen = await receipt.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 40), r.top + r.height / 2);
            return {
              top: r.top,
              bottom: r.bottom,
              vh: window.innerHeight,
              status: el.closest('[role="status"]') !== null,
              pinned: el.closest('.sheet-actions') !== null,
              hit: hit !== null && (el.contains(hit) || hit.contains(el) || el.parentElement?.contains(hit) === true),
            };
          });
          expect(seen, `${who}: the receipt`).toMatchObject({ status: true, pinned: true, hit: true });
          expect(seen.top >= 0 && seen.bottom <= seen.vh, `${who}: the receipt at ${Math.round(seen.top)}-${Math.round(seen.bottom)} in ${seen.vh}`).toBe(true);
          expect(await sheet.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true); // nothing left to save
          await check(o, who, 'the sheet after Save');

          // Saved: Esc closes at once, and switch.json goes back as seeded for the next size.
          await page.keyboard.press('Escape');
          await sheet.waitFor({ state: 'hidden' });
          await writeFile(switchJson(), seeded);
          saved = false;
        },
        {
          reset: async () => {
            if (saved) await writeFile(switchJson(), seeded);
            saved = false;
          },
        },
      );
    }
    expect(await readFile(switchJson(), 'utf8')).toBe(seeded);
  }, perfBudgetMs(300_000));
});
