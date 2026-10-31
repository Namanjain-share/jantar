/**
 * Timed todos ring (spec 4.4): a todo with a due time is a reminder. One
 * `todo` row per open timed todo, at `instantAt(due.day, due.time, tz)`.
 *
 * - A todo rings once per due time. Done, Snooze or a new due time sets the
 *   next one; a repeating todo that is not done stays overdue and rings no
 *   more (the no-nag rule).
 * - A row already set for the todo's time is left alone by every write and
 *   by resync, even once that time has passed: it is due and not yet sent
 *   (a muted reminder waiting out the mute, a failed send the next sweep
 *   retries, the catch-up the start sweep is sending). A row that rang is
 *   parked (no next_at), so it is cleared and never rings twice.
 * - A due time this write gave the todo (create, a new due, Snooze) rings
 *   when it is ahead, or behind by no more than the scheduler's on-time
 *   window (a reminder for 10:00 made at 10:00:20). Any other past time
 *   never rings: an edit or an Undo after the time sends nothing.
 * - Snooze 1h inside the hour the clocks repeat (going back) names a wall
 *   time whose first pass is now; it rings at the later pass, an hour on.
 * - check: deleted, done or untimed: cancel; its due time moved since the
 *   row was set: skip (the row follows the todo, see `next`).
 * - The push: "Todo due", the body by `notify.bodies` (full: the title and
 *   the time; short: the title's first 40 characters; generic: "Tap to
 *   open"), "Missed at HH:MM · " first on a catch-up. Tap: /todos?id=<id>.
 */
import type { Todo } from '@jantar/protocol';
import { dayKeyOf, hhmmOf, instantAt } from '@jantar/life-core';
import type { LifeCore, LifeModuleDeps, LifePush, PingHandler } from '../../contracts.js';
import { clip, oneLine } from '../../notify/format.js';
import { LATE_AFTER_MS } from '../pings.js';
import type { TodosRepo } from './repo.js';

/** A short body's title length (spec 4.3). */
export const SHORT_TITLE = 40;
export const TODO_PUSH_TITLE = 'Todo due';

/** When `t` rings, or null when it does not (done, no time). A wall time the zone repeats is its first pass. */
export function ringAt(t: Todo, tz: string): Date | null {
  if (t.doneAt || !t.due?.time) return null;
  return instantAt(t.due.day, t.due.time, tz);
}

/** Whether `at` is a ring of `t`: its due instant, or another showing its due day and time (the later pass of a repeated hour). */
export function ringsAt(t: Todo, at: Date, tz: string): boolean {
  const first = ringAt(t, tz);
  if (!first || !t.due?.time) return false;
  return first.getTime() === at.getTime() || (dayKeyOf(at, tz) === t.due.day && hhmmOf(at, tz) === t.due.time);
}

export interface ArmOptions {
  /** This write gave the todo its due time (see the file comment). */
  fresh?: boolean;
  /** The instant meant when the wall time alone is ambiguous (Snooze 1h in a repeated hour). */
  at?: Date | undefined;
}

/**
 * Sets or clears `t`'s scheduler row by the rules in the file comment.
 * `armed` is the row's next_at as stored (null: no row, or parked). The
 * caller pokes.
 */
export function armTodo(core: Pick<LifeCore, 'scheduler' | 'tz' | 'now'>, t: Todo, armed: string | null, opts: ArmOptions = {}): void {
  const tz = core.tz();
  const first = ringAt(t, tz);
  if (!first) {
    core.scheduler.clear('todo', t.id);
    return;
  }
  const at = opts.at ?? first;
  if (armed !== null && (opts.at ? armed === at.toISOString() : ringsAt(t, new Date(armed), tz))) return;
  const now = core.now().getTime();
  if (at.getTime() > now || (opts.fresh && at.getTime() > now - LATE_AFTER_MS)) core.scheduler.set('todo', t.id, '', at);
  else core.scheduler.clear('todo', t.id);
}

export function todoPush(t: Todo | null, id: string, dueAt: Date, late: boolean, tz: string, bodies: 'full' | 'short' | 'generic'): LifePush {
  const time = hhmmOf(dueAt, tz);
  const title = t ? oneLine(t.title) : '';
  let body: string;
  if (bodies === 'generic' || !title) body = `Tap to open · ${time}`;
  else if (bodies === 'short') body = `${clip(title, SHORT_TITLE)} · ${time}`;
  else body = `${title} · ${time}`;
  if (late) body = `Missed at ${time} · ${body}`;
  return { kind: 'life', title: TODO_PUSH_TITLE, body, url: `/todos?id=${id}`, tag: `life:todo:${id}` };
}

export function todoPingHandler(core: LifeCore, deps: Pick<LifeModuleDeps, 'ctx'>, repo: TodosRepo): PingHandler {
  return {
    kind: 'todo',
    check(row, dueAt) {
      const t = repo.todo(row.ref);
      if (!t || !ringAt(t, core.tz())) return 'cancel';
      return ringsAt(t, dueAt, core.tz()) ? 'send' : 'skip';
    },
    push(rows, dueAt, late) {
      const id = rows[0]?.ref ?? '';
      return todoPush(repo.todo(id), id, dueAt, late, core.tz(), deps.ctx.settings.get().notify.bodies);
    },
    next(row, after) {
      const t = repo.todo(row.ref);
      const at = t ? ringAt(t, core.tz()) : null;
      return at && at.getTime() > after.getTime() ? at : null;
    },
    resync() {
      const armed = repo.pingTimes();
      const ringing = new Set<string>();
      for (const t of repo.openTimed()) {
        armTodo(core, t, armed.get(t.id) ?? null);
        ringing.add(t.id);
      }
      for (const ref of armed.keys()) if (!ringing.has(ref)) core.scheduler.clear('todo', ref);
    },
  };
}
