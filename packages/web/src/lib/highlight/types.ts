/**
 * What the highlighter hands back, and the limits it works within (v0.3
 * spec 5.2.4). Shared by the page and the worker, so it imports nothing.
 *
 * A highlighted file is a list of lines; a line is a list of segments, each
 * a slice of the file's own text with a token class. The page renders every
 * segment as a text node inside a <span className="tk-…">: no HTML string is
 * ever built, and the colours come from styles/code.css.
 */

/** The token classes styles/code.css knows ('' = plain text). */
export type TokenClass = 'tk-kw' | 'tk-type' | 'tk-fn' | 'tk-str' | 'tk-num' | 'tk-tag' | 'tk-attr' | 'tk-com' | 'tk-punct' | '';

/** One run of text and its class. */
export type Seg = readonly [text: string, cls: TokenClass];

export type Line = readonly Seg[];

/** Highlight at most this many lines, characters and characters on one line; past that, plain text. */
export const HIGHLIGHT_MAX_LINES = 2_000;
export const HIGHLIGHT_MAX_CHARS = 128_000;
export const HIGHLIGHT_MAX_LINE = 2_000;

/** The worker gets this long per file; then it is terminated and the file shows plain. */
export const HIGHLIGHT_WATCHDOG_MS = 1_000;

/** A fresh worker's first file also gets this long, for the worker to load its grammars. */
export const HIGHLIGHT_START_MS = 2_000;

/** Whether `text` is small enough to highlight. */
export function withinLimits(text: string): boolean {
  if (text.length > HIGHLIGHT_MAX_CHARS) return false;
  let lines = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i - start > HIGHLIGHT_MAX_LINE) return false;
    lines += 1;
    if (lines > HIGHLIGHT_MAX_LINES) return false;
    start = i + 1;
  }
  return text.length - start <= HIGHLIGHT_MAX_LINE;
}

/** Page to worker. `lang` is one of LANGUAGES (languages.ts). */
export interface HighlightRequest {
  id: number;
  text: string;
  lang: string;
}

/** Worker to page: null when the worker would not highlight it (unknown grammar, over the limits). */
export interface HighlightReply {
  id: number;
  lines: Line[] | null;
}
