// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Noblot's journal streak, day-key and prompt tests (journal.test.ts), with the import path and the pack changed.
import { describe, expect, it } from 'vitest';
import { JOURNAL_PROMPTS, addDaysToKey, dayKeyNumber, journalStreak, nextStreakMilestone, promptForDay, type JournalPromptPack } from '../src/journal-streak.js';

describe('prompts', () => {
  it('picks the SAME prompt for a given day, and another the next day', () => {
    expect(promptForDay(JOURNAL_PROMPTS, '2026-07-25')).toBe(promptForDay(JOURNAL_PROMPTS, '2026-07-25'));
    expect(promptForDay(JOURNAL_PROMPTS, '2026-07-26')).not.toBe(promptForDay(JOURNAL_PROMPTS, '2026-07-25'));
  });

  it('rotates a WEEKLY pack once per 7 days, not once per day', () => {
    const pack: JournalPromptPack = { id: 'w', cadence: 'weekly', prompts: ['a', 'b', 'c'] };
    const a = promptForDay(pack, '2026-07-20');
    expect(promptForDay(pack, '2026-07-24')).toBe(a);
    expect(promptForDay(pack, '2026-07-27')).not.toBe(a);
  });

  it('falls back to the first prompt for a malformed day key rather than throwing', () => {
    expect(promptForDay(JOURNAL_PROMPTS, 'not-a-day')).toBe(JOURNAL_PROMPTS.prompts[0]);
    expect(dayKeyNumber('not-a-day')).toBeNaN();
  });
});

describe('day-key math', () => {
  it('round-trips a day key through its epoch-day number and steps across a month/leap boundary', () => {
    expect(addDaysToKey('2026-07-25', 0)).toBe('2026-07-25');
    expect(addDaysToKey('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDaysToKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysToKey('2024-02-28', 1)).toBe('2024-02-29');
  });
});

describe('journalStreak', () => {
  it('counts a run ending today, and reports the longest run + total distinct days', () => {
    const s = journalStreak(['2026-07-25', '2026-07-24', '2026-07-23', '2026-07-19', '2026-07-18'], '2026-07-25');
    expect(s).toEqual({ current: 3, longest: 3, lastDay: '2026-07-25', total: 5, writtenToday: true, graceUsed: 0, milestone: null });
  });

  it('keeps a streak ALIVE on a day not yet written (grace), flagged writtenToday:false', () => {
    const s = journalStreak(['2026-07-24', '2026-07-23'], '2026-07-25');
    expect(s.current).toBe(2);
    expect(s.writtenToday).toBe(false);
  });

  it('breaks the streak once the gap is two days', () => {
    expect(journalStreak(['2026-07-23', '2026-07-22'], '2026-07-25').current).toBe(0);
  });

  it('dedupes several entries on one day', () => {
    const s = journalStreak(['2026-07-25', '2026-07-25', '2026-07-25'], '2026-07-25');
    expect(s).toEqual({ current: 1, longest: 1, lastDay: '2026-07-25', total: 1, writtenToday: true, graceUsed: 0, milestone: null });
  });

  it('is empty-safe', () => {
    expect(journalStreak([], '2026-07-25')).toEqual({ current: 0, longest: 0, lastDay: null, total: 0, writtenToday: false, graceUsed: 0, milestone: null });
  });

  it('fires a milestone ONLY on the day it is earned', () => {
    const week = Array.from({ length: 7 }, (_, i) => `2026-07-${19 + i}`);
    expect(journalStreak(week, '2026-07-25').milestone).toBe(7);
    expect(journalStreak(week, '2026-07-26').milestone).toBeNull();
    expect(journalStreak(week.slice(0, 6), '2026-07-24').milestone).toBeNull();
  });

  it('nextStreakMilestone counts down, then runs out', () => {
    expect(nextStreakMilestone(3)).toEqual({ target: 7, away: 4 });
    expect(nextStreakMilestone(7)).toEqual({ target: 30, away: 23 });
    expect(nextStreakMilestone(5000)).toBeNull();
  });
});

describe('journalStreak with a grace day', () => {
  it('forgives one missed day inside the run without counting it as journaled', () => {
    const days = ['2026-07-25', '2026-07-24', '2026-07-22', '2026-07-21'];
    expect(journalStreak(days, '2026-07-25').current).toBe(2);
    const graced = journalStreak(days, '2026-07-25', { graceDays: 1 });
    expect(graced.current).toBe(4);
    expect(graced.graceUsed).toBe(1);
    expect(graced.longest).toBe(4);
  });

  it('still breaks once the gap exceeds the grace', () => {
    const days = ['2026-07-25', '2026-07-21'];
    expect(journalStreak(days, '2026-07-25', { graceDays: 1 }).current).toBe(1);
    expect(journalStreak(days, '2026-07-25', { graceDays: 3 }).current).toBe(2);
  });

  it('extends the same forgiveness to the LIVE end of the streak', () => {
    const days = ['2026-07-23', '2026-07-22'];
    expect(journalStreak(days, '2026-07-25').current).toBe(0);
    const graced = journalStreak(days, '2026-07-25', { graceDays: 1 });
    expect(graced.current).toBe(2);
    expect(graced.graceUsed).toBe(1);
    expect(graced.writtenToday).toBe(false);
  });
});
