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

/**
 * The notification a Life push becomes: control-scope devices only.
 * v0.12: a push for a person (`p.person`) goes to her devices instead (no
 * scope: her devices hold none of his).
 */
export function lifeNotification(p: LifePush, ts: string): Notification {
  if (p.person !== undefined) return { kind: p.kind, title: p.title, body: p.body, url: p.url, tag: p.tag, ts, audience: { person: p.person } };
  return { kind: p.kind, title: p.title, body: p.body, url: p.url, tag: p.tag, ts, minScope: 'control' };
}

/**
 * v0.12 People: what a person's push says on her lock screen (C36), and her
 * own mute. `hide_all` strips titles ("Jantar", "Medicine time");
 * `hide_alerts` hides the text of the owner's alerts (P2) and leaves Life
 * pushes as they are; `all` shows everything.
 */
export interface PersonPushPrefs {
  lockScreen: 'all' | 'hide_alerts' | 'hide_all';
  muteUntil: string | null;
}

export function personPushText(p: LifePush, prefs: PersonPushPrefs): LifePush {
  if (prefs.lockScreen !== 'hide_all') return p;
  return { ...p, title: 'Jantar', body: p.kind === 'med' ? 'Medicine time' : 'Something new in your space' };
}

/** Web Push only, control scope only; a medicine ignores the mute. No deadline here: see `withDeadline`. */
export async function sendLifePush(
  ctx: Pick<DaemonContext, 'settings' | 'clock' | 'log'>,
  notifiers: readonly Notifier[],
  p: LifePush,
  /** v0.12: her lock screen and mute, for a push of hers (her mute, never his, C36). */
  personPrefs?: (personId: string) => PersonPushPrefs | null,
): Promise<LifeSendResult> {
  const webpush = findWebPush(notifiers);
  const targets = webpush ? [webpush] : [];
  if (p.person !== undefined) {
    const prefs = personPrefs?.(p.person) ?? { lockScreen: 'hide_all', muteUntil: null };
    const until = prefs.muteUntil ? Date.parse(prefs.muteUntil) : NaN;
    if (p.kind !== 'med' && Number.isFinite(until) && until > ctx.clock.now()) return { delivered: 0, failed: 0, muted: true };
    return sendDirect(ctx, targets, lifeNotification(personPushText(p, prefs), ctx.clock.iso()), { ignoreMute: true });
  }
  return sendDirect(ctx, targets, lifeNotification(p, ctx.clock.iso()), { ignoreMute: p.kind === 'med' });
}

/** The daemon's LifeSend over its notifiers. */
export function createLifeSend(
  ctx: Pick<DaemonContext, 'settings' | 'clock' | 'log'>,
  notifiers: readonly Notifier[],
  personPrefs?: (personId: string) => PersonPushPrefs | null,
): LifeSend {
  return (p) => sendLifePush(ctx, notifiers, p, personPrefs);
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
