/**
 * pdf.js's standard fonts, from the app's own origin. A PDF may name one of
 * the 14 base fonts (Helvetica, Times, Courier, Symbol, ZapfDingbats) without
 * embedding it; pdf.js then draws it from these files. Without them it
 * falls back to a guessed shape, and text in such a PDF comes out wrong.
 *
 * Each file is a `?url` import, so Vite emits it next to the app (hashed,
 * never inlined as data:) and it loads like any other asset: same origin,
 * connect-src 'self', no CDN. pdf.js names a file and its base URL
 * (`standardFontDataUrl`) would need the files unhashed in one folder, so
 * pdf.ts hands it `SameOriginFontData` as its BinaryDataFactory instead:
 * pdf.js asks it for a file by name, on the page's side (useWorkerFetch is
 * off), and it answers with the bytes. CMaps and wasm stay refused, as
 * before (useWasm is off; a CJK PDF without its CMaps draws what it can).
 */
import foxitDingbats from 'pdfjs-dist/standard_fonts/FoxitDingbats.pfb?url';
import foxitFixed from 'pdfjs-dist/standard_fonts/FoxitFixed.pfb?url';
import foxitFixedBold from 'pdfjs-dist/standard_fonts/FoxitFixedBold.pfb?url';
import foxitFixedBoldItalic from 'pdfjs-dist/standard_fonts/FoxitFixedBoldItalic.pfb?url';
import foxitFixedItalic from 'pdfjs-dist/standard_fonts/FoxitFixedItalic.pfb?url';
import foxitSerif from 'pdfjs-dist/standard_fonts/FoxitSerif.pfb?url';
import foxitSerifBold from 'pdfjs-dist/standard_fonts/FoxitSerifBold.pfb?url';
import foxitSerifBoldItalic from 'pdfjs-dist/standard_fonts/FoxitSerifBoldItalic.pfb?url';
import foxitSerifItalic from 'pdfjs-dist/standard_fonts/FoxitSerifItalic.pfb?url';
import foxitSymbol from 'pdfjs-dist/standard_fonts/FoxitSymbol.pfb?url';
import liberationSansBold from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url';
import liberationSansBoldItalic from 'pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf?url';
import liberationSansItalic from 'pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf?url';
import liberationSansRegular from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url';

/** pdf.js's file name -> where this app serves it. A Map: the name comes from the PDF's side. */
export const STANDARD_FONTS: ReadonlyMap<string, string> = new Map([
  ['FoxitDingbats.pfb', foxitDingbats],
  ['FoxitFixed.pfb', foxitFixed],
  ['FoxitFixedBold.pfb', foxitFixedBold],
  ['FoxitFixedBoldItalic.pfb', foxitFixedBoldItalic],
  ['FoxitFixedItalic.pfb', foxitFixedItalic],
  ['FoxitSerif.pfb', foxitSerif],
  ['FoxitSerifBold.pfb', foxitSerifBold],
  ['FoxitSerifBoldItalic.pfb', foxitSerifBoldItalic],
  ['FoxitSerifItalic.pfb', foxitSerifItalic],
  ['FoxitSymbol.pfb', foxitSymbol],
  ['LiberationSans-Bold.ttf', liberationSansBold],
  ['LiberationSans-BoldItalic.ttf', liberationSansBoldItalic],
  ['LiberationSans-Italic.ttf', liberationSansItalic],
  ['LiberationSans-Regular.ttf', liberationSansRegular],
]);

/** What pdf.js asks its BinaryDataFactory for. */
export interface BinaryDataRequest {
  kind: string;
  filename: string;
}

/**
 * pdf.js's BinaryDataFactory (it calls `new` with its URL options, which
 * this ignores, then `fetch` per file): standard fonts only, by name, from
 * this origin.
 */
export class SameOriginFontData {
  async fetch({ kind, filename }: BinaryDataRequest): Promise<Uint8Array> {
    const url = kind === 'standardFontDataUrl' ? STANDARD_FONTS.get(filename) : undefined;
    if (!url) throw new Error(`Jantar does not serve pdf.js ${kind} data: ${filename}`);
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Unable to load font data at: ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
