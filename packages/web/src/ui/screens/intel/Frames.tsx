/**
 * A read item's thumbnails (v0.8 spec 7, 8): small JPEGs the Mac keeps
 * (`GET /v1/intel/items/:id/frames/:n`, frame 0 the cover when there is
 * one). Each comes through `api.intelFrame` as a Blob shown by an object URL
 * that is revoked when the view goes (as a meeting's screenshot), asked for
 * only once its box is on screen, and dropped when the view leaves (the
 * download is aborted). One that fails leaves its quiet box; nothing is
 * cached between views.
 *
 * - `RowThumb`: 48 px, frame 0, on a row of the list.
 * - `FrameStrip`: the item page's strip, sideways; a tap opens the larger
 *   view in a sheet with the same bytes.
 */
import { ImageIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useDeps } from '../../context.js';
import { Sheet } from '../../kit/Sheet.js';
import { useObjectUrl } from '../files/blob.js';

/** True once `ref`'s box has been on screen (stays true); at once where IntersectionObserver is missing. */
function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      setSeen(true);
      io.disconnect();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, ref]);
  return seen;
}

/** Frame `n` of item `id` as a Blob while `on` (null until it comes, or when it fails); aborted when the view goes. */
export function useFrame(id: string, n: number, on: boolean): Blob | null {
  const { api } = useDeps();
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    if (!on) return;
    const ac = new AbortController();
    setBlob(null);
    api.intelFrame(id, n, { signal: ac.signal }).then(
      (b) => {
        if (!ac.signal.aborted) setBlob(b);
      },
      () => undefined,
    );
    return () => ac.abort();
  }, [api, id, n, on]);
  return blob;
}

/** Frame 0 at 48 px on the right of a row (decorative: the row's title names it). */
export function RowThumb({ id }: { id: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const url = useObjectUrl(useFrame(id, 0, useSeen(box)));
  return (
    <span ref={box} data-thumb className="block size-48 flex-none overflow-hidden rounded-btn border border-line bg-surface">
      {url ? <img src={url} alt="" className="block size-full object-cover" /> : null}
    </span>
  );
}

function StripFrame({ id, n, count, onOpen }: { id: string; n: number; count: number; onOpen: (n: number, blob: Blob | null) => void }) {
  const box = useRef<HTMLButtonElement>(null);
  const blob = useFrame(id, n, useSeen(box));
  const url = useObjectUrl(blob);
  return (
    <li className="flex-none">
      <button
        ref={box}
        type="button"
        aria-label={`Picture ${n + 1} of ${count}`}
        onClick={() => onOpen(n, blob)}
        className="block h-96 overflow-hidden rounded-btn border border-line bg-surface transition-colors duration-120 ease-hover hover:border-line-strong"
      >
        {url ? (
          <img src={url} alt="" className="block h-full w-auto max-w-160 object-cover" />
        ) : (
          <span data-placeholder className="flex h-full w-72 items-center justify-center text-ink-3">
            <ImageIcon size={16} aria-hidden="true" />
          </span>
        )}
      </button>
    </li>
  );
}

/** The larger view: the bytes the strip already has, else asked for again. */
function FrameView({ id, open, onClose }: { id: string; open: { n: number; count: number; blob: Blob | null } | null; onClose: () => void }) {
  const again = useFrame(id, open?.n ?? 0, open !== null && open.blob === null);
  const url = useObjectUrl(open?.blob ?? again);
  return (
    <Sheet open={open !== null} onOpenChange={(o) => (o ? undefined : onClose())} title={open ? `Picture ${open.n + 1} of ${open.count}` : 'Picture'}>
      <div className="flex min-h-160 items-center justify-center pb-16">
        {url ? <img src={url} alt={open ? `Picture ${open.n + 1} of ${open.count}` : ''} className="block max-h-440 w-full rounded-btn object-contain" /> : null}
      </div>
    </Sheet>
  );
}

/** The item page's strip: every thumbnail the Mac kept, sideways; a tap opens the larger view. */
export function FrameStrip({ id, count }: { id: string; count: number }) {
  const [open, setOpen] = useState<{ n: number; count: number; blob: Blob | null } | null>(null);
  if (count <= 0) return null;
  return (
    <>
      <ul aria-label="Pictures" className="no-scrollbar flex gap-8 overflow-x-auto px-16 pb-4">
        {Array.from({ length: count }, (_, n) => (
          <StripFrame key={n} id={id} n={n} count={count} onOpen={(k, blob) => setOpen({ n: k, count, blob })} />
        ))}
      </ul>
      <FrameView id={id} open={open} onClose={() => setOpen(null)} />
    </>
  );
}
