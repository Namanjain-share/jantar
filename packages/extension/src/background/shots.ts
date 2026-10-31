/**
 * Screenshots (spec 3.8): `captureVisibleTab` of the meeting tab, JPEG at
 * quality 85, uploaded as the data URL it came as. The image never passes
 * through a content script, chrome.storage or a message.
 *
 * One queue for every tab: one capture at a time, at least shotGapMs apart
 * (Chrome allows two a second), and on the quota error one more try after
 * 600 ms. The queue holds a shot only until its capture is done; its upload
 * then goes on beside the next capture, one meeting step per tab at a time
 * (tabs.serial keeps a tab's uploads in click order). In this order:
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
 */
import type { ShotAnswer } from '../shared/messages.js';
import { MEETING_SHOT_MAX_BYTES, TIMING } from '../shared/wire.js';
import { onMeetingPage } from './accept.js';
import type { Reply } from './client.js';
import type { Ctx } from './ctx.js';
import { defaultName, type Meetings } from './meetings.js';
import { MISMATCH, NOT_OPEN, SHOT, notSaved } from './sentences.js';

export type ShotFrom = 'page' | 'popup' | 'command';

export const SHOT_QUALITY = 85;
/** A second try when the first is over MEETING_SHOT_MAX_BYTES. */
export const SHOT_QUALITY_SMALLER = 60;
/** After Chrome's two-a-second quota error. */
export const QUOTA_WAIT_MS = 600;
/** The popup closes itself first; this long for it to go. */
export const POPUP_CLOSE_MS = 150;
/** How long the page has to hide its button. */
export const HIDE_WAIT_MS = 300;

const JPEG_DATA_URL = 'data:image/jpeg;base64,';

/** The decoded size of a base64 data URL. */
export function dataUrlBytes(url: string): number {
  const b64 = url.slice(url.indexOf(',') + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** What a capture error means to the user. */
function captureError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // "Either the '<all_urls>' or 'activeTab' permission is required.": no grant in this tab yet (D1).
  return /permission/i.test(message) ? SHOT.allowHere : SHOT.chromeFailed;
}

const isQuota = (err: unknown) => /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(err instanceof Error ? err.message : String(err));

/** The flash for an upload or open that was not 2xx. */
function shotError(reply: Reply): string {
  switch (reply.kind) {
    case 'ok':
      return SHOT.saved;
    case 'down':
      return SHOT.notRunning;
    case 'unpaired':
      return SHOT.pairAgain;
    case 'error':
      if (reply.status === 400) return MISMATCH;
      if (reply.status >= 500) return SHOT.notRunning;
      // 403 (Meetings off), 409 (a cap), 413, 429 (the day's budget): the daemon's own sentence.
      return notSaved(reply.sentence);
  }
}

export interface Shots {
  take(tabId: number, from: ShotFrom): Promise<ShotAnswer>;
}

/** A capture, or the answer saying why there is none. */
type Captured = { image: string } | ShotAnswer;

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
    const image = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality });
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

  /** The capture, or the sentence saying why there is none. */
  async function capture(tabId: number, windowId: number): Promise<Captured> {
    try {
      let image = await grab(tabId, windowId, SHOT_QUALITY);
      if (image !== null && dataUrlBytes(image) > MEETING_SHOT_MAX_BYTES) image = await grab(tabId, windowId, SHOT_QUALITY_SMALLER);
      if (image === null) return { ok: false, text: SHOT.openTabFirst };
      if (!image.startsWith(JPEG_DATA_URL)) return { ok: false, text: SHOT.chromeFailed };
      if (dataUrlBytes(image) > MEETING_SHOT_MAX_BYTES) return { ok: false, text: SHOT.tooLarge };
      return { image };
    } catch (err) {
      return { ok: false, text: captureError(err) };
    }
  }

  /** Steps 3 and 4, one meeting step for the tab at a time. */
  function save(tabId: number, image: string, at: number): Promise<ShotAnswer> {
    return ctx.tabs.serial(tabId, async () => {
      const key = ctx.uuid();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = await ctx.tabs.read(tabId);
        if (!state) return { ok: false, text: SHOT.joinFirst };
        let clientId = state.clientId;
        if (!clientId) {
          const opened = await meetings.open(tabId, state, { name: defaultName(state), autoTodos: false, captions: false });
          if (!opened.ok) return { ok: false, text: shotError(opened.reply) };
          clientId = opened.clientId;
        }
        const reply = await ctx.client.call('shot', { clientId, body: { key, at, image } });
        if (reply.kind === 'ok') {
          const id = clientId;
          await ctx.tabs.patch(tabId, (cur) => (cur && cur.clientId === id ? { ...cur, shots: cur.shots + 1 } : cur));
          return { ok: true, text: SHOT.saved };
        }
        if (reply.kind === 'error' && reply.status === 404 && attempt === 0) {
          // The meeting ended or was deleted: a new one for this call, and the same shot once more.
          await meetings.lost(tabId, clientId, reply.sentence || NOT_OPEN);
          continue;
        }
        return { ok: false, text: shotError(reply) };
      }
      return { ok: false, text: SHOT.tryAgain };
    });
  }

  /** Steps 1 and 2: the checks, the page's button out of the way, the capture. */
  async function shoot(tabId: number, from: ShotFrom): Promise<Captured> {
    if ((await ctx.keys.get()) === null) return { ok: false, text: SHOT.pairAgain };
    const state = await ctx.tabs.read(tabId);
    // A tab with no record is not a meeting tab (the popup or the shortcut named another tab).
    if (!state) return { ok: false, text: SHOT.openTabFirst };
    if (!state.inCall) return { ok: false, text: SHOT.joinFirst };
    const windowId = await front(tabId);
    if (windowId === null) return { ok: false, text: SHOT.openTabFirst };
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
        let answer: ShotAnswer;
        try {
          answer = await (await captured).saving;
        } catch {
          answer = { ok: false, text: SHOT.tryAgain };
        }
        if (from !== 'page') await ctx.toTab(tabId, { t: 'show', flash: answer.text });
        return answer;
      })();
    },
  };
}
