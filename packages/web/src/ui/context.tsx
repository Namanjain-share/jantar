/**
 * Everything a screen needs, passed down once: the state store, the API
 * client, the router, toasts and (optionally) the live connection and the
 * push environment. Tests build their own with fakes.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Api } from '../lib/api.js';
import type { Connection } from '../lib/connection.js';
import type { PushEnv } from '../lib/push.js';
import type { Route, Router } from '../lib/router.js';
import type { AppState, AppStore } from '../store.js';

export type ToastTone = 'info' | 'ok' | 'error';
export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}
export interface ToastState {
  toasts: Toast[];
  show(text: string, tone?: ToastTone, ms?: number): void;
  dismiss(id: number): void;
}

export function createToastStore() {
  let next = 1;
  return createStore<ToastState>()((set, get) => ({
    toasts: [],
    show(text, tone = 'info', ms = tone === 'error' ? 6000 : 3500) {
      const id = next++;
      set({ toasts: [...get().toasts.slice(-2), { id, text, tone }] });
      setTimeout(() => get().dismiss(id), ms);
    },
    dismiss(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  }));
}
export type ToastStore = ReturnType<typeof createToastStore>;

export interface AppDeps {
  store: AppStore;
  api: Api;
  router: Router;
  toasts: ToastStore;
  connection?: Connection;
  /** Push detection; omitted = the real browser APIs. */
  pushEnv?: PushEnv;
  /** Clock for "x minutes ago"; omitted = Date.now. */
  now?: () => number;
}

const Ctx = createContext<AppDeps | null>(null);

export function AppProvider({ deps, children }: { deps: AppDeps; children: ReactNode }) {
  return <Ctx.Provider value={deps}>{children}</Ctx.Provider>;
}

export function useDeps(): AppDeps {
  const d = useContext(Ctx);
  if (!d) throw new Error('AppProvider is missing');
  return d;
}

/** Select from the app store. Return stable values (not fresh arrays/objects). */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(useDeps().store, selector);
}

export function useRoute(): Route {
  return useStore(useDeps().router, (s) => s.route);
}

export function useNavigate(): (to: string | Route, opts?: { replace?: boolean }) => void {
  return useStore(useDeps().router, (s) => s.navigate);
}

export function useToast(): ToastState['show'] {
  return useStore(useDeps().toasts, (s) => s.show);
}

/** The current time, refreshed every `everyMs` (for relative labels). */
export function useNow(everyMs = 30_000): number {
  const { now = Date.now } = useDeps();
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs, now]);
  return t;
}

/** Media query as state (false where matchMedia is missing, e.g. tests). */
export function useMedia(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return m;
}
