/**
 * Screenshots (spec 3.8): `captureVisibleTab` of the meeting tab, JPEG at
 * quality 85, uploaded as the data URL it came as. The image never passes
 * through a content script, chrome.storage or a message.
 *
 * One queue for every tab: one capture at a time, at least shotGapMs apart
 * (Chrome allows two a second), and on the quota error one more try after
 * 600 ms. A capture Chrome does not answer within CAPTURE_TIMEOUT_MS counts
 * as failed, so it never holds the queue. The queue holds a shot only until
 * its capture is done; its upload then goes on beside the next capture, one
 * meeting step per tab at a time (tabs.serial keeps a tab's uploads in click
 * order). In this order:
 * 1. The tab is a meeting tab in a call ("join the call first"), the active
 *    tab of its window and still on a meeting page ("open the meeting tab
 *    first"). captureVisibleTab shoots whatever is in front of the window,
 *    so this is checked again right before every capture call (after each
 *    wait: the gap, the quota retry, the smaller retake) and right after
 *    it, and an image taken while another tab came to the front is dropped:
 *    nothing else is ever captured (MX2).
 * 2. Capture first, so a failed capture makes no meeting.
 * 3. The tab's meeting, opened with `captions: false` when it has none (a
 *    screenshot before Start still saves; M4).
 * 4. The upload with a fresh key. A 404 (the meeting ended or was deleted)
 *    opens a new meeting and uploads once more: the button never blocks.
 *
 * From the page button the page hides itself first. From the shortcut or
 * the popup the worker asks the page to hide (300 ms at most), shoots, and
 * asks it to show again with the answer as its flash; from the popup it
 * first waits 150 ms for the popup to close.
 *
 * v0.5.3: every try ends with one LastShot record in chrome.storage.session
 * (`lastShot`): where it came from, the step it ended at, Chrome's own words
 * when Chrome refused (cut to 200 characters, web addresses taken out) and
 * the daemon's status when it refused. Never a URL, a title or an image. The
 * popup's Settings shows it, so the next real call says why a screenshot
 * was not saved.
 */
import type { LastShot, ShotAnswer, ShotFrom, ShotStep } from '../shared/messages.js';
import { MEETING_SHOT_MAX_BYTES, TIMING } from '../shared/wire.js';
import { onMeetingPage } from './accept.js';
import type { Reply } from './client.js';
import { cleanText, type Ctx } from './ctx.js';
import { defaultName, type Meetings } from './meetings.js';
import { MISMATCH, NOT_OPEN, SHOT, notSaved } from './sentences.js';

export type { ShotFrom } from '../shared/messages.js';

export const SHOT_QUALITY = 85;
/** A second try when the first is over MEETING_SHOT_MAX_BYTES. */
export const SHOT_QUALITY_SMALLER = 60;
/** After Chrome's two-a-second quota error. */
export const QUOTA_WAIT_MS = 600;
/** The popup closes itself first; this long for it to go. */
export const POPUP_CLOSE_MS = 150;
/** How long the page has to hide its button. */
export const HIDE_WAIT_MS = 300;
/** How long Chrome has to answer one captureVisibleTab call. */
export const CAPTURE_TIMEOUT_MS = 5_000;
/** The raw words for a capture Chrome never answered. */
export const NO_CAPTURE_ANSWER = 'Chrome did not answer';
/** Chrome's own message is kept to this many characters. */
export const CHROME_SAID_MAX = 200;
/** The chrome.storage.session key of the last try. */
export const LAST_SHOT_KEY = 'lastShot';

const JPEG_DATA_URL = 'data:image/jpeg;base64,';

/** The decoded size of a base64 data URL. */
export function dataUrlBytes(url: string): number {
  const b64 = url.slice(url.indexOf(',') + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Chrome's message as it came, on one line, with any web or data address taken out, cut to CHROME_SAID_MAX. */
export function chromeSaid(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const said = cleanText(message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*|\bdata:\S+/gi, '[url]'), CHROME_SAID_MAX);
  return said || 'no message';
}

/** How a try ended: the flash, and what the LastShot record keeps. */
type Outcome = ShotAnswer & { step: ShotStep; chrome?: string; status?: number };

/** What a capture error means to the user. */
function captureFailed(err: unknown): Outcome {
  const message = err instanceof Error ? err.message : String(err);
  const chrome = chromeSaid(err);
  // "Either the '<all_urls>' or 'activeTab' permission is required.": no grant in this tab yet (D1).
  if (/permission/i.test(message)) return { ok: false, text: SHOT.allowHere, step: 'grant', chrome };
  return { ok: false, text: SHOT.chromeFailed, step: 'chrome', chrome };
}

const isQuota = (err: unknown) => /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(err instanceof Error ? err.message : String(err));

/** The flash for an upload or open that was not 2xx. */
function shotError(reply: Reply): Outcome {
  switch (reply.kind) {
    case 'ok':
      // Never: a 2xx is a saved shot or an opened meeting.
      return { ok: false, text: SHOT.tryAgain, step: 'daemon', status: reply.status };
    case 'down':
      return { ok: false, text: SHOT.notRunning, step: 'down' };
    case 'unpaired':
      // forgotten: Jantar answered 401 just now.
      return { ok: false, text: SHOT.pairAgain, step: 'unpaired', ...(reply.forgotten ? { status: 401 } : {}) };
    case 'error': {
      const status = reply.status;
      if (status === 400) return { ok: false, text: MISMATCH, step: 'daemon', status };
      if (status >= 500) return { ok: false, text: SHOT.notRunning, step: 'daemon', status };
      // 403 (Meetings off), 409 (a cap), 413, 429 (the day's budget): the daemon's own sentence.
      return { ok: false, text: notSaved(reply.sentence), step: 'daemon', status };
    }
  }
}

const FROM = new Set<string>(['page', 'popup', 'command']);
const STEPS = new Set<string>(['saved', 'unpaired', 'not-meeting', 'not-in-call', 'not-front', 'grant', 'chrome', 'too-large', 'down', 'daemon']);

function isLastShot(v: unknown): v is LastShot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.at === 'number' && typeof s.from === 'string' && FROM.has(s.from) && typeof s.tabId === 'number' &&
    typeof s.ok === 'boolean' && typeof s.text === 'string' && typeof s.step === 'string' && STEPS.has(s.step) &&
    (s.chrome === undefined || typeof s.chrome === 'string') && (s.status === undefined || typeof s.status === 'number')
  );
}

/** The last screenshot try in any tab, or null before the first (or when storage cannot be read). */
export async function readLastShot(): Promise<LastShot | null> {
  try {
    const got = await chrome.storage.session.get(LAST_SHOT_KEY);
    const v = got[LAST_SHOT_KEY];
    return isLastShot(v) ? v : null;
  } catch {
    return null;
  }
}

/** Keep the try's record; a storage that fails loses it, never the answer. */
async function remember(record: LastShot): Promise<void> {
  try {
    await chrome.storage.session.set({ [LAST_SHOT_KEY]: record });
  } catch {
    // The flash still says what happened.
  }
}

/** captureVisibleTab, or the NO_CAPTURE_ANSWER error after CAPTURE_TIMEOUT_MS. */
async function captureInTime(windowId: number, quality: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(NO_CAPTURE_ANSWER)), CAPTURE_TIMEOUT_MS);
    });
    return await Promise.race([chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality }), late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Shots {
  take(tabId: number, from: ShotFrom): Promise<ShotAnswer>;
}

/** A capture, or how the try ended without one. */
type Captured = { image: string } | Outcome;

export function createShots(ctx: Ctx, meetings: Meetings): Shots {
  let queue: Promise<unknown> = Promise.resolve();
  let lastCapture = Number.NEGATIVE_INFINITY;

  /** The tab's window id while the tab is the active one there and still on a meeting page; else null. */
  async function front(tabId: number): Promise<number | null> {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.active && onMeetingPage(tab) ? tab.windowId : null;
    } catch {
      return null;
    }
  }

  /** One captureVisibleTab of the window, only while the tab is in front there: null when it is not, before or after. */
  async function frontShot(tabId: number, windowId: number, quality: number): Promise<string | null> {
    if ((await front(tabId)) !== windowId) return null;
    lastCapture = ctx.now();
    const image = await captureInTime(windowId, quality);
    // Another tab may have come to the front while Chrome took it: then the image may be that tab.
    return (await front(tabId)) === windowId ? image : null;
  }

  async function grab(tabId: number, windowId: number, quality: number): Promise<string | null> {
    const wait = lastCapture + TIMING.shotGapMs - ctx.now();
    if (wait > 0) await ctx.sleep(wait);
    try {
      return await frontShot(tabId, windowId, quality);
    } catch (err) {
      if (!isQuota(err)) throw err;
      await ctx.sleep(QUOTA_WAIT_MS);
      return await frontShot(tabId, windowId, quality);
    }
  }

  /** The capture, or how the try ended without one. */
  async function capture(tabId: number, windowId: number): Promise<Captured> {
    try {
      let image = await grab(tabId, windowId, SHOT_QUALITY);
      if (image !== null && dataUrlBytes(image) > MEETING_SHOT_MAX_BYTES) image = await grab(tabId, windowId, SHOT_QUALITY_SMALLER);
      if (image === null) return { ok: false, text: SHOT.openTabFirst, step: 'not-front' };
      if (!image.startsWith(JPEG_DATA_URL)) return { ok: false, text: SHOT.chromeFailed, step: 'chrome' };
      if (dataUrlBytes(image) > MEETING_SHOT_MAX_BYTES) return { ok: false, text: SHOT.tooLarge, step: 'too-large' };
      return { image };
    } catch (err) {
      return captureFailed(err);
    }
  }

  /** Steps 3 and 4, one meeting step for the tab at a time. */
  function save(tabId: number, image: string, at: number): Promise<Outcome> {
    return ctx.tabs.serial(tabId, async (): Promise<Outcome> => {
      const key = ctx.uuid();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = await ctx.tabs.read(tabId);
        // The tab's record went meanwhile (the tab closed or left the call).
        if (!state) return { ok: false, text: SHOT.joinFirst, step: 'not-in-call' };
        let clientId = state.clientId;
        if (!clientId) {
          const opened = await meetings.open(tabId, state, { name: defaultName(state), autoTodos: false, captions: false });
          if (!opened.ok) return shotError(opened.reply);
          clientId = opened.clientId;
        }
        const reply = await ctx.client.call('shot', { clientId, body: { key, at, image } });
        if (reply.kind === 'ok') {
          const id = clientId;
          await ctx.tabs.patch(tabId, (cur) => (cur && cur.clientId === id ? { ...cur, shots: cur.shots + 1 } : cur));
          return { ok: true, text: SHOT.saved, step: 'saved' };
        }
        if (reply.kind === 'error' && reply.status === 404 && attempt === 0) {
          // The meeting ended or was deleted: a new one for this call, and the same shot once more.
          await meetings.lost(tabId, clientId, reply.sentence || NOT_OPEN);
          continue;
        }
        return shotError(reply);
      }
      return { ok: false, text: SHOT.tryAgain, step: 'daemon' };
    });
  }

  /** Steps 1 and 2: the checks, the page's button out of the way, the capture. */
  async function shoot(tabId: number, from: ShotFrom): Promise<Captured> {
    if ((await ctx.keys.get()) === null) return { ok: false, text: SHOT.pairAgain, step: 'unpaired' };
    const state = await ctx.tabs.read(tabId);
    // A tab with no record is not a meeting tab (the popup or the shortcut named another tab).
    if (!state) return { ok: false, text: SHOT.openTabFirst, step: 'not-meeting' };
    if (!state.inCall) return { ok: false, text: SHOT.joinFirst, step: 'not-in-call' };
    const windowId = await front(tabId);
    if (windowId === null) return { ok: false, text: SHOT.openTabFirst, step: 'not-front' };
    if (from === 'popup') await ctx.sleep(POPUP_CLOSE_MS);
    if (from !== 'page') await Promise.race([ctx.toTab(tabId, { t: 'hide' }), ctx.sleep(HIDE_WAIT_MS)]);
    return capture(tabId, windowId);
  }

  return {
    take(tabId, from) {
      const at = ctx.now();
      // Inside the queue: the capture, and the upload started (so a tab's uploads keep click order). After it: the upload's answer.
      const captured = queue.then(async () => {
        const shot = await shoot(tabId, from);
        return { saving: 'image' in shot ? save(tabId, shot.image, at) : Promise.resolve(shot) };
      });
      queue = captured.catch(() => undefined);
      return (async () => {
        let outcome: Outcome;
        try {
          outcome = await (await captured).saving;
        } catch (err) {
          // Never expected: a Chrome API (storage, the key store) failed under the worker. Its words are kept.
          outcome = { ok: false, text: SHOT.tryAgain, step: 'chrome', chrome: chromeSaid(err) };
        }
        const { ok, text, step, chrome: said, status } = outcome;
        await remember({ at, from, tabId, ok, text, step, ...(said ? { chrome: said } : {}), ...(status !== undefined ? { status } : {}) });
        const answer: ShotAnswer = { ok, text };
        if (from !== 'page') await ctx.toTab(tabId, { t: 'show', flash: answer.text });
        return answer;
      })();
    },
  };
}
