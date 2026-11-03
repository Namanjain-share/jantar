// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, expect, it } from "vitest";
import {
  averageDaysToClose,
  closedInPeriod,
  dealOutcome,
  forecastByMonth,
  groupByCurrency,
  monthKey,
  monthLabel,
  monthRange,
  resolveAnalyticsPeriod,
  revenueByMonth,
  sourcePerformance,
  pipelineTrend,
  stageFunnel,
  timeInStage,
  weekWindows,
  winRateOf,
  type AnalyticsDeal,
  type DealMove,
  type StageTransition,
} from "../../src/work/insights.js";
import type { PipelineStage as Stage } from "../../src/work/pipeline.js";

const UTC = "UTC";
const d = (iso: string) => new Date(iso);

/** An analytics deal with sane defaults; override what the case is about. */
function deal(over: Partial<AnalyticsDeal> = {}): AnalyticsDeal {
  return { startedAt: d("2026-01-01T00:00:00Z"), value: 0, ...over };
}

const S = (id: string, kind: Stage["kind"], order: number): Stage => ({
  id,
  name: id,
  order,
  kind,
});
const STAGES: Stage[] = [
  S("new", "open", 0),
  S("qual", "open", 1),
  S("proposal", "open", 2),
  S("won", "won", 3),
  S("lost", "lost", 4),
];

describe("dealOutcome / closedInPeriod", () => {
  it("classifies won / lost / open", () => {
    expect(dealOutcome(deal({ wonAt: d("2026-02-01T00:00:00Z") }))).toBe("won");
    expect(dealOutcome(deal({ lostAt: d("2026-02-01T00:00:00Z") }))).toBe("lost");
    expect(dealOutcome(deal())).toBe("open");
  });

  it("keeps only deals whose CLOSE date lands inside the window (open deals never qualify)", () => {
    const inside = deal({ wonAt: d("2026-03-15T00:00:00Z") });
    const before = deal({ wonAt: d("2026-01-15T00:00:00Z") });
    const after = deal({ lostAt: d("2026-05-15T00:00:00Z") });
    const open = deal({ startedAt: d("2026-03-01T00:00:00Z") });
    const kept = closedInPeriod(
      [inside, before, after, open],
      d("2026-03-01T00:00:00Z"),
      d("2026-04-01T00:00:00Z"),
    );
    expect(kept).toEqual([inside]);
  });
});

describe("winRateOf", () => {
  it("excludes still-open deals from the denominator", () => {
    const deals = [
      deal({ wonAt: d("2026-02-01T00:00:00Z") }),
      deal({ lostAt: d("2026-02-02T00:00:00Z") }),
      deal({ lostAt: d("2026-02-03T00:00:00Z") }),
      deal(), // open — must NOT dilute the rate
      deal(), // open
    ];
    const r = winRateOf(deals);
    expect(r).toEqual({ won: 1, lost: 2, closed: 3, open: 2, rate: 1 / 3 });
  });

  it("reports NO DATA (rate null) for a period with zero closed deals — never NaN or 0%", () => {
    const r = winRateOf([deal(), deal()]);
    expect(r.closed).toBe(0);
    expect(r.rate).toBeNull(); // not 0, not NaN
    expect(Number.isNaN(r.rate as unknown as number)).toBe(false);
    expect(winRateOf([]).rate).toBeNull();
  });

  it("is 1 when everything closed won and 0 when everything closed lost", () => {
    expect(winRateOf([deal({ wonAt: d("2026-02-01T00:00:00Z") })]).rate).toBe(1);
    expect(winRateOf([deal({ lostAt: d("2026-02-01T00:00:00Z") })]).rate).toBe(0);
  });
});

describe("averageDaysToClose", () => {
  it("averages wonAt − startedAt over WON deals only", () => {
    const r = averageDaysToClose([
      deal({ startedAt: d("2026-01-01T00:00:00Z"), wonAt: d("2026-01-11T00:00:00Z") }), // 10
      deal({ startedAt: d("2026-01-01T00:00:00Z"), wonAt: d("2026-01-21T00:00:00Z") }), // 20
      deal({ startedAt: d("2026-01-01T00:00:00Z"), lostAt: d("2026-06-01T00:00:00Z") }), // ignored
      deal(), // open — ignored
    ]);
    expect(r).toEqual({ averageDays: 15, sample: 2, fastestDays: 10, slowestDays: 20 });
  });

  it("reports null (no data) rather than 0 when nothing has been won", () => {
    expect(averageDaysToClose([deal(), deal({ lostAt: d("2026-02-01T00:00:00Z") })])).toEqual({
      averageDays: null,
      sample: 0,
      fastestDays: null,
      slowestDays: null,
    });
  });

  it("clamps a negative cycle (backdated close) to 0 instead of reporting negative days", () => {
    const r = averageDaysToClose([
      deal({ startedAt: d("2026-02-01T00:00:00Z"), wonAt: d("2026-01-01T00:00:00Z") }),
    ]);
    expect(r.averageDays).toBe(0);
  });
});

describe("month helpers", () => {
  it("buckets by the workspace timezone, not UTC", () => {
    // 2026-07-31 20:00 UTC is already August 1st in Asia/Kolkata (+05:30).
    const at = d("2026-07-31T20:00:00Z");
    expect(monthKey(at, UTC)).toBe("2026-07");
    expect(monthKey(at, "Asia/Kolkata")).toBe("2026-08");
  });

  it("monthRange is contiguous and inclusive of both ends", () => {
    expect(monthRange(d("2025-11-05T00:00:00Z"), d("2026-02-20T00:00:00Z"), UTC)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    expect(monthRange(d("2026-02-01T00:00:00Z"), d("2026-02-28T00:00:00Z"), UTC)).toEqual(["2026-02"]);
  });

  it("labels a month key for the axis", () => {
    expect(monthLabel("2026-07")).toBe("Jul 2026");
  });
});

describe("revenueByMonth", () => {
  it("sums WON value per month and zero-fills the gaps", () => {
    const rows = revenueByMonth(
      [
        deal({ value: 100_000, wonAt: d("2026-01-10T00:00:00Z") }),
        deal({ value: 50_000, wonAt: d("2026-01-20T00:00:00Z") }),
        deal({ value: 900_000, wonAt: d("2026-03-02T00:00:00Z") }),
        deal({ value: 777, lostAt: d("2026-02-02T00:00:00Z") }), // lost — no revenue
        deal({ value: 999 }), // open — no revenue
      ],
      { from: d("2026-01-01T00:00:00Z"), to: d("2026-03-31T00:00:00Z"), tz: UTC },
    );
    expect(rows).toEqual([
      { month: "2026-01", label: "Jan 2026", value: 150_000, count: 2 },
      { month: "2026-02", label: "Feb 2026", value: 0, count: 0 },
      { month: "2026-03", label: "Mar 2026", value: 900_000, count: 1 },
    ]);
  });

  it('starts the series at the first win, so "all time" is not a decade of empty bars', () => {
    const rows = revenueByMonth([deal({ value: 42, wonAt: d("2026-05-04T00:00:00Z") })], {
      from: new Date(Date.UTC(1970, 0, 1)),
      to: d("2026-07-26T00:00:00Z"),
      tz: UTC,
    });
    expect(rows[0]?.month).toBe("2026-05");
    expect(rows.at(-1)?.month).toBe("2026-07");
    expect(rows).toHaveLength(3);
  });

  it("zero-fills a bounded 12-month window even when the only win is this month", () => {
    const rows = revenueByMonth([deal({ value: 42, wonAt: d("2026-07-04T00:00:00Z") })], {
      from: d("2025-07-26T00:00:00Z"),
      to: d("2026-07-26T00:00:00Z"),
      tz: UTC,
    });
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows[0]?.month).toBe("2025-07");
    expect(rows.at(-1)).toEqual({ month: "2026-07", label: "Jul 2026", value: 42, count: 1 });
    expect(rows.filter((r) => r.value > 0)).toHaveLength(1);
  });

  it("collapses an unbounded window with zero wins to the current month, not 120 empty 1970s bars", () => {
    const rows = revenueByMonth([], {
      from: new Date(Date.UTC(1970, 0, 1)),
      to: d("2026-07-26T00:00:00Z"),
      tz: UTC,
    });
    expect(rows).toEqual([{ month: "2026-07", label: "Jul 2026", value: 0, count: 0 }]);
  });

  it("ignores wins outside the window", () => {
    const rows = revenueByMonth([deal({ value: 5, wonAt: d("2025-12-31T00:00:00Z") })], {
      from: d("2026-01-01T00:00:00Z"),
      to: d("2026-01-31T00:00:00Z"),
      tz: UTC,
    });
    expect(rows).toEqual([{ month: "2026-01", label: "Jan 2026", value: 0, count: 0 }]);
  });
});

describe("sourcePerformance", () => {
  it("splits deals + revenue by source and never divides by zero on an all-open source", () => {
    const rows = sourcePerformance([
      deal({ source: "referral", wonAt: d("2026-02-01T00:00:00Z"), value: 300 }),
      deal({ source: "referral", lostAt: d("2026-02-02T00:00:00Z"), value: 100 }),
      deal({ source: "inbound", wonAt: d("2026-02-03T00:00:00Z"), value: 100 }),
      deal({ source: "cold", value: 50 }), // still open
      deal({ value: 7 }), // unattributed + open
    ]);
    expect(rows).toEqual([
      { source: "referral", deals: 2, won: 1, lost: 1, open: 0, revenue: 300, openValue: 0, winRate: 0.5 },
      { source: "inbound", deals: 1, won: 1, lost: 0, open: 0, revenue: 100, openValue: 0, winRate: 1 },
      { source: "cold", deals: 1, won: 0, lost: 0, open: 1, revenue: 0, openValue: 50, winRate: null },
      { source: null, deals: 1, won: 0, lost: 0, open: 1, revenue: 0, openValue: 7, winRate: null },
    ]);
  });
});

describe("stageFunnel", () => {
  const T = (toStageId: string, fromStageId?: string): StageTransition =>
    fromStageId === undefined ? { toStageId } : { fromStageId, toStageId };

  it("counts entries and exits per stage and reconciles with the transition list", () => {
    const transitions: StageTransition[] = [
      T("new"), // created on the board
      T("new"),
      T("new"),
      T("qual", "new"),
      T("qual", "new"),
      T("proposal", "qual"),
      T("won", "proposal"),
      T("lost", "qual"),
    ];
    const { rows, unknownEntered, unknownExited } = stageFunnel(STAGES, transitions);
    const byId = Object.fromEntries(rows.map((r) => [r.stageId, r]));

    expect(byId.new).toMatchObject({ entered: 3, exited: 2, advanced: 2, lostFrom: 0, net: 1 });
    expect(byId.qual).toMatchObject({ entered: 2, exited: 2, advanced: 1, lostFrom: 1, net: 0 });
    expect(byId.proposal).toMatchObject({ entered: 1, exited: 1, advanced: 1, lostFrom: 0, net: 0 });
    expect(byId.won).toMatchObject({ entered: 1, exited: 0, net: 1 });
    expect(byId.lost).toMatchObject({ entered: 1, exited: 0, net: 1 });

    // reconciliation: every transition enters exactly one stage, and every transition WITH an
    // origin exits exactly one stage.
    const sum = (k: "entered" | "exited") => rows.reduce((n, r) => n + r[k], 0);
    expect(sum("entered") + unknownEntered).toBe(transitions.length);
    expect(sum("exited") + unknownExited).toBe(transitions.filter((t) => t.fromStageId).length);
    // net across the board = deals that came in and never left
    expect(rows.reduce((n, r) => n + r.net, 0)).toBe(
      transitions.length - transitions.filter((t) => t.fromStageId).length,
    );
  });

  it("conversion rate = advanced / entered, null for a stage nothing entered", () => {
    const { rows } = stageFunnel(STAGES, [T("new"), T("new"), T("qual", "new")]);
    const byId = Object.fromEntries(rows.map((r) => [r.stageId, r]));
    expect(byId.new?.conversionRate).toBe(0.5);
    expect(byId.proposal?.conversionRate).toBeNull(); // nothing entered → no data, not 0%
  });

  it("a backwards move counts as an exit but NOT as advanced", () => {
    const { rows } = stageFunnel(STAGES, [T("proposal"), T("new", "proposal")]);
    const proposal = rows.find((r) => r.stageId === "proposal")!;
    expect(proposal).toMatchObject({ entered: 1, exited: 1, advanced: 0, lostFrom: 0, net: 0 });
  });

  it("quarantines moves referencing a deleted stage instead of dropping them silently", () => {
    const { rows, unknownEntered, unknownExited } = stageFunnel(STAGES, [
      T("ghost"),
      T("new", "ghost"),
    ]);
    expect(unknownEntered).toBe(1);
    expect(unknownExited).toBe(1);
    expect(rows.find((r) => r.stageId === "new")).toMatchObject({ entered: 1, exited: 0 });
  });

  it("orders rows by stage order", () => {
    const { rows } = stageFunnel([S("b", "open", 1), S("a", "open", 0)], []);
    expect(rows.map((r) => r.stageId)).toEqual(["a", "b"]);
  });
});

describe("forecastByMonth", () => {
  const prob = { qual: 40, proposal: 75 };

  it("weights each open deal by its stage probability and buckets by expected close month", () => {
    const out = forecastByMonth(
      [
        deal({ stageId: "qual", value: 100_000, expectedCloseAt: d("2026-08-10T00:00:00Z") }),
        deal({ stageId: "proposal", value: 200_000, expectedCloseAt: d("2026-08-25T00:00:00Z") }),
        deal({ stageId: "qual", value: 40_000, expectedCloseAt: d("2026-10-01T00:00:00Z") }),
        deal({ stageId: "proposal", value: 1_000 }), // no expected close → unscheduled
        deal({ stageId: "qual", value: 5, wonAt: d("2026-08-01T00:00:00Z") }), // closed → ignored
      ],
      prob,
      { tz: UTC },
    );
    expect(out.months).toEqual([
      { month: "2026-08", label: "Aug 2026", value: 300_000, weighted: 190_000, count: 2 },
      { month: "2026-09", label: "Sep 2026", value: 0, weighted: 0, count: 0 },
      { month: "2026-10", label: "Oct 2026", value: 40_000, weighted: 16_000, count: 1 },
    ]);
    expect(out.unscheduled).toEqual({ value: 1_000, weighted: 750, count: 1 });
  });

  it("has no months and a zeroed unscheduled bucket when nothing is in play", () => {
    expect(forecastByMonth([], prob, { tz: UTC })).toEqual({
      months: [],
      unscheduled: { value: 0, weighted: 0, count: 0 },
    });
  });

  it("falls back to 0% for a deal sitting on an unknown stage (never NaN)", () => {
    const out = forecastByMonth(
      [deal({ stageId: "ghost", value: 100, expectedCloseAt: d("2026-08-01T00:00:00Z") })],
      prob,
      { tz: UTC },
    );
    expect(out.months[0]?.weighted).toBe(0);
  });
});

describe("resolveAnalyticsPeriod", () => {
  const now = d("2026-07-26T12:00:00Z");

  it("rolling windows end at now and start N days/months back", () => {
    expect(resolveAnalyticsPeriod("30d", now, UTC).from.toISOString()).toBe("2026-06-26T12:00:00.000Z");
    expect(resolveAnalyticsPeriod("90d", now, UTC).from.toISOString()).toBe("2026-04-27T12:00:00.000Z");
    expect(resolveAnalyticsPeriod("12m", now, UTC).from.toISOString()).toBe("2025-07-26T12:00:00.000Z");
    expect(resolveAnalyticsPeriod("30d", now, UTC).to.getTime()).toBe(now.getTime());
  });

  it("ytd starts at Jan 1 in the workspace timezone", () => {
    expect(resolveAnalyticsPeriod("ytd", now, UTC).from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // +05:30 → local Jan 1 00:00 is Dec 31 18:30 UTC
    expect(resolveAnalyticsPeriod("ytd", now, "Asia/Kolkata").from.toISOString()).toBe(
      "2025-12-31T18:30:00.000Z",
    );
  });

  it("all reaches back far enough to cover any history", () => {
    const all = resolveAnalyticsPeriod("all", now, UTC);
    expect(all.from.getFullYear()).toBeLessThan(2001);
    expect(all.to.getTime()).toBe(now.getTime());
  });
});

describe("weekWindows", () => {
  it("buckets Monday-to-Monday in the workspace timezone", () => {
    // 2026-07-26 is a Sunday; its ISO week began Monday 2026-07-20.
    const weeks = weekWindows(d("2026-07-22T00:00:00Z"), d("2026-07-26T12:00:00Z"), UTC);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.key).toBe("2026-07-20");
    expect(weeks[0]?.label).toBe("20 Jul");
    expect(weeks[0]?.start.toISOString()).toBe("2026-07-20T00:00:00.000Z");
    // Half-open: the current week runs to next Monday even though that is in the future.
    expect(weeks[0]?.end.toISOString()).toBe("2026-07-27T00:00:00.000Z");
  });

  it("names the Monday by its LOCAL date, not a UTC slice", () => {
    // Monday 2026-07-20 00:00 IST is Sunday 2026-07-19 18:30 UTC — a UTC slice would name it
    // "2026-07-19" and shift the whole chart back a day.
    const weeks = weekWindows(d("2026-07-22T00:00:00Z"), d("2026-07-22T00:00:00Z"), "Asia/Kolkata");
    expect(weeks[0]?.key).toBe("2026-07-20");
    expect(weeks[0]?.start.toISOString()).toBe("2026-07-19T18:30:00.000Z");
  });

  it("is contiguous and capped", () => {
    const weeks = weekWindows(d("2026-01-01T00:00:00Z"), d("2026-07-26T00:00:00Z"), UTC);
    expect(weeks.length).toBeGreaterThan(25);
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i]!.start.getTime()).toBe(weeks[i - 1]!.end.getTime());
    }
    expect(weekWindows(d("1970-01-01T00:00:00Z"), d("2026-07-26T00:00:00Z"), UTC, 12)).toHaveLength(12);
  });

  it("caps from the START, so 'all time' ends at the CURRENT week and not in 1970", () => {
    // The "all" preset resolves `from` to the epoch. Truncating forwards would return the first
    // twelve weeks of 1970 — a flat ₹0 line on a workspace with a full pipeline.
    const weeks = weekWindows(d("1970-01-01T00:00:00Z"), d("2026-07-26T00:00:00Z"), UTC, 12);
    expect(weeks.at(-1)?.key).toBe("2026-07-20"); // the Monday of the week containing `to`
    expect(weeks[0]?.key).toBe("2026-05-04"); // eleven weeks earlier, contiguous
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i]!.start.getTime()).toBe(weeks[i - 1]!.end.getTime());
    }
  });
});

describe("pipelineTrend", () => {
  const weeks = weekWindows(d("2026-07-06T00:00:00Z"), d("2026-07-26T00:00:00Z"), UTC);

  it("counts added / won / lost into the week the event happened", () => {
    const rows = pipelineTrend(
      [
        deal({ startedAt: d("2026-07-07T09:00:00Z"), value: 100_00 }),
        deal({ startedAt: d("2026-07-01T00:00:00Z"), wonAt: d("2026-07-15T00:00:00Z"), value: 500_00 }),
        deal({ startedAt: d("2026-07-01T00:00:00Z"), lostAt: d("2026-07-15T00:00:00Z"), value: 300_00 }),
      ],
      weeks,
    );
    expect(rows.map((r) => r.key)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
    expect(rows[0]).toMatchObject({ added: 1, addedValue: 100_00, won: 0, lost: 0 });
    expect(rows[1]).toMatchObject({ won: 1, wonValue: 500_00, lost: 1, lostValue: 300_00 });
  });

  it("values the open book AT EACH WEEK'S END — a deal closed in the week has left it", () => {
    const rows = pipelineTrend(
      [deal({ startedAt: d("2026-07-07T00:00:00Z"), value: 200_00, wonAt: d("2026-07-15T00:00:00Z") })],
      weeks,
    );
    // Open through the end of week 1 (Mon 13th), gone by the end of week 2 (Mon 20th).
    expect(rows[0]).toMatchObject({ openCount: 1, openValue: 200_00 });
    expect(rows[1]).toMatchObject({ openCount: 0, openValue: 0 });
    expect(rows[2]).toMatchObject({ openCount: 0, openValue: 0 });
  });

  it("a still-open deal keeps contributing to every later week", () => {
    const rows = pipelineTrend([deal({ startedAt: d("2026-07-07T00:00:00Z"), value: 900_00 })], weeks);
    expect(rows.map((r) => r.openValue)).toEqual([900_00, 900_00, 900_00]);
  });
});

describe("timeInStage", () => {
  const now = d("2026-07-26T00:00:00Z");
  const move = (dealKey: string, toStageId: string, at: string): DealMove => ({
    dealKey,
    toStageId,
    at: d(at),
  });

  it("brackets a dwell between consecutive moves on the same card", () => {
    const rows = timeInStage(
      STAGES,
      [
        move("a", "new", "2026-07-01T00:00:00Z"),
        move("a", "qual", "2026-07-05T00:00:00Z"), // 4d in new
        move("b", "new", "2026-07-10T00:00:00Z"),
        move("b", "qual", "2026-07-16T00:00:00Z"), // 6d in new
      ],
      now,
    );
    const created = rows.find((r) => r.stageId === "new")!;
    expect(created).toMatchObject({ sample: 2, averageDays: 5, medianDays: 5 });
  });

  it("reports null (not zero) for a stage nothing has left, and surfaces what is stuck there", () => {
    const rows = timeInStage(
      STAGES,
      [move("a", "proposal", "2026-07-06T00:00:00Z"), move("b", "proposal", "2026-07-16T00:00:00Z")],
      now,
    );
    const proposal = rows.find((r) => r.stageId === "proposal")!;
    expect(proposal.averageDays).toBeNull();
    expect(proposal.sample).toBe(0);
    expect(proposal).toMatchObject({ sittingCount: 2, oldestSittingDays: 20 });
  });

  it("never measures time spent in a terminal stage — repeat business chains through won", () => {
    const rows = timeInStage(
      STAGES,
      [
        move("a", "new", "2026-01-01T00:00:00Z"),
        move("a", "won", "2026-01-05T00:00:00Z"),
        // The same client comes back six months later; the gap is NOT a stage dwell.
        move("a", "new", "2026-07-01T00:00:00Z"),
      ],
      now,
    );
    expect(rows.some((r) => r.stageId === "won")).toBe(false);
    const created = rows.find((r) => r.stageId === "new")!;
    expect(created).toMatchObject({ sample: 1, averageDays: 4, sittingCount: 1 });
  });

  it("orders moves by time even when the log hands them over shuffled", () => {
    const rows = timeInStage(
      STAGES,
      [move("a", "qual", "2026-07-09T00:00:00Z"), move("a", "new", "2026-07-07T00:00:00Z")],
      now,
    );
    expect(rows.find((r) => r.stageId === "new")).toMatchObject({ sample: 1, averageDays: 2 });
  });

  it("takes 'sitting now' from the LIVE board, not from a windowed move scan", () => {
    // The deal landed on Proposal 120 days ago — before any 90-day move window opens — so the
    // event scan sees nothing at all. It is still the stage's worst stuck deal.
    const rows = timeInStage(STAGES, [], now, [
      { stageId: "proposal", since: d("2026-03-28T00:00:00Z") },
    ]);
    const proposal = rows.find((r) => r.stageId === "proposal")!;
    expect(proposal).toMatchObject({ sample: 0, averageDays: null, sittingCount: 1 });
    expect(proposal.oldestSittingDays).toBeGreaterThan(110);
  });

  it("does not double-count a card that is both in the move scan and on the live board", () => {
    const rows = timeInStage(
      STAGES,
      [move("a", "new", "2026-07-01T00:00:00Z"), move("a", "qual", "2026-07-05T00:00:00Z")],
      now,
      [{ stageId: "qual", since: d("2026-07-05T00:00:00Z") }],
    );
    expect(rows.find((r) => r.stageId === "new")).toMatchObject({ sample: 1, sittingCount: 0 });
    expect(rows.find((r) => r.stageId === "qual")).toMatchObject({ sample: 0, sittingCount: 1 });
  });

  it("uses the median to resist one abandoned deal skewing the mean", () => {
    const rows = timeInStage(
      STAGES,
      [
        move("a", "new", "2026-07-01T00:00:00Z"), move("a", "qual", "2026-07-02T00:00:00Z"),
        move("b", "new", "2026-07-01T00:00:00Z"), move("b", "qual", "2026-07-02T00:00:00Z"),
        move("c", "new", "2026-01-01T00:00:00Z"), move("c", "qual", "2026-07-01T00:00:00Z"),
      ],
      now,
    );
    const created = rows.find((r) => r.stageId === "new")!;
    expect(created.medianDays).toBe(1);
    expect(created.averageDays).toBeGreaterThan(50);
  });
});

// Work's own cases: the financial year as a period, and one book per currency (W17).
describe("Work: the financial year and currencies", () => {
  it("fy starts on 1 April in the Life zone, the year before while it is still January to March", () => {
    expect(resolveAnalyticsPeriod("fy", d("2026-07-26T12:00:00Z"), UTC).from.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(resolveAnalyticsPeriod("fy", d("2026-02-10T12:00:00Z"), UTC).from.toISOString()).toBe("2025-04-01T00:00:00.000Z");
    // +05:30 → local 1 April 00:00 is 31 March 18:30 UTC; and 31 March 20:00 UTC is already 1 April there.
    expect(resolveAnalyticsPeriod("fy", d("2026-03-31T20:00:00Z"), "Asia/Kolkata").from.toISOString()).toBe("2026-03-31T18:30:00.000Z");
  });

  it("splits a book by currency, never summing across them", () => {
    const books = groupByCurrency([
      { id: "a", currency: "INR", value: 100 },
      { id: "b", currency: "USD", value: 5 },
      { id: "c", currency: "INR", value: 200 },
      { id: "d", value: 7 },
    ]);
    expect([...books.keys()]).toEqual(["INR", "USD", null]);
    expect(books.get("INR")?.map((x) => x.id)).toEqual(["a", "c"]);
    expect(books.get(null)?.map((x) => x.id)).toEqual(["d"]);
    expect(winRateOf([]).rate).toBeNull();
  });
});
