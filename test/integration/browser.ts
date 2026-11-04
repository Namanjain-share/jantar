/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * What the browser checks of the built web app share
 * (web.integration.test.ts, web-v03.integration.test.ts,
 * web-v04.integration.test.ts): whether they can run here, a page opener
 * that watches the console for the Content Security Policy and for errors,
 * and the layout, grayscale and focus-order probes.
 *
 * Needs `pnpm build` (packages/web/dist) and a Chromium for playwright-core
 * (`pnpm exec playwright-core install --no-remove chromium-headless-shell`).
 * Without them the suites are skipped locally, and fail on CI.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from 'playwright-core';
import { decodePng, luma } from './png.js';

export const DIST = fileURLToPath(new URL('../../packages/web/dist', import.meta.url));

/** Whether playwright-core can start its Chromium here (the headless shell or the full browser). */
async function browserInstalled(): Promise<boolean> {
  try {
    const b = await chromium.launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}

/** 0.12.1: Playwright's own --disable-features switch, as it starts Chromium ('' when it has none), or null if that can't be read. */
let playwrightDisables: Promise<string | null> | undefined;

/**
 * 0.12.1: Chromium for a suite with touch pages, as chromium.launch() starts it but with RenderDocument off.
 *
 * With it on (Chromium's default), each cross-document navigation hands a page's DevTools sessions to the new
 * document: its copy of Playwright's Emulation agent turns touch on, and the old document's turns it off as it
 * goes, which is the likely way CI drops touch (stillTouch). With it off a same-site navigation keeps its
 * sessions, and every navigation in these suites is same-site. Shown here: with it on, touch turned off by a
 * session that leaves comes back at the next navigation (the new document's agents start from the sessions'
 * state); with it off it stays off. stillTouch turns it back on either way.
 *
 * Chromium keeps only the last --disable-features, so a second one would turn Playwright's own list back on
 * (ThirdPartyStoragePartitioning, for one: a third-party frame's storage came back partitioned). Playwright's
 * switch is read from the command line it starts a browser server with, and replaced by itself plus
 * RenderDocument. If it can't be read, the browser starts as chromium.launch() starts it.
 */
export async function launchBrowser(): Promise<Browser> {
  playwrightDisables ??= chromium.launchServer().then(
    async (server) => {
      const own = server.process().spawnargs.find((a) => a.startsWith('--disable-features=')) ?? '';
      await server.close();
      return own;
    },
    () => null,
  );
  const own = await playwrightDisables;
  if (own === null) return chromium.launch();
  return chromium.launch(own ? { ignoreDefaultArgs: [own], args: [`${own},RenderDocument`] } : { args: ['--disable-features=RenderDocument'] });
}

/** True when the suite can run; otherwise says why (and throws on CI). */
export async function browserReady(suite: string): Promise<boolean> {
  const hasDist = existsSync(`${DIST}/index.html`);
  const hasBrowser = await browserInstalled();
  if (hasDist && hasBrowser) return true;
  const why = [hasDist ? '' : 'packages/web/dist is missing (run pnpm build)', hasBrowser ? '' : 'no Chromium for playwright-core'].filter(Boolean).join('; ');
  if (process.env.CI) throw new Error(`web browser checks cannot run: ${why}`);
  console.warn(`[${suite}] skipped: ${why}`);
  return false;
}

const CSP_RE = /Content Security Policy|Refused to apply inline style|Refused to load|Refused to execute|Refused to create a worker/i;

export interface Watch {
  csp: string[];
  errors: string[];
}

export interface Viewport {
  width: number;
  height: number;
  phone?: boolean;
  scheme?: 'light' | 'dark';
  /** 0.12: a coarse pointer at any width: an iPad (its user agent too), or Chrome's device mode. */
  touch?: boolean;
  /** 0.12: the safe-area insets of the iPad's Home Screen app (the status bar, the home indicator). */
  insets?: { top: number; bottom: number };
}

/** iPadOS 26's Safari says it is a Mac; only its five touch points tell it apart (MacIntel, maxTouchPoints 5). */
export const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15';

export const DESK: Viewport = { width: 1440, height: 900 };
export const PHONE: Viewport = { width: 390, height: 844, phone: true };

/** Opens pages in fresh contexts on `base`, each watched; `close()` closes them all. */
export function pageOpener(browser: Browser, base: () => string) {
  const contexts: BrowserContext[] = [];
  const open = async (path: string, o: Viewport): Promise<{ page: Page; watch: Watch }> => {
    const ctx = await browser.newContext({
      viewport: { width: o.width, height: o.height },
      deviceScaleFactor: 2,
      isMobile: o.phone === true || o.touch === true,
      hasTouch: o.phone === true || o.touch === true,
      ...(o.touch ? { userAgent: IPAD_UA } : {}),
      colorScheme: o.scheme ?? 'light',
      locale: 'en-GB',
      serviceWorkers: 'block',
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
    if (o.phone || o.touch) touchPage(page);
    await emulateInsets(page, o);
    const watch: Watch = { csp: [], errors: [] };
    page.on('console', (m) => {
      const t = m.text();
      if (CSP_RE.test(t)) watch.csp.push(`${m.type()}: ${t}`);
      // The refused event stream and the fixture's 404s are expected; anything else is not.
      else if (m.type() === 'error' && !/WebSocket|status of 404/.test(t)) watch.errors.push(t);
    });
    page.on('pageerror', (e) => watch.errors.push(`pageerror: ${e.message}`));
    await page.goto(`${base()}${path}`, { waitUntil: 'load' });
    return { page, watch };
  };
  const close = async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
  };
  return { open, close };
}

export async function styleElements(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('style').length);
}

/**
 * 0.12.1: a touch page keeps its coarse pointer: when Chromium drops it, it is turned back on in the same page.
 *
 * Chromium sometimes drops Playwright's touch emulation part way through a context: CI's macOS run
 * 41667870706 drew the Mac's chrome at touch-1440, as the page does with no (pointer: coarse), and run
 * 41756024997 lost it on web-v04's phone after the Todos test's Delete had reached the Mac, so running the
 * steps again from the start in a new context could not find the todo they had deleted. Blink keeps one
 * touch switch per page (DevToolsEmulator), and a DevTools session whose Emulation agent turned it on turns
 * it off for the whole page as that session goes, while Playwright's own session still has it on (a second
 * CDP session shows it: touch on, detach, no coarse pointer until the next document). The likely way on CI:
 * a cross-document navigation (RenderDocument) moves each session to the new document, whose copy turns
 * touch back on, and lets the old document's copy go; when that lands after the new one, the page has none.
 * Not caught here; nothing in these tests turns touch off. launchBrowser starts the suites' Chromium with
 * RenderDocument off, which takes that hand-over away from their same-site navigations.
 *
 * So a touch page is marked (touchPage) as it opens. stillTouch(page) asks for its coarse pointer; clean()
 * and overflow() ask first, and a test asks before any step that needs the pointer or can't be taken twice.
 * When it is gone, restoreTouch turns it back on in the same page from a DevTools session of the page's own,
 * kept for the page's life (as it goes it would turn touch off again), and waits until the page and the app
 * (its data-chrome) see a coarse pointer; the steps go on from where they were. onTouch runs a test's steps
 * on a page; only when that fails (or a step fails with the pointer gone) does it close the context and run
 * the steps once more in a new one, after its `reset` has put back what they changed on the Mac. Steps past
 * one that can't be taken twice (`irreversible`) fail instead of running again; a drop in the new context
 * fails too.
 *
 * JANTAR_TOUCH_DROP simulates drops, turning the emulation off over CDP as Chromium does on CI:
 * - `every`: at each stillTouch of a touch page (each check, each ask), so between every two checked steps;
 *   each is turned back on in place.
 * - `load`: as each document of a touch page loads (the likely way on CI), so the steps go on with a fine
 *   pointer until the next stillTouch turns it back on.
 * - `stuck:N`: at the Nth stillTouch of the first try of every onTouch, and it won't come back on in place:
 *   the steps' reset and a new context, or past an irreversible step the failure that says why.
 */
const touchPages = new WeakSet<Page>();

type Drops = { mode: 'none' | 'every' | 'load' } | { mode: 'stuck'; at: number };
const DROPS: Drops = (() => {
  const v = (process.env.JANTAR_TOUCH_DROP ?? '').trim();
  if (v === '') return { mode: 'none' };
  if (v === 'every' || v === 'load') return { mode: v };
  const stuck = /^stuck:(\d+)$/.exec(v);
  if (stuck) return { mode: 'stuck', at: Number(stuck[1]) };
  throw new Error(`JANTAR_TOUCH_DROP=${v}: every, load or stuck:N`);
})();
/** The first try of the onTouch running now, its stillTouch calls counted (JANTAR_TOUCH_DROP=stuck:N). */
let firstTry: { page: Page; asks: number } | null = null;
/** Pages whose touch a simulated drop keeps off (JANTAR_TOUCH_DROP=stuck:N). */
const stuckPages = new WeakSet<Page>();

/** 0.12.1: marks `page` as a touch page (hasTouch), checked by stillTouch, clean() and overflow(). */
export function touchPage<P extends Page>(page: P): P {
  touchPages.add(page);
  if (DROPS.mode === 'load') {
    page.on('load', () => {
      dropTouch(page).then(
        () => console.warn(`[touch] JANTAR_TOUCH_DROP=load: ${page.url()}: touch emulation turned off over CDP as it loaded`),
        () => undefined,
      );
    });
  }
  return page;
}

export const hasCoarsePointer = (page: Page): Promise<boolean> => page.evaluate(() => matchMedia('(pointer: coarse)').matches);

export class TouchDropped extends Error {
  constructor(what: string, more = '') {
    super(`${what}: the browser dropped its touch emulation (no (pointer: coarse))${more}`);
    this.name = 'TouchDropped';
  }
}

/** Turns the page's touch emulation off from a DevTools session of its own, as Chromium has on CI. */
export async function dropTouch(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** 0.12.1: each touch page's own DevTools session that turns its touch back on, kept while the page lives. */
const keepers = new WeakMap<Page, Promise<CDPSession>>();

/**
 * 0.12.1: turns `page`'s touch emulation back on in the same page, as Playwright turned it on (one touch
 * point, no touch events for the mouse), and waits until the page has a coarse pointer and the app's chrome
 * is a touch screen's (touch from 640 px, the phone's below; a page with no shell has none). The session is
 * kept: detaching it would turn touch off again. False if it doesn't come back within 5 s.
 */
export async function restoreTouch(page: Page): Promise<boolean> {
  if (stuckPages.has(page)) return false;
  let keeper = keepers.get(page);
  if (!keeper) {
    keeper = page.context().newCDPSession(page);
    keepers.set(page, keeper);
  }
  try {
    await (await keeper).send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.waitForFunction(
      () => {
        if (!matchMedia('(pointer: coarse)').matches) return false;
        const shell = document.querySelector('[data-chrome]');
        return !shell || shell.getAttribute('data-chrome') === (matchMedia('(min-width: 640px)').matches ? 'touch' : 'phone');
      },
      null,
      { timeout: 5_000, polling: 50 },
    );
    // Two frames for what renders from the layout (the panes, a sheet's place) to settle.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    return true;
  } catch {
    return false;
  }
}

/**
 * 0.12.1: for a touch page, makes sure it has its coarse pointer: if Chromium dropped it, it is turned back
 * on in the same page (restoreTouch), saying so; TouchDropped if it won't come back. Nothing for any other page.
 */
export async function stillTouch(page: Page, what = 'a touch page'): Promise<void> {
  if (!touchPages.has(page)) return;
  if (DROPS.mode === 'every') {
    await dropTouch(page);
    console.warn(`[touch] JANTAR_TOUCH_DROP=every: ${what}: touch emulation turned off over CDP`);
  } else if (DROPS.mode === 'stuck' && firstTry?.page === page && ++firstTry.asks === DROPS.at) {
    await dropTouch(page);
    stuckPages.add(page);
    console.warn(`[touch] JANTAR_TOUCH_DROP=stuck:${DROPS.at}: ${what}: touch emulation turned off over CDP, and kept off`);
  }
  if (await hasCoarsePointer(page)) return;
  if (!(await restoreTouch(page))) throw new TouchDropped(what, ', and it did not come back on in the same page');
  console.warn(`[touch] ${what}: the browser dropped its touch emulation (no (pointer: coarse)); turned it back on in the same page`);
}

/** 0.12.1: what onTouch does before it runs a test's steps again in a new context. */
export interface Rerun {
  /** Puts back what the steps changed on the Mac (a todo done or deleted), after the dropped context is closed. */
  reset?: () => Promise<void>;
  /** True once the steps have done what can't be done twice (an Undo tried, a save, a summary run): then they don't run again. */
  irreversible?: () => boolean;
}

/**
 * 0.12.1: `steps` on the page `open` gives, with its coarse pointer (stillTouch turns a dropped one back on
 * in place, and the steps go on). Only when that fails, or a step fails and the page has no coarse pointer,
 * is its context closed, `reset` run to put back what the steps changed on the Mac, and the steps run again
 * from the start in a new one (`open(true)`); a drop there too throws, and so does one after an
 * `irreversible` step. The page is asked once more after the steps, so none passed with a fine pointer.
 * `keep` leaves the page open unless it is run again (a suite's paired phone, for the next test) and
 * returns it; otherwise it is closed (`close`, else its context).
 */
export async function onTouch<T extends { page: Page }>(
  what: string,
  open: (again: boolean) => Promise<T>,
  steps: (o: T) => Promise<void>,
  opts: Rerun & { keep?: boolean; close?: (o: T) => Promise<void> } = {},
): Promise<T> {
  const close = opts.close ?? ((o: T) => o.page.context().close());
  for (let attempt = 1; ; attempt += 1) {
    const o = await open(attempt > 1);
    firstTry = attempt === 1 ? { page: o.page, asks: 0 } : null;
    let rerun = false;
    try {
      await steps(o);
      await stillTouch(o.page, what);
      return o;
    } catch (e) {
      let dropped: string | null = null;
      if (e instanceof TouchDropped) dropped = '';
      else if (touchPages.has(o.page) && (await hasCoarsePointer(o.page).catch(() => true)) === false) {
        dropped = ` (a step failed with it gone: ${String(e instanceof Error ? e.message : e).split('\n')[0]})`;
      }
      if (dropped === null) throw e;
      const gone = `${what}: the browser dropped its touch emulation (no (pointer: coarse))${dropped || ', and it did not come back on in the same page'}`;
      if (attempt > 1) throw new Error(`${gone}, in a new context too; a touch check never runs with a fine pointer`, { cause: e });
      if (opts.irreversible?.()) throw new Error(`${gone}; the steps did what can't be done twice, so they don't run again`, { cause: e });
      console.warn(`[touch] ${gone}; once more in a new context${opts.reset ? ', what the steps changed on the Mac put back first' : ''}`);
      rerun = true;
    } finally {
      firstTry = null;
      // A kept page that failed stays for the suite's next test, which asks for its pointer again.
      if (!opts.keep || rerun) await close(o).catch(() => undefined);
    }
    if (opts.reset) await opts.reset();
  }
}

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * 0.12.1: onTouch for a paired page a suite keeps across its tests (`current`). On a drop that can't be put
 * right in place it is opened again by `again` as the same device, from the dropped context's cookies,
 * storage and IndexedDB (where the app keeps the device secret): pairing again would meet the daemon's claim
 * limit, 8 a minute. `rerun` as onTouch's.
 */
export function onPaired<T extends { ctx: BrowserContext; page: Page }>(
  what: string,
  current: () => T,
  again: (state: StorageState | undefined) => Promise<T>,
  steps: (o: T) => Promise<void>,
  rerun: Rerun = {},
): Promise<T> {
  let state: StorageState | undefined;
  return onTouch(what, async (reopen) => (reopen ? again(state) : current()), steps, {
    keep: true,
    close: async (o) => {
      state = await o.ctx.storageState({ indexedDB: true }).catch(() => undefined);
      await o.ctx.close();
    },
    ...rerun,
  });
}

/** No message about the Content Security Policy, no console error, no <style> element. 0.12.1: `what` names a touch page that lost its pointer. */
export async function clean(page: Page, watch: Watch, what?: string): Promise<void> {
  await stillTouch(page, what);
  expect(watch.csp, watch.csp.join('\n')).toEqual([]);
  expect(watch.errors, watch.errors.join('\n')).toEqual([]);
  expect(await styleElements(page)).toBe(0);
}

/**
 * What sticks out sideways on a page: the page itself scrolling sideways;
 * a scrolling pane (a list, a sheet, the transcript) whose content is wider
 * than it, so it scrolls sideways or cuts its content off, unless it is made
 * to scroll both ways (`overflow-x-auto` and `overflow-auto`, like the code
 * view); and an element past the viewport's sides that no box inside the
 * viewport holds.
 */
export async function overflow(page: Page, what?: string): Promise<string[]> {
  await stillTouch(page, what);
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > vw + 1) out.push(`the page scrolls sideways: ${root.scrollWidth} px in ${vw}`);
    const name = (el: Element) => {
      const id = el.id ? `#${el.id}` : '';
      const label = el.getAttribute('aria-label');
      const text = (el.textContent ?? '').trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${id}${label ? `[aria-label="${label}"]` : ''} "${text}"`;
    };
    const shown = (el: Element) => !el.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(el).visibility !== 'hidden';
    const sideways = (el: Element) => /(^|\s)overflow-(x-)?(auto|scroll)(\s|$)/.test(el.getAttribute('class') ?? '');
    const contained = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (getComputedStyle(p).overflowX === 'visible') continue;
        const r = p.getBoundingClientRect();
        return r.left >= -1 && r.right <= vw + 1;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll('*')) {
      if (out.length >= 10) break;
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !sideways(el) && shown(el)) {
        out.push(`${name(el)} holds ${el.scrollWidth} px in ${el.clientWidth}`);
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1 || (r.left >= -1 && r.right <= vw + 1)) continue;
      if (!shown(el) || contained(el)) continue;
      out.push(`${name(el)}: ${Math.round(r.left)} to ${Math.round(r.right)} in ${vw}`);
    }
    return out;
  });
}

/**
 * A glyph's shape in grayscale, as a string of on and off pixels, with the
 * word of the rail it sits under: what has to tell states apart once
 * colour is gone (direction.md rule 16).
 */
export async function grayscaleKey(row: Locator): Promise<string> {
  const rail = await row.evaluate((el) => {
    let p = el.previousElementSibling;
    while (p && (p.hasAttribute('data-sid') || p.hasAttribute('data-launch'))) p = p.previousElementSibling;
    return (p?.textContent ?? '').replace(/\d+/g, '').trim().toLowerCase();
  });
  const shot = decodePng(await row.locator('svg[data-glyph]').first().screenshot());
  const bg = luma(shot, 0, 0);
  let shape = '';
  for (let y = 0; y < shot.height; y += 1) for (let x = 0; x < shot.width; x += 1) shape += Math.abs(luma(shot, x, y) - bg) > 12 ? '1' : '0';
  expect(shape.includes('1'), `${rail}: the glyph is invisible in grayscale`).toBe(true);
  return `${rail}|${shape}`;
}

/** Turn the whole page gray through the CSSOM (not a <style> element: allowed under the CSP). */
export async function grayscale(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.filter = 'grayscale(1)';
  });
  await page.waitForTimeout(200);
}

/**
 * Watches a page someone opened (web-v04 pairs its pages itself, so they do
 * not come from pageOpener): the same CSP and error rules as pageOpener.
 * Clear `errors` after a step whose errors are expected (the 401s before a
 * pairing claim).
 */
export function watchConsole(page: Page): Watch {
  const watch: Watch = { csp: [], errors: [] };
  page.on('console', (m) => {
    const t = m.text();
    if (CSP_RE.test(t)) watch.csp.push(`${m.type()}: ${t}`);
    else if (m.type() === 'error' && !/WebSocket|status of 404/.test(t)) watch.errors.push(t);
  });
  page.on('pageerror', (e) => watch.errors.push(`pageerror: ${e.message}`));
  return watch;
}

/** One place Tab stopped at. */
export interface FocusStop {
  /** "button Mark done: Example todo", for the failure message. */
  what: string;
  /** Index in document order. */
  order: number;
  visible: boolean;
  named: boolean;
  inDialog: boolean;
  /** Shows a focus ring (an outline), or is a text field (its border shows focus instead). */
  ring: boolean;
}

/**
 * Presses Tab from the top of the page until focus leaves the document or
 * comes back round to where it started, at most `max` times, and says where
 * each press landed. A sheet's focus trap ends the walk too: Base UI's
 * guard (an aria-hidden span at each edge of the sheet) takes focus there
 * and hands it back to the sheet's first stop. Tab moving inside one
 * control (the hour and minute of a time input) is one stop.
 */
export async function focusWalk(page: Page, max = 60): Promise<FocusStop[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: FocusStop[] = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate((): FocusStop | null => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement || el.hasAttribute('data-base-ui-focus-guard')) return null;
      const r = el.getBoundingClientRect();
      const labelled = (el as HTMLInputElement).labels?.[0]?.textContent ?? '';
      const name = (el.getAttribute('aria-label') ?? (el.textContent || el.getAttribute('placeholder') || labelled || el.getAttribute('title') || '')).trim();
      return {
        what: `${el.tagName.toLowerCase()} ${name.slice(0, 50)}`,
        order: [...document.querySelectorAll('*')].indexOf(el),
        visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden], [inert]'),
        named: name !== '' || el.hasAttribute('aria-labelledby'),
        inDialog: el.closest('[role="dialog"]') !== null,
        ring: ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || (getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) > 0),
      };
    });
    if (!stop || (stops.length > 0 && stop.order === stops[0]!.order)) break;
    if (stop.order !== stops.at(-1)?.order) stops.push(stop);
  }
  return stops;
}

/**
 * A sane focus order: no positive tabindex anywhere; every stop visible,
 * named and showing a focus ring; stops in document order (what reads top
 * to bottom is what Tab walks); and in a sheet, every stop inside the sheet.
 */
export async function expectSaneFocus(page: Page, stops: FocusStop[], opts: { dialog?: boolean; what: string }): Promise<void> {
  const positive = await page.evaluate(() => [...document.querySelectorAll('[tabindex]')].filter((el) => Number(el.getAttribute('tabindex')) > 0).length);
  expect(positive, `${opts.what}: an element with a positive tabindex`).toBe(0);
  expect(stops.length, `${opts.what}: Tab reaches nothing`).toBeGreaterThan(0);
  const list = stops.map((s) => s.what).join('\n');
  for (const s of stops) {
    expect(s.visible, `${opts.what}: Tab lands on something not shown: ${s.what}\n${list}`).toBe(true);
    expect(s.named, `${opts.what}: Tab lands on something with no name: ${s.what}\n${list}`).toBe(true);
    expect(s.ring, `${opts.what}: Tab lands on something with no focus ring: ${s.what}\n${list}`).toBe(true);
    if (opts.dialog) expect(s.inDialog, `${opts.what}: Tab leaves the sheet for ${s.what}\n${list}`).toBe(true);
  }
  for (let i = 1; i < stops.length; i += 1) {
    expect(stops[i]!.order > stops[i - 1]!.order, `${opts.what}: Tab goes back up from ${stops[i - 1]!.what} to ${stops[i]!.what}\n${list}`).toBe(true);
  }
}

/**
 * The shape of the first status glyph under `row` in grayscale, as on and
 * off pixels ('' with no glyph), checked visible: a Life row's state that
 * colour alone would carry has to be in its glyph or its words.
 */
export async function glyphShape(row: Locator): Promise<string> {
  const glyph = row.locator('svg[data-glyph]').first();
  if ((await glyph.count()) === 0) return '';
  const shot = decodePng(await glyph.screenshot());
  const bg = luma(shot, 0, 0);
  let shape = '';
  for (let y = 0; y < shot.height; y += 1) for (let x = 0; x < shot.width; x += 1) shape += Math.abs(luma(shot, x, y) - bg) > 12 ? '1' : '0';
  expect(shape.includes('1'), 'a glyph is invisible in grayscale').toBe(true);
  return shape;
}

/** The insets of `o`, if it has any, through the DevTools protocol (Chromium has no option for them). */
async function emulateInsets(page: Page, o: Viewport): Promise<void> {
  if (!o.insets) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: o.insets.top, bottom: o.insets.bottom, left: 0, right: 0 } });
}

/** A fixture as scripts/screenshots.mjs serves it: its clock, its time zone and its /v1 answers. */
export interface AnsweringFixture {
  now: number;
  timezone: string;
  v04: { answer(method: string, url: URL, body?: Buffer | null): { status: number; body?: unknown; bytes?: Buffer; type?: string } | null };
}

/**
 * 0.12: a page in its own context, as scripts/screenshots.mjs opens one: the
 * fixture's clock and time zone, a paired control device, the event stream
 * accepted and quiet, /v1 answered from the fixture (or from `override`
 * first), reduced motion; with `o.touch` an iPad (its user agent,
 * MacIntel, five touch points) and `o.insets` its safe areas. Watched like
 * pageOpener's pages; `close()` closes its context.
 */
export async function openTouchable(
  browser: Browser,
  o: Viewport,
  fixture: AnsweringFixture,
  override?: (url: URL) => { status: number; body: unknown } | null,
): Promise<{ page: Page; watch: Watch; close: () => Promise<void> }> {
  const touch = o.phone === true || o.touch === true;
  const ctx = await browser.newContext({
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: 2,
    isMobile: touch,
    hasTouch: touch,
    ...(o.touch ? { userAgent: IPAD_UA } : {}),
    colorScheme: o.scheme ?? 'light',
    locale: 'en-GB',
    timezoneId: fixture.timezone,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  await ctx.clock.setFixedTime(fixture.now);
  await ctx.addInitScript((ipad: boolean) => {
    try {
      localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev2', name: ipad ? 'iPad' : 'iPhone', scopes: ['read', 'control', 'launch'] }));
    } catch {
      // no storage: Life asks the Mac and gets the same answers
    }
    if (!ipad) return;
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true });
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true });
  }, o.touch === true);
  await ctx.routeWebSocket((url) => url.pathname === '/v1/events', () => undefined);
  await ctx.route(
    (url) => url.pathname.startsWith('/v1/'),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const own = req.method() === 'GET' ? override?.(url) : null;
      if (own) return route.fulfill({ status: own.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(own.body) });
      const reply = fixture.v04.answer(req.method(), url, req.postDataBuffer());
      if (!reply) return route.continue();
      if (reply.bytes) return route.fulfill({ status: reply.status, contentType: reply.type ?? 'application/octet-stream', body: reply.bytes });
      return route.fulfill({ status: reply.status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(reply.body) });
    },
  );
  const page = await ctx.newPage();
  if (touch) touchPage(page);
  await emulateInsets(page, o);
  const watch = watchConsole(page);
  return { page, watch, close: () => ctx.close() };
}
