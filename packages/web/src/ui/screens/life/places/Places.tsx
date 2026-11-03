/**
 * Cafés (v0.4 spec 5.6; v0.10 spec 0.10 A7.1): your own list of places,
 * `[ All | Tried | Want to try ]`, then a bar with Sort, Filters and a
 * search, and, while filters are on, a row of them to take off one by one.
 * The daemon filters and sorts (best first by default); the address carries
 * the view (`/places?filter=tried&sort=work&tags=wifi,sockets&q=dosa`).
 *
 * A row: the name, the café's own stars (or `want` until it is tried) and
 * its price level; the best dish with its stars; then, in mono, the area,
 * the last visit and the first tags. A tap opens the café's screen
 * (`?id=`, PlaceScreen). The Undo of a delete lives here, so it is still on
 * screen when a deleted café's screen goes back to the list. Every v0.10
 * field may be missing from a 0.9 daemon's answer. The title is the page's
 * <h1> in every state.
 *
 * 0.11 (build plan 2.5): a SplitPane ("cafes", fill). With nothing open
 * (and not on a phone) the cafés are cards across the pane, at least 280
 * wide (four at 1440). From a pane of 800 a café opens beside the list,
 * which becomes the rows with the open one current; below 800 it opens
 * over the list with "< Cafés", as before. The one Undo line shows on the
 * café while one is beside the list.
 */
import { CheckIcon, MagnifyingGlassIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Place, PlacesResponse } from '@jantar/protocol';
import { routePath, type PlacesFilter, type PlacesSortKey, type PlacesView } from '../../../../lib/router.js';
import { useDeps, useNavigate } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { IconButton } from '../../../kit/IconButton.js';
import { Choice } from '../../../kit/Popover.js';
import { SplitPane, useSplit } from '../../../kit/SplitPane.js';
import { Tag } from '../../../kit/Tag.js';
import { useLayout } from '../../../shell/layout.js';
import { Segmented } from '../../accounts/Segmented.js';
import { SwitchRow } from '../../devices/parts.js';
import { CHIP, CHIP_OFF, CHIP_ON } from '../money/fields.js';
import { EMPTY, LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus, type LifeLoad } from '../shared/useLife.js';
import { AddButton, Field, Loaded, Page, useHeldDeletes, useLifeClock, useOffline, useSheet, useUndo, useWrite, type Undo } from '../today/parts.js';
import { FIXED_TAGS, SORTS, SORT_LABELS, WORK_TAGS, filterCount, placesQuery, priceLabel, shortDay, tagLabel, tagsLine, tagsOf, tagsOn } from './model.js';
import { PlaceScreen } from './PlaceScreen.js';
import { PlaceSheet } from './PlaceSheet.js';
import { Stars } from './Stars.js';

export interface PlacesProps extends PlacesView {
  name?: 'places';
  filter?: PlacesFilter | undefined;
  id?: string | undefined;
}

const FILTERS: { key: PlacesFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'tried', label: 'Tried' },
  { key: 'want', label: 'Want to try' },
];

const EMPTY_FOR: Record<PlacesFilter, string> = {
  all: EMPTY.places,
  tried: 'No cafés tried yet.',
  want: 'Nothing on the want to try list.',
};

/** Typing in the search box reaches the address this long after it stops. */
export const SEARCH_DEBOUNCE_MS = 250;

/** The place's best dish: the highest rating, the first of those; an unrated dish never counts. */
export function bestDish(p: Place) {
  return p.dishes.reduce<Place['dishes'][number] | null>((best, d) => (d.rating !== undefined && (!best || d.rating > (best.rating ?? 0)) ? d : best), null);
}

/** The view in the address, without the list's segment or a café. */
function viewOf(p: PlacesProps): PlacesView {
  const v: PlacesView = { sort: p.sort, tags: p.tags, price: p.price, stars: p.stars, again: p.again, area: p.area, q: p.q };
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as PlacesView;
}

export function Places(props: PlacesProps) {
  const { filter = 'all', id } = props;
  const view = viewOf(props);
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const currency = status?.currency ?? null;
  const clock = useLifeClock(status);
  const query = placesQuery(filter, view);
  const load = useLifeLoad(`places:${JSON.stringify(query)}`, () => api.placesList(query));
  const sheet = useSheet<Place>();
  const undo = useUndo();
  const held = useHeldDeletes(undo);
  const remove = useWrite();
  const [sorting, setSorting] = useState(false);
  const [filtering, setFiltering] = useState(false);

  // The last answer the chips and the tags came from: a view change empties `data` until it loads.
  const data = load.data;
  const [last, setLast] = useState<PlacesResponse | null>(null);
  if (data && data !== last) setLast(data);
  const known = data ?? last;
  const customTags = (known?.tags ?? []).map((t) => t.tag).filter((t) => !FIXED_TAGS.includes(t));

  const pathFor = (v: PlacesView, f: PlacesFilter = filter, place?: string) =>
    routePath({ name: 'places', ...(f !== 'all' ? { filter: f } : {}), ...v, ...(place ? { id: place } : {}) });
  const go = (v: PlacesView, f: PlacesFilter = filter) => navigate(pathFor(v, f), { replace: true });
  const listPath = pathFor(view);

  const deletePlace = (p: Place) => {
    held.remove(p.id, `Deleted: ${p.name}`, async () => {
      const r = await remove.run(`delete:${p.id}`, (key) => api.placeDelete(p.id, key));
      if (r.ok) load.reload();
      return r.ok;
    });
    if (id) navigate(listPath, { replace: true });
  };

  // 0.11: the cafés across the pane, and a café beside them from a pane of 800 (over them below that).
  return (
    <SplitPane
      name="cafes"
      list={
        <CafeList
          filter={filter}
          view={view}
          load={load}
          places={held.visible(data?.places ?? [], (p) => p.id)}
          currency={currency}
          known={known}
          customTags={customTags}
          undo={undo}
          open={id ?? null}
          error={remove.error}
          go={go}
          onOpen={(p) => navigate(pathFor(view, filter, p.id))}
          onDelete={deletePlace}
          sorting={sorting}
          setSorting={setSorting}
          filtering={filtering}
          setFiltering={setFiltering}
          sheet={sheet}
        />
      }
      detail={
        id ? (
          <PlaceScreen
            key={id}
            id={id}
            back={listPath}
            currency={currency}
            today={clock.day}
            undo={undo}
            held={held}
            customTags={customTags}
            onDelete={deletePlace}
            onDeleted={() => {
              load.reload();
              navigate(listPath, { replace: true });
            }}
            onRated={load.reload}
          />
        ) : null
      }
      selection={id}
      empty="fill"
      listLabel="All cafés"
      detailLabel="Café"
      onClose={() => navigate(listPath, { replace: true })}
    />
  );
}

interface CafeListProps {
  filter: PlacesFilter;
  view: PlacesView;
  load: LifeLoad<PlacesResponse>;
  /** The cafés without those held for Undo. */
  places: readonly Place[];
  currency: string | null;
  known: PlacesResponse | null;
  customTags: readonly string[];
  undo: Undo;
  /** The café open beside the list. */
  open: string | null;
  error: unknown;
  go: (v: PlacesView, f?: PlacesFilter) => void;
  onOpen: (p: Place) => void;
  onDelete: (p: Place) => void;
  sorting: boolean;
  setSorting: (o: boolean) => void;
  filtering: boolean;
  setFiltering: (o: boolean) => void;
  sheet: ReturnType<typeof useSheet<Place>>;
}

/**
 * The list's page: the segments, the view bar and the cafés, as cards
 * across a wide pane with nothing open, as rows beside an open café (and on
 * a phone). The Undo line shows here unless a café is open beside it.
 */
function CafeList({ filter, view, load, places, currency, known, customTags, undo, open, error, go, onOpen, onDelete, sorting, setSorting, filtering, setFiltering, sheet }: CafeListProps) {
  const offline = useOffline();
  const phone = useLayout().chrome === 'phone';
  const split = useSplit();
  const beside = Boolean(split?.split && split.selected);
  const grid = !phone && !split?.selected;
  const count = filterCount(view);
  const narrowed = count > 0 || !!view.q;
  // 0.11 (c26): Sort and Filters open beside their buttons on an iPad or a Mac.
  const sortAt = useRef<HTMLButtonElement>(null);
  const filtersAt = useRef<HTMLButtonElement>(null);

  const addButton = (
    <Button disabled={offline} onClick={() => sheet.show(null)}>
      <PlusIcon size={16} aria-hidden="true" />
      Add café
    </Button>
  );

  return (
    <Page title="Cafés" aside={<AddButton label="Add café" disabled={offline} onClick={() => sheet.show(null)} />} undo={beside ? undefined : undo} wide>
      <div className="px-16 pb-8 @md:max-w-560">
        <Segmented<PlacesFilter> label="Show" fill value={filter} onChange={(f) => go(view, f)} segments={FILTERS} />
      </div>
      <ViewBar view={view} count={count} sortAt={sortAt} filtersAt={filtersAt} onSort={() => setSorting(true)} onFilters={() => setFiltering(true)} onSearch={(q) => go({ ...view, q })} />
      {count > 0 ? <ActiveFilters view={view} currency={currency} onChange={(v) => go(v)} /> : null}
      {error ? (
        <div className="px-16">
          <NotSaved error={error} />
        </div>
      ) : null}
      <Loaded load={load}>
        {() =>
          places.length === 0 ? (
            narrowed ? (
              <LifeEmpty
                action={
                  <Button variant="text" onClick={() => go({ ...(view.sort ? { sort: view.sort } : {}) })}>
                    Clear the search and filters
                  </Button>
                }
              >
                No café matches.
              </LifeEmpty>
            ) : (
              <LifeEmpty action={addButton}>{EMPTY_FOR[filter]}</LifeEmpty>
            )
          ) : grid ? (
            <ul aria-label="Cafés" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-12 px-16 pt-4">
              {places.map((p) => (
                <PlaceCard key={p.id} place={p} currency={currency} onOpen={() => onOpen(p)} />
              ))}
            </ul>
          ) : (
            <ul aria-label="Cafés" className="border-t border-line">
              {places.map((p) => (
                <PlaceRow key={p.id} place={p} currency={currency} current={p.id === open} onOpen={() => onOpen(p)} />
              ))}
            </ul>
          )
        }
      </Loaded>
      <PlaceSheet
        open={sheet.open}
        onOpenChange={sheet.onOpenChange}
        sheetKey={sheet.key}
        place={sheet.item}
        currency={currency}
        customTags={customTags}
        onSaved={load.reload}
        onDelete={onDelete}
        onDeleted={load.reload}
      />
      <SortSheet open={sorting} onOpenChange={setSorting} anchor={sortAt} value={view.sort ?? 'best'} onPick={(s) => go({ ...view, sort: s === 'best' ? undefined : s })} />
      <FiltersSheet open={filtering} onOpenChange={setFiltering} anchor={filtersAt} view={view} known={known} currency={currency} onChange={(v) => go(v)} />
    </Page>
  );
}

/** One café: name, stars or want, price; the best dish; area, last visit and tags in mono. */
function PlaceRow({ place: p, currency, current = false, onOpen }: { place: Place; currency: string | null; current?: boolean; onOpen: () => void }) {
  const dish = bestDish(p);
  const third = thirdLine(p);
  return (
    <li className={clsx('border-b border-line', current && 'bg-select')}>
      <button
        type="button"
        onClick={onOpen}
        data-row={p.id}
        aria-current={current ? 'true' : undefined}
        className={clsx('relative block w-full px-16 py-10 text-left transition-colors duration-120 ease-hover coarse:min-h-44', current ? 'row-tick' : 'hover:bg-hover')}
      >
        <span className="flex items-center gap-8">
          <span className="min-w-0 flex-1 truncate type-row font-medium text-ink">{p.name}</span>
          {!p.tried ? <Tag>want</Tag> : p.stars ? <Stars rating={p.stars} /> : null}
          {p.again === 'no' ? <Tag>not again</Tag> : null}
          {p.space ? <Tag>shared</Tag> : null}
          {p.price ? currency ? <span className="flex-none type-mono text-ink-2">{priceLabel(p.price, currency)}</span> : <Tag>{priceLabel(p.price, null)}</Tag> : null}
        </span>
        {dish ? (
          <span className="mt-2 flex items-center gap-8 type-small text-ink-2">
            <span className="min-w-0 truncate">{dish.name}</span>
            <Stars rating={dish.rating ?? 0} />
          </span>
        ) : null}
        {third.length ? <span className="mt-2 block truncate type-mono text-ink-3">{third.join(' · ')}</span> : null}
      </button>
    </li>
  );
}

/** The mono line of a row or card: area, last visit, the first tags. */
function thirdLine(p: Place): string[] {
  const tags = tagsOn(p);
  const last = p.visits?.last ?? null;
  return [p.area, last ? shortDay(last) : undefined, tags.length ? tagsLine(tags) : undefined].filter((s): s is string => !!s);
}

/**
 * 0.11, the cafés across a wide pane (build plan 2.5): a card per café. The
 * name on two lines, its stars (or want), not again and the price, the best
 * dish and its stars, then the area, last visit and first tags in mono.
 */
function PlaceCard({ place: p, currency, onOpen }: { place: Place; currency: string | null; onOpen: () => void }) {
  const dish = bestDish(p);
  const third = thirdLine(p);
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        data-row={p.id}
        className="flex h-full w-full flex-col rounded-dock border border-line bg-raised px-12 pb-12 pt-10 text-left transition-colors duration-120 ease-hover hover:border-line-strong focus-visible:outline-offset-2"
      >
        <span className="line-clamp-2 break-words type-row font-medium text-ink">{p.name}</span>
        <span className="mt-6 flex flex-wrap items-center gap-8">
          {!p.tried ? <Tag>want</Tag> : p.stars ? <Stars rating={p.stars} /> : null}
          {p.again === 'no' ? <Tag>not again</Tag> : null}
          {/* v0.11 People: a café in the space he shares, as on its row. */}
          {p.space ? <Tag>shared</Tag> : null}
          {p.price ? currency ? <span className="type-mono text-ink-2">{priceLabel(p.price, currency)}</span> : <Tag>{priceLabel(p.price, null)}</Tag> : null}
        </span>
        {dish ? (
          <span className="mt-6 flex items-center gap-8 type-small text-ink-2">
            <span className="min-w-0 truncate">{dish.name}</span>
            <Stars rating={dish.rating ?? 0} />
          </span>
        ) : null}
        {third.length ? <span className="mt-6 line-clamp-2 break-words type-mono text-ink-3">{third.join(' · ')}</span> : null}
      </button>
    </li>
  );
}

/** Sort, Filters (with how many are on) and the search, which takes the bar's place while it is open. */
function ViewBar({
  view,
  count,
  sortAt,
  filtersAt,
  onSort,
  onFilters,
  onSearch,
}: {
  view: PlacesView;
  count: number;
  sortAt: RefObject<HTMLButtonElement | null>;
  filtersAt: RefObject<HTMLButtonElement | null>;
  onSort: () => void;
  onFilters: () => void;
  onSearch: (q: string | undefined) => void;
}) {
  const [open, setOpen] = useState(!!view.q);
  const [text, setText] = useState(view.q ?? '');
  const box = useRef<HTMLInputElement>(null);
  const sent = useRef(view.q ?? '');
  const search = useRef(onSearch);
  useEffect(() => {
    search.current = onSearch;
  });
  useEffect(() => {
    sent.current = view.q ?? '';
    setText(view.q ?? '');
  }, [view.q]);
  useEffect(() => {
    if (text.trim() === sent.current) return;
    const t = setTimeout(() => {
      sent.current = text.trim();
      search.current(text.trim() || undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  if (open) {
    return (
      <div className="flex items-center gap-8 px-16 pb-8">
        <input
          ref={box}
          type="search"
          aria-label="Search cafés"
          placeholder="Search cafés"
          autoFocus
          enterKeyHint="search"
          maxLength={80}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-40 w-full min-w-0 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44 [&::-webkit-search-cancel-button]:appearance-none"
        />
        <IconButton
          aria-label="Close the search"
          onClick={() => {
            setOpen(false);
            setText('');
            sent.current = '';
            if (view.q) onSearch(undefined);
          }}
        >
          <XIcon size={16} aria-hidden="true" />
        </IconButton>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-8 px-16 pb-8">
      <Button ref={sortAt} size="md" aria-haspopup="dialog" onClick={onSort}>
        {`Sort: ${SORT_LABELS[view.sort ?? 'best']}`}
      </Button>
      <Button ref={filtersAt} size="md" aria-haspopup="dialog" onClick={onFilters} aria-label={count ? `Filters, ${count} on` : 'Filters'}>
        Filters
        {count ? <span className="type-mono text-ink-2">{count}</span> : null}
      </Button>
      <IconButton aria-label="Search cafés" className="ml-auto" onClick={() => setOpen(true)}>
        <MagnifyingGlassIcon size={20} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

/** The filters that are on, each a chip that takes itself off, and Clear. Wraps; nothing scrolls sideways. */
function ActiveFilters({ view, currency, onChange }: { view: PlacesView; currency: string | null; onChange: (v: PlacesView) => void }) {
  const tags = tagsOf(view.tags);
  const chips: { key: string; label: string; off: PlacesView }[] = [
    ...tags.map((t) => ({ key: `tag:${t}`, label: tagLabel(t), off: { ...view, tags: tags.filter((x) => x !== t).join(',') || undefined } })),
    ...(view.price ? [{ key: 'price', label: `Up to ${priceLabel(Number(view.price), currency)}`, off: { ...view, price: undefined } }] : []),
    ...(view.stars ? [{ key: 'stars', label: `${view.stars}+ stars`, off: { ...view, stars: undefined } }] : []),
    ...(view.again ? [{ key: 'again', label: 'Would go again', off: { ...view, again: undefined } }] : []),
    ...(view.area ? [{ key: 'area', label: view.area, off: { ...view, area: undefined } }] : []),
  ];
  return (
    <div role="group" aria-label="Filters on" className="flex flex-wrap items-center gap-6 px-16 pb-8">
      {chips.map((c) => (
        <button key={c.key} type="button" aria-label={`Take off ${c.label}`} onClick={() => onChange(c.off)} className={clsx(CHIP, CHIP_ON, 'inline-flex items-center gap-4')}>
          {c.label}
          <XIcon size={12} aria-hidden="true" />
        </button>
      ))}
      <Button variant="text" size="sm" onClick={() => onChange({ ...(view.sort ? { sort: view.sort } : {}), ...(view.q ? { q: view.q } : {}) })}>
        Clear
      </Button>
    </div>
  );
}

const ROW =
  'flex min-h-44 w-full items-center gap-12 border-b border-line px-4 text-left type-row text-ink transition-colors duration-120 ease-hover hover:bg-hover';

function SortSheet({
  open,
  onOpenChange,
  anchor,
  value,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
  value: PlacesSortKey;
  onPick: (s: PlacesSortKey) => void;
}) {
  return (
    <Choice open={open} onOpenChange={onOpenChange} title="Sort" anchor={anchor}>
      <div role="radiogroup" aria-label="Sort cafés" className="pb-16">
        {SORTS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={s === value}
            className={ROW}
            onClick={() => {
              onPick(s);
              onOpenChange(false);
            }}
          >
            <span className={clsx('flex-1', s === value && 'font-medium')}>{SORT_LABELS[s]}</span>
            {s === value ? <CheckIcon size={16} aria-hidden="true" className="text-ink-2" /> : null}
          </button>
        ))}
      </div>
    </Choice>
  );
}

type PriceKey = 'any' | '1' | '2' | '3' | '4';
type StarsKey = 'any' | '3' | '4' | '5';

function FiltersSheet({
  open,
  onOpenChange,
  anchor,
  view,
  known,
  currency,
  onChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
  view: PlacesView;
  known: PlacesResponse | null;
  currency: string | null;
  onChange: (v: PlacesView) => void;
}) {
  const on = tagsOf(view.tags);
  const has = (t: string) => on.some((x) => x.toLowerCase() === t.toLowerCase());
  const counts = known?.tags ?? [];
  // Work tags first (in their order), then the rest as the daemon counted them; a tag that is on always shows.
  const work = WORK_TAGS.map((t) => counts.find((c) => c.tag === t) ?? (has(t) ? { tag: t, n: 0 } : null)).filter((c): c is { tag: string; n: number } => c !== null);
  const rest = counts.filter((c) => !WORK_TAGS.includes(c.tag));
  const missing = on.filter((t) => ![...work, ...rest].some((c) => c.tag.toLowerCase() === t.toLowerCase())).map((tag) => ({ tag, n: 0 }));
  const chips = [...work, ...rest, ...missing];
  const toggle = (t: string) => onChange({ ...view, tags: (has(t) ? on.filter((x) => x.toLowerCase() !== t.toLowerCase()) : [...on, t]).join(',') || undefined });
  const areas = known?.areas ?? [];
  const areaChips = view.area && !areas.some((a) => a.area.toLowerCase() === view.area?.toLowerCase()) ? [...areas, { area: view.area, n: 0 }] : areas;
  const price: PriceKey = (view.price as PriceKey | undefined) ?? 'any';
  const stars: StarsKey = view.stars === '3' || view.stars === '4' || view.stars === '5' ? view.stars : 'any';
  return (
    <Choice
      open={open}
      onOpenChange={onOpenChange}
      anchor={anchor}
      title="Filters"
      actions={
        <Button variant="text" size="sm" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <div className="pb-16">
        <Field label="Tags" id="places-filter-tags">
          {chips.length ? (
            <div role="group" aria-labelledby="places-filter-tags" className="flex flex-wrap gap-6">
              {chips.map((c) => (
                <button key={c.tag} type="button" aria-pressed={has(c.tag)} onClick={() => toggle(c.tag)} className={clsx(CHIP, has(c.tag) ? CHIP_ON : CHIP_OFF, 'inline-flex items-center gap-6')}>
                  {tagLabel(c.tag)}
                  <span className="type-mono text-ink-3">{c.n}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="type-small text-ink-2">No tags on these cafés yet.</p>
          )}
        </Field>
        <Field label="Price up to" id="places-filter-price">
          <Segmented<PriceKey>
            label="Price up to"
            fill
            value={price}
            onChange={(k) => onChange({ ...view, price: k === 'any' ? undefined : k })}
            segments={[
              { key: 'any', label: 'Any' },
              ...(['1', '2', '3', '4'] as const).map((k) => ({ key: k, label: priceLabel(Number(k), currency), name: `Up to price level ${k} of 4` })),
            ]}
          />
        </Field>
        <Field label="Stars at least" id="places-filter-stars">
          <Segmented<StarsKey>
            label="Stars at least"
            fill
            value={stars}
            onChange={(k) => onChange({ ...view, stars: k === 'any' ? undefined : k })}
            segments={[
              { key: 'any', label: 'Any' },
              { key: '3', label: '3+', name: 'At least 3 stars' },
              { key: '4', label: '4+', name: 'At least 4 stars' },
              { key: '5', label: '5', name: '5 stars' },
            ]}
          />
        </Field>
        <SwitchRow id="places-filter-again" checked={!!view.again} onChange={(v) => onChange({ ...view, again: v ? true : undefined })}>
          Would go again
        </SwitchRow>
        {areaChips.length ? (
          <Field label="Area" id="places-filter-area">
            <div role="group" aria-labelledby="places-filter-area" className="flex flex-wrap gap-6">
              {areaChips.map((a) => {
                const pressed = view.area?.toLowerCase() === a.area.toLowerCase();
                return (
                  <button key={a.area} type="button" aria-pressed={pressed} onClick={() => onChange({ ...view, area: pressed ? undefined : a.area })} className={clsx(CHIP, pressed ? CHIP_ON : CHIP_OFF, 'inline-flex items-center gap-6')}>
                    {a.area}
                    <span className="type-mono text-ink-3">{a.n}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}
      </div>
    </Choice>
  );
}
