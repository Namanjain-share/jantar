/**
 * The content script's entry (content.js, a classic script on the four
 * meeting hosts; spec 3.6 to 3.8). It picks the site's adapter by hostname
 * and wires three parts to the worker:
 *
 * - the call watch (call.ts), which polls whether a call is on and tells the
 *   worker; its answers say whether the extension is paired (the camera
 *   button shows only then, and only in a call) and whether this tab's
 *   meeting has notes on. Notes on in the first answer since the page
 *   loaded is a reload: they resume once the call is on again (not in the
 *   waiting room). Later answers never start notes (the page may have
 *   stopped them itself); notes off in one stops them. An answer to a
 *   `call` sent before the worker's last `capture` message is out of date
 *   on notes and changes nothing there;
 * - the capture loop (capture.ts), on only between `capture {on: true}` and
 *   `capture {on: false}`: nothing is read from the page before Start;
 * - the camera button and its bubble (button.ts).
 *
 * The page answers only the worker's messages (`capture`, `button`, `hide`,
 * `show`) and only from this extension; its own `FromPage` messages, which a
 * test's chrome reaches it with, and unknown `t` are ignored. After the
 * extension is reloaded the context is dead: everything stops and the
 * bubble says to reload the page.
 */
import type { CallAnswer, LinesAnswer, ShotAnswer, ToPage } from '../shared/messages.js';
import { siteOf, type MeetingSite } from '../shared/sites.js';
import { meetAdapter } from './adapters/meet.js';
import { teamsAdapter } from './adapters/teams.js';
import type { SiteAdapter } from './adapters/types.js';
import { createCameraButton, type CameraButton } from './button.js';
import { createCallWatch, type CallWatch } from './call.js';
import { createCapture, type Capture } from './capture.js';
import { contextGone, createPageRuntime } from './runtime.js';

export const RELOAD = 'Jantar was updated. Reload this page to keep notes.';

export interface ContentOptions {
  /** The site's adapter (default: by the page's hostname; none on any other host). */
  adapter?: SiteAdapter;
  doc?: Document;
  /** A fresh nonce per notes start (tests pass their own). */
  nonce?: () => string;
}

export interface Content {
  readonly call: CallWatch;
  readonly capture: Capture;
  readonly button: CameraButton;
  /** Everything off, listeners removed, the host gone (tests). */
  stop(): void;
}

type Respond = (answer?: unknown) => void;

export function startContent(opts: ContentOptions = {}): Content | null {
  const doc = opts.doc ?? (typeof document === 'undefined' ? undefined : document);
  if (!doc) return null;
  const adapter = opts.adapter ?? adapterFor(doc.location?.hostname ?? '');
  if (!adapter) return null;

  let paired = false;
  /** Bumped by every `capture` message from the worker. */
  let heard = 0;
  /** What `heard` was when each answer's `call` went. */
  const askedAt = new WeakMap<CallAnswer, number>();
  /** No call answer has come since the page loaded. */
  let first = true;
  /** The first answer had notes on: they resume once the call is on. */
  let resume = false;

  const rt = createPageRuntime(() => {
    // The extension was reloaded: this page's chrome is gone for good.
    call.stop();
    void capture.stop();
    button.setNotes(false);
    button.setShown(false);
    if (paired) button.bubble(RELOAD);
    removeListeners();
  });

  const button = createCameraButton({
    doc,
    spot: adapter.spot,
    shoot: async () => {
      const answer = shotAnswer(await rt.send({ t: 'shot' }));
      // The click found the extension reloaded: the reload sentence, not "did not answer" over it.
      return rt.dead ? { ok: false, text: RELOAD } : answer;
    },
  });

  const capture = createCapture({
    adapter,
    doc,
    send: async (msg) => linesAnswer(await rt.send(msg)),
    captions: (state) => void rt.send({ t: 'captions', state }),
    bubble: (text) => button.bubble(text),
    onStop: () => button.setNotes(false),
    nonce: opts.nonce,
  });

  const sync = () => button.setShown(paired && !rt.dead && call.phase() !== 'out');

  const notesOn = () => {
    if (rt.dead) return;
    resume = false;
    if (!capture.on) capture.start();
    button.setNotes(true);
  };

  const resumeInCall = () => {
    if (resume && call.phase() === 'in') notesOn();
  };

  const call = createCallWatch({
    adapter,
    doc,
    send: async (msg) => {
      const asked = heard;
      const answer = callAnswer(await rt.send(msg));
      if (answer) askedAt.set(answer, asked);
      return answer;
    },
    onAnswer: (answer) => {
      paired = answer.button;
      sync();
      if (askedAt.get(answer) === heard) {
        if (!answer.notes) {
          // The worker has no notes for this tab (its `capture` off may have been lost): reading on would only be refused.
          resume = false;
          if (capture.on) {
            button.setNotes(false);
            void capture.stop();
          }
        } else if (first) resume = true;
      }
      first = false;
      resumeInCall();
    },
    onPhase: () => {
      sync();
      resumeInCall();
    },
  });

  const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender, respond: Respond): boolean | undefined => {
    if (rt.dead) return undefined;
    if (contextGone()) {
      rt.kill();
      return undefined;
    }
    if (!sender || sender.id !== chrome.runtime.id) return undefined;
    const m = toPage(msg);
    if (!m) return undefined;
    switch (m.t) {
      case 'button':
        paired = m.on;
        sync();
        respond({ ok: true });
        return undefined;
      case 'capture':
        heard += 1;
        resume = false;
        if (m.on) {
          notesOn();
          respond({ ok: true });
          return undefined;
        }
        // End or a leave closes the lines and sends what waits before answering; a stop with a reason drops them.
        button.setNotes(false);
        void capture.stop({ final: !m.text, text: m.text }).then(() => respond({ ok: true }));
        return true;
      case 'hide':
        void button.hide().then(() => respond({ ok: true }));
        return true;
      case 'show':
        button.show(m.flash);
        respond({ ok: true });
        return undefined;
    }
  };

  const onPageHide = () => capture.last();

  const removeListeners = () => {
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // A dead context cannot remove it; it ignores everything anyway.
    }
    doc.defaultView?.removeEventListener('pagehide', onPageHide);
  };

  try {
    chrome.runtime.onMessage.addListener(onMessage);
  } catch {
    return null;
  }
  doc.defaultView?.addEventListener('pagehide', onPageHide);
  call.start();

  return {
    call,
    capture,
    button,
    stop() {
      call.stop();
      void capture.stop();
      button.remove();
      removeListeners();
    },
  };
}

/** The adapter per site; shared/sites.ts's siteOf says which site a host is. */
export const SITE_ADAPTERS: Readonly<Record<MeetingSite, SiteAdapter>> = Object.freeze({ meet: meetAdapter, teams: teamsAdapter });

function adapterFor(hostname: string): SiteAdapter | null {
  const site = siteOf(hostname);
  return site ? SITE_ADAPTERS[site] : null;
}

/** A worker message for the page, or null (the page's own messages, unknown `t`). */
function toPage(msg: unknown): ToPage | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  switch (m.t) {
    case 'capture':
      return { t: 'capture', on: m.on === true, text: typeof m.text === 'string' && m.text ? m.text : undefined };
    case 'button':
      return { t: 'button', on: m.on === true };
    case 'hide':
      return { t: 'hide' };
    case 'show':
      return { t: 'show', flash: typeof m.flash === 'string' && m.flash ? m.flash : undefined };
    default:
      return null;
  }
}

function callAnswer(a: unknown): CallAnswer | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const m = a as Record<string, unknown>;
  return { button: m.button === true, notes: m.notes === true };
}

function linesAnswer(a: unknown): LinesAnswer | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const m = a as Record<string, unknown>;
  if (m.ok === true) return { ok: true };
  if (m.ok === false) return { ok: false, retry: m.retry === true, text: typeof m.text === 'string' ? m.text : undefined };
  return undefined;
}

function shotAnswer(a: unknown): ShotAnswer | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const m = a as Record<string, unknown>;
  return typeof m.text === 'string' ? { ok: m.ok === true, text: m.text } : undefined;
}

startContent();
