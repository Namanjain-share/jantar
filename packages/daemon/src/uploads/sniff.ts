/**
 * What an upload is, from its bytes alone (v0.4.2, spec 6.4). Claude's Read
 * routes a file by its extension and fails when the bytes disagree, so the
 * stored extension comes from the bytes:
 *
 * - an image Claude sees: png, jpeg, gif or webp, by the magic bytes
 *   files/raw.ts checks;
 * - a PDF (`%PDF-` at 0);
 * - an office document: a zip, kept only when the phone named it docx, xlsx
 *   or pptx (Claude reads those through a skill or a shell command);
 * - UTF-8 text (files/text.ts sniffHead over every byte: no NUL, valid
 *   UTF-8, not control-heavy), stored under the phone's `ext` when it is in
 *   TEXT_UPLOAD_EXTS, else as txt.
 *
 * HEIC is refused with its own sentence (Claude can't read it; the phone
 * converts photos to JPEG first). Everything else is refused. The phone's
 * `ext` never makes bytes an image or a PDF.
 */
import { UPLOAD_MAX_BYTES, UPLOAD_TEXT_MAX_BYTES, type UploadKind } from '@jantar/protocol';
import { UPLOAD_TOO_LARGE } from '../api/errors.js';
import type { UploadErrorCode } from '../contracts.js';
import { RAW_TYPES } from '../files/raw.js';
import { SNIFF_BYTES, sniffHead } from '../files/text.js';

/** The kind and the stored extension, or why the bytes are refused (the API answers with the code). */
export type SniffResult = { ok: true; kind: UploadKind; ext: string } | { ok: false; code: UploadErrorCode; reason: string };

export const EMPTY_UPLOAD = 'This file is empty';
export const HEIC_REFUSED = "Claude can't read HEIC. The app sends photos as JPEG; this phone couldn't convert it.";
export const TYPE_REFUSED = "Claude can't read this kind of file";
export const TEXT_TOO_LARGE = 'Text files up to 2 MB';

/**
 * Extensions a text upload keeps; any other text is stored as txt. The plain
 * ones, then the text and Markdown kinds of files/kinds.ts that fit the
 * upload query's eight characters (test/uploads/sniff.test.ts checks each
 * against kindOf).
 */
export const TEXT_UPLOAD_EXTS: ReadonlySet<string> = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonc', 'json5', 'jsonl', 'log', 'rst', 'adoc', 'lock',
  'ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql',
  'graphql', 'gql', 'proto', 'lua', 'pl', 'r', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'ml',
  'vue', 'svelte', 'astro', 'html', 'htm', 'xml', 'plist', 'css', 'scss', 'sass', 'less',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'tf', 'hcl', 'gradle', 'groovy', 'diff', 'patch', 'tex', 'mk',
]);

/** Zip-based documents kept as office files, by the phone's `ext`; any other zip is refused. */
export const OFFICE_UPLOAD_EXTS: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx']);

/** The images Claude's Read takes, in the order the magic bytes are tried; the stored extension is the key. */
const IMAGE_EXTS = ['png', 'jpg', 'gif', 'webp'] as const;

/** ISO-BMFF major brands of HEIC and HEIF stills and sequences (`....ftyp<brand>`). */
const HEIF_BRANDS: ReadonlySet<string> = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

function heif(b: Buffer): boolean {
  return b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(b.toString('latin1', 8, 12));
}

function zip(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** Valid UTF-8 (a BOM is fine) with no NUL and few control characters. */
function utf8Text(b: Buffer): boolean {
  const head = sniffHead(b);
  return head.encoding === 'utf-8' && !head.binary;
}

const refuse = (code: UploadErrorCode, reason: string): SniffResult => ({ ok: false, code, reason });

/** What `bytes` are and the extension to store them under; `ext` is the phone's hint for text and office files. */
export function sniffUpload(bytes: Buffer, ext?: string): SniffResult {
  if (bytes.length === 0) return refuse('invalid_request', EMPTY_UPLOAD);
  if (bytes.length > UPLOAD_MAX_BYTES) return refuse('payload_too_large', UPLOAD_TOO_LARGE);
  if (heif(bytes)) return refuse('unsupported_media_type', HEIC_REFUSED);
  for (const image of IMAGE_EXTS) {
    if (RAW_TYPES.get(image)?.magic(bytes)) return { ok: true, kind: 'image', ext: image };
  }
  if (RAW_TYPES.get('pdf')?.magic(bytes)) return { ok: true, kind: 'pdf', ext: 'pdf' };
  if (zip(bytes)) {
    return ext !== undefined && OFFICE_UPLOAD_EXTS.has(ext) ? { ok: true, kind: 'office', ext } : refuse('unsupported_media_type', TYPE_REFUSED);
  }
  // Text is judged on every byte; a file over the text cap only on its head, to pick the sentence.
  if (bytes.length > UPLOAD_TEXT_MAX_BYTES) {
    return utf8Text(bytes.subarray(0, SNIFF_BYTES)) ? refuse('payload_too_large', TEXT_TOO_LARGE) : refuse('unsupported_media_type', TYPE_REFUSED);
  }
  if (!utf8Text(bytes)) return refuse('unsupported_media_type', TYPE_REFUSED);
  return { ok: true, kind: 'text', ext: ext !== undefined && TEXT_UPLOAD_EXTS.has(ext) ? ext : 'txt' };
}
