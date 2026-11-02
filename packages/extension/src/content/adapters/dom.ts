/**
 * DOM reading both site adapters share. No site selector lives here: each
 * adapter keeps its own ordered candidate lists and tries them one at a
 * time through `first` and `firstAll`, never as one comma-joined selector
 * (whichever element came first in the page would win, research 2.2).
 */

/** Whitespace collapsed to single spaces, trimmed. */
export function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** An element's text from its textContent (jsdom has no innerText), whitespace collapsed; '' for none. */
export function textOf(el: Element | null | undefined): string {
  return el ? collapse(el.textContent) : '';
}

/** The first element a candidate finds, the candidates tried in order; `ok` can refuse a find. */
export function first(root: ParentNode, selectors: readonly string[], ok: (el: Element) => boolean = () => true): Element | null {
  for (const sel of selectors) {
    for (const el of Array.from(root.querySelectorAll(sel))) if (ok(el)) return el;
  }
  return null;
}

/** Every element the first candidate with any accepted find finds (later candidates are not mixed in). */
export function firstAll(root: ParentNode, selectors: readonly string[], ok: (el: Element) => boolean = () => true): Element[] {
  for (const sel of selectors) {
    const found = Array.from(root.querySelectorAll(sel)).filter(ok);
    if (found.length) return found;
  }
  return [];
}

/** True when `el` is a button or [role=button], or sits inside one below `root`: caption text is never read there. */
export function inButton(el: Element, root: Element): boolean {
  for (let a: Element | null = el; a && a !== root; a = a.parentElement) {
    if (a.tagName === 'BUTTON' || a.getAttribute('role') === 'button') return true;
  }
  return false;
}

/** How many of `texts` each of their ancestors below `region` holds (one: inside a single turn). */
export function heldBy(texts: readonly Element[], region: Element): Map<Element, number> {
  const held = new Map<Element, number>();
  for (const text of texts) {
    for (let a = text.parentElement; a && a !== region; a = a.parentElement) held.set(a, (held.get(a) ?? 0) + 1);
  }
  return held;
}

/** True when `el` is or holds a button or [role=button]. */
export function holdsButton(el: Element): boolean {
  return el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.querySelector('button') !== null || el.querySelector('[role="button"]') !== null;
}

/** True when `root` shows any text outside button and [role=button] subtrees (a control's label is not a caption). */
export function showsText(root: Element): boolean {
  const doc = root.ownerDocument;
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.nodeValue?.trim()) continue;
    const parent = n.parentElement;
    if (parent && !inButton(parent, root)) return true;
  }
  return false;
}

/** v0.10: where the page is, as the page's own memory keeps it (path, query and hash; never sent, never stored). */
export function pageAt(loc: Location | null | undefined): string | null {
  return loc ? `${loc.pathname}${loc.search}${loc.hash}` : null;
}

/** v0.10: how long a try waits between its steps, and for a menu or pop-up to open. */
export const CC_STEP_MS = 300;
export const CC_OPEN_MS = 2_000;

/** v0.10: not inside a hidden or aria-hidden subtree (jsdom has no layout, so no more than this is asked). */
export function shown(el: Element): boolean {
  return el.closest('[hidden], [aria-hidden="true"]') === null;
}

/** v0.10: a captions control's English words (both sites), exactly: offering to turn them off (so they are on), or on. */
export const SAYS_ON_EN: ReadonlySet<string> = new Set(['turn off captions', 'turn off live captions', 'hide live captions']);
export const SAYS_OFF_EN: ReadonlySet<string> = new Set(['turn on captions', 'turn on live captions', 'show live captions']);

/** v0.10: what a captions control says: aria-pressed or aria-checked, else `off` (a site's own sign of off), else its English words. */
export function saysOf(el: Element, off = false): 'on' | 'off' | 'unknown' {
  for (const attr of ['aria-pressed', 'aria-checked']) {
    const v = el.getAttribute(attr);
    if (v === 'true' || v === 'false') return v === 'true' ? 'on' : 'off';
  }
  if (off) return 'off';
  const words = labelOf(el);
  return SAYS_ON_EN.has(words) ? 'on' : SAYS_OFF_EN.has(words) ? 'off' : 'unknown';
}

/** v0.10: a control's own label, lower-cased: its aria-label, else its text. */
export function labelOf(el: Element): string {
  return collapse(el.getAttribute('aria-label') ?? el.textContent).toLowerCase();
}

/** v0.10: a click as a page script makes one (HTMLElement.click()). */
export function click(el: Element): void {
  (el as HTMLElement).click();
}

/** v0.10: one keydown, bubbling from `target` (the site's own key handlers take untrusted ones). */
export function press(target: EventTarget, key: string, code: string): void {
  const view = (target as Node).ownerDocument?.defaultView ?? (target as Document).defaultView;
  const Ctor = view?.KeyboardEvent ?? KeyboardEvent;
  target.dispatchEvent(new Ctor('keydown', { key, code, bubbles: true, cancelable: true }));
}

/** v0.10: what `find` finds, asked again every CC_STEP_MS for up to `ms`; null when it never does. */
export async function poll<T>(wait: (ms: number) => Promise<void>, find: () => T | null, ms = CC_OPEN_MS): Promise<T | null> {
  for (let waited = 0; ; waited += CC_STEP_MS) {
    const got = find();
    if (got !== null || waited >= ms) return got;
    await wait(CC_STEP_MS);
  }
}
