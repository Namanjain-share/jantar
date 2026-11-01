/**
 * The only way a Life push leaves the daemon (spec 4.3).
 *
 * - Web Push only: `sendLifePush` hands the notification to the Web Push
 *   notifier (`findWebPush`) and to no other. The mac and telegram
 *   channels have no per-device scope filter, so a medicine or a bill must
 *   never reach them, whatever `notify.mac` and `notify.telegram` say.
 * - `minScope: 'control'`: a read-only device (a shared screen) gets none.
 * - Through notify/direct.ts, so `notify.webpush` off sends nothing and
 *   `notify.kinds` never applies; `notify.muted_until` holds a `life` push
 *   (the scheduler retries it once the mute ends) and never a `med` one.
 * - A send that has not finished after LIFE_PUSH_DEADLINE_MS counts as
 *   failed (`withDeadline`); the scheduler keeps the row out of its sweeps
 *   until the send itself ends, so a slow push service never pushes twice.
 * - v0.5.3: `offline` passes on the failures where the push never left the
 *   Mac (notify/webpush.ts); when every failure is one, the scheduler waits
 *   for the network instead of counting a failure.
 *
 * The text was built by the module that owns the kind; this file adds only
 * the time stamp and the scope, and logs nothing of it.
 */
import { LIFE_PUSH_DEADLINE_MS } from '@jantar/protocol';
import type { Clock, DaemonContext, LifePush, Notification, Notifier } from '../contracts.js';
import { sendDirect } from '../notify/direct.js';
import { findWebPush } from '../notify/index.js';
import { errorKind } from './pings.js';

/** What a Life send answers. `muted`: nothing went out because of the mute (a `life` push only). */
export interface LifeSendResult {
  delivered: number;
  failed: number;
  /** v0.5.3: the failures where the push never left the Mac (DNS or connect: asleep, Wi-Fi off). */
  offline?: number;
  muted?: boolean;
}

/** Sends one Life push (the scheduler's sender: `sendLifePush` in the daemon, a spy in tests). */
export type LifeSend = (p: LifePush) => Promise<LifeSendResult>;

/** The notification a Life push becomes: control-scope devices only. */
export function lifeNotification(p: LifePush, ts: string): Notification {
  return { kind: p.kind, title: p.title, body: p.body, url: p.url, tag: p.tag, ts, minScope: 'control' };
}

/** Web Push only, control scope only; a medicine ignores the mute. No deadline here: see `withDeadline`. */
export async function sendLifePush(
  ctx: Pick<DaemonContext, 'settings' | 'clock' | 'log'>,
  notifiers: readonly Notifier[],
  p: LifePush,
): Promise<LifeSendResult> {
  const webpush = findWebPush(notifiers);
  return sendDirect(ctx, webpush ? [webpush] : [], lifeNotification(p, ctx.clock.iso()), { ignoreMute: p.kind === 'med' });
}

/** The daemon's LifeSend over its notifiers. */
export function createLifeSend(ctx: Pick<DaemonContext, 'settings' | 'clock' | 'log'>, notifiers: readonly Notifier[]): LifeSend {
  return (p) => sendLifePush(ctx, notifiers, p);
}

/** `work`'s value, or `timedOut` when it has not settled within `ms` on `clock`. A rejection is passed on. */
export async function withDeadline<T>(clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>, work: Promise<T>, ms: number = LIFE_PUSH_DEADLINE_MS): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<Clock['setTimeout']> | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = clock.setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), deadline]);
  } finally {
    clock.clearTimeout(timer);
  }
}

/**
 * One push now, within the deadline, never throwing: Life's own notices
 * ("Life data needs attention", "Life backup failed"). False when nothing
 * was delivered.
 */
export async function pushNotice(ctx: Pick<DaemonContext, 'clock' | 'log'>, send: LifeSend, p: LifePush): Promise<boolean> {
  try {
    const r = await withDeadline(ctx.clock, send(p));
    return !r.timedOut && r.value.delivered > 0;
  } catch (e) {
    ctx.log.warn('life notice failed', { tag: p.tag, error: errorKind(e) });
    return false;
  }
}
