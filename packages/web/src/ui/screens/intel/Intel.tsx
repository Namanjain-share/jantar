/**
 * The Intel shelf (v0.4 spec 5.8): what the Mac's JSONL sources and the
 * captures hold, newest first.
 *
 *   Intel                         [+ Add]
 *   [ Search the shelf          × ]        300 ms after typing stops; × clears it
 *   All  tool 214  repo 98 …  Tags ›       type chips, scrolling sideways
 *   612 items                              "12 matches" while searching
 *   Claude Code hooks cookbook             a row opens the item page
 *   tool · intel · 29 Oct
 *   What a hook can block and how …
 *   [ Show more ]                          50 at a time
 *   intel: Can't be read                   a refused source's sentence
 *
 * The search, type and tag live in the address (`/intel?q=&type=&tag=`),
 * so back and a shared link land on the same view; `item=` opens one item
 * over it. v0.5.3: the daemon ranks a search best match first, and each row
 * marks the search's words; `focus=search` (the phone header's magnifier)
 * focuses the box and leaves the address. Data comes over REST and again whenever `lifeTick` moves (the
 * shelf ticks while a bot appends); a reload brings back as many rows as
 * were shown, past 100 too (a page holds at most 100, so it follows `next`
 * until it has them). Every state keeps the `<h1>`; while a new view loads,
 * the chips keep the last answer, so the one just pressed stays (with its
 * focus) and only the list waits.
 *
 * v0.8: while the Mac reads links (features.intelRead), Add opens Add post
 * (a link or text and a depth; "Add by hand" is the 0.7 form), and the
 * unfiltered shelf starts with the Reading strip (the Mac's jobs, loaded
 * again on every life.changed). With reading off, Add is the 0.7 sheet and
 * no jobs are asked for.
 */
import { CaretRightIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { INTEL_PAGE_MAX, type IntelListItem, type IntelListResponse } from '@jantar/protocol';
import { useApp, useDeps, useNavigate, useNow, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { useFeatures } from '../../shell/data.js';
import { EMPTY, LifeEmpty, LifeError, LifeLoading, OFFLINE_WRITE } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { AddPostSheet } from './AddPostSheet.js';
import { AddSheet } from './AddSheet.js';
import { IntelRow } from './IntelRow.js';
import { ItemPage } from './ItemPage.js';
import {
  ADDED,
  ADD_SOURCE_COMMAND,
  NOTHING_MATCHES,
  NO_SOURCES,
  PAGE,
  SEARCH_DEBOUNCE_MS,
  hasFilters,
  itemsWord,
  matchesWord,
  shelfPath,
  termsOf,
  type ShelfFilters,
} from './model.js';
import { Reading } from './Reading.js';
import { TagSheet } from './TagSheet.js';

export interface IntelProps {
  q?: string | undefined;
  type?: string | undefined;
  tag?: string | undefined;
  item?: string | undefined;
  /** v0.5.3: from the header's magnifier: focus the search box. */
  focus?: 'search' | undefined;
}

export function Intel({ q, type, tag, item, focus }: IntelProps) {
  const offline = useApp((s) => s.conn.status === 'offline');
  const filters: ShelfFilters = { q, type, tag };
  if (item) return <ItemPage id={item} filters={filters} offline={offline} />;
  return <Shelf filters={filters} offline={offline} focus={focus === 'search'} />;
}

// Room on the right for the clear button; WebKit's own clear button hidden, so there is one.
const INPUT =
  'h-40 w-full min-w-0 rounded-btn border border-line-strong bg-bg pl-12 pr-40 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44 coarse:pr-44 ' +
  '[&::-webkit-search-cancel-button]:appearance-none';

function Chip({ pressed, onClick, label, children }: { pressed?: boolean; onClick: () => void; label?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        'inline-flex h-32 flex-none items-center gap-6 whitespace-nowrap rounded-chip border px-10 type-small transition-colors duration-120 ease-hover coarse:h-44',
        pressed ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:bg-hover hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** Each id once, where it first shows. */
function unique(items: readonly IntelListItem[]): IntelListItem[] {
  const seen = new Set<string>();
  const out: IntelListItem[] = [];
  for (const i of items) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

/** Rows fetched past the first page, for the first page they follow (a reload starts again). */
interface More {
  base: IntelListResponse;
  items: IntelListItem[];
  next: string | null;
}

function Shelf({ filters, offline, focus }: { filters: ShelfFilters; offline: boolean; focus: boolean }) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const toast = useToast();
  const now = useNow(60_000);
  const searchId = useId();
  const searchBox = useRef<HTMLInputElement>(null);
  const terms = termsOf(filters.q);
  const key = JSON.stringify([filters.q ?? '', filters.type ?? '', filters.tag ?? '']);
  // How many rows were on screen for this view, so a reload brings back as many.
  const shown = useRef({ key, n: PAGE });
  const loads = useRef(0);
  const list = useLifeLoad(key, async () => {
    const mine = ++loads.current;
    const want = shown.current.key === key ? Math.max(PAGE, shown.current.n) : PAGE;
    const f = { q: filters.q, type: filters.type, tag: filters.tag };
    let limit = Math.min(INTEL_PAGE_MAX, want);
    const first = await api.intelList({ ...f, limit });
    const items = [...first.items];
    let next = first.next;
    let full = first.items.length === limit;
    // Past one page, the rest follow the cursor until a short page; a load a newer one replaced stops (its answer is dropped anyway).
    while (next && full && items.length < want && mine === loads.current) {
      limit = Math.min(INTEL_PAGE_MAX, want - items.length);
      const page = await api.intelList({ ...f, before: next, limit });
      items.push(...page.items);
      next = page.next;
      full = page.items.length === limit;
    }
    return items.length === first.items.length ? first : { ...first, items, next };
  });
  const sources = useLifeLoad('sources', () => api.intelSources());
  const { intelRead } = useFeatures();
  // v0.8: the Mac's reads; a failure (an older Mac, a part not built) shows no strip.
  const jobs = useLifeLoad(intelRead ? 'jobs' : null, () => api.intelJobs());
  const [more, setMore] = useState<More | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  /** Which add sheet is open: Add post (reading on), or the 0.7 form. */
  const [adding, setAdding] = useState<'post' | 'hand' | null>(null);
  const [picking, setPicking] = useState(false);

  const data = list.data;
  // The last answer the chips were built from: a filter change empties `data` until its view loads.
  const [last, setLast] = useState<IntelListResponse | null>(null);
  if (data && data !== last) setLast(data);
  const chipsFrom = data ?? last;
  const extra = more && more.base === data ? more : null;
  // An item that moved between the fetches (a bot rewrote it) shows once.
  const items = data ? unique([...data.items, ...(extra?.items ?? [])]) : [];
  const next = extra ? extra.next : (data?.next ?? null);
  useEffect(() => {
    shown.current = { key, n: items.length };
  }, [key, items.length]);

  // The search box: typed here, carried into the address once typing stops.
  const [text, setText] = useState(filters.q ?? '');
  useEffect(() => {
    setText(filters.q ?? '');
  }, [filters.q]);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  });
  useEffect(() => {
    if (text === (filtersRef.current.q ?? '')) return;
    const t = setTimeout(() => {
      navigate(shelfPath({ ...filtersRef.current, q: text.trim() ? text : undefined }), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, navigate]);

  const go = (f: ShelfFilters) => navigate(shelfPath(f), { replace: true });

  // The header's magnifier: focus the box, then drop the word from the address (a reload or Back should not jump there again).
  useEffect(() => {
    if (!focus) return;
    searchBox.current?.focus();
    navigate(shelfPath(filtersRef.current), { replace: true });
  }, [focus, navigate]);

  const clearSearch = () => {
    setText('');
    if (filtersRef.current.q) go({ ...filtersRef.current, q: undefined });
    searchBox.current?.focus();
  };

  const showMore = async () => {
    if (!data || !next || moreBusy) return;
    const base = data;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await api.intelList({ q: filters.q, type: filters.type, tag: filters.tag, before: next, limit: PAGE });
      setMore((cur) => {
        const kept = cur && cur.base === base ? cur.items : [];
        return { base, items: [...kept, ...page.items], next: page.next };
      });
    } catch (e) {
      setMoreError(e);
    } finally {
      setMoreBusy(false);
    }
  };

  const types = chipsFrom?.types ?? [];
  const typeChips = filters.type && !types.some((t) => t.type === filters.type) ? [...types, { type: filters.type, n: 0 }] : types;
  const refused = (sources.data?.sources ?? []).filter((s) => s.error);
  const noSources = sources.data ? !sources.data.sources.some((s) => s.id !== 'captures') : false;

  const addButton = (
    <Button variant="outline" onClick={() => setAdding(intelRead ? 'post' : 'hand')} disabled={offline}>
      <PlusIcon size={16} aria-hidden="true" />
      Add
    </Button>
  );

  let body: ReactNode;
  if (!data) {
    body = list.error ? <LifeError error={list.error} offline={offline} onRetry={list.reload} /> : <LifeLoading caption="Opening the shelf…" />;
  } else if (data.total === 0) {
    body = hasFilters(filters) ? (
      <LifeEmpty
        action={
          <Button variant="text" onClick={() => go({})}>
            Clear the search and filters
          </Button>
        }
      >
        {NOTHING_MATCHES}
      </LifeEmpty>
    ) : (
      <LifeEmpty>
        {EMPTY.intel}
        {noSources ? (
          <>
            {' '}
            {NO_SOURCES} <code className="type-mono text-ink">{ADD_SOURCE_COMMAND}</code>
          </>
        ) : null}
      </LifeEmpty>
    );
  } else {
    body = (
      <>
        <p className="px-16 pb-8 pt-12 type-mono text-ink-3">{terms.length ? matchesWord(data.total) : itemsWord(data.total)}</p>
        <ul className="border-t border-line">
          {items.map((i) => (
            <IntelRow key={i.id} item={i} filters={filters} terms={terms} now={now} />
          ))}
        </ul>
        {next ? (
          <div className="px-16 pt-12">
            <Button variant="outline" onClick={() => void showMore()} disabled={moreBusy || offline}>
              {moreBusy ? <Spinner label="Loading more" /> : null}
              Show more
            </Button>
          </div>
        ) : null}
        {moreError ? <LifeError error={moreError} offline={offline} onRetry={() => void showMore()} /> : null}
      </>
    );
  }

  return (
    <div className="pb-48 animate-enter md:max-w-720">
      <header className="flex min-h-44 items-center gap-12 px-16 pb-8 pt-16 md:pt-24">
        <h1 data-display className="min-w-0 flex-1 truncate type-display text-ink">
          Intel
        </h1>
        {addButton}
      </header>
      {offline ? <p className="px-16 pb-8 type-mono text-ink-3">{OFFLINE_WRITE}</p> : null}
      <div className="relative mx-16">
        <label htmlFor={searchId} className="sr-only">
          Search the shelf
        </label>
        <input
          ref={searchBox}
          id={searchId}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search the shelf"
          maxLength={200}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          className={INPUT}
        />
        {text ? (
          <button
            type="button"
            aria-label="Clear the search"
            onClick={clearSearch}
            className="absolute inset-y-0 right-0 flex w-40 items-center justify-center rounded-btn text-ink-3 transition-colors duration-120 ease-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink coarse:w-44"
          >
            <XIcon size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {chipsFrom && (typeChips.length > 0 || chipsFrom.tags.length > 0 || filters.tag) ? (
        // The tag filter comes right after All, so it is on screen however many types the shelf has; the row wraps from md up.
        <div role="group" aria-label="Filter the shelf" className="no-scrollbar mt-12 flex gap-6 overflow-x-auto px-16 md:flex-wrap md:overflow-visible">
          <Chip pressed={!filters.type} onClick={() => go({ ...filters, type: undefined })}>
            All
          </Chip>
          {filters.tag ? (
            <Chip pressed label={`Tag ${filters.tag}: take it off`} onClick={() => go({ ...filters, tag: undefined })}>
              {filters.tag}
              <XIcon size={12} aria-hidden="true" />
            </Chip>
          ) : null}
          {chipsFrom.tags.length ? (
            <Chip onClick={() => setPicking(true)}>
              Tags
              <CaretRightIcon size={12} aria-hidden="true" />
            </Chip>
          ) : null}
          {typeChips.map((t) => (
            <Chip key={t.type} pressed={filters.type === t.type} label={`${t.type}, ${t.n}`} onClick={() => go({ ...filters, type: filters.type === t.type ? undefined : t.type })}>
              {t.type}
              <span className="type-mono text-ink-3">{t.n}</span>
            </Chip>
          ))}
        </div>
      ) : null}
      {data && list.error ? <LifeError error={list.error} offline={offline} onRetry={list.reload} /> : null}
      {jobs.data && !hasFilters(filters) ? (
        <Reading
          data={jobs.data}
          now={now}
          filters={filters}
          offline={offline}
          onChanged={() => {
            jobs.reload();
            list.reload();
          }}
        />
      ) : null}
      {body}
      {refused.length ? (
        <ul aria-label="Sources not read" className="mt-16 px-16">
          {refused.map((s) => (
            <li key={s.id} className="type-small text-ink-2">
              <span className="type-mono text-ink-3">{s.label}</span> {s.error}
            </li>
          ))}
        </ul>
      ) : null}
      <AddPostSheet
        open={adding === 'post'}
        onOpenChange={(o) => setAdding(o ? 'post' : null)}
        offline={offline}
        onSaved={(sentence) => {
          toast(sentence, 'ok');
          list.reload();
          jobs.reload();
          sources.reload();
        }}
        onByHand={() => setAdding('hand')}
      />
      <AddSheet
        open={adding === 'hand'}
        onOpenChange={(o) => setAdding(o ? 'hand' : null)}
        offline={offline}
        onAdded={() => {
          toast(ADDED, 'ok');
          list.reload();
          sources.reload();
        }}
      />
      <TagSheet
        open={picking}
        onOpenChange={setPicking}
        tags={chipsFrom?.tags ?? []}
        current={filters.tag}
        onPick={(t) => {
          setPicking(false);
          go({ ...filters, tag: t });
        }}
      />
    </div>
  );
}
