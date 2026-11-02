/**
 * v0.12 People: one to-do row of hers: a tick circle (at least 44 px), the
 * title, "From {owner}" on an item he added, "Edited by {owner}" on one of
 * hers he changed, and "Got it" when he asked for an ack. Her text and his
 * render as plain text (React escapes it; no HTML).
 */
import type { PersonTodo } from '@jantar/protocol/people';
import { Button } from '../../ui/kit/Button.js';

export function TodoRow({ t, owner, onDone, onAck }: { t: PersonTodo; owner: string; onDone: (done: boolean) => void; onAck?: () => void }) {
  const done = t.doneAt !== undefined;
  return (
    <li className="flex items-start gap-8 py-8">
      <button
        aria-label={done ? `Undo ${t.title}` : `Done: ${t.title}`}
        aria-pressed={done}
        className="flex size-44 shrink-0 items-center justify-center"
        onClick={() => onDone(!done)}
      >
        <span className={`block size-20 rounded-full border-2 ${done ? 'border-ink bg-ink' : 'border-line-strong'}`} />
      </button>
      <div className="min-w-0 flex-1 py-8">
        <p className={`break-words ${done ? 'text-ink-3 line-through' : ''}`}>{t.title}</p>
        <p className="text-small text-ink-2">
          {t.due ? `${t.due.day}${t.due.time ? ` ${t.due.time}` : ''}` : null}
          {t.by === '' ? ` · From ${owner}` : null}
          {t.by !== '' && t.editedBy === '' ? ` · Edited by ${owner}` : null}
          {t.snoozable === false ? ' · no snooze' : null}
        </p>
      </div>
      {t.by === '' && t.ask === 'ack' && !t.ackAt && onAck ? (
        <Button variant="outline" size="sm" onClick={onAck}>
          Got it
        </Button>
      ) : null}
    </li>
  );
}
