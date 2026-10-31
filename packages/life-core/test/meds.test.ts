// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, it, expect } from "vitest";
import { consumeDose, dosesPerDayForSchedule, medMissPatterns, projectSupply, weekdayOfDayKey } from "../src/meds.js";
import type { DoseLogEntry } from "../src/adherence.js";

describe("projectSupply", () => {
  it("projects whole days of supply and the run-out date", () => {
    const p = projectSupply({ unitsRemaining: 30 }, 2, "2026-03-01");
    expect(p.unitsPerDay).toBe(2);
    expect(p.daysRemaining).toBe(15);
    expect(p.runsOutDay).toBe("2026-03-16");
    expect(p.level).toBe("ok");
  });

  it("floors a partial day — 6.9 days of supply is six safe days", () => {
    expect(projectSupply({ unitsRemaining: 13 }, 2, "2026-03-01").daysRemaining).toBe(6);
  });

  it("counts units per dose, not doses", () => {
    expect(projectSupply({ unitsRemaining: 60, unitsPerDose: 2 }, 3, "2026-03-01").daysRemaining).toBe(10);
  });

  it("goes low at the threshold and out at zero", () => {
    expect(projectSupply({ unitsRemaining: 7 }, 1, "2026-03-01").level).toBe("low");
    expect(projectSupply({ unitsRemaining: 8 }, 1, "2026-03-01").level).toBe("ok");
    expect(projectSupply({ unitsRemaining: 0 }, 1, "2026-03-01").level).toBe("out");
    expect(projectSupply({ unitsRemaining: 20, refillThresholdDays: 30 }, 1, "2026-03-01").level).toBe("low");
  });

  it("refuses to invent a projection for an as-needed med", () => {
    const p = projectSupply({ unitsRemaining: 40 }, 0, "2026-03-01");
    expect(p.daysRemaining).toBeNull();
    expect(p.runsOutDay).toBeNull();
    expect(p.level).toBe("ok");
  });

  it("reports unknown when no inventory is tracked at all", () => {
    expect(projectSupply(undefined, 2, "2026-03-01").level).toBe("unknown");
  });
});

describe("dosesPerDayForSchedule", () => {
  it("is times.length when the med has no schedule (the daily default)", () => {
    expect(dosesPerDayForSchedule({ times: ["08:00", "20:00"] })).toBe(2);
    expect(dosesPerDayForSchedule({ times: ["08:00", "20:00"], schedule: { freq: "daily" } })).toBe(2);
  });

  it("prorates a weekly med so its box does not burn seven times too fast", () => {
    expect(dosesPerDayForSchedule({ times: ["09:00"], schedule: { freq: "weekly", byWeekday: [1] } })).toBeCloseTo(1 / 7);
    expect(dosesPerDayForSchedule({ times: ["09:00"], schedule: { freq: "weekly", byWeekday: [1, 4] } })).toBeCloseTo(2 / 7);
    // 30 units at one shot a week is 210 safe days, not 30.
    expect(projectSupply({ unitsRemaining: 30 }, 1 / 7, "2026-03-01").daysRemaining).toBe(210);
  });

  it("halves an alternate-day regimen and zeroes a paused or as-needed med", () => {
    expect(dosesPerDayForSchedule({ times: ["08:00"], schedule: { freq: "interval", interval: 2, startDay: "2026-03-02" } })).toBe(0.5);
    expect(dosesPerDayForSchedule({ times: [] })).toBe(0);
    expect(dosesPerDayForSchedule({ times: ["08:00"], active: false })).toBe(0);
  });

  it("a FINISHED course burns nothing, so its refill alert can be taken down", () => {
    const course = { times: ["08:00", "20:00"], schedule: { freq: "daily" as const, startDay: "2026-03-01", endDay: "2026-03-10" } };
    // Mid-course it burns normally...
    expect(dosesPerDayForSchedule(course, "2026-03-05")).toBe(2);
    expect(dosesPerDayForSchedule(course, "2026-03-10")).toBe(2); // endDay is INCLUSIVE
    // ...and the day after the last dose it burns nothing at all.
    expect(dosesPerDayForSchedule(course, "2026-03-11")).toBe(0);
    // A zero rate is what makes projectSupply return a null projection, which is the exact signal
    // syncRefillReminder reads to REMOVE the alert — otherwise a completed antibiotic nags forever.
    expect(projectSupply({ unitsRemaining: 4 }, dosesPerDayForSchedule(course, "2026-03-11"), "2026-03-11").daysRemaining).toBeNull();
  });

  it("a course that has not STARTED yet still projects — filling it early is useful, not noise", () => {
    const upcoming = { times: ["08:00"], schedule: { freq: "daily" as const, startDay: "2026-04-01" } };
    expect(dosesPerDayForSchedule(upcoming, "2026-03-01")).toBe(1);
  });

  it("omitting `today` keeps the pre-course-dates behaviour", () => {
    expect(dosesPerDayForSchedule({ times: ["08:00"], schedule: { freq: "daily", endDay: "2020-01-01" } })).toBe(1);
  });
});

describe("consumeDose", () => {
  it("decrements by the units a dose costs", () => {
    expect(consumeDose({ unitsRemaining: 10, unitsPerDose: 2 })).toBe(8);
  });

  it("never goes negative", () => {
    expect(consumeDose({ unitsRemaining: 1, unitsPerDose: 2 })).toBe(0);
  });
});

describe("weekdayOfDayKey", () => {
  it("reads a day key as UTC", () => {
    expect(weekdayOfDayKey("2026-03-06")).toBe(5); // a Friday
  });
});

/** Six Fridays and six Mondays; the 22:00 dose is only ever missed on Fridays. */
function fridayEveningMisses(): { days: string[]; logs: DoseLogEntry[] } {
  const days: string[] = [];
  const logs: DoseLogEntry[] = [];
  // 2026-03-02 is a Monday; walk Mondays and Fridays for six weeks.
  for (let w = 0; w < 6; w++) {
    const monday = new Date(Date.UTC(2026, 2, 2 + w * 7));
    const friday = new Date(Date.UTC(2026, 2, 6 + w * 7));
    for (const d of [monday, friday]) {
      const day = d.toISOString().slice(0, 10);
      days.push(day);
      logs.push({ medId: "m1", day, slot: "08:00", status: "taken" });
      if (d === monday) logs.push({ medId: "m1", day, slot: "22:00", status: "taken" });
    }
  }
  return { days: days.sort(), logs };
}

describe("medMissPatterns", () => {
  const meds = [{ medId: "m1", times: ["08:00", "22:00"] }];

  it("finds the weekday the misses cluster on", () => {
    const { days, logs } = fridayEveningMisses();
    const p = medMissPatterns({ days, meds, logs, asOf: { day: "2026-04-30", time: "23:59" } });
    expect(p.byWeekday.Friday!.missed).toBe(6);
    expect(p.byWeekday.Monday!.missed).toBe(0);
    expect(p.insights.some((i) => i.dimension === "weekday" && i.label === "Friday")).toBe(true);
  });

  it("finds the slot and period the misses cluster on", () => {
    const { days, logs } = fridayEveningMisses();
    const p = medMissPatterns({ days, meds, logs, asOf: { day: "2026-04-30", time: "23:59" } });
    expect(p.bySlot["22:00"]!.missRate).toBeCloseTo(0.5);
    expect(p.bySlot["08:00"]!.missRate).toBe(0);
    expect(p.byPeriod.night!.missed).toBe(6);
    expect(p.insights.some((i) => i.dimension === "slot" && i.label === "22:00")).toBe(true);
  });

  it("never counts a not-yet-due slot as a miss", () => {
    const p = medMissPatterns({
      days: ["2026-03-06"],
      meds,
      logs: [{ medId: "m1", day: "2026-03-06", slot: "08:00", status: "taken" }],
      asOf: { day: "2026-03-06", time: "12:00" },
    });
    expect(p.bySlot["22:00"]).toBeUndefined(); // pending, so it never entered a bucket
    expect(p.insights).toEqual([]);
  });

  it("stays quiet when misses are spread evenly — that is an adherence number, not a pattern", () => {
    const { days } = fridayEveningMisses();
    const logs: DoseLogEntry[] = days.map((day) => ({ medId: "m1", day, slot: "08:00", status: "taken" }));
    const p = medMissPatterns({ days, meds, logs, asOf: { day: "2026-04-30", time: "23:59" } });
    expect(p.byWeekday.Friday!.missRate).toBeCloseTo(0.5);
    expect(p.insights.filter((i) => i.dimension === "weekday")).toEqual([]);
  });

  it("never counts a day the med's schedule does not cover", () => {
    // A Monday-only injection, never taken, across four full weeks. The only bucket that may fill
    // is Monday — "you miss this every Tuesday" must never mean "you don't take it on Tuesdays".
    const days: string[] = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.UTC(2026, 2, 2 + i));
      days.push(d.toISOString().slice(0, 10));
    }
    const p = medMissPatterns({
      days,
      meds: [{ medId: "inj", times: ["09:00"], schedule: { freq: "weekly", byWeekday: [1] } }],
      logs: [],
      asOf: { day: "2026-04-30", time: "23:59" },
    });
    expect(Object.keys(p.byWeekday)).toEqual(["Monday"]);
    expect(p.byWeekday.Monday!.scheduled).toBe(4);
    expect(p.byWeekday.Monday!.missed).toBe(4);
    expect(p.byPeriod.morning!.scheduled).toBe(4);
    // One populated bucket on every axis ⇒ nothing to stand out FROM; that is an adherence number.
    expect(p.insights).toEqual([]);
  });

  it("ignores days outside a med's own active window", () => {
    const { days, logs } = fridayEveningMisses();
    const p = medMissPatterns({
      days,
      meds: [{ medId: "m1", times: ["08:00", "22:00"], startDay: "2026-04-01" }],
      logs,
      asOf: { day: "2026-04-30", time: "23:59" },
    });
    expect(p.byWeekday.Friday!.scheduled).toBeLessThan(6);
  });
});
