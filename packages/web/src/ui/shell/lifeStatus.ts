/**
 * The one shared GET /v1/life/status (v0.4; 0.13.0 moved it out of the Life
 * chunk into the main load). Which Life modules are on is a control read,
 * never in the features every device sees, so the shell asks it whether Work
 * is on (the Work place, its tab and its keys), and every Life screen asks it
 * through useLifeStatus (screens/life/shared/useLife.ts): one fetch for both,
 * one at a time, again when `state.lifeTick` moves (a switch at the Mac moves
 * it too). A device paired without control never asks.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { LifeStatus } from '@jantar/protocol';
import type { Api } from '../../lib/api.js';
import { useApp, useDeps } from '../context.js';
import { readLocalDevice } from '../screens/devices/local.js';

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
 * The shared Life status, fetched while `on` (again when lifeTick moves). Off, it still answers what
 * another screen fetched.
 */
export function useLifeStatusFeed(on: boolean): { status: LifeStatus | null; error: unknown; reload: () => void } {
  const { api } = useDeps();
  const tick = useApp((s) => s.state.lifeTick ?? 0);
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
    if (on && store.tick !== tick) refresh(api, store, tick);
  }, [api, store, on, tick]);
  const reload = useCallback(() => refresh(api, store, tick), [api, store, tick]);
  return { status: store.status, error: store.error, reload };
}

/** This browser was paired with control, or kept no record of its pairing (taken to have it, as the places do). */
export function pairedWithControl(): boolean {
  const scopes = readLocalDevice()?.scopes;
  return !Array.isArray(scopes) || scopes.includes('control');
}

/**
 * 0.13.0: Work is on at the Mac (`life.work`, with Todos on: Life status `modules.work`), read on a device
 * with control while any Life module is on. False until Life status says so.
 */
export function useWorkOn(life: boolean): boolean {
  const control = life && pairedWithControl();
  return useLifeStatusFeed(control).status?.modules.work === true && control;
}
