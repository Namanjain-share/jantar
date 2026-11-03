/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * 0.12 wide windows and the iPad (build plan 6.1, 6.2) in the BUILT web app,
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
 *      In the touch shell (c24) the window controls' top-left 80 x 52 is
 *      kept free too, and on every touch screen (c32) the bottom-right
 *      24 x 24, where an iPad window's resize handle sits.
 *   5. On a touch screen, at least 90 % of the characters on screen are
 *      12 px or more, and none is under 11 (A5).
 *   6. No box scrolls up and down inside the page while shorter than
 *      120 px (A6), the short windows (win-quarter, win-min) included.
 *   8. No keycap on a touch screen before a key is pressed (A4); the
 *      matrix presses none.
 *   7. No console message about the Content Security Policy, no error, no
 *      injected <style>.
 *   9-11 and 8's other half (rotation, the on-screen keyboard, hover, the
 *      keycaps after a key) have their own tests below the matrix.
 *  12. The user's four screens at 1440 x 960 (mac-1440 and touch-1440):
 *      Today, Chat (its empty thread too), Alerts (an alert open too) and
 *      Intel are measured, never exempt; and wherever an item is open beside
 *      its list, the list shows the item's row.
 *  13. No control's label runs out of it (the review's Show on Mac at 820 and
 *      795, a button shrunk to 44 under an 84 px label), and no header is too
 *      full for its pane (its last buttons cut off): every size. A session
 *      is measured with Chat on too (session-chat), whose button the iPad's
 *      pane header carries.
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
import { PEOPLE_PID, withPeople } from './web-fixture-people.js';
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
  /** 0.12: v0.11 People on, with one person sharing (web-fixture-people.ts). */
  people?: boolean;
  /** c33: what to do once the place has loaded (open the palette, a sheet, the ? list, Chat beside it), and how to put it away. */
  steps?: (page: Page) => Promise<boolean>;
  undo?: (page: Page) => Promise<void>;
}

/** The palette from its button (the Mac's top bar, the iPad's sidebar or rail); the phone has none. */
async function openPalette(page: Page): Promise<boolean> {
  const b = page.getByRole('button', { name: /Jump to a session|Search or jump/ }).first();
  if (!(await b.isVisible().catch(() => false))) return false;
  await b.click();
  await page.getByRole('dialog').first().waitFor({ timeout: 5000 });
  return true;
}
/** Closes the open dialog by a tap outside it (no key: a key would turn the keyboard flag on). */
async function tapOutside(page: Page): Promise<void> {
  await page.mouse.click(4, page.viewportSize()!.height - 4).catch(() => undefined);
  await page.waitForTimeout(400);
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
  // A session with Chat on: the iPad's pane header carries the Chat button too.
  { name: 'session-chat', path: `/s/${sidOf(4)}`, variant: 'chat' },
  { name: 'posts', path: '/posts', variant: 'posts' },
  { name: 'post', path: `/posts?id=${lid(1201)}`, variant: 'posts' },
  { name: 'intel-item', path: `/intel?item=${encodeURIComponent(READ_IDS.dal)}`, variant: 'intel-read' },
  { name: 'accounts-single', path: '/accounts', accounts: 'single' },
  // 0.12: v0.11 People in the wide layouts: his screen for her (its Today tab), and his Today with her card.
  { name: 'partner', path: `/people/${PEOPLE_PID}`, people: true },
  { name: 'today-partner', path: '/today', people: true },
  // c33: the states that need a step, last in their fixture so what they open is put away after.
  {
    name: 'chat-dock',
    path: `/places?id=${lid(701)}`,
    variant: 'chat',
    steps: async (page) => {
      const b = page.locator('button[aria-pressed][title^="Chat beside"]').first();
      if (!(await b.isVisible().catch(() => false))) return false;
      await b.click();
      await page.getByRole('complementary', { name: 'Chat panel' }).waitFor({ timeout: 5000 });
      return true;
    },
    undo: async (page) => {
      await page.locator('button[aria-pressed="true"][title^="Chat beside"]').first().click().catch(() => undefined);
    },
  },
  {
    name: 'sheet',
    path: '/todos',
    steps: async (page) => {
      await page.getByRole('button', { name: 'Add todo' }).first().click();
      await page.getByRole('dialog', { name: 'New todo' }).waitFor({ timeout: 5000 });
      return true;
    },
    undo: async (page) => {
      await page.getByRole('dialog', { name: 'New todo' }).getByRole('button', { name: 'Cancel' }).click().catch(() => undefined);
    },
  },
  {
    name: 'shortcuts',
    path: '/devices',
    steps: async (page) => {
      await page.getByRole('button', { name: 'Show shortcuts' }).click();
      await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor({ timeout: 5000 });
      return true;
    },
    undo: async (page) => {
      await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByRole('button', { name: 'Done' }).click().catch(() => undefined);
    },
  },
  { name: 'palette', path: '/', steps: openPalette, undo: tapOutside },
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

/** Where check 2 (44 pt on touch) runs: every touch size (c33; c12 ran it at 1180 and 820). */
const TARGET_SIZES = new Set(Object.entries(LAYOUT_SIZES).filter(([, v]) => v.touch || v.phone).map(([k]) => k));

/**
 * Controls that are under 44 x 44 on a touch screen, by their name, with the commit that fixes them.
 * Like the lists above, one that no longer is fails the test, so it is taken out.
 */
// Empty from c24: the touch shell has no status bar (its two 24 px buttons were the last).
export const KNOWN_UNDER_44: Record<string, string> = {};

/** Controls whose target is bigger than their box (by the probe's name), each with its reason. */
export const TARGET_ALLOW: Array<[RegExp, string]> = [
  // The code view's line numbers: 44 wide under a finger (CodeView.tsx), a code line's own height tall; a
  // 44 px line would show a third of the code. The line's link is also in the viewer's menu.
  [/^Line \d+ </, "a code line's number is the line's height"],
  // The phone's dock card grabber and its folded peek (DockFrame.tsx): 28 and 24 tall, with a ::before that
  // reaches 8 and 10 above and below, so the target is 44 (build plan 3.3).
  [/^(Fold the panel|Open the panel) </, "the grabber's target is its ::before, 44 tall"],
];

const WIDE_FROM = 1024;

/**
 * States checked for everything but the width, each with its reason (6.2 #3: exemptions are listed
 * here, not decided ad hoc). The user's four screens are never here.
 */
export const WIDTH_EXEMPT: Record<string, string> = {
  // The viewer has the pane (all of it with Hide browser); a short file's short lines leave its right side empty.
  file: 'a file reads at its own width',
  // 6.2 #3: the page under a modal is measured in its own shot.
  palette: 'a modal over the board',
  sheet: 'a modal over Todos',
  shortcuts: 'a modal over Devices',
  // Chat's 360 beside a café leaves the café in single mode at 600-786, as ipad-design.md draws it (1180 x 820,
  // Chat docked); a lone café's rating rows read as half empty. The café is measured beside its list in `place`,
  // and this shot keeps every other check (sideways, 44 pt, type, safe areas, corners).
  'chat-dock': 'a café alone beside Chat, measured with its list in its own shot',
};

/** The shot's fixture: one per accounts mode and variant. */
const fixtureKey = (s: State) => `${s.accounts ?? 'cswap'}:${s.variant ?? 'default'}${s.people ? ':people' : ''}`;

describe.skipIf(!ready)('0.12: every place at every window size, in Chromium', () => {
  let browser: Browser;
  let server: WebServer;
  const fixtures = new Map<string, WebFixtureV08>();
  let current: WebFixtureV08;
  const fixtureOf = (s: State) => {
    const key = fixtureKey(s);
    let f = fixtures.get(key);
    if (!f) {
      f = webFixtureV08({ accounts: s.accounts ?? 'cswap', variant: s.variant ?? 'default' });
      if (s.people) f = withPeople(f);
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
              // c33: a state that needs a step; one this chrome can't take (the phone's palette) is skipped.
              if (s.steps && !(await s.steps(page).catch(() => false))) continue;
              if (s.steps) await page.waitForTimeout(300);
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
              // 4. The touch shell keeps the window controls' corner free: no control in the top-left 80 x 52.
              if (p.chrome === 'touch') {
                const corner = p.fixed.filter((t) => t.x < 80 && t.y < 52);
                if (corner.length) problems.push(`${at}: in the window controls' corner: ${corner.map((t) => `${t.name} (${t.x},${t.y})`).join('; ')} (${await shot()})`);
              }
              // 4. The bottom-right 24 x 24 stays free on a touch screen (an iPad window's resize handle, c32).
              if (viewport.touch || viewport.phone) {
                const corner = p.fixed.filter((t) => t.x + t.w > p.vw - 24 && t.y + t.h > p.vh - 24);
                if (corner.length) problems.push(`${at}: in the resize corner: ${corner.map((t) => `${t.name} (${t.x},${t.y} ${t.w}x${t.h})`).join('; ')} (${await shot()})`);
              }
              // 13. No label spilling out of its control.
              if (p.spill.length) problems.push(`${at}: a label runs out of its control: ${p.spill.join('; ')} (${await shot()})`);
              if (p.crowded.length) problems.push(`${at}: a header too full for its pane: ${p.crowded.join('; ')} (${await shot()})`);
              // 6. No nested scroller under 120 px (A6).
              if (p.scrollers.length) problems.push(`${at}: a scroller under 120 px: ${p.scrollers.join('; ')} (${await shot()})`);
              // 5. Type on a touch screen (A5): 90 % at 12 px or more, none under 11.
              if ((viewport.touch || viewport.phone) && p.type.chars > 0) {
                if (p.type.under11 > 0) problems.push(`${at}: text under 11 px (${p.type.smallest}) (${await shot()})`);
                if (p.type.under12 / p.type.chars > 0.1) problems.push(`${at}: ${Math.round((p.type.under12 / p.type.chars) * 100)} % of the text under 12 px, e.g. ${p.type.small.join('; ')} (${await shot()})`);
              }
              // 8. No keycap on a touch screen before a key is pressed (A4).
              if ((viewport.touch || viewport.phone) && p.keycaps > 0) problems.push(`${at}: ${p.keycaps} keycaps with no key pressed (${await shot()})`);
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
              // c33: put away what the step opened, before the next state.
              if (s.undo) await s.undo(page);
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

/**
 * 6.2 #8-#11 (c33): what a window's change must keep, the on-screen keyboard, hover and the keycaps,
 * each in its own context.
 *
 *   9. Rotation and resize: a session's draft, a Question card's own answer, an open TodoSheet's text and
 *      Chat's draft survive 820 x 1180 ⇄ 1180 x 820 and the widths where the chrome changes (639 ⇄ 640
 *      and 1023 ⇄ 1024 on a touch screen, 767 ⇄ 768 on a Mac). A remount is caught by DOM identity: the
 *      nodes are tagged with data-probe before the resize, and must still carry it after.
 *  10. The on-screen keyboard, with a stand-in visualViewport (Chromium's can't be shrunk): --vvh and --kb
 *      set, the composer on the keyboard and the header in view, the key row out, the shell following a
 *      pan, a form sheet ending 16 above the keyboard; a 55 px shrink (the shortcut bar) turns the
 *      keyboard flag on and keeps the key row hidden; a 20 px shrink changes nothing.
 *  11. Hover: a mouse's move says data-input="mouse" and tints a ledger row; a star's hover previews
 *      and sends nothing.
 *   8. Keycaps: none on a touch screen until a key is pressed; then the board's show.
 */
describe.skipIf(!ready)('0.12 c33: rotation, the on-screen keyboard, hover and keycaps', () => {
  let browser: Browser;
  let server: WebServer;
  // The chat variant: everything the default one has, and Chat on.
  const fixture = webFixtureV08({ accounts: 'cswap', variant: 'chat' });

  beforeAll(async () => {
    browser = await chromium.launch();
    server = await serveWebApp(DIST, () => fixture);
  });
  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await server?.close();
  });

  /** A context at `v`, with a stand-in visualViewport the test drives (window.__vv). */
  async function open(v: Viewport, path: string, fakeViewport = false) {
    const o = await openTouchable(browser, v, fixture);
    if (fakeViewport)
      await o.page.addInitScript(() => {
        const vv = new EventTarget() as EventTarget & Record<string, number>;
        Object.assign(vv, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true });
        (window as unknown as { __vv: typeof vv }).__vv = vv;
      });
    await o.page.goto(`${server.base}${path}`, { waitUntil: 'networkidle' });
    return o;
  }

  /** Opens `path` the way the app does (the router follows history), then lets it load. */
  async function go(page: Page, path: string) {
    await page.evaluate((to) => {
      history.pushState(null, '', to);
      dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(500);
  }

  /** Tag `selector`'s first match: a remount makes a new node without the tag. */
  const tag = (page: Page, selector: string, name: string) =>
    page.evaluate(
      ([s, n]) => {
        const el = document.querySelector(s);
        if (!el) throw new Error(`nothing matches ${s}`);
        el.setAttribute('data-probe', n);
      },
      [selector, name] as const,
    );
  const tagged = (page: Page, name: string) => page.evaluate((n) => document.querySelector(`[data-probe="${n}"]`) !== null, name);

  /** Resize and let the panes settle (a SplitPane measures in a layout effect, a ResizeObserver after). */
  async function resize(page: Page, width: number, height: number) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
  }

  const CROSSINGS: Array<{ name: string; from: Viewport; to: { width: number; height: number } }> = [
    { name: 'rotating an 11-inch iPad', from: { width: 820, height: 1180, touch: true }, to: { width: 1180, height: 820 } },
    { name: '639 ⇄ 640 on a touch screen (phone ⇄ touch shell)', from: { width: 639, height: 900, touch: true }, to: { width: 640, height: 900 } },
    { name: '1023 ⇄ 1024 on a touch screen (rail ⇄ sidebar)', from: { width: 1023, height: 820, touch: true }, to: { width: 1024, height: 820 } },
    { name: '767 ⇄ 768 on a Mac (phone ⇄ desk)', from: { width: 767, height: 900 }, to: { width: 768, height: 900 } },
  ];

  for (const c of CROSSINGS) {
    it(`9. ${c.name} keeps the session's draft, a card's own answer, a sheet's text and Chat's draft`, async () => {
      const { page, watch, close } = await open(c.from, `/s/${sidOf(4)}`);
      const there = async () => {
        await resize(page, c.to.width, c.to.height);
        await resize(page, c.from.width, c.from.height);
      };
      try {
        // A session's draft, in the composer and its session around it.
        const box = page.getByLabel('Prompt for Claude');
        await box.fill('a draft the rotation must keep');
        await tag(page, 'textarea[aria-label="Prompt for Claude"], form[aria-label="Send a prompt"] textarea', 'composer');
        await tag(page, '[data-transcript]', 'transcript');
        await there();
        expect(await tagged(page, 'composer'), 'the composer was remounted').toBe(true);
        expect(await tagged(page, 'transcript'), 'the transcript was remounted').toBe(true);
        expect(await page.getByLabel('Prompt for Claude').inputValue()).toBe('a draft the rotation must keep');

        // A Question card: Type something, and its own answer.
        await go(page, `/s/${sidOf(1)}`);
        await page.getByRole('radio', { name: 'Type something' }).first().check({ force: true });
        const own = page.getByPlaceholder('Your own answer').first();
        await own.fill('my own answer');
        await tag(page, '[data-dock-frame]', 'card');
        await there();
        expect(await tagged(page, 'card'), 'the Question card was remounted').toBe(true);
        expect(await page.getByPlaceholder('Your own answer').first().inputValue()).toBe('my own answer');

        // An open TodoSheet's title.
        await go(page, '/todos');
        await page.getByRole('button', { name: 'Add todo' }).click();
        const title = page.getByRole('dialog', { name: 'New todo' }).getByRole('textbox').first();
        await title.fill('Buy oat milk');
        await tag(page, 'form[aria-label="New todo"]', 'sheet');
        await there();
        expect(await tagged(page, 'sheet'), 'the TodoSheet form was remounted').toBe(true);
        expect(await page.getByRole('dialog', { name: 'New todo' }).getByRole('textbox').first().inputValue()).toBe('Buy oat milk');
        await page.getByRole('dialog', { name: 'New todo' }).getByRole('button', { name: 'Cancel' }).click();

        // Chat's draft.
        await go(page, '/chat');
        const chat = page.getByRole('textbox', { name: 'A message to Chat' });
        await chat.fill('what did I eat today');
        await there();
        expect(await page.getByRole('textbox', { name: 'A message to Chat' }).inputValue()).toBe('what did I eat today');
        expect(consoleProblems(watch, c.name)).toEqual([]);
      } finally {
        await close();
      }
    }, perfBudgetMs(120_000));
  }

  // New session's start form is in the pane beside the folders at 1180 and the sheet over them at 820: it is built
  // again in its new place, so this proves what it holds is read back, not the same node.
  it("9. rotating an 11-inch iPad keeps New session's Name and picks, there and back", async () => {
    const { page, watch, close } = await open({ width: 1180, height: 820, touch: true, insets: IPAD }, '/new?root=r.work&path=jantar&start=1');
    const form = () => page.locator('section[aria-label="Start a session"]').first();
    const read = () =>
      form().evaluate((el) => ({
        name: (el.querySelector('input[id$="-name"]') as HTMLInputElement | null)?.value ?? null,
        picks: [...el.querySelectorAll('[role="radiogroup"]')].slice(0, 4).map((g) => g.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? null),
      }));
    try {
      await form().getByRole('textbox', { name: 'Name' }).fill('my-named-session');
      await form().getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'high', exact: true }).click();
      await form().getByRole('radiogroup', { name: 'Permissions' }).getByRole('radio', { name: 'Plan', exact: true }).click();
      await form().getByRole('textbox', { name: 'First prompt (optional)' }).fill('fix the login');
      const before = await read();
      expect(before).toEqual({ name: 'my-named-session', picks: ['Plan', expect.any(String), 'high', expect.any(String)] });
      await resize(page, 820, 1180);
      expect(await page.getByRole('dialog').count(), 'portrait shows the form as a sheet').toBe(1);
      expect(await read(), 'the sheet in portrait').toEqual(before);
      await resize(page, 1180, 820);
      expect(await page.getByRole('dialog').count(), 'landscape shows the form beside the folders').toBe(0);
      expect(await read(), 'the pane in landscape again').toEqual(before);
      expect(await form().getByRole('textbox', { name: 'First prompt (optional)' }).inputValue()).toBe('fix the login');
      expect(consoleProblems(watch, 'new session rotation')).toEqual([]);
    } finally {
      await close();
    }
  }, perfBudgetMs(90_000));

  /**
   * 10, on the phone's bottom sheet (the phone, and an iPad's half-width Split View): with the keyboard up the
   * sheet is no taller than what is above it, scrolls, and the focused field is brought into view: its top on
   * screen and its first line above the keyboard.
   */
  for (const at of [
    { name: 'a phone', v: { width: 390, height: 844, phone: true }, kb: 380 },
    { name: 'half an 11-inch iPad (Split View)', v: { width: 585, height: 820, touch: true }, kb: 420 },
  ] satisfies Array<{ name: string; v: Viewport; kb: number }>) {
    it(`10. a bottom sheet on ${at.name} keeps every field it focuses above the keyboard`, async () => {
      const H = at.v.height;
      const { page, close } = await open(at.v, '/todos', true);
      const vv = (height: number) =>
        page.evaluate((h) => {
          const v = (window as unknown as { __vv: EventTarget & Record<string, number> }).__vv;
          v.height = h;
          v.dispatchEvent(new Event('resize'));
        }, height);
      const hidden: string[] = [];
      /** Every text field of the open sheet, one at a time: focus it, raise the keyboard, read where it is, put both away. */
      const each = async (sheetName: string) => {
        const sheet = page.getByRole('dialog').first();
        await sheet.waitFor({ timeout: 5000 });
        await page.waitForTimeout(500);
        expect(await sheet.getAttribute('data-present'), 'the phone bottom sheet').toBe('bottom');
        const fields = sheet.locator('input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="number"], input[inputmode], textarea');
        const n = await fields.count();
        expect(n, `${sheetName} has fields`).toBeGreaterThan(1);
        for (let i = 0; i < n; i += 1) {
          const f = fields.nth(i);
          if (!(await f.isVisible())) continue;
          await f.focus();
          await vv(H - at.kb);
          await page.waitForTimeout(400);
          const r = await f.evaluate((el) => {
            const b = el.getBoundingClientRect();
            return { top: Math.round(b.top), bottom: Math.round(b.bottom), name: el.getAttribute('aria-label') ?? (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? el.getAttribute('placeholder') ?? el.tagName };
          });
          // Its first line: a text field's whole box, a textarea's first 32 px.
          if (r.top < 0 || Math.min(r.bottom, r.top + 32) > H - at.kb + 1) hidden.push(`${sheetName} ${r.name}: ${r.top}-${r.bottom} with the keyboard from ${H - at.kb}`);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await vv(H);
          await page.waitForTimeout(1200);
        }
      };
      try {
        // The New todo sheet.
        await page.getByRole('button', { name: 'Add todo' }).first().click();
        await each('New todo');
        await page.getByRole('dialog', { name: 'New todo' }).getByRole('button', { name: 'Cancel' }).click();
        await page.waitForTimeout(500);
        // A café's Edit, the tallest: its Name, Area and Link were under the screen's top.
        await go(page, `/places?id=${lid(701)}`);
        await page.locator('main').getByRole('button', { name: /^Edit\b/ }).first().click();
        await each('the café sheet');
        expect(hidden, hidden.join('\n')).toEqual([]);
      } finally {
        await close();
      }
    }, perfBudgetMs(120_000));
  }

  it('10. the on-screen keyboard: the composer on it, the header in view, the key row, a pan, a form sheet; 55 and 20 px shrinks', async () => {
    const H = 1180;
    const { page, close } = await open({ width: 820, height: H, touch: true, insets: IPAD }, `/s/${sidOf(4)}`, true);
    const vv = (o: { height?: number; offsetTop?: number; event?: 'resize' | 'scroll' }) =>
      page.evaluate((x) => {
        const v = (window as unknown as { __vv: EventTarget & Record<string, number> }).__vv;
        if (x.height !== undefined) v.height = x.height;
        if (x.offsetTop !== undefined) v.offsetTop = x.offsetTop;
        v.dispatchEvent(new Event(x.event ?? 'resize'));
      }, o);
    const vars = () => page.evaluate(() => ({ vvh: document.documentElement.style.getPropertyValue('--vvh'), kb: document.documentElement.style.getPropertyValue('--kb'), vvt: document.documentElement.style.getPropertyValue('--vvt') }));
    try {
      // A 20 px shrink with a field focused: nothing (the floating keyboard, or a minimised bar).
      await page.getByLabel('Prompt for Claude').focus();
      await vv({ height: H - 20 });
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => localStorage.getItem('jantar:kb'))).not.toBe('true');
      expect(await page.locator('[data-key-row]').count()).toBe(0);

      // The docked keyboard: 847 of 1180 is not enough to say so (333 > 200 is): use 402.
      await vv({ height: 402 });
      await page.waitForTimeout(300);
      expect(await vars()).toMatchObject({ vvh: '402px', kb: `${H - 402}px` });
      const composer = await page.locator('form[aria-label="Send a prompt"]').boundingBox();
      expect(composer && composer.y + composer.height, 'the composer sits on the keyboard').toBeLessThanOrEqual(402 + 1);
      const header = await page.locator('#main header').first().boundingBox();
      expect(header?.y ?? -1, "the session's header stays in view").toBeGreaterThanOrEqual(0);
      await expect.poll(() => page.locator('[data-key-row]').isVisible()).toBe(true);

      // A pan: the shell moves down with it, so the header stays at the visual viewport's top.
      await vv({ offsetTop: 60, event: 'scroll' });
      await page.waitForTimeout(200);
      expect((await vars()).vvt).toBe('60px');
      const shell = await page.locator('[data-chrome]').boundingBox();
      expect(shell?.y).toBe(60);
      await vv({ offsetTop: 0, event: 'scroll' });

      // A form sheet over the keyboard: it ends 16 above it, and nothing of it is under it.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await vv({ height: H });
      await page.waitForTimeout(1200);
      await go(page, '/todos');
      await page.getByRole('button', { name: 'Add todo' }).click();
      const sheet = page.getByRole('dialog', { name: 'New todo' });
      await sheet.getByRole('textbox').first().focus();
      await vv({ height: 600 });
      await page.waitForTimeout(400);
      const box = await sheet.boundingBox();
      expect(box && box.y + box.height, 'the sheet ends above the keyboard').toBeLessThanOrEqual(600 - 16 + 1);
      const below = await sheet.evaluate((el, vb) => [...el.querySelectorAll('button, input, textarea, select, a[href]')].filter((c) => c.getBoundingClientRect().height > 0 && c.getBoundingClientRect().bottom > vb).length, 600);
      expect(below, 'a control of the sheet under the keyboard').toBe(0);
      await sheet.getByRole('button', { name: 'Cancel' }).click().catch(() => undefined);

      // A 55 px shrink with a field focused: the shortcut bar, so a keyboard is attached; no key row.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await vv({ height: H });
      await page.waitForTimeout(1200);
      await go(page, `/s/${sidOf(4)}`);
      await page.getByLabel('Prompt for Claude').focus();
      await vv({ height: H - 55 });
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => localStorage.getItem('jantar:kb'))).toBe('true');
      expect(await page.locator('[data-key-row]').count()).toBe(0);
    } finally {
      await close();
    }
  }, perfBudgetMs(120_000));

  it('11. hover: a mouse says so and tints a ledger row; a star previews and sends nothing', async () => {
    const { page, close } = await open({ width: 1180, height: 820, touch: true, insets: IPAD }, '/');
    try {
      const patches: string[] = [];
      page.on('request', (r) => {
        if (r.method() !== 'GET') patches.push(`${r.method()} ${new URL(r.url()).pathname}`);
      });
      expect(await page.evaluate(() => document.documentElement.dataset.input ?? '')).not.toBe('mouse');
      const row = page.locator('#main a[data-row]').nth(1);
      const before = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
      const r = await row.boundingBox();
      if (!r) throw new Error('no ledger row');
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => document.documentElement.dataset.input)).toBe('mouse');
      expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor), 'the hovered row is tinted').not.toBe(before);

      await go(page, `/places?id=${lid(701)}`);
      const star = page.getByRole('radiogroup').first().getByRole('radio').nth(1);
      await star.waitFor();
      const s = await star.boundingBox();
      if (!s) throw new Error('no star');
      await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
      await page.waitForTimeout(400);
      expect(patches.filter((p) => p.includes('/v1/places')), 'a hover sent a change').toEqual([]);
    } finally {
      await close();
    }
  }, perfBudgetMs(90_000));

  it('8. keycaps: none on a touch screen until a key is pressed, then the board shows them', async () => {
    const { page, close } = await open({ width: 1180, height: 820, touch: true, insets: IPAD }, '/');
    const caps = () => page.evaluate(() => [...document.querySelectorAll('kbd')].filter((k) => k.checkVisibility()).length);
    try {
      expect(await caps()).toBe(0);
      await page.keyboard.press('Shift');
      await expect.poll(caps).toBeGreaterThan(0);
    } finally {
      await close();
    }
  }, perfBudgetMs(60_000));
});

function consoleProblems(watch: Watch, size: string): string[] {
  return [...watch.csp.map((t) => `${size}: CSP: ${t}`), ...watch.errors.map((t) => `${size}: console: ${t}`)];
}
