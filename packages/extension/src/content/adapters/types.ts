/**
 * What a site adapter gives the content script (spec 3.4), frozen for wave
 * 1. Selectors live only in adapters/meet.ts and adapters/teams.ts, each an
 * ordered list of candidates tried one at a time (never one comma-joined
 * selector), so a redesign that renames one hook falls back to the next.
 *
 * v0.10: `inCallHook` names the in-call control that matched, and `waiting`
 * says whether the page shows the call's join screen or its waiting room,
 * each by a fixed hook id. Both read fixed attributes, Meet's icon ligature
 * and the URL's path and query only: never caption text or names, never
 * `region()` or `blocks()`, and no observer (MP6).
 */
import type { CallStage, CaptionsClient } from '../../shared/messages.js';
import type { MeetingSite } from '../../shared/sites.js';

export type { CallStage };
/** One fixed id from an adapter's own lists ("meet:call_end"), never page text. */
export type HookId = string;

/** v0.10: the join screen or the waiting room, with the hook that said so. `strong`: a real hook matched, not the URL alone. */
export interface Waiting {
  stage: 'prejoin' | 'lobby';
  hook: HookId;
  strong: boolean;
}

/** v0.10: the page's own memory for `waiting`: the URL (path, query and hash, in memory only) where this page last saw a join hook. */
export interface WaitingSeen {
  joinHookAt: string | null;
}

/** v0.10: whether the call's own captions are on, by a fixed control or the caption region (`hook` says which), never caption text. */
export interface CcState {
  state: 'on' | 'off' | 'unknown';
  hook: HookId;
}

/**
 * v0.10: one try to switch captions on: they were on (`on`), a control was
 * clicked or a key pressed (`clicked`), there was nothing to click (`none`:
 * maybe not drawn yet), the site's menu opened and holds no captions
 * (`unavailable`: the organizer's policy; no more tries), or a menu of the
 * site's was already open (`busy`: the user is in it).
 */
export interface CcStep {
  result: 'on' | 'clicked' | 'none' | 'unavailable' | 'busy';
  hook: HookId;
}

/** v0.10: what a try may use: a wait on the page's own clock, and which try this is (1 first). */
export interface CcTry {
  wait(ms: number): Promise<void>;
  attempt: number;
}

/**
 * v0.10: the call's own captions control (research captions-research.md
 * 6.2). Only ever used after notes start (MP6): it reads the control's
 * state first and clicks only a control that says off (on Teams, also a
 * captions item that says nothing, when nothing on the page said on),
 * closes any menu it opened, and never turns captions off.
 */
export interface CaptionsControl {
  state(doc: Document): CcState;
  turnOn(doc: Document, t: CcTry): Promise<CcStep>;
  /** Whose way to turn captions on the page should name. */
  client(doc: Document): CaptionsClient;
}

/** One speaker turn in the caption region, in DOM order. `text` comes from the leaf's textContent, whitespace collapsed. */
export interface Block {
  el: Element;
  speaker: string | null;
  text: string;
}

export interface SiteAdapter {
  site: MeetingSite;
  /** Meet's code from the path (both /abc-defg-hij and /meet/abc-defg-hij); Teams: null (the tab is the call). */
  callKey(loc: Location): string | null;
  /** In a call: `inCallHook(doc) !== null`. */
  inCall(doc: Document): boolean;
  /** v0.10: the in-call hook that matched, or null. */
  inCallHook(doc: Document): HookId | null;
  /** v0.10: not in a call: the join screen or the waiting room, or null for neither. */
  waiting(doc: Document, seen: WaitingSeen): Waiting | null;
  /** The page title for the Name field, cleaned; '' when it says nothing. */
  title(doc: Document): string;
  /** The caption region, re-found on every poll; null when absent. */
  region(doc: Document): Element | null;
  /** The region's speaker turns in DOM order; never reads inside button or [role=button] subtrees. */
  blocks(region: Element): Block[];
  /** v0.10: the call's own captions control (it replaces v0.5's `howTo`: shared/captions.ts words the way to turn them on per client). */
  readonly cc: CaptionsControl;
  /** The camera button's fixed position (CSS lengths), clear of the site's controls; checked on the real Mac (R6). */
  readonly spot: Readonly<{ left?: string; right?: string; top?: string; bottom?: string }>;
}
