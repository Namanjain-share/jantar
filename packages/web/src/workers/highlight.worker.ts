/**
 * The syntax highlighter's worker (v0.3 spec 5.2.4): Prism off the main
 * thread. It gets { id, text, lang } and answers { id, lines } (lines of
 * text-and-class segments, never HTML), or lines: null when it will not
 * highlight that text. Vite bundles it as its own file
 * (lib/highlight/client.ts starts it with new URL(..., import.meta.url)),
 * so the CSP's worker-src 'self' covers it; it is never a blob: URL.
 */
import { highlightLines } from '../lib/highlight/prism.js';
import type { HighlightReply, HighlightRequest } from '../lib/highlight/types.js';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<HighlightRequest>) => void) | null;
  postMessage(reply: HighlightReply): void;
};

scope.onmessage = (e) => {
  const { id, text, lang } = e.data ?? {};
  if (typeof id !== 'number') return;
  let lines: HighlightReply['lines'] = null;
  try {
    lines = typeof text === 'string' && typeof lang === 'string' ? highlightLines(text, lang) : null;
  } catch {
    lines = null;
  }
  scope.postMessage({ id, lines });
};
