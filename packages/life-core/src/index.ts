/**
 * @jantar/life-core: the pure logic of the Life modules. No I/O, no clock of
 * its own, no zod: callers pass day keys, instants and the Life time zone.
 *
 * - Copied from Noblot with their tests (docs/PROVENANCE.md): adherence.ts
 *   (which days and times a dose is due, the day checklist, adherence),
 *   meds.ts (pill supply), recurrence.ts (`computeNextRunAt`, `isRuleDay`).
 * - Ours: tz.ts (day keys and wall-clock times in a zone), repeat.ts (a
 *   repeating todo's next day), slots.ts (a dose time's next ping),
 *   snooze.ts (the snooze presets).
 * - v0.11 People: delivery.ts (the one resolver: tiers, quiet hours, holds;
 *   adapted from Noblot), day-review.ts (the evening review's outcomes;
 *   adapted from Noblot), journal-streak.ts (adapted from Noblot), and ours,
 *   sleep-week.ts (nights and the week) and quick-plan.ts (Quick plan).
 * - v0.13 Work (work/): task-review.ts (copied from Noblot with its tests)
 *   and ours, project-health.ts (a project's health line on it); tags.ts and
 *   csv.ts (copied from Noblot with their tests), contacts.ts (adapted from
 *   Noblot with its tests: names, e-mails and phones compared, duplicate
 *   groups, the log line, touches, vCard), and ours, client-import.ts (an
 *   import row's fields and the duplicate warning). P3: deal.ts (lost
 *   reasons, sources, close days), pipeline.ts (the stage invariant,
 *   deleting a stage, probabilities, the forecast), stage.ts (quiet deals),
 *   insights.ts (win rate, cycle, revenue, funnel, forecast, trend, time in
 *   stage) and milestones.ts, each adapted from Noblot with its tests; P3b:
 *   merge.ts (the merge plan and its conflicts) and segments.ts (client
 *   lists as an in-memory predicate, and the starter lists).
 */
export {
  DOSE_GRACE_MINUTES,
  buildDayChecklist,
  computeAdherence,
  isLateDose,
  isScheduledOn,
  scheduleForDay,
  scheduledTimesOn,
  slotPeriod,
  type AdherenceResult,
  type ChecklistGroup,
  type ChecklistItem,
  type DoseLogEntry,
  type MedScheduleLike,
  type MedWindow,
} from './adherence.js';
export { DEFAULT_REFILL_THRESHOLD_DAYS, consumeDose, dosesPerDayForSchedule, projectSupply, type SupplyProjection } from './meds.js';
export { computeNextRunAt, isRuleDay } from './recurrence.js';
export type { RecurrenceRule } from './recurrence-rule.js';
export { dayKeyOf, daysBetween, hhmmOf, instantAt, isValidTimeZone, monthOf, shiftDay, shiftMonths, weekdayOf } from './tz.js';
export { nextRepeat, repeatRule, type RepeatLike } from './repeat.js';
export { nextMedSlot, type MedSlotSource } from './slots.js';
export { SNOOZE_MORNING, SNOOZE_TONIGHT, snoozeTarget, type SnoozePresetName, type SnoozeTarget } from './snooze.js';
export {
  DELIVERY_TIERS,
  inQuietHours,
  inQuietWindow,
  minuteOf,
  minutesToQuietEnd,
  quietWindowOf,
  resolveDelivery,
  type DeliveryDecision,
  type DeliveryTier,
  type HoldReason,
  type QuietWindow,
  type RecipientState,
} from './delivery.js';
export {
  REVIEW_OUTCOMES,
  countsLine,
  resolvePick,
  reviewCounts,
  reviewOutcome,
  type DayPickOutcome,
  type DayPlanPick,
  type PickState,
  type ResolvedPick,
  type ReviewCounts,
  type ReviewItemState,
  type ReviewOutcome,
} from './day-review.js';
export {
  JOURNAL_PROMPTS,
  JOURNAL_STREAK_MILESTONES,
  addDaysToKey,
  dayKeyFromNumber,
  dayKeyNumber,
  journalStreak,
  nextStreakMilestone,
  promptForDay,
  type JournalPromptPack,
  type JournalStreak,
  type JournalStreakOptions,
} from './journal-streak.js';
export {
  SLEEP_AXIS_MIN,
  SLEEP_AXIS_START,
  SLEEP_HOLD_MAX_H,
  SLEEP_OPEN_MAX_H,
  SLEEP_SHORT_MIN,
  SLEEP_TREND_MIN_NIGHTS,
  axisMinute,
  hoursLabel,
  minutesAsleep,
  mondayOf,
  nightOf,
  sleepWeek,
  type SleepNightLike,
  type SleepWeekSummary,
} from './sleep-week.js';
export { QUICK_BETWEEN_MAX, QUICK_STEPS_MAX, parseQuickPlan, type QuickBetween, type QuickPlan, type QuickStep } from './quick-plan.js';
export { MED_ESCALATE_DAYS, computeMedEscalation, type MedDay, type MedEscalation, type MedEscalationLevel } from './med-escalation.js';
export {
  PROJECT_HEALTH_WEEKS,
  PROJECT_QUIET_DAYS,
  projectHealth,
  projectWeeks,
  type HealthDue,
  type HealthTodo,
  type ProjectHealthInput,
  type ProjectHealthResult,
} from './work/project-health.js';
export { completedByProject, doneCountsByWeek, isStale, openTaskHealth, type WeekWindow } from './work/task-review.js';
export {
  TAG_MAX_LENGTH,
  TAG_PALETTE,
  defaultTagColor,
  normalizeTag,
  normalizeTags,
  planTagRename,
  resolveTagColor,
  tagTypeahead,
  type TagColor,
  type TagRenamePlan,
} from './work/tags.js';
export { parseCsv, toCsv, toCsvRows, unguardCsvCell, type CsvCell } from './work/csv.js';
export {
  LOG_CHANNEL_LABELS,
  LOG_OUTCOME_LABELS,
  TOUCH_KINDS,
  contactAvatarColor,
  contactInitials,
  countsAsTouch,
  duplicatePairKey,
  findDuplicateGroups,
  formatLogLine,
  inferContactLinkType,
  lastTouchAt,
  normalizeContactEmail,
  normalizeContactLink,
  normalizeContactName,
  normalizeContactPhone,
  parseVCard,
  toVCard,
  type ContactLink,
  type ContactLinkInput,
  type ContactLinkType,
  type DuplicateCandidate,
  type DuplicateGroup,
  type DuplicateReason,
  type LogChannel,
  type LogLineLike,
  type LogOutcome,
  type VCardContact,
} from './work/contacts.js';
export {
  IMPORT_FIELDS,
  guessImportMapping,
  importKind,
  importRowFields,
  importState,
  similarContacts,
  similarIn,
  similarIndex,
  vcardRowFields,
  type ImportField,
  type ImportKind,
  type ImportRow,
  type ImportState,
  type SimilarCandidate,
  type SimilarIndex,
  type SimilarProbe,
  type SimilarWhy,
} from './work/client-import.js';
export {
  CLOSING_MONTH_DAYS,
  CLOSING_SOON_DAYS,
  LOST_REASON_CODES,
  LOST_REASON_LABELS,
  canonicalSource,
  daysUntilClose,
  expectedCloseState,
  inClosingWindow,
  lossCodeBreakdown,
  lostReasonLabel,
  normalizeSource,
  sourceTypeahead,
  type CloseState,
  type ClosingWindow,
  type LossCodeRow,
  type LostDeal,
  type LostReasonCode,
} from './work/deal.js';
export {
  DEFAULT_QUIET_DAYS,
  dealIsClosed,
  pipelineForecast,
  planStageDeletions,
  resolveQuietDays,
  stageInvariantError,
  stageProbabilities,
  weightedAmount,
  type BlockedStageDeletion,
  type ForecastColumn,
  type PipelineForecast,
  type PipelineStage,
  type StageDeletionPlan,
  type StageKind,
  type StageMigration,
} from './work/pipeline.js';
export { resolveStageQuietDays, stageHealth, type StageHealth } from './work/stage.js';
export {
  ANALYTICS_PERIODS,
  averageDaysToClose,
  closedInPeriod,
  dealClosedAt,
  dealOutcome,
  forecastByMonth,
  groupByCurrency,
  monthKey,
  monthLabel,
  monthRange,
  pipelineTrend,
  resolveAnalyticsPeriod,
  revenueByMonth,
  sourcePerformance,
  stageFunnel,
  timeInStage,
  weekWindows,
  winRateOf,
  type AnalyticsDeal,
  type AnalyticsPeriod,
  type CycleStats,
  type DealMove,
  type DealOutcome,
  type ForecastByMonth,
  type ForecastMonth,
  type FunnelRow,
  type MonthBucket,
  type OpenDealPosition,
  type ResolvedPeriod,
  type SourceRow,
  type StageDwellRow,
  type StageFunnel,
  type StageTransition,
  type TrendRow,
  type TrendWeek,
  type WinRate,
} from './work/insights.js';
export { MILESTONES_MAX, milestoneMissed, milestoneProgress, type MilestoneLike, type MilestoneProgress } from './work/milestones.js';
export {
  MERGE_FIELDS,
  MERGE_FIELD_LABELS,
  contactMergeConflicts,
  planContactMerge,
  type MergeConflict,
  type MergeField,
  type MergeState,
  type MergeableContact,
  type MergedContactFields,
} from './work/merge.js';
export { describeClientList, matchesClientList, starterClientLists, type ClientListFilters, type ListClient, type StarterList } from './work/segments.js';
