/**
 * Microsoft Teams on the web (teams.cloud.microsoft, teams.microsoft.com,
 * teams.live.com; spec 3.4). Teams marks its UI with `data-tid` attributes,
 * English and not localized, which changed in the October 2026 redesign:
 * the candidates cover the 2026 renderer wrapper, the v2 window wrapper with
 * its virtual list, and the older renderer. Teams' URL names no meeting, so
 * the tab is the call (`callKey` is null).
 *
 * v0.10, the screens around the call (Start when I join), first match wins
 * and every check is an exact `id` or `data-tid` (never the loose match):
 * a lobby-only hook (TEAMS_LOBBY, empty until a real-Mac check names one:
 * R12) is the waiting room even beside a hang-up; then the call (a hang-up,
 * then a caption container); the join screen (#prejoin-join-button); then,
 * on a join link only (by its path or query: no host, no URL is spelled out
 * here), the waiting room after Join now (this page saw the join button at
 * this same URL and shows neither it nor the call), else the join link
 * alone. Off a join link (Teams v2's one /v2/ address, Chat, Calendar)
 * nothing but a real hook names a stage.
 */
import { WIRE_LIMITS } from '../../shared/wire.js';
import { collapse, first, firstAll, inButton, pageAt, textOf } from './dom.js';
import type { Block, HookId, SiteAdapter } from './types.js';

/** Hang-up controls, each with its hook id: in a call only (the last one is an anonymous guest's). The lobby has #prejoin-join-button instead. */
const HANGUP: readonly (readonly [string, HookId])[] = [
  ['#hangup-button', 'teams:hangup-button'],
  ['button[data-tid="hangup-main-btn"]', 'teams:hangup-main-btn'],
  ['button[data-tid="hangup-leave-button"]', 'teams:hangup-leave-button'],
  ['button[data-tid="hangup-end-meeting-button"]', 'teams:hangup-end-meeting-button'],
  ['button[data-tid="hangup-button"]', 'teams:hangup-button-tid'],
  ['button[data-tid="anon-hangup-button"]', 'teams:anon-hangup-button'],
];
/**
 * v0.10: hooks only the waiting room has (`data-tid` or `id`). Empty until
 * a real-Mac check (R12) names one; one that matches makes the page the
 * waiting room, and not in a call, even while a hang-up button shows.
 */
export const TEAMS_LOBBY: readonly string[] = [];
/** v0.10: the join screen's Join now (the second is unverified, R12). */
const PREJOIN = ['#prejoin-join-button', 'button[data-tid="prejoin-join-button"]'];
/** v0.10: the paths of a join link (light meetings, the meetup-join link, the short /meet/ link, the launcher). */
const JOIN_PATHS = ['/light-meetings/', '/l/meetup-join/', '/meet/', '/dl/launcher/'];
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

  inCall: (doc) => inCallHook(doc) !== null,

  inCallHook,

  waiting(doc, seen) {
    if (lobbyOnly(doc)) return { stage: 'lobby', hook: 'teams:lobby', strong: true };
    if (inCallHook(doc) !== null) return null;
    if (first(doc, PREJOIN) !== null) return { stage: 'prejoin', hook: 'teams:prejoin-join', strong: true };
    const loc = doc.location;
    if (!loc) return null;
    if (!joinLink(loc)) return null;
    // Light meetings pass through Join now before the waiting room, at the same URL. Only on a join link: Teams v2 keeps
    // one address (/v2/) for its whole app, so there the join screen seen before proves nothing (Chat after a cancel).
    if (seen.joinHookAt !== null && seen.joinHookAt === pageAt(loc)) return { stage: 'lobby', hook: 'teams:after-join', strong: true };
    return { stage: 'prejoin', hook: 'teams:join-link', strong: false };
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

// Asked every second on every Teams page (Chat and Calendar too): the specific hooks only, never the loose
// substring match over the whole document, which region() still tries while notes are on.
function inCallHook(doc: Document): HookId | null {
  if (lobbyOnly(doc)) return null;
  for (const [sel, id] of HANGUP) if (doc.querySelector(sel) !== null) return id;
  if (first(doc, REGION) !== null) return 'teams:caption-region';
  return null;
}

function lobbyOnly(doc: Document): boolean {
  return TEAMS_LOBBY.length > 0 && first(doc, TEAMS_LOBBY) !== null;
}

function joinLink(loc: Location): boolean {
  const path = loc.pathname.toLowerCase();
  return JOIN_PATHS.some((p) => path.startsWith(p)) || loc.search.toLowerCase().includes('meetingjoin=true');
}

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
