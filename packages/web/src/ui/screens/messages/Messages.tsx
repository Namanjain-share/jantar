/**
 * 0.15 Messages (`/messages`): this morning's run from his WhatsApp, the
 * place the morning push opens. `?view=settings` is its settings
 * (MessagesSettings.tsx).
 *
 *   Messages                                     ⚙ (Settings)
 *   WhatsApp data up to Fri 07:58               or the stale warning
 *   Messages can't read WhatsApp right now: …   the reader's problem, if any
 *   Last run Fri 08:00 · 12 chats · 140 messages · 3 calls
 *   WhatsApp calls weren't read.                its notes, if any (runNotes)
 *   [ Run now ]  Undo this morning              Undo asks first
 *   SUMMARY            the model's, as text
 *   WAITING ON YOU 2   DraftRow: Copy, Open in WhatsApp (a 1:1 with a
 *                      number), Done, Dismiss (5 s Undo)
 *   CALL BACK 1        CallbackRow: opens its Life todo
 *   TODOS MADE 3       each opens its Life todo
 *
 * The lines at the top are the newest run's; the summary, Todos made and
 * Undo are the runs that made them (Today's `made`: each run of the Life
 * zone's day that made something, so an empty or failed later run never
 * hides the morning's, and a later Run now never takes its Undo), else the
 * newest run's. With more than one, each summary is under its time and
 * each Undo names its run ("Undo the 08:00 run").
 *
 * Sections are cards in columns from a pane of 640 (Columns), rails below.
 * Data comes over REST, again on lifeTick (the run's todos are Life's) and
 * on coming back into view; while a run is going (the timer's), every 10 s.
 * Run now waits for the run (it can take minutes) and shows its report.
 * Nothing here sends anything: a draft goes out only when he opens it in
 * WhatsApp and presses send there. Every word from WhatsApp or the model is
 * text, never markup.
 */
import { CaretRightIcon, GearSixIcon, WarningIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Todo } from '@jantar/protocol';
import type { Draft, MessagesTodayResponse, MorningRun } from '@jantar/protocol/messages';
import { routePath, type MessagesView } from '../../../lib/router.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Columns, useCardWidth } from '../../kit/Columns.js';
import { Panel } from '../../kit/Panel.js';
import { Spinner } from '../../kit/Spinner.js';
import { useFeatures } from '../../shell/data.js';
import { Link } from '../../shell/Link.js';
import { CommandSentence, LifeLoading, NotSaved } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { Page, useOffline, useUndo, useWrite } from '../life/today/parts.js';
import { CallbackRow } from './CallbackRow.js';
import { DraftRow } from './DraftRow.js';
import { MessagesSettings } from './MessagesSettings.js';
import { NO_RUN, RUNNING, RUNNING_POLL_MS, canUndo, dueText, freshness, plural, readerLine, runLine, runNotes, runWhen, undoWords } from './model.js';
import { MessagesError, useMessages } from './parts.js';

export interface MessagesProps {
  view?: MessagesView | undefined;
}

export function Messages({ view }: MessagesProps) {
  return view === 'settings' ? <MessagesSettings /> : <MessagesToday />;
}

const SETTINGS = routePath({ name: 'messages', view: 'settings' });

function SettingsLink() {
  return (
    <Link
      href={SETTINGS}
      aria-label="Messages settings"
      title="Messages settings"
      className="inline-flex size-28 flex-none items-center justify-center rounded-btn text-ink-2 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink coarse:size-44"
    >
      <GearSixIcon size={20} aria-hidden="true" />
    </Link>
  );
}

const without = (s: ReadonlySet<string>, id: string): ReadonlySet<string> => new Set([...s].filter((x) => x !== id));

function MessagesToday() {
  const m = useMessages();
  const { api } = useDeps();
  const offline = useOffline();
  const { life } = useFeatures();
  const { status: lifeStatus } = useLifeStatus();
  const tz = lifeStatus?.timezone;
  const load = useLifeLoad('messages:today', () => m.today());
  const status = useLifeLoad('messages:status', () => m.status());
  const run = load.data?.run ?? null;
  // Today's runs that made something, each with its Undo; the summaries and todos shown (else the newest run's).
  const made = load.data?.made ?? [];
  const shown = made.length > 0 ? made : run ? [run] : [];
  const todoIds = [...new Set(shown.flatMap((r) => r.todoIds))];
  // The todos they made, by their ids, from Life's open todos (while Todos are on).
  const todosOn = life && lifeStatus?.modules.todos === true;
  const todos = useLifeLoad(todosOn && todoIds.length > 0 ? `messages:todos:${shown.map((r) => r.id).join(',')}` : null, () => api.todosList());

  // While a run is going, ask again every 10 s (visible and online only): the run sends no tick.
  const going = run?.state === 'running';
  const { reload } = load;
  useEffect(() => {
    if (!going || offline) return;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') reload();
    }, RUNNING_POLL_MS);
    return () => clearInterval(t);
  }, [going, offline, reload]);

  const undo = useUndo();
  const draftWrite = useWrite();
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const mark = async (d: Draft, state: 'done' | 'dismissed') => {
    const r = await draftWrite.run(`${d.id}:${state}`, (k) => m.setDraft(d.id, state, k));
    if (!r.ok) return;
    setGone((g) => new Set(g).add(d.id));
    undo.show(`${state === 'done' ? 'Done' : 'Dismissed'}: ${d.chatName}`, () => {
      void draftWrite.run(`${d.id}:open`, (k) => m.setDraft(d.id, 'open', k)).then((u) => {
        if (!u.ok) return;
        setGone((g) => without(g, d.id));
        reload();
      });
    });
    reload();
  };

  const undoWrite = useWrite();
  // The run whose Undo is asking first.
  const [asking, setAsking] = useState<string | null>(null);
  // The runs Undo undid (each line says so; its button goes).
  const [undone, setUndone] = useState<ReadonlySet<string>>(() => new Set());

  const runWrite = useWrite();
  const runNow = async () => {
    const r = await runWrite.run('run', (k) => m.run(k));
    if (r.ok) {
      setUndone(new Set());
      reload();
      status.reload();
    }
  };

  const undoRun = async (id: string) => {
    const r = await undoWrite.run(`undo:${id}`, (k) => m.undo(id, k));
    if (!r.ok) return;
    setAsking(null);
    setUndone((u) => new Set(u).add(id));
    reload();
    todos.reload();
  };
  const many = made.length > 1;
  const undoable = made.filter((r) => canUndo(r) && !undone.has(r.id));
  const askingRun = asking ? (made.find((r) => r.id === asking && canUndo(r)) ?? null) : null;

  const box = useRef<HTMLDivElement>(null);
  const cards = useCardWidth(box);
  const problem = readerLine(status.data);
  const busy = runWrite.busy || going;
  const error = runWrite.error ?? undoWrite.error ?? draftWrite.error;

  let body: ReactNode;
  if (!load.data) {
    body = load.error ? <MessagesError error={load.error} offline={offline} onRetry={load.reload} /> : <LifeLoading caption="Asking the Mac…" />;
  } else {
    body = (
      <Sections today={load.data} runs={shown} todoIds={todoIds} gone={gone} tz={tz} cards={cards} todos={todos.data?.todos ?? null} offline={offline} busy={draftWrite.busy} onState={(d, s) => void mark(d, s)} />
    );
  }

  const fresh = run ? freshness(run, tz) : null;
  return (
    <Page title="Messages" aside={<SettingsLink />} undo={undo} wide>
      <div className="flex flex-col gap-4 px-16 pb-12">
        {fresh ? (
          fresh.stale ? (
            <p data-stale className="flex items-start gap-6 break-words type-small text-ink">
              <WarningIcon size={16} aria-hidden="true" className="mt-2 flex-none text-ink-2" />
              <span className="min-w-0">{fresh.text}</span>
            </p>
          ) : (
            <p className="break-words type-mono text-ink-3">{fresh.text}</p>
          )
        ) : null}
        {problem ? <CommandSentence sentence={problem} className="break-words" /> : null}
        {run ? <p className="break-words type-mono text-ink-3">{runLine(run, tz)}</p> : null}
        {/* What the run couldn't do: calls not read, Life's limit or refusal. */}
        {run
          ? runNotes(run).map((note) => (
              <p key={note} data-note className="break-words type-small text-ink-2">
                {note}
              </p>
            ))
          : null}
        {run?.state === 'failed' && run.why ? <p className="break-words type-small text-ink-2">{run.why}</p> : null}
        {going ? <p className="type-small text-ink-2">{RUNNING}</p> : null}
        {made
          .filter((r) => undone.has(r.id))
          .map((r) => (
            <p key={r.id} role="status" className="type-small text-ink-2">
              {undoWords(r, tz, many).done}
            </p>
          ))}
      </div>
      {load.data ? (
        <div data-actions className="flex flex-wrap items-center gap-8 px-16 pb-12">
          <Button variant="primary" disabled={busy || offline} onClick={() => void runNow()} className="coarse:min-w-44">
            {runWrite.busy ? <Spinner label="Running" /> : null}
            {runWrite.busy ? 'Running…' : 'Run now'}
          </Button>
          {askingRun
            ? null
            : undoable.map((r) => (
                <Button key={r.id} variant="text" disabled={offline || undoWrite.busy} onClick={() => setAsking(r.id)} className="coarse:min-w-44">
                  {undoWords(r, tz, many).label}
                </Button>
              ))}
        </div>
      ) : null}
      {askingRun ? (
        <div role="group" aria-label={undoWords(askingRun, tz, many).label} className="mx-16 mb-12 rounded-btn border border-line-strong px-12 py-8">
          <p className="type-small text-ink">{undoWords(askingRun, tz, many).ask}</p>
          <div data-actions className="mt-8 flex flex-wrap items-center gap-8">
            <Button variant="primary" disabled={offline || undoWrite.busy} onClick={() => void undoRun(askingRun.id)} className="coarse:min-w-44">
              Undo it
            </Button>
            <Button variant="text" onClick={() => setAsking(null)} className="coarse:min-w-44">
              Keep
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="px-16 pb-8">
          <NotSaved error={error} />
        </div>
      ) : null}
      <div ref={box}>
        {load.data && load.error && !offline ? <MessagesError error={load.error} onRetry={load.reload} /> : null}
        {body}
      </div>
    </Page>
  );
}

function Sections({
  today,
  runs,
  todoIds,
  gone,
  tz,
  cards,
  todos,
  offline,
  busy,
  onState,
}: {
  today: MessagesTodayResponse;
  /** The runs whose summaries show: today's that made something, else the newest. */
  runs: readonly MorningRun[];
  /** The todos those runs made. */
  todoIds: readonly string[];
  /** Drafts marked here, off the list until the next answer leaves them out (or Undo brings them back). */
  gone: ReadonlySet<string>;
  tz: string | null | undefined;
  cards: boolean;
  /** Life's open todos (null: Todos off, or not loaded). */
  todos: readonly Todo[] | null;
  offline: boolean;
  busy: boolean;
  onState: (d: Draft, state: 'done' | 'dismissed') => void;
}) {
  const { callbacks } = today;
  const drafts = today.drafts.filter((d) => !gone.has(d.id));
  if (runs.length === 0 && drafts.length === 0 && callbacks.length === 0) return <p className="px-16 py-16 type-small text-ink-2">{NO_RUN}</p>;
  const sections: ReactNode[] = [];
  const summed = runs.filter((r) => r.summary);
  if (summed.length > 0) {
    sections.push(
      <Panel key="summary" label="Summary" card={cards}>
        {summed.map((r) => (
          <div key={r.id} className="px-16 py-12">
            {summed.length > 1 ? <p className="type-mono text-ink-3">{runWhen(r, tz)}</p> : null}
            <p className="whitespace-pre-line break-words type-body text-ink-2">{r.summary}</p>
          </div>
        ))}
      </Panel>,
    );
  }
  sections.push(
    <Panel key="waiting" label="Waiting on you" count={drafts.length} card={cards}>
      {drafts.length ? (
        <ul>
          {drafts.map((d) => (
            <DraftRow key={d.id} draft={d} tz={tz} disabled={offline || busy} onState={onState} />
          ))}
        </ul>
      ) : (
        <p className="px-16 py-12 type-small text-ink-2">Nobody is waiting on a reply.</p>
      )}
    </Panel>,
    <Panel key="callbacks" label="Call back" count={callbacks.length} card={cards}>
      {callbacks.length ? (
        <ul>
          {callbacks.map((c) => (
            <CallbackRow key={c.todoId} callback={c} tz={tz} />
          ))}
        </ul>
      ) : (
        <p className="px-16 py-12 type-small text-ink-2">No calls to return.</p>
      )}
    </Panel>,
  );
  if (todoIds.length > 0) sections.push(<TodosMade key="todos" ids={todoIds} todos={todos} cards={cards} />);
  return cards ? (
    <Columns min={340} className="px-16 pt-4">
      {sections}
    </Columns>
  ) : (
    <>{sections}</>
  );
}

/** The todos this run made that are still open, each opening its Life todo; the rest counted. */
function TodosMade({ ids, todos, cards }: { ids: readonly string[]; todos: readonly Todo[] | null; cards: boolean }) {
  const open = todos ? todos.filter((t) => ids.includes(t.id)) : [];
  const rest = ids.length - open.length;
  return (
    <Panel label="Todos made" count={ids.length} card={cards}>
      {open.length ? (
        <ul>
          {open.map((t) => (
            <li key={t.id} className="border-b border-line">
              <Link href={routePath({ name: 'todos', id: t.id })} className="flex min-h-44 items-center gap-12 px-16 py-8 transition-colors duration-120 ease-hover hover:bg-hover">
                <span className="min-w-0 flex-1">
                  <span className="block break-words type-row text-ink">{t.title}</span>
                  {t.due ? <span className="block type-mono text-ink-3">{dueText(t.due)}</span> : null}
                </span>
                <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {todos === null ? (
        <p className="px-16 py-12 type-small text-ink-2">{plural(ids.length, 'todo')} in the WhatsApp project.</p>
      ) : rest > 0 ? (
        <p className="px-16 py-12 type-small text-ink-3">{plural(rest, 'other')} done or removed.</p>
      ) : null}
    </Panel>
  );
}
