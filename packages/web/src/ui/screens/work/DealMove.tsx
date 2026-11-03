/**
 * 0.13.0 Moving a deal (design 6.2 "Won and Lost", W32, W33): one way for
 * every place that moves one (a card's ··· or long press, the board's drag,
 * `m` with a keyboard, a deal's page).
 *
 *   Move to…        the stages, the one it is on ticked: a popover beside
 *                   the button that opened it on a wide screen, a bottom
 *                   sheet on a phone (kit/Popover.tsx Choice)
 *   an open stage   moves at once; "Moved to Contacted · Undo" moves it back
 *   Won             "Won · ₹4,50,000. Make a project for it?" with its name
 *                   and the client's folder filled in: Make project, or Not
 *                   now (Won without one); its open follow-ups each with a
 *                   Mark done tick (off)
 *   Lost            why, from eight reasons, and a note: Save or Skip; its
 *                   open follow-ups each with Mark done (on). A lost deal's
 *                   reason can be changed later (`edit`).
 *
 * A move is one save (`POST /v1/work/deals/:id/move`): Won makes the
 * project in it, or neither happens. The follow-ups ticked done are marked
 * after it, one by one.
 */
import { CheckIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Todo } from '@jantar/protocol';
import type { WorkDealHub, WorkLostCode, WorkStageKind } from '@jantar/protocol/work';
import { errorText } from '../../../lib/api.js';
import { formatAmount } from '../../../lib/money.js';
import { useApp, useDeps, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Choice } from '../../kit/Popover.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { NotSaved } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useSheet, useWrite, type Undo } from '../life/today/parts.js';
import { sessionFolders } from '../life/todos/model.js';
import { workClient } from './client.js';
import { LOST_REASONS, moveStep } from './dealModel.js';
import { Chips, SaveError } from './parts.js';

/** A stage as a move names it. */
export interface StageRef {
  id: string;
  name: string;
  kind: WorkStageKind;
}

/** The deal being moved: what the sheets say and what Undo needs. */
export interface MoveDeal {
  id: string;
  title: string;
  stage: string;
  value?: number | undefined;
  currency: string | null;
  client: { id: string; name: string };
  lostCode?: WorkLostCode | undefined;
}

type Asking = { deal: MoveDeal; stage: StageRef; edit?: boolean };

/**
 * The move flow: `choose` opens Move to… (beside `anchor`), `to` moves straight to a stage (a drop), `lost`
 * opens the Lost sheet to change a lost deal's reason. `element` holds its popover and sheets.
 */
export function useDealMove({ stages, undo, onMoved }: { stages: readonly StageRef[]; undo: Undo; onMoved: () => void }) {
  const { api } = useDeps();
  const w = useMemo(() => workClient(api), [api]);
  const toast = useToast();
  const offline = useOffline();
  const anchor = useRef<HTMLElement | null>(null);
  const [choosing, setChoosing] = useState<MoveDeal | null>(null);
  const won = useSheet<Asking>();
  const lost = useSheet<Asking>();
  const [busy, setBusy] = useState(false);
  const { show } = undo;

  /** An open stage: at once, then Undo moves it back (a lost deal back with its reason). */
  const moveOpen = useCallback(
    async (deal: MoveDeal, to: StageRef) => {
      setBusy(true);
      try {
        const r = await w.dealMove(deal.id, { stage: to.id });
        onMoved();
        const back = stages.find((s) => s.id === r.from);
        show(`Moved to ${to.name}`, () => {
          void w
            .dealMove(deal.id, { stage: r.from, ...(back?.kind === 'lost' && deal.lostCode ? { lostCode: deal.lostCode } : {}) })
            .then(onMoved, (e: unknown) => toast(`Not moved back. ${errorText(e)}`, 'error'));
        });
      } catch (e) {
        toast(`Not moved. ${errorText(e)}`, 'error');
      } finally {
        setBusy(false);
      }
    },
    [w, stages, onMoved, show, toast],
  );

  const to = useCallback(
    (deal: MoveDeal, stageId: string) => {
      const stage = stages.find((s) => s.id === stageId);
      if (!stage || offline || busy) return;
      const step = moveStep(deal.stage, stage);
      if (step === 'open') void moveOpen(deal, stage);
      else if (step === 'won') won.show({ deal, stage });
      else if (step === 'lost') lost.show({ deal, stage });
    },
    [stages, offline, busy, moveOpen, won.show, lost.show],
  );

  const choose = useCallback((deal: MoveDeal, at: HTMLElement | null) => {
    anchor.current = at;
    setChoosing(deal);
  }, []);

  const editLost = useCallback(
    (deal: MoveDeal) => {
      const stage = stages.find((s) => s.id === deal.stage);
      if (stage) lost.show({ deal, stage, edit: true });
    },
    [stages, lost.show],
  );

  const element = (
    <>
      <Choice open={choosing !== null} onOpenChange={(o) => (o ? undefined : setChoosing(null))} title="Move to" anchor={anchor}>
        <div role="radiogroup" aria-label="Stages" className="pb-16">
          {stages.map((s) => {
            const here = s.id === choosing?.stage;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={here}
                disabled={offline || busy}
                className="flex min-h-44 w-full items-center gap-12 border-b border-line px-4 text-left type-row text-ink transition-colors duration-120 ease-hover hover:bg-hover disabled:text-ink-3"
                onClick={() => {
                  const deal = choosing;
                  setChoosing(null);
                  if (deal) to(deal, s.id);
                }}
              >
                <span className={clsx('flex-1', here && 'font-medium')}>{s.name}</span>
                {s.kind !== 'open' && !here ? <span className="type-mono text-ink-3">{s.kind === 'won' ? 'asks about a project' : 'asks why'}</span> : null}
                {here ? <CheckIcon size={16} aria-hidden="true" className="text-ink-2" /> : null}
              </button>
            );
          })}
        </div>
        {offline ? <OfflineLine className="pb-12" /> : null}
      </Choice>
      <Sheet open={won.open} onOpenChange={won.onOpenChange} title={won.item ? wonTitle(won.item.deal) : 'Won'}>
        {won.open && won.item ? <WonForm key={won.key} deal={won.item.deal} stage={won.item.stage} undo={undo} onMoved={onMoved} onDone={won.close} /> : null}
      </Sheet>
      <Sheet open={lost.open} onOpenChange={lost.onOpenChange} title={lost.item?.edit ? 'Why it was lost' : `Lost · ${lost.item?.deal.title ?? ''}`}>
        {lost.open && lost.item ? <LostForm key={lost.key} asking={lost.item} undo={undo} onMoved={onMoved} onDone={lost.close} /> : null}
      </Sheet>
    </>
  );
  return { choose, to, editLost, busy, element };
}

/** The deal's open follow-ups, each with a Mark done tick (W33's sheets). */
function FollowUpTicks({ todos, ticked, onTick }: { todos: readonly Todo[]; ticked: ReadonlySet<string>; onTick: (id: string, on: boolean) => void }) {
  if (!todos.length) return null;
  return (
    <fieldset className="mt-8 min-w-0 border-t border-line pt-8">
      <legend className="type-rail text-ink-3">Its follow-ups</legend>
      <ul className="mt-4">
        {todos.map((t) => (
          <li key={t.id}>
            <label className="flex min-h-44 cursor-pointer items-center gap-12 type-row text-ink">
              <input type="checkbox" className="size-20 flex-none accent-ink" checked={ticked.has(t.id)} onChange={(e) => onTick(t.id, e.target.checked)} />
              <span className="min-w-0 flex-1 truncate">Mark done: {t.title}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** One deal's hub while a sheet is open (its open follow-ups, its project, its reason). */
function useDealHub(id: string) {
  const { api } = useDeps();
  return useLifeLoad<WorkDealHub>(`work:deal:${id}:move`, () => workClient(api).deal(id));
}

/** The follow-ups ticked done, marked after the move; a failure is said, the move stands. */
function useMarkDone() {
  const { api } = useDeps();
  const toast = useToast();
  return async (ids: readonly string[]) => {
    let failed = 0;
    for (const id of ids) {
      try {
        await api.todoDone(id, true);
      } catch {
        failed++;
      }
    }
    if (failed) toast(`${failed} ${failed === 1 ? 'follow-up was' : 'follow-ups were'} not marked done. Try again from the client.`, 'error');
  };
}

/** The ticks over `todos`: all on or all off until he changes one (the list may load after the sheet opens). */
function useTicks(todos: readonly Todo[], on: boolean) {
  const [set, setSet] = useState<ReadonlySet<string> | null>(null);
  const ticked = set ?? new Set(on ? todos.map((t) => t.id) : []);
  const onTick = (id: string, v: boolean) => {
    const n = new Set(ticked);
    if (v) n.add(id);
    else n.delete(id);
    setSet(n);
  };
  return { ticked, onTick };
}

/** W33's title: "Won · ₹4,50,000". */
function wonTitle(deal: MoveDeal): string {
  return deal.value !== undefined ? `Won · ${formatAmount(deal.value, deal.currency)}` : 'Won';
}

function WonForm({ deal, stage, undo, onMoved, onDone }: { deal: MoveDeal; stage: StageRef; undo: Undo; onMoved: () => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const toast = useToast();
  const write = useWrite();
  const id = useId();
  const hub = useDealHub(deal.id);
  const client = useLifeLoad(`work:client:${deal.client.id}:won`, () => workClient(api).client(deal.client.id));
  const sessions = useApp((s) => s.state.sessions);
  const [name, setName] = useState(deal.title.slice(0, 80));
  const [folder, setFolder] = useState<string | null>(null);
  const markDone = useMarkDone();
  const own = client.data?.contact.folder;
  const folders = useMemo(() => {
    const list = sessionFolders(Object.values(sessions));
    return own && !list.includes(own) ? [own, ...list] : list;
  }, [sessions, own]);
  // The client's folder until he picks another (or none).
  const chosen = folder ?? own ?? '';
  const hasProject = Boolean(hub.data?.project);
  const followUps = hub.data?.followUps ?? [];
  // Won: none ticked done until he ticks one (the work may go on).
  const ticks = useTicks(followUps, false);

  const save = async (withProject: boolean) => {
    if (offline || write.busy) return;
    const body = { stage: stage.id, ...(withProject && name.trim() ? { project: { name: name.trim(), ...(chosen ? { folder: chosen } : {}) } } : {}) };
    const r = await write.run(JSON.stringify(body), (key) => workClient(api).dealMove(deal.id, body, key));
    if (!r.ok) return;
    await markDone([...ticks.ticked]);
    onMoved();
    onDone();
    const from = r.value.from;
    if (r.value.projectId) toast(`Won. Made the project ${name.trim()}.`);
    else undo.show(`Moved to ${stage.name}`, () => void workClient(api).dealMove(deal.id, { stage: from }).then(onMoved, (e: unknown) => toast(`Not moved back. ${errorText(e)}`, 'error')));
  };

  return (
    <form
      aria-label="Won"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save(!hasProject);
      }}
    >
      {hub.loading && !hub.data ? <Spinner label="Loading" /> : null}
      {hasProject ? (
        <p className="type-small text-ink-2">Its project is {hub.data?.project?.name}. Won makes {deal.client.name} a client.</p>
      ) : (
        <>
          <p className="type-small text-ink-2">Make a project for it? Won makes {deal.client.name} a client either way.</p>
          <Field label="Name" htmlFor={`${id}-name`}>
            <input id={`${id}-name`} className={INPUT} value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Folder" htmlFor={`${id}-folder`}>
            <select id={`${id}-folder`} className={INPUT} value={chosen} onChange={(e) => setFolder(e.target.value)}>
              <option value="">None</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f === own ? `${f} (the client's)` : f}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <FollowUpTicks todos={followUps} ticked={ticks.ticked} onTick={ticks.onTick} />
      {write.error ? <SaveError error={write.error} /> : null}
      <SheetActions>
        {hasProject ? (
          <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={offline || write.busy}>
            {write.busy ? <Spinner label="Saving" /> : null}
            Mark as won
          </Button>
        ) : (
          <>
            <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={offline || write.busy || !name.trim()}>
              {write.busy ? <Spinner label="Saving" /> : null}
              Make project
            </Button>
            <Button size="lg" disabled={offline || write.busy} onClick={() => void save(false)}>
              Not now
            </Button>
          </>
        )}
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}

/** W33: why it was lost (eight reasons and a note), Save or Skip; or, for a lost deal, its reason changed. */
function LostForm({ asking, undo, onMoved, onDone }: { asking: Asking; undo: Undo; onMoved: () => void; onDone: () => void }) {
  const { deal, stage, edit = false } = asking;
  const { api } = useDeps();
  const offline = useOffline();
  const toast = useToast();
  const write = useWrite();
  const id = useId();
  const hub = useDealHub(deal.id);
  const [code, setCode] = useState<WorkLostCode | null>(deal.lostCode ?? null);
  const [note, setNote] = useState<string | null>(null);
  const markDone = useMarkDone();
  const followUps = edit ? [] : (hub.data?.followUps ?? []);
  // Lost: every follow-up ticked done until he unticks one.
  const ticks = useTicks(followUps, true);
  const shownNote = note ?? hub.data?.deal.lostNote ?? '';

  const save = async (skip: boolean) => {
    if (offline || write.busy) return;
    if (edit) {
      const patch = { lostCode: code, lostNote: shownNote.trim() ? shownNote.trim() : null };
      const r = await write.run(JSON.stringify(patch), (key) => workClient(api).dealUpdate(deal.id, patch, key));
      if (!r.ok) return;
      onMoved();
      onDone();
      return;
    }
    const body = { stage: stage.id, ...(!skip && code ? { lostCode: code } : {}), ...(!skip && shownNote.trim() ? { lostNote: shownNote.trim() } : {}) };
    const r = await write.run(JSON.stringify(body), (key) => workClient(api).dealMove(deal.id, body, key));
    if (!r.ok) return;
    await markDone([...ticks.ticked]);
    onMoved();
    onDone();
    const from = r.value.from;
    undo.show(`Moved to ${stage.name}`, () => void workClient(api).dealMove(deal.id, { stage: from }).then(onMoved, (e: unknown) => toast(`Not moved back. ${errorText(e)}`, 'error')));
  };

  return (
    <form
      aria-label={edit ? 'Why it was lost' : 'Lost'}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <Field label="Why">
        <Chips<WorkLostCode> label="Why it was lost" chips={LOST_REASONS} value={code} onChange={setCode} clearable />
      </Field>
      <Field label="Note" htmlFor={`${id}-note`}>
        <textarea id={`${id}-note`} className={TEXTAREA} rows={2} maxLength={200} value={shownNote} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <FollowUpTicks todos={followUps} ticked={ticks.ticked} onTick={ticks.onTick} />
      {hub.error && !hub.data ? <NotSaved error={hub.error} /> : null}
      {write.error ? <SaveError error={write.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={offline || write.busy}>
          {write.busy ? <Spinner label="Saving" /> : null}
          Save
        </Button>
        {edit ? null : (
          <Button size="lg" disabled={offline || write.busy} onClick={() => void save(true)}>
            Skip
          </Button>
        )}
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}

/** A deal as the move flow takes it, from a card or a hub. */
export function moveDeal(card: { id: string; title: string; stage: string; value?: number | undefined; currency: string | null; client: { id: string; name: string }; lostCode?: WorkLostCode | undefined }): MoveDeal {
  return { id: card.id, title: card.title, stage: card.stage, value: card.value, currency: card.currency, client: { id: card.client.id, name: card.client.name }, lostCode: card.lostCode };
}

export type MoveFlow = ReturnType<typeof useDealMove>;
