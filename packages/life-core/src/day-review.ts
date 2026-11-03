// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
/**
 * v0.11 People: the evening review's outcomes (spec 3.10), adapted from
 * Noblot's day plan (`packages/core/src/dayPlan.ts`: the pick snapshot,
 * `DayPickOutcome`, `resolvePick`). Every item of a day resolves to done,
 * moved, missed or gone, as there; Jantar adds `skipped` (she skipped it,
 * with her reason) and `excused` (a rough day).
 *
 * The honesty rule (spec 3.2): `moved` is never a failure and `missed` is
 * grey, not red. No outcome feeds a score, a streak, an alert or a concern:
 * these functions only name what happened.
 */
import { dayKeyOf } from './tz.js';

/** What became of a picked item, as Noblot's review names it. */
export type DayPickOutcome = 'done' | 'moved' | 'missed' | 'gone';

/** One picked item, denormalized: the review must still render a row whose source was deleted. */
export interface DayPlanPick {
  kind: string;
  id: string;
  /** Snapshotted when it was sent, so a renamed or deleted source still shows what was committed to. */
  title: string;
}

export interface ResolvedPick extends DayPlanPick {
  outcome: DayPickOutcome;
}

export interface PickState {
  /** Absent from the live data entirely: deleted. */
  missing?: boolean;
  done?: boolean;
  /** The source's current due instant, for the moved check. */
  at?: Date | null;
}

/**
 * Classify one pick (Noblot's `resolvePick`). `moved` (rather than `missed`)
 * when the thing is still open but no longer lands that day: the honest
 * reading of "I pushed it", which the review never scolds.
 */
export function resolvePick(pick: DayPlanPick, state: PickState, dayKey: string, tz: string): ResolvedPick {
  if (state.missing) return { ...pick, outcome: 'gone' };
  if (state.done) return { ...pick, outcome: 'done' };
  if (state.at && dayKeyOf(state.at, tz) !== dayKey) return { ...pick, outcome: 'moved' };
  return { ...pick, outcome: 'missed' };
}

/** Jantar's outcomes: Noblot's four plus skipped and excused. */
export const REVIEW_OUTCOMES = ['done', 'skipped', 'excused', 'moved', 'missed', 'gone'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** What an item of the day looks like now (a plan step, or a todo due that day). */
export interface ReviewItemState {
  /** In the plan as sent, but no longer in it (a step he removed), or a todo deleted after it was due. */
  missing?: boolean;
  /** A step's status, or a todo's: done, skipped (with a reason) or still open. */
  status?: 'todo' | 'doing' | 'done' | 'skipped' | 'excused' | undefined;
  /** The later day it was carried or moved to (a carry, a snooze, a new due day). */
  movedTo?: string | null | undefined;
}

/**
 * An item's outcome (spec 3.10's table): gone, then done, skipped, excused,
 * then moved, and missed for anything still open when the review is sent or
 * closes.
 */
export function reviewOutcome(s: ReviewItemState): ReviewOutcome {
  if (s.missing) return 'gone';
  if (s.status === 'done') return 'done';
  if (s.status === 'skipped') return 'skipped';
  if (s.status === 'excused') return 'excused';
  if (s.movedTo) return 'moved';
  return 'missed';
}

export type ReviewCounts = Record<ReviewOutcome, number>;

/** How many of each outcome. */
export function reviewCounts(outcomes: readonly (ReviewOutcome | undefined)[]): ReviewCounts {
  const out: ReviewCounts = { done: 0, skipped: 0, excused: 0, moved: 0, missed: 0, gone: 0 };
  for (const o of outcomes) if (o) out[o] += 1;
  return out;
}

/** "5 done · 1 moved · 1 missed": the non-zero counts in the table's order (the counts level's one line). */
export function countsLine(c: ReviewCounts): string {
  const parts = REVIEW_OUTCOMES.filter((o) => c[o] > 0).map((o) => `${c[o]} ${o}`);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing planned';
}
