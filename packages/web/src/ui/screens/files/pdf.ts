/**
 * pdf.js on demand (v0.3 spec 5.2.3): its own chunk, loaded the first time a
 * PDF is opened, never with the app. Its worker comes from a `?url` import,
 * a same-origin file Vite emits (worker-src 'self'), never blob: or data:.
 *
 * The options keep it inert under the strict CSP: no WebAssembly
 * (no 'wasm-unsafe-eval'), no XFA forms, no FontFace (glyphs are drawn as
 * paths), and the bytes are handed over whole, so it never fetches the
 * document. The one thing it reads besides is a standard font a PDF names
 * without embedding, from this app's own files (pdf-fonts.ts).
 */
import { SameOriginFontData } from './pdf-fonts.js';

export type PdfLib = typeof import('pdfjs-dist');

/** The getDocument options every PDF gets (besides its bytes). */
export const PDF_OPTIONS = {
  useWasm: false,
  enableXfa: false,
  disableFontFace: true,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  useWorkerFetch: false,
  BinaryDataFactory: SameOriginFontData,
  maxImageSize: 16e6,
} as const;

let loading: Promise<PdfLib> | null = null;

export function loadPdfjs(): Promise<PdfLib> {
  loading ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  // A failed chunk load (offline) can be tried again.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
