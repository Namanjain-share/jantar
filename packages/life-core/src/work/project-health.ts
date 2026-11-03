/**
 * v0.13 Work: a project's health line (the project hub), on Noblot's task
 * review (`task-review.ts`): its overdue count and soonest-due todo, how
 * many todos were done each week, and whether it has gone quiet.
 *
 * Jantar's todos are due on a day key in the Life zone, at a time or not,
 * and overdue by Life's rule: before today, or today at a time before now
 * (the Todos module's `isOverdue`, and each project row's count).
 * `openTaskHealth` compares instants, so each due becomes its wall-clock
 * moment read as UTC (a day with no time at its last millisecond, after
 * every timed todo that day) and the cut-off is the current minute read the
 * same way. The comparison is then exactly Life's rule, whatever the zone's
 * clock changes do, and the soonest is the one the todos list shows first.
 *
 * Weeks run Monday to Monday in the Life zone, oldest first, this week last.
 */
import { mondayOf } from '../sleep-week.js';
import { instantAt, shiftDay } from '../tz.js';
import { doneCountsByWeek, isStale, openTaskHealth, type WeekWindow } from './task-review.js';

/** Weeks in the done trend. */
export const PROJECT_HEALTH_WEEKS = 8;
/** An active project with no change in more than this many days is quiet (Noblot's PROJECT_STALE_DAYS). */
export const PROJECT_QUIET_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A todo's due as Life keeps it. */
export interface HealthDue {
  day: string;
  time?: string;
}

/** An open todo, in the todos list's order (by due). */
export interface HealthTodo {
  id: string;
  due?: HealthDue;
}

export interface ProjectHealthInput {
  /** The project's open todos, in the todos list's order (by due). */
  open: readonly HealthTodo[];
  /** When each of its done todos was done (ISO instants); ones before the trend's first week are ignored. */
  doneAt: readonly string[];
  /** The newest change to the project or any of its todos (ISO), or null. */
  lastChange: string | null;
  status: 'active' | 'paused' | 'done';
  now: Date;
  /** Today's day key and the time now (HH:MM), in the Life zone. */
  today: string;
  nowHhmm: string;
  tz: string;
  /** Default PROJECT_HEALTH_WEEKS. */
  weeks?: number;
  /** Default PROJECT_QUIET_DAYS. */
  quietAfterDays?: number;
}

export interface ProjectHealthResult {
  overdue: number;
  /** The soonest-due open todo, overdue or not; null when none has a due day. */
  nextDue: { todoId: string; due: HealthDue } | null;
  /** Whole days since the last change, for an active project quiet past `quietAfterDays`; else null. */
  quietDays: number | null;
  /** Done todos per week, oldest first, this week last. */
  doneByWeek: number[];
}

/** A day key and HH:MM as a wall-clock moment read as UTC (never through a zone). */
function wallClock(day: string, hhmm: string, endOfMinute = false): Date {
  const d = DAY_KEY.exec(day);
  const t = HH_MM.exec(hhmm);
  if (!d || !t) throw new RangeError(`not a day and time: "${day} ${hhmm}"`);
  const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  return new Date(endOfMinute ? ms + 59_999 : ms);
}

/** A due as the moment it falls due: its time, or the last moment of its day when it has none. */
function dueMoment(due: HealthDue): Date {
  return due.time !== undefined ? wallClock(due.day, due.time) : wallClock(due.day, '23:59', true);
}

/** The last `count` weeks, Monday 00:00 to Monday 00:00 in `tz`, oldest first, the week holding `today` last. */
export function projectWeeks(today: string, tz: string, count = PROJECT_HEALTH_WEEKS): WeekWindow[] {
  const thisMonday = mondayOf(today);
  return Array.from({ length: count }, (_, i) => {
    const monday = shiftDay(thisMonday, -7 * (count - 1 - i));
    return { start: instantAt(monday, '00:00', tz), end: instantAt(shiftDay(monday, 7), '00:00', tz) };
  });
}

/** The health line of one project (see the file comment). */
export function projectHealth(input: ProjectHealthInput): ProjectHealthResult {
  const dated = input.open.flatMap((t) => (t.due ? [{ _id: t.id, title: '', dueAt: dueMoment(t.due), due: t.due }] : []));
  const { overdueCount, nextDueTask } = openTaskHealth(dated, wallClock(input.today, input.nowHhmm));
  const next = nextDueTask ? dated.find((t) => t._id === nextDueTask._id) : undefined;
  const weeks = projectWeeks(input.today, input.tz, input.weeks ?? PROJECT_HEALTH_WEEKS);
  const doneByWeek = doneCountsByWeek(
    input.doneAt.map((at) => new Date(at)).filter((d) => !Number.isNaN(d.getTime())),
    weeks,
  );
  let quietDays: number | null = null;
  const last = input.lastChange === null ? null : new Date(input.lastChange);
  const after = input.quietAfterDays ?? PROJECT_QUIET_DAYS;
  if (input.status === 'active' && last && !Number.isNaN(last.getTime()) && isStale(last, input.now, after)) {
    quietDays = Math.floor((input.now.getTime() - last.getTime()) / DAY_MS);
  }
  return {
    overdue: overdueCount,
    nextDue: next ? { todoId: next._id, due: next.due } : null,
    quietDays,
    doneByWeek,
  };
}
