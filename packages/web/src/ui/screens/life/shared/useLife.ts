/**
 * How every Life and Intel screen gets its data (v0.4 spec 5.0): over REST,
 * reloaded when `state.lifeTick` moves (one text-free counter for all of
 * Life and the shelf) and when the page comes back into view. Nothing is
 * kept in IndexedDB or the service worker.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LifeStatus } from '@jantar/protocol';
import { useApp } from '../../../context.js';
import { useFeatures } from '../../../shell/data.js';
import { useLifeStatusFeed } from '../../../shell/lifeStatus.js';
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
// The one shared LifeStatus (0.13.0: its store is the shell's, shell/lifeStatus.ts, which asks it for Work)

/**
 * GET /v1/life/status, shared by every screen that asks (which modules are
 * on, the zone, the currency, who would get a medicine ping). Fetched only
 * while Life or the shelf is on; again when lifeTick moves.
 */
export function useLifeStatus(): { status: LifeStatus | null; error: unknown; reload: () => void } {
  const { life, intel } = useFeatures();
  return useLifeStatusFeed(life || intel);
}
