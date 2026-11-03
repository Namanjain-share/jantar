/**
 * v0.13 Work (ours): a project's health line on Noblot's task review. The
 * overdue count is Life's rule exactly (before today, or today at a time
 * before now, to the minute), the soonest due is the todos list's first,
 * weeks run Monday to Monday in the Life zone, and only an active project
 * goes quiet.
 */
import { describe, expect, it } from 'vitest';
import { PROJECT_HEALTH_WEEKS, projectHealth, projectWeeks } from '../../src/work/project-health.js';

const TZ = 'Asia/Kolkata';
// Tuesday 3 November 2026, 10:00 in Kolkata.
const NOW = new Date('2026-11-03T04:30:00.000Z');
const base = { open: [], doneAt: [], lastChange: null, status: 'active' as const, now: NOW, today: '2026-11-03', nowHhmm: '10:00', tz: TZ };

describe('projectHealth', () => {
  it('counts overdue by Life\'s rule: an earlier day, or today before now to the minute', () => {
    const h = projectHealth({
      ...base,
      open: [
        { id: 'a', due: { day: '2026-11-02' } }, // yesterday, no time: overdue
        { id: 'b', due: { day: '2026-11-03', time: '09:59' } }, // today, a minute ago: overdue
        { id: 'c', due: { day: '2026-11-03', time: '10:00' } }, // today, this minute: not yet
        { id: 'd', due: { day: '2026-11-03' } }, // today, no time: not overdue today
        { id: 'e' }, // no due day
        { id: 'f', due: { day: '2026-11-10', time: '08:00' } },
      ],
    });
    expect(h.overdue).toBe(2);
  });

  it('a day with no time is never overdue on that day, even in its last minute', () => {
    expect(projectHealth({ ...base, nowHhmm: '23:59', open: [{ id: 'a', due: { day: '2026-11-03' } }] }).overdue).toBe(0);
    expect(projectHealth({ ...base, today: '2026-11-04', nowHhmm: '00:00', open: [{ id: 'a', due: { day: '2026-11-03' } }] }).overdue).toBe(1);
  });

  it("the next due is the todos list's first with a due: timed before untimed on the same day, the first of equals", () => {
    const h = projectHealth({
      ...base,
      open: [
        { id: 'timed', due: { day: '2026-11-05', time: '15:00' } },
        { id: 'twin', due: { day: '2026-11-05', time: '15:00' } },
        { id: 'untimed', due: { day: '2026-11-05' } },
        { id: 'later', due: { day: '2026-11-06', time: '08:00' } },
      ],
    });
    expect(h.nextDue).toEqual({ todoId: 'timed', due: { day: '2026-11-05', time: '15:00' } });
    expect(projectHealth({ ...base, open: [{ id: 'u', due: { day: '2026-11-05' } }, { id: 't', due: { day: '2026-11-05', time: '23:59' } }] }).nextDue?.todoId).toBe('t');
    expect(projectHealth({ ...base, open: [{ id: 'x' }] }).nextDue).toBeNull();
  });

  it('done by week: eight Monday-to-Monday weeks in the Life zone, this week last', () => {
    const h = projectHealth({
      ...base,
      doneAt: [
        '2026-11-02T00:00:00.000+05:30', // this Monday at midnight in Kolkata: this week
        '2026-11-01T23:59:00.000+05:30', // the Sunday before: last week
        '2026-11-03T04:00:00.000Z', // today
        '2026-09-14T00:00:00.000+05:30', // the first week's Monday
        '2026-09-13T12:00:00.000+05:30', // before the trend: ignored
        'not a date',
      ],
    });
    expect(h.doneByWeek).toHaveLength(PROJECT_HEALTH_WEEKS);
    expect(h.doneByWeek).toEqual([1, 0, 0, 0, 0, 0, 1, 2]);
  });

  it('quiet: an active project with no change in more than 14 days, in whole days; paused and done never', () => {
    const fifteen = new Date(NOW.getTime() - 15 * 86_400_000 - 60_000).toISOString();
    expect(projectHealth({ ...base, lastChange: fifteen }).quietDays).toBe(15);
    const fourteen = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();
    expect(projectHealth({ ...base, lastChange: fourteen }).quietDays).toBeNull();
    expect(projectHealth({ ...base, lastChange: fifteen, status: 'paused' }).quietDays).toBeNull();
    expect(projectHealth({ ...base, lastChange: fifteen, status: 'done' }).quietDays).toBeNull();
    expect(projectHealth({ ...base, lastChange: null }).quietDays).toBeNull();
  });
});

describe('projectWeeks', () => {
  it('starts each week on Monday at midnight in the zone, back to back', () => {
    const weeks = projectWeeks('2026-11-03', TZ, 2);
    expect(weeks.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      ['2026-10-25T18:30:00.000Z', '2026-11-01T18:30:00.000Z'],
      ['2026-11-01T18:30:00.000Z', '2026-11-08T18:30:00.000Z'],
    ]);
  });

  it('a week across a clock change is still Monday to Monday on the wall clock', () => {
    // Sunday 1 November 2026: New York falls back an hour.
    const [w] = projectWeeks('2026-10-28', 'America/New_York', 1);
    expect(w?.start.toISOString()).toBe('2026-10-26T04:00:00.000Z');
    expect(w?.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });
});
