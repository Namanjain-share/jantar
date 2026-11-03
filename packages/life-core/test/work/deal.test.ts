// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, expect, it } from "vitest";
import {
  CLOSING_SOON_DAYS,
  canonicalSource,
  daysUntilClose,
  expectedCloseState,
  inClosingWindow,
  lossCodeBreakdown,
  lostReasonLabel,
  normalizeSource,
  sourceTypeahead,
} from "../../src/work/deal.js";

const NOW = "2026-07-25T10:00:00.000Z";
const TODAY = "2026-07-25";
/** A close day `n` calendar days from TODAY (a day key, as Work stores it). */
const inDays = (n: number) => {
  const d = new Date(Date.UTC(2026, 6, 25 + n));
  return d.toISOString().slice(0, 10);
};

describe("lossCodeBreakdown", () => {
  it("counts only lost deals, biggest bucket first", () => {
    const rows = lossCodeBreakdown([
      { lostAt: NOW, lostCode: "price", value: 100 },
      { lostAt: NOW, lostCode: "price", value: 200 },
      { lostAt: NOW, lostCode: "timing", value: 50 },
      { value: 999 }, // still open — must not appear anywhere
    ]);
    expect(rows.map((r) => r.code)).toEqual(["price", "timing"]);
    expect(rows[0]).toMatchObject({ count: 2, value: 300 });
    expect(rows[0]!.share).toBeCloseTo(2 / 3);
  });

  it("buckets an uncoded loss under null rather than dropping it", () => {
    const rows = lossCodeBreakdown([{ lostAt: NOW, value: 10 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBeNull();
    expect(rows[0]!.label).toBe("Unspecified");
  });

  it("is empty when nothing was lost", () => {
    expect(lossCodeBreakdown([{ value: 1 }])).toEqual([]);
  });
});

describe("lostReasonLabel", () => {
  it("names a code and survives an absent one", () => {
    expect(lostReasonLabel("competitor")).toBe("Went with a competitor");
    expect(lostReasonLabel(undefined)).toBe("Unspecified");
  });
});

describe("sources", () => {
  it("folds case and inner whitespace into one key", () => {
    expect(normalizeSource("  Referral  ")).toBe("referral");
    expect(normalizeSource("Cold   Email")).toBe("cold email");
  });

  it("reuses the spelling already in use rather than minting a variant", () => {
    expect(canonicalSource("referral", ["Referral", "Inbound"])).toBe("Referral");
  });

  it("keeps the user's own spelling for a genuinely new source", () => {
    expect(canonicalSource("  LinkedIn ", ["Referral"])).toBe("LinkedIn");
    expect(canonicalSource("   ", ["Referral"])).toBe("");
  });

  it("ranks prefix matches above substring matches and dedupes by key", () => {
    const hits = sourceTypeahead(["Referral", "referral", "Partner referral", "Inbound"], "ref");
    expect(hits).toEqual(["Referral", "Partner referral"]);
  });

  it("lists everything when the query is empty", () => {
    expect(sourceTypeahead(["b", "a"], "")).toEqual(["a", "b"]);
  });
});

describe("expectedCloseState", () => {
  it("separates overdue / today / soon / later", () => {
    expect(expectedCloseState(inDays(-1), TODAY)).toBe("overdue");
    expect(expectedCloseState(inDays(CLOSING_SOON_DAYS), TODAY)).toBe("soon");
    expect(expectedCloseState(inDays(CLOSING_SOON_DAYS + 1), TODAY)).toBe("later");
    expect(expectedCloseState(undefined, TODAY)).toBeNull();
  });

  // A close date is a DAY. Comparing instants made every deal due today read "overdue" from
  // one minute past its own midnight — the state a card paints red and calls late.
  it("calls a deal due TODAY today, all day, not overdue", () => {
    expect(expectedCloseState(TODAY, TODAY)).toBe("today");
    expect(expectedCloseState(inDays(-1), TODAY)).toBe("overdue");
    expect(expectedCloseState(inDays(1), TODAY)).toBe("soon");
  });

  // Work's own case: day keys are calendar arithmetic, so a month end, a leap day and a clock
  // change in the Life zone all count whole days.
  it("counts calendar days across a month end, a leap day and a DST weekend", () => {
    expect(daysUntilClose("2026-08-01", "2026-07-31")).toBe(1);
    expect(daysUntilClose("2028-03-01", "2028-02-28")).toBe(2);
    expect(daysUntilClose("2026-11-02", "2026-10-31")).toBe(2);
    expect(daysUntilClose("2026-03-30", "2026-03-28")).toBe(2);
  });
});

describe("inClosingWindow", () => {
  it("pulls overdue deals INTO the forward windows", () => {
    expect(inClosingWindow(inDays(-10), "week", TODAY)).toBe(true);
    expect(inClosingWindow(inDays(-10), "month", TODAY)).toBe(true);
  });

  it("bounds week at 7 days and month at 31", () => {
    expect(inClosingWindow(inDays(6), "week", TODAY)).toBe(true);
    expect(inClosingWindow(inDays(8), "week", TODAY)).toBe(false);
    expect(inClosingWindow(inDays(8), "month", TODAY)).toBe(true);
    expect(inClosingWindow(inDays(40), "month", TODAY)).toBe(false);
  });

  it("overdue means overdue only", () => {
    expect(inClosingWindow(inDays(-1), "overdue", TODAY)).toBe(true);
    expect(inClosingWindow(inDays(1), "overdue", TODAY)).toBe(false);
    expect(inClosingWindow(undefined, "overdue", TODAY)).toBe(false);
    // Same calendar-day rule as the card's state: due today is not yet overdue.
    expect(inClosingWindow(TODAY, "overdue", TODAY)).toBe(false);
    expect(inClosingWindow(TODAY, "week", TODAY)).toBe(true);
  });
});
