/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * 0.13.0 Work on a phone and an iPad (design 15, F7 and F8), in the BUILT web
 * app, in a real headless Chromium served by jantard itself (in-process on a
 * synthetic HOME with life.todos and life.work on, harness.ts), on made-up
 * clients, deals and projects written through the API. Each browser pairs
 * the way a phone does.
 *
 * - At 320 x 568 and 390 x 844 with touch, every Work route walked the way a
 *   finger does: the Work tab, Projects, a project's hub, Clients, the search
 *   sheet (the header's magnifier) and the New client sheet, a client's page,
 *   a call logged with a next step for today (the follow-up then sits in
 *   Today's Due with the client's name, and Today's Work card counts one deal
 *   fewer with no next step), Deals (the phone's stage picker), a deal, a move
 *   to another stage, the Won and Lost sheets (put away), Insights, the
 *   preview of a small CSV import (nothing imported), the CSV export, then the
 *   Board and the browser's Back.
 * - One iPad pass over the same routes, 1024 x 1366 with touch and the Home
 *   Screen app's safe areas: Work from the sidebar, the projects and clients
 *   tables, a project, a client and a deal open beside their list (split
 *   views), and the deals board.
 * - F7: Accounts, Posts, a post and the New post sheet at each of the three.
 * - On every screen and sheet: no console message about the Content Security
 *   Policy, no console error, no <style> element; nothing scrolling sideways
 *   (the page, or a box not marked data-scroll-x); no target wholly on
 *   screen under 44 x 44; no target that stays put (not in a scroll box) in
 *   the bottom 24 px, nor, on the iPad, under its status bar.
 * - Design 6.5 on every Work route at each size: with Work off (`jantar work
 *   off`) the off page; with life.db broken, Life's 503 sentence.
 * - Her app (her host's /p and p.html) never loads one of Work's chunks
 *   (told by their source maps), while his walks above did.
 *
 * The steps that change the Mac (the logged call and its follow-up, the stage
 * move) run in onPaired (browser.ts): a page that loses its coarse pointer
 * gets it back in place and the steps go on; if it won't come back, `reset`
 * puts the Mac back as seeded and the steps run once more as the same device
 * in a new context. Each walk ends with that reset too, so every size starts
 * from the same Mac. Run it with JANTAR_TOUCH_DROP=every as well.
 *
 * Every name, number and address is made up (example.com). Needs a built
 * dist/ and Playwright's Chromium.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { perfBudgetMs } from '@jantar/fixtures';
import { DEVICE_COOKIE, type PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { under44 } from '../../packages/web/test/layout-metric.js';
import { DIST, IPAD_UA, browserReady, clean, launchBrowser, onPaired, overflow, stillTouch, touchPage, watchConsole, type Rerun, type StorageState, type Viewport, type Watch } from './browser.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';
import { probeLayout, type Probe } from './layout-probe.js';

const ready = await browserReady('web-v013-phone.integration');

const DAY_MS = 86_400_000;
/** A day `n` days from now, in Life's zone (UTC here). */
const day = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);

type Who = 'p320' | 'p390' | 'ipad';
/** The iPad's insets in the Home Screen app: the status bar and the home indicator. */
const IPAD_INSETS = { top: 24, bottom: 20 };
const SIZES: Record<Who, Viewport> = {
  p320: { width: 320, height: 568, phone: true },
  p390: { width: 390, height: 844, phone: true },
  ipad: { width: 1024, height: 1366, touch: true, insets: IPAD_INSETS },
};
const WHO: readonly Who[] = ['p320', 'p390', 'ipad'];

/** Her host (cloudflare mode's people hostname), reached through the test's own route to the daemon. */
const PUBLIC = 'https://jantar.example.com';
const PEOPLE = 'https://us.example.com';
const PEOPLE_HOST = 'us.example.com';

/** The small file the import previews: two new rows and one that is already a client (the same e-mail). */
const CSV = [
  'Name,Company,Email,Phone',
  'Jordan Placeholder,Sample Works,jordan@example.com,+91 90000 00011',
  'Casey Specimen,,casey@example.com,',
  'Pat Example,Example Studio,pat@example.com,',
  '',
].join('\n');

/** The built chunks that hold a Work module, told by their source maps (Work, Clients, Deals, Insights, their sheets). */
function workChunks(): Set<string> {
  const out = new Set<string>();
  const assets = join(DIST, 'assets');
  for (const f of readdirSync(assets).filter((n) => n.endsWith('.js.map'))) {
    const map = JSON.parse(readFileSync(join(assets, f), 'utf8')) as { sources?: string[] };
    if ((map.sources ?? []).some((s) => /(^|\/)ui\/screens\/work\//.test(s))) out.add(f.slice(0, -'.map'.length));
  }
  return out;
}

/** Her app's files, from its own build manifest (as the daemon's personAssets reads it). */
function herFiles(): Set<string> {
  const manifest = JSON.parse(readFileSync(join(DIST, '.vite', 'p-manifest.json'), 'utf8')) as Record<string, { file: string; css?: string[]; assets?: string[] }>;
  const out = new Set<string>();
  for (const e of Object.values(manifest)) for (const f of [e.file, ...(e.css ?? []), ...(e.assets ?? [])]) if (f.startsWith('assets/')) out.add(f.slice('assets/'.length));
  return out;
}

/** A request to the daemon as her host receives it (Host: us.example.com); the raw answer. */
function onHerHost(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: Buffer | null): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...headers, host: PEOPLE_HOST }, timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: flat(res.headers), body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body?.length) req.write(body);
    req.end();
  });
}

function flat(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || ['connection', 'keep-alive', 'transfer-encoding'].includes(k)) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

interface Opened {
  ctx: BrowserContext;
  page: Page;
  watch: Watch;
}

describe.skipIf(!ready)('0.13.0 Work on a phone and an iPad, in Chromium, served by jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let cookie: string;
  let browser: Browser;
  const ids: Record<string, string> = {};
  const pages: Partial<Record<Who, Opened>> = {};
  /** Every /assets/ file his pages asked for (the positive side of her app's check). */
  const hisAssets = new Set<string>();
  const WORK_CHUNKS = ready ? workChunks() : new Set<string>();

  const base = () => `http://127.0.0.1:${d.port}`;
  const call = (method: string, path: string, body?: unknown) => http(d.port, method, path, { cookie, ...(body === undefined ? {} : { body }) });
  async function made(name: string, path: string, body: unknown): Promise<{ id: string; companyId?: string }> {
    const r = await call('POST', path, body);
    expect(r.status, `POST ${path}: ${r.text}`).toBe(200);
    const reply = r.body as { id: string; companyId?: string };
    ids[name] = reply.id;
    return reply;
  }
  const cli = async (...args: string[]) => {
    const io = memoryIo();
    const code = await main(args, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  };

  /** A context paired as a phone (or an iPad) scanning the Mac's code; 0.12.1: or, with `state`, that device again in a new one. */
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
    // iPadOS's Safari says it is a Mac; its five touch points tell it apart.
    if (ipad) {
      await ctx.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true });
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true });
      });
    }
    const page = touchPage(await ctx.newPage());
    await safeAreas(page, who);
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/assets/')) hisAssets.add(path.slice('/assets/'.length));
    });
    const watch = watchConsole(page);
    if (state) return { ctx, page, watch };
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: who, scopes: ['read', 'control'] });
    await page.goto(`${base()}/pair#c=${start.code}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Paired' }).waitFor();
    // Before the claim the app's first calls answer 401: expected, and over now.
    watch.errors.length = 0;
    return { ctx, page, watch };
  }

  /** Each iPad page's own DevTools session for its safe areas, kept for the page's life (one that goes takes its override with it). */
  const insetSessions = new WeakMap<Page, CDPSession>();

  /**
   * The iPad's safe areas on `page`, set (again) and seen in effect. A new document can come up without them
   * once restoreTouch's session has turned touch back on (JANTAR_TOUCH_DROP=every, then a page.goto), so each
   * check sets them again through the page's own session first.
   */
  async function safeAreas(page: Page, who: Who) {
    const insets = SIZES[who].insets;
    if (!insets) return;
    let cdp = insetSessions.get(page);
    if (!cdp) {
      cdp = await page.context().newCDPSession(page);
      insetSessions.set(page, cdp);
    }
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: insets.top, bottom: insets.bottom, left: 0, right: 0 } });
    // env() read through the CSSOM (an inline style, not a <style> element), on an element made and removed here.
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

  /** `steps` on `who`'s page; one that drops its touch emulation for good is opened again as the same device (after `rerun.reset`). */
  const on = (who: Who, what: string, steps: (o: Opened) => Promise<void>, rerun: Rerun = {}) =>
    onPaired(what, () => pages[who]!, async (state) => (pages[who] = await paired(who, state)), steps, rerun);

  /** Sheets and pushed screens finish moving (reduced motion: they fade), then a beat for the layout. */
  async function settle(page: Page) {
    await page
      .waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5_000, polling: 50 })
      .catch(() => undefined);
    await page.waitForTimeout(150);
  }

  /**
   * The checks on one screen: a clean console, nothing sideways, 44 x 44 under a finger, nothing that stays
   * put in the bottom 24 px (on the iPad, nor under its status bar), and the chrome of this size.
   * `expected`: console errors that are the screen's answer (a 503 the page shows), not a fault.
   */
  async function check(o: Opened, who: Who, what: string, opts: { expected?: RegExp } = {}) {
    const { page, watch } = o;
    const at = `${what} (${who})`;
    await settle(page);
    if (opts.expected) watch.errors.splice(0, watch.errors.length, ...watch.errors.filter((e) => !opts.expected!.test(e)));
    await clean(page, watch, at);
    await safeAreas(page, who);
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
      const file = join(tmpdir(), `jantar-web-v013-${who}-${what.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
      await page.screenshot({ path: file }).catch(() => undefined);
      problems.push(`(the page: ${file})`);
    }
    expect(problems, at).toEqual([]);
  }

  /** With a list and an item open beside it (an iPad's split view): the list on the left, the item on its right. */
  async function besideIt(page: Page, list: string, item: string, at: string) {
    const l = await page.getByRole('region', { name: list, exact: true }).boundingBox();
    const r = await page.getByRole('region', { name: item, exact: true }).boundingBox();
    expect(l && r, `${at}: both panes`).toBeTruthy();
    expect(l!.x + l!.width, `${at}: the list ends where the item starts`).toBeLessThanOrEqual(r!.x + 1);
    expect(l!.width, `${at}: the list's width`).toBeGreaterThanOrEqual(300);
  }

  const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
  const workParts = (page: Page) => page.getByRole('group', { name: 'Work' });

  /** What a walk wrote on the Mac, put back: its follow-up and logged call go, and the deal is on Proposal sent again. */
  async function reset(title: string, note: string) {
    const todos = (await call('GET', '/v1/todos')).body as { todos: Array<{ id: string; title: string }> };
    for (const t of todos.todos.filter((x) => x.title === title)) expect((await call('DELETE', `/v1/todos/${t.id}`)).status).toBe(200);
    const hub = (await call('GET', `/v1/work/clients/${ids.pat}`)).body as { log: Array<{ id: string; body?: string }> };
    for (const row of hub.log.filter((x) => x.body === note)) expect((await call('DELETE', `/v1/work/log/${row.id}`)).status).toBe(200);
    const deal = (await call('GET', `/v1/work/deals/${ids.site_deal}`)).body as { deal: { stage: string } };
    if (deal.deal.stage !== 'proposal') expect((await call('POST', `/v1/work/deals/${ids.site_deal}/move`, { stage: 'proposal' })).status).toBe(200);
  }

  /** Today's Work card as the Mac counts it: the open deals with no next step. */
  const noNextStep = async () => ((await call('GET', '/v1/life/today')).body as { work?: { noNextStep: number } }).work?.noNextStep;

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true, work: true, posts: true, timezone: 'UTC', currency: 'INR' } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'ctl.sock');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'seed', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'seed' } });
    expect(claim.status, claim.text).toBe(200);
    cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);

    // Clients: a person at a company, a lead, and a company with a long name.
    const pat = await made('pat', '/v1/work/clients', {
      name: 'Pat Example',
      companyName: 'Example Studio',
      state: 'client',
      email: 'pat@example.com',
      phone: '+91 90000 00001',
      title: 'Head of Ops',
      tags: ['retail'],
    });
    ids.studio = pat.companyId as string;
    await made('sam', '/v1/work/clients', { name: 'Sam Sample', state: 'lead', email: 'sam@example.com', source: 'referral' });
    await made('labs', '/v1/work/clients', { name: 'Fixture Labs and Sample Trading Company', kind: 'company', state: 'client', email: 'labs@example.com' });
    // Projects (active, paused, done) and their todos.
    await made('site', '/v1/projects', { name: 'Site rebuild', clientId: ids.studio, due: day(20), notes: 'Wants the store live before the festival.' });
    await made('audit', '/v1/projects', { name: 'Data audit', clientId: ids.labs });
    await made('brand', '/v1/projects', { name: 'Brand refresh', status: 'paused' });
    await made('old', '/v1/projects', { name: 'Old landing page', status: 'done' });
    await made('wireframes', '/v1/todos', { title: 'Send wireframes', projectId: ids.site, due: { day: day(2), time: '15:00' } });
    await made('staging', '/v1/todos', { title: 'Fix staging login', projectId: ids.site, due: { day: day(-1) } });
    // Deals on three open stages, none with a next step.
    await made('site_deal', '/v1/work/deals', { clientId: ids.studio, title: 'Site rebuild', stage: 'proposal', value: 45_000_000, expectedClose: day(10), projectId: ids.site });
    await made('audit_deal', '/v1/work/deals', { clientId: ids.labs, title: 'Data audit', stage: 'contacted', value: 20_000_000 });
    await made('shop_deal', '/v1/work/deals', { clientId: ids.sam, title: 'Shop setup', stage: 'new', value: 8_000_000 });
    expect(await noNextStep()).toBe(3);
    // 0.13.0 (F7): Posts, a ready one with a time and an idea with none.
    await made('post', '/v1/posts', { platform: 'reddit', where: 'r/example', title: 'How a small shop plans its first week', text: 'Three lists and one rule.', due: { day: day(1), time: '19:30' }, status: 'ready' });
    await made('idea', '/v1/posts', { platform: 'linkedin', text: 'What a placeholder client taught us about invoices.' });

    browser = await launchBrowser();
    for (const who of WHO) pages[who] = await paired(who);
  }, perfBudgetMs(120_000));

  afterAll(async () => {
    for (const p of Object.values(pages)) await p?.ctx.close().catch(() => undefined);
    await browser?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  /**
   * Every Work route on `who`, as a finger takes it. The call it logs and the stage it moves are put back by
   * `reset` (before a rerun, and after the walk).
   */
  async function walk(who: Who) {
    const wide = who === 'ipad';
    const title = `Send the quote ${who}`;
    const note = `Wants a quote by Friday (${who}).`;
    try {
      await on(
        who,
        `the Work walk (${who})`,
        async (o) => {
          const { page } = o;
          await page.goto(`${base()}/`, { waitUntil: 'load' });
          await mainNav(page).getByRole('link', { name: 'Work', exact: true }).waitFor();
          await stillTouch(page, `the Board (${who})`);

          // The Work tab (the sidebar's Work row on the iPad): Projects.
          await mainNav(page).getByRole('link', { name: 'Work', exact: true }).tap();
          await page.waitForURL(`${base()}/work`);
          const projects = page.getByRole(wide ? 'table' : 'list', { name: 'Active projects' });
          await projects.waitFor();
          await page.getByRole('region', { name: 'Paused' }).waitFor();
          await check(o, who, 'Work › Projects');

          // A project's hub (beside the list on the iPad), and back.
          await page.getByRole('link', { name: /^Site rebuild/ }).first().tap();
          await page.getByRole('heading', { level: 1, name: 'Site rebuild' }).waitFor();
          await page.getByRole('region', { name: 'Its todos' }).getByText('Send wireframes').waitFor();
          if (wide) await besideIt(page, 'All projects', 'Project', `a project (${who})`);
          await check(o, who, "a project's hub");
          if (wide) await page.getByRole('region', { name: 'Project', exact: true }).getByRole('button', { name: 'Close' }).tap();
          else await page.getByRole('main').getByRole('link', { name: 'Projects', exact: true }).tap();
          await page.getByRole(wide ? 'table' : 'list', { name: 'Active projects' }).waitFor();

          // Clients, and a client's page.
          await workParts(page).getByRole('button', { name: 'Clients' }).tap();
          const clients = page.getByRole(wide ? 'table' : 'list', { name: 'Clients', exact: true });
          await clients.waitFor();
          await check(o, who, 'Work › Clients');

          // 0.13.0: the search sheet (the phone header's magnifier, F1; the iPad's Search or jump), Work's rows in it.
          if (wide) await page.getByRole('button', { name: /^Search or jump/ }).first().tap();
          else await page.getByRole('banner').getByRole('button', { name: 'Search', exact: true }).tap();
          const search = page.getByRole('dialog', { name: 'Search or jump' });
          await search.getByRole('combobox').fill('Sample');
          await search.getByRole('option', { name: /^Sam Sample/ }).waitFor();
          await search.getByRole('option', { name: /^Fixture Labs and Sample Trading Company/ }).waitFor();
          await check(o, who, 'the search sheet');
          // The phone's sheet has Cancel beside the box; the iPad's closes with a tap beside it.
          if (wide) await page.touchscreen.tap(100, SIZES.ipad.height - 200);
          else await search.getByRole('button', { name: 'Cancel', exact: true }).tap();
          await search.waitFor({ state: 'detached' });

          // 0.13.0: the add-client sheet, put away with nothing typed.
          await page.getByRole('button', { name: 'Add client', exact: true }).first().tap();
          const adding = page.getByRole('dialog', { name: 'New client' });
          await adding.getByRole('form', { name: 'New client' }).waitFor();
          await check(o, who, 'the New client sheet');
          await adding.getByRole('button', { name: 'Cancel', exact: true }).tap();
          await adding.waitFor({ state: 'detached' });

          await clients.getByRole('link', { name: /^Pat Example/ }).tap();
          await page.getByRole('heading', { level: 1, name: 'Pat Example' }).waitFor();
          await page.getByRole('region', { name: 'Deals' }).getByRole('link', { name: /^Site rebuild/ }).waitFor();
          if (wide) await besideIt(page, 'All clients', 'Client', `a client (${who})`);
          await check(o, who, "a client's page");

          // Log a call with a next step for today: one save on the Mac.
          await page.getByRole('button', { name: 'Log a call or meeting' }).tap();
          const sheet = page.getByRole('dialog', { name: 'Log with Pat Example' });
          await sheet.waitFor();
          await check(o, who, 'the Log sheet');
          await sheet.getByRole('button', { name: 'Went well' }).tap();
          await sheet.getByLabel('Minutes', { exact: true }).fill('25');
          await sheet.getByLabel('Note', { exact: true }).fill(note);
          await sheet.getByLabel('Deal', { exact: true }).selectOption({ label: 'Site rebuild · Example Studio' });
          await sheet.getByRole('group', { name: 'Next step day' }).getByRole('button', { name: 'Pick' }).tap();
          await sheet.getByLabel('Day', { exact: true }).fill(day(0));
          await sheet.getByLabel('Title', { exact: true }).fill(title);
          await check(o, who, 'the Log sheet, filled in');
          await sheet.getByRole('button', { name: 'Log and set next step' }).tap();
          await sheet.waitFor({ state: 'detached' });
          await page.getByRole('region', { name: 'Follow-ups' }).getByText(title).waitFor();
          await page.getByRole('region', { name: 'Log' }).getByText(note).waitFor();
          await check(o, who, "a client's page with its follow-up");

          // Today: the follow-up is due today, with the client's name; the Work card has one deal fewer with no next step.
          await mainNav(page).getByRole('link', { name: 'Today', exact: true }).tap();
          await page.getByRole('heading', { level: 1, name: 'Today' }).waitFor();
          const due = page.getByRole('region', { name: 'Due' }).getByRole('listitem').filter({ hasText: title });
          await due.waitFor();
          expect(await due.innerText(), `the follow-up on Today (${who})`).toContain('Pat Example');
          await page.getByRole('region', { name: 'Work', exact: true }).getByRole('link', { name: 'No next step: 2 deals' }).waitFor();
          await check(o, who, 'Today with the follow-up');

          // Deals: the phone picks a stage from its strip; the iPad shows the board.
          await mainNav(page).getByRole('link', { name: 'Work', exact: true }).tap();
          await workParts(page).getByRole('button', { name: 'Deals' }).tap();
          if (!wide) {
            const strip = page.getByRole('group', { name: 'Stages' });
            await strip.getByRole('button', { name: /^Proposal sent/ }).tap();
            await expect.poll(() => strip.getByRole('button', { name: /^Proposal sent/ }).getAttribute('aria-pressed'), { message: `the stage picker (${who})` }).toBe('true');
          }
          const column = page.getByRole('list', { name: 'Proposal sent' });
          await column.getByRole('link', { name: /Site rebuild/ }).waitFor();
          if (wide) {
            // The board: the open stages as columns side by side, in order.
            const boxes: Array<{ x: number; y: number } | null> = [];
            for (const stage of ['New lead', 'Contacted', 'Proposal sent', 'Negotiation']) boxes.push(await page.getByRole('region', { name: stage, exact: true }).boundingBox());
            const at = boxes.map((b) => (b ? `${Math.round(b.x)},${Math.round(b.y)}` : 'none')).join(' ');
            expect(boxes.every((b, i) => b !== null && (i === 0 || (b.x > boxes[i - 1]!.x && Math.abs(b.y - boxes[0]!.y) < 2))), `the deals board's columns (${at})`).toBe(true);
          }
          await check(o, who, wide ? 'Work › Deals, the board' : 'Work › Deals, Proposal sent');

          // A deal, then Move to… Negotiation (a bottom sheet on a phone, a popover on the iPad).
          await column.getByRole('link', { name: /Site rebuild/ }).tap();
          await page.getByRole('heading', { level: 1, name: 'Site rebuild' }).waitFor();
          await page.getByRole('button', { name: 'Move to…' }).waitFor();
          if (wide) await besideIt(page, 'All deals', 'Deal', `a deal (${who})`);
          await check(o, who, 'a deal');
          await page.getByRole('button', { name: 'Move to…' }).tap();
          const move = page.getByRole('dialog', { name: 'Move to' });
          await move.waitFor();
          await check(o, who, 'Move to…');
          await stillTouch(page, `Move to… (${who})`);
          await move.getByRole('radio', { name: 'Negotiation' }).tap();
          await move.waitFor({ state: 'detached' });
          await page.getByText('Moved to Negotiation').first().waitFor();
          await expect
            .poll(async () => ((await call('GET', `/v1/work/deals/${ids.site_deal}`)).body as { deal: { stage: string } }).deal.stage, { message: `the move on the Mac (${who})` })
            .toBe('negotiation');
          await page.getByRole('main').getByText(/^Negotiation/).first().waitFor();
          await check(o, who, 'a deal moved, its Undo up');

          // 0.13.0: Won and Lost each ask first, in a sheet with the deal's follow-up (W33); Cancel leaves it on Negotiation.
          for (const [stage, sheetName] of [
            ['Won', /^Won · /],
            ['Lost', 'Lost · Site rebuild'],
          ] as const) {
            await page.getByRole('button', { name: 'Move to…' }).tap();
            await move.waitFor();
            await move.getByRole('radio', { name: new RegExp(`^${stage}`) }).tap();
            await move.waitFor({ state: 'detached' });
            const asks = page.getByRole('dialog', { name: sheetName });
            await asks.getByRole('form', { name: stage }).waitFor();
            await asks.getByText(`Mark done: ${title}`).waitFor();
            await check(o, who, `the ${stage} sheet`);
            await asks.getByRole('button', { name: 'Cancel', exact: true }).tap();
            await asks.waitFor({ state: 'detached' });
          }
          expect(((await call('GET', `/v1/work/deals/${ids.site_deal}`)).body as { deal: { stage: string } }).deal.stage, `Won and Lost put away (${who})`).toBe('negotiation');

          // Insights (from Deals), and back to Deals.
          if (!wide) await page.getByRole('main').getByRole('link', { name: 'Deals', exact: true }).tap();
          await page.getByRole('link', { name: 'Insights', exact: true }).tap();
          await page.getByRole('heading', { level: 1, name: 'Insights' }).waitFor();
          await page.getByRole('region', { name: 'Funnel' }).waitFor();
          await check(o, who, 'Insights');
          await page.getByRole('main').getByRole('link', { name: 'Deals', exact: true }).tap();
          await workParts(page).waitFor();

          // Import: the preview of a small CSV, then Back, then away; nothing imported.
          await workParts(page).getByRole('button', { name: 'Clients' }).tap();
          await page.getByRole(wide ? 'table' : 'list', { name: 'Clients', exact: true }).waitFor();
          await page.getByRole('button', { name: 'More for clients' }).tap();
          await page.getByRole('menuitem', { name: 'Import a file' }).tap();
          const importer = page.getByRole('dialog', { name: 'Import clients' });
          await importer.waitFor();
          const choose = importer.locator('button', { hasText: 'Choose a file' });
          await choose.waitFor();
          await check(o, who, 'Import clients');
          const [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose.tap()]);
          await chooser.setFiles({ name: 'clients.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
          const fresh = importer.getByRole('region', { name: 'New' });
          await fresh.getByText('Jordan Placeholder').waitFor();
          await fresh.getByText('Casey Specimen').waitFor();
          await importer.getByRole('region', { name: 'Already here' }).getByRole('group', { name: 'What to do with Pat Example' }).waitFor();
          await check(o, who, 'the import preview');
          await importer.getByRole('button', { name: 'Back', exact: true }).tap();
          await choose.waitFor();
          if (wide) {
            // A tap on the scrim beside the form sheet; it saw a file come in, so it asks first.
            await page.touchscreen.tap(100, SIZES.ipad.height - 200);
            const ask = importer.getByRole('group', { name: 'Unsaved changes' });
            await ask.waitFor();
            await check(o, who, 'Import clients, asking before it closes');
            await ask.getByRole('button', { name: 'Discard' }).tap();
          } else await page.keyboard.press('Escape');
          await importer.waitFor({ state: 'detached' });
          const named = (await call('GET', '/v1/work/clients?q=Placeholder')).body as { clients: unknown[] };
          expect(named.clients, `the preview imported nothing (${who})`).toEqual([]);

          // Export: the clients as a CSV (the share sheet, else a download).
          await page.getByRole('button', { name: 'More for clients' }).tap();
          const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/v1/work/export.csv');
          await page.getByRole('menuitem', { name: 'Export CSV' }).tap();
          const res = await answered;
          expect(res.status(), `the export (${who})`).toBe(200);
          expect(res.headers()['content-type'] ?? '', `the export (${who})`).toMatch(/^text\/csv/);
          const csv = await res.text();
          expect(csv, `the export (${who})`).toContain('pat@example.com');
          expect(csv, `the export (${who})`).toContain('Fixture Labs and Sample Trading Company');
          await page.getByText('Clients exported.').first().waitFor();
          await check(o, who, 'Clients after the export');

          // Back: the Board, then the browser's Back lands on Clients again.
          await mainNav(page).getByRole('link', { name: 'Board', exact: true }).tap();
          await page.waitForURL(`${base()}/`);
          await page.goBack();
          await page.waitForURL(/\/work\?tab=clients$/);
          await page.getByRole(wide ? 'table' : 'list', { name: 'Clients', exact: true }).waitFor();
          await check(o, who, 'back on Clients');
        },
        { reset: () => reset(title, note) },
      );
    } finally {
      // Passed or not, the next size starts from the Mac as seeded.
      await reset(title, note);
    }
    expect(await noNextStep(), `the Mac as seeded after the walk (${who})`).toBe(3);
  }

  it('at 320 x 568 with touch: every Work route, a call logged with a next step, a stage moved, import preview and export', async () => {
    await walk('p320');
  }, perfBudgetMs(300_000));

  it('at 390 x 844 with touch: the same walk', async () => {
    await walk('p390');
  }, perfBudgetMs(300_000));

  it('on an iPad, 1024 x 1366 with touch: Work from the sidebar, split views and the deals board, the same walk', async () => {
    await walk('ipad');
  }, perfBudgetMs(300_000));

  it('F7: Accounts, Posts, a post and the New post sheet at each size, with touch', async () => {
    for (const who of WHO) {
      await on(who, `Accounts and Posts (${who})`, async (o) => {
        const { page } = o;
        await page.goto(`${base()}/accounts`, { waitUntil: 'load' });
        await page.getByRole('heading', { level: 1, name: 'Accounts' }).waitFor({ state: 'attached' });
        await page.getByRole('main').getByText('team-b').first().waitFor();
        await check(o, who, 'Accounts');

        await page.goto(`${base()}/posts`, { waitUntil: 'load' });
        await page.getByRole('heading', { level: 1, name: 'Posts' }).waitFor();
        await page.getByRole('main').getByText('How a small shop plans its first week').first().waitFor();
        await page.getByRole('main').getByText(/placeholder client taught us/).first().waitFor();
        await check(o, who, 'Posts');

        await page.getByRole('button', { name: 'Add post', exact: true }).tap();
        const sheet = page.getByRole('dialog', { name: 'New post' });
        await sheet.getByRole('form', { name: 'New post' }).waitFor();
        await check(o, who, 'the New post sheet');
        await sheet.getByRole('button', { name: 'Cancel', exact: true }).tap();
        await sheet.waitFor({ state: 'detached' });

        // A post: its sheet on a phone; on the iPad (a pane of 800 or more) its page beside the list.
        await page.goto(`${base()}/posts?id=${ids.post}`, { waitUntil: 'load' });
        const wide = who === 'ipad';
        const post = wide ? page.getByRole('article', { name: 'The post' }) : page.getByRole('dialog', { name: 'Edit post' });
        await (wide ? post.getByText('Three lists and one rule.') : post.getByLabel('Text', { exact: true })).waitFor();
        await check(o, who, wide ? 'a post beside Posts' : 'a post, its sheet');
        if (!wide) {
          // An open post's sheet has Delete, not Cancel; nothing changed, so it goes as it is.
          await page.keyboard.press('Escape');
          await post.waitFor({ state: 'detached' });
        }
      });
    }
  }, perfBudgetMs(300_000));

  /** Every Work route by its address: the lists, a project, a client, a deal, Insights. */
  const routes = () => [
    ['Projects', '/work'],
    ['a project', `/work?id=${ids.site}`],
    ['Clients', '/work?tab=clients'],
    ['a client', `/work?tab=clients&id=${ids.pat}`],
    ['Deals', '/work?tab=deals'],
    ['a deal', `/work?tab=deals&id=${ids.site_deal}`],
    ['Insights', '/work?tab=insights'],
  ];

  it('design 6.5, Work off (jantar work off): every Work route shows the off page, at each size', async () => {
    const off = await cli('work', 'off');
    expect(off.code, `${off.out}${off.err}`).toBe(0);
    try {
      expect(((await call('GET', '/v1/work/clients')).body as { error?: { message: string } }).error?.message).toBe('Work is off. Turn it on at your Mac: jantar work on');
      for (const who of WHO) {
        await on(who, `Work off (${who})`, async (o) => {
          for (const [name, path] of routes()) {
            await o.page.goto(`${base()}${path}`, { waitUntil: 'load' });
            const main = o.page.getByRole('main');
            await main.getByText('Work is off. Turn it on at your Mac:').waitFor();
            await main.getByText('jantar work on', { exact: true }).waitFor();
            await check(o, who, `${name}, Work off`);
          }
        });
      }
    } finally {
      const on_ = await cli('work', 'on');
      expect(on_.code, `${on_.out}${on_.err}`).toBe(0);
    }
    expect(await noNextStep()).toBe(3);
  }, perfBudgetMs(300_000));

  it("her app (her host's /p and p.html) never loads one of Work's chunks; his walks did", async () => {
    expect(WORK_CHUNKS.size, 'Work chunks in the build').toBeGreaterThan(3);
    expect([...hisAssets].filter((a) => WORK_CHUNKS.has(a)).length, "his pages loaded Work's chunks").toBeGreaterThan(3);
    const mine = herFiles();
    expect([...mine].filter((f) => WORK_CHUNKS.has(f)), 'her build').toEqual([]);
    const set = await d.ctx.settings.patch({ remote: { mode: 'cloudflare', publicUrl: PUBLIC, peopleUrl: PEOPLE } });
    expect(set.ok, JSON.stringify(set)).toBe(true);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-GB', timezoneId: 'UTC', serviceWorkers: 'block' });
    try {
      // Her host is the daemon's own TCP port with her Host header; nothing else is reached.
      await ctx.routeWebSocket(() => true, () => undefined);
      await ctx.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.host !== PEOPLE_HOST) return route.abort();
        const res = await onHerHost(d.port, req.method(), `${url.pathname}${url.search}`, req.headers(), req.postDataBuffer());
        return route.fulfill({ status: res.status, headers: res.headers, body: res.body });
      });
      const page = await ctx.newPage();
      const asked: string[] = [];
      page.on('request', (r) => asked.push(new URL(r.url()).pathname));
      for (const path of ['/p', '/p/todos', '/p.html']) {
        const r = await page.goto(`${PEOPLE}${path}`, { waitUntil: 'networkidle' });
        expect(r?.status(), path).toBe(200);
        expect(await r?.text(), path).toMatch(/<script[^>]+src="\/assets\/p-/);
      }
      const assets = asked.filter((p) => p.startsWith('/assets/')).map((p) => p.slice('/assets/'.length));
      expect(assets.length, 'her app loaded its files').toBeGreaterThan(0);
      expect(assets.filter((a) => WORK_CHUNKS.has(a)), "a Work chunk in her app").toEqual([]);
      expect(assets.filter((a) => !mine.has(a)), 'a file that is not her build').toEqual([]);
      // Her host serves none of his Work chunks either.
      for (const chunk of WORK_CHUNKS) expect((await onHerHost(d.port, 'GET', `/assets/${chunk}`)).status, chunk).toBe(404);
    } finally {
      await ctx.close();
      const back = await d.ctx.settings.patch({ remote: { mode: 'loopback', publicUrl: null, peopleUrl: null } });
      expect(back.ok, JSON.stringify(back)).toBe(true);
    }
  }, perfBudgetMs(120_000));

  it("design 6.5, life.db broken: every Work route shows Life's 503 sentence, at each size", async () => {
    const lifeDb = d.ctx.paths.lifeDb;
    await d.restart(async () => {
      await writeFile(lifeDb, Buffer.alloc(4096, 0x5a));
      await rm(`${lifeDb}-wal`, { force: true });
      await rm(`${lifeDb}-shm`, { force: true });
    });
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'ctl.sock after the restart');
    const status = (await call('GET', '/v1/life/status')).body as { open: boolean; broken?: string };
    expect(status.open).toBe(false);
    expect(status.broken).toMatch(/jantar life restore/);
    const projects = await call('GET', '/v1/projects');
    expect(projects.status).toBe(503);
    for (const who of WHO) {
      await on(who, `life.db broken (${who})`, async (o) => {
        for (const [name, path] of routes()) {
          await o.page.goto(`${base()}${path}`, { waitUntil: 'load' });
          await o.page.getByRole('main').getByText(status.broken as string).first().waitFor();
          // The browser logs each 503 the screen answers with its sentence.
          await check(o, who, `${name}, life.db broken`, { expected: /status of 503/ });
        }
      });
    }
  }, perfBudgetMs(300_000));
});
