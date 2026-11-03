// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, expect, it } from "vitest";
import { milestoneMissed, milestoneProgress } from "../../src/work/milestones.js";

const TODAY = "2026-05-10";

describe("milestoneProgress", () => {
  it("flags a milestone as missed only while it is still open past its target", () => {
    const p = milestoneProgress(
      [
        { id: "a", name: "Design", target: "2026-05-01" },
        { id: "b", name: "Build", target: "2026-05-01", done: true },
      ],
      TODAY,
    );
    expect(p).toMatchObject({ total: 2, done: 1, percent: 50, missed: ["a"] });
    expect(milestoneMissed({ id: "c", name: "Launch" }, TODAY)).toBe(false);
  });

  it("due today is not missed yet; a day later it is", () => {
    const m = { id: "a", name: "Wireframes", target: TODAY };
    expect(milestoneMissed(m, TODAY)).toBe(false);
    expect(milestoneMissed(m, "2026-05-11")).toBe(true);
  });

  it("the next one is the earliest target among the open ones, else the first open one", () => {
    const list = [
      { id: "a", name: "Kick-off", done: true, target: "2026-04-01" },
      { id: "b", name: "Content" },
      { id: "c", name: "Launch", target: "2026-06-30" },
      { id: "d", name: "Design", target: "2026-05-20" },
    ];
    expect(milestoneProgress(list, TODAY).next?.id).toBe("d");
    expect(milestoneProgress([{ id: "b", name: "Content" }], TODAY).next?.id).toBe("b");
    expect(milestoneProgress([{ id: "a", name: "Done", done: true }], TODAY).next).toBeNull();
  });

  it("is an empty bar with none", () => {
    expect(milestoneProgress([], TODAY)).toEqual({ total: 0, done: 0, percent: 0, missed: [], next: null });
  });
});
