/**
 * Screenshots in the worker (spec 3.8): MX2 (only the meeting tab, only in
 * a call, only while it is in front and on a meeting page, checked right
 * before and after every capture call), MX6 (Jantar down makes no meeting;
 * a 404 opens a new one and saves), MX8 (Meetings off flashes the daemon's
 * sentence and makes no meeting), and every "Not saved" sentence. The
 * capture comes first, so a failed one makes no meeting; one queue, at
 * least 550 ms apart, holding a shot only until its capture; the quota
 * error waits 600 ms and tries once more; too large tries quality 60.
 * v0.5.3: Chrome's own words kept (cut, no web address), a capture Chrome
 * never answers fails after 5 s and frees the queue, and one LastShot
 * record for every try, whatever step it ended at.
 */
import { MEETING_MARKER, markerJpeg } from '@jantar/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MISMATCH, NOT_OPEN, SHOT } from '../../src/background/sentences.js';
import { CAPTURE_TIMEOUT_MS, CHROME_SAID_MAX, HIDE_WAIT_MS, LAST_SHOT_KEY, NO_CAPTURE_ANSWER, POPUP_CLOSE_MS, QUOTA_WAIT_MS, chromeSaid } from '../../src/background/shots.js';
import type { LastShot, ShotStep } from '../../src/shared/messages.js';
import { MEETING_SHOT_MAX_BYTES, TIMING } from '../../src/shared/wire.js';
import { CAPTURE_PERMISSION_ERROR } from '../helpers/chrome-fake.js';
import { MEET_URL, UUID, daemonError, markerIn, setupWorker, watchConsole, type WorkerUnderTest } from './chrome.js';

/** Another site, in front of the meeting's window or in the meeting's own tab. */
const BANK_URL = 'https://bank.example.com/';
const MAIL_URL = 'https://mail.example.com/inbox';

let w: WorkerUnderTest;
let watched: ReturnType<typeof watchConsole> | undefined;
afterEach(() => {
  // MP7: no image bytes, titles or names in the console.
  if (watched) expect(markerIn(watched.text())).toBe(false);
  watched = undefined;
  w?.close();
});

const shot = (tabId = 7) => w.page(tabId, { t: 'shot' });

/** A worker whose sleeps run `during(ms)` first (then move the virtual clock on, as setupWorker's do). */
function workerWithSleeps(during: (ms: number) => void): WorkerUnderTest {
  const made = setupWorker({
    deps: {
      sleep: async (ms) => {
        during(ms);
        made.clock.slept.push(ms);
        made.clock.t += ms;
      },
    },
  });
  return made;
}

/** Another tab comes to the front of window 1. */
const bankInFront = () => w.model.addTab({ id: 9, windowId: 1, url: BANK_URL, active: true });

describe('MX2: only the meeting tab, in a call', () => {
  it('a meeting tab that is not the active tab of its window is never captured', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.addTab({ id: 8, windowId: 1, url: 'https://example.com/', active: true });
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: false, text: SHOT.openTabFirst });
    w.chrome.commands.onCommand.dispatch('take-screenshot', w.model.tab(7));
    await expect.poll(() => w.toPage(7).some((m) => m.t === 'show')).toBe(true);
    expect(w.model.captures).toEqual([]);
    expect(w.daemon.calls).toEqual([]);
  });

  it('a request naming another tab is refused before any capture', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.addTab({ id: 8, windowId: 2, url: 'https://example.com/', active: true });
    expect(await w.popup({ t: 'shot', tabId: 8 })).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(await w.popup({ t: 'shot', tabId: 99 })).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(w.model.captures).toEqual([]);
  });

  it('outside a call (the waiting room) the answer is "join the call first"', async () => {
    w = setupWorker();
    await w.meetTab(7, { inCall: false });
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.joinFirst });
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: false, text: SHOT.joinFirst });
    expect(w.model.captures).toEqual([]);
  });

  it('a meeting tab that went to another site in the same tab is never captured, and the popup offers nothing there', async () => {
    w = setupWorker();
    await w.meetTab(7);
    expect(await shot(7)).toEqual({ ok: true, text: SHOT.saved });
    // Left the call and typed another address within the 60-s grace: no `left` came, the record still says in a call.
    w.model.addTab({ id: 7, windowId: 1, url: MAIL_URL, active: true });
    w.model.onTabMessage(7, null);
    const captures = w.model.captures.length;
    const calls = w.daemon.calls.length;
    w.chrome.commands.onCommand.dispatch('take-screenshot', w.model.tab(7));
    await expect.poll(() => w.toPage(7).some((m) => m.t === 'show')).toBe(true);
    expect(w.toPage(7).find((m) => m.t === 'show')).toEqual({ t: 'show', flash: SHOT.openTabFirst });
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: false, text: SHOT.openTabFirst });
    // A page click sent while the tab was still on Meet, arriving after it left.
    const stale = { id: w.chrome.runtime.id, tab: { id: 7, windowId: 1, url: MEET_URL, active: true }, url: MEET_URL };
    expect(await w.chrome.runtime.onMessage.dispatch({ t: 'shot' }, stale)).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(w.model.captures.length).toBe(captures);
    expect(w.daemon.calls.length).toBe(calls);
    expect(await w.popup({ t: 'state', tabId: 7 })).toMatchObject({ connection: 'ok', tab: null });
  });

  it('a tab whose URL Chrome hides (no grant there) is tried: the capture says how to allow it', async () => {
    w = setupWorker();
    await w.meetTab(7);
    // The page button's sender names its page; tabs.get shows no URL without activeTab or <all_urls>.
    w.model.addTab({ id: 7, windowId: 1, url: undefined as unknown as string, active: true });
    w.model.failCapture('permission');
    const sender = { id: w.chrome.runtime.id, tab: { id: 7, windowId: 1, url: MEET_URL, active: true }, url: MEET_URL };
    expect(await w.chrome.runtime.onMessage.dispatch({ t: 'shot' }, sender)).toEqual({ ok: false, text: SHOT.allowHere });
    expect(w.model.captures).toHaveLength(1);
    expect(w.daemon.calls).toEqual([]);
  });

  it("captures the meeting tab's window, JPEG at quality 85", async () => {
    w = setupWorker();
    await w.meetTab(7, { windowId: 4 });
    expect(await shot(7)).toEqual({ ok: true, text: SHOT.saved });
    expect(w.model.captures).toEqual([{ windowId: 4, options: { format: 'jpeg', quality: 85 } }]);
  });
});

describe('a screenshot before Start', () => {
  it('opens a meeting for the call (captions off, the name the popup would prefill) and saves into it', async () => {
    w = setupWorker();
    watched = watchConsole();
    w.model.captureImage = markerJpeg();
    await w.meetTab(7, { title: 'Weekly sync' });
    expect(await shot(7)).toEqual({ ok: true, text: SHOT.saved });
    expect(w.daemon.ops()).toEqual(['open', 'shot']);
    const [open] = w.daemon.of('open');
    const [up] = w.daemon.of('shot');
    expect(open?.body).toEqual({ site: 'meet', name: 'Weekly sync', autoTodos: false, captions: false, at: w.clock.t });
    expect(up?.clientId).toBe(open?.clientId);
    // The image as captureVisibleTab gave it, with a fresh key and the click's time.
    expect(up?.body).toEqual({ key: expect.stringMatching(UUID), at: expect.any(Number), image: `data:image/jpeg;base64,${markerJpeg().toString('base64')}` });
    expect(w.tabState(7)).toMatchObject({ clientId: open?.clientId, notes: false, shots: 1 });
    // The image never went to a page or into storage.
    expect(JSON.stringify(w.toPage(7))).not.toContain('base64');
    expect(JSON.stringify([...w.model.session.values()])).not.toContain('base64');
  });

  it('names a meeting on a page with no title "Teams call" or "Meet call"', async () => {
    w = setupWorker();
    await w.meetTab(7, { url: 'https://teams.live.com/v2/', title: '' });
    await shot(7);
    expect(w.daemon.of('open')[0]?.body).toMatchObject({ site: 'teams', name: 'Teams call' });
  });

  it('a second screenshot goes into the same meeting', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await shot(7);
    await shot(7);
    expect(w.daemon.ops()).toEqual(['open', 'shot', 'shot']);
    const [a, b] = w.daemon.of('shot');
    expect(a?.clientId).toBe(b?.clientId);
    expect(a?.body).not.toEqual(b?.body);
    expect(w.tabState(7)).toMatchObject({ shots: 2 });
  });
});

describe('capture first: a failed capture makes no meeting', () => {
  it('without a grant here: "Not saved: click the Jantar icon once in this tab, then try again."', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.failCapture('permission');
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.allowHere });
    expect(w.daemon.calls).toEqual([]);
  });

  it('an image that is not a JPEG data URL: "Not saved: Chrome could not take it."', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.chrome.tabs.captureVisibleTab = async () => 'data:image/png;base64,iVBORw0KGgo=';
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.chromeFailed });
    expect(w.daemon.calls).toEqual([]);
  });

  it('any other error: "Not saved: Chrome could not take it."', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.failCapture('Failed to capture tab: view is invisible');
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.chromeFailed });
    expect(w.daemon.calls).toEqual([]);
  });

  it('the quota error waits 600 ms and tries once more', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.failCapture('quota');
    expect(await shot(7)).toEqual({ ok: true, text: SHOT.saved });
    expect(w.model.captures).toHaveLength(2);
    expect(w.clock.slept).toContain(QUOTA_WAIT_MS);
    w.model.failCapture('quota', 2);
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.chromeFailed });
  });

  it('too large at 85 tries 60; still too large is "Not saved: the screenshot is too large."', async () => {
    w = setupWorker();
    await w.meetTab(7);
    const big = `data:image/jpeg;base64,${Buffer.alloc(MEETING_SHOT_MAX_BYTES + 3, 0xff).toString('base64')}`;
    const small = `data:image/jpeg;base64,${w.model.captureImage.toString('base64')}`;
    const qualities: number[] = [];
    w.chrome.tabs.captureVisibleTab = async (_win, opts) => {
      qualities.push(opts?.quality ?? 0);
      return opts?.quality === 85 ? big : small;
    };
    expect(await shot(7)).toEqual({ ok: true, text: SHOT.saved });
    expect(qualities).toEqual([85, 60]);
    expect((w.daemon.of('shot')[0]?.body as { image: string }).image).toBe(small);
    w.chrome.tabs.captureVisibleTab = async () => big;
    const before = w.daemon.calls.length;
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.tooLarge });
    expect(w.daemon.calls.length).toBe(before);
  });
});

describe('the upload', () => {
  it('MX6: Jantar down says so and makes no meeting', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.daemon.on('open', 'down');
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.notRunning });
    expect(w.tabState(7)?.clientId).toBeUndefined();
    w.daemon.on('open', { status: 200, body: { id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' } });
    w.daemon.on('shot', 'down');
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.notRunning });
    w.daemon.on('shot', daemonError(500, 'internal'));
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.notRunning });
  });

  it('MX6: a 404 (the meeting ended or was deleted) opens a new meeting and saves there', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await w.popup({ t: 'start', tabId: 7, name: 'Weekly sync', autoTodos: false });
    const first = w.tabState(7)?.clientId;
    w.daemon.on('shot', daemonError(404, NOT_OPEN), { status: 200, body: { id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' } });
    expect(await shot(7)).toEqual({ ok: true, text: SHOT.saved });
    const [lost, saved] = w.daemon.of('shot');
    expect(lost?.clientId).toBe(first);
    expect(saved?.clientId).not.toBe(first);
    expect(saved?.body).toEqual(lost?.body);
    expect(w.daemon.of('open')[1]).toMatchObject({ clientId: saved?.clientId, body: { captions: false } });
    expect(w.tabState(7)).toMatchObject({ clientId: saved?.clientId, notes: false, shots: 1 });
    // Notes were on in the lost meeting: the page stops them and says why.
    expect(w.toPage(7)).toContainEqual({ t: 'capture', on: false, text: NOT_OPEN });
  });

  it('a 404 twice is not retried again', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.daemon.on('shot', daemonError(404, NOT_OPEN));
    expect(await shot(7)).toEqual({ ok: false, text: `Not saved: ${NOT_OPEN}` });
    expect(w.daemon.of('shot')).toHaveLength(2);
  });

  it("MX8: Meetings off flashes the daemon's sentence and makes no meeting", async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.daemon.on('open', daemonError(403, 'Meetings are off. Turn them on at your Mac: jantar meetings on'));
    expect(await shot(7)).toEqual({ ok: false, text: 'Not saved: Meetings are off. Turn them on at your Mac: jantar meetings on' });
    expect(w.daemon.of('shot')).toEqual([]);
    expect(w.tabState(7)?.clientId).toBeUndefined();
  });

  it("a cap, a body limit or the day's budget: 'Not saved: <the daemon's sentence>'", async () => {
    w = setupWorker();
    await w.meetTab(7);
    for (const [status, sentence] of [
      [409, 'This meeting has 500 screenshots.'],
      [409, 'Screenshots fill 5 GB in Jantar. Delete some meetings to take more.'],
      [413, 'request body is larger than 6 MB'],
      [429, 'This extension sent 1 GB of screenshots today. Try again tomorrow.'],
      [403, 'Meetings are off. Turn them on at your Mac: jantar meetings on'],
    ] as const) {
      w.daemon.on('shot', daemonError(status, sentence));
      expect(await shot(7)).toEqual({ ok: false, text: `Not saved: ${sentence}` });
    }
  });

  it('a 400 is the mismatch sentence', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.daemon.on('shot', daemonError(400, 'Not a JPEG image.'));
    expect(await shot(7)).toEqual({ ok: false, text: MISMATCH });
  });

  it('a 401 forgets the key, takes the button away from every tab and says "pair again"', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await w.meetTab(8, { windowId: 2 });
    w.daemon.on('open', daemonError(401, 'The Jantar extension is not paired.'));
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.pairAgain });
    expect(await w.keys.get()).toBeNull();
    expect(w.toPage(7)).toContainEqual({ t: 'button', on: false });
    expect(w.toPage(8)).toContainEqual({ t: 'button', on: false });
    // Unpaired now: nothing is captured.
    const captures = w.model.captures.length;
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.pairAgain });
    expect(w.model.captures.length).toBe(captures);
  });
});

describe('where it comes from', () => {
  it('the page button: no hide or show from the worker (the page hides itself)', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await shot(7);
    expect(w.toPage(7)).toEqual([]);
  });

  it('the popup: waits for it to close, hides the button, shoots, shows it with the flash', async () => {
    w = setupWorker();
    await w.meetTab(7);
    const order: string[] = [];
    w.model.onTabMessage(7, (msg) => {
      order.push((msg as { t: string }).t);
      return { ok: true };
    });
    const capture = w.chrome.tabs.captureVisibleTab.bind(w.chrome.tabs);
    w.chrome.tabs.captureVisibleTab = (win, opts) => (order.push('capture'), capture(win, opts));
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: true, text: SHOT.saved });
    expect(order).toEqual(['hide', 'capture', 'show']);
    expect(w.toPage(7)).toEqual([{ t: 'hide' }, { t: 'show', flash: SHOT.saved }]);
    expect(w.clock.slept[0]).toBe(POPUP_CLOSE_MS);
  });

  it('the shortcut: hides, shoots and flashes; does nothing at all while unpaired', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.chrome.commands.onCommand.dispatch('take-screenshot', w.model.tab(7));
    await expect.poll(() => w.toPage(7).length).toBe(2);
    expect(w.toPage(7)).toEqual([{ t: 'hide' }, { t: 'show', flash: SHOT.saved }]);
    expect(w.model.captures).toHaveLength(1);
    w.chrome.commands.onCommand.dispatch('something-else', w.model.tab(7));
    await w.keys.clear();
    w.chrome.commands.onCommand.dispatch('take-screenshot', w.model.tab(7));
    await new Promise((r) => setTimeout(r, 10));
    expect(w.model.captures).toHaveLength(1);
    expect(w.toPage(7)).toHaveLength(2);
  });

  it('a page that never answers hide is waited for 300 ms at most', async () => {
    w = setupWorker({ deps: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } });
    await w.meetTab(7);
    w.model.onTabMessage(7, (msg) => ((msg as { t: string }).t === 'hide' ? new Promise(() => undefined) : undefined));
    const t0 = Date.now();
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: true, text: SHOT.saved });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(POPUP_CLOSE_MS + HIDE_WAIT_MS - 20);
    expect(w.model.captures).toHaveLength(1);
  });

  it('the tab left the front while the button hid: nothing is captured', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.onTabMessage(7, (msg) => {
      if ((msg as { t: string }).t === 'hide') w.model.addTab({ id: 9, windowId: 1, url: 'https://example.com/', active: true });
      return { ok: true };
    });
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(w.model.captures).toEqual([]);
  });
});

describe('in front right before and right after each capture call', () => {
  it('another tab came to the front during the gap before a queued capture: that shot is not taken', async () => {
    w = workerWithSleeps((ms) => {
      if (ms === TIMING.shotGapMs) bankInFront();
    });
    await w.meetTab(7);
    expect(await Promise.all([shot(7), shot(7)])).toEqual([
      { ok: true, text: SHOT.saved },
      { ok: false, text: SHOT.openTabFirst },
    ]);
    expect(w.model.captures).toHaveLength(1);
    expect(w.daemon.of('shot')).toHaveLength(1);
  });

  it('during the quota wait: no second try', async () => {
    w = workerWithSleeps((ms) => {
      if (ms === QUOTA_WAIT_MS) bankInFront();
    });
    await w.meetTab(7);
    w.model.failCapture('quota');
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(w.model.captures).toHaveLength(1);
    expect(w.daemon.calls).toEqual([]);
  });

  it('during the gap before the smaller retake: no retake', async () => {
    w = workerWithSleeps((ms) => {
      if (ms === TIMING.shotGapMs) bankInFront();
    });
    await w.meetTab(7);
    const big = `data:image/jpeg;base64,${Buffer.alloc(MEETING_SHOT_MAX_BYTES + 3, 0xff).toString('base64')}`;
    const qualities: number[] = [];
    w.chrome.tabs.captureVisibleTab = async (_win, opts) => {
      qualities.push(opts?.quality ?? 0);
      return big;
    };
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(qualities).toEqual([85]);
    expect(w.daemon.calls).toEqual([]);
  });

  it('while Chrome took it: the image is dropped', async () => {
    w = setupWorker();
    await w.meetTab(7);
    const capture = w.chrome.tabs.captureVisibleTab.bind(w.chrome.tabs);
    w.chrome.tabs.captureVisibleTab = async (win, opts) => {
      const image = await capture(win, opts);
      bankInFront();
      return image;
    };
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(w.model.captures).toHaveLength(1);
    expect(w.daemon.calls).toEqual([]);
  });

  it('in another window now (the tab was dragged out): not taken', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.onTabMessage(7, (msg) => {
      if ((msg as { t: string }).t === 'hide') w.model.addTab({ id: 7, windowId: 3, url: MEET_URL, active: true });
      return { ok: true };
    });
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: false, text: SHOT.openTabFirst });
    expect(w.model.captures).toEqual([]);
  });
});

describe('the queue', () => {
  it('one capture at a time, at least 550 ms apart, in the order asked; two clicks give two shots', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await w.meetTab(8, { windowId: 2, url: MEET_URL });
    const answers = await Promise.all([shot(7), shot(7), shot(8)]);
    expect(answers).toEqual([
      { ok: true, text: SHOT.saved },
      { ok: true, text: SHOT.saved },
      { ok: true, text: SHOT.saved },
    ]);
    expect(w.model.captures.map((c) => c.windowId)).toEqual([1, 1, 2]);
    expect(w.clock.slept.filter((ms) => ms === TIMING.shotGapMs)).toHaveLength(2);
    expect(w.daemon.of('shot')).toHaveLength(3);
  });

  it("holds a shot only until its capture: a slow upload keeps no other tab's capture waiting", async () => {
    w = setupWorker();
    await w.meetTab(7);
    await w.meetTab(8, { windowId: 2 });
    const held = w.daemon.hold('shot');
    const first = shot(7);
    await held.started;
    expect(await shot(8)).toEqual({ ok: true, text: SHOT.saved });
    expect(w.model.captures.map((c) => c.windowId)).toEqual([1, 2]);
    held.release();
    expect(await first).toEqual({ ok: true, text: SHOT.saved });
  });

  it("a tab's uploads keep click order, each after the one before", async () => {
    w = setupWorker();
    await w.meetTab(7);
    const held = w.daemon.hold('shot');
    const first = shot(7);
    await held.started;
    const second = shot(7);
    // The second click is captured now, while the first one's upload waits.
    await expect.poll(() => w.model.captures.length).toBe(2);
    expect(w.daemon.of('shot')).toHaveLength(1);
    held.release();
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, text: SHOT.saved },
      { ok: true, text: SHOT.saved },
    ]);
    const [a, b] = w.daemon.of('shot');
    expect(b?.clientId).toBe(a?.clientId);
    expect((a?.body as { at: number }).at).toBeLessThanOrEqual((b?.body as { at: number }).at);
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(w.tabState(7)).toMatchObject({ shots: 2 });
  });

  it('a capture long after the last waits for nothing', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await shot(7);
    w.clock.t += 5_000;
    await shot(7);
    expect(w.clock.slept).toEqual([]);
  });
});

/** The record the last try left in storage.session. */
const last = () => w.model.session.get(LAST_SHOT_KEY) as LastShot | undefined;
const big = `data:image/jpeg;base64,${Buffer.alloc(MEETING_SHOT_MAX_BYTES + 3, 0xff).toString('base64')}`;

describe("v0.5.3: Chrome's own words", () => {
  it('the allow-here sentence reads as a failure', () => {
    expect(SHOT.allowHere).toBe('Not saved: click the Jantar icon once in this tab, then try again.');
  });

  it('are kept on one line, with no web or data address, cut to 200 characters', () => {
    expect(chromeSaid(new Error(CAPTURE_PERMISSION_ERROR))).toBe(CAPTURE_PERMISSION_ERROR);
    expect(chromeSaid(new Error('Cannot access contents of url "https://meet.google.com/abc-defg-hij?authuser=1".\nExtension manifest must request permission.'))).toBe(
      'Cannot access contents of url "[url] Extension manifest must request permission.',
    );
    expect(chromeSaid(new Error('Cannot access a chrome:// URL'))).toBe('Cannot access a [url] URL');
    expect(chromeSaid('Bad image data:image/png;base64,iVBORw0KGgo= here')).toBe('Bad image [url] here');
    const long = chromeSaid(new Error(`Taking screenshots has been disabled ${'x'.repeat(400)}`));
    expect(long.length).toBe(CHROME_SAID_MAX);
    expect(long.startsWith('Taking screenshots has been disabled')).toBe(true);
    expect(chromeSaid(new Error(''))).toBe('no message');
  });

  it('a refused capture keeps them in the record, never in the flash', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.failCapture(`Taking screenshots has been disabled by https://admin.example.com/policy ${'x'.repeat(300)}`);
    expect(await shot(7)).toEqual({ ok: false, text: SHOT.chromeFailed });
    const record = last();
    expect(record).toMatchObject({ ok: false, step: 'chrome', text: SHOT.chromeFailed });
    expect(record?.chrome?.startsWith('Taking screenshots has been disabled by [url] xxx')).toBe(true);
    expect(record?.chrome).toHaveLength(CHROME_SAID_MAX);
  });
});

describe('v0.5.3: a capture Chrome never answers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails after 5 s with "Chrome did not answer", and the next shot is taken', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    w = setupWorker();
    await w.meetTab(7);
    const capture = w.chrome.tabs.captureVisibleTab.bind(w.chrome.tabs);
    w.chrome.tabs.captureVisibleTab = () => new Promise<string>(() => undefined);
    let answer: unknown;
    void shot(7).then((a) => (answer = a));
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ ok: false, text: SHOT.chromeFailed });
    expect(last()).toMatchObject({ ok: false, step: 'chrome', chrome: NO_CAPTURE_ANSWER });
    expect(w.daemon.calls).toEqual([]);
    // The queue is free again.
    w.chrome.tabs.captureVisibleTab = capture;
    expect(await shot(7)).toEqual({ ok: true, text: SHOT.saved });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('from the shortcut: the page gets its button back with the flash', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    w = setupWorker();
    await w.meetTab(7);
    w.chrome.tabs.captureVisibleTab = () => new Promise<string>(() => undefined);
    w.chrome.commands.onCommand.dispatch('take-screenshot', w.model.tab(7));
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    await vi.waitFor(() => expect(w.toPage(7)).toEqual([{ t: 'hide' }, { t: 'show', flash: SHOT.chromeFailed }]));
    expect(last()).toMatchObject({ from: 'command', step: 'chrome', chrome: NO_CAPTURE_ANSWER });
  });
});

describe('v0.5.3: one LastShot record for every try', () => {
  /** Run one try after `arrange`, and say what it answered and recorded. */
  async function tryOnce(arrange: (w: WorkerUnderTest) => unknown, from: 'page' | 'popup' | 'command' = 'page', tabId = 7) {
    w?.close();
    w = setupWorker();
    await w.meetTab(7, { title: `Weekly sync ${MEETING_MARKER}` });
    await arrange(w);
    const at = w.clock.t;
    let answer: unknown;
    if (from === 'page') answer = await shot(tabId);
    else if (from === 'popup') answer = await w.popup({ t: 'shot', tabId });
    else {
      w.chrome.commands.onCommand.dispatch('take-screenshot', w.model.tab(tabId));
      await expect.poll(() => last()).toBeDefined();
    }
    return { at, answer, record: last() };
  }

  /** The step, the flash, what makes the try end there, and what else the record holds. */
  type Case = [ShotStep, string, (u: WorkerUnderTest) => unknown, Partial<LastShot>];
  const cases: Case[] = [
    ['saved', SHOT.saved, () => undefined, {}],
    ['not-front', SHOT.openTabFirst, (u: WorkerUnderTest) => void u.model.addTab({ id: 9, windowId: 1, url: 'https://example.com/', active: true }), {}],
    ['grant', SHOT.allowHere, (u: WorkerUnderTest) => u.model.failCapture('permission'), { chrome: CAPTURE_PERMISSION_ERROR }],
    ['chrome', SHOT.chromeFailed, (u: WorkerUnderTest) => u.model.failCapture('Failed to capture tab: view is invisible'), { chrome: 'Failed to capture tab: view is invisible' }],
    ['too-large', SHOT.tooLarge, (u: WorkerUnderTest) => void (u.chrome.tabs.captureVisibleTab = async () => big), {}],
    ['down', SHOT.notRunning, (u: WorkerUnderTest) => u.daemon.on('open', 'down'), {}],
    ['daemon', `Not saved: ${'This meeting has 500 screenshots.'}`, (u: WorkerUnderTest) => u.daemon.on('shot', daemonError(409, 'This meeting has 500 screenshots.')), { status: 409 }],
    ['daemon', SHOT.notRunning, (u: WorkerUnderTest) => u.daemon.on('shot', daemonError(503, 'Meetings data could not be opened.')), { status: 503 }],
    ['daemon', MISMATCH, (u: WorkerUnderTest) => u.daemon.on('open', daemonError(400, 'bad')), { status: 400 }],
    ['unpaired', SHOT.pairAgain, (u: WorkerUnderTest) => u.daemon.on('open', daemonError(401, 'The Jantar extension is not paired.')), { status: 401 }],
    ['unpaired', SHOT.pairAgain, (u: WorkerUnderTest) => u.keys.clear(), {}],
  ];

  it.each(cases)('%s: "%s"', async (step, text, arrange, extra) => {
    const { at, answer, record } = await tryOnce(arrange);
    expect(answer).toEqual({ ok: step === 'saved', text });
    expect(record).toEqual({ at, from: 'page', tabId: 7, ok: step === 'saved', text, step, ...extra });
  });

  it('not-meeting and not-in-call, from the popup', async () => {
    let got = await tryOnce(() => undefined, 'popup', 99);
    expect(got.record).toEqual({ at: got.at, from: 'popup', tabId: 99, ok: false, text: SHOT.openTabFirst, step: 'not-meeting' });
    got = await tryOnce((u) => u.page(7, { t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync' }).then(() => undefined), 'popup');
    expect(got.record).toEqual({ at: got.at, from: 'popup', tabId: 7, ok: false, text: SHOT.joinFirst, step: 'not-in-call' });
  });

  it('the shortcut, saved', async () => {
    const got = await tryOnce(() => undefined, 'command');
    expect(got.record).toEqual({ at: got.at, from: 'command', tabId: 7, ok: true, text: SHOT.saved, step: 'saved' });
  });

  it('a try that fails in a way it never should keeps the words it failed with', async () => {
    const got = await tryOnce((u) => {
      u.keys.get = async () => {
        throw new Error('Extension context invalidated.');
      };
    });
    expect(got.answer).toEqual({ ok: false, text: SHOT.tryAgain });
    expect(got.record).toMatchObject({ ok: false, text: SHOT.tryAgain, step: 'chrome', chrome: 'Extension context invalidated.' });
  });

  it('the newest try replaces the one before; never a URL, a title or an image in it', async () => {
    w = setupWorker();
    w.model.captureImage = markerJpeg();
    await w.meetTab(7, { title: `Weekly sync ${MEETING_MARKER}` });
    await shot(7);
    w.model.failCapture('permission');
    await shot(7);
    expect(last()).toMatchObject({ step: 'grant' });
    const kept = JSON.stringify(last());
    for (const never of [MEETING_MARKER, 'base64', 'meet.google.com', 'Weekly sync']) expect(kept).not.toContain(never);
  });

  it('a storage that will not keep the record still answers', async () => {
    w = setupWorker();
    await w.meetTab(7);
    const set = w.chrome.storage.session.set.bind(w.chrome.storage.session);
    w.chrome.storage.session.set = async (items) => {
      if (LAST_SHOT_KEY in items) throw new Error('QUOTA_BYTES quota exceeded');
      return set(items);
    };
    expect(await shot(7)).toEqual({ ok: true, text: SHOT.saved });
    expect(last()).toBeUndefined();
  });
});
