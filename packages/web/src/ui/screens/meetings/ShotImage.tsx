/**
 * A screenshot in the transcript (v0.5 spec 5.3): a full-width 16:10 box
 * until its bytes arrive, then the image at its own ratio, its time in mono
 * under it. The bytes are asked for only once the box comes near the view
 * (IntersectionObserver against the box the shell scrolls; at once where
 * there is none), through `api.meetingShot` as a Blob shown by an object
 * URL that is revoked on unmount (MW3). Leaving aborts the download, and
 * nothing is cached between views. A tap opens the viewer with the bytes
 * already here.
 */
import { CameraIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MeetingShot } from '@jantar/protocol';
import { isApiError } from '../../../lib/api.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { useObjectUrl } from '../files/blob.js';
import { useOffline } from '../life/today/parts.js';
import { SHOTS_LIMITED, SHOT_FAILED, hhmm } from './model.js';
import { scrollParent } from './scroll.js';

/** How far below the view a box starts loading, so a slow scroll finds it there. */
const NEAR = '400px 0px';

/**
 * True once `ref` has come within NEAR of the view (stays true). The root is
 * the box the shell scrolls: a root margin grows only the root, not the
 * boxes that clip on the way, so against the viewport NEAR would never apply.
 */
function useNearView(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setNear(true);
        io.disconnect();
      },
      { root: scrollParent(el), rootMargin: NEAR },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

/** Why a screenshot did not load: the byte budget's 429 says to wait, the rest is one sentence. */
export function shotErrorText(e: unknown): string {
  return isApiError(e, 'rate_limited') ? SHOTS_LIMITED : SHOT_FAILED;
}

/**
 * One screenshot's bytes while `on`: asked again on retry, and once by itself
 * when the Mac can be reached again after a failure; aborted when the view goes.
 */
export function useShotBlob(meetingId: string, shotId: string, on: boolean): { blob: Blob | null; error: unknown; retry: () => void } {
  const { api } = useDeps();
  const offline = useOffline();
  const [state, setState] = useState<{ blob: Blob | null; error: unknown }>({ blob: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const wasOffline = useRef(offline);
  useEffect(() => {
    const back = wasOffline.current && !offline;
    wasOffline.current = offline;
    if (back && state.error) setAttempt((n) => n + 1);
  }, [offline, state.error]);
  useEffect(() => {
    if (!on) return;
    const ac = new AbortController();
    setState((s) => (s.blob || s.error ? { blob: null, error: null } : s));
    api.meetingShot(meetingId, shotId, { signal: ac.signal }).then(
      (blob) => {
        if (!ac.signal.aborted) setState({ blob, error: null });
      },
      (error: unknown) => {
        if (!ac.signal.aborted) setState({ blob: null, error });
      },
    );
    return () => ac.abort();
  }, [api, meetingId, shotId, on, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

export function ShotImage({ meetingId, shot, onOpen }: { meetingId: string; shot: MeetingShot; onOpen: (shot: MeetingShot, blob: Blob | null) => void }) {
  const box = useRef<HTMLButtonElement>(null);
  const near = useNearView(box);
  const { blob, error, retry } = useShotBlob(meetingId, shot.id, near);
  const url = useObjectUrl(blob);
  const at = hhmm(shot.at);
  return (
    <figure data-shot={shot.id} className="py-8">
      <button
        ref={box}
        type="button"
        aria-label={`Open the screenshot from ${at}`}
        onClick={() => onOpen(shot, blob)}
        className="block w-full overflow-hidden rounded-btn border border-line bg-surface transition-colors duration-120 ease-hover hover:border-line-strong"
      >
        {url ? (
          <img src={url} alt={`Screenshot ${at}`} className="block h-auto w-full" />
        ) : (
          <span data-placeholder className="flex aspect-16/10 w-full items-center justify-center text-ink-3">
            <CameraIcon size={20} aria-hidden="true" />
          </span>
        )}
      </button>
      {error ? (
        <p role="status" className="mt-4 flex flex-wrap items-center gap-x-8 type-small text-ink-2">
          {shotErrorText(error)}
          <Button variant="text" size="sm" className="-ml-8" onClick={retry}>
            Try again
          </Button>
        </p>
      ) : null}
      <figcaption className="mt-4 type-mono text-ink-3">
        <time dateTime={shot.at}>{at}</time>
      </figcaption>
    </figure>
  );
}
