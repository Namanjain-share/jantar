/// <reference lib="dom" />
/**
 * v0.5.3 (spec 3.3): screenshots on the extension as you load it (`dist/`,
 * no `<all_urls>`), where only the toolbar icon's activeTab grant lets
 * Chrome take a tab: the path every user who chose Not now depends on, and
 * the one the first real calls never got through. playwright-core's own
 * Chromium with a fresh temp profile, a synthetic Meet call served at a real
 * Meet URL (the extension's fixture page), and jantard in-process on a
 * synthetic HOME (harness.ts) with Meetings on.
 *
 * 1. Paired, the icon never used: the page button says "Not saved: click
 *    the Jantar icon once in this tab, then try again.", no upload reaches
 *    jantard (no `meetings: screenshot upload` line), and the worker's last
 *    try is `grant`, with Chrome's own words.
 * 2. The toolbar icon (Extensions.triggerAction on the tab target, Chrome's
 *    own click): the action popup draws the sheet, and the page button
 *    saves; jantard logs one upload, 200.
 * 3. A reload on the same origin: the grant holds, the page button saves.
 * 4. Another origin and back: the grant is gone, the allow-here sentence
 *    again, nothing sent.
 * 5. The icon again: the real action popup names the failed try, and its
 *    Screenshot (a trusted click on the popup's own target) saves. Then
 *    Settings says "Last screenshot: <time> · popup · Saved" and the
 *    shortcut Chrome holds.
 *
 * A Chromium without Extensions.triggerAction skips 2 to 5 with a warning,
 * as the suites do without Chromium. Needs `pnpm -r build` and the full
 * Chromium (extension.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { perfBudgetMs } from '@jantar/fixtures';
import type { ExtPairStartReply, MeetingsList } from '@jantar/protocol';
import { SHOT_UPLOAD_LOG } from '@jantar/daemon/api/app';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { FIXTURE_SCRIPT_PATH, fixtureDriverScript, fixturePageHtml } from '../../packages/extension/test/fixtures/pages.js';
import { actionPopup, cameraView, clickCamera, clickToolbarIcon, extensionReady, launchExtension, openPopup, type CameraView, type ChromeLike, type LoadedExtension } from './extension.js';
import { bootDaemon, type Daemon } from './harness.js';
import { eventually } from './http.js';

const ready = await extensionReady('ext-v053', 'dist');

const MEET = 'https://meet.google.com/qwe-rtyu-iop';
const OTHER = 'https://example.com/';
const SAVED = 'Saved';
const ALLOW_HERE = 'Not saved: click the Jantar icon once in this tab, then try again.';
const NO_ICON = '[ext-v053] skipped: this Chromium has no Extensions.triggerAction (the toolbar icon)';

/** The worker's record of the last try (chrome.storage.session `lastShot`). */
interface LastShotSeen {
  at: number;
  from: string;
  tabId: number;
  ok: boolean;
  text: string;
  step: string;
  chrome?: string;
  status?: number;
}

type WithStorage = ChromeLike & { storage: { session: { get(key: string): Promise<Record<string, unknown>> } }; commands: { getAll(): Promise<{ name?: string; shortcut?: string }[]> } };

describe.skipIf(!ready)('ext-v053: screenshots through the toolbar icon on the build as you load it', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let ext: LoadedExtension;
  let meet: Page;
  /** Extensions.triggerAction worked (step 2); else 2 to 5 skip. */
  let icon = false;

  const lastShot = () =>
    ext.worker.evaluate(async () => (await (globalThis as unknown as { chrome: WithStorage }).chrome.storage.session.get('lastShot')).lastShot) as Promise<LastShotSeen | undefined>;
  /** Every screenshot jantard holds, over all meetings. */
  const shots = async () => (await callDaemon<MeetingsList>(ctl, 'GET', '/v1/meetings?limit=50')).meetings.reduce((n, m) => n + m.shots, 0);
  /** jantard's one line per upload (wave 0, api/app.ts), refusals included. */
  const uploads = () => d.log.records.filter((r) => r.msg === SHOT_UPLOAD_LOG).map((r) => r.fields.status);

  async function cameraUntil(ok: (v: CameraView) => boolean, what: string, ms = 10_000): Promise<CameraView> {
    let last: CameraView | null = null;
    try {
      return await eventually(async () => {
        last = await cameraView(meet);
        return ok(last) ? last : null;
      }, ms, what);
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)} (last: ${JSON.stringify(last)})`);
    }
  }

  /** The page button, and the bubble it ends with. */
  async function pageButton(bubble: string): Promise<void> {
    await meet.bringToFront();
    await cameraUntil((v) => v.button && !v.hidden, 'the camera button');
    await clickCamera(meet);
    await cameraUntil((v) => v.bubble === bubble, `the bubble "${bubble}"`);
  }

  /** The toolbar icon, then its popup once it has drawn `words`. */
  async function iconPopup(words: string) {
    expect(await clickToolbarIcon(ext, meet)).toBe(true);
    const popup = await actionPopup(ext);
    await eventually(() => popup.evaluate<boolean>(`(document.querySelector('.view')?.textContent ?? '').includes(${JSON.stringify(words)})`), 10_000, `the action popup saying "${words}"`);
    return popup;
  }

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { meetings: { enabled: true } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    ext = await launchExtension({ build: 'dist' });
    const driver = await fixtureDriverScript();
    await ext.context.route('https://meet.google.com/**', (route) =>
      new URL(route.request().url()).pathname === FIXTURE_SCRIPT_PATH
        ? route.fulfill({ status: 200, contentType: 'text/javascript', body: driver })
        : route.fulfill({ status: 200, contentType: 'text/html', body: fixturePageHtml('meet-call') }),
    );
    await ext.context.route(`${OTHER}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Example</title><p>Another site</p>' }));

    // Paired from an extension page, as the popup pairs (Not now: no <all_urls>).
    const start = await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start');
    const pairer = await ext.context.newPage();
    await pairer.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=-1`);
    const done = await pairer.evaluate((line) => (globalThis as unknown as { chrome: ChromeLike }).chrome.runtime.sendMessage({ t: 'pair', text: line }), `jantar-ext:${start.port ?? d.port}:${start.code}`);
    expect(done).toEqual({ ok: true });
    expect(await pairer.evaluate(() => (globalThis as unknown as { chrome: ChromeLike }).chrome.permissions.contains({ origins: ['<all_urls>'] }))).toBe(false);
    await pairer.close();

    meet = await ext.context.newPage();
    await meet.goto(MEET, { waitUntil: 'load' });
  }, perfBudgetMs(90_000));

  afterAll(async () => {
    await ext?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. the icon never used: the page button says to click it, nothing reaches Jantar, and the last try is "grant" in Chrome\'s words', async () => {
    await pageButton(ALLOW_HERE);
    const last = await lastShot();
    expect(last).toMatchObject({ from: 'page', ok: false, step: 'grant', text: ALLOW_HERE });
    expect(last?.chrome).toMatch(/activeTab/);
    expect(JSON.stringify(last)).not.toContain('meet.google.com');
    expect(uploads()).toEqual([]);
    expect(await shots()).toBe(0);
  }, perfBudgetMs(60_000));

  it('2. the toolbar icon (Chrome\'s own click on the tab): the page button saves, and jantard logs the upload', async (t) => {
    icon = await clickToolbarIcon(ext, meet);
    if (!icon) {
      console.warn(NO_ICON);
      t.skip();
    }
    // The action popup ran for this tab: the grant shows it the meeting.
    const popup = await actionPopup(ext);
    await eventually(() => popup.evaluate<boolean>(`(document.querySelector('.view')?.textContent ?? '').includes('Start notes')`), 10_000, 'the sheet in the action popup');
    await popup.close();
    await pageButton(SAVED);
    await eventually(async () => (await shots()) === 1, 5_000, 'the first screenshot');
    expect(uploads()).toEqual([200]);
    expect(await lastShot()).toMatchObject({ from: 'page', ok: true, step: 'saved', text: SAVED });
  }, perfBudgetMs(60_000));

  it('3. a reload on the same origin keeps the grant: the page button saves', async (t) => {
    if (!icon) t.skip();
    await meet.reload({ waitUntil: 'load' });
    await pageButton(SAVED);
    await eventually(async () => (await shots()) === 2, 5_000, 'the screenshot after the reload');
    expect(uploads()).toEqual([200, 200]);
  }, perfBudgetMs(60_000));

  it('4. another origin and back drops it: the allow-here sentence, nothing sent', async (t) => {
    if (!icon) t.skip();
    await meet.goto(OTHER, { waitUntil: 'load' });
    await meet.goto(MEET, { waitUntil: 'load' });
    await pageButton(ALLOW_HERE);
    expect(await lastShot()).toMatchObject({ from: 'page', ok: false, step: 'grant' });
    expect(uploads()).toEqual([200, 200]);
    expect(await shots()).toBe(2);
  }, perfBudgetMs(60_000));

  it("5. the icon again: the real popup names the failed try, its Screenshot saves, and Settings says so with Chrome's shortcut", async (t) => {
    if (!icon) t.skip();
    const popup = await iconPopup('Last screenshot not saved: click the Jantar icon once in this tab, then try again.');
    expect(await popup.evaluate<string>(`document.querySelector('.view').textContent`)).not.toMatch(/allowed/i);
    const at = await popup.evaluate<{ x: number; y: number } | null>(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Screenshot'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    expect(at).not.toBeNull();
    // The popup closes itself as it asks; the worker waits for it to go, then takes the tab.
    await popup.click(at!.x, at!.y);
    await eventually(async () => (await shots()) === 3, 10_000, "the popup's screenshot");
    await popup.close();
    expect(uploads()).toEqual([200, 200, 200]);
    // The worker keeps the record once the upload's answer is back, a moment after jantard holds the shot.
    const last = await eventually(async () => {
      const seen = await lastShot();
      return seen?.from === 'popup' ? seen : null;
    }, 5_000, "the popup try's record");
    expect(last).toMatchObject({ from: 'popup', ok: true, step: 'saved' });

    const shortcut = await ext.worker.evaluate(async () => (await (globalThis as unknown as { chrome: WithStorage }).chrome.commands.getAll()).find((c) => c.name === 'take-screenshot')?.shortcut ?? '');
    const settings = await openPopup(ext, -1);
    await settings.getByRole('button', { name: 'Settings' }).click();
    const when = new Date(last!.at);
    const hhmm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    await settings.locator('.view').getByText(`Last screenshot: ${hhmm} · popup · Saved`).waitFor();
    await settings.locator('.view').getByText(`Shortcut: ${shortcut || 'not set'}`).waitFor();
    await settings.close();
  }, perfBudgetMs(60_000));
});
