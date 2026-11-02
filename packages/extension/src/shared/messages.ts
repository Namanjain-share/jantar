/**
 * Every message between the page (content script), the service worker and
 * the popup (spec 3.3), frozen for wave 1. Each is a plain object with a
 * `t` field; an unknown `t` is ignored. The worker is the only one that
 * talks to the daemon, from a fixed table of routes: a page or the popup
 * never names a path or a URL, and a page never names a tab (its tab is
 * `sender.tab.id`).
 */
import type { LineUpsert } from '@jantar/protocol';
import type { MeetingSite } from './sites.js';

/** What the page knows about the captions on screen. */
export type CaptionsState = 'reading' | 'none' | 'notFound';

/**
 * v0.10: what the page shows, as the page's call watch judges it from fixed
 * controls only: no join screen or call (`none`), the call's join screen
 * (`prejoin`), its waiting room (`lobby`), the call (`in`), or this page left
 * the call (`left`).
 */
export type CallStage = 'none' | 'prejoin' | 'lobby' | 'in' | 'left';

// ---------------------------------------------------------------------------
// content script -> worker (chrome.runtime.sendMessage)

export type FromPage =
  /**
   * Answered with CallAnswer. `left`: the 60-s grace ran out (the worker ends the meeting).
   * v0.10: `stage`, the page's stable stage, and `hook`, the fixed hook id that decided it (never page text).
   */
  | { t: 'call'; site: MeetingSite; inCall: boolean; left?: true; callKey: string | null; title: string; stage?: CallStage; hook?: string }
  /** At most 200, the newest revision per lineId. Answered with LinesAnswer. */
  | { t: 'lines'; lines: LineUpsert[] }
  | { t: 'captions'; state: CaptionsState }
  /** The page button, a trusted click. Answered with ShotAnswer. */
  | { t: 'shot' };

/** button: the extension is paired (mount the camera button); notes: this tab's meeting reads captions. */
export type CallAnswer = { button: boolean; notes: boolean };
/** retry: Jantar did not answer (keep the lines, try again); else notes stop, with `text` in the bubble. */
export type LinesAnswer = { ok: true } | { ok: false; retry: boolean; text?: string };
/** The flash: "Saved", or "Not saved: …". */
export type ShotAnswer = { ok: boolean; text: string };

// ---------------------------------------------------------------------------
// worker -> content script (chrome.tabs.sendMessage)

export type ToPage =
  /**
   * Start or stop reading captions, and the notes-on dot; `text`: a bubble saying why they stopped.
   * v0.10: `text` with `on: true` is the bubble shown once notes started by themselves.
   */
  | { t: 'capture'; on: boolean; text?: string }
  /** After pairing, unpairing or a 401. */
  | { t: 'button'; on: boolean }
  /** Hide the camera button; answered { ok: true } after two animation frames. */
  | { t: 'hide' }
  | { t: 'show'; flash?: string };

// ---------------------------------------------------------------------------
// popup -> worker (chrome.runtime.sendMessage)

export type FromPopup =
  /** Answered with PopupState. */
  | { t: 'state'; tabId: number }
  /** The pasted "jantar-ext:<port>:<code>". Answered with Done. */
  | { t: 'pair'; text: string }
  | { t: 'unpair' }
  | { t: 'start'; tabId: number; name: string; projectId?: string; people?: string; autoTodos: boolean }
  /** Answered with ShotAnswer. */
  | { t: 'shot'; tabId: number }
  | { t: 'end'; tabId: number }
  /** v0.8: Read saved links on or off (the popup asked Chrome for the post sites first). Answered with Done. */
  | { t: 'reads'; on: boolean }
  /** v0.10: Start when I join, with the sheet's fields (`name` '': the page's title then). Done; starts now when the tab is already in the call. */
  | { t: 'arm'; tabId: number; name: string; projectId?: string; people?: string; autoTodos: boolean }
  /** v0.10: Cancel, or Not this call for an Always arm. Done. */
  | { t: 'disarm'; tabId: number }
  /** v0.10: Settings › Always start when I join a call. Done. */
  | { t: 'always'; on: boolean };

export type Done = { ok: boolean; error?: string };

/** v0.10: a tab's live Start when I join, as the popup shows it. `off`: Not this call (Always skips this call). */
export interface ArmView {
  from: 'popup' | 'always';
  off: boolean;
  name: string;
  projectId?: string;
  people?: string;
  autoTodos: boolean;
  until: number;
}

/** v0.10: the last time notes started by themselves in a tab, or why they did not (`text`). */
export interface AutoStart {
  at: number;
  ok: boolean;
  text?: string;
}

/** v0.5.3: which control asked for a screenshot: the page's camera button, the popup, or the shortcut. */
export type ShotFrom = 'page' | 'popup' | 'command';
/** v0.5.3: where a screenshot try ended (`saved`, or the step that stopped it). */
export type ShotStep = 'saved' | 'unpaired' | 'not-meeting' | 'not-in-call' | 'not-front' | 'grant' | 'chrome' | 'too-large' | 'down' | 'daemon';
/**
 * v0.5.3: the last screenshot try, one record for every take (kept in
 * chrome.storage.session), so the popup can say why one was not saved.
 * `text` is the flash the bubble showed; `chrome` Chrome's own error
 * message, cut to 200 characters; `status` the daemon's HTTP status. Never a
 * URL, a title or an image.
 */
export interface LastShot {
  at: number;
  from: ShotFrom;
  tabId: number;
  ok: boolean;
  text: string;
  step: ShotStep;
  chrome?: string;
  status?: number;
}

export interface PopupState {
  connection: 'ok' | 'down' | 'off' | 'unpaired';
  /** The daemon's sentence for 'off' and the problem states. */
  sentence?: string;
  /** `<all_urls>` is granted (D1): the page button works without a toolbar click. */
  pageButton: boolean;
  /** null: Todos are off (the sheet hides Project). */
  projects: { id: string; name: string; emoji?: string }[] | null;
  tab: null | {
    site: MeetingSite;
    inCall: boolean;
    title: string;
    name?: string;
    notes: boolean;
    shots: number;
    captions: CaptionsState | 'unknown';
    /** v0.10: what the page last said it shows, and the hook id that decided it ('' when none). */
    stage: CallStage;
    hook: string;
    /** v0.10: Start when I join, live arms only. */
    arm: ArmView | null;
    /** v0.10: the last start by itself: started, or failed in the last ARM_TIMING.failedShowMs. */
    auto: AutoStart | null;
  };
  /** v0.5.3: the last screenshot try in any tab (Settings › Last screenshot); null before the first. */
  lastShot: LastShot | null;
  /** v0.5.3: the take-screenshot shortcut as Chrome shows it ("⌥⇧S"), '' when unset. */
  shortcut: string;
  /** v0.8: Read saved links is on (switched on here, and Chrome allows the post sites). */
  reads: boolean;
  /** v0.10: Always start when I join a call. */
  always: boolean;
}
