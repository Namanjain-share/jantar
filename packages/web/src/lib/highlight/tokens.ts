/**
 * Prism's token tree to lines of (text, class) segments, and the hidden
 * characters a reader should see. Pure: the worker runs `toLines`, the page
 * runs `splitHidden` on whatever it renders.
 */
import type { Line, Seg, TokenClass } from './types.js';

/** The shape of Prism.tokenize's result (prismjs ships no types here). */
export interface PrismToken {
  type: string;
  content: PrismStream;
  alias?: string | string[];
}
export type PrismStream = string | PrismToken | Array<string | PrismToken>;

/** Prism token types (and aliases) to our classes; anything else inherits its parent's class. */
const CLASS = new Map<string, TokenClass>([
  ['keyword', 'tk-kw'],
  ['important', 'tk-kw'],
  ['atrule', 'tk-kw'],
  ['rule', 'tk-kw'],
  ['directive', 'tk-kw'],
  ['class-name', 'tk-type'],
  ['builtin', 'tk-type'],
  ['namespace', 'tk-type'],
  ['maybe-class-name', 'tk-type'],
  ['function', 'tk-fn'],
  ['function-variable', 'tk-fn'],
  ['method', 'tk-fn'],
  ['macro', 'tk-fn'],
  ['string', 'tk-str'],
  ['template-string', 'tk-str'],
  ['char', 'tk-str'],
  ['regex', 'tk-str'],
  ['url', 'tk-str'],
  ['attr-value', 'tk-str'],
  ['inserted', 'tk-str'],
  ['number', 'tk-num'],
  ['boolean', 'tk-num'],
  ['constant', 'tk-num'],
  ['symbol', 'tk-num'],
  ['entity', 'tk-num'],
  ['tag', 'tk-tag'],
  ['selector', 'tk-tag'],
  ['doctype', 'tk-tag'],
  ['attr-name', 'tk-attr'],
  ['property', 'tk-attr'],
  ['key', 'tk-attr'],
  ['variable', 'tk-attr'],
  ['comment', 'tk-com'],
  ['prolog', 'tk-com'],
  ['cdata', 'tk-com'],
  ['shebang', 'tk-com'],
  ['deleted', 'tk-com'],
  ['punctuation', 'tk-punct'],
  ['operator', 'tk-punct'],
]);

/** Our class for a Prism token: its type first, then its aliases. */
export function classOf(type: string, alias?: string | string[]): TokenClass | null {
  const own = CLASS.get(type);
  if (own) return own;
  for (const a of typeof alias === 'string' ? [alias] : (alias ?? [])) {
    const c = CLASS.get(a);
    if (c) return c;
  }
  return null;
}

/** Flatten a token stream into lines; a token's class covers its children unless they have their own. */
export function toLines(stream: PrismStream): Line[] {
  const lines: Seg[][] = [[]];
  const push = (text: string, cls: TokenClass) => {
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      // Neighbours with the same class merge: fewer spans for the same text.
      if (last && last[1] === cls) line[line.length - 1] = [last[0] + part, cls];
      else line.push([part, cls]);
    });
  };
  const walk = (s: PrismStream, cls: TokenClass) => {
    if (typeof s === 'string') push(s, cls);
    else if (Array.isArray(s)) for (const x of s) walk(x, cls);
    else walk(s.content, classOf(s.type, s.alias) ?? cls);
  };
  walk(stream, '');
  return lines;
}

/** Lines of plain text, the same shape as highlighted ones. */
export function plainLines(text: string): Line[] {
  return text.split('\n').map((l) => (l ? [[l, ''] as const] : []));
}

/**
 * Characters that change how text reads without showing: bidi controls,
 * zero-width marks, line and paragraph separators, a stray BOM and C0
 * controls (tab kept). The viewer shows each as ⟨U+202E⟩.
 */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** "⟨U+202E⟩" */
export function hiddenName(ch: string): string {
  return `⟨U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`;
}

/** Split text into visible runs and single hidden characters (true = hidden). */
export function splitHidden(text: string): Array<readonly [string, boolean]> {
  if (!HIDDEN.test(text)) return [[text, false]];
  const out: Array<readonly [string, boolean]> = [];
  let run = '';
  for (const ch of text) {
    if (HIDDEN.test(ch)) {
      if (run) out.push([run, false]);
      run = '';
      out.push([ch, true]);
    } else {
      run += ch;
    }
  }
  if (run) out.push([run, false]);
  return out;
}

/** `text` with each hidden character spelled out, for plain-string places (a toast, a label). */
export function showHidden(text: string): string {
  return splitHidden(text)
    .map(([t, hidden]) => (hidden ? hiddenName(t) : t))
    .join('');
}
