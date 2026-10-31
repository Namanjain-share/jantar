/**
 * Tags › (v0.4 spec 5.8): the 30 most used tags of what the search and
 * type let through, with their counts. Tapping one filters the shelf by it;
 * "Any tag" takes the filter off.
 */
import { CheckIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { IntelListResponse } from '@jantar/protocol';
import { Sheet } from '../../kit/Sheet.js';

const ROW =
  'flex min-h-44 w-full items-center gap-12 border-b border-line px-4 text-left type-row text-ink transition-colors duration-120 ease-hover hover:bg-hover';

export function TagSheet({
  open,
  onOpenChange,
  tags,
  current,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: IntelListResponse['tags'];
  current: string | undefined;
  onPick: (tag: string | undefined) => void;
}) {
  const on = (t: string) => current !== undefined && current.toLowerCase() === t.toLowerCase();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Tags">
      <ul className="max-h-440 overflow-y-auto pb-16">
        <li>
          <button type="button" className={ROW} aria-pressed={current === undefined} onClick={() => onPick(undefined)}>
            <span className="flex-1">Any tag</span>
            {current === undefined ? <CheckIcon size={16} aria-hidden="true" className="text-ink-2" /> : null}
          </button>
        </li>
        {tags.map((t) => (
          <li key={t.tag}>
            <button type="button" className={ROW} aria-pressed={on(t.tag)} onClick={() => onPick(t.tag)}>
              <span className={clsx('min-w-0 flex-1 truncate', on(t.tag) && 'font-medium')}>{t.tag}</span>
              <span className="type-mono text-ink-3">{t.n}</span>
              {on(t.tag) ? <CheckIcon size={16} aria-hidden="true" className="text-ink-2" /> : null}
            </button>
          </li>
        ))}
        {tags.length === 0 ? <li className="py-12 type-small text-ink-2">No tags on what is shown.</li> : null}
      </ul>
    </Sheet>
  );
}
