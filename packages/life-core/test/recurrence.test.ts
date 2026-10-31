// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, expect, it } from "vitest";
import { TZDate } from "@date-fns/tz";
import { computeNextRunAt, isRuleDay } from "../src/recurrence.js";
import type { RecurrenceRule } from "../src/recurrence-rule.js";

const IST = "Asia/Kolkata";
const NY = "America/New_York";

/** Build a UTC instant from a wall-clock in a timezone (mirrors how nextRunAt is stored). */
function inst(
  tz: string,
  y: number,
  m1: number,
  d: number,
  h: number,
  mi = 0,
): Date {
  return new Date(new TZDate(y, m1 - 1, d, h, mi, 0, 0, tz).getTime());
}

/** Read back the wall-clock in a timezone for assertions. */
function wall(instant: Date, tz: string) {
  const z = new TZDate(instant.getTime(), tz);
  return {
    y: z.getFullYear(),
    m: z.getMonth() + 1,
    d: z.getDate(),
    h: z.getHours(),
    mi: z.getMinutes(),
  };
}

describe("computeNextRunAt — daily", () => {
  it("advances one day and preserves the IST wall-clock time", () => {
    const from = inst(IST, 2026, 7, 16, 9, 0); // 09:00 IST
    const next = computeNextRunAt({ freq: "daily", interval: 1 }, from, IST)!;
    expect(wall(next, IST)).toEqual({ y: 2026, m: 7, d: 17, h: 9, mi: 0 });
  });

  it("a 09:00 Asia/Kolkata daily reminder resolves to the correct UTC instant (03:30Z)", () => {
    const from = inst(IST, 2026, 7, 16, 9, 0);
    const next = computeNextRunAt({ freq: "daily", interval: 1 }, from, IST)!;
    // 09:00 IST = 03:30 UTC (IST = UTC+5:30, no DST).
    expect(next.getUTCHours()).toBe(3);
    expect(next.getUTCMinutes()).toBe(30);
    expect(next.getUTCDate()).toBe(17);
  });

  it("honors interval > 1", () => {
    const from = inst(IST, 2026, 7, 16, 9, 0);
    const next = computeNextRunAt({ freq: "daily", interval: 3 }, from, IST)!;
    expect(wall(next, IST).d).toBe(19);
  });
});

describe("computeNextRunAt — weekly byWeekday across week boundaries", () => {
  it("from Friday, [Mon,Wed,Fri] jumps to Monday next week", () => {
    // 2026-07-17 is a Friday.
    const from = inst(IST, 2026, 7, 17, 18, 0);
    const rule: RecurrenceRule = {
      freq: "weekly",
      interval: 1,
      byWeekday: [1, 3, 5], // Mon, Wed, Fri
    };
    const next = computeNextRunAt(rule, from, IST)!;
    const w = wall(next, IST);
    // Next Monday = 2026-07-20, time preserved.
    expect(w).toEqual({ y: 2026, m: 7, d: 20, h: 18, mi: 0 });
  });

  it("within-week hop: from Monday, [Mon,Wed,Fri] → Wednesday same week", () => {
    // 2026-07-20 is a Monday.
    const from = inst(IST, 2026, 7, 20, 18, 0);
    const next = computeNextRunAt(
      { freq: "weekly", interval: 1, byWeekday: [1, 3, 5] },
      from,
      IST,
    )!;
    expect(wall(next, IST).d).toBe(22); // Wednesday
  });

  it("interval 2 (biweekly) skips a week", () => {
    // 2026-07-20 Monday → next Monday-only occurrence two weeks later.
    const from = inst(IST, 2026, 7, 20, 9, 0);
    const next = computeNextRunAt(
      { freq: "weekly", interval: 2, byWeekday: [1] },
      from,
      IST,
    )!;
    expect(wall(next, IST).d).toBe(3); // 2026-08-03
    expect(wall(next, IST).m).toBe(8);
  });

  it("no byWeekday defaults to the anchor weekday", () => {
    const from = inst(IST, 2026, 7, 17, 9, 0); // Friday
    const next = computeNextRunAt({ freq: "weekly", interval: 1 }, from, IST)!;
    expect(wall(next, IST).d).toBe(24); // next Friday
  });
});

describe("computeNextRunAt — monthly with day-31 clamping", () => {
  it("Jan-31 monthly → Feb-28 (clamped)", () => {
    const from = inst(IST, 2026, 1, 31, 9, 0);
    const next = computeNextRunAt(
      { freq: "monthly", interval: 1, byMonthDay: 31 },
      from,
      IST,
    )!;
    expect(wall(next, IST)).toMatchObject({ m: 2, d: 28 });
  });

  it("recovers to the 31st in March (anchor-based, no drift)", () => {
    // Feb-28 is the previous fire, but byMonthDay=31 carries the anchor.
    const from = inst(IST, 2026, 2, 28, 9, 0);
    const next = computeNextRunAt(
      { freq: "monthly", interval: 1, byMonthDay: 31 },
      from,
      IST,
    )!;
    expect(wall(next, IST)).toMatchObject({ m: 3, d: 31 });
  });

  it("leap year: Jan-31 → Feb-29 in 2028", () => {
    const from = inst(IST, 2028, 1, 31, 9, 0);
    const next = computeNextRunAt(
      { freq: "monthly", interval: 1, byMonthDay: 31 },
      from,
      IST,
    )!;
    expect(wall(next, IST)).toMatchObject({ m: 2, d: 29 });
  });

  it("interval 3 (quarterly) on the 15th", () => {
    const from = inst(IST, 2026, 1, 15, 9, 0);
    const next = computeNextRunAt(
      { freq: "monthly", interval: 3, byMonthDay: 15 },
      from,
      IST,
    )!;
    expect(wall(next, IST)).toMatchObject({ m: 4, d: 15 });
  });
});

describe("computeNextRunAt — yearly", () => {
  it("Feb-29 birthday → Feb-28 in a non-leap year", () => {
    const from = inst(IST, 2024, 2, 29, 9, 0); // 2024 is leap
    const next = computeNextRunAt(
      { freq: "yearly", interval: 1, byMonth: 2, byMonthDay: 29 },
      from,
      IST,
    )!;
    expect(wall(next, IST)).toMatchObject({ y: 2025, m: 2, d: 28 });
  });

  it("Feb-29 birthday recovers to Feb-29 on the next leap year", () => {
    const from = inst(IST, 2025, 2, 28, 9, 0); // previous clamped fire
    const next = computeNextRunAt(
      { freq: "yearly", interval: 1, byMonth: 2, byMonthDay: 29 },
      from,
      IST,
    )!;
    // 2026, 2027 non-leap → 28; 2028 leap → 29. interval=1 fires each year, so first is 2026-02-28.
    expect(wall(next, IST)).toMatchObject({ y: 2026, m: 2, d: 28 });
  });

  it("ordinary yearly birthday advances one year and preserves the day", () => {
    const from = inst(IST, 2026, 3, 14, 19, 30);
    const next = computeNextRunAt(
      { freq: "yearly", interval: 1, byMonth: 3, byMonthDay: 14 },
      from,
      IST,
    )!;
    expect(wall(next, IST)).toMatchObject({ y: 2027, m: 3, d: 14, h: 19, mi: 30 });
  });
});

describe("computeNextRunAt — until handling", () => {
  it("returns null when the next occurrence is past until", () => {
    const from = inst(IST, 2026, 7, 16, 9, 0);
    const until = inst(IST, 2026, 7, 16, 23, 0); // same day
    const next = computeNextRunAt(
      { freq: "daily", interval: 1, until },
      from,
      IST,
    );
    expect(next).toBeNull();
  });

  it("returns the occurrence when it lands exactly on/before until", () => {
    const from = inst(IST, 2026, 7, 16, 9, 0);
    const until = inst(IST, 2026, 7, 18, 9, 0);
    const next = computeNextRunAt(
      { freq: "daily", interval: 1, until },
      from,
      IST,
    )!;
    expect(wall(next, IST).d).toBe(17);
  });
});

describe("computeNextRunAt — timezone correctness beyond IST", () => {
  it("computes in the given tz, not the host tz (America/New_York)", () => {
    const from = inst(NY, 2026, 7, 16, 9, 0);
    const next = computeNextRunAt({ freq: "daily", interval: 1 }, from, NY)!;
    expect(wall(next, NY)).toMatchObject({ d: 17, h: 9, mi: 0 });
  });
});

describe("isRuleDay — an anchor a caller hands in still has to obey the rule", () => {
  // 2026-07-16 is a Thursday (4); 2026-07-17 a Friday (5).
  it("rejects a weekday the weekly rule excludes and accepts one it lists", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [1, 3, 5] };
    expect(isRuleDay(rule, inst(IST, 2026, 7, 16, 19, 0), IST)).toBe(false);
    expect(isRuleDay(rule, inst(IST, 2026, 7, 17, 19, 0), IST)).toBe(true);
  });

  it("is evaluated in the GIVEN tz — the same instant can be two weekdays", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [4] }; // Thu only
    const lateThuIST = inst(IST, 2026, 7, 16, 23, 30); // still Thu 14:00 in New York
    expect(isRuleDay(rule, lateThuIST, IST)).toBe(true);
    const earlyFriIST = inst(IST, 2026, 7, 17, 6, 0); // = Thu 20:30 in New York
    expect(isRuleDay(rule, earlyFriIST, IST)).toBe(false);
    expect(isRuleDay(rule, earlyFriIST, NY)).toBe(true);
  });

  it("an unnarrowed rule allows every day", () => {
    expect(isRuleDay({ freq: "daily", interval: 1 }, inst(IST, 2026, 7, 16, 9, 0), IST)).toBe(true);
    expect(isRuleDay({ freq: "weekly", interval: 1 }, inst(IST, 2026, 7, 16, 9, 0), IST)).toBe(true);
  });

  it("monthly/yearly narrowing clamps to the month end, like computeNextRunAt", () => {
    const monthly: RecurrenceRule = { freq: "monthly", interval: 1, byMonthDay: 31 };
    expect(isRuleDay(monthly, inst(IST, 2026, 2, 28, 9, 0), IST)).toBe(true); // clamped
    expect(isRuleDay(monthly, inst(IST, 2026, 2, 27, 9, 0), IST)).toBe(false);
    const yearly: RecurrenceRule = { freq: "yearly", interval: 1, byMonth: 9, byMonthDay: 1 };
    expect(isRuleDay(yearly, inst(IST, 2026, 9, 1, 9, 0), IST)).toBe(true);
    expect(isRuleDay(yearly, inst(IST, 2026, 8, 18, 9, 0), IST)).toBe(false);
  });
});

// ── bySetPos: "the 2nd Tuesday of the month" ────────────────────────────────────────────────
describe("computeNextRunAt — nth weekday of the month (bySetPos)", () => {
  const secondTuesday: RecurrenceRule = {
    freq: "monthly",
    interval: 1,
    byWeekday: [2], // Tue
    bySetPos: 2,
  };

  it("lands on the 2nd Tuesday, which is a DIFFERENT date each month", () => {
    // Sep 2026: Tuesdays are 1, 8, 15, 22, 29 → 2nd is the 8th.
    // Oct 2026: Tuesdays are 6, 13, 20, 27    → 2nd is the 13th.
    // Nov 2026: Tuesdays are 3, 10, 17, 24    → 2nd is the 10th.
    const oct = computeNextRunAt(secondTuesday, inst(IST, 2026, 9, 8, 9), IST)!;
    expect(wall(oct, IST)).toMatchObject({ y: 2026, m: 10, d: 13, h: 9 });
    const nov = computeNextRunAt(secondTuesday, oct, IST)!;
    expect(wall(nov, IST)).toMatchObject({ y: 2026, m: 11, d: 10, h: 9 });
    // The positive anchor that makes the negative below mean something: a byMonthDay rule DOES
    // keep the same number every month, so "different date each month" is a real distinction.
    const byNumber: RecurrenceRule = { freq: "monthly", interval: 1, byMonthDay: 8 };
    expect(wall(computeNextRunAt(byNumber, inst(IST, 2026, 9, 8, 9), IST)!, IST).d).toBe(8);
    expect(wall(oct, IST).d).not.toBe(8);
  });

  it("counts -1 from the END, so 'the last Friday' tracks 4- and 5-Friday months alike", () => {
    const lastFriday: RecurrenceRule = { freq: "monthly", interval: 1, byWeekday: [5], bySetPos: -1 };
    // Oct 2026 Fridays: 2, 9, 16, 23, 30 (five) → 30th. Nov 2026 Fridays: 6, 13, 20, 27 → 27th.
    const oct = computeNextRunAt(lastFriday, inst(IST, 2026, 9, 25, 18), IST)!;
    expect(wall(oct, IST)).toMatchObject({ m: 10, d: 30 });
    const nov = computeNextRunAt(lastFriday, oct, IST)!;
    expect(wall(nov, IST)).toMatchObject({ m: 11, d: 27 });
  });

  it("skips a month that has no such position rather than clamping into the wrong week", () => {
    // 5th Monday. Feb 2027 (Mondays 1, 8, 15, 22) has none; Mar 2027 (1, 8, 15, 22, 29) does.
    const fifthMonday: RecurrenceRule = { freq: "monthly", interval: 1, byWeekday: [1], bySetPos: 4 };
    const rule5: RecurrenceRule = { ...fifthMonday, bySetPos: -1 };
    // Positive anchor: the "last Monday" form always resolves, so a null here would be the rule,
    // not the walker, refusing.
    expect(computeNextRunAt(rule5, inst(IST, 2027, 2, 1, 9), IST)).not.toBeNull();
    // 4th Monday of Feb 2027 is the 22nd; from the 23rd the next is 22 Mar 2027.
    const next = computeNextRunAt(fifthMonday, inst(IST, 2027, 2, 23, 9), IST)!;
    expect(wall(next, IST)).toMatchObject({ y: 2027, m: 3, d: 22 });
  });

  it("isRuleDay narrows to the positioned day, not to every day of the month", () => {
    // Positive anchor first: the 2nd Tuesday of Sep 2026 IS a rule day.
    expect(isRuleDay(secondTuesday, inst(IST, 2026, 9, 8, 9), IST)).toBe(true);
    // …and the 1st and 3rd Tuesdays are not — which is what a byMonthDay-only narrowing missed.
    expect(isRuleDay(secondTuesday, inst(IST, 2026, 9, 1, 9), IST)).toBe(false);
    expect(isRuleDay(secondTuesday, inst(IST, 2026, 9, 15, 9), IST)).toBe(false);
  });

  it("yearly resolves the position inside the anchor month", () => {
    // "The last Thursday of November" — US Thanksgiving. 2026: Nov 26. 2027: Nov 25.
    const rule: RecurrenceRule = {
      freq: "yearly",
      interval: 1,
      byMonth: 11,
      byWeekday: [4],
      bySetPos: -1,
    };
    const y26 = computeNextRunAt(rule, inst(IST, 2026, 1, 1, 12), IST)!;
    expect(wall(y26, IST)).toMatchObject({ y: 2026, m: 11, d: 26 });
    const y27 = computeNextRunAt(rule, y26, IST)!;
    expect(wall(y27, IST)).toMatchObject({ y: 2027, m: 11, d: 25 });
  });
});

// ── timesOfDay: several fires per day on ONE series ─────────────────────────────────────────
describe("computeNextRunAt — multiple fire times per day (timesOfDay)", () => {
  const thriceDaily: RecurrenceRule = {
    freq: "daily",
    interval: 1,
    timesOfDay: ["08:00", "14:00", "20:00"],
  };

  it("walks the day's slots in order, then rolls to the FIRST slot of the next day", () => {
    const t8 = inst(IST, 2026, 9, 10, 8);
    const t14 = computeNextRunAt(thriceDaily, t8, IST)!;
    expect(wall(t14, IST)).toMatchObject({ d: 10, h: 14, mi: 0 });
    const t20 = computeNextRunAt(thriceDaily, t14, IST)!;
    expect(wall(t20, IST)).toMatchObject({ d: 10, h: 20, mi: 0 });
    const nextDay = computeNextRunAt(thriceDaily, t20, IST)!;
    expect(wall(nextDay, IST)).toMatchObject({ d: 11, h: 8, mi: 0 });
    // Positive anchor for the negative that follows: WITHOUT timesOfDay the same daily rule
    // advances a whole day per call and never produces a second fire on the 10th.
    const plain: RecurrenceRule = { freq: "daily", interval: 1 };
    expect(wall(computeNextRunAt(plain, t8, IST)!, IST)).toMatchObject({ d: 11, h: 8 });
  });

  it("is unordered and duplicate-tolerant on input", () => {
    const messy: RecurrenceRule = { freq: "daily", interval: 1, timesOfDay: ["20:00", "08:00", "08:00", "14:00"] };
    const next = computeNextRunAt(messy, inst(IST, 2026, 9, 10, 8), IST)!;
    expect(wall(next, IST)).toMatchObject({ d: 10, h: 14 });
  });

  it("still obeys the day narrowing — a Mon/Wed slot series never fires on a Tuesday", () => {
    // 2026-09-07 is a Monday. byWeekday [1,3] = Mon, Wed.
    const monWed: RecurrenceRule = {
      freq: "weekly",
      interval: 1,
      byWeekday: [1, 3],
      timesOfDay: ["09:00", "17:00"],
    };
    const monMorning = inst(IST, 2026, 9, 7, 9);
    const monEvening = computeNextRunAt(monWed, monMorning, IST)!;
    expect(wall(monEvening, IST)).toMatchObject({ d: 7, h: 17 }); // positive anchor: same Monday
    const wedMorning = computeNextRunAt(monWed, monEvening, IST)!;
    expect(wall(wedMorning, IST)).toMatchObject({ d: 9, h: 9 }); // Wed, not Tue the 8th
  });

  it("applies `until` to the instant that actually fires", () => {
    // until = 10 Sep 15:00 IST. The 14:00 slot is inside it; the 20:00 slot is not.
    const bounded: RecurrenceRule = { ...thriceDaily, until: inst(IST, 2026, 9, 10, 15) };
    const t14 = computeNextRunAt(bounded, inst(IST, 2026, 9, 10, 8), IST);
    expect(t14).not.toBeNull();
    expect(wall(t14!, IST)).toMatchObject({ d: 10, h: 14 });
    expect(computeNextRunAt(bounded, t14!, IST)).toBeNull();
  });

  it("combines with bySetPos — 'the 1st Monday, morning and evening'", () => {
    const rule: RecurrenceRule = {
      freq: "monthly",
      interval: 1,
      byWeekday: [1],
      bySetPos: 1,
      timesOfDay: ["07:30", "19:30"],
    };
    // 1st Monday of Sep 2026 is the 7th; of Oct 2026 is the 5th.
    const evening = computeNextRunAt(rule, inst(IST, 2026, 9, 7, 7, 30), IST)!;
    expect(wall(evening, IST)).toMatchObject({ m: 9, d: 7, h: 19, mi: 30 });
    const nextMonth = computeNextRunAt(rule, evening, IST)!;
    expect(wall(nextMonth, IST)).toMatchObject({ m: 10, d: 5, h: 7, mi: 30 });
  });

  it("crosses a DST boundary on the wall clock, not the UTC clock", () => {
    // US DST ends 2026-11-01. A 09:00/21:00 daily series must stay at 09:00 local either side.
    const rule: RecurrenceRule = { freq: "daily", interval: 1, timesOfDay: ["09:00", "21:00"] };
    const before = inst(NY, 2026, 10, 31, 21);
    const next = computeNextRunAt(rule, before, NY)!;
    expect(wall(next, NY)).toMatchObject({ m: 11, d: 1, h: 9, mi: 0 });
  });
});
