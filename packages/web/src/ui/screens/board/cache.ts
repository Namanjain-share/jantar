/**
 * The last known state, kept in localStorage so every later load paints at
 * once instead of showing skeletons (direction.md 5.6 "Cached state").
 *
 * - hydrate: before the first sync (seq 0, never heard from the daemon),
 *   apply the cached StateResponse and set `lastOkAt` to when it was saved,
 *   so the status bar reads "catching up · last 14:02" and the strip stays
 *   dashed until the real sync replaces it.
 * - persist: while live or polling, save at most every few seconds and when
 *   the page is hidden.
 * - forget: a 401 (this browser is no longer paired) clears it.
 *
 * Storage may be missing or full: every access is guarded and the app works
 * without it. `wireStateCache(store)` is idempotent per store, so the store
 * bootstrap (main.tsx) can call it too; the Board calls it on mount.
 */
import type { State } from '@jantar/protocol';
import { readLocal, writeLocal } from '../../../lib/storage.js';
import type { AppStore } from '../../../store.js';

export const STATE_CACHE_KEY = 'last-state';
/** 2: the v0.3 state gained `rewrites` and `launches`, so an older cache is dropped rather than hydrated. */
const VERSION = 2;
/** Skip saving anything larger than this (localStorage is ~5 MB per origin). */
const MAX_CHARS = 1_500_000;
const THROTTLE_MS = 4000;

export interface CachedState {
  v: number;
  /** ms */
  savedAt: number;
  seq: number;
  epoch: string;
  state: State;
}

export function readStateCache(): CachedState | null {
  const c = readLocal<CachedState | null>(STATE_CACHE_KEY, null);
  if (!c || typeof c !== 'object' || c.v !== VERSION) return null;
  if (typeof c.seq !== 'number' || typeof c.epoch !== 'string' || typeof c.savedAt !== 'number') return null;
  if (!c.state || typeof c.state !== 'object' || typeof c.state.sessions !== 'object') return null;
  return c;
}

export function clearStateCache(): void {
  writeLocal(STATE_CACHE_KEY, undefined);
}

/** Save the store's current state if it is a real, in-sync one. */
export function saveStateCache(store: AppStore, now: number = Date.now()): boolean {
  const s = store.getState();
  if (!s.epoch || s.state.seq <= 0 || s.needsResync) return false;
  if (s.conn.status !== 'live' && s.conn.status !== 'polling') return false;
  const entry: CachedState = { v: VERSION, savedAt: now, seq: s.state.seq, epoch: s.epoch, state: s.state };
  let size = 0;
  try {
    size = JSON.stringify(entry).length;
  } catch {
    return false;
  }
  if (size > MAX_CHARS) return false;
  writeLocal(STATE_CACHE_KEY, entry);
  return true;
}

/** Paint the cached state if nothing has synced yet. Returns whether it did. */
export function hydrateStateCache(store: AppStore): boolean {
  const s = store.getState();
  if (s.state.seq !== 0 || s.conn.lastOkAt !== null) return false;
  if (s.conn.status !== 'connecting' && s.conn.status !== 'offline') return false;
  const c = readStateCache();
  if (!c) return false;
  try {
    s.applyStateResponse({ seq: c.seq, epoch: c.epoch, state: c.state });
  } catch {
    return false;
  }
  // Only claim "last heard at" when nothing newer arrived meanwhile.
  if (store.getState().conn.lastOkAt === null) s.setConn({ lastOkAt: c.savedAt });
  return true;
}

const wired = new WeakSet<AppStore>();

export function wireStateCache(store: AppStore): void {
  if (wired.has(store)) return;
  wired.add(store);
  hydrateStateCache(store);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAt = 0;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastAt = Date.now();
    saveStateCache(store, lastAt);
  };

  store.subscribe((s, prev) => {
    if (s.conn.status === 'unauthorized') {
      if (prev.conn.status !== 'unauthorized') clearStateCache();
      return;
    }
    if (s.state === prev.state && s.conn.status === prev.conn.status) return;
    if (s.conn.status !== 'live' && s.conn.status !== 'polling') return;
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, lastAt + THROTTLE_MS - Date.now()));
  });

  if (typeof window !== 'undefined') {
    const onHide = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
  }
}
