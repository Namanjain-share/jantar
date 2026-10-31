/**
 * A PDF (v0.3 spec 5.2.3, P1): "PDF · 12.4 MB · Open" first, since the
 * bytes and pdf.js are both large. On Open, the bytes come from
 * GET /v1/files/raw as a Blob and go to pdf.js whole (pdf.ts has the inert
 * options). Pages are canvases drawn only on or near the screen, at most
 * three alive at once; the rest are empty boxes of the right shape. No text
 * layer, no annotation layer, no links.
 *
 * Which pages are alive: two observers for the whole document, both rooted
 * at the scroller the pages move in (the viewport would see them clipped).
 * One measures how much of each page is on screen, the other which pages
 * are within 200 px of it. Pages on screen come first, the most visible
 * first and the higher one on a tie; pages just off screen fill what is
 * left, so the next page is often drawn before it scrolls in.
 */
import { FilePdfIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { FILES_RAW_PDF_MAX } from '@jantar/protocol';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { useOffline } from './data.js';
import { sizeText } from './model.js';
import { LoadError } from './states.js';
import { PDF_OPTIONS, loadPdfjs } from './pdf.js';

/** Canvases kept drawn at once. */
export const PDF_ALIVE = 3;

type Phase = { name: 'idle' } | { name: 'loading' } | { name: 'ready'; doc: PDFDocumentProxy; ratio: number } | { name: 'error'; error: unknown };

/** How far past the scroller's edges a page counts as near. */
const NEAR = '200px 0px';
/** Steps at which a page's on-screen share is measured again. */
const STEPS = [0, 0.25, 0.5, 0.75, 1];

/**
 * The pages to draw, in page order: those on screen (`shown`, page to the
 * share of it in view), most visible first and the lower page on a tie,
 * then those only near the screen, in page order; at most PDF_ALIVE.
 */
export function pickAlive(shown: ReadonlyMap<number, number>, near: ReadonlySet<number>): number[] {
  const first = [...shown].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n]) => n);
  const rest = [...near].filter((n) => !shown.has(n)).sort((a, b) => a - b);
  return [...first, ...rest].slice(0, PDF_ALIVE).sort((a, b) => a - b);
}

function same(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Track the pages (`[data-page]` boxes) inside `scroller` and keep `alive` to the ones to draw. */
function useAlivePages(scroller: RefObject<HTMLDivElement | null>, doc: PDFDocumentProxy | null, setAlive: (f: (a: number[]) => number[]) => void) {
  useEffect(() => {
    const root = scroller.current;
    if (!doc || !root) return;
    // Without IntersectionObserver (tests, very old browsers): the first pages.
    if (typeof IntersectionObserver === 'undefined') {
      const first = Array.from({ length: Math.min(PDF_ALIVE, doc.numPages) }, (_, i) => i + 1);
      setAlive(() => first);
      return;
    }
    const shown = new Map<number, number>();
    const near = new Set<number>();
    const update = () =>
      setAlive((a) => {
        const next = pickAlive(shown, near);
        return same(a, next) ? a : next;
      });
    const pageOf = (e: IntersectionObserverEntry) => Number((e.target as HTMLElement).dataset.page);
    const onScreen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) shown.set(pageOf(e), e.intersectionRatio);
          else shown.delete(pageOf(e));
        }
        update();
      },
      { root, threshold: STEPS },
    );
    const nearScreen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) near.add(pageOf(e));
          else near.delete(pageOf(e));
        }
        update();
      },
      { root, rootMargin: NEAR },
    );
    for (const el of root.querySelectorAll<HTMLElement>('[data-page]')) {
      onScreen.observe(el);
      nearScreen.observe(el);
    }
    return () => {
      onScreen.disconnect();
      nearScreen.disconnect();
    };
  }, [scroller, doc, setAlive]);
}

function Page({ doc, n, ratio, alive }: { doc: PDFDocumentProxy; n: number; ratio: number; alive: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shape, setShape] = useState(ratio);

  useEffect(() => {
    if (!alive) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    let release: (() => void) | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(n);
        if (cancelled) return;
        release = () => page.cleanup();
        const base = page.getViewport({ scale: 1 });
        setShape(base.height / base.width);
        const width = box.current?.clientWidth || 800;
        const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
        const viewport = page.getViewport({ scale: (width * dpr) / base.width });
        const c = canvas.current;
        if (!c || cancelled) return;
        c.width = Math.floor(viewport.width);
        c.height = Math.floor(viewport.height);
        const render = page.render({ canvas: c, viewport, annotationMode: 0 });
        task = render;
        await render.promise;
      } catch {
        // A cancelled or broken page stays an empty box.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      // Free the bitmap: a zero-size canvas holds no pixels.
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
      release?.();
    };
  }, [alive, doc, n]);

  return (
    <div
      ref={box}
      data-page={n}
      role="img"
      aria-label={`Page ${n}`}
      className="relative w-full overflow-hidden rounded-btn border border-line bg-surface"
      // The page's own shape before it is drawn (CSSOM style, CSP-safe).
      style={{ aspectRatio: `1 / ${shape}` }}
    >
      <canvas ref={canvas} className="block h-auto w-full" data-alive={alive ? 'true' : undefined} />
      <span className="absolute bottom-6 right-8 type-mono text-ink-3">{n}</span>
    </div>
  );
}

export function PdfView({ root, path, size }: { root: string; path: string; size: number }) {
  const { api } = useDeps();
  const offline = useOffline();
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [alive, setAlive] = useState<number[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const job = useRef<{ abort: AbortController; destroy?: () => void } | null>(null);
  const tooBig = size > FILES_RAW_PDF_MAX;

  // Leaving the view drops the request, the document and its worker.
  useEffect(
    () => () => {
      job.current?.abort.abort();
      job.current?.destroy?.();
      job.current = null;
    },
    [],
  );

  const open = async () => {
    job.current?.abort.abort();
    job.current?.destroy?.();
    const abort = new AbortController();
    const mine: { abort: AbortController; destroy?: () => void } = { abort };
    job.current = mine;
    setPhase({ name: 'loading' });
    try {
      const blob = await api.filesRaw({ root, path }, { signal: abort.signal });
      const data = new Uint8Array(await blob.arrayBuffer());
      const lib = await loadPdfjs();
      if (job.current !== mine) return;
      const task = lib.getDocument({ data, ...PDF_OPTIONS });
      mine.destroy = () => void task.destroy();
      const doc = await task.promise;
      const first = await doc.getPage(1);
      const base = first.getViewport({ scale: 1 });
      if (job.current !== mine) return;
      setAlive([]);
      setPhase({ name: 'ready', doc, ratio: base.height / base.width });
    } catch (error) {
      if (job.current === mine && !abort.signal.aborted) setPhase({ name: 'error', error });
    }
  };
  useAlivePages(scroller, phase.name === 'ready' ? phase.doc : null, setAlive);

  if (phase.name === 'ready') {
    const pages = Array.from({ length: phase.doc.numPages }, (_, i) => i + 1);
    return (
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-16 py-16 md:px-24">
        <p className="mb-12 type-mono text-ink-3">
          PDF · {sizeText(size)} · {pages.length === 1 ? '1 page' : `${pages.length} pages`}
        </p>
        <div className="flex flex-col gap-12">
          {pages.map((n) => (
            <Page key={n} doc={phase.doc} n={n} ratio={phase.ratio} alive={alive.includes(n)} />
          ))}
        </div>
      </div>
    );
  }
  if (phase.name === 'error') {
    return <LoadError error={phase.error} offline={offline} onRetry={() => void open()} />;
  }
  return (
    <div className="px-16 py-16 md:px-24">
      <p className="flex items-center gap-8 type-mono text-ink-3">
        <FilePdfIcon size={20} aria-hidden="true" className="text-ink-2" />
        PDF · {sizeText(size)}
      </p>
      {tooBig ? (
        <p className="mt-8 type-small text-ink-2">Jantar opens PDFs up to {sizeText(FILES_RAW_PDF_MAX)}.</p>
      ) : (
        <div className="mt-12 flex items-center gap-12">
          <Button variant="primary" onClick={() => void open()} disabled={phase.name === 'loading' || offline}>
            Open
          </Button>
          {phase.name === 'loading' ? <Spinner label="Opening the PDF" /> : null}
        </div>
      )}
      {offline && !tooBig ? <p className="mt-8 type-small text-ink-2">Offline: can't open it right now.</p> : null}
    </div>
  );
}
