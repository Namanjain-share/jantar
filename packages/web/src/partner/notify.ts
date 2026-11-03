/**
 * v0.11 People: notifications on her phone, shared by her first-run steps
 * (after Accept and join), the card on Today and Me › Notifications.
 *
 * - On an iPhone, Web Push works only from the app on her Home Screen, so
 *   the first step there is "Add to Home Screen" (the owner's pairing has
 *   the same step).
 * - Turn on asks for permission, subscribes her device and sends a test.
 */
import type { PersonApi } from './api.js';

/** An iPhone or iPad browser tab (not the Home Screen app). */
export function needsHomeScreen(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
  return ios && !standalone;
}

/** Whether this device already lets her app notify (permission given). */
export function notificationsOn(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/** Whether to show the "Turn on notifications" card: not on yet, and not refused for good. */
export function askForNotifications(): boolean {
  if (needsHomeScreen()) return true;
  return typeof Notification !== 'undefined' && Notification.permission === 'default';
}

/** Turn notifications on and send a test; the sentence to show either way. */
export async function turnOnNotifications(api: PersonApi): Promise<string> {
  try {
    if (needsHomeScreen()) throw new Error('Add the app to your Home Screen first, then open it from there.');
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof PushManager === 'undefined') throw new Error('This browser has no notifications. Add the app to your Home Screen first.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked for this app. Allow them in Settings › Notifications.');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api.pushKey();
    const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
    const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api.pushSubscribe(sub.toJSON());
    const r = await api.pushTest();
    return r.delivered > 0 ? 'Done: a test notification is on its way.' : 'Turned on, but the test did not arrive.';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
