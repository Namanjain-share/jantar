/**
 * Microsoft Teams on the web (teams.cloud.microsoft, teams.microsoft.com,
 * teams.live.com; spec 3.4). Teams marks its UI with `data-tid` attributes,
 * English and not localized, which changed in the October 2026 redesign:
 * the candidates cover the 2026 renderer wrapper, the v2 window wrapper with
 * its virtual list, and the older renderer. Teams' URL names no meeting, so
 * the tab is the call (`callKey` is null).
 */
import { WIRE_LIMITS } from '../../shared/wire.js';
import { collapse, first, firstAll, inButton, textOf } from './dom.js';
import type { Block, SiteAdapter } from './types.js';

/** Hang-up controls: in a call only (the last one is an anonymous guest's). The lobby has #prejoin-join-button instead. */
const HANGUP = [
  '#hangup-button',
  'button[data-tid="hangup-main-btn"]',
  'button[data-tid="hangup-leave-button"]',
  'button[data-tid="hangup-end-meeting-button"]',
  'button[data-tid="hangup-button"]',
  'button[data-tid="anon-hangup-button"]',
];
/** The caption container, newest layout first. */
const REGION = [
  '[data-tid="closed-caption-renderer-wrapper"]',
  '[data-tid="closed-caption-v2-window-wrapper"]',
  '[data-tid="closed-captions-renderer"]',
];
/** A loose match also finds the toolbar's Captions control: taken only when it holds caption text. */
const LOOSE_REGION = ['[data-tid*="closed-caption"]'];
const TEXT = ['[data-tid="closed-caption-text"]', '[data-tid="closed-caption-message"]'];
const AUTHOR = ['[data-tid="author"]', '[data-tid="closed-caption-author"]'];
/** One utterance, when Fluent UI's class is there. */
const ITEM = ['.fui-ChatMessageCompact'];
/** The list of utterances (the v2 virtual list, the 2026 list): an utterance is its child. */
const LIST = ['[data-tid="closed-caption-v2-virtual-list-content"]', '[role="list"]'];

/** Title parts that name a Teams view, not a meeting. */
const VIEWS = new Set(['microsoft teams', 'calendar', 'chat', 'activity']);

export const teamsAdapter: SiteAdapter = {
  site: 'teams',

  callKey: () => null,

  // Asked every second on every Teams page (Chat and Calendar too): the specific hooks only, never the loose
  // substring match over the whole document, which region() still tries while notes are on.
  inCall(doc) {
    return first(doc, HANGUP) !== null || first(doc, REGION) !== null;
  },

  // "<subject> | Microsoft Teams", with (n) counters and view names mixed in;
  // "Meet now" and "Meeting with …" are Teams' own names, not the meeting's.
  title(doc) {
    const parts = collapse(doc.title)
      .replace(/^\(\d+\)\s*/, '')
      .split('|')
      .map((p) => collapse(p.replace(/^\(\d+\)\s*/, '')))
      .filter((p) => p && !VIEWS.has(p.toLowerCase()));
    const t = parts[0] ?? '';
    if (/^meet now$/i.test(t) || /^meeting with\b/i.test(t)) return '';
    return t.slice(0, WIRE_LIMITS.name);
  },

  region: findRegion,

  blocks(region) {
    const texts = firstAll(region, TEXT, (el) => !inButton(el, region));
    // How many text elements each ancestor holds: one means it is inside a single utterance.
    const held = new Map<Element, number>();
    for (const text of texts) {
      for (let a = text.parentElement; a && a !== region; a = a.parentElement) held.set(a, (held.get(a) ?? 0) + 1);
    }
    const out: Block[] = [];
    for (const text of texts) {
      const said = textOf(text);
      if (!said) continue;
      const { el, author } = utterance(text, region, held);
      out.push({ el, speaker: author ? textOf(author) || null : null, text: said });
    }
    return out;
  },

  howTo: "No captions on screen. Turn them on: More (…) › Language and speech › Live captions, or Cmd+Shift+A. If they are on, Jantar can't read them on this page; screenshots still work.",
  // Right of the 68-px app bar.
  spot: Object.freeze({ left: '76px', top: '50%' }),
};

function findRegion(doc: Document): Element | null {
  return first(doc, REGION) ?? first(doc, LOOSE_REGION, (el) => first(el, TEXT) !== null);
}

/**
 * The utterance a text element belongs to and its author: the Fluent UI
 * item, else the list's child (either only when it holds no other
 * utterance's text), else the nearest ancestor holding an author and no
 * other utterance's text. The first two stay the same element
 * whether or not the author shows and however many utterances follow, so
 * the tracker keeps one line per utterance. A user who chose not to be
 * identified has no author; the tracker gives the line the previous speaker.
 */
function utterance(text: Element, region: Element, held: Map<Element, number>): { el: Element; author: Element | null } {
  const notHere = (a: Element) => !text.contains(a) && !inButton(a, region);
  const inside = (a: Element | null): a is Element => a !== null && a !== region && region.contains(a);
  for (const sel of ITEM) {
    const item = text.closest(sel);
    if (inside(item) && held.get(item) === 1) return { el: item, author: first(item, AUTHOR, notHere) };
  }
  for (const sel of LIST) {
    const list = text.parentElement?.closest(sel) ?? null;
    if (!inside(list) && list !== region) continue;
    let item: Element = text;
    while (item.parentElement && item.parentElement !== list) item = item.parentElement;
    if (item === text || held.get(item) === 1) return { el: item, author: first(item, AUTHOR, notHere) };
  }
  let el: Element = text;
  for (let a = text.parentElement; a && a !== region && held.get(a) === 1; a = a.parentElement) {
    el = a;
    const author = first(a, AUTHOR, notHere);
    if (author) return { el: a, author };
  }
  return { el, author: null };
}
