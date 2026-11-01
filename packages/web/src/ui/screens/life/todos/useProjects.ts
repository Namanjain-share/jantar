/**
 * Projects for the Board's chips (v0.4 spec 5.3, gate LW6): a module-level
 * cache per Api, so every Board row shares one list and one request. It
 * fetches only while Life is on and this device's stored scopes include
 * control, again when lifeTick moves (one request at a time; a tick that
 * moves meanwhile is fetched when it ends), and never again after a 401,
 * 403, 501 or 503 until the app reloads: a device without control, the
 * todos module off, or Life broken would answer every later fetch the same.
 * It sits in the main chunk with the Board, so it imports nothing heavy.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ProjectView } from '@jantar/protocol';
import { isApiError, type Api } from '../../../../lib/api.js';
import { useApp, useDeps } from '../../../context.js';
import { useFeatures } from '../../../shell/data.js';
import { readLocalDevice } from '../../devices/local.js';

interface ProjectsCache {
  projects: readonly ProjectView[];
  /** The lifeTick the last fetch answered for. */
  tick: number | null;
  /** The newest lifeTick asked for. */
  wanted: number | null;
  inflight: boolean;
  /** A refusal that would only repeat: no more fetches until the app reloads. */
  stopped: boolean;
  listeners: Set<() => void>;
}

const NONE: readonly ProjectView[] = [];
const caches = new WeakMap<Api, ProjectsCache>();

function cacheFor(api: Api): ProjectsCache {
  let c = caches.get(api);
  if (!c) {
    c = { projects: NONE, tick: null, wanted: null, inflight: false, stopped: false, listeners: new Set() };
    caches.set(api, c);
  }
  return c;
}

/** Not paired, no control scope or the todos module off, not built, Life broken. */
const STOPS = new Set([401, 403, 501, 503]);

function fetchProjects(api: Api, c: ProjectsCache, tick: number): void {
  c.wanted = tick;
  if (c.inflight || c.stopped) return;
  c.inflight = true;
  const done = () => {
    c.inflight = false;
    c.tick = tick;
    for (const l of [...c.listeners]) l();
    if (!c.stopped && c.wanted !== null && c.wanted !== tick) fetchProjects(api, c, c.wanted);
  };
  api.projectsList().then(
    (r) => {
      c.projects = r.projects;
      done();
    },
    (e: unknown) => {
      if (isApiError(e) && STOPS.has(e.status)) c.stopped = true;
      done();
    },
  );
}

/** This browser was paired with the control scope (Life's every route needs it). */
function storedControl(): boolean {
  return readLocalDevice()?.scopes.includes('control') ?? false;
}

/** The projects with their counts, for chips; empty while Life is off, without control, or before the first answer. */
export function useProjects(): readonly ProjectView[] {
  const { api } = useDeps();
  const { life } = useFeatures();
  const tick = useApp((s) => s.state.lifeTick ?? 0);
  const c = cacheFor(api);
  // One subscription per chip for as long as the cache is the same: every Board row renders one.
  const subscribe = useCallback(
    (fn: () => void) => {
      c.listeners.add(fn);
      return () => {
        c.listeners.delete(fn);
      };
    },
    [c],
  );
  const projects = useSyncExternalStore(subscribe, () => c.projects);
  useEffect(() => {
    if (!life || c.stopped || c.tick === tick || (c.inflight && c.wanted === tick)) return;
    if (!storedControl()) return;
    fetchProjects(api, c, tick);
  }, [api, c, life, tick]);
  return life ? projects : NONE;
}

/** A project's folder holds `cwd`; the project whose folder holds it, the deepest winning (v0.5.3: protocol's, shared with the daemon's folder todos). */
export { inFolder, projectFor } from '@jantar/protocol';
