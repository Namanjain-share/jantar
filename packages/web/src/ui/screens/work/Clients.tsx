/**
 * 0.13.0 Work › Clients (design 6.2-6.4, W20): his clients and companies,
 * a chunk of its own (Work.tsx loads it on the first visit).
 *
 *   Work                                        ··· +
 *   [ Projects | Clients ]
 *   ⌕ Filter by name, company, e-mail or phone
 *   [ All | Leads | Clients | Past ]
 *   [Sort: Name ▾] [Any tag ▾] [Lists ▾]
 *   NEEDS A STEP · 2        open deals with no next step (W12)
 *   Northwind               lead · no next step
 *   CLIENTS · 9
 *   Acme                    next Thu 15:00  ›
 *     2 open deals · ₹6,50,000 · talked 2d ago
 *   LEADS · 4 / PAST (folded)
 *
 * The filters are the address (`?q=&state=&tag=&list=`, W20), so a link
 * from Today's Work card opens the list it names; the sort is this
 * screen's. A SplitPane ("work-clients", fill): with nothing open a pane
 * of 800 or more shows a table (Name, Company, State, Next step, Last
 * touch, Open deals, Tags); a client opens beside the list (340, 440 from
 * 1180), else over it with "‹ Clients" (ClientHub.tsx).
 *
 * + adds a client (ClientSheet.tsx: about ten seconds, a duplicate warns
 * and never blocks), then opens it. ··· holds Import a file (its sheet
 * loads on first use, ImportSheet.tsx) and Export CSV (the share sheet or
 * a download, never into a folder).
 *
 * Every state of design 6.5: loading, empty ("No clients yet." with Add and
 * Import), nothing matching (Clear filters), Work off and life.db broken
 * (the daemon's sentences), a failed load (Try again), offline (the last
 * list stays; adding is off).
 */
import { CaretDownIcon, CaretRightIcon, MagnifyingGlassIcon, PlusIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WORK_CLIENT_LISTS, WorkClientListsReply, WorkClientRow, WorkClientsResponse, WorkSettings } from '@jantar/protocol/work';
import { errorText } from '../../../lib/api.js';
import type { Route, WorkClientState } from '../../../lib/router.js';
import { shareFile } from '../../../lib/share-file.js';
import { useDeps, useNavigate, useNow, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Panel } from '../../kit/Panel.js';
import { SplitPane, useSplit } from '../../kit/SplitPane.js';
import { useLayout } from '../../shell/layout.js';
import { Link } from '../../shell/Link.js';
import { LifeEmpty } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus, type LifeLoad } from '../life/shared/useLife.js';
import { AddButton, INPUT, Loaded, Page, RowMenu, useLifeClock, useOffline, useSheet } from '../life/today/parts.js';
import { ClientHub } from './ClientHub.js';
import { ClientSheet } from './ClientSheet.js';
import { type ClientsFilter, type WorkClient, workClient } from './client.js';
import {
  CLIENT_GROUPS,
  STATE_CHIPS,
  STATE_LABEL,
  clientPath,
  groupClients,
  needsStep,
  nextLate,
  nextText,
  openDealsText,
  touchText,
} from './clientModel.js';
import { Chips, FromTag } from './parts.js';

// It loads on first use: an import is rare, and most of its code is its own.
const ImportSheet = lazy(() => import('./ImportSheet.js').then((m) => ({ default: m.ImportSheet })));

type WorkRoute = Extract<Route, { name: 'work' }>;
type ListId = (typeof WORK_CLIENT_LISTS)[number];
type Sort = NonNullable<ClientsFilter['sort']>;

/** Work's settings as the screens read them, with the defaults while they load (or can't). */
export interface WorkPrefs {
  quietDays: number;
  dialCode?: string | undefined;
}
const DEFAULT_PREFS: WorkPrefs = { quietDays: 14 };

/** Work's settings (quiet days, the dial code), read once per lifeTick. */
export function useWorkPrefs(w: WorkClient): WorkPrefs {
  const s = useLifeLoad<WorkSettings>('work:settings', () => w.settings());
  return useMemo(() => (s.data ? { quietDays: s.data.quietDays, dialCode: s.data.dialCode } : DEFAULT_PREFS), [s.data]);
}

/** The starter lists' ids (WORK_CLIENT_LISTS, as words: the chunk carries no schema; a test compares them). */
export const CLIENT_LISTS: readonly ListId[] = ['check-in', 'open-deals', 'quiet-leads', 'gone-quiet', 'no-email'];
const isList = (v: string | undefined): v is ListId => v !== undefined && (CLIENT_LISTS as readonly string[]).includes(v);

/**
 * `tabs`: Work's segments, which Work.tsx hands over, so this chunk imports nothing that sits in Work's own
 * (a phone opening Clients fetches only what Clients adds; the perf gate counts it so).
 */
export function Clients({ route, tabs }: { route: WorkRoute; tabs: ReactNode }) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const w = useMemo(() => workClient(api), [api]);
  const prefs = useWorkPrefs(w);
  const [sort, setSort] = useState<Sort>('name');
  const filter = { q: route.q, state: route.state, tag: route.tag, list: isList(route.list) ? route.list : undefined };
  const query: ClientsFilter = { ...filter, sort };
  const load = useLifeLoad(`work:clients:${JSON.stringify(query)}`, () => w.clients(query));
  const lists = useLifeLoad('work:lists', () => w.clientLists());
  const list = clientPath(undefined, filter);
  const reload = load.reload;
  const { id } = route;
  return (
    <SplitPane
      name="work-clients"
      list={<ClientsList w={w} tabs={tabs} load={load} lists={lists} filter={filter} sort={sort} onSort={setSort} prefs={prefs} open={id ?? null} onSaved={reload} />}
      detail={id ? <ClientHub key={id} id={id} back={list} prefs={prefs} onChanged={reload} onDeleted={() => navigate(list, { replace: true })} /> : null}
      selection={id}
      empty="fill"
      listLabel="All clients"
      detailLabel="Client"
      onClose={() => navigate(list, { replace: true })}
    />
  );
}

interface Filter {
  q?: string | undefined;
  state?: WorkClientState | undefined;
  tag?: string | undefined;
  list?: ListId | undefined;
}

interface ClientsListProps {
  w: WorkClient;
  tabs: ReactNode;
  load: LifeLoad<WorkClientsResponse>;
  lists: LifeLoad<WorkClientListsReply>;
  filter: Filter;
  sort: Sort;
  onSort: (s: Sort) => void;
  prefs: WorkPrefs;
  open: string | null;
  onSaved: () => void;
}

/** The list's page: the filters, then the groups as rows (a phone, beside an open client) or one table across a wide pane. */
function ClientsList({ w, tabs, load, lists, filter, sort, onSort, prefs, open, onSaved }: ClientsListProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const offline = useOffline();
  const phone = useLayout().chrome === 'phone';
  const split = useSplit();
  const table = !phone && Boolean(split?.split) && !split?.selected;
  const { status } = useLifeStatus();
  const now = useLifeClock(status);
  const nowMs = useNow(60_000);
  const add = useSheet<null>();
  const importer = useSheet<null>();
  const [showPast, setShowPast] = useState(false);
  const filtered = Boolean(filter.q || filter.state || filter.tag || filter.list);
  const go = (next: Filter) => navigate(clientPath(undefined, { ...filter, ...next }), { replace: true });
  // The tags he can pick: the ones on the rows shown, and the one picked.
  const tags = useMemo(() => {
    const all = new Set((load.data?.clients ?? []).flatMap((c) => c.tags));
    if (filter.tag) all.add(filter.tag);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [load.data, filter.tag]);

  const exportCsv = async () => {
    try {
      const csv = await w.exportCsv();
      const r = await shareFile(new File([csv], 'jantar-clients.csv', { type: 'text/csv' }));
      if (r !== 'cancelled') toast('Clients exported.');
    } catch (e) {
      toast(`Not exported. ${errorText(e)}`, 'error');
    }
  };

  const menu = (
    <RowMenu
      label="More for clients"
      groups={[
        {
          items: [
            { label: 'Import a file', onSelect: () => importer.show(null), disabled: offline },
            { label: 'Export CSV', onSelect: () => void exportCsv(), disabled: offline },
          ],
        },
      ]}
    />
  );

  return (
    <Page
      title="Work"
      aside={
        <>
          {menu}
          <AddButton label="Add client" disabled={offline} onClick={() => add.show(null)} />
        </>
      }
      wide
    >
      {tabs}
      <Filters filter={filter} sort={sort} onSort={onSort} tags={tags} lists={lists.data?.lists ?? []} onChange={go} />
      <Loaded load={load}>
        {(d) => {
          if (d.clients.length === 0)
            return filtered ? (
              <LifeEmpty
                action={
                  <Button onClick={() => navigate(clientPath(), { replace: true })} className="coarse:min-h-44">
                    Clear filters
                  </Button>
                }
              >
                No clients match.
              </LifeEmpty>
            ) : (
              <LifeEmpty
                action={
                  <div className="flex flex-wrap gap-8">
                    <Button variant="primary" disabled={offline} onClick={() => add.show(null)} className="coarse:min-h-44">
                      <PlusIcon size={16} aria-hidden="true" />
                      Add a client
                    </Button>
                    <Button disabled={offline} onClick={() => importer.show(null)} className="coarse:min-h-44">
                      <UploadSimpleIcon size={16} aria-hidden="true" />
                      Import a file
                    </Button>
                  </div>
                }
              >
                No clients yet.
              </LifeEmpty>
            );
          const listName = filter.list ? (lists.data?.lists.find((l) => l.id === filter.list)?.name ?? 'List') : null;
          const groups = listName ? null : groupClients(d.clients);
          const shown = groups ? CLIENT_GROUPS.filter((g) => groups[g.key].length > 0) : [];
          const rowProps = { today: now.day, nowMs, quietDays: prefs.quietDays, open, filter };
          return (
            <div className={table ? 'flex flex-col gap-16 px-16 pt-4' : undefined}>
              {listName ? (
                <Panel label={listName} count={d.clients.length} card={table}>
                  {table ? <ClientTable label={listName} rows={d.clients} {...rowProps} /> : <ClientRows label={listName} rows={d.clients} showState {...rowProps} />}
                </Panel>
              ) : (
                shown.map((g) => {
                  const rows = groups![g.key];
                  // Past folds until opened, unless the list is the past ones.
                  const foldable = g.key === 'past' && filter.state !== 'past';
                  const folded = foldable && !showPast;
                  const fold = foldable ? (
                    <button
                      type="button"
                      aria-expanded={showPast}
                      onClick={() => setShowPast((v) => !v)}
                      className="inline-flex h-28 items-center gap-6 type-rail text-ink-3 transition-colors duration-120 ease-hover hover:text-ink coarse:h-44"
                    >
                      {showPast ? <CaretDownIcon size={12} aria-hidden="true" /> : <CaretRightIcon size={12} aria-hidden="true" />}
                      {showPast ? 'Hide' : 'Show'}
                    </button>
                  ) : undefined;
                  return (
                    <Panel key={g.key} label={g.label} count={rows.length} aside={fold} card={table}>
                      {folded ? null : table ? (
                        <ClientTable label={g.label} rows={rows} {...rowProps} />
                      ) : (
                        <ClientRows label={g.label} rows={rows} showState={g.key === 'step'} {...rowProps} />
                      )}
                    </Panel>
                  );
                })
              )}
              {d.more > 0 ? <p className="px-16 py-12 type-small text-ink-2">{`${d.more.toLocaleString('en-US')} more not shown. Narrow the filter to find them.`}</p> : null}
            </div>
          );
        }}
      </Loaded>
      <ClientSheet
        open={add.open}
        onOpenChange={add.onOpenChange}
        sheetKey={add.key}
        client={null}
        onSaved={(newId, name) => {
          onSaved();
          toast(`Added ${name}`);
          navigate(clientPath(newId, filter));
        }}
      />
      {importer.key ? (
        <Suspense fallback={null}>
          <ImportSheet open={importer.open} onOpenChange={importer.onOpenChange} sheetKey={importer.key} onImported={onSaved} />
        </Suspense>
      ) : null}
    </Page>
  );
}

/** The filter box (its words go to the address once typing stops), the state chips, the sort, a tag and a starter list. */
function Filters({ filter, sort, onSort, tags, lists, onChange }: { filter: Filter; sort: Sort; onSort: (s: Sort) => void; tags: readonly string[]; lists: WorkClientListsReply['lists']; onChange: (f: Filter) => void }) {
  const [text, setText] = useState(filter.q ?? '');
  const typed = useRef(filter.q ?? '');
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });
  // A filter changed from elsewhere (Clear filters, a link): the box says it.
  useEffect(() => {
    if ((filter.q ?? '') !== typed.current.trim()) {
      typed.current = filter.q ?? '';
      setText(filter.q ?? '');
    }
  }, [filter.q]);
  useEffect(() => {
    const q = text.trim();
    if (q === (filter.q ?? '')) return;
    const t = setTimeout(() => change.current({ q: q || undefined }), 300);
    return () => clearTimeout(t);
  }, [text, filter.q]);
  const select = 'h-32 min-w-0 max-w-full rounded-btn border border-line bg-bg px-8 type-small text-ink outline-none focus-visible:outline-2 focus-visible:outline-ink coarse:h-44';
  return (
    <div className="flex flex-col gap-8 px-16 pb-12">
      <label className="relative block">
        <span className="sr-only">Filter clients</span>
        <MagnifyingGlassIcon size={16} aria-hidden="true" className="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          type="search"
          className={clsx(INPUT, 'pl-36')}
          value={text}
          maxLength={80}
          autoComplete="off"
          placeholder="Name, company, e-mail or phone"
          onChange={(e) => {
            typed.current = e.target.value;
            setText(e.target.value);
          }}
        />
      </label>
      <Chips<'all' | WorkClientState> label="State" chips={STATE_CHIPS} value={filter.state ?? 'all'} onChange={(k) => onChange({ state: !k || k === 'all' ? undefined : k })} />
      <div className="flex flex-wrap items-center gap-8">
        <select aria-label="Sort" className={select} value={sort} onChange={(e) => onSort(e.target.value as Sort)}>
          <option value="name">By name</option>
          <option value="touch">Last touch</option>
          <option value="next">Next step</option>
        </select>
        <select aria-label="Tag" className={select} value={filter.tag ?? ''} onChange={(e) => onChange({ tag: e.target.value || undefined })}>
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
        {lists.length ? (
          <select aria-label="List" className={select} value={filter.list ?? ''} onChange={(e) => onChange({ list: isList(e.target.value) ? e.target.value : undefined })}>
            <option value="">Every client</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.count})
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

interface RowsProps {
  rows: readonly WorkClientRow[];
  today: string;
  nowMs: number;
  quietDays: number;
  open: string | null;
  filter: Filter;
}

/** One client: its name (a person with its company), its next step at the right, then its state, open deals and last touch. */
function ClientRows({ label, rows, showState = false, today, nowMs, quietDays, open, filter }: RowsProps & { label: string; showState?: boolean }) {
  return (
    <ul aria-label={label}>
      {rows.map((c) => {
        const current = c.id === open;
        const next = nextText(c.next, today);
        const touch = touchText(c.lastTouchAt, nowMs, quietDays);
        const deals = openDealsText(c.openDeals);
        const meta = [
          showState ? STATE_LABEL[c.state].toLowerCase() : null,
          c.title ?? null,
          deals || null,
          touch.text,
          c.checkInDue ? 'check-in due' : null,
        ].filter((x): x is string => x !== null);
        return (
          <li key={c.id} className={clsx('border-b border-line', current && 'bg-select')}>
            <Link
              href={clientPath(c.id, filter)}
              data-client={c.id}
              data-row={c.id}
              aria-current={current ? 'true' : undefined}
              className={clsx('relative flex items-center gap-8 px-16 py-10 transition-colors duration-120 ease-hover coarse:min-h-56', current ? 'row-tick' : 'hover:bg-hover')}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-8">
                  <span className="min-w-0 truncate type-row text-ink">
                    <span className="font-medium">{c.name}</span>
                    {c.company ? <span className="text-ink-2"> · {c.company.name}</span> : null}
                  </span>
                  <FromTag from={c.from ?? c.company?.from} className="flex-none" />
                  <span className={clsx('ml-auto flex-none type-mono', nextLate(c.next, today) ? 'text-signal-text' : 'text-ink-2')}>
                    {next ?? (needsStep(c) ? 'no next step' : '')}
                  </span>
                </span>
                <span className="mt-2 block truncate type-mono text-ink-3">{meta.join(' · ')}</span>
              </span>
              <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** A wide pane with nothing open (D2): one row per client across the table's columns; the name is the row's link. */
function ClientTable({ label, rows, today, nowMs, quietDays, filter }: RowsProps & { label: string }) {
  const navigate = useNavigate();
  const cell = 'flex-none truncate type-mono';
  return (
    <div role="table" aria-label={label}>
      <div role="row" className="flex h-32 items-center gap-12 border-b border-line px-16 type-small text-ink-3">
        <span role="columnheader" className="min-w-0 flex-1">
          Name
        </span>
        <span role="columnheader" className="w-160 flex-none">
          Company
        </span>
        <span role="columnheader" className="w-64 flex-none">
          State
        </span>
        <span role="columnheader" className="w-120 flex-none">
          Next step
        </span>
        <span role="columnheader" className="w-120 flex-none">
          Last touch
        </span>
        <span role="columnheader" className="w-160 flex-none">
          Open deals
        </span>
        <span role="columnheader" className="w-120 flex-none">
          Tags
        </span>
      </div>
      {rows.map((c) => {
        const href = clientPath(c.id, filter);
        const touch = touchText(c.lastTouchAt, nowMs, quietDays);
        return (
          <div
            role="row"
            key={c.id}
            data-client={c.id}
            className="flex min-h-44 cursor-pointer items-center gap-12 border-b border-line px-16 transition-colors duration-120 ease-hover last:border-b-0 hover:bg-hover coarse:min-h-52"
            onClick={(e) => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.target as Element).closest('a')) return;
              navigate(href);
            }}
          >
            <span role="cell" className="flex min-w-0 flex-1 items-center gap-8 self-stretch">
              <Link href={href} data-row={c.id} className="flex min-w-0 flex-1 items-center truncate py-6 type-row font-medium text-ink focus-visible:-outline-offset-2">
                {c.name}
              </Link>
              <FromTag from={c.from} className="flex-none" />
            </span>
            <span role="cell" className="w-160 flex-none truncate type-small text-ink-2">
              {c.company?.name ?? ''}
            </span>
            <span role="cell" className={clsx(cell, 'w-64 text-ink-2')}>
              {STATE_LABEL[c.state].toLowerCase()}
            </span>
            <span role="cell" className={clsx(cell, 'w-120', nextLate(c.next, today) ? 'text-signal-text' : 'text-ink-2')}>
              {nextText(c.next, today)?.replace(/^next:? /, '') ?? (needsStep(c) ? 'none' : '')}
            </span>
            <span role="cell" className={clsx(cell, 'w-120 text-ink-3')}>
              {c.lastTouchAt ? touch.text : ''}
            </span>
            <span role="cell" className={clsx(cell, 'w-160 text-ink-2')}>
              {openDealsText(c.openDeals)}
            </span>
            <span role="cell" className={clsx(cell, 'w-120 text-ink-3')}>
              {c.tags.map((t) => `#${t}`).join(' ')}
            </span>
          </div>
        );
      })}
    </div>
  );
}
