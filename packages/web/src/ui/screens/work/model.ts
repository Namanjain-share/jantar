/**
 * 0.13.0 Work, pure helpers for its screens: a project's next todo and its
 * group on the list, the hub's health and log lines, a milestone ticked
 * done (the list that sends), where a project's folder sits under the
 * Mac's roots (for "New session here" and "Open folder in Files"), and the
 * names the seed sheet suggests for folders.
 * Day keys and times are the Life clock's (the daemon's own zone).
 */
import type { FileRoot, ProjectStatus, ProjectView, Session, Todo } from '@jantar/protocol';
import type { ProjectHub, WorkLogRow, WorkMilestone, WorkMilestonesBody } from '@jantar/protocol/work';
import { routePath } from '../../../lib/router.js';
import { dayLabel } from '../life/shared/DayNav.js';
import { clockIn, type LifeClock } from '../life/today/parts.js';
import { isOverdue, shortDue } from '../life/todos/model.js';
import { tildePath } from '../session/order.js';

/** The list's groups, in order (Done collapsed until opened). */
export const STATUS_GROUPS: readonly { status: ProjectStatus; label: string }[] = [
  { status: 'active', label: 'Active' },
  { status: 'paused', label: 'Paused' },
  { status: 'done', label: 'Done' },
];

/** The projects of each status, each in the daemon's order (by name). */
export function byStatus(projects: readonly ProjectView[]): Record<ProjectStatus, ProjectView[]> {
  const out: Record<ProjectStatus, ProjectView[]> = { active: [], paused: [], done: [] };
  for (const p of projects) out[p.status].push(p);
  return out;
}

/**
 * Each project's next open todo: the first with a due day in the todos list's order (by due, then
 * created), as the hub's health line names it.
 */
export function nextByProject(todos: readonly Todo[]): Map<string, Todo> {
  const out = new Map<string, Todo>();
  for (const t of todos) if (t.projectId && t.due && !t.doneAt && !out.has(t.projectId)) out.set(t.projectId, t);
  return out;
}

/** "Thu", "Today 15:00", "Tomorrow", "31 Oct": a due as a line says it, short. */
export function dueWord(due: NonNullable<Todo['due']>, today: string): string {
  const short = shortDue(due.day, today);
  return due.time ? `${short} ${due.time}` : short;
}

/** The project's open todo the health line names (the hub's `nextDue`), from its open list. */
export function nextDueTodo(hub: Pick<ProjectHub, 'open' | 'health'>): Todo | null {
  const id = hub.health.nextDue?.todoId;
  return id ? (hub.open.find((t) => t.id === id) ?? null) : null;
}

/** The health line's parts (W41): "1 overdue", "next: Send wireframes Thu", "5 done this week", "quiet 16 days". */
export function healthParts(hub: Pick<ProjectHub, 'open' | 'health' | 'doneThisWeek'>, now: LifeClock): { key: string; text: string; ember?: boolean }[] {
  const out: { key: string; text: string; ember?: boolean }[] = [];
  if (hub.health.overdue > 0) out.push({ key: 'overdue', text: `${hub.health.overdue} overdue`, ember: true });
  const next = nextDueTodo(hub);
  if (next?.due && !isOverdue(next, now)) out.push({ key: 'next', text: `next: ${next.title} ${dueWord(next.due, now.day)}` });
  if (hub.doneThisWeek > 0) out.push({ key: 'done', text: `${hub.doneThisWeek} done this week` });
  if (hub.health.quietDays !== undefined) out.push({ key: 'quiet', text: `quiet ${hub.health.quietDays} ${hub.health.quietDays === 1 ? 'day' : 'days'}` });
  if (out.length === 0) out.push({ key: 'none', text: hub.open.length ? 'Nothing due' : 'Nothing open' });
  return out;
}

const LOG_KIND: Record<WorkLogRow['kind'], string> = {
  call: 'Call',
  meeting: 'Meeting',
  email: 'Email',
  message: 'Message',
  note: 'Note',
  stage: 'Stage',
  created: 'Added',
  followup: 'Done',
};
const OUTCOME: Record<NonNullable<WorkLogRow['outcome']>, string> = { good: 'Went well', neutral: 'OK', bad: 'Badly', no_answer: 'No answer' };

/**
 * One log row as the hub lists it: "Call · out · 25m · Went well · 2 Nov", its words under it. A stage move
 * names its stages by `stages` (a deal's page knows them), else by their ids.
 */
export function logLine(row: WorkLogRow, tz?: string | null, stages?: ReadonlyMap<string, string>): { line: string; body?: string } {
  const day = dayLabel(clockIn(Date.parse(row.at), tz).day).replace(/^\w+ /, '');
  const parts = [LOG_KIND[row.kind]];
  if (row.kind === 'meeting' && row.meeting) parts.push(row.meeting.name);
  if (row.kind === 'followup' && row.title) parts.push(row.title);
  const stage = (id: string) => stages?.get(id) ?? id;
  if (row.kind === 'stage' && row.stageTo) parts.push(row.stageFrom ? `${stage(row.stageFrom)} → ${stage(row.stageTo)}` : stage(row.stageTo));
  if (row.direction) parts.push(row.direction);
  if (row.minutes) parts.push(`${row.minutes}m`);
  if (row.outcome) parts.push(OUTCOME[row.outcome]);
  parts.push(day);
  return { line: parts.join(' · '), ...(row.body ? { body: row.body } : {}) };
}

/** Where a project's folder sits under the Mac's roots: a configured root's id and the path below it (deepest root wins). */
export function folderUnder(folder: string | undefined, roots: readonly FileRoot[]): { root: string; path: string } | null {
  if (!folder) return null;
  const here = tildePath(folder).replace(/\/+$/, '');
  let best: { root: string; path: string; depth: number } | null = null;
  for (const r of roots) {
    if (r.kind !== 'configured') continue;
    const base = r.display.replace(/\/+$/, '');
    if (here !== base && !here.startsWith(`${base}/`)) continue;
    if (best && best.depth >= base.length) continue;
    best = { root: r.id, path: here.slice(base.length).replace(/^\/+/, ''), depth: base.length };
  }
  return best ? { root: best.root, path: best.path } : null;
}

/**
 * "New session here" (F6): the start form for the project's folder, through the configured roots, else
 * a live session's own root when one runs in exactly that folder (as a Board row's menu does).
 */
export function newSessionHref(folder: string | undefined, roots: readonly FileRoot[], live: readonly Session[]): string | null {
  const at = folderUnder(folder, roots);
  if (at) return routePath({ name: 'new', root: at.root, ...(at.path ? { path: at.path } : {}), start: true });
  const same = live.find((s) => s.cwd.replace(/\/+$/, '') === folder?.replace(/\/+$/, ''));
  return same ? routePath({ name: 'new', root: `s.${same.sid}`, start: true }) : null;
}

/** "Open folder in Files": the folder under a configured root, or null when none holds it. */
export function filesHref(folder: string | undefined, roots: readonly FileRoot[]): string | null {
  const at = folderUnder(folder, roots);
  return at ? routePath({ name: 'files', root: at.root, ...(at.path ? { path: at.path } : {}) }) : null;
}

/** A folder's name as a project's: "globex-labs" is "Globex Labs", "acme_web" "Acme Web" (60 at most). */
export function nameFromFolder(name: string): string {
  const words = name
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  return (words.join(' ') || name).slice(0, 60);
}

/** The folders a project links already, as `~/…` paths (the seed sheet marks them). */
export function linkedFolders(projects: readonly Pick<ProjectView, 'folder'>[]): Set<string> {
  return new Set(projects.flatMap((p) => (p.folder ? [tildePath(p.folder).replace(/\/+$/, '')] : [])));
}

/**
 * A project's milestones as PUT /v1/work/projects/:id/milestones takes them (the whole list, in order, by
 * id), with the one `id` names ticked done or not.
 */
export function milestonesWith(items: readonly WorkMilestone[], id: string, done: boolean): WorkMilestonesBody {
  return {
    milestones: items.map((m) => ({ id: m.id, name: m.name, ...(m.target ? { target: m.target } : {}), ...((m.id === id ? done : m.done) ? { done: true } : {}) })),
  };
}

/** A project's place in Work (`/work?id=`), Projects being Work's first part. */
export function projectPath(id: string): string {
  return routePath({ name: 'work', id });
}
