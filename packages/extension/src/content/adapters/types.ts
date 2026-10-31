/**
 * What a site adapter gives the content script (spec 3.4), frozen for wave
 * 1. Selectors live only in adapters/meet.ts and adapters/teams.ts, each an
 * ordered list of candidates tried one at a time (never one comma-joined
 * selector), so a redesign that renames one hook falls back to the next.
 */
import type { MeetingSite } from '../../shared/sites.js';

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
  inCall(doc: Document): boolean;
  /** The page title for the Name field, cleaned; '' when it says nothing. */
  title(doc: Document): string;
  /** The caption region, re-found on every poll; null when absent. */
  region(doc: Document): Element | null;
  /** The region's speaker turns in DOM order; never reads inside button or [role=button] subtrees. */
  blocks(region: Element): Block[];
  /** How to turn captions on, in the site's own words; shown when no captions are on screen. */
  readonly howTo: string;
  /** The camera button's fixed position (CSS lengths), clear of the site's controls; checked on the real Mac (R6). */
  readonly spot: Readonly<{ left?: string; right?: string; top?: string; bottom?: string }>;
}
