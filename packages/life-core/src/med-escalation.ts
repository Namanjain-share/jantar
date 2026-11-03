// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
/**
 * v0.12 People: the two-day medicine concern (spec 3.4, 4.4), adapted from
 * Noblot's partner medicine escalation (`packages/core/src/health-report.ts`:
 * `MedDay`, `MedEscalation`, `computeMedEscalation`).
 *
 * It reads `computeAdherence().perDay` (adherence.ts). Its `missed` counts
 * the slots past `asOf`, so the caller passes an `asOf` of now minus
 * DOSE_GRACE_MINUTES (the daemon's medicines/day.ts does): a dose that
 * hasn't come due, or came due within the grace, is never a miss. One day
 * with a dose not logged is a
 * `nudge`; doses not logged on `escalateAfterDays` days running (today
 * included) is an `escalate`. It is derived when someone looks: no
 * scheduler, no stored mark, and its words never name a medicine.
 *
 * Jantar's words say "not logged", not "missed": the app knows what was
 * logged, not what was taken.
 */

/** One day of medicine adherence: the part of `computeAdherence().perDay` this reads. */
export interface MedDay {
  day: string;
  taken: number;
  missed: number;
}

export type MedEscalationLevel = 'none' | 'nudge' | 'escalate';

export interface MedEscalation {
  level: MedEscalationLevel;
  missedToday: number;
  /** Days running, ending at `asOfDay`, with at least one dose not logged. */
  consecutiveMissedDays: number;
  message: string;
}

/** Doses not logged on this many days running is the concern line (spec 3.4). */
export const MED_ESCALATE_DAYS = 2;

export function computeMedEscalation(perDay: readonly MedDay[], asOfDay: string, escalateAfterDays = MED_ESCALATE_DAYS): MedEscalation {
  const upto = perDay.filter((d) => d.day <= asOfDay).sort((a, b) => a.day.localeCompare(b.day));
  const today = upto.find((d) => d.day === asOfDay);
  const missedToday = today?.missed ?? 0;

  let streak = 0;
  for (let i = upto.length - 1; i >= 0; i--) {
    if ((upto[i] as MedDay).missed > 0) streak += 1;
    else break;
  }

  if (missedToday === 0 && streak === 0) {
    return { level: 'none', missedToday: 0, consecutiveMissedDays: 0, message: 'Every dose logged.' };
  }
  if (streak >= escalateAfterDays) {
    return { level: 'escalate', missedToday, consecutiveMissedDays: streak, message: `Doses not logged ${streak} days running. Worth checking in.` };
  }
  return {
    level: 'nudge',
    missedToday,
    consecutiveMissedDays: streak,
    message: missedToday > 0 ? `${missedToday} dose${missedToday === 1 ? '' : 's'} not logged today.` : "A dose wasn't logged recently.",
  };
}
