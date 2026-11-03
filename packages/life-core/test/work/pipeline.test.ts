// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_DAYS,
  dealIsClosed,
  pipelineForecast,
  planStageDeletions,
  resolveQuietDays,
  stageInvariantError,
  stageProbabilities,
  weightedAmount,
  type PipelineStage,
} from "../../src/work/pipeline.js";

const S = (id: string, kind: PipelineStage["kind"], order: number, probability?: number): PipelineStage => ({
  id,
  name: id,
  order,
  kind,
  ...(probability === undefined ? {} : { probability }),
});

const PIPELINE: PipelineStage[] = [S("new", "open", 0), S("qual", "open", 1), S("won", "won", 2), S("lost", "lost", 3)];

describe("resolveQuietDays", () => {
  it("falls back to 14 when nothing is configured", () => {
    expect(DEFAULT_QUIET_DAYS).toBe(14);
    expect(resolveQuietDays(undefined)).toBe(14);
  });

  it("honors a configured override and rejects nonsense values", () => {
    expect(resolveQuietDays(3)).toBe(3);
    expect(resolveQuietDays(0)).toBe(14); // 0 would make every deal quiet
    expect(resolveQuietDays(-5)).toBe(14);
    expect(resolveQuietDays(9999)).toBe(14);
  });
});

describe("stageInvariantError", () => {
  it("accepts the empty pipeline", () => {
    expect(stageInvariantError([])).toBeNull();
  });

  it("accepts exactly one won + one lost", () => {
    expect(stageInvariantError(PIPELINE)).toBeNull();
  });

  it("rejects a non-empty pipeline missing a terminal stage", () => {
    expect(stageInvariantError([S("new", "open", 0), S("won", "won", 1)])).toMatch(/exactly one/);
    expect(stageInvariantError([S("new", "open", 0), S("lost", "lost", 1)])).toMatch(/exactly one/);
  });

  it("rejects two won stages", () => {
    expect(stageInvariantError([S("a", "won", 0), S("b", "won", 1), S("lost", "lost", 2)])).toMatch(/exactly one/);
  });

  it("rejects duplicate stage ids (a deal's stage would be ambiguous)", () => {
    expect(stageInvariantError([S("a", "open", 0), S("a", "won", 1), S("l", "lost", 2)])).toMatch(/duplicate/);
  });
});

describe("planStageDeletions", () => {
  const counts = { new: 0, qual: 3, won: 1, lost: 0 };

  it("is a no-op when nothing was deleted", () => {
    expect(planStageDeletions(PIPELINE, PIPELINE, counts, [])).toEqual({ ok: true, moves: [] });
  });

  it("allows deleting an empty stage with no migration", () => {
    const next = PIPELINE.filter((s) => s.id !== "new");
    expect(planStageDeletions(PIPELINE, next, counts, [])).toEqual({ ok: true, moves: [] });
  });

  it("BLOCKS deleting a stage that still holds deals when no target was given", () => {
    const next = PIPELINE.filter((s) => s.id !== "qual");
    const plan = planStageDeletions(PIPELINE, next, counts, []);
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("unreachable");
    expect(plan.blocked).toEqual([{ stageId: "qual", name: "qual", count: 3 }]);
  });

  it("BLOCKS when the migration target is itself being deleted", () => {
    const next = PIPELINE.filter((s) => s.id !== "qual" && s.id !== "new");
    const plan = planStageDeletions(PIPELINE, next, counts, [{ fromStageId: "qual", toStageId: "new" }]);
    expect(plan.ok).toBe(false);
  });

  it("accepts an explicit surviving target and returns the move to run", () => {
    const next = PIPELINE.filter((s) => s.id !== "qual");
    expect(planStageDeletions(PIPELINE, next, counts, [{ fromStageId: "qual", toStageId: "new" }])).toEqual({ ok: true, moves: [{ fromStageId: "qual", toStageId: "new" }] });
  });

  it("reports every blocked stage at once, not just the first", () => {
    const plan = planStageDeletions(PIPELINE, [S("new", "open", 0)], { ...counts, won: 2, lost: 4 }, []);
    if (plan.ok) throw new Error("unreachable");
    expect(plan.blocked.map((b) => b.stageId).sort()).toEqual(["lost", "qual", "won"]);
  });
});

describe("stage probability + weighted forecast", () => {
  it("pins terminals and ramps unconfigured open stages by position", () => {
    // 2 open stages → 1/3 and 2/3 of the way to a close
    expect(stageProbabilities(PIPELINE)).toEqual({ new: 33, qual: 67, won: 100, lost: 0 });
  });

  it("an explicit probability always wins over the ramp", () => {
    const configured = [S("new", "open", 0, 10), S("qual", "open", 1), S("won", "won", 2), S("lost", "lost", 3)];
    expect(stageProbabilities(configured).new).toBe(10);
    expect(stageProbabilities(configured).qual).toBe(67);
  });

  it("a terminal probability override is ignored — won is always 100, lost always 0", () => {
    const silly = [S("won", "won", 0, 42), S("lost", "lost", 1, 42)];
    expect(stageProbabilities(silly)).toEqual({ won: 100, lost: 0 });
  });

  it("weightedAmount rounds to whole minor units", () => {
    expect(weightedAmount(10_000, 33)).toBe(3300);
    expect(weightedAmount(999, 50)).toBe(500);
    expect(weightedAmount(10_000, 0)).toBe(0);
  });

  it("pipelineForecast sums open stages only — won/lost are history, not forecast", () => {
    const forecast = pipelineForecast([
      { stageId: "new", kind: "open", value: 100_000, probability: 25 },
      { stageId: "qual", kind: "open", value: 40_000, probability: 50 },
      { stageId: "won", kind: "won", value: 500_000, probability: 100 },
      { stageId: "lost", kind: "lost", value: 90_000, probability: 0 },
    ]);
    expect(forecast).toEqual({ openValue: 140_000, weighted: 45_000, wonValue: 500_000 });
  });

  // Work's six default stages: four open ones ramp 20, 40, 60, 80.
  it("ramps Work's four default open stages evenly", () => {
    const work = [S("new", "open", 0), S("contacted", "open", 1), S("proposal", "open", 2), S("negotiation", "open", 3), S("won", "won", 4), S("lost", "lost", 5)];
    expect(stageProbabilities(work)).toEqual({ new: 20, contacted: 40, proposal: 60, negotiation: 80, won: 100, lost: 0 });
  });
});

describe("deal lifecycle", () => {
  const openDeal = { stage: "new", stageMovedAt: "2026-07-25T10:00:00.000Z" };

  it("dealIsClosed only for a won or lost deal", () => {
    expect(dealIsClosed(openDeal)).toBe(false);
    expect(dealIsClosed({ ...openDeal, wonAt: "2026-07-26T10:00:00.000Z" })).toBe(true);
    expect(dealIsClosed({ ...openDeal, lostAt: "2026-07-26T10:00:00.000Z" })).toBe(true);
    expect(dealIsClosed(undefined)).toBe(false);
  });
});
