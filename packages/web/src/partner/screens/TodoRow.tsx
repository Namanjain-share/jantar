/**
 * v0.11 People: one to-do row of hers: a tick circle (at least 44 px), the
 * title, and under it what the item carries: "From {owner}" on an item he
 * added, "Edited by {owner}" on one of hers he changed, "no snooze", "asks
 * for a short report" and "{owner} asked to know by 08:45" while it is open
 * (his join-page promise: "You see both on the item"), and her report once
 * done, or "skipped" and its reason; the project of hers it is in. "Got
 * it" when he asked for an ack. A
 * tick on an item that asks for a report opens the report sheet (Save note,
 * or Done without a note). A tap on the title opens its sheet (TodoSheet:
 * snooze, skip, ask to change, edit, delete). Her text and his render as
 * plain text (React escapes it; no HTML).
 */
import type { PersonTodo } from '@jantar/protocol/people';
import { useState } from 'react';
import { dayLabel } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import { ReportSheet, Tick } from '../ui.js';

/** The line under a to-do's title, as she reads it; `project`: the name of her project it is in. */
export function todoSubline(t: PersonTodo, owner: string, project?: string): string {
  const open = t.doneAt === undefined;
  return [
    t.due ? `${dayLabel(t.due.day)}${t.due.time ? ` ${t.due.time}` : ''}` : null,
    t.repeat ? `every ${t.repeat.freq === 'daily' ? 'day' : t.repeat.freq.replace(/ly$/, '')}` : null,
    project ? `in ${project}` : null,
    t.by === '' ? `From ${owner}` : null,
    t.by !== '' && t.editedBy === '' ? `Edited by ${owner}` : null,
    t.snoozable === false ? 'no snooze' : null,
    t.ask === 'report' && open ? 'asks for a short report' : null,
    t.followUp && open ? `${owner} asked to know by ${t.followUp}` : null,
    t.report && !open ? `"${t.report}"` : null,
    t.skipped && !open ? `skipped${t.skipped.reason ? `: ${t.skipped.reason}` : ''}` : null,
    t.askedChange && open ? `you asked ${owner} to change it` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function TodoRow({
  t,
  owner,
  project,
  onDone,
  onAck,
  onMore,
}: {
  t: PersonTodo;
  owner: string;
  /** The name of her project it is in (left out on that project's own page). */
  project?: string;
  onDone: (done: boolean, report?: string) => void;
  onAck?: () => void;
  onMore?: () => void;
}) {
  const done = t.doneAt !== undefined;
  const [reporting, setReporting] = useState(false);
  const sub = todoSubline(t, owner, project);
  return (
    <li className="flex items-start gap-8 py-8">
      <Tick done={done} label={done ? `Undo ${t.title}` : `Done: ${t.title}`} onClick={() => (!done && t.ask === 'report' ? setReporting(true) : onDone(!done))} />
      {onMore ? (
        <button type="button" aria-label={`More for ${t.title}`} className="min-h-44 min-w-0 flex-1 py-8 text-left" onClick={onMore}>
          <p className={`break-words ${done ? 'text-ink-3 line-through' : ''}`}>{t.title}</p>
          {sub ? <p className="break-words text-small text-ink-2">{sub}</p> : null}
        </button>
      ) : (
        <div className="min-w-0 flex-1 py-8">
          <p className={`break-words ${done ? 'text-ink-3 line-through' : ''}`}>{t.title}</p>
          {sub ? <p className="break-words text-small text-ink-2">{sub}</p> : null}
        </div>
      )}
      {t.by === '' && t.ask === 'ack' && !t.ackAt && onAck ? (
        <Button variant="outline" className="min-h-44" onClick={onAck}>
          Got it
        </Button>
      ) : null}
      <ReportSheet open={reporting} title={t.title} owner={owner} close={() => setReporting(false)} onDone={(report) => (setReporting(false), onDone(true, report))} />
    </li>
  );
}
