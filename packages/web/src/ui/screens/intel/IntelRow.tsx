/**
 * One row of the shelf (v0.4 spec 5.8): the title, then "type · source ·
 * date" in mono --ink-3, then two lines of what it is in --ink-2. The whole
 * row opens the item page; links open only from there. v0.5.3: while
 * searching, the search's words are marked in the title and the summary,
 * as React text (never HTML). v0.8: a row read from a link says
 * "platform · creator · date" instead, shows its first thumbnail (48 px, on
 * the right) when the Mac kept one, and "Couldn't read" when its read
 * failed (after a restart too, when no job is left to say so).
 *
 * 0.12: IntelCard, the same item as a card for the grid across a wide pane.
 */
import type { IntelListItem } from '@jantar/protocol';
import clsx from 'clsx';
import { Link } from '../../shell/Link.js';
import { CardFrame, RowThumb } from './Frames.js';
import { PLATFORM_LABEL, READ_COPY, marks, shelfDate, shelfPath, type ShelfFilters } from './model.js';

/** --select alone is about 1.1:1 on the page: the underline is what shows. */
export function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {marks(text, terms).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-chip bg-select text-ink underline decoration-line-strong decoration-2 underline-offset-2">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/** "tool · intel · 29 Oct", or for a read link "Instagram · @example_cook · 29 Oct". */
export function rowMeta(item: IntelListItem, now: number): string {
  const read = item.platform !== undefined || item.read !== undefined;
  return (read ? [item.platform ? PLATFORM_LABEL[item.platform] : item.type, item.creator] : [item.type, item.source]).concat(shelfDate(item.at, now)).filter(Boolean).join(' · ');
}

/** `current`: the item open beside the list (0.12): ticked (the SplitPane keeps it in view). */
export function IntelRow({ item, filters, terms, now, current = false }: { item: IntelListItem; filters: ShelfFilters; terms: readonly string[]; now: number; current?: boolean }) {
  const meta = rowMeta(item, now);
  const failed = item.read?.state === 'failed';
  return (
    <li className="border-b border-line">
      <Link
        href={shelfPath(filters, item.id)}
        data-row={item.id}
        aria-current={current ? 'true' : undefined}
        className={clsx(
          'relative flex gap-12 px-16 py-10 transition-colors duration-120 ease-hover focus-visible:-outline-offset-2',
          current ? 'row-tick bg-select' : 'hover:bg-hover',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="line-clamp-3 break-words type-row font-medium text-ink">
            <Marked text={item.title} terms={terms} />
          </p>
          <p className="mt-2 truncate type-mono text-ink-3">{meta}</p>
          {failed ? <p className="mt-2 type-small text-ink-2">{READ_COPY.failed}</p> : null}
          {item.summary ? (
            <p className="mt-2 line-clamp-2 break-words type-small text-ink-2">
              <Marked text={item.summary} terms={terms} />
            </p>
          ) : null}
        </div>
        {item.thumb ? <RowThumb id={item.id} /> : null}
      </Link>
    </li>
  );
}

/**
 * 0.12, the shelf across a wide pane (build plan 2.7): a card per item, the
 * first picture on top when the Mac kept one, the title on two lines, where
 * it is from and when, three lines of what it is, and two tags. The card
 * opens the item beside the list.
 */
export function IntelCard({ item, filters, terms, now }: { item: IntelListItem; filters: ShelfFilters; terms: readonly string[]; now: number }) {
  const failed = item.read?.state === 'failed';
  return (
    <li className="min-w-0">
      <Link
        href={shelfPath(filters, item.id)}
        data-row={item.id}
        className="flex h-full flex-col overflow-hidden rounded-dock border border-line bg-raised transition-colors duration-120 ease-hover hover:border-line-strong focus-visible:outline-offset-2"
      >
        {item.thumb ? <CardFrame id={item.id} /> : null}
        <div className="flex min-w-0 flex-1 flex-col px-12 pb-12 pt-10">
          <p className="line-clamp-2 break-words type-row font-medium text-ink">
            <Marked text={item.title} terms={terms} />
          </p>
          <p className="mt-4 truncate type-mono text-ink-3">{rowMeta(item, now)}</p>
          {failed ? <p className="mt-4 type-small text-ink-2">{READ_COPY.failed}</p> : null}
          {item.summary ? (
            <p className="mt-4 line-clamp-3 break-words type-small text-ink-2">
              <Marked text={item.summary} terms={terms} />
            </p>
          ) : null}
          {item.tags.length ? (
            <span className="mt-auto flex flex-wrap gap-4 pt-8">
              {item.tags.slice(0, 2).map((t) => (
                <span key={t} className="inline-flex h-20 items-center rounded-chip border border-line px-6 font-mono text-rail font-data text-ink-3">
                  {t}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
