/**
 * Sends that bypass the router (v0.4): Life pushes, like the launcher's and
 * Files' alerts, are not bus events, so `notify.kinds` (the router's
 * filter) never applies to them. What does:
 *
 * - each notifier's channel switch (`notify.webpush` for Web Push, and so on);
 * - `notify.muted_until`, unless `ignoreMute` (a medicine is never muted).
 *
 * The caller picks the notifiers: life/push.ts passes the Web Push one only,
 * because the mac and telegram channels have no per-device scope filter.
 */
import type { Settings } from '@jantar/protocol';
import type { DaemonContext, Notification, Notifier } from '../contracts.js';

/** Whether `notify.muted_until` is still ahead of `nowMs`. */
export function isMuted(notify: Pick<Settings['notify'], 'muted_until'>, nowMs: number): boolean {
  if (!notify.muted_until) return false;
  const until = Date.parse(notify.muted_until);
  return Number.isFinite(until) && until > nowMs;
}

/** Whether settings let `notifier`'s channel send at all. */
export function channelOn(notify: Pick<Settings['notify'], 'webpush' | 'mac' | 'telegram'>, notifier: Pick<Notifier, 'channel'>): boolean {
  switch (notifier.channel) {
    case 'webpush':
      return notify.webpush;
    case 'mac':
      return notify.mac;
    case 'telegram':
      return notify.telegram;
  }
}

export interface DirectResult {
  delivered: number;
  failed: number;
  /** Nothing was sent: muted. */
  muted: boolean;
}

/**
 * Send `n` through `notifiers` now. A notifier that throws counts as one
 * failure; its error is logged with the channel and kind, never the text.
 */
export async function sendDirect(
  ctx: Pick<DaemonContext, 'settings' | 'clock' | 'log'>,
  notifiers: readonly Notifier[],
  n: Notification,
  opts: { ignoreMute?: boolean } = {},
): Promise<DirectResult> {
  const notify = ctx.settings.get().notify;
  if (!opts.ignoreMute && isMuted(notify, ctx.clock.now())) return { delivered: 0, failed: 0, muted: true };
  let delivered = 0;
  let failed = 0;
  for (const notifier of notifiers) {
    if (!channelOn(notify, notifier)) continue;
    try {
      const r = await notifier.send(n);
      delivered += r.delivered;
      failed += r.failed;
    } catch (e) {
      failed += 1;
      ctx.log.error('notifier failed', { channel: notifier.channel, kind: n.kind, error: String(e) });
    }
  }
  return { delivered, failed, muted: false };
}
