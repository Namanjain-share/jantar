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
