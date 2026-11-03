/**
 * v0.11 People: one journal entry as both sides show it (spec 3.11): her
 * words as plain text (React escapes them), the mood face, the emotion
 * chips and the comment count.
 */
import type { JournalEntry } from '@jantar/protocol/people';
import { EMOTIONS } from '@jantar/protocol/people-core';
import { face, hmOf } from './time.js';

export function JournalEntryCard({ e, onOpen }: { e: JournalEntry; onOpen?: () => void }) {
  const body = (
    <>
      <p className="text-small text-ink-2">
        {e.kind === 'checkin' ? 'Check-in' : e.kind === 'review' ? 'Evening review' : 'Entry'} · {hmOf(e.at)}
        {e.editedAt ? ' · edited' : ''}
        {e.mood ? ` · ${face(e.mood)}` : ''}
      </p>
      {e.emotions && e.emotions.length > 0 ? (
        <p className="mt-4 flex flex-wrap gap-4">
          {e.emotions.map((x) => (
            <span key={x} className="rounded-chip border border-line px-8 text-small">
              {EMOTIONS[x]}
            </span>
          ))}
        </p>
      ) : null}
      {e.text ? <p className="mt-4 whitespace-pre-wrap break-words">{e.text}</p> : null}
      {e.comments ? <p className="mt-4 text-small text-ink-2">{e.comments === 1 ? '1 comment' : `${e.comments} comments`}</p> : null}
    </>
  );
  return onOpen ? (
    <button type="button" className="block w-full py-8 text-left" onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="py-8">{body}</div>
  );
}
