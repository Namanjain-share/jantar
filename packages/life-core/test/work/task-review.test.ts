// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// taskReview — pure aggregation over already-fetched task/activity rows (Deepening: Task
// history, stats & review + Project overview & health). Tests written FIRST per the binding
// convention: no DB, no tz — callers (tasks.ts/projects.ts routers) hand in tz-resolved week
// boundaries/instants via services/lifeos.ts-style TZDate helpers, exactly like taskBucket's
// own split between "pure grouping" and "tz boundary math".
import { describe, it, expect } from "vitest";
import { completedByProject, doneCountsByWeek, isStale, openTaskHealth } from "../../src/work/task-review.js";

describe("completedByProject", () => {
  it("groups completed tasks by projectId, sorted by count desc", () => {
    const rows = completedByProject([
      { _id: "1", projectId: "a" },
      { _id: "2", projectId: "b" },
      { _id: "3", projectId: "a" },
      { _id: "4", projectId: "a" },
    ]);
    expect(rows).toEqual([
      { projectId: "a", completedCount: 3 },
      { projectId: "b", completedCount: 1 },
    ]);
  });

  it("buckets no-project tasks under projectId: null", () => {
    const rows = completedByProject([{ _id: "1" }, { _id: "2", projectId: "a" }]);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ projectId: "a", completedCount: 1 });
    expect(rows).toContainEqual({ projectId: null, completedCount: 1 });
  });

  it("empty input → empty breakdown", () => {
    expect(completedByProject([])).toEqual([]);
  });
});

describe("doneCountsByWeek", () => {
  const week = (startIso: string, endIso: string) => ({
    start: new Date(startIso),
    end: new Date(endIso),
  });

  it("buckets completed dates into their trailing week, start-inclusive end-exclusive", () => {
    const weeks = [
      week("2026-07-06T00:00:00.000Z", "2026-07-13T00:00:00.000Z"),
      week("2026-07-13T00:00:00.000Z", "2026-07-20T00:00:00.000Z"),
    ];
    const dates = [
      new Date("2026-07-06T00:00:00.000Z"), // exactly week1 start — included
      new Date("2026-07-10T12:00:00.000Z"), // mid week1
      new Date("2026-07-12T23:59:59.999Z"), // last ms of week1
      new Date("2026-07-13T00:00:00.000Z"), // exactly week2 start — NOT week1
      new Date("2026-07-15T00:00:00.000Z"), // week2
    ];
    expect(doneCountsByWeek(dates, weeks)).toEqual([3, 2]);
  });

  it("a date outside every window is dropped, not miscounted", () => {
    const weeks = [week("2026-07-06T00:00:00.000Z", "2026-07-13T00:00:00.000Z")];
    const dates = [new Date("2026-06-01T00:00:00.000Z"), new Date("2026-08-01T00:00:00.000Z")];
    expect(doneCountsByWeek(dates, weeks)).toEqual([0]);
  });

  it("empty weeks → empty trend; empty dates → all-zero trend", () => {
    expect(doneCountsByWeek([new Date()], [])).toEqual([]);
    const weeks = [week("2026-07-06T00:00:00.000Z", "2026-07-13T00:00:00.000Z")];
    expect(doneCountsByWeek([], weeks)).toEqual([0]);
  });
});

describe("isStale", () => {
  const now = new Date("2026-07-25T00:00:00.000Z");

  it("older than threshold → stale", () => {
    const lastActivityAt = new Date("2026-06-01T00:00:00.000Z"); // 54 days ago
    expect(isStale(lastActivityAt, now, 30)).toBe(true);
  });

  it("newer than threshold → not stale", () => {
    const lastActivityAt = new Date("2026-07-10T00:00:00.000Z"); // 15 days ago
    expect(isStale(lastActivityAt, now, 30)).toBe(false);
  });

  it("exactly at the threshold boundary → not stale (strictly greater-than)", () => {
    const lastActivityAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(isStale(lastActivityAt, now, 30)).toBe(false);
  });

  it("one millisecond past the boundary → stale", () => {
    const lastActivityAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000 - 1);
    expect(isStale(lastActivityAt, now, 30)).toBe(true);
  });
});

describe("openTaskHealth", () => {
  const overdueBefore = new Date("2026-07-25T00:00:00.000Z"); // start of "today"

  it("counts overdue (dueAt before the boundary) and picks the soonest-due task", () => {
    const tasks = [
      { _id: "1", title: "Late", dueAt: new Date("2026-07-20T00:00:00.000Z") },
      { _id: "2", title: "Later still", dueAt: new Date("2026-07-10T00:00:00.000Z") },
      { _id: "3", title: "Future", dueAt: new Date("2026-08-01T00:00:00.000Z") },
      { _id: "4", title: "No due date" },
    ];
    const health = openTaskHealth(tasks, overdueBefore);
    expect(health.overdueCount).toBe(2);
    expect(health.nextDueTask?._id).toBe("2"); // earliest dueAt overall, not just among overdue
  });

  it("a task due exactly at the boundary is NOT overdue (strictly-before semantics)", () => {
    const health = openTaskHealth([{ _id: "1", title: "T", dueAt: overdueBefore }], overdueBefore);
    expect(health.overdueCount).toBe(0);
  });

  it("no tasks with a due date → zero overdue, no next-due task", () => {
    const health = openTaskHealth([{ _id: "1", title: "No date" }], overdueBefore);
    expect(health).toEqual({ overdueCount: 0, nextDueTask: null });
  });

  it("empty input → zero/null", () => {
    expect(openTaskHealth([], overdueBefore)).toEqual({ overdueCount: 0, nextDueTask: null });
  });
});
