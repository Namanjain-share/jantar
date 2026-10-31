/**
 * One meeting (v0.5 spec 5.3, `/meetings?id=<id>`, over the list):
 *
 *   ‹ Meetings
 *   Weekly sync                                 ···   Edit, Export text, Delete
 *   Thu 30 Oct · 10:00 to 10:42 · Google Meet         mono --ink-3
 *   Acme site · Sam, Priya                            --ink-2
 *   SUMMARY        the text, or its state's sentence (and Summarize or Try again)
 *   DECISIONS      one row each, once the summary is done
 *   ACTION ITEMS   ItemRow: Add to <project>, or ✓ In todos · Remove
 *   TRANSCRIPT     turns, with each screenshot at its time
 *
 * Over REST, again on lifeTick and on coming back into view; while the
 * meeting is open, every 10 s while visible too (caption lines send no
 * tick). Remove holds the todo's removal under the screen's one Undo, and
 * the item shows removed until the Undo ends, on this page or on one opened
 * again meanwhile; Delete leaves for the list at once and is held there. A
 * tap the Mac took shows as taken until the meeting comes back saying so,
 * so it cannot be sent twice. Everything the meeting says is a text node:
 * `**` in a summary shows as typed. The title is the page's <h1> in every
 * state ("Meetings" until the meeting is here).
 */
import { CaretLeftIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CLI_NAME, type Meeting, type MeetingDetail, type MeetingShot, type ProjectView } from '@jantar/protocol';
import { isApiError } from '../../../lib/api.js';
import { useDeps, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Link } from '../../shell/Link.js';
import { LifeLoading, NotSaved } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { Page, RowMenu, useOffline, useSheet, useWrite, type Undo } from '../life/today/parts.js';
import { EditSheet } from './EditSheet.js';
import { exportText } from './export.js';
import { ItemRow } from './ItemRow.js';
import {
  AFTER_END,
  EXPORTED,
  EXPORTED_MS,
  GONE,
  NO_LINES_YET,
  NO_NOTES,
  REMOVED,
  WRITING,
  addLabel,
  linesText,
  meetingWhen,
  meetingWho,
  meetingsPath,
  shotsText,
  summaryView,
  type MeetingFilters,
  type SummaryView,
} from './model.js';
import { usePoll } from './poll.js';
import { ShotViewer, type ShotView } from './ShotViewer.js';
import { MeetingsError } from './states.js';
import { Transcript } from './Transcript.js';

export interface MeetingPageProps {
  id: string;
  filters: MeetingFilters;
  /** The screen's one Undo line (the list's too). */
  undo: Undo;
  /** What this page's taps did that the meeting does not say yet, kept beside `undo`. */
  marks: ItemMarks;
  /** Todos are on: the project and the Add and Remove buttons show. */
  todos: boolean;
  projects: readonly ProjectView[];
  /** Delete from the page's menu: the screen goes back to the list and holds it there. */
  onDelete: (meeting: Meeting) => void;
  /** A held delete that failed while this page shows ("Not saved"). */
  notice?: ReactNode;
}

function Back({ filters }: { filters: MeetingFilters }) {
  return (
    <Link href={meetingsPath(filters)} className="inline-flex h-44 items-center gap-4 px-8 type-small text-ink-2 transition-colors duration-120 ease-hover hover:text-ink">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Meetings
    </Link>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="mt-16">
      <RailLabel ground="bg">{label}</RailLabel>
      {children}
    </section>
  );
}

function SummaryBody({ view, action, busy, offline }: { view: SummaryView; action: () => void; busy: boolean; offline: boolean }) {
  const say = (text: string) => <p className="type-small text-ink-2">{text}</p>;
  const button = (label: string) => (
    <Button size="sm" className="mt-12" disabled={busy || offline} onClick={action}>
      {label}
    </Button>
  );
  switch (view.kind) {
    case 'open':
      return say(AFTER_END);
    case 'writing':
      return say(WRITING);
    case 'done':
      return <p className="whitespace-pre-wrap break-words type-body text-ink">{view.text}</p>;
    case 'failed':
      return (
        <>
          {say(view.reason)}
          {button('Try again')}
        </>
      );
    case 'none':
      return (
        <>
          {say(view.reason)}
          {button('Summarize')}
        </>
      );
    case 'no-notes':
      return say(NO_NOTES);
  }
}

/**
 * An action item a page changed before its meeting says so: added (until
 * it comes back with the todo), a Remove held under Undo, or a Remove sent
 * (until it comes back without the todo).
 */
type Mark = 'added' | 'held' | 'sent';
type Marks = ReadonlyMap<number, Mark>;
const NO_MARKS: Marks = new Map();

/**
 * The marks of every meeting, kept by the screen beside its one Undo: a
 * Remove held on a page that was left (its Undo line goes with the list)
 * still shows on that meeting's page opened again before it ends.
 */
export function useItemMarks() {
  const [all, setAll] = useState<ReadonlyMap<string, Marks>>(() => new Map());
  const update = useCallback(
    (id: string, fn: (cur: Marks) => Marks) =>
      setAll((cur) => {
        const before = cur.get(id) ?? NO_MARKS;
        const after = fn(before);
        if (after === before) return cur;
        const next = new Map(cur);
        if (after.size > 0) next.set(id, after);
        else next.delete(id);
        return next;
      }),
    [],
  );
  return useMemo(() => ({ of: (id: string) => all.get(id) ?? NO_MARKS, update }), [all, update]);
}

export type ItemMarks = ReturnType<typeof useItemMarks>;

interface BodyProps extends Omit<MeetingPageProps, 'id'> {
  d: MeetingDetail;
  /** A reload that failed while the meeting stays on screen. */
  error: ReactNode;
  reload: () => void;
}

function Body({ d, filters, undo, marks: itemMarks, todos, projects, onDelete, notice, error, reload }: BodyProps) {
  const { api } = useDeps();
  const offline = useOffline();
  const now = useNow(60_000);
  const m = d.meeting;
  const edit = useSheet<null>();
  const summarize = useWrite();
  const items = useWrite();
  const marks = itemMarks.of(m.id);
  const { update } = itemMarks;
  // The meeting as it was when Summarize was taken: "Writing the summary…" until any newer answer
  // (each is a new object), which says queued, or failed already when the run could not start.
  const [askedOf, setAskedOf] = useState<MeetingDetail | null>(null);
  const view: SummaryView = askedOf === d ? { kind: 'writing' } : summaryView(d);
  const [shot, setShot] = useState<ShotView | null>(null);
  // "Text exported" for EXPORTED_MS; a new export starts the time again.
  const [exported, setExported] = useState(0);
  const who = meetingWho(m);

  useEffect(() => {
    if (!exported) return;
    const t = setTimeout(() => setExported(0), EXPORTED_MS);
    return () => clearTimeout(t);
  }, [exported]);

  // An add or a removal the Mac has done is over once the meeting comes back saying so.
  useEffect(() => {
    update(d.meeting.id, (cur) => {
      const left = [...cur].filter(([n, s]) => {
        const item = d.summary.items[n];
        return s === 'held' || (s === 'sent' ? Boolean(item?.todoId) : item !== undefined && !item.todoId);
      });
      return left.length === cur.size ? cur : new Map(left);
    });
  }, [d, update]);

  // A Remove's commit can run after this page is left: the marks are the screen's, and a page
  // opened again meanwhile hears of the removal from Life's tick.
  const mark = (n: number, s: Mark | null) =>
    update(m.id, (cur) => {
      const next = new Map(cur);
      if (s) next.set(n, s);
      else next.delete(n);
      return next;
    });

  const add = async (n: number) => {
    // Add while its Remove waits under Undo takes the Remove back: the todo is still there.
    if (marks.get(n) === 'held') {
      undo.take();
      return;
    }
    const r = await items.run(`todo:${m.id}:${n}`, (key) => api.meetingItemTodo(m.id, n, key));
    if (!r.ok) return;
    mark(n, 'added');
    reload();
  };

  const remove = (n: number) => {
    // Undone or refused, an item just added stays added until the meeting says so.
    const before = marks.get(n) === 'added' ? 'added' : null;
    mark(n, 'held');
    undo.show(
      REMOVED,
      () => mark(n, before),
      () => {
        mark(n, 'sent');
        void items.run(`untodo:${m.id}:${n}`, (key) => api.meetingItemUntodo(m.id, n, key)).then((r) => {
          if (r.ok) reload();
          else mark(n, before);
        });
      },
    );
  };

  const runSummary = async () => {
    const r = await summarize.run(`summary:${m.id}`, (key) => api.meetingSummarize(m.id, key));
    if (!r.ok) return;
    setAskedOf(d);
    reload();
  };

  const exportIt = async () => {
    if ((await exportText(d)) !== 'cancelled') setExported((n) => n + 1);
  };

  const menu = (
    <RowMenu
      label={`Actions for ${m.name}`}
      groups={[
        {
          items: [
            { label: 'Edit', onSelect: () => edit.show(null), disabled: offline },
            { label: 'Export text', onSelect: () => void exportIt() },
            { label: 'Delete', onSelect: () => onDelete(m), disabled: offline },
          ],
        },
      ]}
    />
  );
  const done = d.summary.state === 'done';
  // The name wraps here (Page's <h1> cuts to one line): a long Teams title shows in full nowhere else.
  const title = <span className="whitespace-normal break-words">{m.name}</span>;

  return (
    <Page title={title} back={<Back filters={filters} />} aside={menu} undo={undo}>
      {notice}
      {error}
      <p className="px-16 type-mono text-ink-3">{meetingWhen(m, now)}</p>
      {who ? <p className="mt-2 break-words px-16 type-small text-ink-2">{who}</p> : null}
      {m.endedAt === null ? (
        <p className="mt-8 flex items-center gap-6 px-16 type-mono text-ink-3">
          <i aria-hidden="true" className="block size-6 flex-none bg-jup" />
          <span>
            Running · {linesText(m.lines)} · {shotsText(m.shots)}
          </span>
        </p>
      ) : null}
      {exported ? (
        <p role="status" className="mt-8 px-16 type-small text-ink-2">
          {EXPORTED} <code className="type-mono text-ink">{CLI_NAME} meetings export {m.id}</code> at your Mac
        </p>
      ) : null}

      <Section label="Summary">
        <div className="px-16 py-12">
          {/* Writing, written or failed: said to a screen reader as it changes. */}
          <div role="status">
            <SummaryBody view={view} action={() => void runSummary()} busy={summarize.busy} offline={offline} />
          </div>
          {summarize.error ? <NotSaved error={summarize.error} /> : null}
        </div>
      </Section>

      {done && d.summary.decisions.length > 0 ? (
        <Section label="Decisions">
          <ul>
            {d.summary.decisions.map((x, i) => (
              <li key={i} className="break-words border-b border-line px-16 py-8 type-row text-ink">
                {x}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {done && d.summary.items.length > 0 ? (
        <Section label="Action items">
          {items.error ? (
            <div className="px-16">
              <NotSaved error={items.error} />
            </div>
          ) : null}
          <ul>
            {d.summary.items.map((item, n) => (
              <ItemRow
                key={n}
                item={item}
                addLabel={addLabel(m)}
                todos={todos}
                inTodos={marks.has(n) ? marks.get(n) === 'added' : Boolean(item.todoId)}
                disabled={offline || items.busy || marks.get(n) === 'sent'}
                onAdd={() => void add(n)}
                onRemove={() => remove(n)}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {d.lines.length > 0 || d.shots.length > 0 ? (
        <Section label="Transcript">
          <Transcript meetingId={m.id} lines={d.lines} shots={d.shots} onOpenShot={(s: MeetingShot, blob) => setShot({ shot: s, blob })} />
        </Section>
      ) : m.endedAt === null && m.notes ? (
        <Section label="Transcript">
          <p className="px-16 py-12 type-small text-ink-2">{NO_LINES_YET}</p>
        </Section>
      ) : null}

      <EditSheet open={edit.open} onOpenChange={edit.onOpenChange} sheetKey={edit.key} detail={d} projects={projects} todos={todos} onSaved={reload} />
      <ShotViewer meetingId={m.id} view={shot} onClose={() => setShot(null)} />
    </Page>
  );
}

export function MeetingPage({ id, filters, undo, marks, todos, projects, onDelete, notice }: MeetingPageProps) {
  const { api } = useDeps();
  const offline = useOffline();
  const load = useLifeLoad(`meeting:${id}`, () => api.meetingGet(id));
  const gone = isApiError(load.error, 'not_found');
  const d = gone ? null : load.data;
  usePoll(d !== null && d.meeting.endedAt === null, load.reload);

  if (d) {
    // The meeting stays while a reload fails; a lost connection is the shell's banner, not said twice.
    const say = load.error && !offline && !isApiError(load.error, 'network');
    return (
      <Body
        d={d}
        filters={filters}
        undo={undo}
        marks={marks}
        todos={todos}
        projects={projects}
        onDelete={onDelete}
        notice={notice}
        error={say ? <MeetingsError error={load.error} onRetry={load.reload} /> : null}
        reload={load.reload}
      />
    );
  }
  return (
    <Page title="Meetings" back={<Back filters={filters} />} undo={undo}>
      {notice}
      {gone ? (
        <p className="px-16 py-16 type-small text-ink-2">{GONE}</p>
      ) : load.error ? (
        <MeetingsError error={load.error} offline={offline} onRetry={load.reload} />
      ) : (
        <LifeLoading count={3} />
      )}
    </Page>
  );
}
