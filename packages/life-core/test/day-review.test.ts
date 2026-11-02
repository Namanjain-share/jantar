// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Noblot's resolvePick cases (dayPlan.test.ts), and (ours) Jantar's six outcomes and the counts line.
import { describe, expect, it } from 'vitest';
import { countsLine, resolvePick, reviewCounts, reviewOutcome, type DayPlanPick } from '../src/day-review.js';

const TZ = 'Asia/Kolkata';
const pick: DayPlanPick = { kind: 'task', id: 't1', title: 'Ship the deck' };

describe('resolvePick (Noblot)', () => {
  const dayKey = '2026-07-06';
  const noon = new Date('2026-07-06T06:30:00.000Z'); // 12:00 IST

  it('done wins over everything', () => {
    expect(resolvePick(pick, { done: true, at: null }, dayKey, TZ).outcome).toBe('done');
  });

  it('a deleted source is `gone`, not `missed`', () => {
    expect(resolvePick(pick, { missing: true }, dayKey, TZ).outcome).toBe('gone');
  });

  it('still open and still today is `missed`', () => {
    expect(resolvePick(pick, { at: noon }, dayKey, TZ).outcome).toBe('missed');
  });

  it('still open but rescheduled off today is `moved`', () => {
    const tomorrow = new Date('2026-07-07T06:30:00.000Z');
    expect(resolvePick(pick, { at: tomorrow }, dayKey, TZ).outcome).toBe('moved');
  });

  it('an open item with no date at all is `missed` (there is nothing to have moved to)', () => {
    expect(resolvePick(pick, { at: null }, dayKey, TZ).outcome).toBe('missed');
  });

  it("uses the zone's day, not UTC's", () => {
    // 2026-07-05T20:00Z is already 2026-07-06 in IST.
    expect(resolvePick(pick, { at: new Date('2026-07-05T20:00:00.000Z') }, dayKey, TZ).outcome).toBe('missed');
    expect(resolvePick(pick, { at: new Date('2026-07-05T20:00:00.000Z') }, dayKey, 'UTC').outcome).toBe('moved');
  });
});

describe('reviewOutcome: the spec 3.10 table', () => {
  it('gone, done, skipped, excused, moved, missed', () => {
    expect(reviewOutcome({ missing: true, status: 'done' })).toBe('gone');
    expect(reviewOutcome({ status: 'done', movedTo: '2026-11-04' })).toBe('done');
    expect(reviewOutcome({ status: 'skipped' })).toBe('skipped');
    expect(reviewOutcome({ status: 'excused' })).toBe('excused');
    expect(reviewOutcome({ status: 'todo', movedTo: '2026-11-04' })).toBe('moved');
    expect(reviewOutcome({ status: 'doing' })).toBe('missed');
    expect(reviewOutcome({ status: 'todo' })).toBe('missed');
    expect(reviewOutcome({})).toBe('missed');
  });

  it('counts each outcome and names only the non-zero ones, in order', () => {
    const c = reviewCounts(['done', 'done', 'moved', 'missed', 'done', 'done', 'done', undefined]);
    expect(c).toEqual({ done: 5, skipped: 0, excused: 0, moved: 1, missed: 1, gone: 0 });
    expect(countsLine(c)).toBe('5 done · 1 moved · 1 missed');
    expect(countsLine(reviewCounts([]))).toBe('Nothing planned');
  });
});
