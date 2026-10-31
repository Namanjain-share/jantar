/**
 * Preparing a file on the phone before it is uploaded (v0.4.2, spec 6.2).
 * Photos become JPEG (long edge at most UPLOAD_IMAGE_EDGE, quality 0.85),
 * which makes HEIC readable by Claude and drops EXIF, GPS included; GIF stays
 * as it is; PNG and WebP stay when small enough and free of metadata chunks
 * (EXIF, XMP, text), else are drawn again as PNG (or JPEG when that is too
 * big), which drops them; PDF, office documents and
 * text go as they are, and so does SVG, as text (its source is what Claude
 * can read and edit; drawn as a JPEG it would be a picture of it); video,
 * audio and anything Claude can't read are
 * refused with a sentence for the chip. Canvas only: no `data:` URLs (the
 * CSP allows `blob:` images).
 *
 * The kind is decided by `file.type`, then by the extension (iOS gives some
 * files no type). The daemon decides again from the bytes (uploads/sniff.ts):
 * this only spares the phone an upload the Mac would refuse, and turns
 * photos into something Claude reads. A JPEG the browser can't decode is
 * refused (its EXIF could not be removed); another photo it can't decode
 * goes as it is, and the daemon refuses HEIC with its own sentence.
 */
import { UPLOAD_IMAGE_EDGE, UPLOAD_MAX_BYTES, UPLOAD_TEXT_MAX_BYTES, type UploadKind } from '@jantar/protocol';
import { SVG_TYPE, extOf, imageType, ownName } from './names.js';

export { extOf, isImage, ownName } from './names.js';

/** A file ready to upload. */
export interface PreparedFile {
  blob: Blob;
  /** The stored file's extension ("jpg" for a converted photo); "" when the file has none Jantar can name. */
  ext: string;
  kind: UploadKind;
  /** The name the chip and the prompt use (the file's own, without folders; "" for a pasted one, which the composer numbers). */
  name: string;
}

/** PNG and WebP go as they are up to this many bytes (and UPLOAD_IMAGE_EDGE on each side): what Claude takes as is. */
export const KEEP_IMAGE_BYTES = 3.75 * 1024 * 1024;
export const JPEG_QUALITY = 0.85;

/** The chip's sentence for a file the phone won't upload. */
export const REFUSED = {
  media: "Claude can't watch video or listen to audio",
  kind: "Claude can't read this kind of file",
  large: 'Larger than 20 MB',
  text: 'Text files up to 2 MB',
  photo: "This phone can't read the photo, so its location data can't be removed",
} as const;

/** PNG chunks and WebP chunks that hold metadata: EXIF (a location, a camera, a date), XMP, text. */
const PNG_META = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);
const WEBP_META = new Set(['EXIF', 'XMP ']);

/** What the upload route takes in `?ext=` (UploadQuerySchema). */
const EXT_OK = /^[a-z0-9]{1,8}$/;

const MEDIA_EXTS = new Set(['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', '3gp', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'caf']);

const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);

/**
 * Text and code by extension, mirroring the daemon's allowlist (plain text,
 * Markdown, data, and the code of files/kinds.ts). Another text file goes as
 * "txt"; so does one whose extension is longer than the route takes.
 */
const TEXT_EXTS = new Set([
  ...['txt', 'text', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonc', 'json5', 'jsonl', 'log', 'rst', 'adoc', 'lock', 'ipynb'],
  ...['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift'],
  ...['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql'],
  ...['graphql', 'gql', 'proto', 'lua', 'pl', 'r', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'ml'],
  ...['vue', 'svelte', 'astro', 'html', 'htm', 'xml', 'plist', 'css', 'scss', 'sass', 'less', 'yaml', 'yml', 'toml'],
  ...['ini', 'cfg', 'conf', 'tf', 'hcl', 'gradle', 'groovy', 'diff', 'patch', 'tex', 'mk'],
]);

/** Text files known by their whole name. */
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'containerfile', 'gemfile', 'rakefile', 'license', 'licence', 'readme', 'changelog']);

/** Types that are text without saying text/. */
const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-sh', 'application/x-yaml', 'application/toml']);

/** The name without its extension ("IMG_0412.HEIC" gives "IMG_0412"). */
function stemOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/** A decoded image and the object URL behind it (`done` revokes it). */
interface Decoded {
  img: HTMLImageElement;
  width: number;
  height: number;
  done: () => void;
}

/** Decode `blob` in an `<img>` (which applies the EXIF orientation); null when the browser can't. */
async function decode(blob: Blob): Promise<Decoded | null> {
  let url: string;
  try {
    url = URL.createObjectURL(blob);
  } catch {
    return null;
  }
  const done = () => URL.revokeObjectURL(url);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) {
      done();
      return null;
    }
    return { img, width, height, done };
  } catch {
    done();
    return null;
  }
}

/**
 * Whether a PNG or WebP holds metadata chunks, read from its bytes (true when they can't be read). PNG:
 * an 8-byte signature, then chunks of length (big-endian), type, data and CRC. WebP: "RIFF", a size,
 * "WEBP", then chunks of id, size (little-endian) and data padded to an even length.
 */
async function carriesMetadata(file: Blob, type: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return true;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (type === 'image/png') {
    for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
      const t = tag(at + 4);
      if (PNG_META.has(t)) return true;
      // Bytes after the image's end are kept by the file, whatever they hold.
      if (t === 'IEND') return at + 12 < bytes.length;
    }
    return false;
  }
  for (let at = 12; at + 8 <= bytes.length; ) {
    if (WEBP_META.has(tag(at))) return true;
    const size = view.getUint32(at + 4, true);
    at += 8 + size + (size % 2);
  }
  return false;
}

/**
 * Draw the image on a canvas with its long edge at most UPLOAD_IMAGE_EDGE and encode it (JPEG, or PNG,
 * which keeps transparency); null on failure. Nothing of the file but its pixels survives.
 */
async function drawAs(d: Decoded, type: 'image/jpeg' | 'image/png'): Promise<Blob | null> {
  const scale = Math.min(1, UPLOAD_IMAGE_EDGE / Math.max(d.width, d.height));
  const width = Math.max(1, Math.round(d.width * scale));
  const height = Math.max(1, Math.round(d.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (type === 'image/jpeg') {
      // JPEG has no transparency: a see-through PNG gets a white page, not black.
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(d.img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, type === 'image/jpeg' ? JPEG_QUALITY : undefined));
    // A browser that can't encode the type gives PNG (or nothing): only the type asked for counts.
    return blob && blob.type === type ? blob : null;
  } catch {
    return null;
  } finally {
    // iOS keeps a canvas's pixels until it is shrunk.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** The extension a file goes with as it is, when the route takes it ("" sends none: the daemon names images by their bytes). */
function ownExt(file: File): string {
  const ext = extOf(file.name);
  return EXT_OK.test(ext) ? ext : '';
}

async function prepareImage(file: File, type: string, name: string): Promise<PreparedFile | { refused: string }> {
  if (type === 'image/gif') return { blob: file, ext: 'gif', kind: 'image', name };
  // Not decoded here: the original goes, and the daemon says why it can't take it (HEIC). A JPEG would go
  // with its EXIF, GPS included: refused.
  const original = (): PreparedFile | { refused: string } =>
    type === 'image/jpeg' ? { refused: REFUSED.photo } : { blob: file, ext: ownExt(file), kind: 'image', name };
  const d = await decode(file);
  if (!d) return original();
  try {
    const small = (type === 'image/png' || type === 'image/webp') && Math.max(d.width, d.height) <= UPLOAD_IMAGE_EDGE && file.size <= KEEP_IMAGE_BYTES;
    if (small && !(await carriesMetadata(file, type))) return { blob: file, ext: type === 'image/png' ? 'png' : 'webp', kind: 'image', name };
    // A small one with metadata is drawn again as PNG, its pixels only, while that stays small.
    const png = small ? await drawAs(d, 'image/png') : null;
    if (png && png.size <= KEEP_IMAGE_BYTES) return { blob: png, ext: 'png', kind: 'image', name: stemOf(name) };
    const jpeg = await drawAs(d, 'image/jpeg');
    // The stored file is .jpg; the label keeps the name without its old extension.
    return jpeg ? { blob: jpeg, ext: 'jpg', kind: 'image', name: stemOf(name) } : original();
  } finally {
    d.done();
  }
}

function isText(file: File, ext: string, name: string): boolean {
  const type = file.type.toLowerCase();
  return type.startsWith('text/') || TEXT_TYPES.has(type) || type === SVG_TYPE || ext === 'svg' || TEXT_EXTS.has(ext) || TEXT_NAMES.has(name.toLowerCase());
}

export async function prepareFile(file: File): Promise<PreparedFile | { refused: string }> {
  const name = ownName(file);
  const type = file.type.toLowerCase();
  const ext = extOf(file.name);
  if (type.startsWith('video/') || type.startsWith('audio/') || MEDIA_EXTS.has(ext)) return { refused: REFUSED.media };
  const image = imageType(file);
  let out: PreparedFile;
  if (image) {
    const p = await prepareImage(file, image, name);
    if ('refused' in p) return p;
    out = p;
  } else if (type === 'application/pdf' || ext === 'pdf') {
    out = { blob: file, ext: 'pdf', kind: 'pdf', name };
  } else if (OFFICE_EXTS.has(ext)) {
    out = { blob: file, ext, kind: 'office', name };
  } else if (isText(file, ext, name)) {
    if (file.size > UPLOAD_TEXT_MAX_BYTES) return { refused: REFUSED.text };
    out = { blob: file, ext: TEXT_EXTS.has(ext) && EXT_OK.test(ext) ? ext : 'txt', kind: 'text', name };
  } else {
    return { refused: REFUSED.kind };
  }
  return out.blob.size > UPLOAD_MAX_BYTES ? { refused: REFUSED.large } : out;
}
