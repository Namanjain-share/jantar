/**
 * v0.10, Start when I join, end to end (spec 14.4): the real extension (the
 * test build) in playwright-core's own Chromium with a fresh profile, never
 * the user's Chrome; synthetic Meet and Teams pages served at the meeting
 * addresses inside that browser only; jantard with a synthetic HOME.
 *
 * 1. Meet: the join screen at /abc-defg-hij, the popup's Start when I join
 *    with a project; the icon says ARM and nothing reaches Jantar; Ask to
 *    join (the popup follows by itself), then let in: notes start by
 *    themselves with that project, the captions already on screen are kept,
 *    the icon says ON and the popup shows the notes view.
 * 2. Teams light meetings: a guest's waiting room at
 *    /light-meetings/launch (a made-up query), armed, then let in: notes start.
 * 3. Captions on when notes start, Teams light meetings as a guest (the case
 *    of 2 November 2026): captions off, Start notes; Jantar opens More, clicks
 *    Captions and closes More (one click, nothing else), the lines then come in
 *    with their speakers, and Settings › Call check names how it went.
 * 4. The same on Meet's "Captions and translation" (2026-10-22): the pop-up is
 *    opened, its toggle turned on, and the pop-up closed again.
 *
 * Needs `pnpm -r build` and the full Chromium for playwright-core; skipped
 * with a warning otherwise (extension.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { perfBudgetMs, projectBody } from '@jantar/fixtures';
import { DEVICE_COOKIE, type MeetingDetail, type MeetingsList, type PairStartResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { FIXTURE_SCRIPT_PATH, fixtureDriverScript, fixturePageHtml, type FixturePageName } from '../../packages/extension/test/fixtures/pages.js';
import { extensionReady, launchExtension, openPopup, tabIdOf, type LoadedExtension } from './extension.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const ready = await extensionReady('ext-v010-arm');

const MEET = 'https://meet.google.com/abc-defg-hij';
const LIGHT = 'https://teams.microsoft.com/light-meetings/launch?anon=1&p=made-up-thread';
const ARM_BUTTON = 'Start when I join';
/** v0.10: two more calls, each with captions off, at addresses of their own. */
const LIGHT_GUEST = 'https://teams.microsoft.com/light-meetings/launch?anon=true&p=made-up-guest';
const MEET_POPUP = 'https://meet.google.com/xyz-abcd-efg';

/** The fixture page each meeting host serves. */
const served = new Map<string, FixturePageName>();

async function serveFixtures(context: BrowserContext): Promise<void> {
  const driver = await fixtureDriverScript();
  for (const host of ['meet.google.com', 'teams.microsoft.com']) {
    await context.route(`https://${host}/**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === FIXTURE_SCRIPT_PATH) return route.fulfill({ status: 200, contentType: 'text/javascript', body: driver });
      return route.fulfill({ status: 200, contentType: 'text/html', body: fixturePageHtml(served.get(host) ?? 'meet-prejoin') });
    });
  }
}

const view = (popup: Page) => popup.locator('.view');
const step = (page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(([n, a]) => (window as unknown as { __step: (n: string, ...a: unknown[]) => unknown }).__step(n as string, ...(a as unknown[])), [name, args] as const);

type ChromeAction = { chrome: { action: { getBadgeText(d: { tabId: number }): Promise<string> } } };

describe.skipIf(!ready)('ext-v010-arm: Start when I join in the real extension', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let ext: LoadedExtension;
  let projectA = '';

  const list = () => callDaemon<MeetingsList>(ctl, 'GET', '/v1/meetings?limit=50');
  const detail = (id: string) => callDaemon<MeetingDetail>(ctl, 'GET', `/v1/meetings/${id}`);
  const badge = async (url: string) => {
    const tabId = await tabIdOf(ext, url);
    return ext.worker.evaluate((id) => (globalThis as unknown as ChromeAction).chrome.action.getBadgeText({ tabId: id }), tabId);
  };

  async function meetingPage(url: string, page: FixturePageName): Promise<Page> {
    served.set(new URL(url).host, page);
    const p = await ext.context.newPage();
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction(() => typeof (window as unknown as { __step?: unknown }).__step === 'function');
    return p;
  }

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  async function pairThrough(popup: Page): Promise<number> {
    const io = memoryIo(d.home.env);
    const running = main(['pair', '--extension'], { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    const line = await eventually(async () => /jantar-ext:\d+:[A-Za-z0-9_-]+/.exec(io.stdout)?.[0], 10_000, 'the pairing line');
    await popup.locator('#code').fill(line);
    await popup.getByRole('button', { name: 'Pair' }).click();
    return running;
  }

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true }, meetings: { enabled: false } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'ext-v010 phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'ext-v010 phone' } });
    expect(claim.status, claim.text).toBe(200);
    const phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    const made = await http(d.port, 'POST', '/v1/projects', { cookie: phone, headers: { 'idempotency-key': 'k-ext-v010-a' }, body: projectBody({ name: 'Example launch' }) });
    expect(made.status, made.text).toBe(200);
    projectA = (made.body as { id: string }).id;
    const on = await cli('meetings', 'on');
    expect(on.code, on.err).toBe(0);
    ext = await launchExtension();
    await serveFixtures(ext.context);
  }, perfBudgetMs(90_000));

  afterAll(async () => {
    await ext?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. Meet: armed on the join screen with a project, then let in: notes start by themselves', async () => {
    const meet = await meetingPage(MEET, 'meet-prejoin');
    const pairing = await openPopup(ext, await tabIdOf(ext, MEET), meet);
    await pairing.getByText('Pairing code').waitFor();
    expect(await pairThrough(pairing)).toBe(0);
    await pairing.close();

    const popup = await openPopup(ext, await tabIdOf(ext, MEET), meet);
    await view(popup).getByText('Not in the call yet.').waitFor();
    await popup.locator('#project').selectOption(projectA);
    await popup.getByRole('button', { name: ARM_BUTTON }).click();
    await view(popup).getByText('Armed: starts when you join').waitFor();
    expect(await badge(MEET)).toBe('ARM');
    expect((await list()).meetings).toEqual([]);

    // Ask to join: the popup follows by itself (it asks again every 2 s).
    await step(meet, 'askToJoin');
    await view(popup).getByText("Armed: starts when you're let in").waitFor();
    await meet.waitForTimeout(2_500);
    expect((await list()).meetings).toEqual([]);

    // Said before notes start, on screen once let in: read at the start.
    await step(meet, 'say', 'Sam', 'So the plan for Friday');
    await step(meet, 'admit');
    await view(popup).getByText('Keeping notes').waitFor();
    await view(popup).getByText(/Started when you joined, \d\d:\d\d/).waitFor();
    const running = await eventually(async () => (await list()).running, 10_000, 'the meeting started by itself');
    expect(running).toMatchObject({ site: 'meet', name: 'Weekly sync', projectId: projectA, notes: true, endedAt: null });
    await eventually(async () => ((await detail(running.id)).lines.some((l) => l.text === 'So the plan for Friday') ? true : null), 10_000, 'the caption on screen when notes started');
    expect(await badge(MEET)).toBe('ON');
    await popup.close();
    await meet.close();
    await eventually(async () => ((await list()).running === null ? true : null), 10_000, 'the Meet meeting ended with its tab');
  }, perfBudgetMs(90_000));

  it("2. Teams light meetings: a guest's waiting room, armed, then let in", async () => {
    const teams = await meetingPage(LIGHT, 'teams-light-waiting');
    const popup = await openPopup(ext, await tabIdOf(ext, LIGHT), teams);
    await popup.getByRole('button', { name: ARM_BUTTON }).waitFor();
    await popup.getByRole('button', { name: ARM_BUTTON }).click();
    await view(popup).getByText(/^Armed: starts when/).waitFor();
    expect(await badge(LIGHT)).toBe('ARM');
    await step(teams, 'admit');
    await view(popup).getByText('Keeping notes').waitFor();
    const running = await eventually(async () => (await list()).running, 10_000, 'the Teams meeting');
    expect(running).toMatchObject({ site: 'teams', name: 'Weekly sync', notes: true });
    expect(running.projectId).toBeUndefined();
    expect(await badge(LIGHT)).toBe('ON');
    await popup.close();
    await teams.close();
    await eventually(async () => ((await list()).running === null ? true : null), 10_000, 'the Teams meeting ended with its tab');
  }, perfBudgetMs(90_000));

  it('3. captions on when notes start, Teams light meetings as a guest: More › Captions, closed again, then lines with speakers', async () => {
    const teams = await meetingPage(LIGHT_GUEST, 'teams-light-call');
    expect(await step(teams, 'captionsShown')).toBe(false);
    const popup = await openPopup(ext, await tabIdOf(ext, LIGHT_GUEST), teams);
    await popup.getByRole('button', { name: 'Start notes' }).click();
    await view(popup).getByText('Keeping notes').waitFor();
    await eventually(async () => ((await step(teams, 'captionsShown')) === true ? true : null), 10_000, 'the captions on');
    expect(await step(teams, 'ccLog')).toEqual(['more-open', 'item']);
    await step(teams, 'say', 'Sam', 'Shall we begin?');
    await step(teams, 'say', 'Priya', 'Yes, go ahead.');
    const running = await eventually(async () => (await list()).running, 10_000, 'the guest meeting');
    const said = await eventually(
      async () => {
        const lines = (await detail(running.id)).lines.map((l) => [l.speaker, l.text]);
        return lines.length === 2 ? lines : null;
      },
      10_000,
      "the guest's lines",
    );
    expect(said).toEqual([
      ['Sam', 'Shall we begin?'],
      ['Priya', 'Yes, go ahead.'],
    ]);
    expect(await badge(LIGHT_GUEST)).toBe('ON');
    // Nothing was on screen until someone spoke: one click, never a second.
    await teams.waitForTimeout(2_000);
    expect(await step(teams, 'ccLog')).toEqual(['more-open', 'item']);
    // Settings › Call check, in a popup opened after the page said how it went: turned on (someone spoke while
    // Jantar checked), or clicked with nothing on screen yet; by the item either way.
    await popup.close();
    const again = await openPopup(ext, await tabIdOf(ext, LIGHT_GUEST), teams);
    await again.getByRole('button', { name: 'Settings' }).click();
    await view(again).getByText(/^Captions: (turned on by Jantar|Jantar clicked Captions; none on screen yet) · teams:cc-more-item$/).waitFor();
    await again.close();
    await teams.close();
    await eventually(async () => ((await list()).running === null ? true : null), 10_000, 'the guest meeting ended with its tab');
  }, perfBudgetMs(90_000));

  it('4. captions on when notes start, Meet\'s "Captions and translation": the pop-up opened, turned on, closed', async () => {
    const meet = await meetingPage(MEET_POPUP, 'meet-popup-off');
    const popup = await openPopup(ext, await tabIdOf(ext, MEET_POPUP), meet);
    await popup.getByRole('button', { name: 'Start notes' }).click();
    await view(popup).getByText('Keeping notes').waitFor();
    await eventually(async () => ((await step(meet, 'captionsShown')) === true ? true : null), 10_000, 'the captions on');
    await eventually(async () => ((await step(meet, 'ccLog')) as string[]).includes('popup-close') || null, 10_000, 'the pop-up closed');
    expect(await step(meet, 'ccLog')).toEqual(['popup-open', 'toggle', 'popup-close']);
    await step(meet, 'say', 'Alex', 'Captions came on by themselves');
    const running = await eventually(async () => (await list()).running, 10_000, 'the Meet meeting');
    await eventually(async () => ((await detail(running.id)).lines.some((l) => l.text === 'Captions came on by themselves') ? true : null), 10_000, 'the line');
    await popup.close();
    const again = await openPopup(ext, await tabIdOf(ext, MEET_POPUP), meet);
    await again.getByRole('button', { name: 'Settings' }).click();
    await view(again).getByText('Captions: turned on by Jantar · meet:cc-popup').waitFor();
    await again.close();
    await meet.close();
  }, perfBudgetMs(90_000));
});
