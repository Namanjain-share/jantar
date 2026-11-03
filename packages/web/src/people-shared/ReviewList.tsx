/**
 * v0.11 People: the evening review's items (spec 3.10), shared by her
 * review screen and his read-only view. "moved" and "missed" are neutral
 * grey, never red; nothing here scores anything.
 */
import type { ReviewItem } from '@jantar/protocol/people';
import { hmOf, weekdayOf } from './time.js';

const MARK: Record<string, string> = { done: '✓', skipped: '–', excused: '–', moved: '↷', missed: '○', gone: '–' };

export function outcomeText(i: ReviewItem, owner: string): string {
  if (i.kind === 'between') return i.ticks ? `${i.ticks.done} of ${i.ticks.of}` : '';
  const who = i.by === '' ? ` · ${owner}` : '';
  switch (i.outcome) {
    case 'done':
      return `done${i.doneAt ? ` ${hmOf(i.doneAt)}` : ''}`;
    case 'skipped':
      return `skipped${i.reason ? ` · ${i.reason}` : ''}`;
    case 'excused':
      return 'rough day';
    case 'moved':
      return `moved${i.movedTo ? ` to ${weekdayOf(i.movedTo)}` : ''}`;
    case 'missed':
      return `missed${who}`;
    case 'gone':
      return 'gone';
    default:
      return `open${who}`;
  }
}

export function ReviewList({ items, owner, action }: { items: readonly ReviewItem[]; owner: string; action?: (i: ReviewItem) => React.ReactNode }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((i) => (
        <li key={`${i.kind}:${i.ref}`} className="flex min-h-44 items-center gap-8 py-4">
          <span aria-hidden="true" className="w-16 text-center text-ink-2">
            {i.kind === 'between' ? '·' : (MARK[i.outcome ?? ''] ?? '○')}
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words">{i.title}</p>
            {i.report ? <p className="break-words text-small text-ink-2">"{i.report}"</p> : null}
          </div>
          <span className="shrink-0 text-small text-ink-2">{outcomeText(i, owner)}</span>
          {action ? action(i) : null}
        </li>
      ))}
    </ul>
  );
}
