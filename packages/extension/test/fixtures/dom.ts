/**
 * A tiny element builder for the caption fixtures: DOM calls only (no
 * innerHTML), so the same builders run under a page's Trusted Types in the
 * end-to-end fixture pages.
 */

export type Attrs = Record<string, string>;

/** `<tag attrs>children</tag>`; a string child is a text node. `class` is an attribute like any other. */
export function h(doc: Document, tag: string, attrs: Attrs = {}, ...children: (Node | string | null)[]): HTMLElement {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null) el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  return el;
}

/** The made-up people the fixtures talk as ("You" is the note taker, as both sites label them). */
export const PEOPLE = Object.freeze({ sam: 'Sam', priya: 'Priya', alex: 'Alex', you: 'You' });

/** Set a text holder's words in place: its first text node changes (a characterData mutation, as the sites revise text). */
export function setWords(holder: Element, text: string): void {
  const node = Array.from(holder.childNodes).find((n) => n.nodeType === 3);
  if (node) (node as Text).data = text;
  else holder.append(holder.ownerDocument.createTextNode(text));
}

/** A holder's words. */
export function wordsOf(holder: Element): string {
  return (holder.textContent ?? '').replace(/\s+/g, ' ').trim();
}
