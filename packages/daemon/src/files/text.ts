/**
 * One window of a text file (v0.3 spec 4.4.4), read through the policy's
 * handle, always sent as JSON and rendered as text nodes on the phone.
 *
 * - A window is at most `max` bytes (512 KiB), cut after the last newline;
 *   a line longer than the window is cut at a character boundary and
 *   flagged `truncated-line`.
 * - Binary: a NUL in the first 8 KiB, invalid UTF-8, UTF-16 without a BOM
 *   (it has NULs), or more than 5% control characters. Binary files and
 *   files over 64 MiB get no text (stat still gives their metadata).
 * - Content rule: a window is refused when it, or 16 KiB on either side of
 *   it, holds a private key block (so a window inside a key is caught too).
 *   Secret tokens (sk-ant-, ghp_, github_pat_, AKIA, xoxb-, ...) are masked
 *   after their prefix, one '*' per character, and the window carries a
 *   `secret-like` warning.
 */
import type { FileText, FileTextWarning } from '@jantar/protocol';
import type { FileRefusal, OpenedFile } from '../contracts.js';
import { readRange } from '../sources/lib/fsx.js';
import { holdsPrivateKey, looksSecret, secretSpans } from './deny.js';
import { refuse } from './policy.js';

/** Larger files give metadata only. */
export const TEXT_MAX_FILE = 64 * 1024 * 1024;
/** Bytes read to tell text from binary. */
export const SNIFF_BYTES = 8 * 1024;
/** Bytes scanned on each side of a window for a private key block (more than any PEM key). */
export const KEY_MARGIN = 16 * 1024;
const CONTROL_MAX_RATIO = 0.05;
const MINIFIED_AVG_LINE = 500;
const MINIFIED_LONG_LINE = 10_000;

export const BINARY_MESSAGE = 'This is a binary file. Jantar shows text, images and PDFs.';
export const KEY_MESSAGE = 'This file holds a private key. Keys and secrets never leave the Mac.';
export const TOO_LARGE_TEXT_MESSAGE = 'This file is over 64 MB: Jantar shows its size and date only.';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export interface TextHead {
  encoding: TextEncoding;
  /** Byte length of the BOM (0 without one). */
  bom: number;
  binary: boolean;
}

// Direction overrides and isolates, zero-width marks, line and paragraph
// separators, and U+FEFF (a BOM is skipped before decoding, so any left is
// not leading).
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2028\u2029\ufeff]/;

function bomOf(b: Buffer): { encoding: TextEncoding; bom: number } {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: 'utf-8', bom: 3 };
  if (b[0] === 0xff && b[1] === 0xfe) return { encoding: 'utf-16le', bom: 2 };
  if (b[0] === 0xfe && b[1] === 0xff) return { encoding: 'utf-16be', bom: 2 };
  return { encoding: 'utf-8', bom: 0 };
}

/** More than 5% control characters (tab, newline, carriage return and form feed do not count). */
export function controlHeavy(text: string): boolean {
  if (text.length === 0) return false;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) || c === 0x7f) n += 1;
  }
  return n / text.length > CONTROL_MAX_RATIO;
}

function evenLength(b: Buffer): Buffer {
  return b.length % 2 === 0 ? b : b.subarray(0, b.length - 1);
}

/** Encoding and BOM from the file's first bytes, and whether it is binary. */
export function sniffHead(head: Buffer): TextHead {
  const { encoding, bom } = bomOf(head);
  const body = head.subarray(bom);
  if (encoding === 'utf-8' && body.includes(0)) return { encoding, bom, binary: true };
  let text: string;
  try {
    // stream: a character cut at the end of the sniffed bytes is not an error.
    const data = encoding === 'utf-8' ? body : evenLength(body);
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(data, { stream: true });
  } catch {
    return { encoding, bom, binary: true };
  }
  return { encoding, bom, binary: controlHeavy(text) };
}

export async function readHead(file: OpenedFile): Promise<TextHead> {
  return sniffHead(await readRange(file.fh, 0, Math.min(file.stat.size, SNIFF_BYTES)));
}

interface Cut {
  /** Bytes skipped at the start (the tail of a character the previous window held). */
  start: number;
  end: number;
  truncatedLine: boolean;
}

function utf8SeqLen(b: number): number {
  if (b < 0x80) return 1;
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  return 1;
}

/** Where a UTF-8 window of `want` bytes ends (`avail` may hold a few bytes more). */
function cutUtf8(avail: Buffer, want: number, atEnd: boolean, skipLead: boolean): Cut {
  let start = 0;
  if (skipLead) while (start < 3 && start < want && ((avail[start] as number) & 0xc0) === 0x80) start += 1;
  if (atEnd) return { start, end: want, truncatedLine: false };
  const nl = avail.lastIndexOf(0x0a, want - 1);
  if (nl >= start) return { start, end: nl + 1, truncatedLine: false };
  // One line longer than the window: cut after the last whole character.
  let k = want - 1;
  while (k > start && ((avail[k] as number) & 0xc0) === 0x80) k -= 1;
  const len = utf8SeqLen(avail[k] as number);
  let end = k + len <= want ? want : k;
  // A window smaller than one character still moves forward by that character.
  if (end <= start) end = Math.min(avail.length, k + len);
  return { start, end, truncatedLine: true };
}

/**
 * Where a UTF-16 window ends: on a code unit, after the last newline, never
 * inside a surrogate pair. With `skipLead`, a window that starts on the low
 * half of a pair skips it (the previous window held the pair).
 */
function cutUtf16(avail: Buffer, want: number, atEnd: boolean, le: boolean, skipLead: boolean): Cut {
  const unit = (i: number) => (le ? (avail[i] as number) | ((avail[i + 1] as number) << 8) : ((avail[i] as number) << 8) | (avail[i + 1] as number));
  const start = skipLead && avail.length >= 2 && (unit(0) & 0xfc00) === 0xdc00 ? 2 : 0;
  let w = want - (want % 2);
  if (w === 0) w = Math.min(2, avail.length - (avail.length % 2));
  if (atEnd) return { start, end: Math.max(w, start), truncatedLine: false };
  for (let i = w - 2; i >= start; i -= 2) if (unit(i) === 0x0a) return { start, end: i + 2, truncatedLine: false };
  let end = w;
  if (end >= start + 2 && (unit(end - 2) & 0xfc00) === 0xd800) end -= 2;
  // A window smaller than one character still moves forward by that character.
  if (end <= start) end = Math.min(start + 4, avail.length - (avail.length % 2));
  return { start, end, truncatedLine: true };
}

function eolOf(text: string): FileText['eol'] {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 0x0d) crlf += 1;
    else lf += 1;
  }
  if (crlf > 0) return lf > 0 ? 'mixed' : 'crlf';
  return 'lf';
}

function minified(text: string): boolean {
  let lines = 0;
  let longest = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf('\n', from);
    const end = i === -1 ? text.length : i;
    if (end > from || i !== -1) lines += 1;
    longest = Math.max(longest, end - from);
    if (i === -1) break;
    from = i + 1;
  }
  if (longest > MINIFIED_LONG_LINE) return true;
  return lines > 0 && text.length / lines > MINIFIED_AVG_LINE;
}

/** `masked`: a secret token in the window was masked (its prefix alone may not look secret any more). */
export function textWarnings(text: string, truncatedLine: boolean, masked = false): FileTextWarning[] {
  const out: FileTextWarning[] = [];
  if (BIDI_RE.test(text)) out.push('bidi');
  if (masked || looksSecret(text)) out.push('secret-like');
  if (minified(text)) out.push('minified');
  if (truncatedLine) out.push('truncated-line');
  return out;
}

/**
 * `raw` with each span of `scanned` (its text: latin1 for UTF-8, one
 * character per byte; decoded for UTF-16, one per code unit) set to '*'.
 * A copy; the tokens are ASCII, so every byte offset stays where it was.
 */
function maskBytes(raw: Buffer, spans: readonly (readonly [number, number])[], encoding: TextEncoding): Buffer {
  const out = Buffer.from(raw);
  for (const [from, to] of spans) {
    for (let i = from; i < to; i++) {
      if (encoding === 'utf-8') out[i] = 0x2a;
      else if (encoding === 'utf-16le') out.writeUInt16LE(0x2a, 2 * i);
      else out.writeUInt16BE(0x2a, 2 * i);
    }
  }
  return out;
}

/**
 * Read one window. `bytes` is how many file bytes the window covers (for
 * the audit row). Refusals: `too_large` (over 64 MiB), `unsupported_type`
 * (binary), `protected` (a private key block).
 */
export async function readWindow(
  file: OpenedFile,
  q: { offset: number; max: number },
  meta: { mtime: string; language?: string | undefined },
): Promise<{ text: FileText; bytes: number } | FileRefusal> {
  const size = file.stat.size;
  if (size > TEXT_MAX_FILE) return refuse('too_large', TOO_LARGE_TEXT_MESSAGE);
  const head = await readHead(file);
  if (head.binary) return refuse('unsupported_type', BINARY_MESSAGE);
  const utf16 = head.encoding !== 'utf-8';
  let offset = Math.max(q.offset, head.bom);
  if (utf16 && (offset - head.bom) % 2 === 1) offset -= 1;
  const base = { size, bom: head.bom > 0, mtime: meta.mtime, ...(meta.language ? { language: meta.language } : {}) };
  if (offset >= size) {
    return { text: { ...base, text: '', offset: Math.min(offset, size), next: null, eol: 'lf', warnings: [] }, bytes: 0 };
  }

  const scanStart = Math.max(0, offset - KEY_MARGIN);
  const scanEnd = Math.min(size, offset + q.max + KEY_MARGIN);
  const raw = await readRange(file.fh, scanStart, scanEnd - scanStart);
  // The key markers and the tokens are ASCII: latin1 never fails and keeps every byte for UTF-8.
  const scanned = utf16 ? new TextDecoder(head.encoding, { ignoreBOM: true }).decode(evenLength(raw)) : raw.toString('latin1');
  // Masked across the margins too, so a token that starts before the window is hidden inside it.
  const spans = secretSpans(scanned);
  const buf = spans.length === 0 ? raw : maskBytes(raw, spans, head.encoding);
  const avail = buf.subarray(Math.min(buf.length, offset - scanStart));
  // The file may have shrunk since it was opened: the window ends where the bytes do.
  const want = Math.min(q.max, size - offset, avail.length);
  const atEnd = offset + want >= size || avail.length <= want;
  if (want <= 0) return { text: { ...base, text: '', offset, next: null, eol: 'lf', warnings: [] }, bytes: 0 };
  const cut = utf16 ? cutUtf16(avail, want, atEnd, head.encoding === 'utf-16le', offset > head.bom) : cutUtf8(avail, want, atEnd, offset > head.bom);

  let text: string;
  try {
    text = new TextDecoder(head.encoding, { fatal: true, ignoreBOM: true }).decode(avail.subarray(cut.start, cut.end));
  } catch {
    return refuse('unsupported_type', BINARY_MESSAGE);
  }
  if (holdsPrivateKey(scanned)) return refuse('protected', KEY_MESSAGE);

  const end = offset + cut.end;
  const unit = utf16 ? 2 : 1;
  const from = offset - scanStart + cut.start;
  const to = offset - scanStart + cut.end;
  const masked = spans.some(([a, b]) => a * unit < to && b * unit > from);
  return {
    text: {
      ...base,
      text,
      offset: offset + cut.start,
      next: atEnd || end >= size ? null : end,
      eol: eolOf(text),
      warnings: textWarnings(text, cut.truncatedLine, masked),
    },
    bytes: cut.end - cut.start,
  };
}
