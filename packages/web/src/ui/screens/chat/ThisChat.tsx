/**
 * This chat (0.11, build plan 2.2, D7): a third column beside the thread in
 * a pane of 1180 or more, or the history column's Changes and Photos below
 * that.
 *
 *   CHANGES 2          what Chat changed that can still be undone (a day),
 *   Added  Todo · …    newest first, each with Undo
 *   PHOTOS             the loaded turns' photos; a tap goes to the turn
 *
 * With no turns yet it says what Chat can see and how long it keeps the
 * thread, in place of an empty list (the user's empty Chat at 1440).
 */
import type { ChatTurn } from '@jantar/protocol';
import { RailLabel } from '../../kit/RailLabel.js';
import { PRIVACY, undoableChanges, photosOf } from './model.js';
import { Change, Thumb } from './Turn.js';

/** The changes still inside the Undo window, newest first, each with its Undo. */
export function ChangeList({ turns, nowMs, offline, onChanged }: { turns: readonly ChatTurn[]; nowMs: number; offline: boolean; onChanged: () => void }) {
  const changes = undoableChanges(turns, nowMs);
  if (!changes.length) return <p className="px-16 py-12 type-small text-ink-3">Nothing to undo. A change can be undone for a day.</p>;
  return (
    <ul aria-label="Changes to undo" className="flex flex-col gap-4 px-16 py-8">
      {changes.map(({ turn, change }) => (
        <Change key={`${turn.id}:${change.n}`} turn={turn} change={change} nowMs={nowMs} offline={offline} onChanged={onChanged} />
      ))}
    </ul>
  );
}

/** The photos in the loaded turns; a tap scrolls the thread to the turn it came with. */
export function PhotoGrid({ turns, onPick }: { turns: readonly ChatTurn[]; onPick: (t: ChatTurn) => void }) {
  const photos = photosOf(turns);
  if (!photos.length) return <p className="px-16 py-12 type-small text-ink-3">No photos in the loaded days.</p>;
  return (
    <ul aria-label="Photos" className="flex flex-wrap gap-8 px-16 py-12">
      {photos.map(({ turn, photo }) => (
        <li key={photo.id}>
          <Thumb photo={photo} label="Go to this photo's message" onOpen={() => onPick(turn)} />
        </li>
      ))}
    </ul>
  );
}

export function ThisChat({ turns, nowMs, offline, keepDays, onPick, onChanged }: { turns: readonly ChatTurn[]; nowMs: number; offline: boolean; keepDays: number; onPick: (t: ChatTurn) => void; onChanged: () => void }) {
  const n = undoableChanges(turns, nowMs).length;
  return (
    <aside aria-label="This chat" className="min-h-0 w-320 flex-none overflow-y-auto border-l border-line bg-surface pb-24">
      {turns.length ? (
        <>
          <section aria-label="Changes">
            <RailLabel ground="surface" count={n}>
              Changes
            </RailLabel>
            <ChangeList turns={turns} nowMs={nowMs} offline={offline} onChanged={onChanged} />
          </section>
          <section aria-label="Photos" className="mt-8">
            <RailLabel ground="surface">Photos</RailLabel>
            <PhotoGrid turns={turns} onPick={onPick} />
          </section>
        </>
      ) : (
        <section aria-label="What Chat can see" className="px-16 pt-16">
          <h2 className="type-row font-medium text-ink">What Chat can see</h2>
          <p className="mt-8 type-small text-pretty text-ink-2">{PRIVACY}</p>
          <h2 className="mt-24 type-row font-medium text-ink">Kept {keepDays} days</h2>
          <p className="mt-8 type-small text-pretty text-ink-2">
            The thread stays on the Mac for {keepDays} days, then goes. What Chat added stays where it put it.
          </p>
        </section>
      )}
    </aside>
  );
}
