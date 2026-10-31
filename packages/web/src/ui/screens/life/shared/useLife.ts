/**
 * How every Life and Intel screen gets its data (v0.4 spec 5.0): over REST,
 * reloaded when `state.lifeTick` moves (one text-free counter for all of
 * Life and the shelf) and when the page comes back into view. Nothing is
 * kept in IndexedDB or the service worker.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LifeStatus } from '@jantar/protocol';
import type { Api } from '../../../../lib/api.js';
import { useApp, useDeps } from '../../../context.js';
import { useFeatures } from '../../../shell/data.js';
import { useReloadOn } from '../../files/data.js';

/** `state.lifeTick` (0 from a daemon before v0.4). */
export function useLifeTick(): number {
  return useApp((s) => s.state.lifeTick ?? 0);
}

/** Call `fn` when the page becomes visible again (the phone woke, the tab came back). */
export function useOnVisible(fn: () => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const on = () => {
      if (document.visibilityState === 'visible') ref.current();
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
}

export interface LifeLoad<T> {
  data: T | null;
  error: unknown;
  /** No answer yet for this key. */
  loading: boolean;
  reload: () => void;
}

/**
 * `load()` for `key` (null: nothing to load), again on every lifeTick move
 * and on visibility. A newer key's answer always wins over an older one's;
 * the last data stays on screen while a reload runs (and when it fails).
 */
export function useLifeLoad<T>(key: string | null, load: () => Promise<T>): LifeLoad<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: unknown; loading: boolean }>({ key: null, data: null, error: null, loading: false });
  const seq = useRef(0);
  const loadRef = useRef(load);
  // reload() always loads the key shown now: a sheet's onClose that fires after
  // the day changed must not load its old key over the new one's answer.
  const keyRef = useRef(key);
  useEffect(() => {
    loadRef.current = load;
    keyRef.current = key;
  });
  const run = useCallback((k: string) => {
    const mine = ++seq.current;
    setState((s) => ({ key: k, data: s.key === k ? s.data : null, error: null, loading: true }));
    loadRef.current().then(
      (data) => {
        if (mine === seq.current) setState({ key: k, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (mine === seq.current) setState((s) => ({ key: k, data: s.key === k ? s.data : null, error, loading: false }));
      },
    );
  }, []);
  useEffect(() => {
    if (key !== null) run(key);
  }, [key, run]);
  const reload = useCallback(() => {
    if (keyRef.current !== null) run(keyRef.current);
  }, [run]);
  useReloadOn(String(useLifeTick()), reload);
  useOnVisible(reload);
  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: current ? state.loading : key !== null, reload };
}

// ---------------------------------------------------------------------------
// The one shared LifeStatus

interface StatusStore {
  status: LifeStatus | null;
  error: unknown;
  /** The lifeTick the last fetch answered for. */
  tick: number | null;
  /** The newest lifeTick asked for: one that moves during a fetch is fetched when that one ends. */
  wanted: number | null;
  inflight: boolean;
  listeners: Set<() => void>;
  version: number;
}

const stores = new WeakMap<Api, StatusStore>();

function storeFor(api: Api): StatusStore {
  let s = stores.get(api);
  if (!s) {
    s = { status: null, error: null, tick: null, wanted: null, inflight: false, listeners: new Set(), version: 0 };
    stores.set(api, s);
  }
  return s;
}

function notify(s: StatusStore): void {
  s.version += 1;
  for (const l of [...s.listeners]) l();
}

/** One fetch at a time; a tick asked for meanwhile is fetched as soon as it ends. */
function refresh(api: Api, s: StatusStore, tick: number): void {
  s.wanted = tick;
  if (s.inflight) return;
  s.inflight = true;
  const done = () => {
    s.inflight = false;
    s.tick = tick;
    notify(s);
    if (s.wanted !== null && s.wanted !== tick) refresh(api, s, s.wanted);
  };
  api.lifeStatus().then(
    (status) => {
      s.status = status;
      s.error = null;
      done();
    },
    (error: unknown) => {
      s.error = error;
      done();
    },
  );
}

/**
 * GET /v1/life/status, shared by every screen that asks (which modules are
 * on, the zone, the currency, who would get a medicine ping). Fetched only
 * while Life or the shelf is on; again when lifeTick moves.
 */
export function useLifeStatus(): { status: LifeStatus | null; error: unknown; reload: () => void } {
  const { api } = useDeps();
  const { life, intel } = useFeatures();
  const tick = useLifeTick();
  const store = storeFor(api);
  // A stable subscribe: a new one each render would unsubscribe and subscribe again every time.
  const subscribe = useCallback(
    (fn: () => void) => {
      store.listeners.add(fn);
      return () => {
        store.listeners.delete(fn);
      };
    },
    [store],
  );
  useSyncExternalStore(subscribe, () => store.version);
  useEffect(() => {
    if ((life || intel) && store.tick !== tick) refresh(api, store, tick);
  }, [api, store, life, intel, tick]);
  const reload = useCallback(() => refresh(api, store, tick), [api, store, tick]);
  return { status: store.status, error: store.error, reload };
}
