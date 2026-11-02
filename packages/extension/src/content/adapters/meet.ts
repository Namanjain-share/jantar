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
 *
 * v0.10, the screens around the call (Start when I join), first match wins:
 * the call (the captions button by its jsname, then by its icon, which
 * Meet's redesign of 2026-10-22 may have left alone, then the caption
 * region: `inCall`'s own hooks), the waiting room (a button holding the `call_end` icon and no
 * captions button: you wait to be let in), the join screen (Meet's join
 * button), else the code alone (the join screen, or a screen after it).
 * The icon is a fixed glyph name, not localized page text.
 *
 * v0.10, captions on when notes start (research captions-research.md 2.2;
 * selector facts as of 2026-11-02, read from TranscripTonic, Meeting
 * Transcripts, meet-caption-log-extension and vibeconf, no code taken): the
 * captions control is the old toggle (its jsname) or, since 2026-10-22,
 * "Captions and translation", found by its icon. Its `aria-pressed` says
 * whether captions are on; failing that its icon or English label. The
 * old toggle is clicked; a control that opens a pop-up (any aria-haspopup)
 * is opened, the pop-up taken only when it is new and named as the button,
 * its toggle being the first button that opens nothing more and says what
 * captions are, clicked only when it says off and the toolbar does not
 * disagree; the pop-up is closed again. The key `c` (Meet's own shortcut,
 * a toggle) is the last resort, only when the control says off. A control
 * whose state can't be read is never touched.
 */
import { WIRE_LIMITS } from '../../shared/wire.js';
import { CC_STEP_MS, click, collapse, first, firstAll, heldBy, holdsButton, inButton, poll, press, saysOf, textOf } from './dom.js';
import type { Block, CaptionsControl, CcStep, CcTry, HookId, SiteAdapter } from './types.js';

/** The call's code in both URL forms: /abc-defg-hij and, once admitted, /meet/abc-defg-hij. */
const CODE = /(?:^|\/)([a-z]{3,4}-[a-z]{4}-[a-z]{3,4})(?=\/|$)/i;
const BARE_CODE = /^[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}$/i;

/** The captions button: in the call only, in any UI language. The waiting room has none. */
const CAPTIONS_BUTTON = ['button[jsname="RrG0hf"]'];
/**
 * v0.10: the captions control found by its icon, whatever its jsname: the
 * "Captions and translation" button of 2026-10-22 opens a pop-up, the older
 * one is pressed or not. Only in the call, with captions off too (research
 * captions-research.md 2.2, R-C1).
 */
const CC_ICON_BUTTON = ['button[aria-haspopup="dialog"][aria-pressed]', 'button[aria-pressed]'];
const CC_ICONS = new Set(['translate_cc', 'closed_caption', 'closed_caption_off']);
const ICON_FONT = ['i.google-symbols', 'i.google-material-icons', 'i.material-icons-extended'];
/** v0.10: the control by its English label, last (a UI in another language has none of these). */
const CC_LABEL_EN = ['Captions and translation', 'Turn on captions', 'Turn off captions'].map((l) => `button[aria-label="${l}"]`);
/** v0.10: the pop-up (new since the click, its aria-label the button's) and its toggle: the first button that opens nothing more and says what captions are. */
const CC_DIALOG = ['[role="dialog"]'];
const CC_POPUP_TOGGLE = ['button:not([aria-haspopup])'];
/** v0.10: the try that presses `c` instead of clicking the old toggle again (a click that did nothing: Translate speech's hover panel). */
const CC_KEY_TRY = 3;
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
/** v0.10: Meet's icon fonts; a button holding one whose ligature is exactly `call_end` (the waiting room shows it, the captions button not yet). */
const ICONS = ICON_FONT.map((i) => `button ${i}`);
const CALL_END = 'call_end';
/** v0.10: the join screen's Join now / Ask to join (unverified on a real Mac, R12; it only names the join screen). */
const JOIN_BUTTON = ['[jsname="Qx7uuf"]'];

export const meetAdapter: SiteAdapter = {
  site: 'meet',

  callKey,

  inCall: (doc) => inCallHook(doc) !== null,

  inCallHook,

  waiting(doc) {
    if (!doc.location || callKey(doc.location) === null || inCallHook(doc) !== null) return null;
    if (first(doc, ICONS, (el) => collapse(el.textContent) === CALL_END)) return { stage: 'lobby', hook: 'meet:call_end', strong: true };
    if (first(doc, JOIN_BUTTON)) return { stage: 'prejoin', hook: 'meet:join-button', strong: true };
    // The code alone: the join screen, or "You left" and "You can't join" (the call watch's memory makes those `left`).
    return { stage: 'prejoin', hook: 'meet:code', strong: false };
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

  cc: {
    state(doc) {
      const region = findRegion(doc);
      if (region && first(region, [...TURN, ...TEXT]) !== null) return { state: 'on', hook: 'meet:caption-region' };
      const control = ccControl(doc);
      return control ? { state: ccSays(control.el), hook: control.hook } : { state: 'unknown', hook: 'meet:no-cc' };
    },
    turnOn: ccTurnOn,
    client: () => 'meet',
  } satisfies CaptionsControl,
  spot: Object.freeze({ left: '12px', top: '50%' }),
};

// A code and the captions button (by its jsname, else by its icon) or the
// caption region. Meet's call_end icon is also on the waiting room's
// screen, so it proves nothing alone, and with the captions button beside
// it adds nothing to the button.
function inCallHook(doc: Document): HookId | null {
  if (!doc.location || callKey(doc.location) === null) return null;
  if (first(doc, CAPTIONS_BUTTON) !== null) return 'meet:captions-button';
  if (ccIconButton(doc) !== null) return 'meet:captions-icon';
  // Whether the region is on the page, never what it says.
  if (findRegion(doc) !== null) return 'meet:caption-region';
  return null;
}

/** The glyph a control's icon shows ('' for none). */
function iconOf(el: Element): string {
  return collapse(first(el, ICON_FONT)?.textContent);
}

function ccIconButton(doc: Document): Element | null {
  return first(doc, CC_ICON_BUTTON, (b) => CC_ICONS.has(iconOf(b)));
}

/** v0.10: the captions control: by its jsname, its icon, then its English label. */
function ccControl(doc: Document): { el: Element; hook: HookId } | null {
  const old = first(doc, CAPTIONS_BUTTON);
  if (old) return { el: old, hook: 'meet:captions-button' };
  const icon = ccIconButton(doc);
  if (icon) return { el: icon, hook: 'meet:captions-icon' };
  const en = first(doc, CC_LABEL_EN);
  return en ? { el: en, hook: 'meet:captions-label' } : null;
}

/** v0.10: what a captions control says: pressed (or checked), else its icon, else its English label. */
const ccSays = (el: Element) => saysOf(el, iconOf(el) === 'closed_caption_off');

/** v0.10: one try (see the header). */
async function ccTurnOn(doc: Document, t: CcTry): Promise<CcStep> {
  const control = ccControl(doc);
  if (!control) return { result: 'none', hook: 'meet:no-cc' };
  const { el } = control;
  // Its pop-up is open: he is in it.
  if (el.getAttribute('aria-expanded') === 'true') return { result: 'busy', hook: control.hook };
  const says = ccSays(el);
  if (says === 'on') return { result: 'on', hook: control.hook };
  const pops = el.getAttribute('aria-haspopup');
  if (!pops || pops === 'false') {
    if (says !== 'off') return { result: 'none', hook: control.hook };
    if (t.attempt >= CC_KEY_TRY) return key(doc);
    click(el);
    return { result: 'clicked', hook: 'meet:cc-button' };
  }
  // "Captions and translation": open its pop-up (a new dialog named as the button), turn the toggle on, close it.
  const label = el.getAttribute('aria-label');
  const before = new Set(doc.querySelectorAll('[role="dialog"]'));
  click(el);
  const dialog = label ? await poll(t.wait, () => first(doc, CC_DIALOG, (d) => !before.has(d) && d.getAttribute('aria-label') === label)) : null;
  // The toggle says what captions are itself (a Close or Learn more button says nothing); the toolbar must not disagree.
  const toggle = dialog ? first(dialog, CC_POPUP_TOGGLE, (b) => ccSays(b) !== 'unknown') : null;
  const own = toggle ? ccSays(toggle) : 'unknown';
  let step: CcStep | null = toggle ? { result: 'none', hook: 'meet:cc-disagree' } : null;
  if (toggle && (says === 'unknown' || says === own)) {
    if (own === 'on') step = { result: 'on', hook: 'meet:cc-popup' };
    else if (t.live()) {
      click(toggle);
      step = { result: 'clicked', hook: 'meet:cc-popup' };
    }
  }
  await t.wait(CC_STEP_MS);
  if (el.getAttribute('aria-expanded') === 'true') click(el);
  else if (dialog?.isConnected) press(dialog, 'Escape', 'Escape');
  if (step) return step;
  return says === 'off' && t.live() ? key(doc) : { result: 'none', hook: 'meet:no-cc-toggle' };
}

/** v0.10: Meet's own shortcut for captions (it toggles: only ever sent when the control says off). */
function key(doc: Document): CcStep {
  press(doc, 'c', 'KeyC');
  return { result: 'clicked', hook: 'meet:key-c' };
}

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
  const held = heldBy(texts, region);
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
