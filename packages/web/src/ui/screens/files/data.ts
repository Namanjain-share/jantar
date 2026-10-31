/**
 * Loading for the Files screens: one hook that fetches, keeps the last
 * reply per key in memory, and reloads when the Mac comes back.
 *
 * The cache is memory only (file names and text never go to storage) and
 * small. Coming back to a list paints the cached reply at once and
 * refreshes it quietly: no skeleton or spinner over data already shown.
 * Only an unreachable Mac keeps that copy on screen; any other answer (gone,
 * refused, too large) replaces it, so an old copy never passes for current.
 *
 * The lists follow the sessions live: every Write or Edit moves the
 * session's counter in `state.fileTicks` (files.changed), and the views ask
 * again once it moves, one ask per burst of writes (TICK_RELOAD_MS).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../../../lib/api.js';
import { useApp, useDeps } from '../../context.js';

const CACHE_MAX = 40;
/** File text kept in the cache, in characters (a text window is up to 512 KiB). */
const CACHE_TEXT_MAX = 4 * 1024 * 1024;
/** A burst of writes within this long is one reload. */
export const TICK_RELOAD_MS = 400;
const cache = new Map<string, { value: unknown; weight: number }>();
let cachedText = 0;

/** A file text window weighs its characters; listings and stats weigh nothing here. */
function weigh(value: unknown): number {
  const t = value !== null && typeof value === 'object' ? (value as { text?: unknown }).text : undefined;
  return typeof t === 'string' ? t.length : 0;
}

function forget(key: string) {
  const had = cache.get(key);
  if (!had) return;
  cachedText -= had.weight;
  cache.delete(key);
}

function remember(key: string, value: unknown) {
  forget(key);
  const weight = weigh(value);
  cache.set(key, { value, weight });
  cachedText += weight;
  // Oldest out first; the reply just stored always stays.
  while (cache.size > 1 && (cache.size > CACHE_MAX || cachedText > CACHE_TEXT_MAX)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    forget(oldest);
  }
}

function recall<T>(key: string | null, cached: boolean): T | null {
  return key !== null && cached ? ((cache.get(key)?.value as T | undefined) ?? null) : null;
}

/** Drop everything cached (tests; any reply saying this device is no longer paired). */
export function clearFilesCache(): void {
  cache.clear();
  cachedText = 0;
}

export interface Loaded<T> {
  data: T | null;
  /** The last failure; kept beside stale data only while the Mac is out of reach. */
  error: unknown;
  /** A request is in flight. */
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch `load(signal)` for `key` (null: nothing to load). Replies for an
 * older key are dropped, and the request behind them is aborted (a new key,
 * a reload, unmount), so a big download stops when nobody waits for it.
 * `cache: false` keeps the reply out of the cache (file bytes).
 */
export function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, opts: { cache?: boolean } = {}): Loaded<T> {
  const cached = opts.cache !== false;
  const { store } = useDeps();
  const conn = useApp((s) => s.conn.status);
  const [state, setState] = useState<{ key: string | null; data: T | null; error: unknown; loading: boolean }>(() => ({
    key,
    data: recall<T>(key, cached),
    error: null,
    loading: key !== null,
  }));
  const loadRef = useRef(load);
  // Declared first, so the effects below always call this render's `load`.
  useEffect(() => {
    loadRef.current = load;
  });
  const seq = useRef(0);
  const alive = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  const stop = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
    };
  }, [stop]);

  const run = useCallback(
    (k: string) => {
      const mine = ++seq.current;
      stop();
      const abort = new AbortController();
      inFlight.current = abort;
      setState((s) => ({ ...s, loading: true }));
      loadRef.current(abort.signal).then(
        (data) => {
          if (!alive.current || mine !== seq.current) return;
          inFlight.current = null;
          if (cached) remember(k, data);
          setState({ key: k, data, error: null, loading: false });
        },
        (error: unknown) => {
          if (!alive.current || mine !== seq.current) return;
          inFlight.current = null;
          // Out of reach: what is on screen is the best there is, and says so beside it.
          if (isApiError(error, 'network') || store.getState().conn.status === 'offline') {
            setState((s) => ({ ...s, error, loading: false }));
            return;
          }
          // The Mac answered (gone, refused, too large, unpaired): the old copy is not the file any more.
          if (isApiError(error, 'unauthorized')) clearFilesCache();
          else forget(k);
          setState({ key: k, data: null, error, loading: false });
        },
      );
    },
    [cached, stop, store],
  );

  // A new key shows its cached reply (or nothing) at once, then asks.
  if (state.key !== key) {
    setState({ key, data: recall<T>(key, cached), error: null, loading: key !== null });
  }
  useEffect(() => {
    if (key !== null) run(key);
    else {
      seq.current += 1;
      stop();
    }
  }, [key, run, stop]);

  // Back from offline: ask again.
  const wasOffline = useRef(conn === 'offline');
  useEffect(() => {
    if (conn === 'offline') wasOffline.current = true;
    else if (wasOffline.current && (conn === 'live' || conn === 'polling')) {
      wasOffline.current = false;
      if (key !== null) run(key);
    }
  }, [conn, key, run]);

  const reload = useCallback(() => {
    if (key !== null) run(key);
  }, [key, run]);
  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: current ? state.loading : key !== null, reload };
}

/** Whether the Mac cannot be reached right now. */
export function useOffline(): boolean {
  return useApp((s) => s.conn.status === 'offline');
}

/** The files.changed counter of one session, or of every session together (`state.fileTicks`). */
export function useFileTick(sid?: string): number {
  return useApp((s) => {
    const ticks = s.state.fileTicks;
    if (!ticks) return 0;
    if (sid !== undefined) return Object.hasOwn(ticks, sid) ? (ticks[sid] ?? 0) : 0;
    let n = 0;
    for (const v of Object.values(ticks)) n += v;
    return n;
  });
}

/**
 * Call `reload` when `signal` moves (a session wrote a file), at most once
 * per `ms`: the first move starts the wait, and the one reload after it
 * reads every move made meanwhile. Nothing on the first render.
 */
export function useReloadOn(signal: string, reload: () => void, ms = TICK_RELOAD_MS): void {
  const seen = useRef(signal);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    if (signal === seen.current) return;
    seen.current = signal;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reloadRef.current();
    }, ms);
  }, [signal, ms]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
}
