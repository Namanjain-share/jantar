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
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { pendingFor, type Session } from '@jantar/protocol';
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
import { Composer, carriesFiles } from './session/Composer.js';
import { ControlBar } from './session/controls/ControlBar.js';
import { ModeChip } from './session/controls/ModeChip.js';
import { FilesTab } from './session/FilesTab.js';
import { takeAsk } from './session/ask.js';
import { answeredBy, type Receipt } from './session/decide.js';
import { DockFrame, isLate } from './session/DockFrame.js';
import { Header, PANEL_ID, TAB_ID, Tabs, type View } from './session/Header.js';
import { subagentTitle } from './session/Info.js';
import { PaneRoot } from './session/keys.js';
import { MetaLine, Props } from './session/Meta.js';
import { kindWord, needsQueue, openCard, stepsFor } from './session/order.js';
import { PermissionCard, type CardProps } from './session/Permission.js';
import { PlanCard } from './session/Plan.js';
import { QuestionCard } from './session/Question.js';
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
 * v0.6: the Screen tab's picture (with its capture hook) is its own chunk too: it shows only while
 * screenshots are on, and the room it leaves in the first load is Fleet's. Until it arrives the
 * tab shows a spinner (never a text read the picture would make needless).
 */
const ShotView = lazy(() => import('./session/controls/ShotView.js').then((m) => ({ default: m.ShotView })));

/** ?view=screen (and ?view=files&root=&path=&tab=) survive a reload (the router keeps only ?p= for sessions). */
function viewFromUrl(): { view: View; files: FilesLocation } {
  try {
    return sessionView(window.location.search);
  } catch {
    return { view: 'transcript', files: {} };
  }
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
  const features = useFeatures();
  const root = useRef<HTMLDivElement>(null);

  // Keep the last known session, so a session that goes away mid-read still shows what it said.
  // Own keys only: a sid from the URL such as "constructor" is no session.
  const live = Object.hasOwn(state.sessions, sid) ? state.sessions[sid] : undefined;
  const seen = useRef<Session | null>(null);
  if (live) seen.current = live;
  const session = live ?? seen.current;
  const gone = !live && session !== null;
  const account = session && session.account !== null ? state.accounts[String(session.account)] : undefined;

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
  const screenRead = useSessionScreen(sid, view === 'screen' && !peek ? 'transcript' : view, live?.status ?? null, Boolean(subagent));
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
      toast('Brought the tab to the front on the Mac', 'ok');
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
  const working = Object.values(state.sessions).filter((s) => s.status === 'working' || s.status === 'compacting').length;
  const ended = gone || session.status === 'ended';
  // v0.4.2 (spec 2.1): a dialog in the terminal with no hook card for it, below a card and its receipt.
  const dialogOnScreen = Boolean(screenRead.screen?.dialog) || screenRead.answered !== null;
  const dock = !ended && !target && !(receipt !== null && showReceipt) && (settled || subagent !== undefined || dialogOnScreen);

  // ----- the bottom of the pane: dock, receipt or composer -----
  const composer = (
    <Composer sid={sid} folder={session.folder} sends={sends} phone={phone} offline={offline} onShowOnMac={() => void showOnMac()} />
  );
  let bottom: ReactNode;
  if (gone) {
    bottom = null;
  } else if (target) {
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
      onShowOnMac: () => void showOnMac(),
    };
    bottom =
      target.kind === 'permission' ? (
        <PermissionCard key={target.id} {...props} />
      ) : target.kind === 'question' ? (
        <QuestionCard key={target.id} {...props} />
      ) : (
        <PlanCard key={target.id} {...props} />
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
  } else if (dock) {
    const since = subagent ? subagent.createdAt : session.statusSince;
    const age = ago(since, now) || 'now';
    const title = subagent ? subagentTitle(subagent) : 'Claude is waiting in the terminal';
    bottom = (
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
          onShowOnMac={() => void showOnMac()}
        />
      </Suspense>
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
    features.controls && !gone && !ended && !target && !dock ? (
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
      canShowOnMac={!ended}
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
      Could not show it on the Mac: {focusError}
    </p>
  ) : null;
  // The Screen tab's text: the session screen's one read, and the keypad while no dock is up.
  const screenText = (p: { id?: string; labelledBy?: string }) => (
    <ScreenView
      sid={sid}
      phone={phone}
      onShowOnMac={() => void showOnMac()}
      read={screenRead}
      onShown={setPeek}
      keys={features.controls && !gone && !ended && !target && !dock}
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
      <Suspense
        fallback={
          <div role="tabpanel" id={PANEL_ID(sid, 'screen')} aria-labelledby={TAB_ID(sid, 'screen')} className="flex h-40 items-center justify-center">
            <Spinner label="Loading the picture" />
          </div>
        }
      >
        <ShotView
          sid={sid}
          phone={phone}
          onShowOnMac={() => void showOnMac()}
          id={PANEL_ID(sid, 'screen')}
          labelledBy={TAB_ID(sid, 'screen')}
          text={screenText}
        />
      </Suspense>
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
          {reading ? null : <MetaLine session={session} account={account} ceiling={ceiling} now={now} phone modeOnChip={modeOnChip} />}
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
        {focusLine}
        <div className="flex min-h-0 flex-1 justify-between gap-32 px-32">
          <div className="flex min-h-0 min-w-0 max-w-640 flex-1 flex-col">
            {wide ? null : <MetaLine session={session} account={account} ceiling={ceiling} now={now} phone={false} modeOnChip={modeOnChip} />}
            {goneNotice}
            {panel}
            {controlBar}
            {bottom ? <div className="flex-none pb-24">{bottom}</div> : null}
          </div>
          {wide ? <Props session={session} account={account} state={state} ceiling={ceiling} now={now} onOpen={openSession} modeOnChip={modeOnChip} /> : null}
        </div>
      </div>
    </PaneRoot.Provider>
  );
}
