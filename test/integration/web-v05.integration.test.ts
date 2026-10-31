/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * MW1 (v0.5 spec 6, 9.1 "CSP and layout"): the Meetings screens of the
 * BUILT web app in a real headless Chromium, served by jantard itself
 * (in-process on a synthetic HOME, harness.ts) with its real headers and
 * the build's strict <meta> policy, on meetings the extension's routes
 * captured and the fake claude summed up. Each browser pairs the way a
 * phone does (/pair#c=..., "Pair this device").
 *
 * - The list at 390 px and 1440 px in both themes: the running line, the
 *   project chips, search (a word said only in a line), Show more, and a
 *   Delete held under its 5 s Undo and taken back.
 * - A meeting in every summary state (done, failed with Try again, none
 *   with Summarize, still running), its decisions, its action items added
 *   by the toggle with Remove under Undo and Add, the transcript with its
 *   screenshots inline (loaded as blobs), the full-screen viewer, Export
 *   text (a Markdown download and the CLI line), and the edit sheet saving
 *   a new name.
 * - Captions, a speaker, the meeting's name and the summary holding
 *   `<img src=x onerror=window.__pwned=1>` render as text; nothing runs.
 * - Everywhere: no console message about the Content Security Policy, no
 *   console error, no <style> element, nothing sticking out sideways.
 * - With Meetings switched off at the Mac nothing of them shows: no nav
 *   entry, and /meetings is not a page.
 *
 * Every name and line is synthetic. Needs a built dist/ and a Chromium
 * (browser.ts).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { extLinesBody, extOpenBody, extShotBody, makeJpeg, projectBody, setFakeClaude } from '@jantar/fixtures';
import { DEVICE_COOKIE, EXTENSION_ID, EXTENSION_KEY_HEADER, type ExtPairStartReply, type LineUpsert, type MeetingDetail, type PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { DESK, PHONE, browserReady, clean, overflow, watchConsole, type Viewport, type Watch } from './browser.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const ready = await browserReady('web-v05.integration');

const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const HOSTILE = '<img src=x onerror=window.__pwned=1>';
/** A page of the list is 30 meetings: this many more than that brings Show more. */
const EXTRA = 31;

type Scheme = 'light' | 'dark';
const VIEWS: ReadonlyArray<{ who: 'phone' | 'desk'; scheme: Scheme }> = [
  { who: 'phone', scheme: 'light' },
  { who: 'phone', scheme: 'dark' },
  { who: 'desk', scheme: 'light' },
  { who: 'desk', scheme: 'dark' },
];

describe.skipIf(!ready)('MW1: the Meetings screens in Chromium, served by jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let seed: string;
  let key = '';
  let projectId = '';
  let browser: Browser;
  const ids: Record<'done' | 'failed' | 'none' | 'running', string> = { done: '', failed: '', none: '', running: '' };
  const pages: Partial<Record<'phone' | 'desk', { ctx: BrowserContext; page: Page; watch: Watch }>> = {};

  const ext = (path: string, body: unknown) => http(d.port, 'POST', path, { origin: EXT_ORIGIN, headers: { [EXTENSION_KEY_HEADER]: key }, body });
  const phoneGet = <T>(path: string) => http(d.port, 'GET', path, { cookie: seed }).then((r) => r.body as T);

  /** A call as the extension records it: opened, its lines (said now), screenshots, maybe ended. */
  async function meeting(open: Parameters<typeof extOpenBody>[0], lines: LineUpsert[], shots: number, end: boolean): Promise<string> {
    const client = randomUUID();
    const opened = await ext(`/v1/ext/meetings/${client}`, extOpenBody({ at: Date.now() - 600_000, ...open }));
    expect(opened.status, opened.text).toBe(200);
    if (lines.length > 0) expect((await ext(`/v1/ext/meetings/${client}/lines`, { lines })).status).toBe(200);
    for (let i = 0; i < shots; i += 1) expect((await ext(`/v1/ext/meetings/${client}/shots`, extShotBody(makeJpeg(640, 400), { at: Date.now() - 300_000 + i * 60_000 }))).status).toBe(200);
    if (end) expect((await ext(`/v1/ext/meetings/${client}/end`, { reason: 'user', at: Date.now() - 60_000 })).status).toBe(200);
    return (opened.body as { id: string }).id;
  }

  /** `n` lines said in the last minutes, `text(i)` for each one's words. */
  const said = (n: number, nonce: string, text: (i: number) => string, speaker?: (i: number) => string): LineUpsert[] => {
    const t0 = Date.now() - 540_000;
    return extLinesBody(n, { nonce }).lines.map((l, i) => ({ ...l, at: t0 + i * 20_000, text: text(i), ...(speaker ? { speaker: speaker(i) } : {}) }));
  };

  async function paired(vp: Viewport, name: string): Promise<{ ctx: BrowserContext; page: Page; watch: Watch }> {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.phone === true,
      hasTouch: vp.phone === true,
      colorScheme: 'light',
      locale: 'en-GB',
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    const page = await ctx.newPage();
    const watch = watchConsole(page);
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes: ['read', 'control'] });
    await page.goto(`http://127.0.0.1:${d.port}/pair#c=${start.code}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Paired' }).waitFor();
    // Before the claim the app's first calls answer 401: expected, and over now.
    watch.errors.length = 0;
    return { ctx, page, watch };
  }

  /** Clean console, no <style>, nothing ran, nothing past the sides of the viewport. */
  async function check(page: Page, watch: Watch, what: string) {
    await page.waitForTimeout(400);
    await clean(page, watch);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned), what).toBeUndefined();
    expect(await overflow(page), what).toEqual([]);
  }

  async function inEachView(path: string, fn: (page: Page, what: string) => Promise<void>) {
    for (const v of VIEWS) {
      const { page, watch } = pages[v.who]!;
      await page.emulateMedia({ colorScheme: v.scheme });
      await page.goto(`http://127.0.0.1:${d.port}${path}`, { waitUntil: 'load' });
      const what = `${path} (${v.who}, ${v.scheme})`;
      await fn(page, what);
      await check(page, watch, what);
    }
  }

  const open = async (page: Page, path: string) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`http://127.0.0.1:${d.port}${path}`, { waitUntil: 'load' });
  };
  const menu = async (page: Page, name: string, item: string) => {
    await page.getByRole('button', { name: `Actions for ${name}` }).first().click();
    await page.getByRole('menuitem', { name: item }).click();
  };

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true }, meetings: { enabled: true } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'seed', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'seed' } });
    expect(claim.status, claim.text).toBe(200);
    seed = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(seed, claim.body);
    const made = await http(d.port, 'POST', '/v1/projects', { cookie: seed, headers: { 'idempotency-key': 'k-project' }, body: projectBody({ name: 'Example launch' }) });
    projectId = (made.body as { id: string }).id;
    const code = (await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start')).code;
    const ext2 = await http(d.port, 'POST', '/v1/ext/pair', { body: { code }, origin: EXT_ORIGIN });
    key = (ext2.body as { key: string }).key;

    // Older meetings first, so the four the checks open are the newest.
    for (let i = 0; i < EXTRA; i += 1) await meeting({ name: `Example older call ${i + 1}`, at: Date.now() - 86_400_000 * (2 + i) }, [], 0, true);
    ids.done = await meeting(
      { name: `Launch review ${HOSTILE}`, projectId, people: `Sam, Priya ${HOSTILE}`, autoTodos: true },
      said(14, 'webdone1', (i) => (i === 3 ? `We should ask about the zeppelin permit ${HOSTILE} before Friday.` : `Line ${i + 1} about the launch, the quote and the room booking.`), (i) => (i % 2 === 0 ? `Sam ${HOSTILE}` : 'Priya')),
      2,
      true,
    );
    await eventually(async () => {
      const done = await phoneGet<MeetingDetail>(`/v1/meetings/${ids.done}`);
      return done.summary.state === 'done' && done.summary.items.every((x) => x.todoId);
    }, 30_000, 'the summary and its todos');
    ids.none = await meeting({ name: 'Quick check-in' }, said(2, 'webnone1', () => 'Short line.'), 0, true);
    await setFakeClaude(d.home, { mode: 'meeting-bad-json' });
    ids.failed = await meeting({ name: 'Vendor call' }, said(8, 'webfail1', (i) => `Line ${i + 1} about the vendor, the contract and the delivery dates.`), 0, true);
    await eventually(async () => (await phoneGet<MeetingDetail>(`/v1/meetings/${ids.failed}`)).summary.state === 'failed', 30_000, 'the failed summary');
    await setFakeClaude(d.home, { mode: 'meeting-ok' });
    ids.running = await meeting({ name: 'Standup', at: Date.now() - 120_000 }, said(3, 'webrun01', (i) => `Standup line ${i + 1} with today's plan.`), 1, false);

    browser = await chromium.launch();
    pages.phone = await paired(PHONE, 'Example phone');
    pages.desk = await paired(DESK, 'Example Mac browser');
  }, 120_000);

  afterAll(async () => {
    for (const p of Object.values(pages)) await p?.ctx.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await d?.stop();
  }, 30_000);

  it('the list: the running line, the chips, search, Show more, and a Delete held under Undo', async () => {
    await inEachView('/meetings', async (page) => {
      await page.getByRole('heading', { name: 'Meetings', level: 1 }).waitFor();
      await page.getByText('Meeting running · Standup').waitFor();
      await page.getByText(`Launch review ${HOSTILE}`).first().waitFor();
      await page.getByRole('group', { name: 'Filter by project' }).getByRole('button', { name: 'Example launch' }).waitFor();
    });

    const { page, watch } = pages.phone!;
    await open(page, '/meetings');
    // The daemon holds an open's time to the last five minutes, so the older calls list in the order they were
    // made: call 1 is the oldest, past the first page. Exact: the name's own text, not a row's name and time run
    // together ("Example older call 1" + "12:05" reads "Example older call 112:05").
    const oldest = page.getByText('Example older call 1', { exact: true });
    const more = page.getByRole('button', { name: 'Show more' });
    await more.waitFor();
    expect(await oldest.count()).toBe(0);
    await more.click();
    await oldest.waitFor();
    await check(page, watch, 'after Show more');

    await page.getByRole('group', { name: 'Filter by project' }).getByRole('button', { name: 'Example launch' }).click();
    await expect.poll(() => page.locator('li[data-meeting]').count()).toBe(1);
    await check(page, watch, 'the project chip');

    await open(page, '/meetings');
    await page.getByLabel('Search meetings').fill('zeppelin');
    await expect.poll(() => page.locator('li[data-meeting]').evaluateAll((els) => els.map((e) => e.getAttribute('data-meeting')))).toEqual([ids.done]);
    expect(page.url()).toContain('q=zeppelin');
    await check(page, watch, 'search');

    // Delete asks nothing: the row goes, Undo brings it back, and nothing reached the Mac.
    await open(page, '/meetings');
    await menu(page, 'Quick check-in', 'Delete');
    const line = page.getByRole('status').filter({ hasText: 'Deleted: Quick check-in' });
    await line.waitFor();
    expect(await page.locator(`li[data-meeting="${ids.none}"]`).count()).toBe(0);
    await check(page, watch, 'the Undo line after Delete');
    await line.getByRole('button', { name: 'Undo' }).click();
    await page.locator(`li[data-meeting="${ids.none}"]`).waitFor();
    await page.waitForTimeout(5_500);
    expect((await http(d.port, 'GET', `/v1/meetings/${ids.none}`, { cookie: seed })).status).toBe(200);
  }, 120_000);

  it('a meeting done: summary, decisions, items in todos, the transcript with its screenshots, the viewer', async () => {
    await inEachView(`/meetings?id=${ids.done}`, async (page) => {
      await page.getByRole('heading', { name: `Launch review ${HOSTILE}`, level: 1 }).waitFor();
      for (const section of ['Summary', 'Decisions', 'Action items', 'Transcript']) await page.getByRole('region', { name: section }).waitFor();
      await page.getByText(`zeppelin permit ${HOSTILE}`).waitFor();
      // Screenshots load as they come into view, as blobs from the API.
      const shots = page.locator('figure[data-shot]');
      expect(await shots.count()).toBe(2);
      await shots.last().scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator('figure[data-shot] img[src^="blob:"]').count(), { timeout: 10_000 }).toBe(2);
    });

    const { page, watch } = pages.phone!;
    await open(page, `/meetings?id=${ids.done}`);
    const summary = page.getByRole('region', { name: 'Summary' });
    await expect.poll(() => summary.textContent()).toContain(`Sam ${HOSTILE}`);
    const shot = page.getByRole('region', { name: 'Transcript' }).getByRole('button', { name: /^Open the screenshot from/ }).first();
    await shot.scrollIntoViewIfNeeded();
    await shot.locator('img[src^="blob:"]').waitFor();
    await shot.click();
    const viewer = page.getByRole('dialog');
    await viewer.locator('img[src^="blob:"]').waitFor();
    await check(page, watch, 'the viewer');
    await viewer.getByRole('button', { name: 'Close' }).click();
    await viewer.waitFor({ state: 'detached' });
  }, 120_000);

  it('action items: Remove waits under Undo, Undo keeps the todo, a Remove sent can be Added again', async () => {
    const { page, watch } = pages.phone!;
    await open(page, `/meetings?id=${ids.done}`);
    const items = page.getByRole('region', { name: 'Action items' });
    const first = (await phoneGet<MeetingDetail>(`/v1/meetings/${ids.done}`)).summary.items[0]!;
    await items.getByRole('button', { name: `Remove from todos: ${first.title}` }).click();
    const undo = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Undo' }) });
    await undo.waitFor();
    await check(page, watch, 'the Undo line after Remove');
    await undo.getByRole('button', { name: 'Undo' }).click();
    await page.waitForTimeout(5_500);
    expect((await phoneGet<MeetingDetail>(`/v1/meetings/${ids.done}`)).summary.items[0]!.todoId).toBe(first.todoId);

    await items.getByRole('button', { name: `Remove from todos: ${first.title}` }).click();
    await eventually(async () => !(await phoneGet<MeetingDetail>(`/v1/meetings/${ids.done}`)).summary.items[0]!.todoId, 10_000, 'the Remove to reach the Mac');
    await items.getByRole('button', { name: `Add to Example launch: ${first.title}` }).click();
    await eventually(async () => Boolean((await phoneGet<MeetingDetail>(`/v1/meetings/${ids.done}`)).summary.items[0]!.todoId), 10_000, 'the Add');
    await items.getByRole('button', { name: `Remove from todos: ${first.title}` }).waitFor();
    await check(page, watch, 'after Add');
  }, 60_000);

  it('Export text downloads the Markdown and shows the CLI line; Edit saves a new name', async () => {
    const { page, watch } = pages.phone!;
    await open(page, `/meetings?id=${ids.done}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    const download = page.waitForEvent('download');
    await menu(page, `Launch review ${HOSTILE}`, 'Export text');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.md$/);
    const md = await readFile((await file.path())!, 'utf8');
    expect(md).toContain('## Transcript');
    expect(md).toContain('zeppelin permit');
    await page.getByRole('status').filter({ hasText: `meetings export ${ids.done}` }).waitFor();
    await check(page, watch, 'Export text');

    await menu(page, `Launch review ${HOSTILE}`, 'Edit');
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('Name').fill('Launch review, renamed');
    await check(page, watch, 'the edit sheet');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('heading', { name: 'Launch review, renamed', level: 1 }).waitFor();
    expect((await phoneGet<MeetingDetail>(`/v1/meetings/${ids.done}`)).meeting.name).toBe('Launch review, renamed');
  }, 60_000);

  it('the other summary states: failed with Try again, none with Summarize, and a running meeting', async () => {
    const { page, watch } = pages.phone!;
    await inEachView(`/meetings?id=${ids.failed}`, async (p) => {
      await p.getByText('The summary did not work. Try again.').waitFor();
    });
    await inEachView(`/meetings?id=${ids.none}`, async (p) => {
      await p.getByRole('region', { name: 'Summary' }).getByRole('button', { name: 'Summarize' }).waitFor();
    });
    await inEachView(`/meetings?id=${ids.running}`, async (p) => {
      await p.getByText('The summary comes after the meeting ends.').waitFor();
      await p.getByText(/^Running · 3 lines · 1 screenshot/).waitFor();
    });

    // Try again runs it (the fake claude answers properly now).
    await open(page, `/meetings?id=${ids.failed}`);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('region', { name: 'Decisions' }).waitFor({ timeout: 30_000 });
    await check(page, watch, 'after Try again');
  }, 120_000);

  it('switched off at the Mac, nothing of Meetings shows', async () => {
    await callDaemon(ctl, 'PATCH', '/v1/settings', { meetings: { enabled: false } });
    for (const who of ['phone', 'desk'] as const) {
      const { page, watch } = pages[who]!;
      await open(page, '/more');
      await page.getByRole('heading', { name: 'More', level: 1 }).waitFor();
      expect(await page.getByRole('link', { name: 'Meetings' }).count(), who).toBe(0);
      await open(page, '/meetings');
      await page.getByRole('heading', { name: 'That is off on this Mac.' }).waitFor();
      expect(await page.getByText('Meeting running').count()).toBe(0);
      await check(page, watch, `Meetings off (${who})`);
    }
  }, 60_000);
});
