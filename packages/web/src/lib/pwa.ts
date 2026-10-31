/**
 * Service-worker registration, the install prompt and the iOS
 * "Add to Home Screen" hint.
 */
import { createStore } from 'zustand/vanilla';
import { isIOS } from './push.js';
import { readLocal, writeLocal } from './storage.js';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** Chrome/Edge/Android: the deferred install prompt. */
  installEvent: InstallPromptEvent | null;
  /** Running from the Home Screen / as an installed app. */
  standalone: boolean;
  ios: boolean;
  iosHintDismissed: boolean;
  dismissIosHint(): void;
  promptInstall(): Promise<boolean>;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(nav.standalone) || Boolean(window.matchMedia?.('(display-mode: standalone)').matches);
}

export const pwaStore = createStore<PwaState>()((set, get) => ({
  installEvent: null,
  standalone: detectStandalone(),
  ios:
    typeof navigator !== 'undefined' &&
    isIOS({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints ?? 0 }),
  iosHintDismissed: readLocal('ios-hint-dismissed', false),
  dismissIosHint() {
    writeLocal('ios-hint-dismissed', true);
    set({ iosHintDismissed: true });
  },
  async promptInstall() {
    const ev = get().installEvent;
    if (!ev) return false;
    await ev.prompt();
    const choice = await ev.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
    set({ installEvent: null });
    return choice.outcome === 'accepted';
  },
}));

export function listenForInstallPrompt(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pwaStore.setState({ installEvent: e as InstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => pwaStore.setState({ installEvent: null, standalone: true }));
}

export interface SwHandlers {
  /** A notification was tapped while the app was open: show this path. */
  onNavigate(path: string): void;
  /** A new version of the app took over: offer a reload. */
  onUpdate(): void;
}

export function registerServiceWorker(h: SwHandlers): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  let hadController = Boolean(sw.controller);
  sw.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: unknown; url?: unknown } | null;
    if (d && d.type === 'jantar:navigate' && typeof d.url === 'string' && d.url.startsWith('/')) h.onNavigate(d.url);
  });
  sw.addEventListener('controllerchange', () => {
    if (hadController) h.onUpdate();
    hadController = true;
  });
  const register = () => {
    sw.register('/sw.js', { scope: '/' }).catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
