// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Med adherence math (LIFE-OS §Meds deepen). The load-bearing property under test: a SKIPPED dose
// is not a MISSED dose — it is excluded from `adherencePct`'s denominator but counted against
// `strictPct`, and it never breaks (nor builds) the streak. Written before the implementation.
import { describe, it, expect } from "vitest";
import {
  buildDayChecklist,
  computeAdherence,
  isLateDose,
  isPausedOn,
  isScheduledOn,
  minutesOfDay,
  nearestSlot,
  scheduleForDay,
  scheduledTimesOn,
  slotPeriod,
  type DoseLogEntry,
  type MedScheduleLike,
  type MedWindow,
} from "../src/adherence.js";

const med = (medId: string, times: string[], extra: Record<string, unknown> = {}) => ({ medId, times, ...extra });
const log = (medId: string, day: string, slot: string | null, status: "taken" | "skipped", extra: Partial<DoseLogEntry> = {}): DoseLogEntry => ({
  medId,
  day,
  slot,
  status,
  ...extra,
});

describe("slot helpers", () => {
  it("minutesOfDay parses HH:MM", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("08:30")).toBe(510);
    expect(minutesOfDay("23:59")).toBe(1439);
  });

  it("slotPeriod buckets into morning / afternoon / night", () => {
    expect(slotPeriod("06:00")).toBe("morning");
    expect(slotPeriod("11:59")).toBe("morning");
    expect(slotPeriod("12:00")).toBe("afternoon");
    expect(slotPeriod("17:59")).toBe("afternoon");
    expect(slotPeriod("18:00")).toBe("night");
    expect(slotPeriod("23:30")).toBe("night");
  });

  it("nearestSlot picks the closest scheduled time; null when the med has no schedule", () => {
    expect(nearestSlot(["08:00", "20:00"], "08:40")).toBe("08:00");
    expect(nearestSlot(["08:00", "20:00"], "15:00")).toBe("20:00"); // 7h vs 5h → 20:00
    expect(nearestSlot([], "09:00")).toBeNull();
  });

  it("isLateDose only flags doses taken AFTER the slot past the grace window", () => {
    expect(isLateDose("08:00", "08:45")).toBe(false); // inside the 60m grace
    expect(isLateDose("08:00", "09:30")).toBe(true);
    expect(isLateDose("08:00", "06:00")).toBe(false); // early is not late
    expect(isLateDose("08:00", "08:20", 15)).toBe(true); // custom grace
  });
});

describe("computeAdherence — a skip is not a miss", () => {
  const days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"];
  const meds = [med("m1", ["08:00", "20:00"])];

  it("counts taken / skipped / missed separately and keeps skips out of adherencePct", () => {
    // 8 scheduled slots. 4 taken, 2 skipped, 2 missed.
    const logs = [
      log("m1", "2026-07-20", "08:00", "taken"),
      log("m1", "2026-07-20", "20:00", "taken"),
      log("m1", "2026-07-21", "08:00", "skipped", { reason: "Doctor said pause" }),
      log("m1", "2026-07-21", "20:00", "taken"),
      log("m1", "2026-07-22", "08:00", "skipped", { reason: "Nausea" }),
      // 2026-07-22 20:00 → missed
      log("m1", "2026-07-23", "08:00", "taken"),
      // 2026-07-23 20:00 → missed
    ];
    const r = computeAdherence({ days, meds, logs });
    expect(r.overall.scheduled).toBe(8);
    expect(r.overall.taken).toBe(4);
    expect(r.overall.skipped).toBe(2);
    expect(r.overall.missed).toBe(2);
    expect(r.overall.pending).toBe(0);
    // adherencePct excludes skips: 4 / (4 + 2) = 66.7%
    expect(r.overall.adherencePct).toBeCloseTo(4 / 6, 10);
    // strictPct counts them against: 4 / (4 + 2 + 2) = 50%
    expect(r.overall.strictPct).toBeCloseTo(0.5, 10);
  });

  it("a day of pure skips scores differently from a day of pure misses", () => {
    const allSkipped = computeAdherence({
      days: ["2026-07-20"],
      meds,
      logs: [log("m1", "2026-07-20", "08:00", "skipped"), log("m1", "2026-07-20", "20:00", "skipped")],
    });
    const allMissed = computeAdherence({ days: ["2026-07-20"], meds, logs: [] });
    expect(allSkipped.overall.adherencePct).toBeNull(); // nothing to hold against you
    expect(allMissed.overall.adherencePct).toBe(0); // a real 0%
    expect(allSkipped.overall.strictPct).toBe(0);
    expect(allMissed.overall.strictPct).toBe(0);
    expect(allSkipped.overall.skipped).toBe(2);
    expect(allSkipped.overall.missed).toBe(0);
    expect(allMissed.overall.missed).toBe(2);
  });

  it("splits per-med and rolls the same numbers up overall", () => {
    const two = [med("m1", ["08:00"]), med("m2", ["09:00"])];
    const logs = [log("m1", "2026-07-20", "08:00", "taken"), log("m2", "2026-07-20", "09:00", "skipped")];
    const r = computeAdherence({ days: ["2026-07-20"], meds: two, logs });
    expect(r.perMed.m1?.taken).toBe(1);
    expect(r.perMed.m1?.adherencePct).toBe(1);
    expect(r.perMed.m2?.skipped).toBe(1);
    expect(r.perMed.m2?.adherencePct).toBeNull();
    expect(r.overall.scheduled).toBe(2);
    expect(r.overall.taken).toBe(1);
    expect(r.overall.skipped).toBe(1);
  });

  it("does not count future slots as missed (asOf)", () => {
    const r = computeAdherence({
      days: ["2026-07-23"],
      meds,
      logs: [log("m1", "2026-07-23", "08:00", "taken")],
      asOf: { day: "2026-07-23", time: "12:00" },
    });
    expect(r.overall.taken).toBe(1);
    expect(r.overall.missed).toBe(0);
    expect(r.overall.pending).toBe(1); // the 20:00 dose hasn't come due
    expect(r.overall.adherencePct).toBe(1);
  });

  it("clamps a med's window to startDay/endDay so a new or paused med is not penalised", () => {
    const r = computeAdherence({
      days,
      meds: [med("m1", ["08:00"], { startDay: "2026-07-22", endDay: "2026-07-23" })],
      logs: [log("m1", "2026-07-22", "08:00", "taken"), log("m1", "2026-07-23", "08:00", "taken")],
    });
    expect(r.overall.scheduled).toBe(2); // NOT 4
    expect(r.overall.adherencePct).toBe(1);
  });

  it("treats unscheduled (PRN / duplicate) takes as extra, never as scheduled adherence", () => {
    const r = computeAdherence({
      days: ["2026-07-20"],
      meds: [med("prn", [])],
      logs: [log("prn", "2026-07-20", null, "taken"), log("prn", "2026-07-20", null, "taken")],
    });
    expect(r.overall.scheduled).toBe(0);
    expect(r.overall.taken).toBe(0);
    expect(r.overall.extraTaken).toBe(2);
    expect(r.overall.adherencePct).toBeNull();
  });

  it("a duplicate log for the same slot fills the slot once and counts the rest as extra", () => {
    const r = computeAdherence({
      days: ["2026-07-20"],
      meds: [med("m1", ["08:00"])],
      logs: [log("m1", "2026-07-20", "08:00", "taken"), log("m1", "2026-07-20", "08:00", "taken")],
    });
    expect(r.overall.taken).toBe(1);
    expect(r.overall.extraTaken).toBe(1);
  });

  it("counts late-taken doses without demoting them below taken", () => {
    const r = computeAdherence({
      days: ["2026-07-20"],
      meds: [med("m1", ["08:00"])],
      logs: [log("m1", "2026-07-20", "08:00", "taken", { late: true })],
    });
    expect(r.overall.taken).toBe(1);
    expect(r.overall.lateTaken).toBe(1);
    expect(r.overall.adherencePct).toBe(1);
  });

  it("emits one perDay row per requested day, in order", () => {
    const r = computeAdherence({ days, meds, logs: [] });
    expect(r.perDay.map((d) => d.day)).toEqual(days);
    expect(r.perDay[0]?.missed).toBe(2);
  });
});

describe("adherence streak", () => {
  const meds = [med("m1", ["08:00"])];
  const days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"];

  it("counts consecutive trailing days with no missed dose", () => {
    const logs = days.map((d) => log("m1", d, "08:00", "taken"));
    expect(computeAdherence({ days, meds, logs }).streakDays).toBe(4);
  });

  it("a missed dose breaks the streak; a skipped one does not", () => {
    const missed = computeAdherence({
      days,
      meds,
      logs: [log("m1", "2026-07-20", "08:00", "taken"), log("m1", "2026-07-22", "08:00", "taken"), log("m1", "2026-07-23", "08:00", "taken")],
    });
    expect(missed.streakDays).toBe(2); // 07-21 missed → streak restarts

    const skipped = computeAdherence({
      days,
      meds,
      logs: [
        log("m1", "2026-07-20", "08:00", "taken"),
        log("m1", "2026-07-21", "08:00", "skipped", { reason: "Sick day" }),
        log("m1", "2026-07-22", "08:00", "taken"),
        log("m1", "2026-07-23", "08:00", "taken"),
      ],
    });
    expect(skipped.streakDays).toBe(3); // the skip day doesn't count, but doesn't break the run
  });

  it("a today with pending doses and no misses still counts", () => {
    const r = computeAdherence({
      days: ["2026-07-22", "2026-07-23"],
      meds: [med("m1", ["08:00", "20:00"])],
      logs: [
        log("m1", "2026-07-22", "08:00", "taken"),
        log("m1", "2026-07-22", "20:00", "taken"),
        log("m1", "2026-07-23", "08:00", "taken"),
      ],
      asOf: { day: "2026-07-23", time: "10:00" },
    });
    expect(r.streakDays).toBe(2);
  });
});

// ── The day axis: which DAYS a med is due on ────────────────────────────────────────────────
// 2026-03-02 is a Monday, so this block's day keys run Mon(02) Tue(03) Wed(04) Thu(05) Fri(06)
// Sat(07) Sun(08) — the same anchor meds.test.ts uses.
const MONDAY = "2026-03-02";
const daysFrom = (start: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${start}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

describe("isScheduledOn", () => {
  it("treats an ABSENT schedule as daily-every-day-forever — the zero-migration invariant", () => {
    for (const day of daysFrom(MONDAY, 14)) expect(isScheduledOn(undefined, day)).toBe(true);
    expect(isScheduledOn(undefined, "1999-01-01")).toBe(true);
    expect(isScheduledOn(undefined, "2099-12-31")).toBe(true);
  });

  it("daily covers every day inside its course dates and nothing outside them", () => {
    const s: MedScheduleLike = { freq: "daily", startDay: "2026-03-04", endDay: "2026-03-06" };
    expect(daysFrom(MONDAY, 7).filter((d) => isScheduledOn(s, d))).toEqual(["2026-03-04", "2026-03-05", "2026-03-06"]);
  });

  it("weekly covers only its byWeekday days (0=Sun..6=Sat, the RecurrenceRule convention)", () => {
    expect(daysFrom(MONDAY, 7).filter((d) => isScheduledOn({ freq: "weekly", byWeekday: [1] }, d))).toEqual([MONDAY]);
    // 0=Sunday, 6=Saturday — the weekend, not Mon/Tue
    expect(daysFrom(MONDAY, 7).filter((d) => isScheduledOn({ freq: "weekly", byWeekday: [0, 6] }, d))).toEqual([
      "2026-03-07",
      "2026-03-08",
    ]);
    expect(daysFrom(MONDAY, 7).filter((d) => isScheduledOn({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5] }, d))).toEqual(
      daysFrom(MONDAY, 5),
    );
  });

  it("interval counts every Nth day FROM startDay, and never before it", () => {
    const s: MedScheduleLike = { freq: "interval", interval: 2, startDay: "2026-03-04" };
    expect(daysFrom(MONDAY, 8).filter((d) => isScheduledOn(s, d))).toEqual(["2026-03-04", "2026-03-06", "2026-03-08"]);
    expect(isScheduledOn({ freq: "interval", interval: 3, startDay: MONDAY }, "2026-03-05")).toBe(true); // +3
    expect(isScheduledOn({ freq: "interval", interval: 1, startDay: MONDAY }, "2026-03-03")).toBe(true); // every day
  });

  it("scheduledTimesOn returns the times on a due day and nothing on an off day", () => {
    const m = { times: ["09:00", "21:00"], schedule: { freq: "weekly", byWeekday: [1] } as MedScheduleLike };
    expect(scheduledTimesOn(m, MONDAY)).toEqual(["09:00", "21:00"]);
    expect(scheduledTimesOn(m, "2026-03-03")).toEqual([]);
    expect(scheduledTimesOn({ times: ["09:00"] }, "2026-03-03")).toEqual(["09:00"]);
  });
});

describe("computeAdherence — non-daily schedules", () => {
  it("NO REGRESSION: an absent schedule computes exactly what it did before schedules existed", () => {
    const days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"];
    const logs = [
      log("m1", "2026-07-20", "08:00", "taken"),
      log("m1", "2026-07-20", "20:00", "taken"),
      log("m1", "2026-07-21", "08:00", "skipped", { reason: "Doctor said pause" }),
      log("m1", "2026-07-21", "20:00", "taken"),
      log("m1", "2026-07-22", "08:00", "skipped", { reason: "Nausea" }),
      log("m1", "2026-07-23", "08:00", "taken"),
    ];
    // The pre-existing expected values, asserted again against the schedule-aware code path.
    const bare = computeAdherence({ days, meds: [med("m1", ["08:00", "20:00"])], logs });
    expect(bare.overall.scheduled).toBe(8);
    expect(bare.overall.taken).toBe(4);
    expect(bare.overall.skipped).toBe(2);
    expect(bare.overall.missed).toBe(2);
    expect(bare.overall.pending).toBe(0);
    expect(bare.overall.adherencePct).toBeCloseTo(4 / 6, 10);
    expect(bare.overall.strictPct).toBeCloseTo(0.5, 10);

    // …and an EXPLICIT daily schedule is the same computation, not a second one.
    const daily = computeAdherence({ days, meds: [med("m1", ["08:00", "20:00"], { schedule: { freq: "daily" } })], logs });
    expect(daily).toEqual(bare);
  });

  it("a weekly injection is one scheduled dose a week, not seven", () => {
    const days = daysFrom(MONDAY, 7);
    const meds = [med("inj", ["09:00"], { schedule: { freq: "weekly", byWeekday: [1] } })];
    const r = computeAdherence({ days, meds, logs: [log("inj", MONDAY, "09:00", "taken")] });
    expect(r.overall.scheduled).toBe(1);
    expect(r.overall.taken).toBe(1);
    expect(r.overall.missed).toBe(0);
    expect(r.overall.adherencePct).toBe(1); // NOT 1/7

    // Without the schedule the same logs read as six chronic misses — the bug this fixes.
    const asDaily = computeAdherence({ days, meds: [med("inj", ["09:00"])], logs: [log("inj", MONDAY, "09:00", "taken")] });
    expect(asDaily.overall.missed).toBe(6);
    expect(asDaily.overall.adherencePct).toBeCloseTo(1 / 7, 10);
  });

  it("misses only the days a weekly med was actually due", () => {
    const days = daysFrom(MONDAY, 14);
    const meds = [med("inj", ["09:00"], { schedule: { freq: "weekly", byWeekday: [1] } })];
    const r = computeAdherence({ days, meds, logs: [log("inj", MONDAY, "09:00", "taken")] });
    expect(r.overall.scheduled).toBe(2); // two Mondays in a fortnight
    expect(r.overall.missed).toBe(1); // the second one
    expect(r.perDay.filter((d) => d.scheduled > 0).map((d) => d.day)).toEqual([MONDAY, "2026-03-09"]);
  });

  it("alternating-day dosing counts every other day", () => {
    const days = daysFrom(MONDAY, 7);
    const meds = [med("alt", ["08:00"], { schedule: { freq: "interval", interval: 2, startDay: MONDAY } })];
    const r = computeAdherence({
      days,
      meds,
      logs: [
        log("alt", "2026-03-02", "08:00", "taken"),
        log("alt", "2026-03-04", "08:00", "taken"),
        log("alt", "2026-03-06", "08:00", "taken"),
        log("alt", "2026-03-08", "08:00", "taken"),
      ],
    });
    expect(r.overall.scheduled).toBe(4); // 03-02 / 04 / 06 / 08
    expect(r.overall.missed).toBe(0);
    expect(r.overall.adherencePct).toBe(1);
  });

  it("a weekday-only regimen ignores the weekend", () => {
    const days = daysFrom(MONDAY, 7);
    const meds = [med("wd", ["08:00"], { schedule: { freq: "weekly", byWeekday: [1, 2, 3, 4, 5] } })];
    const r = computeAdherence({ days, meds, logs: daysFrom(MONDAY, 5).map((d) => log("wd", d, "08:00", "taken")) });
    expect(r.overall.scheduled).toBe(5);
    expect(r.overall.taken).toBe(5);
    expect(r.overall.missed).toBe(0);
    // Saturday and Sunday resolve to nothing at all — not a miss, not a pending row.
    const weekend = r.perDay.filter((d) => d.day >= "2026-03-07");
    expect(weekend.map((d) => d.scheduled)).toEqual([0, 0]);
    expect(weekend.map((d) => d.missed)).toEqual([0, 0]);
  });

  it("a finite course: days outside [startDay, endDay] are neither scheduled nor missed", () => {
    const days = daysFrom("2026-02-27", 16); // 02-27 … 03-14
    const course = { freq: "daily" as const, startDay: MONDAY, endDay: "2026-03-11" }; // a 10-day antibiotic
    const meds = [med("abx", ["08:00", "20:00"], { schedule: course })];
    const taken = daysFrom(MONDAY, 10).flatMap((d) => [log("abx", d, "08:00", "taken"), log("abx", d, "20:00", "taken")]);
    const r = computeAdherence({ days, meds, logs: taken });
    expect(r.overall.scheduled).toBe(20); // 10 days × 2 times, not 16 × 2
    expect(r.overall.taken).toBe(20);
    expect(r.overall.missed).toBe(0);
    expect(r.overall.adherencePct).toBe(1);
    // The three days before it started and the three after it finished stay silent.
    expect(r.perDay.filter((d) => d.scheduled > 0).map((d) => d.day)).toEqual(daysFrom(MONDAY, 10));
    expect(r.perDay.filter((d) => d.missed > 0)).toEqual([]);
  });

  it("a 21-on / 7-off cycle charges only the on-block", () => {
    const days = daysFrom(MONDAY, 28);
    const onBlock = { freq: "daily" as const, startDay: MONDAY, endDay: "2026-03-22" }; // 21 days inclusive
    const meds = [med("cyc", ["08:00"], { schedule: onBlock })];
    const r = computeAdherence({ days, meds, logs: daysFrom(MONDAY, 21).map((d) => log("cyc", d, "08:00", "taken")) });
    expect(r.overall.scheduled).toBe(21);
    expect(r.overall.taken).toBe(21);
    expect(r.overall.missed).toBe(0);
    expect(r.perDay.slice(21).every((d) => d.scheduled === 0 && d.missed === 0)).toBe(true);
  });

  it("an off day neither builds nor breaks the streak", () => {
    const days = daysFrom(MONDAY, 21);
    const meds = [med("inj", ["09:00"], { schedule: { freq: "weekly", byWeekday: [1] } })];
    const r = computeAdherence({
      days,
      meds,
      logs: ["2026-03-02", "2026-03-09", "2026-03-16"].map((d) => log("inj", d, "09:00", "taken")),
    });
    expect(r.streakDays).toBe(3); // three Mondays taken; the 18 off days pass through
  });

  it("a dose taken on an off day is extra, never scheduled adherence", () => {
    const days = daysFrom(MONDAY, 7);
    const meds = [med("inj", ["09:00"], { schedule: { freq: "weekly", byWeekday: [1] } })];
    const r = computeAdherence({
      days,
      meds,
      logs: [log("inj", MONDAY, "09:00", "taken"), log("inj", "2026-03-05", "09:00", "taken")],
    });
    expect(r.overall.scheduled).toBe(1);
    expect(r.overall.taken).toBe(1);
    expect(r.overall.extraTaken).toBe(1);
  });

  it("the med's own lifetime window still clamps on top of the schedule", () => {
    const days = daysFrom(MONDAY, 14);
    // Weekly Mondays, but the med was only added on the 9th — the first Monday predates it.
    const meds = [med("inj", ["09:00"], { schedule: { freq: "weekly", byWeekday: [1] }, startDay: "2026-03-09" })];
    const r = computeAdherence({ days, meds, logs: [log("inj", "2026-03-09", "09:00", "taken")] });
    expect(r.overall.scheduled).toBe(1);
    expect(r.overall.adherencePct).toBe(1);
  });
});

describe("buildDayChecklist", () => {
  const meds = [
    { medId: "m1", name: "Vitamin D", dosage: "1000 IU", times: ["08:00", "13:00", "21:00"] },
    { medId: "prn", name: "Ibuprofen", times: [] },
  ];

  it("groups a med's times[] into morning / afternoon / night, in order", () => {
    const groups = buildDayChecklist({ day: "2026-07-23", meds, logs: [] });
    expect(groups.map((g) => g.period)).toEqual(["morning", "afternoon", "night", "anytime"]);
    expect(groups[0]?.items.map((i) => i.slot)).toEqual(["08:00"]);
    expect(groups[1]?.items.map((i) => i.slot)).toEqual(["13:00"]);
    expect(groups[2]?.items.map((i) => i.slot)).toEqual(["21:00"]);
    expect(groups[3]?.items[0]?.medId).toBe("prn"); // as-needed lands in "anytime"
  });

  it("reflects taken / skipped / missed / pending per slot and carries the log id back", () => {
    const groups = buildDayChecklist({
      day: "2026-07-23",
      meds,
      logs: [
        log("m1", "2026-07-23", "08:00", "taken", { id: "L1", late: true }),
        log("m1", "2026-07-23", "13:00", "skipped", { id: "L2", reason: "Out of stock" }),
      ],
      asOf: { day: "2026-07-23", time: "19:00" },
    });
    const bySlot = new Map(groups.flatMap((g) => g.items).map((i) => [`${i.medId}@${i.slot}`, i]));
    expect(bySlot.get("m1@08:00")).toMatchObject({ status: "taken", late: true, logId: "L1" });
    expect(bySlot.get("m1@13:00")).toMatchObject({ status: "skipped", reason: "Out of stock", logId: "L2" });
    expect(bySlot.get("m1@21:00")?.status).toBe("pending"); // 21:00 not due yet at 19:00
  });

  it("marks an overdue unlogged slot as missed once its time has passed", () => {
    const groups = buildDayChecklist({ day: "2026-07-23", meds, logs: [], asOf: { day: "2026-07-23", time: "23:59" } });
    const statuses = groups.flatMap((g) => g.items).filter((i) => i.medId === "m1").map((i) => i.status);
    expect(statuses).toEqual(["missed", "missed", "missed"]);
  });

  it("omits a med entirely on a day its schedule does not cover", () => {
    const weekly = [{ medId: "inj", name: "Methotrexate", times: ["09:00"], schedule: { freq: "weekly" as const, byWeekday: [1] } }];
    const onDay = buildDayChecklist({ day: MONDAY, meds: weekly, logs: [], asOf: { day: MONDAY, time: "23:59" } });
    expect(onDay.flatMap((g) => g.items).map((i) => i.status)).toEqual(["missed"]);

    const offDay = buildDayChecklist({ day: "2026-03-03", meds: weekly, logs: [], asOf: { day: "2026-03-03", time: "23:59" } });
    expect(offDay).toEqual([]); // a Tuesday shows no standing miss for a Monday-only injection
  });

  it("shows a dose taken on an off day under anytime rather than inventing a slot", () => {
    const weekly = [{ medId: "inj", name: "Methotrexate", times: ["09:00"], schedule: { freq: "weekly" as const, byWeekday: [1] } }];
    const groups = buildDayChecklist({
      day: "2026-03-03",
      meds: weekly,
      logs: [log("inj", "2026-03-03", "09:00", "taken", { id: "L7" })],
    });
    expect(groups.map((g) => g.period)).toEqual(["anytime"]);
    expect(groups[0]?.items).toEqual([
      { medId: "inj", name: "Methotrexate", slot: null, period: "anytime", status: "taken", logId: "L7" },
    ]);
  });

  it("lists each as-needed take plus a trailing pending row to take another", () => {
    const groups = buildDayChecklist({
      day: "2026-07-23",
      meds,
      logs: [log("prn", "2026-07-23", null, "taken", { id: "L9" })],
    });
    const anytime = groups.find((g) => g.period === "anytime")!;
    expect(anytime.items.map((i) => i.status)).toEqual(["taken", "pending"]);
    expect(anytime.items[0]?.logId).toBe("L9");
  });
});

// ── The schedule is EFFECTIVE-DATED, and a pause survives the resume ──────────────────────────
// A medication doc holds ONE schedule and an edit replaces it wholesale, so judging the whole
// window by the CURRENT schedule re-reads every past day under a rule that did not exist then.
// Both directions rewrite a medical record on a single save, and neither says so on screen.
describe("scheduleForDay / isPausedOn", () => {
  const week = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"];
  const daily = (medId: string, extra: Partial<MedWindow> = {}): MedWindow => ({ medId, times: ["09:00"], ...extra });
  const takenEveryDay = (medId: string): DoseLogEntry[] =>
    week.map((day) => ({ medId, day, slot: "09:00", status: "taken" as const }));

  it("hands each day the version in force ON IT, and falls back to the first one before that", () => {
    const m = {
      schedule: { freq: "interval" as const, interval: 2, startDay: "2026-03-06" },
      scheduleHistory: [
        { from: "2026-03-02" },
        { from: "2026-03-06", schedule: { freq: "interval" as const, interval: 2, startDay: "2026-03-06" } },
      ],
    };
    expect(scheduleForDay(m, "2026-02-01")).toBeUndefined(); // before the first version → version 0
    expect(scheduleForDay(m, "2026-03-05")).toBeUndefined(); // still the daily-every-day default
    expect(scheduleForDay(m, "2026-03-06")?.interval).toBe(2); // the day the change took effect
    expect(scheduleForDay(m, "2026-03-31")?.interval).toBe(2);
    // With no history at all the CURRENT schedule governs — the pre-history behaviour, unchanged.
    expect(scheduleForDay({ schedule: { freq: "weekly", byWeekday: [1] } }, "2026-03-05")?.byWeekday).toEqual([1]);
  });

  it("moving a daily med to every-other-day leaves the earlier days' counts untouched", () => {
    const logs = takenEveryDay("m");
    const before = computeAdherence({ days: week, meds: [daily("m")], logs });
    expect(before.overall).toMatchObject({ scheduled: 7, taken: 7, extraTaken: 0, adherencePct: 1 });

    const after = computeAdherence({
      days: week,
      meds: [
        daily("m", {
          schedule: { freq: "interval", interval: 2, startDay: "2026-03-08" },
          scheduleHistory: [{ from: "2026-03-02" }, { from: "2026-03-08", schedule: { freq: "interval", interval: 2, startDay: "2026-03-08" } }],
        }),
      ],
      logs,
    });
    // Reading the CURRENT schedule over the window gave {scheduled:1, taken:1, extraTaken:6}:
    // six recorded takes reclassified as unscheduled extras by one save.
    expect(after.overall).toMatchObject({ scheduled: 7, taken: 7, extraTaken: 0, adherencePct: 1 });
  });

  it("moving a weekly injection to daily does not invent six misses out of a perfect record", () => {
    const monday = "2026-03-02";
    const logs: DoseLogEntry[] = [{ medId: "inj", day: monday, slot: "09:00", status: "taken" }];
    const weekly = { freq: "weekly" as const, byWeekday: [1] };
    const after = computeAdherence({
      days: week,
      meds: [
        { medId: "inj", times: ["09:00"], scheduleHistory: [{ from: monday, schedule: weekly }, { from: "2026-03-08" }] },
      ],
      logs,
    });
    // Monday under the weekly rule (taken) + Sunday the 8th under the new daily one (missed).
    expect(after.overall).toMatchObject({ scheduled: 2, taken: 1, missed: 1 });
    // Without effective dating this read {scheduled:7, missed:6} — a 100% record shown as 14%.
  });

  it("a closed pause range schedules nothing, so a resumed med is not re-charged for it", () => {
    const paused = computeAdherence({
      days: week,
      meds: [daily("m", { pausedRanges: [{ from: "2026-03-04", to: "2026-03-06" }] })],
      logs: takenEveryDay("m").filter((l) => l.day < "2026-03-04" || l.day > "2026-03-06"),
    });
    expect(paused.overall).toMatchObject({ scheduled: 4, taken: 4, missed: 0, adherencePct: 1 });
    expect(isPausedOn({ pausedRanges: [{ from: "2026-03-04", to: "2026-03-06" }] }, "2026-03-05")).toBe(true);
    expect(isPausedOn({ pausedRanges: [{ from: "2026-03-04", to: "2026-03-06" }] }, "2026-03-07")).toBe(false);
    expect(isPausedOn({}, "2026-03-05")).toBe(false);
  });
});
