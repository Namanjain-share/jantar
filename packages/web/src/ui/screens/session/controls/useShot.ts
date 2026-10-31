/**
 * One session's terminal screenshot (v0.3, the controls addendum; work
 * package C): fetched with `api.screenshot` (a plain <img src> could not
 * carry the paired device's credentials), shown through an object URL
 * (img-src blob:) that is revoked as soon as a newer image replaces it, the
 * session changes, or the view unmounts. A request still in flight is
 * aborted then too. Taken when the view opens and on demand only: a capture
 * costs the Mac more than a text read, and the daemon limits them.
 *
 * A failed try to switch tabs and capture (select) keeps the refusal that
 * led to it in `error`, so the text peek stays up, and says why in
 * `selectError`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../../lib/api.js';
import { useDeps } from '../../../context.js';

export interface Shot {
  url: string;
  /** When it was captured (ISO), or null when the reply did not say. */
  at: string | null;
  width: number | null;
  height: number | null;
  /** A background tab was selected for a moment to take it. */
  disturbed: boolean;
}

export interface ShotState {
  shot: Shot | null;
  busy: boolean;
  error: ApiError | null;
  /** Why the last try to switch tabs and capture failed. */
  selectError: ApiError | null;
}

export function useShot(sid: string, active: boolean) {
  const { api } = useDeps();
  const [state, setState] = useState<ShotState>({ shot: null, busy: false, error: null, selectError: null });
  const url = useRef<string | null>(null);
  const flight = useRef<AbortController | null>(null);

  const drop = useCallback(() => {
    flight.current?.abort();
    flight.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
  }, []);

  const load = useCallback(
    async (opts: { select?: boolean } = {}) => {
      flight.current?.abort();
      const ac = new AbortController();
      flight.current = ac;
      setState((s) => ({ ...s, busy: true }));
      try {
        const r = await api.screenshot(sid, opts.select ? { select: true } : {}, { signal: ac.signal });
        if (ac.signal.aborted) return;
        const next = URL.createObjectURL(r.blob);
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = next;
        setState({ shot: { url: next, at: r.at, width: r.width, height: r.height, disturbed: r.disturbed }, busy: false, error: null, selectError: null });
      } catch (e) {
        if (ac.signal.aborted) return;
        const error = e instanceof ApiError ? e : new ApiError('bad_response', e instanceof Error ? e.message : String(e), 0);
        setState((s) => (opts.select ? { ...s, busy: false, selectError: error } : { ...s, busy: false, error, selectError: null }));
      } finally {
        if (flight.current === ac) flight.current = null;
      }
    },
    [api, sid],
  );

  // A new session starts empty: never show one session's picture under another's name.
  useEffect(() => {
    setState({ shot: null, busy: false, error: null, selectError: null });
    return drop;
  }, [sid, drop]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  return { ...state, load };
}
