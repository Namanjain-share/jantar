/**
 * Google Meet (meet.google.com, spec 3.4). Meet's classes are obfuscated and
 * change between releases; the longer-lived hooks are ARIA roles and labels,
 * Closure `jsname` / `jscontroller` attributes and icon text. Every lookup is
 * an ordered list of candidates, and when none of the known caption classes
 * is on the page any more, a strict structural fallback reads the turns.
 *
 * The shape the candidates expect: region › list › one child per speaker
 * turn › [name (often with an avatar), text]. The list's last children are
 * not captions; they hold buttons, and nothing inside a button is read.
 */
import { WIRE_LIMITS } from '../../shared/wire.js';
import { collapse, first, firstAll, holdsButton, inButton, textOf } from './dom.js';
import type { Block, SiteAdapter } from './types.js';

/** The call's code in both URL forms: /abc-defg-hij and, once admitted, /meet/abc-defg-hij. */
const CODE = /(?:^|\/)([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})(?=\/|$)/i;
const BARE_CODE = /^[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}$/i;

/** The captions button: in the call only, in any UI language. The waiting room has none. */
const CAPTIONS_BUTTON = ['button[jsname="RrG0hf"]'];
/** The caption region (labels are localized, hence the partial match). */
const REGION = [
  'div[role="region"][aria-label*="aption" i]',
  'div[role="region"][aria-label*="ubtit" i]',
  'div[jsname="dsyhDe"]',
  'div[jsname="tgaKEf"]',
  '[jscontroller="D1tHje"]',
];
/** A speaker turn (a child of the region's list). */
const TURN = ['.nMcdL', '.TBMuR'];
/** A turn's text element. */
const TEXT = ['.ygicle', '.bh44bd', '.iTTPOb'];
/** A turn's name element. */
const NAME = ['.NWpY1d', '.zs7s8d', '.KcIKyf', '.adE6rb'];
const TITLE = ['[data-meeting-title]'];

export const meetAdapter: SiteAdapter = {
  site: 'meet',

  callKey,

  // A code and the captions button or the caption region. Meet's call_end
  // icon is also on the waiting room's screen, so it proves nothing alone,
  // and with the captions button beside it adds nothing to the button.
  inCall(doc) {
    if (!doc.location || callKey(doc.location) === null) return false;
    return first(doc, CAPTIONS_BUTTON) !== null || findRegion(doc) !== null;
  },

  title(doc) {
    const el = first(doc, TITLE);
    let t = el ? collapse(el.getAttribute('data-meeting-title')) || textOf(el) : '';
    if (!t) t = collapse(doc.title).replace(/^Meet\s*[–—-]\s*/, '');
    if (!t || /^(google )?meet$/i.test(t) || BARE_CODE.test(t)) return '';
    return t.slice(0, WIRE_LIMITS.name);
  },

  region: findRegion,

  blocks(region) {
    const texts = firstAll(region, TEXT, (el) => !inButton(el, region));
    return texts.length ? knownBlocks(region, texts) : structuralBlocks(region);
  },

  howTo: "No captions on screen. Turn them on with the CC button, or press c. If they are on, Jantar can't read them on this page; screenshots still work.",
  spot: Object.freeze({ left: '12px', top: '50%' }),
};

function callKey(loc: Location): string | null {
  const m = CODE.exec(loc.pathname);
  return m?.[1] ? m[1].toLowerCase() : null;
}

function findRegion(doc: Document): Element | null {
  return first(doc, REGION);
}

/**
 * Turns found through the known classes: each text element with the name
 * element in its turn. The turn is its known turn element; failing that,
 * the first ancestor holding a name element and no other turn's text, else
 * the widest one holding no other turn's text.
 */
function knownBlocks(region: Element, texts: Element[]): Block[] {
  // How many text elements each ancestor holds: one means it is inside a single turn.
  const held = new Map<Element, number>();
  for (const text of texts) {
    for (let a = text.parentElement; a && a !== region; a = a.parentElement) held.set(a, (held.get(a) ?? 0) + 1);
  }
  const turns = new Map<Element, Block>();
  for (const text of texts) {
    const nameIn = (a: Element) => first(a, NAME, (n) => !text.contains(n) && !inButton(n, region));
    let el: Element = text;
    let name: Element | null = null;
    const turn = TURN.map((sel) => text.closest(sel)).find((t) => t && t !== region && region.contains(t) && held.get(t) === 1);
    if (turn) {
      el = turn;
      name = nameIn(turn);
    } else {
      for (let a = text.parentElement; a && a !== region && held.get(a) === 1; a = a.parentElement) {
        el = a;
        name = nameIn(a);
        if (name) break;
      }
    }
    const said = textOf(text);
    if (!said) continue;
    const seen = turns.get(el);
    if (seen) seen.text = `${seen.text} ${said}`;
    else turns.set(el, { el, speaker: name ? textOf(name) || null : null, text: said });
  }
  return [...turns.values()];
}

/**
 * Only when no known class is on the page: a list child whose first element
 * (the name) and the element after it (the text) both hold text. A child
 * holding a button (the list's trailing controls) is never a turn. The list
 * is whichever of the region and its children yields the most turns (the
 * region itself loses when its one child is the list: that child holds the
 * trailing buttons).
 */
function structuralBlocks(region: Element): Block[] {
  let best: Block[] = [];
  for (const list of [...Array.from(region.children), region]) {
    const found: Block[] = [];
    for (const child of Array.from(list.children)) {
      if (holdsButton(child)) continue;
      const name = child.firstElementChild;
      const speaker = textOf(name);
      const text = textOf(name?.nextElementSibling);
      if (speaker && text) found.push({ el: child, speaker, text });
    }
    if (found.length > best.length) best = found;
  }
  return best;
}
