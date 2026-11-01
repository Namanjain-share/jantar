/**
 * Todos, reminders and projects on the phone (v0.4 spec 4.4, 5.3): which
 * rail a todo sits under, when it is overdue, what its meta line says, the
 * Reminders order, the next full hour for a new reminder, and which
 * project a session's folder belongs to. Pure functions over day keys and
 * HH:MM on the Life clock (the daemon's own day and zone).
 */
import type { ProjectView, Session, Todo } from '@jantar/protocol';
import { dayLabel, shiftDayKey } from '../shared/DayNav.js';
import type { LifeClock } from '../today/parts.js';
import { inFolder } from './useProjects.js';

export { inFolder, projectFor } from './useProjects.js';

/** Whole days from `a` to `b` (day keys). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Not done, and due before today, or due today at a time already past (spec 4.4). */
export function isOverdue(todo: Todo, now: LifeClock): boolean {
  if (todo.doneAt || !todo.due) return false;
  if (todo.due.day < now.day) return true;
  return todo.due.day === now.day && todo.due.time !== undefined && todo.due.time < now.hhmm;
}

/** "overdue 3d", or "overdue" for earlier today. */
export function overdueText(todo: Todo, now: LifeClock): string {
  const d = todo.due ? daysBetween(todo.due.day, now.day) : 0;
  return d >= 1 ? `overdue ${d}d` : 'overdue';
}

/** "Today", "Tomorrow", else "Fri 31 Oct". */
export function dueDay(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === shiftDayKey(today, 1)) return 'Tomorrow';
  return dayLabel(day);
}

export type TodoRail = 'overdue' | 'today' | 'upcoming' | 'none';

export const RAIL_LABEL: Record<TodoRail, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  none: 'No date',
};

export const RAIL_ORDER: readonly TodoRail[] = ['overdue', 'today', 'upcoming', 'none'];

export function railOf(todo: Todo, now: LifeClock): TodoRail {
  if (!todo.due) return 'none';
  if (isOverdue(todo, now)) return 'overdue';
  return todo.due.day === now.day ? 'today' : 'upcoming';
}

/** The open todos under their rails, each in the daemon's order (due, then created). */
export function byRail(todos: readonly Todo[], now: LifeClock): Record<TodoRail, Todo[]> {
  const out: Record<TodoRail, Todo[]> = { overdue: [], today: [], upcoming: [], none: [] };
  for (const t of todos) if (!t.doneAt) out[railOf(t, now)].push(t);
  return out;
}

/** The Reminders view: open todos that have a time, by when they ring. */
export function remindersOf(todos: readonly Todo[]): Todo[] {
  const ring = (t: Todo) => `${t.due?.day ?? ''} ${t.due?.time ?? ''}`;
  return todos.filter((t) => !t.doneAt && t.due?.time !== undefined).sort((a, b) => ring(a).localeCompare(ring(b)) || a.createdAt.localeCompare(b.createdAt));
}

/** A new reminder's time: the next full hour on the Life clock (00:00 tomorrow after 23:00). */
export function nextFullHour(now: LifeClock): { day: string; time: string } {
  const h = Number(now.hhmm.slice(0, 2)) + 1;
  if (h >= 24) return { day: shiftDayKey(now.day, 1), time: '00:00' };
  return { day: now.day, time: `${String(h).padStart(2, '0')}:00` };
}

/** The Mac's live sessions (not ended) whose folder is inside `folder`. A paired server's (v0.6) never is: Life is the Mac's. */
export function liveIn(sessions: readonly Session[], folder: string | undefined): Session[] {
  if (!folder) return [];
  return sessions.filter((s) => s.node === undefined && s.status !== 'ended' && inFolder(s.cwd, folder));
}

/** The distinct folders of the Mac's sessions the phone knows (no paired server's), for a project's Folder picker. */
export function sessionFolders(sessions: readonly Session[]): string[] {
  return [...new Set(sessions.filter((s) => s.node === undefined).map((s) => s.cwd).filter((c) => c.startsWith('/')))].sort();
}

/** A project's name with its emoji, as rows and chips show it. */
export function projectLabel(p: Pick<ProjectView, 'name' | 'emoji'>): string {
  return p.emoji ? `${p.emoji} ${p.name}` : p.name;
}

/** Its due day is past and it is not done (spec 5.3: the one ember on a project row). */
export function projectOverdue(p: Pick<ProjectView, 'due' | 'status'>, today: string): boolean {
  return p.status !== 'done' && p.due !== undefined && p.due < today;
}
