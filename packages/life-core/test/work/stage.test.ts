// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, expect, it } from "vitest";
import { DEFAULT_QUIET_DAYS } from "../../src/work/pipeline.js";
import { resolveStageQuietDays, stageHealth } from "../../src/work/stage.js";

const stage = (quietDays?: number) => (quietDays === undefined ? {} : { quietDays });

describe("resolveStageQuietDays", () => {
  it("prefers the stage's own threshold", () => {
    expect(resolveStageQuietDays(stage(3), 21)).toBe(3);
  });

  it("falls back to the setting, then the default", () => {
    expect(resolveStageQuietDays(stage(), 21)).toBe(21);
    expect(resolveStageQuietDays(stage(), undefined)).toBe(DEFAULT_QUIET_DAYS);
  });

  it("ignores an out-of-range override instead of marking the column permanently quiet", () => {
    expect(resolveStageQuietDays(stage(0), 21)).toBe(21);
  });
});

describe("stageHealth", () => {
  it("is quiet on a healthy column", () => {
    const h = stageHealth(stage(), [1, 2], 14);
    expect(h).toMatchObject({ count: 2, quiet: 0, warning: null });
  });

  it("counts quiet cards against the stage's own threshold", () => {
    const h = stageHealth(stage(3), [1, 4, 9], 30);
    expect(h.quietDays).toBe(3);
    expect(h.quiet).toBe(2);
    expect(h.warning).toBe("2 quiet deals (3d+)");
  });

  it("a card exactly at the threshold is quiet; one deal reads in the singular", () => {
    const h = stageHealth(stage(), [14, 13], 14);
    expect(h).toMatchObject({ count: 2, quiet: 1, warning: "1 quiet deal (14d+)" });
  });

  it("an empty column is healthy", () => {
    expect(stageHealth(stage(2), [], 14)).toEqual({ count: 0, quietDays: 2, quiet: 0, warning: null });
  });
});
