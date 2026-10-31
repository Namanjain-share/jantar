/**
 * The box a screen scrolls in. The shells scroll an inner box (`<main>` on
 * the phone, a div inside it on a wide screen), never the window, and keep
 * it while the address changes within one screen.
 */

/** The nearest ancestor of `el` that scrolls; null where none does (jsdom has no styles). */
export function scrollParent(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return null;
}
