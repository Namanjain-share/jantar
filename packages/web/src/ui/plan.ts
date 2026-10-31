/**
 * /v1/plan, shared by every screen that needs it: ccw's "next →", burn and
 * "full in", and the autoswitch ceilings (which read-scope devices cannot
 * get from settings).
 *
 * One feed per Api object: the first subscriber loads it and starts a
 * minute timer, later subscribers share the same answer (and ask again if
 * it is older than STALE_MS), and the timer stops when the last one goes.
 * It asks only while the app is in sync with the daemon (live or polling),
 * so an unpaired browser on the Pair screen sends nothing, and it asks at
 * once when the link comes back. Failures keep the last answer.
 */
import type { PlanResponse } from '@jantar/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import type { Api } from '../lib/api.js';
import type { AppStore } from '../store.js';
import { useApp, useDeps } from './context.js';

/**
 * Used until /v1/plan answers, and by daemons too old to send `ceiling`.
 * It is the settings default (protocol settings.ts `autoswitch.ceiling`;
 * a test keeps them equal). Parsing the zod schema here would pull zod
 * into the bundle.
 */
export const DEFAULT_CEILING = 97;

const PERIOD_MS = 60_000;
const STALE_MS = 15_000;

interface Feed {
  plan: PlanResponse | null;
  askedAt: number;
  subs: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}

const feeds = new WeakMap<Api, Feed>();

function feedFor(api: Api): Feed {
  let f = feeds.get(api);
  if (!f) {
    f = { plan: null, askedAt: 0, subs: new Set(), timer: null, inFlight: false };
    feeds.set(api, f);
  }
  return f;
}

function linked(store: AppStore): boolean {
  const st = store.getState().conn.status;
  return st === 'live' || st === 'polling';
}

function load(api: Api, f: Feed, store: AppStore): void {
  if (f.inFlight || !linked(store)) return;
  f.inFlight = true;
  f.askedAt = Date.now();
  let p: Promise<PlanResponse>;
  try {
    p = api.getPlan();
  } catch {
    f.inFlight = false;
    return;
  }
  p.then(
    (plan) => {
      f.inFlight = false;
      f.plan = plan;
      for (const cb of f.subs) cb();
    },
    () => {
      f.inFlight = false;
    },
  );
}

export function usePlan(): PlanResponse | null {
  const { api, store } = useDeps();
  const f = feedFor(api);
  const isLinked = useApp((s) => s.conn.status === 'live' || s.conn.status === 'polling');
  // Back in sync (first sync, or after being offline): ask now if the answer is old.
  useEffect(() => {
    if (isLinked && Date.now() - f.askedAt > STALE_MS) load(api, f, store);
  }, [isLinked, api, f, store]);
  return useSyncExternalStore(
    (cb) => {
      f.subs.add(cb);
      if (!f.timer) f.timer = setInterval(() => load(api, f, store), PERIOD_MS);
      if (Date.now() - f.askedAt > STALE_MS) load(api, f, store);
      return () => {
        f.subs.delete(cb);
        if (f.subs.size === 0 && f.timer) {
          clearInterval(f.timer);
          f.timer = null;
        }
      };
    },
    () => f.plan,
    () => f.plan,
  );
}

export function ceilingOf(plan: PlanResponse | null): number {
  return typeof plan?.ceiling === 'number' && Number.isFinite(plan.ceiling) ? plan.ceiling : DEFAULT_CEILING;
}

/** The autoswitch 5h ceiling in force, in %. */
export function useCeiling(): number {
  return ceilingOf(usePlan());
}
