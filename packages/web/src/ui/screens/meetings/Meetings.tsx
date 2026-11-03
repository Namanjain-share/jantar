/**
 * Meetings (v0.5 spec 5.2, `/meetings`): what the Chrome extension kept
 * from Meet and Teams calls, newest first.
 *
 *   Meetings
 *   ● Meeting running · Weekly sync          the newest open one; opens it
 *     34 lines · 3 screenshots               every 10 s while visible
 *   [ Search meetings              ]         300 ms after typing stops
 *   All  Acme site  Jantar  No project       the active projects, while Todos are on
 *   TODAY                                    a rail per day
 *   Weekly sync              10:00 · 42 min  MeetingRow
 *   [ Show more ]                            30 at a time
 *   Deleted: Weekly sync · Undo              5 s, then the DELETE is sent
 *
 * The search and the project live in the address (`?q=&project=`), so back
 * and a shared link land on the same view; `id=` opens one meeting
 * (MeetingPage), and coming back from it brings back as many rows as were
 * shown, at the scroll it had (the SplitPane keeps it). Data comes over REST, again on
 * lifeTick and on coming back into view; a reload brings back as many rows
 * as were shown, and a new search or project keeps the last rows, dimmed,
 * until its own answer comes. Offline, the search and the chips wait for
 * the Mac (the last list stays as it is). Caption lines send no tick, so
 * while a meeting runs its line alone (one row) is asked for every 10 s.
 * The list and the page share one Undo line, so a delete made on the page
 * is held on the list it goes back to; a failed delete's "Not saved" stays
 * with the view it failed on. Every state keeps the `<h1>`.
 *
 * 0.12 (build plan 2.8): a SplitPane ("meetings", fill). With nothing open
 * the meetings are cards across the pane (at least 280 wide: four at 1440),
 * and the days sit side by side, each over as many card columns as it has
 * meetings, so a day of one meeting doesn't leave its row empty. A meeting
 * opens beside the list from a pane of 800, where the list is rows with the
 * open one current, and over it below that. The Undo line and "Not saved"
 * show once, on the meeting while one is beside the list.
 *
 * 0.12.2: how many rows the list shows is kept in the commit, so a reload
 * that comes the moment Show more's rows are on screen brings them all back.
 */
import clsx from 'clsx';
import { useEffect, useId, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { CLI_NAME, MEETING_LIMITS, type Meeting, type MeetingsList, type ProjectView } from '@jantar/protocol';
import { isApiError } from '../../../lib/api.js';
import { useDeps, useNavigate, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Spinner } from '../../kit/Spinner.js';
import { SplitPane, useSplit } from '../../kit/SplitPane.js';
import { useFeatures } from '../../shell/data.js';
import { useLayout } from '../../shell/layout.js';
import { Link } from '../../shell/Link.js';
import { LifeEmpty, LifeLoading, NotSaved } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { INPUT, Page, useHeldDeletes, useOffline, useUndo, useWrite, type Undo } from '../life/today/parts.js';
import { MeetingPage, useItemMarks } from './MeetingPage.js';
import { MeetingCard, MeetingRow } from './MeetingRow.js';
import {
  NOTHING_MATCHES,
  NO_MEETINGS,
  PAGE,
  SEARCH_DEBOUNCE_MS,
  byDay,
  chipProjects,
  hasFilters,
  linesText,
  meetingKey,
  meetingsPath,
  projectText,
  shotsText,
  unique,
  type MeetingFilters,
} from './model.js';
import { usePoll } from './poll.js';
import { MeetingsError } from './states.js';

export interface MeetingsProps {
  /** A project id, or 'none' for meetings without one. */
  project?: string;
  q?: string;
  /** A meeting's id: its page opens over the list. */
  id?: string;
}

/** A meeting card is at least this wide, with this gap between cards and days (px). */
const CARD_MIN = 280;
const CARD_GAP = 12;

/**
 * The days across a wide pane, in order, wrapping: a day's box starts as
 * wide as its cards side by side and the rows share what is left in
 * proportion, so days of one or two meetings sit together on a row instead
 * of each leaving the rest of it empty. A day with more cards than fit wraps
 * them. CSS only (flex, then each day's own auto-fit grid): nothing measures.
 */
function DayGrid({ days, ground, card }: { days: { rail: string; meetings: Meeting[] }[]; ground: 'surface' | 'bg'; card: (m: Meeting) => ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-12 px-16">
      {days.map((g) => {
        const n = g.meetings.length;
        return (
          <div key={g.rail} role="group" aria-label={g.rail} className="min-w-0" style={{ flex: `${n} 1 ${n * (CARD_MIN + CARD_GAP) - CARD_GAP}px` }}>
            <RailLabel ground={ground} inset={false}>
              {g.rail}
            </RailLabel>
            <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-12 pb-16 pt-12">{g.meetings.map(card)}</ul>
          </div>
        );
      })}
    </div>
  );
}

/** Where the list was: its view and how many rows it showed (its scroll is the SplitPane's to keep). */
interface ListPlace {
  key: string;
  n: number;
}

export function Meetings({ project, q, id }: MeetingsProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const { life } = useFeatures();
  const { status } = useLifeStatus();
  // Projects are Todos': no chips, no Project field and no Add while Todos are off.
  const todos = life && status?.modules.todos === true;
  const projects = useLifeLoad(todos ? 'projects' : null, () => api.projectsList());
  const undo = useUndo();
  const marks = useItemMarks();
  const held = useHeldDeletes(undo);
  const remove = useWrite();
  const filters: MeetingFilters = { project, q };
  const projectList = todos ? (projects.data?.projects ?? []) : [];
  // Kept here, not in the list: the list is gone while a meeting shows over it.
  const place = useRef<ListPlace>({ key: '', n: PAGE });

  const deleteMeeting = (m: Meeting) => {
    held.remove(meetingKey(m.id), `Deleted: ${m.name}`, async () => (await remove.run(`delete:${m.id}`, (key) => api.meetingDelete(m.id, key))).ok);
  };
  // A failed delete's "Not saved" belongs to the view it showed on: opening or leaving a meeting drops it.
  const clearRemove = remove.clear;
  useEffect(() => clearRemove(), [id, clearRemove]);
  const notSaved = remove.error ? (
    <div className="px-16">
      <NotSaved error={remove.error} />
    </div>
  ) : null;

  const shown = id && held.visible([meetingKey(id)], (k) => k).length > 0 ? id : null;
  // 0.12: the list across the pane (cards), and a meeting beside it from a pane of 800 (over it below that).
  return (
    <SplitPane
      name="meetings"
      list={
        <ListPage undo={undo} notice={notSaved}>
          <List
            filters={filters}
            todos={todos}
            projects={projectList}
            place={place}
            open={shown}
            visible={(ms) => held.visible(ms, (m) => meetingKey(m.id))}
            onDelete={deleteMeeting}
          />
        </ListPage>
      }
      detail={
        shown ? (
          <MeetingPage
            key={shown}
            id={shown}
            filters={filters}
            undo={undo}
            marks={marks}
            todos={todos}
            projects={projectList}
            onDelete={(m) => {
              deleteMeeting(m);
              navigate(meetingsPath(filters), { replace: true });
            }}
            notice={notSaved}
          />
        ) : null
      }
      selection={shown ?? undefined}
      empty="fill"
      listLabel="All meetings"
      detailLabel="Meeting"
      onClose={() => navigate(meetingsPath(filters), { replace: true })}
    />
  );
}

/**
 * The list's page. The one Undo line and a delete's "Not saved" show once:
 * on the meeting's page while one is open beside the list, here otherwise.
 */
function ListPage({ undo, notice, children }: { undo: Undo; notice: ReactNode; children: ReactNode }) {
  const split = useSplit();
  const beside = Boolean(split?.split && split.selected);
  return (
    <Page title="Meetings" undo={beside ? undefined : undo} wide>
      {beside ? null : notice}
      {children}
    </Page>
  );
}

function Chip({ pressed, disabled, onClick, children }: { pressed: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex h-32 flex-none items-center gap-6 whitespace-nowrap rounded-chip border px-10 type-small transition-colors duration-120 ease-hover disabled:opacity-40 coarse:h-44 coarse:min-w-44 coarse:justify-center',
        pressed ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:not-disabled:bg-hover hover:not-disabled:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** "● Meeting running · Weekly sync / 34 lines · 3 screenshots": the whole line opens it. */
function RunningLine({ meeting: m, filters }: { meeting: Meeting; filters: MeetingFilters }) {
  return (
    <Link
      href={meetingsPath(filters, m.id)}
      className="mx-8 mb-8 block rounded-btn px-8 py-6 transition-colors duration-120 ease-hover hover:bg-hover"
    >
      <span className="flex items-center gap-8">
        <i aria-hidden="true" className="block size-6 flex-none bg-jup" />
        <span className="min-w-0 truncate type-row text-ink">Meeting running · {m.name}</span>
      </span>
      <span className="mt-2 block pl-14 type-mono text-ink-3">
        {linesText(m.lines)} · {shotsText(m.shots)}
      </span>
    </Link>
  );
}

/** Rows fetched past the first page, for the first page they follow (a reload starts again). */
interface More {
  base: MeetingsList;
  meetings: Meeting[];
  next: string | null;
}

function List({
  filters,
  todos,
  projects,
  place,
  open,
  visible,
  onDelete,
}: {
  filters: MeetingFilters;
  todos: boolean;
  projects: readonly ProjectView[];
  place: MutableRefObject<ListPlace>;
  /** The meeting open beside the list. */
  open: string | null;
  /** The rows without those held for Undo. */
  visible: (ms: readonly Meeting[]) => readonly Meeting[];
  onDelete: (m: Meeting) => void;
}) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const now = useNow(60_000);
  const searchId = useId();
  const key = JSON.stringify([filters.project ?? '', filters.q ?? '']);
  const loads = useRef(0);
  // A reload, or coming back from a meeting, brings back as many rows as this view showed.
  const list = useLifeLoad(key, async () => {
    const mine = ++loads.current;
    const want = place.current.key === key ? Math.max(PAGE, place.current.n) : PAGE;
    const f = { project: filters.project, q: filters.q };
    let limit = Math.min(MEETING_LIMITS.page, want);
    const first = await api.meetingsList({ ...f, limit });
    const meetings = [...first.meetings];
    let next = first.next;
    let full = first.meetings.length === limit;
    // Past one page, the rest follow the cursor until a short page; a load a newer one replaced stops.
    while (next && full && meetings.length < want && mine === loads.current) {
      limit = Math.min(MEETING_LIMITS.page, want - meetings.length);
      const page = await api.meetingsList({ ...f, before: next, limit });
      meetings.push(...page.meetings);
      next = page.next;
      full = page.meetings.length === limit;
    }
    return meetings.length === first.meetings.length ? first : { ...first, meetings, next };
  });
  const [more, setMore] = useState<More | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);

  // A new search or project keeps the last answer's rows on screen, dimmed, until its own comes.
  const [last, setLast] = useState<MeetingsList | null>(null);
  useEffect(() => {
    if (list.data) setLast(list.data);
  }, [list.data]);
  const stale = list.data === null && last !== null;
  const data = list.data ?? last;
  const extra = more && more.base === data ? more : null;
  const all = data ? unique([...data.meetings, ...(extra?.meetings ?? [])]) : [];
  const next = extra ? extra.next : (data?.next ?? null);
  // 0.12.2: kept in the commit (a layout effect), so a reload the moment Show more's rows are on screen brings them
  // all back. Show more's answer commits outside a user event, and React yields for paint before its passive
  // effects: a reload in that gap (the page coming back into view) read the count from before and showed one
  // page (the CI flake in meetings.test.tsx).
  useLayoutEffect(() => {
    if (list.data) place.current = { key, n: all.length };
  }, [place, list.data, key, all.length]);
  const rows = visible(all);
  // Cards across a wide pane with nothing open (not on a phone); rows in the list column beside a meeting.
  const phone = useLayout().chrome === 'phone';
  const split = useSplit();
  const beside = Boolean(split?.split && split.selected);
  const grid = !phone && !split?.selected;
  // Caption lines send no tick: while a meeting runs, its line asks for itself every 10 s. One row
  // is enough (`running` comes whatever the filter); the pages on screen are not asked for again.
  const [live, setLive] = useState<{ base: MeetingsList; running: Meeting | null } | null>(null);
  const newest = live && live.base === data ? live.running : (data?.running ?? null);
  const running = newest && visible([newest]).length > 0 ? newest : null;
  usePoll(running !== null, () => {
    const base = data;
    if (!base) return;
    // A failed ask waits for the next one; the list's own reloads say what went wrong.
    api.meetingsList({ limit: 1 }).then(
      (r) => setLive({ base, running: r.running }),
      () => undefined,
    );
  });

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
      navigate(meetingsPath({ ...filtersRef.current, q: text.trim() ? text : undefined }), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, navigate]);

  const go = (f: MeetingFilters) => navigate(meetingsPath(f), { replace: true });

  const showMore = async () => {
    if (!data || !next || moreBusy || stale) return;
    const base = data;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await api.meetingsList({ project: filters.project, q: filters.q, before: next, limit: PAGE });
      setMore((cur) => {
        const kept = cur && cur.base === base ? cur.meetings : [];
        return { base, meetings: [...kept, ...page.meetings], next: page.next };
      });
    } catch (e) {
      setMoreError(e);
    } finally {
      setMoreBusy(false);
    }
  };

  const chips = chipProjects(projects, filters.project);

  let body: ReactNode;
  if (!data) {
    body = list.error ? <MeetingsError error={list.error} offline={offline} onRetry={list.reload} /> : <LifeLoading caption="Asking the Mac…" />;
  } else if (rows.length === 0) {
    body = hasFilters(filters) ? (
      <LifeEmpty
        action={
          <Button variant="text" onClick={() => go({})}>
            Clear the search and filter
          </Button>
        }
      >
        {NOTHING_MATCHES}
      </LifeEmpty>
    ) : (
      <LifeEmpty>
        {NO_MEETINGS} <code className="type-mono text-ink">{CLI_NAME} pair --extension</code>
      </LifeEmpty>
    );
  } else {
    const days = byDay(rows, now);
    body = (
      <>
        {/* A group, not a landmark: dozens of days would each be a region. */}
        {grid ? (
          <DayGrid days={days} ground="bg" card={(m) => <MeetingCard key={m.id} meeting={m} filters={filters} offline={offline} onDelete={onDelete} />} />
        ) : (
          days.map((g) => (
            <div key={g.rail} role="group" aria-label={g.rail}>
              <RailLabel ground={beside ? 'surface' : 'bg'}>{g.rail}</RailLabel>
              <ul>
                {g.meetings.map((m) => (
                  <MeetingRow key={m.id} meeting={m} filters={filters} offline={offline} current={m.id === open} onDelete={onDelete} />
                ))}
              </ul>
            </div>
          ))
        )}
        {next ? (
          <div className="px-16 pt-12">
            <Button variant="outline" onClick={() => void showMore()} disabled={moreBusy || offline || stale}>
              {moreBusy ? <Spinner label="Loading more" /> : null}
              Show more
            </Button>
          </div>
        ) : null}
        {moreError ? <MeetingsError error={moreError} offline={offline} onRetry={() => void showMore()} /> : null}
      </>
    );
  }

  return (
    <div>
      {running ? <RunningLine meeting={running} filters={filters} /> : null}
      <div className="px-16 @md:max-w-560">
        <label htmlFor={searchId} className="sr-only">
          Search meetings
        </label>
        <input
          id={searchId}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search meetings"
          maxLength={MEETING_LIMITS.search}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          disabled={offline}
          className={INPUT}
        />
      </div>
      {todos && (chips.length > 0 || filters.project) ? (
        <div data-scroll-x role="group" aria-label="Filter by project" className="no-scrollbar mt-12 flex gap-6 overflow-x-auto px-16 @md:flex-wrap @md:overflow-visible">
          <Chip pressed={!filters.project} disabled={offline} onClick={() => go({ ...filters, project: undefined })}>
            All
          </Chip>
          {chips.map((p) => (
            <Chip
              key={p.id}
              pressed={filters.project === p.id}
              disabled={offline}
              onClick={() => go({ ...filters, project: filters.project === p.id ? undefined : p.id })}
            >
              {projectText(p)}
            </Chip>
          ))}
          <Chip pressed={filters.project === 'none'} disabled={offline} onClick={() => go({ ...filters, project: filters.project === 'none' ? undefined : 'none' })}>
            No project
          </Chip>
        </div>
      ) : null}
      <div className={clsx('mt-12', stale && list.loading && 'opacity-60')} aria-busy={stale && list.loading ? true : undefined}>
        {/* The list stays while a reload fails; a lost connection is the shell's banner, not said twice. */}
        {data && list.error && !offline && !isApiError(list.error, 'network') ? <MeetingsError error={list.error} onRetry={list.reload} /> : null}
        {body}
      </div>
    </div>
  );
}
