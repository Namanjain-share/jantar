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
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
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
}

export const DESK: Viewport = { width: 1440, height: 900 };
export const PHONE: Viewport = { width: 390, height: 844, phone: true };

/** Opens pages in fresh contexts on `base`, each watched; `close()` closes them all. */
export function pageOpener(browser: Browser, base: () => string) {
  const contexts: BrowserContext[] = [];
  const open = async (path: string, o: Viewport): Promise<{ page: Page; watch: Watch }> => {
    const ctx = await browser.newContext({
      viewport: { width: o.width, height: o.height },
      deviceScaleFactor: 2,
      isMobile: o.phone === true,
      hasTouch: o.phone === true,
      colorScheme: o.scheme ?? 'light',
      locale: 'en-GB',
      serviceWorkers: 'block',
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
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

/** No message about the Content Security Policy, no console error, no <style> element. */
export async function clean(page: Page, watch: Watch): Promise<void> {
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
export async function overflow(page: Page): Promise<string[]> {
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
