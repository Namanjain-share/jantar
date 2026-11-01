/**
 * One row of the shelf (v0.4 spec 5.8): the title, then "type · source ·
 * date" in mono --ink-3, then two lines of what it is in --ink-2. The whole
 * row opens the item page; links open only from there. v0.5.3: while
 * searching, the search's words are marked in the title and the summary,
 * as React text (never HTML). v0.8: a row read from a link says
 * "platform · creator · date" instead, shows its first thumbnail (48 px, on
 * the right) when the Mac kept one, and "Couldn't read" when its read
 * failed (after a restart too, when no job is left to say so).
 */
import type { IntelListItem } from '@jantar/protocol';
import { Link } from '../../shell/Link.js';
import { RowThumb } from './Frames.js';
import { PLATFORM_LABEL, READ_COPY, marks, shelfDate, shelfPath, type ShelfFilters } from './model.js';

/** --select alone is about 1.1:1 on the page: the underline is what shows. */
function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
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

export function IntelRow({ item, filters, terms, now }: { item: IntelListItem; filters: ShelfFilters; terms: readonly string[]; now: number }) {
  const read = item.platform !== undefined || item.read !== undefined;
  const meta = (read ? [item.platform ? PLATFORM_LABEL[item.platform] : item.type, item.creator] : [item.type, item.source]).concat(shelfDate(item.at, now)).filter(Boolean).join(' · ');
  const failed = item.read?.state === 'failed';
  return (
    <li className="border-b border-line">
      <Link
        href={shelfPath(filters, item.id)}
        className="flex gap-12 px-16 py-10 transition-colors duration-120 ease-hover hover:bg-hover focus-visible:-outline-offset-2"
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
