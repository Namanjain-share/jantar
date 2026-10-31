// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
//
// Noblot's `schemas/recurrence.ts` declares the rule as a zod schema. life-core needs no zod, so the
// same fields are declared here as a plain interface: `computeNextRunAt` and `isRuleDay` read it
// exactly as before. Storage never holds one of these directly; Jantar's protocol stores a todo's
// repeat as `RepeatSchema` (daily, weekly on chosen days, monthly), a strict subset of these fields
// with `interval` always 1, which is passed to `computeNextRunAt` as it is.

/** daily, weekly, monthly or yearly. */
export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** "every N units"; absent or below 1 reads as 1. */
  interval?: number;
  /** 0=Sun..6=Sat, weekly (and with `bySetPos`, monthly or yearly). */
  byWeekday?: number[];
  /** Monthly anchor day, clamped to the month's end. */
  byMonthDay?: number;
  /** Yearly anchor month, 1-12. */
  byMonth?: number;
  /**
   * Nth occurrence of `byWeekday` within the month, 1..4 or -1 for "the last one". Only on
   * monthly or yearly rules, and only with `byWeekday`; `byMonthDay` is not consulted then.
   */
  bySetPos?: number;
  /** `HH:MM` wall-clock fire times in the series' time zone; absent = the anchor's own time. */
  timesOfDay?: string[];
  /** Inclusive upper bound on the occurrence instant. */
  until?: Date;
  /** "Ends after N occurrences": resolved to `until` at write time; `computeNextRunAt` never reads it. */
  count?: number;
}
