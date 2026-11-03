// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
/**
 * v0.11 People: the one delivery resolver (spec 6.3, D25). Every People
 * ring, alert and comment push, to her or to him, asks `resolveDelivery`
 * what to do with it: `push` it now, `hold` it (stored, released later as
 * one summary), `drop` it (it never rings later: a 10:00 ring at 11:30 is
 * noise), or `save` it (over the recipient's caps: kept in history, never
 * pushed).
 *
 * Adapted from Noblot's tier contract (`packages/core/src/notifications.ts`:
 * NOTIFICATION_TIERS, `quietWindowFor`, `resolveNotification`; critical
 * crosses quiet hours, important is held, standard is dropped), its quiet
 * window (`inQuietHours`, `packages/core/src/dynamics.ts`) and the
 * receiver-side wrapper `resolveUsPing` (`coupleEveryday.ts`, where need
 * space is checked before quiet hours). Jantar's tiers add `urgent` (an
 * Urgent alert, which crosses quiet hours only when the recipient allows
 * it), and its states add pause, focus and an open night.
 *
 * Pure: minutes of the day, weekdays and booleans in, a decision out. No
 * clock, no zone: the caller passes the recipient's local minute.
 */

/** The four tiers, loudest first. */
export const DELIVERY_TIERS = ['critical', 'urgent', 'important', 'standard'] as const;
export type DeliveryTier = (typeof DELIVERY_TIERS)[number];

/** Why something is held (the sender sees it, spec 6.2; `sleep` only when the area behind it is shared). */
export type HoldReason = 'paused' | 'muted' | 'space' | 'focus' | 'sleep' | 'quiet';

export type DeliveryDecision =
  | { action: 'push'; reason: 'ok' }
  | { action: 'hold'; reason: HoldReason }
  | { action: 'drop'; reason: HoldReason }
  | { action: 'save'; reason: 'capped' };

/** A quiet window in local minutes of the day, [startMin, endMin), which may wrap midnight. */
export interface QuietWindow {
  startMin: number;
  endMin: number;
  /** The weekdays (0 Sunday … 6 Saturday) a window may START on; absent: every day. */
  days?: readonly number[] | undefined;
}

/** True if `minute` (0–1439) is within [startMin, endMin), which may wrap midnight. An empty window is never quiet. */
export function inQuietHours(minute: number, q: { startMin: number; endMin: number }): boolean {
  if (q.startMin === q.endMin) return false; // empty window
  return q.startMin < q.endMin ? minute >= q.startMin && minute < q.endMin : minute >= q.startMin || minute < q.endMin;
}

/**
 * Whether `minute` on `weekday` is inside the window, honouring its days: a
 * window that wraps midnight belongs to the day it started on, so 02:00 on
 * Saturday is inside a Friday-only 22:00–07:00 window.
 */
export function inQuietWindow(q: QuietWindow | null | undefined, minute: number, weekday: number): boolean {
  if (!q || !inQuietHours(minute, q)) return false;
  if (!q.days || q.days.length === 0) return true;
  const startedYesterday = q.startMin > q.endMin && minute < q.endMin;
  const startDay = startedYesterday ? (weekday + 6) % 7 : weekday;
  return q.days.includes(startDay);
}

/** Minutes until the window ends, from inside it (0 when not inside). */
export function minutesToQuietEnd(q: QuietWindow, minute: number): number {
  if (!inQuietHours(minute, q)) return 0;
  return (q.endMin - minute + 1440) % 1440 || 1440;
}

/** "HH:MM" to minutes of the day (NaN for anything else). */
export function minuteOf(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

/** A stored `{from, to, days?}` window as minutes (null when absent or malformed). */
export function quietWindowOf(q: { from: string; to: string; days?: readonly number[] | undefined } | null | undefined): QuietWindow | null {
  if (!q) return null;
  const startMin = minuteOf(q.from);
  const endMin = minuteOf(q.to);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return null;
  return { startMin, endMin, ...(q.days ? { days: q.days } : {}) };
}

/** The recipient as the resolver sees them now. Every flag is optional: absent is "no". */
export interface RecipientState {
  /** Over the recipient's caps for this kind (alerts, nudges, comments; the caller counts). */
  overCap?: boolean;
  /** She paused (to her only, D14). */
  paused?: boolean;
  /** Her or his `muteUntil` is still ahead. */
  muted?: boolean;
  /** Her status is Need space (to her). */
  needSpace?: boolean;
  /** A focus step of hers is `doing` (to her, C32). */
  focus?: boolean;
  /** A night of hers is open and she holds alerts while she sleeps (to her, O10). */
  asleep?: boolean;
  /** The recipient's quiet window, minute and weekday (local). */
  quiet?: QuietWindow | null;
  minute?: number;
  weekday?: number;
  /** "Urgent breaks through quiet hours" (default on). */
  urgentBreaksQuiet?: boolean;
}

const PUSH: DeliveryDecision = { action: 'push', reason: 'ok' };

/** Urgent where a row says "as quiet hours": through only when the recipient allows it. */
function asQuiet(s: RecipientState, reason: HoldReason): DeliveryDecision {
  return s.urgentBreaksQuiet === false ? { action: 'hold', reason } : PUSH;
}

/**
 * What happens to one push of `tier` for `s` (spec 6.3). Rows are checked
 * top to bottom and the first that applies wins; a cell the table leaves
 * empty doesn't apply, and the next row is read.
 *
 * | state       | critical | urgent        | important | standard |
 * | over caps   | —        | save          | save      | —        |
 * | paused      | push     | hold          | hold      | drop     |
 * | muted       | push     | push          | hold      | drop     |
 * | need space  | push     | as quiet      | hold      | —        |
 * | focus       | push     | as quiet      | hold      | drop     |
 * | asleep      | push     | as quiet      | hold      | drop     |
 * | quiet hours | push     | if allowed    | hold      | drop     |
 * | otherwise   | push     | push          | push      | push     |
 *
 * Need space never holds her own rings (`standard`, "push (her own rings)"):
 * it reads on to the rows below, so her quiet hours still drop them.
 */
export function resolveDelivery(tier: DeliveryTier, s: RecipientState): DeliveryDecision {
  if (tier === 'critical') return PUSH;
  if (s.overCap && (tier === 'urgent' || tier === 'important')) return { action: 'save', reason: 'capped' };
  if (s.paused) return tier === 'standard' ? { action: 'drop', reason: 'paused' } : { action: 'hold', reason: 'paused' };
  if (s.muted) {
    if (tier === 'urgent') return PUSH;
    return tier === 'important' ? { action: 'hold', reason: 'muted' } : { action: 'drop', reason: 'muted' };
  }
  if (s.needSpace && tier !== 'standard') return tier === 'urgent' ? asQuiet(s, 'space') : { action: 'hold', reason: 'space' };
  for (const [on, reason] of [
    [s.focus, 'focus'],
    [s.asleep, 'sleep'],
  ] as const) {
    if (!on) continue;
    if (tier === 'urgent') return asQuiet(s, reason);
    return tier === 'important' ? { action: 'hold', reason } : { action: 'drop', reason };
  }
  const quiet = s.minute !== undefined && inQuietWindow(s.quiet, s.minute, s.weekday ?? 0);
  if (quiet) {
    if (tier === 'urgent') return asQuiet(s, 'quiet');
    return tier === 'important' ? { action: 'hold', reason: 'quiet' } : { action: 'drop', reason: 'quiet' };
  }
  return PUSH;
}
