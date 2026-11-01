/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * LW1 (v0.4 spec 6, 9.1 "CSP and layout"): the v0.4 screens of the BUILT
 * web app in a real headless Chromium, served by jantard itself (in-process
 * on a synthetic HOME, harness.ts) with its real headers and the build's
 * strict <meta> policy, on Life and Intel data written through the API.
 * Each browser pairs the way a phone does (/pair#c=..., "Pair this device").
 *
 * - Every screen and sheet, at 390 px and 1440 px in both themes: no
 *   console message about the Content Security Policy, no console error,
 *   no <style> element, `window.__pwned` never set, nothing sticking out
 *   sideways: Today with every section and the push warning, the dose
 *   sheet (from a row and from a push's link), Todos with Reminders, a
 *   project and its screen, Medicines, Food with weight, Cafés, Finance,
 *   Intel with a hostile item, More and the start sheet with Resume.
 * - The sheets: todo, project, medicine, food (Type, Saved, Ask Claude with
 *   its rows), weight, target, café, expense, budget, bill, Intel's add.
 * - Done shows the 5 s Undo line and Undo takes it back; a saved food's
 *   "Added" Undo too; Ask Claude's rows save nothing until added. Delete
 *   asks nothing: Undo keeps the todo, and a delete left alone reaches the
 *   Mac after its 5 s. On a long list the Undo of the last row, deleted or
 *   done, is a bar inside the visible area.
 * - The phone's tabs: Today is current on every Life screen, More holds
 *   the places past the fifth tab and opens them.
 * - In grayscale, the five dose states (taken, skipped, overdue, due,
 *   pending) still read apart by glyph and words.
 * - Focus: Tab walks each screen in document order over visible, named
 *   stops, and a sheet keeps it inside.
 *
 * The Life zone is one whose clock reads 14:xx during the run, so the
 * medicine rows have a taken, a skipped, an overdue, a due and a later dose
 * today whatever the hour; the browsers use the same zone. Every name and
 * value is synthetic. Needs a built dist/ and a Chromium (browser.ts).
 */
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import {
  LAUNCH_HELD,
  PAST_SESSIONS,
  billBody,
  launchAccounts,
  medBody,
  moneyBody,
  perfBudgetMs,
  placeBody,
  projectBody,
  todoBody,
  writeIntelJsonl,
  writePastSessions,
} from '@jantar/fixtures';
import { DEVICE_COOKIE, type FoodDay, type MedicinesResponse, type PairStartResponse, type TodosResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { DESK, PHONE, browserReady, clean, expectSaneFocus, focusWalk, glyphShape, grayscale, overflow, watchConsole, type Viewport, type Watch } from './browser.js';
import { bootDaemon, fakeBinsSettings, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const ready = await browserReady('web-v04.integration');

const SID = '74747474-7474-4747-8747-747474747474';
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;
/** Hours ahead of UTC that put the Life clock at 14:xx now (Etc/GMT's sign is the other way round). */
const K = 14 - new Date().getUTCHours();
const ZONE = K === 0 ? 'UTC' : K > 0 ? `Etc/GMT-${K}` : `Etc/GMT+${-K}`;
/** The Life zone's wall clock, read with the UTC getters. */
const wall = (ms = Date.now()) => new Date(ms + K * HOUR);
const TODAY = wall().toISOString().slice(0, 10);
const day = (n: number) => wall(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
/** Five minutes ago on the Life clock: its dose is due, not yet overdue. */
const DUE_SLOT = wall(Date.now() - 5 * 60_000).toISOString().slice(11, 16);
const NEWEST_PAST = PAST_SESSIONS[0]!.id;

type Scheme = 'light' | 'dark';
const VIEWS: ReadonlyArray<{ who: 'phone' | 'desk'; scheme: Scheme }> = [
  { who: 'phone', scheme: 'light' },
  { who: 'phone', scheme: 'dark' },
  { who: 'desk', scheme: 'light' },
  { who: 'desk', scheme: 'dark' },
];

describe.skipIf(!ready)('LW1: the v0.4 screens in Chromium, served by jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let cookie: string;
  let browser: Browser;
  const ids: Record<string, string> = {};
  const pages: Partial<Record<'phone' | 'desk', { ctx: BrowserContext; page: Page; watch: Watch }>> = {};
  let intelFile = '';

  const call = (method: string, path: string, body?: unknown) => http(d.port, method, path, { cookie, ...(body === undefined ? {} : { body }) });
  async function made(name: string, method: string, path: string, body: unknown): Promise<string> {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}: ${r.text}`).toBe(200);
    const id = (r.body as { id?: string }).id ?? '';
    ids[name] = id;
    return id;
  }

  /** A browser context paired through the pairing page, as a phone scanning the Mac's code would be. */
  async function paired(vp: Viewport, name: string): Promise<{ ctx: BrowserContext; page: Page; watch: Watch }> {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.phone === true,
      hasTouch: vp.phone === true,
      colorScheme: 'light',
      locale: 'en-GB',
      timezoneId: ZONE,
      serviceWorkers: 'block',
    });
    const page = await ctx.newPage();
    const watch = watchConsole(page);
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes: ['read', 'control', 'admin', 'launch'] });
    await page.goto(`http://127.0.0.1:${d.port}/pair#c=${start.code}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Paired' }).waitFor();
    // Before the claim the app's first calls answer 401: expected, and over now.
    watch.errors.length = 0;
    await check(page, watch, `${name}: paired`);
    return { ctx, page, watch };
  }

  /** Clean console, no <style>, nothing ran, nothing past the sides of the viewport. */
  async function check(page: Page, watch: Watch, what: string) {
    // Sheets and pushed screens finish sliding in first.
    await page.waitForTimeout(400);
    await clean(page, watch);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned), what).toBeUndefined();
    expect(await overflow(page), what).toEqual([]);
  }

  /** Opens `path` in each view (both themes on the phone and the desk), runs `fn` there and checks the page. */
  async function inEachView(path: string, fn: (page: Page, what: string, watch: Watch) => Promise<void>) {
    for (const v of VIEWS) {
      const { page, watch } = pages[v.who]!;
      await page.emulateMedia({ colorScheme: v.scheme });
      await page.goto(`http://127.0.0.1:${d.port}${path}`, { waitUntil: 'load' });
      const what = `${path} (${v.who}, ${v.scheme})`;
      await fn(page, what, watch);
      await check(page, watch, what);
    }
  }

  /** Opens a sheet with `open`, checks it, and closes it with Escape. */
  async function sheet(page: Page, watch: Watch, what: string, open: () => Promise<void>, inside?: (dialog: Locator) => Promise<void>) {
    await open();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await inside?.(dialog);
    await check(page, watch, what);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }

  beforeAll(async () => {
    d = await bootDaemon({
      home: {
        accounts: launchAccounts(),
        sessions: [{ sid: SID, pid: 74001, account: 5, project: 'demo-app', status: 'idle', tty: 'ttys074', transcript: [] }],
      },
      before: async (home) => {
        intelFile = join(home.home, 'bot', 'intel.jsonl');
        await writeIntelJsonl(intelFile, { count: 30, extras: true });
        await mkdir(join(home.home, 'Desktop', 'work', 'foo'), { recursive: true });
        // Claude keys a folder's history by its real path (/private/var/... for a temp dir on macOS).
        await writePastSessions(home, await realpath(join(home.home, 'Desktop', 'work', 'foo')), PAST_SESSIONS);
      },
      settings: (home) => ({
        bins: fakeBinsSettings(home),
        accounts: { kept: [...LAUNCH_HELD] },
        files: { enabled: true },
        launch: { enabled: true, mode: 'cswap-run' },
        folders: { roots: [{ id: 'work', path: join(home.home, 'Desktop', 'work'), label: 'Work' }] },
        life: { todos: true, medicines: true, food: true, places: true, finance: true, timezone: ZONE, currency: 'INR' },
        intel: { enabled: true, sources: [intelFile] },
      }),
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');

    // The data, written from a paired device the way the phone writes it.
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'seed', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'seed' } });
    expect(claim.status, claim.text).toBe(200);
    cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);

    const project = await made('project', 'POST', '/v1/projects', projectBody({ folder: d.home.session(SID).cwd, due: day(3) }));
    await made('overdue', 'POST', '/v1/todos', todoBody({ title: 'Example overdue todo', due: { day: day(-1) } }));
    await made('today', 'POST', '/v1/todos', todoBody({ title: 'Example todo for today', due: { day: TODAY }, priority: 'high' }));
    await made('long', 'POST', '/v1/todos', todoBody({ title: 'Example todo with a long title that has to wrap on a phone without pushing anything sideways', due: { day: TODAY } }));
    await made('inProject', 'POST', '/v1/todos', todoBody({ title: 'Example todo in the project', projectId: project, due: { day: day(2) } }));
    await made('someday', 'POST', '/v1/todos', todoBody({ title: 'Example someday todo' }));
    await made('reminder', 'POST', '/v1/todos', todoBody({ title: 'Example reminder' }, { timed: { day: TODAY, time: '18:30' } }));
    await made('reminder2', 'POST', '/v1/todos', todoBody({ title: 'Example reminder tomorrow' }, { timed: { day: day(1), time: '09:00' } }));

    const daily = { freq: 'daily' as const };
    const taken = await made('taken', 'POST', '/v1/medicines', medBody({ name: 'Testamol', dose: '500 mg', times: ['08:00'], pills: { left: 30, perDose: 1 } }));
    const skipped = await made('skipped', 'POST', '/v1/medicines', { name: 'Placebin', dose: '10 mg', times: ['09:00'], schedule: daily });
    await made('overdueMed', 'POST', '/v1/medicines', { name: 'Examplex', dose: '1000 IU', times: ['11:00'], schedule: daily, pills: { left: 3, perDose: 1 } });
    await made('due', 'POST', '/v1/medicines', { name: 'Mockacin', dose: '250 mg', times: [DUE_SLOT], schedule: daily });
    await made('later', 'POST', '/v1/medicines', { name: 'Fixturol', dose: '5 mg', times: ['20:30'], schedule: daily });
    await made('takenDose', 'POST', `/v1/medicines/${taken}/doses`, { day: TODAY, slot: '08:00', status: 'taken' });
    await made('skippedDose', 'POST', `/v1/medicines/${skipped}/doses`, { day: TODAY, slot: '09:00', status: 'skipped' });

    await made('poha', 'POST', '/v1/food', { day: TODAY, name: 'Sample Poha', kcal: 280 });
    await made('dosa', 'POST', '/v1/food', { day: TODAY, name: 'Sample Dosa', kcal: 350, save: true });
    expect((await call('PUT', '/v1/food/targets', { kcalTarget: 1800, goalKg: 70 })).status).toBe(200);
    for (const [n, kg] of [
      [-30, 74],
      [-7, 73],
      [0, 72.4],
    ] as const) {
      expect((await call('PUT', `/v1/weights/${day(n)}`, { kg })).status).toBe(200);
    }

    await made('cafe', 'POST', '/v1/places', placeBody());
    await made('bistro', 'POST', '/v1/places', placeBody({ name: 'Sample Bistro', area: 'Example Market', tried: false, dishes: [{ name: 'Sample Thali', rating: 4 }] }));

    await made('groceries', 'POST', '/v1/money', moneyBody({ day: TODAY }));
    await made('dinners', 'POST', '/v1/money', moneyBody({ day: TODAY, category: 'Food', amount: 900_000, note: 'Example dinners' }));
    await made('salary', 'POST', '/v1/money', moneyBody({ day: TODAY, kind: 'income', category: 'Salary', amount: 12_000_000, note: 'Example salary' }));
    expect((await call('PUT', '/v1/money/budgets', { category: 'Food', amount: 500_000 })).status).toBe(200);
    await made('bill', 'POST', '/v1/bills', billBody({ nextDue: TODAY }));
    await made('gym', 'POST', '/v1/bills', billBody({ name: 'Example Gym', amount: 150_000, nextDue: day(10) }));

    await eventually(async () => {
      const r = await call('GET', '/v1/intel?limit=1');
      return r.status === 200 && (r.body as { total: number }).total > 30;
    }, 15_000, 'the shelf');

    browser = await chromium.launch();
    pages.phone = await paired(PHONE, 'Example phone');
    pages.desk = await paired(DESK, 'Example Mac browser');
  }, perfBudgetMs(90_000));

  afterAll(async () => {
    for (const p of Object.values(pages)) await p?.ctx.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('Today: every section and the push warning; the dose sheet from a row and from a push', async () => {
    await inEachView('/today', async (page) => {
      await page.getByRole('heading', { name: 'Today', level: 1 }).waitFor();
      for (const section of ['Medicines', 'Due', 'Bills', 'Food', 'Claude', 'Life']) await page.getByRole('region', { name: section }).waitFor();
      await page.getByText('No device gets medicine pings.').first().waitFor();
      await page.getByText('Example overdue todo').waitFor();
      await page.getByText('Example Stream').first().waitFor();
      // A display title truncates on one line: its balance must not reset text-wrap-mode under `truncate`.
      const modes = await page.evaluate(() => [...document.querySelectorAll('h1[data-display]')].map((h) => getComputedStyle(h).getPropertyValue('text-wrap-mode')));
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.every((m) => m === 'nowrap'), modes.join(', ')).toBe(true);
    });

    for (const who of ['phone', 'desk'] as const) {
      const { page, watch } = pages[who]!;
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`http://127.0.0.1:${d.port}/today`);
      await sheet(page, watch, `the dose sheet from a row (${who})`, () => page.getByRole('button', { name: `Mockacin 250 mg at ${DUE_SLOT}, due` }).click(), async (dialog) => {
        await dialog.getByRole('button', { name: 'Taken' }).waitFor();
        await dialog.getByText('Not logged yet').waitFor();
      });
      // A medicine push opens Today on that dose.
      await page.goto(`http://127.0.0.1:${d.port}/today?dose=${ids.due}@${DUE_SLOT.replace(':', '')}`);
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Taken' }).waitFor();
      await check(page, watch, `the dose sheet from a push (${who})`);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    }
    // Looking is not logging.
    const meds = (await call('GET', `/v1/medicines?day=${TODAY}`)).body as MedicinesResponse;
    expect(meds.day.groups.flatMap((g) => g.items).find((i) => i.medId === ids.due)?.status).toBe('pending');
  });

  it('Todos with Reminders and a project, its screen and the sheets; Done and Delete show Undo, and Undo takes them back', async () => {
    await inEachView('/todos', async (page, what, watch) => {
      await page.getByText('Example overdue todo').waitFor();
      await page.getByText('Example someday todo').waitFor();
      await page.getByRole('button', { name: 'Reminders' }).click();
      await page.getByText('Example reminder tomorrow').waitFor();
      await check(page, watch, `${what}, Reminders`);
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.getByText('Example project').first().click();
      await page.getByText('Example todo in the project').waitFor();
    });

    const { page, watch } = pages.phone!;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`http://127.0.0.1:${d.port}/todos`);
    await page.getByText('Example todo for today').waitFor();
    await sheet(page, watch, 'the todo sheet', () => page.getByRole('button', { name: 'Add todo' }).click());
    await sheet(page, watch, 'a todo opened', () => page.getByText('Example todo for today').click());
    await page.getByRole('button', { name: 'Projects' }).click();
    await sheet(page, watch, 'the project sheet', () => page.getByRole('button', { name: 'Add project' }).click());

    await page.getByRole('button', { name: 'Todos' }).click();
    await page.getByRole('button', { name: 'Mark done: Example todo for today' }).click();
    const undo = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Undo' }) });
    await undo.waitFor();
    await check(page, watch, 'the Undo line after Done');
    const open = async () => ((await call('GET', '/v1/todos')).body as TodosResponse).todos.some((t) => t.id === ids.today);
    expect(await open()).toBe(false);
    await undo.getByRole('button', { name: 'Undo' }).click();
    await eventually(open, 5_000, 'Undo to reopen the todo');
    await page.getByRole('button', { name: 'Mark done: Example todo for today' }).waitFor();
    await check(page, watch, 'after Undo');

    // Delete asks nothing: the row goes at once and the delete waits out its 5 s Undo before it reaches the Mac.
    const listed = async () => ((await call('GET', '/v1/todos')).body as TodosResponse).todos.some((t) => t.id === ids.someday);
    const remove = async () => {
      await page.getByRole('button', { name: 'Actions for Example someday todo' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      const line = page.getByRole('status').filter({ hasText: 'Deleted: Example someday todo' });
      await line.waitFor();
      return line;
    };
    const held = await remove();
    expect(await page.getByRole('dialog').count()).toBe(0);
    await check(page, watch, 'the Undo line after Delete');
    expect(await listed()).toBe(true);
    await held.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Example someday todo').waitFor();
    await remove();
    await eventually(async () => !(await listed()), 10_000, 'the held delete to reach the Mac');
    await check(page, watch, 'after the delete is sent');
  });

  it('a long list: the Undo of a row deleted or done far down is a bar in view, not a line scrolled away', async () => {
    const fillers: string[] = [];
    for (let i = 1; i <= 16; i++) fillers.push(await made(`filler${i}`, 'POST', '/v1/todos', todoBody({ title: `Example filler todo ${String(i).padStart(2, '0')}` })));
    try {
      const { page, watch } = pages.phone!;
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`http://127.0.0.1:${d.port}/todos`);
      const menus = page.getByRole('button', { name: /^Actions for Example filler todo/ });
      await menus.first().waitFor();
      const main = await page.locator('#main').boundingBox();
      const inView = async (what: string) => {
        const bar = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Undo' }) });
        await bar.waitFor();
        const box = await bar.boundingBox();
        expect(box && main, what).toBeTruthy();
        expect(box!.y, what).toBeGreaterThanOrEqual(main!.y);
        expect(box!.y + box!.height, what).toBeLessThanOrEqual(main!.y + main!.height + 0.5);
        await check(page, watch, what);
        await bar.getByRole('button', { name: 'Undo' }).click();
        await bar.waitFor({ state: 'detached' });
      };

      // Delete the last row from its menu: the page is scrolled to it.
      const last = menus.last();
      const name = ((await last.getAttribute('aria-label')) ?? '').replace('Actions for ', '');
      await last.click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await inView(`the Undo after deleting ${name}, the last row`);
      await page.getByText(name).waitFor();

      // Mark the last row done.
      await page.getByRole('button', { name: `Mark done: ${name}` }).click();
      await inView(`the Undo after marking ${name} done`);
    } finally {
      for (const id of fillers) await call('DELETE', `/v1/todos/${id}`);
    }
  });

  it('Medicines: every dose state, its sheet; in grayscale the five states still read apart', async () => {
    await inEachView('/meds', async (page) => {
      await page.getByRole('heading', { name: 'Medicines', level: 1 }).waitFor();
      await page.getByText('No device gets medicine pings.').first().waitFor();
      await page.locator(`[data-dose="${ids.later}@20:30"]`).first().waitFor();
    });

    const { page, watch } = pages.phone!;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`http://127.0.0.1:${d.port}/meds`);
    await page.locator(`[data-dose="${ids.later}@20:30"]`).first().waitFor();
    await sheet(page, watch, 'the medicine sheet', () => page.getByRole('button', { name: 'Add medicine' }).click());

    await grayscale(page);
    const rows: Array<[string, string]> = [
      ['taken', `${ids.taken}@08:00`],
      ['skipped', `${ids.skipped}@09:00`],
      ['overdue', `${ids.overdueMed}@11:00`],
      ['due', `${ids.due}@${DUE_SLOT}`],
      ['pending', `${ids.later}@20:30`],
    ];
    const seen = new Map<string, string>();
    for (const [state, key] of rows) {
      const row = page.locator(`[data-dose="${key}"]`).first();
      // Without colour: the glyph's shape, the words at the end of the row (times and names aside) and the check.
      const words = (await row.evaluate((el) => (el.lastElementChild?.textContent ?? '').replace(/[\d:]/g, '').trim())) || '-';
      const tick = (await row.locator('svg:not([data-glyph])').count()) > 0 ? 'tick' : '';
      const k = `${await glyphShape(row)}|${words}|${tick}`;
      expect(seen.get(k), `${state} looks the same as ${seen.get(k)} in grayscale`).toBeUndefined();
      seen.set(k, state);
    }
    expect(seen.size).toBe(5);
  });

  it('Food with weight; the add sheet: Type, Saved with its Undo, and Ask Claude, which saves nothing', async () => {
    await inEachView('/food', async (page) => {
      await page.getByText('Sample Poha').waitFor();
      await page.getByText(/72\.4/).first().waitFor();
    });

    const { page, watch } = pages.phone!;
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`http://127.0.0.1:${d.port}/food`);
    await page.getByText('Sample Poha').waitFor();
    await sheet(page, watch, 'the weight sheet', () => page.getByText(/72\.4/).first().click());
    await sheet(page, watch, 'the target sheet', () => page.getByRole('button', { name: /^Daily target/ }).click());

    const before = ((await call('GET', `/v1/food?day=${TODAY}`)).body as FoodDay).entries.length;
    await page.getByRole('button', { name: 'Add food' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('form', { name: 'Type a food' }).waitFor();
    await check(page, watch, 'the add sheet, Type');

    await dialog.getByRole('button', { name: 'Saved', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add Sample Dosa, 350 kcal' }).click();
    const undo = dialog.getByRole('status').filter({ has: page.getByRole('button', { name: 'Undo' }) });
    await undo.waitFor();
    await check(page, watch, 'the add sheet, Saved, with its Undo');
    await undo.getByRole('button', { name: 'Undo' }).click();
    await eventually(async () => ((await call('GET', `/v1/food?day=${TODAY}`)).body as FoodDay).entries.length === before, 5_000, 'Undo to take the saved food back');

    await dialog.getByRole('button', { name: 'Ask Claude' }).click();
    await dialog.getByLabel('What did you eat?').fill('2 rotis and dal');
    await dialog.getByRole('button', { name: 'Estimate' }).click();
    const rows = dialog.getByRole('list', { name: "Claude's estimate" });
    await rows.waitFor({ timeout: 30_000 });
    await expect.poll(() => rows.getByRole('textbox', { name: 'Name' }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['Roti', 'Dal']);
    await check(page, watch, "the add sheet, Claude's rows");
    expect(((await call('GET', `/v1/food?day=${TODAY}`)).body as FoodDay).entries.length).toBe(before);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }, perfBudgetMs(90_000));

  it('Cafés and Finance, with their sheets', async () => {
    await inEachView('/places', async (page, what) => {
      await page.getByText('Example Café').first().waitFor();
      await page.getByRole('button', { name: 'Want to try' }).click();
      await page.getByText('Sample Bistro').waitFor();
      await expect.poll(() => page.getByText('Example Café').count(), { message: what }).toBe(0);
    });
    await inEachView('/money', async (page) => {
      await page.getByRole('heading', { name: 'Finance', level: 1 }).waitFor();
      await page.getByRole('region', { name: 'By category' }).getByText('Food').waitFor();
      await page.getByText('Example Gym').waitFor();
    });

    const { page, watch } = pages.phone!;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`http://127.0.0.1:${d.port}/places`);
    await page.getByText('Example Café').first().waitFor();
    await sheet(page, watch, 'a café opened', () => page.getByText('Example Café').first().click());
    await sheet(page, watch, 'the café sheet', () => page.getByRole('button', { name: 'Add café' }).click());

    await page.goto(`http://127.0.0.1:${d.port}/money`);
    await page.getByText('Example Gym').waitFor();
    await sheet(page, watch, 'the expense sheet', () => page.getByRole('button', { name: 'Expense', exact: true }).click());
    await sheet(page, watch, 'the budget sheet', () => page.getByRole('region', { name: 'By category' }).getByRole('button').filter({ hasText: 'Food' }).first().click());
    await sheet(page, watch, 'the bill sheet', () => page.getByText('Example Gym').click());
  });

  it('on the phone the day and month chips and the category rows are 44 px touch targets', async () => {
    const { page } = pages.phone!;
    // Sizes are read on a still screen. Each Life screen slides in (translateY 8px to 0), and a box read part
    // way sits at a fractional offset where Chromium's float corners give 44 px as 43.99997. With reduced
    // motion the screen only fades in.
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const tall = async (target: Locator, what: string) => {
      await target.waitFor();
      expect((await target.boundingBox())?.height ?? 0, what).toBeGreaterThanOrEqual(44);
    };
    try {
      for (const path of [`/food?day=${day(-1)}`, `/meds?day=${day(-1)}`]) {
        await page.goto(`http://127.0.0.1:${d.port}${path}`);
        await tall(page.getByRole('button', { name: 'Today', exact: true }), `the Today chip on ${path}`);
      }
      const month = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
      await page.goto(`http://127.0.0.1:${d.port}/money?month=${month}`);
      await tall(page.getByRole('button', { name: 'This month' }), 'the This month chip');
      await page.goto(`http://127.0.0.1:${d.port}/money`);
      const rows = page.getByRole('region', { name: 'By category' }).getByRole('button');
      await rows.first().waitFor();
      for (let i = 0; i < (await rows.count()); i++) await tall(rows.nth(i), `category row ${i}`);
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
  });

  it('Intel with a hostile item: its title is text, nothing runs, no javascript: link', async () => {
    await inEachView('/intel', async (page) => {
      await page.getByText('<script>window.__pwned=1</script>').first().waitFor();
      expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
    });
    await inEachView(`/intel?item=${encodeURIComponent('intel:ex-script')}`, async (page) => {
      await page.getByText('<script>window.__pwned=1</script>').first().waitFor();
      expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
    });
    await inEachView(`/intel?item=${encodeURIComponent('intel:ex-js-field')}`, async (page) => {
      await page.getByText('javascript:alert(2)').first().waitFor();
      expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
    });
    const { page, watch } = pages.phone!;
    await page.goto(`http://127.0.0.1:${d.port}/intel`);
    await page.getByText('<script>window.__pwned=1</script>').first().waitFor();
    await sheet(page, watch, "Intel's add sheet", () => page.getByRole('button', { name: 'Add', exact: true }).first().click());
    expect(await page.evaluate(() => document.querySelectorAll('script:not([src])').length)).toBe(0);
  });

  it("the phone's tabs: Today is current on a Life screen, and More holds the rest and opens them", async () => {
    const { page, watch } = pages.phone!;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`http://127.0.0.1:${d.port}/meds`);
    const tabs = page.getByRole('navigation', { name: 'Main' });
    await expect.poll(() => tabs.getByRole('link').evaluateAll((els) => els.map((e) => e.textContent?.trim()))).toEqual(['Board', 'Today', 'Files', 'Accounts', 'More']);
    expect(await tabs.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');

    await tabs.getByRole('link', { name: 'More' }).click();
    await page.getByRole('heading', { name: 'More', level: 1 }).waitFor();
    // The places past the fifth tab, which the tab bar does not show.
    for (const place of ['Alerts', 'Devices', 'Intel']) await page.getByRole('link', { name: new RegExp(`^${place}`) }).first().waitFor();
    await check(page, watch, 'More');
    await page.getByRole('link', { name: 'Intel' }).first().click();
    await page.waitForURL(/\/intel$/);
    await page.getByText('<script>window.__pwned=1</script>').first().waitFor();
    expect(await tabs.getByRole('link', { name: 'More' }).getAttribute('aria-current')).toBe('page');
    await check(page, watch, 'Intel from More');

    await inEachView('/more', async (p) => {
      await p.getByRole('heading', { name: 'More', level: 1 }).waitFor();
    });
  });

  it("the start sheet with Resume: Pick… lists the folder's past sessions and the command resumes the one picked", async () => {
    await inEachView('/new?root=r.work&path=foo&start=1', async (page, what, watch) => {
      // A sheet on the phone, the detail pane on the desk.
      const resume = page.getByRole('radiogroup', { name: 'Resume' });
      await resume.waitFor();
      await resume.getByRole('radio', { name: 'Pick…' }).click();
      const list = page.getByRole('list', { name: 'Past sessions' });
      await list.waitFor();
      await list.getByText('fix the push example in the service worker').waitFor();
      await check(page, watch, `${what}, Pick a past session`);
      await list.locator(`[data-past="${NEWEST_PAST}"] button`).click();
      await expect.poll(() => page.locator('[data-command]').textContent()).toContain(`--resume ${NEWEST_PAST}`);
    });
    // Nothing was started.
    expect(await callDaemon<{ jobs: unknown[] }>(ctl, 'GET', '/v1/launches').then((r) => r.jobs.length)).toBe(0);
  });

  it('focus: Tab walks each screen in document order over visible, named stops; a sheet keeps it inside', async () => {
    for (const who of ['phone', 'desk'] as const) {
      const { page } = pages[who]!;
      await page.emulateMedia({ colorScheme: 'light' });
      for (const [path, ready] of [
        ['/today', 'Example overdue todo'],
        ['/todos', 'Example overdue todo'],
        ['/meds', 'Fixturol'],
        ['/food', 'Sample Poha'],
        ['/places', 'Example Café'],
        ['/money', 'Example Gym'],
        ['/intel', 'Example tool 29'],
      ] as const) {
        await page.goto(`http://127.0.0.1:${d.port}${path}`);
        await page.getByText(ready).first().waitFor();
        await expectSaneFocus(page, await focusWalk(page), { what: `${path} (${who})` });
      }
      await page.goto(`http://127.0.0.1:${d.port}/today`);
      await page.getByRole('button', { name: `Mockacin 250 mg at ${DUE_SLOT}, due` }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(400);
      await expectSaneFocus(page, await focusWalk(page), { what: `the dose sheet (${who})`, dialog: true });
      await page.keyboard.press('Escape');
    }
  });
});
