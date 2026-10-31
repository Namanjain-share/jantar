/// <reference lib="dom" />
/**
 * The real built extension end to end (v0.5 spec 9.3, flows 1 to 8): the
 * extension's test build (`dist-test/`, `<all_urls>` granted at install)
 * in playwright-core's own Chromium with a fresh temp profile, synthetic
 * Meet and Teams pages served at the real meeting URLs by `context.route`
 * (the extension's own fixture pages and their driver, test/fixtures in
 * packages/extension), and jantard in-process on a synthetic HOME (harness.ts)
 * with `jantar` itself (main() from packages/cli) on its ctl.sock.
 *
 * 1. Pairing and the switch: no camera button before pairing; `jantar pair
 *    --extension`'s line pasted into the popup pairs and the CLI says
 *    "Paired."; the button appears; with Meetings off the popup and a click
 *    say so and nothing is made; `jantar meetings on`; the sheet lists the
 *    active projects only.
 * 2. A Meet call: no button in the waiting room; Start from the popup with
 *    the name from the page, a project, people and auto todos; a line grows,
 *    is rewritten in the middle, trimmed at the front, and another speaker
 *    talks: the daemon holds the final lines, once each, with one
 *    `life.changed` for the open and none for the lines; the site's own
 *    captions button is never clicked.
 * 3. Screenshots: the page button (a 0600 JPEG, "Saved", the button not in
 *    the picture: MX3), the popup's Screenshot, and none of another tab in
 *    front of the meeting's window (MX2).
 * 4. Jantar down: the click says "Not saved: Jantar is not running on this
 *    Mac.", the page says Jantar is not answering, and the turns said
 *    meanwhile arrive once each after the restart on the same port.
 * 5. A short gap, then a new call: the in-call hooks gone for 10 s keep one
 *    meeting; a new Meet code ends it at once (`left`); the fake claude
 *    writes its summary, the action items are todos of the project, and
 *    Remove takes one back; the new call has the button and no meeting.
 * 6. Teams under a strict CSP: the button renders, hides for its shot and
 *    the shot saves (MX3); a turn unmounted and remounted is one line; the
 *    popup's End ends the meeting (`user`), and after a second Start,
 *    closing the tab ends that one (`closed`).
 * 7. A screenshot before Start: a meeting with notes off and no lines;
 *    Start keeps it and turns notes on; the call's hooks gone for good end
 *    it (`left`) once the minute's grace runs out, not before; lines for a
 *    meeting with captions off are 409.
 * 8. Not now (D1): the build as you load it (`dist/`), paired, the offer
 *    declined: the page button says to click the Jantar icon once, and
 *    nothing is made.
 *
 * Then the sweep: MEETING_MARKER, typed into the sheet's name and people
 * and said in a caption, is in no event, audit row or log line. And flow
 * 10's part in the browser: with meetings.db broken, the popup shows the
 * daemon's sentence (the daemon's side is v05-meetings).
 *
 * Needs `pnpm -r build` and the full Chromium (extension.ts); skipped with
 * a warning without them.
 */
import { randomBytes } from 'node:crypto';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { MEETING_MARKER, perfBudgetMs, projectBody } from '@jantar/fixtures';
import { DEVICE_COOKIE, EXTENSION_ID, type MeetingDetail, type MeetingsList, type MeetingsStatus, type PairStartResponse, type TodosResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { FIXTURE_SCRIPT_PATH, PAGE_BACKGROUND, STRICT_CSP, fixtureDriverScript, fixturePageHtml, type FixturePageName } from '../../packages/extension/test/fixtures/pages.js';
import { cameraBox, cameraView, clickCamera, extensionReady, launchExtension, openPopup, tabIdOf, type CameraView, type ChromeLike, type LoadedExtension } from './extension.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret } from './http.js';

const ready = (await extensionReady('ext-v05')) && (await extensionReady('ext-v05', 'dist'));

const MEET = 'https://meet.google.com/meet/abc-defg-hij';
const MEET_NEXT = 'https://meet.google.com/meet/xyz-abcd-efg';
const TEAMS_STRICT = 'https://teams.cloud.microsoft/v2/';
const TEAMS_LIVE = 'https://teams.live.com/v2/';
const NAME = `Weekly sync ${MEETING_MARKER}`;
const PEOPLE = `Sam, Priya ${MEETING_MARKER}`;

const SAVED = 'Saved';
const NOT_RUNNING = 'Not saved: Jantar is not running on this Mac.';
const NOT_ANSWERING = 'Jantar is not answering. Notes wait in this tab until it is back.';
const OPEN_TAB_FIRST = 'Not saved: open the meeting tab first.';
const ALLOW_HERE = 'Click the Jantar icon once to allow screenshots here.';
const BROKEN = 'Meetings data could not be opened. The file is untouched. Move meetings.db aside at your Mac to start again (docs/extension.md).';

/** The fixture page each meeting host serves, changed as the flows go. */
const served = new Map<string, { page: FixturePageName; csp?: string }>();

async function serveFixtures(context: BrowserContext): Promise<void> {
  const driver = await fixtureDriverScript();
  for (const host of ['meet.google.com', 'teams.cloud.microsoft', 'teams.live.com', 'teams.microsoft.com']) {
    await context.route(`https://${host}/**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === FIXTURE_SCRIPT_PATH) return route.fulfill({ status: 200, contentType: 'text/javascript', body: driver });
      const spec = served.get(host) ?? { page: 'meet-call' as FixturePageName };
      return route.fulfill({ status: 200, contentType: 'text/html', headers: spec.csp ? { 'content-security-policy': spec.csp } : {}, body: fixturePageHtml(spec.page) });
    });
  }
  // The other tab of flow 3, never on the network.
  await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Example</title><p>Another site</p>' }));
}

/** The popup's view (its live line for screen readers repeats the view's first line). */
const view = (popup: Page) => popup.locator('.view');

/** One step of the fixture page's driver (`window.__step`). */
const step = (page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(([n, a]) => (window as unknown as { __step: (n: string, ...a: unknown[]) => unknown }).__step(n as string, ...(a as unknown[])), [name, args] as const);

/** Waits until the camera button's view passes `ok` (polled through the DevTools protocol). */
async function cameraUntil(page: Page, ok: (v: CameraView) => boolean, what: string, ms = 10_000): Promise<CameraView> {
  let last: CameraView | null = null;
  return eventually(async () => {
    last = await cameraView(page);
    return ok(last) ? last : null;
  }, ms, `${what} (last: ${JSON.stringify(last)})`);
}

/** The colour of the picture at (x, y) CSS pixels of a `cssWidth`-wide page, decoded by the browser (on a blank page: a meeting page's CSP may refuse a data: image). */
async function pixelAt(context: BrowserContext, jpeg: Buffer, x: number, y: number, cssWidth: number): Promise<[number, number, number]> {
  const page = await context.newPage();
  try {
    return await page.evaluate(
    async ([b64, px, py, w]) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const scale = img.naturalWidth / (w as number);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const g = canvas.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.round((px as number) * scale), Math.round((py as number) * scale), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    [jpeg.toString('base64'), x, y, cssWidth] as const,
    );
  } finally {
    await page.close();
  }
}

const BACKGROUND = PAGE_BACKGROUND.match(/\d+/g)!.map(Number) as [number, number, number];
const nearBackground = (c: readonly number[]) => c.every((v, i) => Math.abs(v - BACKGROUND[i]!) <= 24);

describe.skipIf(!ready)('ext-v05: the real extension, a Meet and a Teams call, and jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let ext: LoadedExtension;
  let phone: string;
  let meet: Page;
  const projects: Record<'a' | 'b' | 'paused', string> = { a: '', b: '', paused: '' };
  /** The first Meet call's meeting. */
  let first = '';

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  /** `jantar pair --extension`: its line pasted into a popup, and what the CLI said once it saw the claim. */
  async function pairThrough(popup: Page): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const running = main(['pair', '--extension'], { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    const line = await eventually(async () => /jantar-ext:\d+:[A-Za-z0-9_-]+/.exec(io.stdout)?.[0], 10_000, 'the pairing line');
    await popup.locator('#code').fill(line);
    await popup.getByRole('button', { name: 'Pair' }).click();
    const code = await running;
    return { code, out: io.stdout, err: io.stderr };
  }

  const phoneCall = (method: string, path: string, body?: unknown) => http(d.port, method, path, { cookie: phone, headers: method === 'GET' ? {} : { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` }, ...(body === undefined ? {} : { body }) });
  const list = () => callDaemon<MeetingsList>(ctl, 'GET', '/v1/meetings?limit=50');
  const detail = (id: string) => callDaemon<MeetingDetail>(ctl, 'GET', `/v1/meetings/${id}`);
  const status = () => callDaemon<MeetingsStatus>(ctl, 'GET', '/v1/meetings/status');
  const ticks = () => {
    const r = d.ctx.store.replay(0);
    return r.kind === 'events' ? r.events.filter((e) => e.type === 'life.changed').length : 0;
  };
  /** The text of each line, by time. */
  const said = (m: MeetingDetail) => m.lines.map((l) => `${l.speaker}: ${l.text}`);

  async function meetingPage(url: string, page: FixturePageName, csp?: string): Promise<Page> {
    served.set(new URL(url).host, csp ? { page, csp } : { page });
    const p = await ext.context.newPage();
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction(() => typeof (window as unknown as { __step?: unknown }).__step === 'function');
    return p;
  }

  async function startNotes(page: Page, opts: { project?: string; people?: string; auto?: boolean; name?: string } = {}): Promise<void> {
    const popup = await openPopup(ext, await tabIdOf(ext, page.url()), page);
    await popup.getByRole('button', { name: 'Start notes' }).waitFor();
    if (opts.name !== undefined) await popup.locator('#name').fill(opts.name);
    if (opts.project) await popup.locator('#project').selectOption(opts.project);
    if (opts.people) await popup.locator('#people').fill(opts.people);
    if (opts.auto) await popup.locator('#todos').check();
    await popup.getByRole('button', { name: 'Start notes' }).click();
    await view(popup).getByText('Keeping notes').waitFor();
    await popup.close();
  }

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true }, meetings: { enabled: false } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'ext-v05 phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'ext-v05 phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    for (const [key, body] of [
      ['a', projectBody({ name: 'Example launch' })],
      ['b', projectBody({ name: 'Example hiring' })],
      ['paused', projectBody({ name: 'Example paused', status: 'paused' })],
    ] as const) {
      const r = await phoneCall('POST', '/v1/projects', body);
      expect(r.status, r.text).toBe(200);
      projects[key] = (r.body as { id: string }).id;
    }
    ext = await launchExtension();
    await serveFixtures(ext.context);
  }, 90_000);

  afterAll(async () => {
    await ext?.close();
    await d?.stop();
  }, 30_000);

  it('1. pairing and the switch', async () => {
    expect(ext.extensionId).toBe(EXTENSION_ID);
    meet = await meetingPage(MEET, 'meet-waiting');
    await step(meet, 'join');
    // In the call, but not paired: no button.
    await meet.waitForTimeout(1_500);
    expect((await cameraView(meet)).onPage).toBe(false);

    const popup = await openPopup(ext, await tabIdOf(ext, MEET), meet);
    await view(popup).getByText('Pairing code').waitFor();
    const paired = await pairThrough(popup);
    expect(paired.code, paired.err).toBe(0);
    expect(paired.out).toContain('Paired.');
    expect(paired.err).toBe('');
    await cameraUntil(meet, (v) => v.button, 'the camera button after pairing', 3_000);

    // Meetings off: the popup says so, and a click makes nothing.
    await view(popup).getByText('Meetings are off').waitFor();
    await popup.close();
    await clickCamera(meet);
    const off = await cameraUntil(meet, (v) => v.bubble !== null, 'the off flash');
    expect(off.bubble).toMatch(/^Not saved: Meetings are off/);
    expect((await status()).meetings).toBe(0);

    const on = await cli('meetings', 'on');
    expect(on.code, on.err).toBe(0);
    expect(on.out).toContain('never a screenshot');
    const sheet = await openPopup(ext, await tabIdOf(ext, MEET), meet);
    await sheet.getByRole('button', { name: 'Start notes' }).waitFor();
    // The active projects by name; the paused one is not offered.
    expect(await sheet.locator('#project option').allTextContents()).toEqual(['No project', 'Example hiring', 'Example launch']);
    await sheet.close();
    expect((await list()).meetings).toEqual([]);
  }, 90_000);

  it('2. a Meet call: Start with the sheet, captions grow, change and finish as lines, one tick for the open', async () => {
    // The waiting room of another call never shows the button.
    const waiting = await meetingPage('https://meet.google.com/meet/wai-tingr-oom', 'meet-waiting');
    await waiting.waitForTimeout(1_500);
    expect((await cameraView(waiting)).onPage).toBe(false);
    await waiting.close();

    await meet.bringToFront();
    await meet.evaluate(() => {
      const w = window as unknown as { __ccClicks: number };
      w.__ccClicks = 0;
      document.querySelector('[jsname="RrG0hf"]')?.addEventListener('click', () => (w.__ccClicks += 1));
    });
    const popup = await openPopup(ext, await tabIdOf(ext, MEET), meet);
    await popup.getByRole('button', { name: 'Start notes' }).waitFor();
    expect(await popup.locator('#name').inputValue()).toBe('Weekly sync');
    await popup.close();

    const before = ticks();
    await startNotes(meet, { name: NAME, project: projects.a, people: PEOPLE, auto: true });
    await cameraUntil(meet, (v) => v.dot, 'the notes-on dot');
    const running = await eventually(async () => (await list()).running, 5_000, 'the running meeting');
    first = running.id;
    expect(running).toMatchObject({ site: 'meet', name: NAME, people: PEOPLE, projectId: projects.a, autoTodos: true, notes: true, endedAt: null });

    const pause = () => meet.waitForTimeout(700);
    await step(meet, 'say', 'Sam', 'So the plan for Friday');
    await pause();
    await step(meet, 'grow', 0, 'is to ship the new site');
    await pause();
    await step(meet, 'set', 0, 'So the plan for Monday is to ship the new site');
    await pause();
    await step(meet, 'trimFront', 0, 3);
    await pause();
    await step(meet, 'grow', 0, `and the docs ${MEETING_MARKER}.`);
    await pause();
    await step(meet, 'say', 'Priya', 'Monday works for me, I will book the review room for the afternoon.');

    const want = [`Sam: So the plan for Monday is to ship the new site and the docs ${MEETING_MARKER}.`, 'Priya: Monday works for me, I will book the review room for the afternoon.'];
    const m = await eventually(async () => {
      const got = await detail(first);
      return JSON.stringify(said(got)) === JSON.stringify(want) ? got : null;
    }, 8_000, 'the final lines');
    // Their times: when each was first seen, in order, within this test.
    const times = m.lines.map((l) => Date.parse(l.at));
    expect(times[0]!).toBeLessThanOrEqual(times[1]!);
    expect(Date.now() - times[0]!).toBeLessThan(perfBudgetMs(60_000));
    // Settled: nothing more arrives, and no line came twice.
    await meet.waitForTimeout(2_000);
    expect(said(await detail(first))).toEqual(want);

    expect(ticks() - before).toBe(1);
    expect(await meet.evaluate(() => (window as unknown as { __ccClicks: number }).__ccClicks)).toBe(0);
  }, 90_000);

  it('3. screenshots: the page button (not in the picture), the popup, and never another tab in front', async () => {
    const box = (await cameraBox(meet))!;
    const width = meet.viewportSize()?.width ?? 1280;
    await clickCamera(meet);
    await cameraUntil(meet, (v) => v.bubble === SAVED, 'the Saved flash', 5_000);
    const one = await eventually(async () => {
      const got = await detail(first);
      return got.shots.length === 1 ? got.shots[0] : null;
    }, 5_000, 'the first screenshot');
    const file = join(d.ctx.paths.meetingsDir, first, `${one.id}.jpg`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(d.ctx.paths.meetingsDir, first))).mode & 0o777).toBe(0o700);
    // MX3: where the button sat, the picture shows the page.
    const bytes = await ctl.bytes(`/v1/meetings/${first}/shots/${one.id}`);
    expect(bytes.status).toBe(200);
    expect(bytes.body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const colour = await pixelAt(ext.context, bytes.body, box.x + box.width / 2, box.y + box.height / 2, width);
    expect(nearBackground(colour), `the button's spot in the picture is ${colour.join(',')}`).toBe(true);
    // The button is back after the shot.
    await cameraUntil(meet, (v) => v.button && !v.hidden, 'the button shown again');

    // The popup's Screenshot: the popup goes, then the tab is taken.
    const popup = await openPopup(ext, await tabIdOf(ext, MEET), meet);
    // The popup closes itself as it asks.
    await popup.getByRole('button', { name: 'Screenshot' }).click().catch(() => undefined);
    await eventually(async () => (await detail(first)).shots.length === 2, 5_000, 'the popup screenshot');

    // MX2: another tab in front of the meeting's window: nothing is taken.
    const tabId = await tabIdOf(ext, MEET);
    const other = await ext.worker.evaluate(async (id) => {
      const c = (globalThis as unknown as { chrome: ChromeLike }).chrome;
      const meetTab = (await c.tabs.query({})).find((t) => t.id === id)!;
      const made = await c.tabs.create({ windowId: meetTab.windowId, url: 'https://example.com/', active: true });
      return made.id!;
    }, tabId);
    const asker = await openPopup(ext, tabId);
    await ext.worker.evaluate((id) => (globalThis as unknown as { chrome: ChromeLike }).chrome.tabs.update(id, { active: true }), other);
    const answer = await asker.evaluate((id) => (globalThis as unknown as { chrome: ChromeLike }).chrome.runtime.sendMessage({ t: 'shot', tabId: id }), tabId);
    expect(answer).toEqual({ ok: false, text: OPEN_TAB_FIRST });
    expect((await detail(first)).shots).toHaveLength(2);
    await asker.close();
    await ext.worker.evaluate((id) => (globalThis as unknown as { chrome: ChromeLike }).chrome.tabs.remove(id), other);
    await meet.bringToFront();
  }, 90_000);

  it('4. Jantar down: the click says so, the page says it waits, and the turns arrive once each after the restart', async () => {
    await d.restart(async () => {
      await step(meet, 'say', 'Sam', 'While Jantar was down we agreed to move the demo to Tuesday morning.');
      await meet.waitForTimeout(400);
      await step(meet, 'say', 'Priya', 'And I will send the revised quote to the client before lunch.');
      await meet.waitForTimeout(400);
      await clickCamera(meet);
      await cameraUntil(meet, (v) => v.bubble === NOT_RUNNING, 'the not-running flash', 5_000);
      await cameraUntil(meet, (v) => v.bubble === NOT_ANSWERING, 'the not-answering bubble', 15_000);
    });
    const want = ['Sam: While Jantar was down we agreed to move the demo to Tuesday morning.', 'Priya: And I will send the revised quote to the client before lunch.'];
    await eventually(async () => {
      const got = said(await detail(first));
      return want.every((w) => got.filter((g) => g === w).length === 1);
    }, 8_000, 'the turns said while Jantar was down');
    // Still the one meeting, notes still on; the click made no meeting and saved nothing.
    const after = await list();
    expect(after.meetings.map((x) => x.id)).toEqual([first]);
    expect(after.running?.id).toBe(first);
    expect((await detail(first)).shots).toHaveLength(2);
    await cameraUntil(meet, (v) => v.dot, 'notes still on');
  }, 90_000);

  it('5. a short gap keeps the meeting; a new Meet code ends it, its summary and todos follow, and the new call has no meeting', async () => {
    await step(meet, 'hooksOff');
    await step(meet, 'say', 'Sam', 'Can everyone hear me now, the screen share dropped for a moment there.');
    await meet.waitForTimeout(10_000);
    await step(meet, 'hooksOn');
    await eventually(async () => said(await detail(first)).includes('Sam: Can everyone hear me now, the screen share dropped for a moment there.'), 8_000, 'the turn said during the gap');
    expect((await list()).meetings.map((x) => x.id)).toEqual([first]);
    expect((await detail(first)).meeting.endedAt).toBeNull();

    await step(meet, 'goTo', '/meet/xyz-abcd-efg');
    const ended = await eventually(async () => {
      const got = await detail(first);
      return got.meeting.endedAt ? got : null;
    }, 5_000, 'the first meeting to end');
    expect(ended.meeting.endReason).toBe('left');

    const done = await eventually(async () => {
      const got = await detail(first);
      if (got.summary.state === 'failed') throw new Error(`the summary failed: ${got.summary.reason ?? ''}`);
      return got.summary.state === 'done' && got.summary.items.every((i) => i.todoId) ? got : null;
    }, 30_000, 'the summary and its todos');
    expect(done.summary.items).toHaveLength(2);
    const todos = async () => ((await phoneCall('GET', '/v1/todos')).body as TodosResponse).todos.filter((t) => t.projectId === projects.a);
    expect((await todos()).map((t) => t.id).sort()).toEqual(done.summary.items.map((i) => i.todoId).sort());

    const removed = await phoneCall('DELETE', `/v1/meetings/${first}/items/0/todo`);
    expect(removed.status, removed.text).toBe(200);
    expect((await todos()).map((t) => t.id)).toEqual([done.summary.items[1]!.todoId]);
    expect((await detail(first)).summary.items[0]!.todoId).toBeUndefined();

    // The new call: the button, no notes, no meeting.
    expect(meet.url()).toBe(MEET_NEXT);
    await cameraUntil(meet, (v) => v.button && !v.dot, 'the button in the new call');
    expect((await list()).running).toBeNull();
    const popup = await openPopup(ext, await tabIdOf(ext, MEET_NEXT), meet);
    await popup.getByRole('button', { name: 'Start notes' }).waitFor();
    await popup.close();
  }, 120_000);

  it('6. Teams under a strict CSP: the button, a shot without it, one line for a remounted turn; End, and closing the tab, end a meeting', async () => {
    const csp: string[] = [];
    const teams = await meetingPage(TEAMS_STRICT, 'teams-2026-right', STRICT_CSP);
    teams.on('console', (msg) => {
      if (/Content Security Policy|Trusted Type/i.test(msg.text())) csp.push(msg.text());
    });
    await cameraUntil(teams, (v) => v.button, 'the button on the strict page');
    await startNotes(teams, { name: 'Teams sync' });
    const id = await eventually(async () => (await list()).running?.id, 5_000, 'the Teams meeting');
    expect((await detail(id)).meeting.site).toBe('teams');

    await step(teams, 'say', 'Alex', 'The vendor call moved to Thursday, so the budget review waits a week.');
    await teams.waitForTimeout(700);
    await step(teams, 'unmount', 0);
    await teams.waitForTimeout(700);
    await step(teams, 'remount', 0);
    await teams.waitForTimeout(700);
    await step(teams, 'say', 'You', 'Thanks, I will update the plan tonight.');
    const want = ['Alex: The vendor call moved to Thursday, so the budget review waits a week.', 'You: Thanks, I will update the plan tonight.'];
    await eventually(async () => JSON.stringify(said(await detail(id))) === JSON.stringify(want), 8_000, 'the Teams lines');
    await teams.waitForTimeout(1_500);
    expect(said(await detail(id))).toEqual(want);

    const box = (await cameraBox(teams))!;
    await clickCamera(teams);
    await cameraUntil(teams, (v) => v.bubble === SAVED, 'the Saved flash on Teams', 5_000);
    const shot = await eventually(async () => (await detail(id)).shots[0], 5_000, 'the Teams screenshot');
    const bytes = await ctl.bytes(`/v1/meetings/${id}/shots/${shot.id}`);
    const colour = await pixelAt(ext.context, bytes.body, box.x + box.width / 2, box.y + box.height / 2, teams.viewportSize()?.width ?? 1280);
    expect(nearBackground(colour), `the button's spot in the picture is ${colour.join(',')}`).toBe(true);
    expect(csp).toEqual([]);

    // End from the popup: the meeting ends now, and the dot goes.
    const popup = await openPopup(ext, await tabIdOf(ext, TEAMS_STRICT), teams);
    await popup.getByRole('button', { name: 'End' }).click();
    await popup.getByRole('button', { name: 'Start notes' }).waitFor();
    await popup.close();
    const ended = await eventually(async () => {
      const got = await detail(id);
      return got.meeting.endedAt ? got : null;
    }, 5_000, 'End to end the meeting');
    expect(ended.meeting.endReason).toBe('user');
    await cameraUntil(teams, (v) => v.button && !v.dot, 'notes off after End');

    // Start again in the same call: a new meeting, which closing the tab ends.
    await startNotes(teams, { name: 'Teams sync, part two' });
    const again = await eventually(async () => (await list()).running?.id, 5_000, 'the second Teams meeting');
    expect(again).not.toBe(id);
    await teams.close();
    const closed = await eventually(async () => {
      const got = await detail(again);
      return got.meeting.endedAt ? got : null;
    }, 5_000, 'the Teams meeting to end');
    expect(closed.meeting.endReason).toBe('closed');
  }, 90_000);

  it('7. a screenshot before Start makes a meeting without notes; Start keeps it; leaving ends it after the grace; lines for a meeting without notes are 409', async () => {
    const live = await meetingPage(TEAMS_LIVE, 'teams-v2');
    await step(live, 'say', 'Sam', 'This turn was on screen before Start.');
    await cameraUntil(live, (v) => v.button, 'the button on teams.live.com');
    await clickCamera(live);
    await cameraUntil(live, (v) => v.bubble === SAVED, 'the Saved flash before Start', 5_000);
    const made = await eventually(async () => (await list()).running, 5_000, 'the meeting the screenshot made');
    expect(made).toMatchObject({ notes: false, lines: 0, shots: 1, site: 'teams' });
    // Nothing is read before Start (MP6).
    await live.waitForTimeout(2_000);
    expect((await detail(made.id)).lines).toEqual([]);

    await startNotes(live);
    await eventually(async () => (await detail(made.id)).meeting.notes, 5_000, 'notes on');
    await step(live, 'say', 'Priya', 'Now the notes are on, this line is kept.');
    await eventually(async () => said(await detail(made.id)).includes('Priya: Now the notes are on, this line is kept.'), 8_000, 'the line after Start');
    expect((await list()).meetings.filter((x) => x.id === made.id)).toHaveLength(1);

    // Leaving: the call's hooks gone for good end the meeting once the minute's grace runs out, not before.
    await step(live, 'hooksOff');
    await live.waitForTimeout(45_000);
    expect((await detail(made.id)).meeting.endedAt).toBeNull();
    const left = await eventually(async () => {
      const got = await detail(made.id);
      return got.meeting.endedAt ? got : null;
    }, 30_000, 'the meeting to end after the grace');
    expect(left.meeting.endReason).toBe('left');

    // The daemon refuses lines for a meeting opened with captions off, whoever sends them.
    const code = (await callDaemon<{ code: string }>(ctl, 'POST', '/v1/ext/pair/start')).code;
    const origin = `chrome-extension://${EXTENSION_ID}`;
    const claim = await http(d.port, 'POST', '/v1/ext/pair', { body: { code }, origin });
    expect(claim.status, claim.text).toBe(200);
    const key = (claim.body as { key: string }).key;
    const ext2 = { origin, headers: { 'x-jantar-extension-key': key } };
    const client = '3c0b8a4e-9d2f-4b1a-8e7c-5f6a7b8c9d0e';
    const opened = await http(d.port, 'POST', `/v1/ext/meetings/${client}`, { ...ext2, body: { site: 'meet', name: 'By hand', autoTodos: false, captions: false, at: Date.now() } });
    expect(opened.status, opened.text).toBe(200);
    const lines = await http(d.port, 'POST', `/v1/ext/meetings/${client}/lines`, { ...ext2, body: { lines: [{ lineId: 'abcdefgh-1', rev: 1, speaker: 'Sam', text: 'Not kept.', at: Date.now() }] } });
    expect(lines.status, lines.text).toBe(409);
    await live.close();
  }, 180_000);

  it('8. Not now: the build as you load it, paired, the page button says to click the Jantar icon, and nothing is made', async () => {
    const plain = await launchExtension({ build: 'dist' });
    try {
      await serveFixtures(plain.context);
      served.set('meet.google.com', { page: 'meet-call' });
      const page = await plain.context.newPage();
      await page.goto('https://meet.google.com/meet/not-nown-oway', { waitUntil: 'load' });
      // The worker sees no meeting URL without a grant: the popup pairs with no tab.
      const opened = plain.context.waitForEvent('page', { predicate: (p) => p.url().includes('/popup.html') });
      await plain.worker.evaluate(async () => {
        const c = (globalThis as unknown as { chrome: ChromeLike }).chrome;
        await c.windows.create({ url: c.runtime.getURL('popup.html?tab=-1'), type: 'popup' });
      });
      const popup = await opened;
      await view(popup).getByText('Pairing code').waitFor();
      const paired = await pairThrough(popup);
      expect(paired.code, paired.err).toBe(0);
      await view(popup).getByText('Let the screenshot button work on meeting pages').waitFor();
      await popup.getByRole('button', { name: 'Not now' }).click();
      expect(await popup.evaluate(() => (globalThis as unknown as { chrome: ChromeLike }).chrome.permissions.contains({ origins: ['<all_urls>'] }))).toBe(false);
      await popup.close();

      const before = (await list()).meetings.length;
      await page.bringToFront();
      await cameraUntil(page, (v) => v.button, 'the button after pairing');
      await clickCamera(page);
      await cameraUntil(page, (v) => v.bubble === ALLOW_HERE, 'the allow-here flash', 5_000);
      expect((await list()).meetings).toHaveLength(before);
    } finally {
      await plain.close();
    }
  }, 90_000);

  it('the sweep: what was typed into the sheet and said in the call is in no event, audit row or log line', async () => {
    // It was in play: the meeting holds it.
    expect(JSON.stringify(await detail(first))).toContain(MEETING_MARKER);
    const replay = d.ctx.store.replay(0);
    const sources: Record<string, unknown> = {
      'event ring': replay.kind === 'events' ? replay.events : [],
      'stored events': d.ctx.db.events.since(0),
      'audit rows': d.ctx.db.audit.list({ after: 0, limit: 100_000 }),
      'log lines': d.log.records,
    };
    for (const [what, value] of Object.entries(sources)) expect(JSON.stringify(value), what).not.toContain(MEETING_MARKER);
  });

  it("10. a broken meetings.db: the popup shows the daemon's sentence", async () => {
    const file = d.ctx.paths.meetingsDb;
    await d.restart(async () => {
      for (const extra of ['-wal', '-shm']) await rm(`${file}${extra}`, { force: true });
      await writeFile(file, randomBytes(32 * 1024), { mode: 0o600 });
    });
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    expect((await status()).broken).toBe(BROKEN);
    const popup = await openPopup(ext, await tabIdOf(ext, MEET_NEXT), meet);
    await view(popup).getByText(BROKEN).waitFor();
    await popup.close();
  }, 60_000);
});
