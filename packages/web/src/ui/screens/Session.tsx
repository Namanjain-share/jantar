/**
 * One session (direction.md 5.2): header with the glyph, folder and name,
 * "1 / N" steppers and Show on Mac; the mono meta line (or, at 1360 px and
 * wider, the property column); Transcript | Screen tabs (?view=screen); and
 * at the bottom either the decision dock, the receipt after answering, or
 * the composer. A phone shows the dock as a bottom sheet that folds to a
 * 56 px peek.
 *
 * The pieces live in ./session/. The decision, two-tap and send-stage logic
 * are v0.1's, re-skinned (session/decide.ts, TwoTap.tsx, sends.ts).
 *
 * v0.3 slots, each shown only while its switch is on (useFeatures): a Files
 * tab (?view=files&root=&path=&tab=, session/FilesTab.tsx), the control bar
 * with its mode chip above the bottom block (session/controls/), the Screen
 * tab's Picture | Text switch (session/controls/ShotView.tsx), and the
 * composer's Rewrite button (in Composer.tsx). Their components belong to
 * the v0.3 work packages; this screen only places them.
 *
 * v0.4.2: one read of the terminal per session screen (session/screen.ts)
 * feeds the dock for a dialog with no hook card (session/TermDialog.tsx),
 * where v0.4.1's WaitingCard was, and the Screen tab's text. Below a hook
 * card and its receipt, the dock shows when Claude has waited for
 * SCREEN_PATH_SETTLE_MS (time for a hook card to arrive first), when a
 * subagent card is open, or when the latest read parsed a dialog, in any
 * status but ended. The control bar hides while the dock shows: every key
 * there is refused while a dialog waits.
 *
 * v0.6 (Fleet): a paired machine's session says where it runs under the
 * header ("build-1 · Linux · tmux"), reads its account and switches from
 * its own machine (no Picture, Files or Rewrite there), and offers the
 * composer, keypad and control bar only while Jantar can type into it
 * (`canType`); otherwise the one fixed line for why (not in tmux, Windows
 * watch-only, a watch-only machine, offline). Show on Mac shows only where
 * there is a Terminal window to raise. Its cards are headed with the
 * machine's name and are off while it is offline or watch-only. Every call
 * stays keyed by the session or card: the Mac knows where it runs. A
 * session of the Mac's own looks as before.
 *
 * v0.6.1: a session waiting on work it started in the background says so in
 * one mono line under the header ("1 workflow running · demo-sweep · 52m",
 * then the quiet "6 shells"), and its glyph reads working until it ends.
 *
 * The hook cards (session/Permission.tsx, Plan.tsx, Question.tsx) load
 * with import() the first time one shows (v0.6: the first load's room for
 * Fleet); until one arrives the dock says what it is with a spinner. A
 * card or dialog dock whose chunk is gone (a page left open across an
 * update: the new service worker drops the old build's files) says so,
 * with Reload, instead of leaving the screen blank.
 */
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  machineName,
  machineOf,
  pendingFor,
  sessionAccount,
  sessionFeatures,
  shownStatus,
  typeRefusal,
  typeRefusalText,
  type Session,
} from '@jantar/protocol';
import { errorText } from '../../lib/api.js';
import { screenTitle } from '../../lib/favicon.js';
import { ago } from '../../lib/format.js';
import { closeNotificationsFor } from '../../lib/push.js';
import { sessionView, sessionViewPath, type FilesLocation } from '../../lib/router.js';
import { useApp, useDeps, useMedia, useNavigate, useNow, useToast } from '../context.js';
import { Button } from '../kit/Button.js';
import { EmptyState } from '../kit/EmptyState.js';
import { glyphStateOf } from '../kit/glyph.js';
import { SkeletonRows } from '../kit/Skeleton.js';
import { Spinner } from '../kit/Spinner.js';
import { Tag } from '../kit/Tag.js';
import { useCeiling, useFeatures } from '../shell/data.js';
import { useFrame } from '../shell/layout.js';
import { backgroundLine } from './board/model.js';
import { Composer, carriesFiles } from './session/Composer.js';
import { ControlBar } from './session/controls/ControlBar.js';
import { ModeChip } from './session/controls/ModeChip.js';
import { FilesTab } from './session/FilesTab.js';
import { takeAsk } from './session/ask.js';
import { answeredBy, type Receipt } from './session/decide.js';
import { DockFrame, isLate } from './session/DockFrame.js';
import { Header, PANEL_ID, TAB_ID, Tabs, type View } from './session/Header.js';
import { cardMachine, hasMachines, machineLine, offlineStatus, screenReadable, SubagentAsk, subagentTitle } from './session/Info.js';
import { PaneRoot } from './session/keys.js';
import { MetaLine, Props } from './session/Meta.js';
import { kindWord, needsQueue, openCard, stepsFor } from './session/order.js';
import type { CardProps } from './session/Permission.js';
import { AnswerReceipt } from './session/Receipt.js';
import { ScreenView } from './session/ScreenView.js';
import { useSessionScreen, useWaitingSettled } from './session/screen.js';
import { useSends } from './session/sends.js';
import { Transcript } from './session/Transcript.js';

const WIDE = '(min-width: 1360px)';

/**
 * v0.4.2's dock for a terminal dialog, with its keypad, is its own chunk: most session screens never
 * show it, and the app's first load stays within its budget (scripts/perf-chunks.mjs). Until it
 * arrives the dock says what it says before its first screen read.
 */
const TermDialogDock = lazy(() => import('./session/TermDialog.js').then((m) => ({ default: m.TermDialogDock })));
/**
 * v0.5.3: the Screen tab's picture (with useShot.ts) is its own chunk too, shown only while
 * screenshots are on, so the first load has room for Ask (and v0.6's Fleet). The tab panel stays
 * here, and a spinner holds its place until the picture's chunk arrives.
 */
const ShotView = lazy(() => import('./session/controls/ShotView.js').then((m) => ({ default: m.ShotView })));

/** v0.6: the hook cards are their own chunks, loaded the first time one shows. */
const PermissionCard = lazy(() => import('./session/Permission.js').then((m) => ({ default: m.PermissionCard })));
const QuestionCard = lazy(() => import('./session/Question.js').then((m) => ({ default: m.QuestionCard })));
const PlanCard = lazy(() => import('./session/Plan.js').then((m) => ({ default: m.PlanCard })));
const CARD_WORD = { permission: 'Permission', question: 'Question', plan: 'Plan' } as const;

/** Under a card or dialog dock that could not load (most often a chunk an update dropped). */
export const RELOAD_LINE = "This didn't load: Jantar may have been updated since the page opened. Reload to answer here.";

/** Shows `failed` in place of a lazy part that could not load (React.lazy throws), not a blank screen. */
class ChunkBoundary extends Component<{ failed: ReactNode; children: ReactNode }, { error: boolean }> {
  override state = { error: false };
  static getDerivedStateFromError(): { error: boolean } {
    return { error: true };
  }
  override render(): ReactNode {
    return this.state.error ? this.props.failed : this.props.children;
  }
}

/** The dock a card or dialog would have been: what waits, and Reload. */
function ReloadDock({ phone, title, age, late }: { phone: boolean; title: string; age: string; late: boolean }) {
  return (
    <DockFrame phone={phone} title={title} age={age} late={late} peek={RELOAD_LINE}>
      <p role="alert" className="mt-8 type-small text-ink-2">
        {RELOAD_LINE}
      </p>
      <Button className="mt-12" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </DockFrame>
  );
}

/** ?view=screen (and ?view=files&root=&path=&tab=) survive a reload (the router keeps only ?p= for sessions). */
function viewFromUrl(): { view: View; files: FilesLocation } {
  try {
    return sessionView(window.location.search);
  } catch {
    return { view: 'transcript', files: {} };
  }
}

/** The sessions on one machine (`node` undefined: the Mac's own). */
function sessionsOn(sessions: Record<string, Session>, node: string | undefined): Record<string, Session> {
  return Object.fromEntries(Object.entries(sessions).filter(([, s]) => s.node === node));
}

function waitingAge(iso: string, now: number): string {
  const a = ago(iso, now);
  return !a || a === 'now' ? 'waiting now' : `waiting ${a}`;
}

export function SessionScreen({ sid, pendingId }: { sid: string; pendingId?: string }) {
  const { api, pushEnv, now: clockNow = Date.now } = useDeps();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const frame = useFrame();
  const phone = frame === 'phone';
  const wide = useMedia(WIDE) && !phone;
  const state = useApp((s) => s.state);
  const conn = useApp((s) => s.conn.status);
  const offline = conn === 'offline';
  const ceiling = useCeiling();
  const hubFeatures = useFeatures();
  const root = useRef<HTMLDivElement>(null);

  // Keep the last known session, so a session that goes away mid-read still shows what it said.
  // Own keys only: a sid from the URL such as "constructor" is no session.
  const live = Object.hasOwn(state.sessions, sid) ? state.sessions[sid] : undefined;
  const seen = useRef<Session | null>(null);
  if (live) seen.current = live;
  const session = live ?? seen.current;
  const gone = !live && session !== null;
  // v0.6: a paired machine's session reads its account and switches from that machine, and says why
  // Jantar can't type into it (null: it can). The Mac's own sessions read exactly as before.
  const account = session ? (sessionAccount(state, session) ?? undefined) : undefined;
  const features = session && session.node !== undefined ? sessionFeatures(state, session) : hubFeatures;
  // Offline: a status, not a failed send's refusal (nothing was sent yet).
  const refusal = session ? (typeRefusal(state, session) === 'offline' ? offlineStatus(state, session, now) : typeRefusalText(state, session)) : null;
  const typable = refusal === null;
  const readable = !session || screenReadable(state, session);
  const node = session ? machineOf(state, session.node) : null;
  // A server that reads no usage (config dirs, one login): its session's meta says nothing of usage.
  const noUsage = session?.node !== undefined && node?.accountsMode !== 'cswap';
  const machine = session?.node !== undefined ? machineName(state, session.node) : null;
  // Show on Mac raises a Terminal window: the Mac's own, or a Mac server's (online, not watch-only).
  const raisable = !session || session.node === undefined || (node?.backend === 'terminal-app' && typable);

  const sends = useSends(sid, now);
  const { setDraft } = sends;
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [initial] = useState(viewFromUrl);
  const [chosenView, setViewState] = useState<View>(initial.view);
  const [filesAt, setFilesAt] = useState<FilesLocation>(initial.files);
  // A Files view left in the URL means nothing while Files is off.
  const view: View = chosenView === 'files' && !features.files ? 'transcript' : chosenView;
  const cards = useMemo(() => pendingFor(state, sid), [state, sid]);
  const subagent = cards.find((p) => p.kind === 'subagent-info' && p.state === 'open');
  // v0.4.2: the session screen's one terminal read (nothing for a session that is gone). The Screen
  // tab counts only while its text shows (`peek`): its picture reads no text.
  const [peek, setPeek] = useState(false);
  // A server's session with no terminal to read (offline, no tmux pane, native Windows) is never read.
  const screenRead = useSessionScreen(sid, view === 'screen' && !peek ? 'transcript' : view, readable ? (live?.status ?? null) : null, Boolean(subagent));
  const settled = useWaitingSettled(live?.status ?? null, live?.statusSince ?? null, clockNow);
  const [focusing, setFocusing] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);

  useEffect(() => {
    void closeNotificationsFor(sid, pushEnv).catch(() => 0);
  }, [sid, pushEnv]);
  // Files dropped anywhere on this screen (iPad, desktop), the dock included: chips, as on the composer.
  // Left to the browser it would open the file and leave the app, the draft and the chips with it. A drop
  // on the composer arrives here already handled (prevented).
  const addFiles = useRef(sends.addFiles);
  addFiles.current = sends.addFiles;
  const canAttach = Boolean(live) && live?.status !== 'ended';
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none';
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      if (!handled && canAttach) addFiles.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [canAttach]);
  // "Ask about this" from the Files place: the mention it queued goes into the draft, once (v0.3).
  useEffect(() => {
    const ask = takeAsk(sid);
    if (ask) setDraft((d) => (d.trim() ? `${d.trimEnd()} ${ask}` : ask));
  }, [sid, setDraft]);
  useEffect(() => {
    if (session && typeof document !== 'undefined') document.title = screenTitle(session.folder);
  }, [session]);

  const open = cards.filter((p) => p.state === 'open' && p.kind !== 'subagent-info' && !answered.has(p.id));
  const target = open.find((p) => p.id === pendingId) ?? open[0];
  const decided = cards.find((p) => p.state === 'decided');

  // A card answered somewhere else still gets a receipt here.
  useEffect(() => {
    if (decided && (!receipt || receipt.pendingId !== decided.id) && !answered.has(decided.id)) {
      setReceipt({ pendingId: decided.id, text: answeredBy(decided), at: clockNow() });
    }
  }, [decided, receipt, answered, clockNow]);
  // Sending a prompt clears the receipt.
  useEffect(() => {
    if (sends.sentCount) setReceipt(null);
  }, [sends.sentCount]);

  const onDecided = useCallback(
    (r: Receipt) => {
      setAnswered((prev) => new Set(prev).add(r.pendingId));
      setReceipt({ ...r, at: clockNow() });
    },
    [clockNow],
  );

  const setView = (v: View, files: FilesLocation = v === 'files' ? filesAt : {}) => {
    setViewState(v);
    if (v === 'files') setFilesAt(files);
    navigate(sessionViewPath(sid, v, { ...(pendingId ? { pendingId } : {}), files }), { replace: true });
  };
  // Like the view itself, the viewer's place replaces the URL: it lives in this screen's state.
  const onFilesLocation = (next: FilesLocation) => setView('files', next);
  // "Ask about this" in the Files tab: back to the transcript with the mention in the draft (never sent).
  const onAsk = (text: string) => {
    setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
    setView('transcript');
    requestAnimationFrame(() => sends.area.current?.focus());
  };

  const showOnMac = async () => {
    setFocusing(true);
    setFocusError(null);
    try {
      await api.focus(sid);
      toast(`Brought the tab to the front on ${machine ?? 'the Mac'}`, 'ok');
    } catch (e) {
      setFocusError(errorText(e));
    } finally {
      setFocusing(false);
    }
  };
  const openSession = (to: string) => navigate(sessionViewPath(to, 'transcript'));

  if (!session) {
    if (state.seq === 0 && conn !== 'unauthorized') return <SkeletonRows count={4} />;
    return (
      <EmptyState title="This session is gone">
        <p>It ended, or its Claude process exited.</p>
        <Button className="mt-16" onClick={() => navigate('/')}>
          Back to the board
        </Button>
      </EmptyState>
    );
  }

  const glyph = gone ? 'ended' : glyphStateOf(state, session, now);
  const name = session.name?.trim() || session.sid.slice(0, 8);
  const phase = receipt && state.pending[receipt.pendingId] ? 'waiting' : 'picked';
  // A new dialog in the terminal after the answer outranks the receipt.
  const showReceipt = receipt !== null && !(phase === 'picked' && session.status === 'waiting');
  const steps = stepsFor(state, sid);
  const step = !showReceipt && steps.index >= 0 ? { at: steps.index + 1, of: steps.list.length } : null;
  const queue = needsQueue(state).filter((s) => s.sid !== sid);
  const next = queue[0] ?? null;
  const working = Object.values(state.sessions).filter((s) => shownStatus(s) === 'working' || shownStatus(s) === 'compacting').length;
  const ended = gone || session.status === 'ended';
  // v0.4.2 (spec 2.1): a dialog in the terminal with no hook card for it, below a card and its receipt.
  const dialogOnScreen = Boolean(screenRead.screen?.dialog) || screenRead.answered !== null;
  const dock = !ended && !target && !(receipt !== null && showReceipt) && (settled || subagent !== undefined || dialogOnScreen);

  // ----- the bottom of the pane: dock, receipt or composer -----
  // v0.6: where Jantar can't type (canType), the one fixed line for why takes the composer's place.
  const composer = typable ? (
    <Composer
      sid={sid}
      folder={session.folder}
      sends={sends}
      phone={phone}
      offline={offline}
      {...(raisable ? { onShowOnMac: () => void showOnMac() } : {})}
      machine={machine}
    />
  ) : (
    <p role="status" className={phone ? 'flex-none border-t border-line px-16 pb-safe-16 pt-12 type-small text-ink-2' : 'type-small text-ink-2'}>
      {refusal}
    </p>
  );
  let bottom: ReactNode;
  if (gone) {
    bottom = null;
  } else if (target) {
    const cardFrom = cardMachine(state, session);
    const props: CardProps = {
      p: target,
      folder: session.folder,
      phone,
      offline,
      age: waitingAge(target.createdAt, now),
      late: isLate(target.createdAt, now),
      aside: open.length > 1 ? <Tag>{open.length} cards</Tag> : undefined,
      onDecided,
      // A plan card without the plan's text sends the user to the Mac, which shows the plan (SP10).
      ...(raisable ? { onShowOnMac: () => void showOnMac() } : {}),
      ...(cardFrom ? { machine: cardFrom } : {}),
    };
    const word = target.kind === 'permission' ? `${CARD_WORD.permission} · ${target.tool}` : CARD_WORD[target.kind === 'question' ? 'question' : 'plan'];
    bottom = (
      <ChunkBoundary key={target.id} failed={<ReloadDock phone={phone} title={word} age={props.age} late={props.late} />}>
        <Suspense
          fallback={
            <DockFrame phone={phone} title={word} age={props.age} late={props.late} peek={word}>
              <div data-card-loading className="mt-12 flex h-40 items-center">
                <Spinner label="Loading the card" />
              </div>
            </DockFrame>
          }
        >
          {target.kind === 'permission' ? (
            <PermissionCard key={target.id} {...props} />
          ) : target.kind === 'question' ? (
            <QuestionCard key={target.id} {...props} />
          ) : (
            <PlanCard key={target.id} {...props} />
          )}
        </Suspense>
      </ChunkBoundary>
    );
  } else if (receipt && showReceipt) {
    const withComposer = phase === 'picked' && !ended && session.status !== 'waiting';
    bottom = (
      <>
        <AnswerReceipt
          receipt={receipt}
          phase={phase}
          phone={phone}
          now={now}
          next={next}
          nextWord={next ? kindWord(openCard(state, next.sid)) : ''}
          left={queue.length}
          working={working}
          onNext={() => next && openSession(next.sid)}
          onBoard={() => navigate('/')}
          composerBelow={withComposer}
        />
        {withComposer ? <div className={phone ? 'contents' : 'mt-12'}>{composer}</div> : null}
      </>
    );
    // The composer sits second, in a div, here and in the plain branch below: a send clears the
    // receipt, and the composer (with a Rewrite sheet open in it) must stay mounted across that.
  } else if (dock && !typable) {
    // v0.6: nothing on that machine can be typed or read from here: what waits, and why.
    const since = subagent ? subagent.createdAt : session.statusSince;
    bottom = (
      <DockFrame
        phone={phone}
        title={subagent ? subagentTitle(subagent) : 'Claude is waiting in the terminal'}
        age={ago(since, now) || 'now'}
        late={isLate(since, now)}
        peek={refusal ?? ''}
      >
        {subagent ? <SubagentAsk p={subagent} /> : null}
        <p className="mt-8 type-small text-ink-2">{refusal}</p>
      </DockFrame>
    );
  } else if (dock) {
    const since = subagent ? subagent.createdAt : session.statusSince;
    const age = ago(since, now) || 'now';
    const title = subagent ? subagentTitle(subagent) : 'Claude is waiting in the terminal';
    bottom = (
      <ChunkBoundary failed={<ReloadDock phone={phone} title={title} age={age} late={isLate(since, now)} />}>
        <Suspense
          fallback={
            <DockFrame phone={phone} title={title} age={age} late={isLate(since, now)} peek="Reading the screen">
              <div className="mt-12 flex h-40 items-center">
                <Spinner label="Reading the screen" />
              </div>
            </DockFrame>
          }
        >
          <TermDialogDock
            sid={sid}
            session={session}
            subagent={subagent}
            screen={screenRead}
            phone={phone}
            age={age}
            late={isLate(since, now)}
            sends={sends}
            {...(raisable ? { onShowOnMac: () => void showOnMac() } : {})}
            {...(machine ? { machine } : {})}
          />
        </Suspense>
      </ChunkBoundary>
    );
  } else if (ended) {
    bottom = (
      <p className={phone ? 'flex-none border-t border-line px-16 pb-safe-16 pt-12 type-small text-ink-2' : 'type-small text-ink-2'}>
        This session has ended.
      </p>
    );
  } else {
    // A fragment with the composer second, as in the receipt branch, so it stays mounted across a send.
    bottom = (
      <>
        {null}
        <div className="contents">{composer}</div>
      </>
    );
  }

  // v0.3: the control bar (with its mode chip) above the bottom block, while no card or dialog dock is open.
  const controlBar =
    features.controls && typable && !gone && !ended && !target && !dock ? (
      <ControlBar
        sid={sid}
        session={session}
        phone={phone}
        offline={offline}
        modeChip={<ModeChip sid={sid} session={session} phone={phone} />}
      />
    ) : null;
  // The chip says the mode, so the meta line and the property column leave it out meanwhile (rule 19).
  const modeOnChip = controlBar !== null;
  // Phone: a file open in the Files tab is a pushed screen of its own (spec 5.2.3). The viewer takes
  // the height; the meta line, the control bar and the composer come back with its back button or
  // "Ask about this" (a path not ending in "/" is a file, as files/model.ts placeOf reads it). A card
  // or a waiting dialog stays: it needs an answer whatever is being read.
  const reading = phone && view === 'files' && Boolean(filesAt.root && filesAt.path && !filesAt.path.endsWith('/'));
  const bottomShown = reading && !target && !dock ? null : bottom;
  const filesTab = features.files ? { count: session.filesChanged ?? 0 } : null;

  const header = (
    <Header
      sid={sid}
      folder={session.folder}
      name={name}
      glyph={glyph}
      phone={phone}
      view={view}
      onView={setView}
      step={step}
      onStep={(dir) => {
        const s = steps.list[steps.index + dir];
        if (s) openSession(s.sid);
      }}
      onShowOnMac={() => void showOnMac()}
      showOnMacBusy={focusing}
      canShowOnMac={!ended && raisable}
      // v0.6: a Mac server's window is shown there ("Show on mini-1"); a tmux or Windows server has none to show.
      {...(machine !== null ? { showOn: raisable ? machine : null } : {})}
      onBack={() => navigate('/')}
      back={frame === 'tablet'}
      files={filesTab}
    />
  );
  const goneNotice = gone ? (
    <div role="status" className={phone ? 'flex-none border-b border-line px-16 py-12' : 'flex-none border-b border-line py-12'}>
      <p className="type-title text-ink">This session is gone</p>
      <p className="mt-2 type-small text-ink-2">It ended, or its Claude process exited. This is what it last said.</p>
    </div>
  ) : null;
  const focusLine = focusError ? (
    <p role="alert" className={phone ? 'flex-none px-16 pb-8 type-small text-signal-text' : 'flex-none px-32 pt-8 type-small text-signal-text'}>
      Could not show it on {machine ?? 'the Mac'}: {focusError}
    </p>
  ) : null;
  // v0.6.1: what it still runs in the background, right under the header (no role="status": it changes every minute).
  const bg = gone ? null : backgroundLine(session, now);
  const bgLine =
    bg && (bg.running || bg.quiet) ? (
      <p data-background-line className={phone ? 'flex-none truncate px-16 pb-4 type-mono' : 'flex-none truncate px-32 pt-8 type-mono'}>
        {bg.running ? <span className="text-ink-2">{bg.running}</span> : null}
        {bg.quiet ? <span className="text-ink-3">{bg.running ? ` · ${bg.quiet}` : bg.quiet}</span> : null}
      </p>
    ) : null;
  // v0.6: where a paired machine's session runs, under the header.
  const where = machineLine(state, session, now);
  const whereLine = where ? (
    <p data-machine-line className={phone ? 'flex-none truncate px-16 pb-4 type-mono text-ink-3' : 'flex-none truncate px-32 pt-8 type-mono text-ink-3'}>
      {where}
    </p>
  ) : null;
  // "Also on 03" counts the sessions on the same machine's account 03 only (every server has its own).
  const sameMachine = hasMachines(state) ? { ...state, sessions: sessionsOn(state.sessions, session.node) } : state;
  // The Screen tab's text: the session screen's one read, and the keypad while no dock is up.
  const screenText = (p: { id?: string; labelledBy?: string }) => (
    <ScreenView
      sid={sid}
      phone={phone}
      {...(raisable ? { onShowOnMac: () => void showOnMac() } : {})}
      {...(raisable && machine ? { showOn: machine } : {})}
      read={screenRead}
      onShown={setPeek}
      keys={features.controls && typable && !gone && !ended && !target && !dock}
      offline={offline}
      {...p}
    />
  );
  const panel =
    view === 'files' ? (
      <FilesTab
        sid={sid}
        session={session}
        phone={phone}
        id={PANEL_ID(sid, 'files')}
        labelledBy={TAB_ID(sid, 'files')}
        location={filesAt}
        onLocation={onFilesLocation}
        onAsk={onAsk}
      />
    ) : view === 'screen' && features.screenshots ? (
      <div id={PANEL_ID(sid, 'screen')} role="tabpanel" aria-labelledby={TAB_ID(sid, 'screen')} className="flex min-h-0 flex-1 flex-col">
        <Suspense
          fallback={
            <div className={phone ? 'px-16 pt-16' : 'pt-24'}>
              <Spinner label="Opening the picture" />
            </div>
          }
        >
          <ShotView sid={sid} phone={phone} onShowOnMac={() => void showOnMac()} text={screenText} />
        </Suspense>
      </div>
    ) : view === 'screen' && !readable ? (
      <div role="tabpanel" id={PANEL_ID(sid, 'screen')} aria-labelledby={TAB_ID(sid, 'screen')} className={phone ? 'min-h-0 flex-1 px-16 py-16' : 'min-h-0 flex-1 py-16'}>
        <p className="type-small text-ink-2">{refusal}</p>
      </div>
    ) : view === 'screen' ? (
      screenText({ id: PANEL_ID(sid, 'screen'), labelledBy: TAB_ID(sid, 'screen') })
    ) : (
      <Transcript
        session={session}
        glyph={glyph}
        sends={sends}
        now={now}
        phone={phone}
        dim={gone}
        id={PANEL_ID(sid, 'transcript')}
        labelledBy={TAB_ID(sid, 'transcript')}
      />
    );

  if (phone) {
    return (
      <PaneRoot.Provider value={root}>
        <div
          ref={root}
          className="flex h-full min-h-0 flex-col bg-bg"
          // Reach under the home indicator so the sheet's surface runs to the edge (CSSOM style, CSP-safe).
          style={{ height: 'calc(100% + env(safe-area-inset-bottom, 0px))', marginBottom: 'calc(env(safe-area-inset-bottom, 0px) * -1)' }}
        >
          {header}
          {bgLine}
          {whereLine}
          {reading ? null : <MetaLine session={session} account={account} ceiling={ceiling} now={now} phone modeOnChip={modeOnChip} noUsage={noUsage} />}
          <div className="flex-none border-b border-line px-16 py-8">
            <Tabs sid={sid} view={view} onView={(v) => setView(v)} phone files={filesTab} />
          </div>
          {focusLine}
          {goneNotice}
          {panel}
          {reading ? null : controlBar}
          {bottomShown}
        </div>
      </PaneRoot.Provider>
    );
  }

  return (
    <PaneRoot.Provider value={root}>
      <div ref={root} className="flex h-full min-h-0 flex-col bg-bg">
        {header}
        {bgLine}
        {whereLine}
        {focusLine}
        <div className="flex min-h-0 flex-1 justify-between gap-32 px-32">
          <div className="flex min-h-0 min-w-0 max-w-640 flex-1 flex-col">
            {wide ? null : <MetaLine session={session} account={account} ceiling={ceiling} now={now} phone={false} modeOnChip={modeOnChip} noUsage={noUsage} />}
            {goneNotice}
            {panel}
            {controlBar}
            {bottom ? <div className="flex-none pb-24">{bottom}</div> : null}
          </div>
          {wide ? <Props session={session} account={account} state={sameMachine} ceiling={ceiling} now={now} onOpen={openSession} modeOnChip={modeOnChip} noUsage={noUsage} /> : null}
        </div>
      </div>
    </PaneRoot.Provider>
  );
}
