/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * 0.11 wide windows and the iPad (build plan 6.1, 6.2) in the BUILT web app,
 * in a real headless Chromium: every place at the plan's window sizes, with
 * a fine pointer (a Mac) and a coarse one (an iPad, Chrome's device mode).
 * Served with the daemon's real headers and the screenshot fixture
 * (web-fixture-v08.ts, with its Chat, Posts and Intel variants), as
 * scripts/screenshots.mjs serves it. Each context opens the app once and
 * moves between places as the app does (the router, no reload).
 *
 * The checks here (6.2; the rest arrive with c33's rotation, keyboard and
 * hover tests):
 *
 *   1. Nothing scrolls sideways: not the page, and no box, unless it says it
 *      is meant to (data-scroll-x: the terminal mirror, the code view, the
 *      Accounts runway, the phone's chip strips). KNOWN_SIDEWAYS lists what
 *      still does, with the commit that fixes it.
 *   2. On a touch screen, no control smaller than 44 x 44 (A1), measured on
 *      the controls wholly on screen. TARGET_SIZES says where it runs (c12
 *      runs it at 1180 and 820; c33 at every touch size). KNOWN_UNDER_44
 *      lists what still is, with the commit that fixes it; TARGET_ALLOW the
 *      controls whose target is bigger than their box, each with its reason.
 *   3. At 1024 px and wider, no place leaves more than 35 % of its content
 *      width empty (layout-metric.ts). Empty states are exempt, and so are
 *      the states in WIDTH_EXEMPT, each with its reason. Every place that
 *      still does is listed in KNOWN_WIDE_GAPS with its measure; a listed
 *      one that passes fails the test too, so each chunk-2 commit removes
 *      its rows, and the list is empty at c23.
 *   4. With the iPad's safe areas (24 top, 20 bottom), no control that
 *      doesn't scroll sits in them (A2): nothing under the status bar or
 *      over the home indicator. Content in a scroll box may pass under.
 *   7. No console message about the Content Security Policy, no error, no
 *      injected <style>.
 *  12. The user's four screens at 1440 x 960 (mac-1440 and touch-1440):
 *      Today, Chat (its empty thread too), Alerts (an alert open too) and
 *      Intel are measured, never exempt; and wherever an item is open beside
 *      its list, the list shows the item's row.
 *
 * Tier A sizes in light run by default; JANTAR_LAYOUT_FULL=1 adds tier B and
 * dark. On a failure the page's PNG goes to the OS temp folder, named in the
 * message. Every name and value is synthetic. Needs a built dist/ and a
 * Chromium.
 *
 * While working on one place: JANTAR_LAYOUT_STATES=today,todos measures only
 * those states, JANTAR_LAYOUT_SIZES=mac-1440,ipad-air-l only those sizes,
 * and JANTAR_LAYOUT_SHOTS=1 keeps every page's PNG (not only a failure's) in
 * the same folder, with the share measured (and where the empty columns are)
 * in the log.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { perfBudgetMs } from '@jantar/fixtures';
import { emptyRanges, emptyShare, MAX_EMPTY, under44 } from '../../packages/web/test/layout-metric.js';
import { browserReady, DIST, openTouchable, type Viewport, type Watch } from './browser.js';
import { probeLayout, type Probe } from './layout-probe.js';
import { lid } from './web-fixture-v04.js';
import { READ_IDS, webFixtureV08, type V08Variant, type WebFixtureV08 } from './web-fixture-v08.js';
import { sidOf } from './web-fixture.js';
import { serveWebApp, type WebServer } from './web-server.js';

const ready = await browserReady('web-v011-layout.integration');
const FULL = process.env.JANTAR_LAYOUT_FULL === '1';
const list = (v: string | undefined) => (v ? new Set(v.split(',').map((x) => x.trim())) : null);
/** Only these states / sizes (a place being worked on); the user's-case check then reads only what ran. */
const ONLY_STATES = list(process.env.JANTAR_LAYOUT_STATES);
const ONLY_SIZES = list(process.env.JANTAR_LAYOUT_SIZES);
const SHOTS = process.env.JANTAR_LAYOUT_SHOTS === '1';

/** The iPad's insets in the Home Screen app: the status bar and the home indicator. */
const IPAD = { top: 24, bottom: 20 };

/** The window sizes (6.1). Tier B and dark run with JANTAR_LAYOUT_FULL=1. */
export const LAYOUT_SIZES: Record<string, Viewport & { tier: 'A' | 'B' }> = {
  'mac-1440': { width: 1440, height: 960, tier: 'A' },
  'touch-1440': { width: 1440, height: 960, touch: true, tier: 'A' },
  desktop: { width: 1440, height: 900, tier: 'A' },
  'mac-1024': { width: 1024, height: 768, tier: 'B' },
  'ipad-air-l': { width: 1180, height: 820, touch: true, insets: IPAD, tier: 'A' },
  'ipad-air-p': { width: 820, height: 1180, touch: true, insets: IPAD, tier: 'A' },
  'ipad-pro-l': { width: 1210, height: 834, touch: true, insets: IPAD, tier: 'A' },
  'ipad-pro-p': { width: 834, height: 1210, touch: true, insets: IPAD, tier: 'A' },
  'ipad-1024': { width: 1024, height: 820, touch: true, insets: IPAD, tier: 'B' },
  'ipad-13-l': { width: 1366, height: 1024, touch: true, insets: IPAD, tier: 'B' },
  'split-23-air': { width: 795, height: 820, touch: true, tier: 'A' },
  'split-23-pro': { width: 825, height: 834, touch: true, tier: 'A' },
  'split-12-air': { width: 585, height: 820, touch: true, tier: 'A' },
  'split-12-pro': { width: 600, height: 834, touch: true, tier: 'A' },
  'split-p23-air': { width: 490, height: 1180, touch: true, tier: 'B' },
  'split-p23-pro': { width: 504, height: 1210, touch: true, tier: 'B' },
  third: { width: 375, height: 820, touch: true, tier: 'B' },
  'third-18': { width: 320, height: 1180, touch: true, tier: 'B' },
  'win-min': { width: 375, height: 486, touch: true, tier: 'B' },
  'win-quarter': { width: 585, height: 398, touch: true, tier: 'B' },
  'safari-l': { width: 1180, height: 734, touch: true, tier: 'B' },
  'safari-p': { width: 820, height: 1094, touch: true, tier: 'B' },
  phone: { width: 390, height: 844, phone: true, tier: 'A' },
};

interface State {
  name: string;
  path: string;
  variant?: V08Variant;
  accounts?: 'cswap' | 'single';
  /** Chat on with no turns yet (the user's -14). */
  chatEmpty?: boolean;
}

/** The places and states measured (6.1's shots that open by URL; c33 adds the ones that need steps). */
export const STATES: readonly State[] = [
  { name: 'board', path: '/' },
  { name: 'session', path: `/s/${sidOf(4)}` },
  { name: 'session-card', path: `/s/${sidOf(1)}` },
  { name: 'new', path: '/new?root=r.work&path=jantar&start=1' },
  { name: 'today', path: '/today' },
  { name: 'todos', path: '/todos' },
  { name: 'reminders', path: '/todos?tab=reminders' },
  { name: 'projects', path: '/todos?tab=projects' },
  { name: 'meds', path: '/meds' },
  { name: 'food', path: '/food' },
  { name: 'money', path: '/money' },
  { name: 'places', path: '/places' },
  { name: 'place', path: `/places?id=${lid(701)}` },
  { name: 'intel', path: '/intel' },
  { name: 'meetings', path: '/meetings' },
  { name: 'meeting', path: `/meetings?id=${lid(501)}` },
  { name: 'accounts', path: '/accounts' },
  { name: 'alerts', path: '/alerts' },
  { name: 'alert', path: '/alerts?id=al2' },
  { name: 'devices', path: '/devices' },
  { name: 'files', path: '/files' },
  { name: 'file', path: `/files?root=r.work&path=${encodeURIComponent('jantar/src/cookies.ts')}` },
  { name: 'more', path: '/more' },
  { name: 'chat', path: '/chat', variant: 'chat' },
  { name: 'chat-empty', path: '/chat', variant: 'chat', chatEmpty: true },
  { name: 'posts', path: '/posts', variant: 'posts' },
  { name: 'post', path: `/posts?id=${lid(1201)}`, variant: 'posts' },
  { name: 'intel-item', path: `/intel?item=${encodeURIComponent(READ_IDS.dal)}`, variant: 'intel-read' },
  { name: 'accounts-single', path: '/accounts', accounts: 'single' },
];

/** 6.2 #12: the user's four screens at 1440 x 960, never exempt. */
const USERS_CASE = { sizes: ['mac-1440', 'touch-1440'], states: ['today', 'chat', 'chat-empty', 'alerts', 'alert', 'intel', 'intel-item'] };

/**
 * Every place x size at 1024 and wider that still leaves more than 35 % of its width empty, with the
 * share measured when it was listed. Chunk 1 listed every place that did (the screenshot fixture);
 * each chunk-2 commit widened its place and took its rows out (c14 Today, c16 Alerts, c17 Intel,
 * c15 Chat, c18 Meetings, c19 Cafés, c20 the Life lists, c21 Posts, c22a Files, c22b Accounts,
 * c22c Devices, c22d More), and it is empty from c22d. A place that regresses fails the test.
 *
 * A short list reads as empty however wide it is: with 3 rows (Alerts' fixture) no 4 px column has
 * 96 px of content, so Alerts measured 0.97-1. c16 made its table one card across the pane, which reads
 * as the table it is (3 % empty at 1440).
 */
export const KNOWN_WIDE_GAPS: Record<string, number> = {};

/**
 * What still scrolls or cuts sideways, by place x size, with the commit that fixes it. Like
 * KNOWN_WIDE_GAPS, a listed one that no longer does fails the test, so it is taken out.
 */
// Empty from c23, which made Show on Mac an icon where the session's pane is under 640 (a touch screen
// at 1024 with the Mac's chrome gave its 44 pt header 628 px).
export const KNOWN_SIDEWAYS: Record<string, string> = {};

/** Where check 2 (44 pt on touch) runs: c12's two sizes, until c33 runs it at every touch size. */
const TARGET_SIZES = new Set(['ipad-air-l', 'ipad-air-p']);

/**
 * Controls that are under 44 x 44 on a touch screen, by their name, with the commit that fixes them.
 * Like the lists above, one that no longer is fails the test, so it is taken out.
 */
export const KNOWN_UNDER_44: Record<string, string> = {
  // The Mac's status bar on a touch screen: 24 px buttons in a 24 px bar. The touch shell (c24) has none.
  'Legend <': 'c24',
  '5-hour usage per account. Open Accounts <': 'c24',
};

/** Controls whose target is bigger than their box (by the probe's name), each with its reason. */
export const TARGET_ALLOW: Array<[RegExp, string]> = [
  // The code view's line numbers: 44 wide under a finger (CodeView.tsx), a code line's own height tall; a
  // 44 px line would show a third of the code. The line's link is also in the viewer's menu.
  [/^Line \d+ </, "a code line's number is the line's height"],
];

const WIDE_FROM = 1024;

/**
 * States checked for everything but the width, each with its reason (6.2 #3: exemptions are listed
 * here, not decided ad hoc). The user's four screens are never here.
 */
export const WIDTH_EXEMPT: Record<string, string> = {
  // The viewer has the pane (all of it with Hide browser); a short file's short lines leave its right side empty.
  file: 'a file reads at its own width',
};

/** The shot's fixture: one per accounts mode and variant. */
const fixtureKey = (s: State) => `${s.accounts ?? 'cswap'}:${s.variant ?? 'default'}`;

describe.skipIf(!ready)('0.11: every place at every window size, in Chromium', () => {
  let browser: Browser;
  let server: WebServer;
  const fixtures = new Map<string, WebFixtureV08>();
  let current: WebFixtureV08;
  const fixtureOf = (s: State) => {
    const key = fixtureKey(s);
    let f = fixtures.get(key);
    if (!f) {
      f = webFixtureV08({ accounts: s.accounts ?? 'cswap', variant: s.variant ?? 'default' });
      fixtures.set(key, f);
    }
    return f;
  };
  const shots = join(tmpdir(), 'jantar-v011-layout');

  beforeAll(async () => {
    browser = await chromium.launch();
    current = fixtureOf(STATES[0]!);
    server = await serveWebApp(DIST, () => current);
    mkdirSync(shots, { recursive: true });
  });
  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await server?.close();
  });

  /** Opens `path` the way the app does: the router follows history and popstate. */
  async function go(page: Page, path: string) {
    await page.evaluate((p) => {
      history.pushState(null, '', p);
      dispatchEvent(new PopStateEvent('popstate'));
    }, path);
  }

  /**
   * Waits for a place to settle: no request in flight for 500 ms (its chunk and its data), then no
   * skeleton ("Opening …", which shows only after 150 ms), nothing busy and no spinner, then a breath.
   */
  async function settle(page: Page, inFlight: () => number) {
    const until = Date.now() + perfBudgetMs(15_000);
    let quietSince = Date.now();
    while (Date.now() < until) {
      await page.waitForTimeout(100);
      if (inFlight() > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= 500) break;
    }
    await page
      .waitForFunction(
        () => !document.querySelector('main [aria-busy="true"], main [role="progressbar"]') && !/Opening [A-Z]|Connecting to the Mac/.test(document.querySelector('main')?.textContent ?? ''),
        null,
        { timeout: Math.max(1000, until - Date.now()) },
      )
      .catch(() => undefined);
    await page.waitForTimeout(300);
  }

  const groups = new Map<string, State[]>();
  for (const s of STATES.filter((x) => !ONLY_STATES || ONLY_STATES.has(x.name))) groups.set(fixtureKey(s), [...(groups.get(fixtureKey(s)) ?? []), s]);
  const sizes = Object.entries(LAYOUT_SIZES).filter(([k, v]) => (ONLY_SIZES ? ONLY_SIZES.has(k) : FULL || v.tier === 'A'));
  const schemes = FULL ? (['light', 'dark'] as const) : (['light'] as const);

  for (const [size, viewport] of sizes) {
    for (const scheme of schemes) {
      it(`${size} (${viewport.width} x ${viewport.height}${viewport.touch || viewport.phone ? ', touch' : ''}), ${scheme}`, async () => {
        const problems: string[] = [];
        const wide: Record<string, number> = {};
        const measured = new Set<string>();
        const seenSmall = new Set<string>();
        for (const [, states] of groups) {
          const fixture = fixtureOf(states[0]!);
          current = fixture;
          const chatEmpty = { on: false };
          const opened = await openTouchable(browser, { ...viewport, scheme }, fixture, (url) =>
            chatEmpty.on && url.pathname === '/v1/chat' ? { status: 200, body: { older: null, ready: { ok: true }, keepDays: 30, turns: [] } } : null,
          );
          const { page, watch, close } = opened;
          // Requests in flight, so a place counts as loaded only once its chunk and its data are here.
          let pending = 0;
          page.on('request', () => (pending += 1));
          page.on('requestfinished', () => (pending -= 1));
          page.on('requestfailed', () => (pending -= 1));
          try {
            for (const [i, s] of states.entries()) {
              chatEmpty.on = s.chatEmpty === true;
              if (i === 0 && !s.chatEmpty) await page.goto(`${server.base}${s.path}`, { waitUntil: 'networkidle' });
              else if (i === 0) await page.goto(`${server.base}/`, { waitUntil: 'networkidle' }).then(() => go(page, s.path));
              else {
                // A state of its own (the empty thread): leave first, so Chat loads again.
                if (s.chatEmpty) await go(page, '/');
                await go(page, s.path);
              }
              await settle(page, () => pending);
              const p: Probe = await page.evaluate(probeLayout);
              const at = `${s.name} at ${size}`;
              const shot = async () => {
                const file = join(shots, `${size}-${scheme}-${s.name}.png`);
                await page.screenshot({ path: file }).catch(() => undefined);
                return file;
              };
              let measuredShare: number | null = null;
              // 1. Nothing sideways (or what KNOWN_SIDEWAYS still lists).
              const sidewaysKnown = KNOWN_SIDEWAYS[`${s.name}@${size}`] !== undefined;
              if (p.sideways.length && !sidewaysKnown) problems.push(`${at}: sideways: ${p.sideways.join('; ')} (${await shot()})`);
              if (!p.sideways.length && sidewaysKnown) problems.push(`${at}: nothing sideways now: take it out of KNOWN_SIDEWAYS`);
              // 4. The safe areas (A2): no control that stays put under the status bar or over the home indicator.
              if (viewport.insets) {
                const { top, bottom } = viewport.insets;
                const inBands = p.fixed.filter((t) => t.y < top || t.y + t.h > p.vh - bottom);
                if (inBands.length) problems.push(`${at}: in the safe areas: ${inBands.map((t) => `${t.name} (${t.x},${t.y} ${t.w}x${t.h})`).join('; ')} (${await shot()})`);
              }
              // 2. 44 pt on touch (A1).
              if (TARGET_SIZES.has(size) && (viewport.touch || viewport.phone)) {
                const small = under44(p.whole).filter((t) => !TARGET_ALLOW.some(([re]) => re.test(t.name)));
                for (const t of small) {
                  const known = Object.keys(KNOWN_UNDER_44).find((k) => t.name.startsWith(k));
                  if (known) seenSmall.add(known);
                  else problems.push(`${at}: under 44: ${t.name} ${t.w}x${t.h}`);
                }
              }
              // 12. An item opened beside its list: the list shows its row (it scrolled to it).
              if (p.selected && !p.selected.inView) problems.push(`${at}: the open item's row is out of view in the list (${p.selected.name}) (${await shot()})`);
              // 3. The width, at 1024 and wider.
              if (viewport.width >= WIDE_FROM && p.region) {
                const users = USERS_CASE.sizes.includes(size) && USERS_CASE.states.includes(s.name);
                const exempt = p.exempt ?? WIDTH_EXEMPT[s.name] ?? null;
                if (exempt && users) problems.push(`${at}: the user's case is never exempt, but read as ${exempt}`);
                if (!exempt) {
                  const share = Math.round(emptyShare(p.boxes, p.region) * 100) / 100;
                  measuredShare = share;
                  const key = `${s.name}@${size}`;
                  measured.add(key);
                  if (share > MAX_EMPTY) wide[key] = share;
                  const known = KNOWN_WIDE_GAPS[key];
                  if (share > MAX_EMPTY && known === undefined) problems.push(`${at}: ${Math.round(share * 100)} % of the width is empty (at most ${MAX_EMPTY * 100} %) (${await shot()})`);
                  if (share <= MAX_EMPTY && known !== undefined) problems.push(`${at}: now ${Math.round(share * 100)} % empty: take it out of KNOWN_WIDE_GAPS`);
                }
              }
              if (SHOTS) {
                const where = measuredShare && p.region ? ` at ${emptyRanges(p.boxes, p.region).map(([a, b]) => `${a}-${b}`).join(', ')}` : '';
                console.info(`[layout] ${s.name}@${size} ${scheme}: ${measuredShare === null ? 'not measured' : `${Math.round(measuredShare * 100)} % empty${where}`} (${await shot()})`);
              }
            }
            // 7. The console, over every place this context opened.
            problems.push(...consoleProblems(watch, size));
            if (await page.evaluate(() => document.querySelectorAll('style').length)) problems.push(`${size}: a <style> element was injected`);
          } finally {
            await close();
          }
        }
        // 2. A known small control that no longer is: take it out of KNOWN_UNDER_44.
        if (TARGET_SIZES.has(size) && (viewport.touch || viewport.phone) && !ONLY_STATES)
          for (const k of Object.keys(KNOWN_UNDER_44)) if (!seenSmall.has(k)) problems.push(`${size}: "${k}" is 44 now: take it out of KNOWN_UNDER_44`);
        // 12. The user's four screens were measured at 1440 x 960.
        if (USERS_CASE.sizes.includes(size))
          for (const s of USERS_CASE.states) if ((!ONLY_STATES || ONLY_STATES.has(s)) && !measured.has(`${s}@${size}`)) problems.push(`${s} at ${size}: the user's case was not measured`);
        if (Object.keys(wide).length) console.info(`[layout] ${size} ${scheme} still wide: ${JSON.stringify(wide)}`);
        expect(problems, problems.join('\n')).toEqual([]);
      }, perfBudgetMs(240_000));
    }
  }
});

function consoleProblems(watch: Watch, size: string): string[] {
  return [...watch.csp.map((t) => `${size}: CSP: ${t}`), ...watch.errors.map((t) => `${size}: console: ${t}`)];
}
