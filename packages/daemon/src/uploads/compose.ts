/**
 * The prompt with its attachments (v0.4.2, spec 6.5): the user's words, then
 * a block that names each file by a cleaned, quoted label and its absolute
 * path, every line starting with words so Claude Code never turns one into
 * an attached image:
 *
 *   <text, trimmed>
 *
 *   Attached files:
 *   - "<label>": <absolute path>
 *
 * With blank text the block opens with "Please look at these files:". A
 * prompt the block makes too long is refused with a fixed sentence (the API
 * answers 400 with it); the writer then validates the text like any prompt
 * (writer/text.ts, where imagePathLines refuses a path-only image line).
 *
 * A label is untrusted text (a downloaded file's name) placed inside the
 * user's own prompt, so this is the one place it is cleaned and quoted.
 */
import { UPLOAD_LABEL_MAX } from '@jantar/protocol';
import type { ResolvedUpload } from '../contracts.js';
import { MAX_PROMPT_CHARS } from '../writer/text.js';

/** The prompt to type, or why there is none. */
export type ComposeResult = { ok: true; text: string } | { ok: false; reason: string };

export const COMPOSED_TOO_LONG = 'With the file list the prompt is longer than 16,000 characters';
export const FILES_HEADING = 'Attached files:';
export const FILES_ONLY_HEADING = 'Please look at these files:';

/** Stored extensions of images Claude sees: a nameless one is called "image N", anything else "file N". */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i;
// Line breaks and tabs become a space.
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;
// Every other control or format character (bidi overrides, zero-width marks) is dropped.
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * A label safe to quote in the prompt: controls dropped, line breaks as
 * spaces, `/` and `\` as `_` (no path inside a label), `"` as `'` (the
 * quotes stay closed), an `@` that would start a mention as `_` (Claude
 * Code reads `@name` as a file to attach after a space, a line start or CJK
 * punctuation such as `。`, so only an `@` after a letter, digit or `_`
 * stays), spaces squashed, at most
 * UPLOAD_LABEL_MAX characters. `fallback` when nothing is left.
 */
export function cleanLabel(label: string, fallback: string): string {
  const cleaned = label
    .replace(BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(/[/\\]/g, '_')
    .replace(/"/g, "'")
    .replace(/\s+/gu, ' ')
    .replace(/(?<![0-9A-Za-z_])@/g, '_')
    .trim();
  // By code point, so a cut never splits a surrogate pair.
  const cut = Array.from(cleaned).slice(0, UPLOAD_LABEL_MAX).join('').trim();
  return cut === '' ? fallback : cut;
}

/** An absolute path as Claude Code reads it from a prompt: quoted only when it holds whitespace; never `@`, never escaped. */
function quotePath(path: string): string {
  return /\s/u.test(path) ? `"${path}"` : path;
}

/** The user's words with the attachment block. */
export function composePrompt(text: string, files: readonly ResolvedUpload[]): ComposeResult {
  if (files.length === 0) return { ok: true, text };
  const words = text.replace(/\r\n?/g, '\n').trim();
  let images = 0;
  let others = 0;
  const lines = files.map((f) => {
    const fallback = IMAGE_FILE.test(f.path) ? `image ${(images += 1)}` : `file ${(others += 1)}`;
    return `- "${cleanLabel(f.label, fallback)}": ${quotePath(f.path)}`;
  });
  const head = words === '' ? [FILES_ONLY_HEADING] : [words, '', FILES_HEADING];
  const composed = [...head, ...lines].join('\n');
  if (composed.length > MAX_PROMPT_CHARS) return { ok: false, reason: COMPOSED_TOO_LONG };
  return { ok: true, text: composed };
}
