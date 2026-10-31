/**
 * Web Push on this device: detect support, subscribe with the daemon's VAPID
 * key, and register the subscription with the daemon.
 *
 * iPhone and iPad only allow push for a web app opened from the Home Screen
 * (iOS 16.4+), and only after a tap: `enablePush` must run from a click.
 */
import type { NotifyKind, PushSubscriptionJSON } from '@jantar/protocol';
import type { Api } from './api.js';

export type PushState =
  /** No service worker, PushManager or Notification API. */
  | 'unsupported'
  /** iOS Safari tab: add to the Home Screen and open it from there first. */
  | 'needs-install'
  /** Plain http on a non-local address: browsers refuse push there. */
  | 'insecure'
  /** The user blocked notifications for this site. */
  | 'denied'
  | 'off'
  | 'on';

interface SubscriptionLike {
  endpoint: string;
  options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}
interface RegistrationLike {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<SubscriptionLike>;
  };
  getNotifications?(): Promise<Array<{ data?: unknown; close(): void }>>;
}

export interface PushEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** navigator.standalone (iOS) or display-mode: standalone. */
  standalone: boolean;
  isSecureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  notification: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> } | null;
  /** Resolves with the active registration, or null after `timeoutMs`. */
  ready(timeoutMs: number): Promise<RegistrationLike | null>;
}

export function defaultPushEnv(): PushEnv {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const w = typeof window !== 'undefined' ? window : undefined;
  const standalone =
    Boolean((nav as unknown as { standalone?: boolean } | undefined)?.standalone) ||
    Boolean(w?.matchMedia?.('(display-mode: standalone)').matches);
  const N = (globalThis as { Notification?: PushEnv['notification'] & object }).Notification;
  return {
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone,
    isSecureContext: Boolean(w?.isSecureContext),
    hasServiceWorker: Boolean(nav && 'serviceWorker' in nav),
    hasPushManager: Boolean(w && 'PushManager' in w),
    notification: N
      ? {
          get permission() {
            return N.permission;
          },
          requestPermission: () => N.requestPermission(),
        }
      : null,
    ready: (timeoutMs) => {
      if (!nav || !('serviceWorker' in nav)) return Promise.resolve(null);
      return Promise.race([
        nav.serviceWorker.ready as Promise<unknown> as Promise<RegistrationLike>,
        new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
      ]);
    },
  };
}

export function isIOS(env: Pick<PushEnv, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return /iPad|iPhone|iPod/.test(env.userAgent) || (env.platform === 'MacIntel' && env.maxTouchPoints > 1);
}

export function urlBase64ToBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== b[i]) return false;
  return true;
}

/** Where push stands on this device, without prompting. */
export async function getPushState(env: PushEnv = defaultPushEnv()): Promise<PushState> {
  if (isIOS(env) && !env.standalone) return 'needs-install';
  if (!env.isSecureContext) return 'insecure';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.notification) return 'unsupported';
  if (env.notification.permission === 'denied') return 'denied';
  if (env.notification.permission !== 'granted') return 'off';
  const reg = await env.ready(1500);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return sub ? 'on' : 'off';
}

/** Ask for permission, subscribe and register with the daemon. Call from a tap. */
export async function enablePush(api: Api, env: PushEnv = defaultPushEnv()): Promise<PushState> {
  const before = await getPushState(env);
  if (before === 'needs-install' || before === 'insecure' || before === 'unsupported' || before === 'denied') {
    return before;
  }
  const n = env.notification;
  if (!n) return 'unsupported';
  const perm = n.permission === 'granted' ? 'granted' : await n.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await env.ready(10_000);
  if (!reg) throw new Error("The app's service worker is not running yet. Reload the page and try again.");
  const { publicKey } = await api.vapidKey();
  const key = urlBase64ToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    // Made with an older daemon key: replace it.
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.pushSubscribe({ subscription: sub.toJSON() as PushSubscriptionJSON });
  return 'on';
}

export async function disablePush(api: Api, env: PushEnv = defaultPushEnv()): Promise<PushState> {
  const reg = await env.ready(3000);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe().catch(() => false);
  }
  return getPushState(env);
}

/**
 * Re-register an existing subscription quietly (the daemon may have lost it,
 * e.g. after a reinstall). Never prompts. `kinds` is this device's own
 * choice, if it made one: the daemon replaces the record, so leaving it out
 * would wipe a customised list.
 */
export async function resyncPush(api: Api, env: PushEnv = defaultPushEnv(), kinds?: readonly NotifyKind[]): Promise<void> {
  if (!env.hasServiceWorker || !env.hasPushManager || env.notification?.permission !== 'granted') return;
  const reg = await env.ready(3000);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (!sub) return;
  const body = { subscription: sub.toJSON() as PushSubscriptionJSON, ...(kinds ? { kinds: [...kinds] } : {}) };
  await api.pushSubscribe(body).catch(() => undefined);
}

/** Close system notifications that point at a session (it is on screen now). */
export async function closeNotificationsFor(sid: string, env: PushEnv = defaultPushEnv()): Promise<number> {
  if (!env.hasServiceWorker) return 0;
  const reg = await env.ready(1000);
  if (!reg?.getNotifications) return 0;
  const prefix = `/s/${encodeURIComponent(sid)}`;
  const list = await reg.getNotifications().catch(() => []);
  let closed = 0;
  for (const n of list) {
    const url = (n.data as { url?: unknown } | undefined)?.url;
    if (typeof url === 'string' && (url === prefix || url.startsWith(`${prefix}?`))) {
      n.close();
      closed += 1;
    }
  }
  return closed;
}
