// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// taskReview — pure aggregation over already-fetched task/activity rows, shared by the tasks
// router's weekly-review/stale-task-nudge procs (Deepening: Task history, stats & review) and
// the projects router's per-project health fields (Deepening: Project overview & health). NO
// DB, NO tz resolution here — callers (packages/api/src/routers/{tasks,projects}.ts) do their
// own tz-aware day/week-boundary math (mirroring services/lifeos.ts's TZDate helpers) and hand
// in plain Dates, so this stays a pure array transform, unit-testable without a clock or a
// timezone — same split `viz/*.ts`'s pure geometry keeps from its React chrome.

export interface CompletedTaskLike {
  _id: string;
  projectId?: string;
}

export interface ProjectBreakdownRow {
  projectId: string | null;
  completedCount: number;
}

/** Groups a set of completed tasks by project (no-project tasks bucket under `null`), sorted
 *  by count descending — the weekly-review "per-project breakdown". */
export function completedByProject(completed: CompletedTaskLike[]): ProjectBreakdownRow[] {
  const counts = new Map<string | null, number>();
  for (const t of completed) {
    const key = t.projectId ?? null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([projectId, completedCount]) => ({ projectId, completedCount }))
    .sort((a, b) => b.completedCount - a.completedCount);
}

export interface WeekWindow {
  start: Date;
  end: Date;
}

/** Trailing weekly done-counts (same order as `weeks`, so callers pass oldest→newest for a
 *  left-to-right chronological trend) — feeds the Bar/Sparkline viz, no burndown theater, just
 *  "how many finished each week". Each window is start-inclusive, end-exclusive. */
export function doneCountsByWeek(completedDates: Date[], weeks: WeekWindow[]): number[] {
  return weeks.map(({ start, end }) => completedDates.filter((d) => d >= start && d < end).length);
}

/** A task/project is "stale" when its last REAL activity (from the activities log — never a
 *  denormalized `updatedAt` that could in principle drift from what actually happened) is
 *  strictly older than `thresholdDays`. Callers gate by status/lifecycle themselves (a done
 *  task or an archived project is never "stale", it's just finished). */
export function isStale(lastActivityAt: Date, now: Date, thresholdDays: number): boolean {
  return now.getTime() - lastActivityAt.getTime() > thresholdDays * 24 * 60 * 60 * 1000;
}

export interface OpenTaskLike {
  _id: string;
  title: string;
  dueAt?: Date;
}

export interface OpenTaskHealth {
  overdueCount: number;
  /** The soonest-due open task (by dueAt), regardless of whether it's overdue — `null` when no
   *  open task carries a dueAt at all. */
  nextDueTask: OpenTaskLike | null;
}

/** Overdue-count + soonest-due task from a project's (or any set of) open tasks. `overdueBefore`
 *  is the CALLER'S OWN tz-day-boundary instant — the exact "start of today" tasks.list's own
 *  `overdue` filter already uses — never a raw `now` compare, so a task due later today never
 *  misreports as overdue (mirrors tasks.ts's `todayBoundsUTC` semantics). */
export function openTaskHealth(tasks: OpenTaskLike[], overdueBefore: Date): OpenTaskHealth {
  let overdueCount = 0;
  let nextDueTask: OpenTaskLike | null = null;
  for (const t of tasks) {
    if (!t.dueAt) continue;
    if (t.dueAt < overdueBefore) overdueCount++;
    if (!nextDueTask || (nextDueTask.dueAt as Date) > t.dueAt) nextDueTask = t;
  }
  return { overdueCount, nextDueTask };
}
