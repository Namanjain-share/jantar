/**
 * What the composer knows of a picked file before it is prepared (v0.4.2's
 * attachments; split out in v0.5.1): its own name, its extension and
 * whether it is a photo. Split from convert.ts so the composer can number and queue chips without loading the
 * preparation itself, which sends.ts loads with `import()` the first time a
 * file is attached (it is not part of the app's first load).
 */

/** Image extensions for files that come without a type. */
const IMAGE_TYPES = new Map<string, string>([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
]);

/** A name the clipboard makes up for a pasted image: "image.png". */
const CLIPBOARD_NAME = /^image\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;

/** The lower-cased extension without the dot; "" for none and for dot names like ".zshrc". */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** The file's own name without folders, or "" when it has none of its own (a paste: "image.png"). */
export function ownName(file: File): string {
  const base = file.name.split(/[\\/]/).pop()?.trim() ?? '';
  return CLIPBOARD_NAME.test(base) ? '' : base;
}

/** SVG is text: XML that Claude reads as it is. */
export const SVG_TYPE = 'image/svg+xml';

/** The image type a file has, by its type or else its extension; null when it is not an image (SVG is not one here). */
export function imageType(file: File): string | null {
  const type = file.type.toLowerCase();
  if (type === SVG_TYPE) return null;
  if (type.startsWith('image/')) return type;
  if (type) return null;
  return IMAGE_TYPES.get(extOf(file.name)) ?? null;
}

/** Whether the file is a photo or picture (the composer calls a nameless one "image N"). */
export function isImage(file: File): boolean {
  return imageType(file) !== null;
}
