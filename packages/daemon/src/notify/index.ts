/**
 * Notifications for jantard (work package E). v0.1 has one channel, Web Push;
 * Mac banners and Telegram arrive in v0.2 as further `Notifier`s.
 */
import type { Factories, Notifier } from '../contracts.js';
import { NotificationRouterImpl } from './router.js';
import { WebPushNotifier } from './webpush.js';

export * from './direct.js';
export * from './format.js';
export * from './push-hosts.js';
export * from './router.js';
export * from './vapid.js';
export * from './webpush.js';

export const createNotifiers: Factories['notifiers'] = (ctx): Notifier[] => [new WebPushNotifier(ctx)];

export const createNotificationRouter: Factories['notifications'] = (ctx, deps) => new NotificationRouterImpl(ctx, deps);

/** The Web Push notifier among `notifiers`, if any (the API serves its public key). */
export function findWebPush(notifiers: readonly Notifier[]): WebPushNotifier | null {
  return (notifiers.find((n) => n instanceof WebPushNotifier) as WebPushNotifier | undefined) ?? null;
}
