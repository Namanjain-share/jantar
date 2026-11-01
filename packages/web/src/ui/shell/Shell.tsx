/**
 * The app shell: picks the frame for the width (shell/layout.ts), wires the
 * chrome to the store and router, and places the current screen.
 *
 *   phone   PhoneHeader / notices / screen / TabBar   (a session is full screen)
 *   tablet  TopBar / Rail + screen / StatusBar          (a session is full width)
 *   desk+   TopBar / Rail + ledger column + detail pane / StatusBar
 *
 * Pair and NotPaired are bare: no chrome at all.
 *
 * The v0.3 places, Files and New session, are their own chunks, loaded the
 * first time one opens (skeleton rows meanwhile), so the main chunk carries
 * neither; the service worker precaches them like every other file. So are
 * v0.4's Life screens and the Intel shelf, each shown only while its switch
 * is on (Life: any module; which modules are on is the screen's to ask),
 * v0.5's Meetings, shown only while Meetings are on, and v0.5.3's Ask,
 * shown only while Ask is on.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { boardOrder, needsYou } from '@jantar/protocol';
import { documentTitle, setFavicon } from '../../lib/favicon.js';
import { resyncPush } from '../../lib/push.js';
import { useApp, useDeps, useNavigate, useNow, useRoute } from '../context.js';
import { SkeletonRows } from '../kit/Skeleton.js';
import { Accounts } from '../screens/Accounts.js';
import { Alerts } from '../screens/Alerts.js';
import { Board } from '../screens/Board.js';
import { Desk } from '../screens/Desk.js';
import { Devices } from '../screens/Devices.js';
import { useCanStart } from '../screens/new/machines.js';
import { NotFound } from '../screens/NotFound.js';
import { NotPaired, PairScreen } from '../screens/Pair.js';
import { SessionScreen } from '../screens/Session.js';
import { savedKinds } from '../screens/devices/kinds.js';
import { routePath, type FilesLocation, type Route } from '../../lib/router.js';
import { useAccountsMode, useCeiling, useFeatures, useNeedsCount, useNewAlerts, useStripItems, useUsagePairs } from './data.js';
import { More } from '../screens/more/More.js';
import { useGlobalKeys, useKey } from './keys.js';
import { isSplit, useFrame } from './layout.js';
import { LegendPopover, LegendSheet } from './LegendPopover.js';
import { OfflineNotice, UpdateNotice } from './Notices.js';
import { PhoneHeader } from './PhoneHeader.js';
import { Rail } from './Rail.js';
import { StatusBar } from './StatusBar.js';
import { TabBar } from './TabBar.js';
import { Toasts } from './Toasts.js';
import { TopBar } from './TopBar.js';

// Desktop-only and loaded on first use: cmdk and the Base UI dialog.
const Palette = lazy(() => import('./Palette.js').then((m) => ({ default: m.Palette })));
// v0.3 places, each its own chunk (the viewer, highlighter client and TanStack Virtual; the folder browser, start form and receipt).
const FilesPlace = lazy(() => import('../screens/files/FilesPlace.js').then((m) => ({ default: m.FilesPlace })));
const NewSession = lazy(() => import('../screens/new/NewSession.js').then((m) => ({ default: m.NewSession })));
// v0.4 places, each its own chunk.
const Today = lazy(() => import('../screens/life/today/Today.js').then((m) => ({ default: m.Today })));
const Todos = lazy(() => import('../screens/life/todos/Todos.js').then((m) => ({ default: m.Todos })));
const Meds = lazy(() => import('../screens/life/meds/Meds.js').then((m) => ({ default: m.Meds })));
const Food = lazy(() => import('../screens/life/food/Food.js').then((m) => ({ default: m.Food })));
const Places = lazy(() => import('../screens/life/places/Places.js').then((m) => ({ default: m.Places })));
const Money = lazy(() => import('../screens/life/money/Money.js').then((m) => ({ default: m.Money })));
const Intel = lazy(() => import('../screens/intel/Intel.js').then((m) => ({ default: m.Intel })));
// v0.5, its own chunk.
const Meetings = lazy(() => import('../screens/meetings/Meetings.js').then((m) => ({ default: m.Meetings })));
// v0.5.3, its own chunk.
const Ask = lazy(() => import('../screens/ask/Ask.js').then((m) => ({ default: m.Ask })));

export function Shell() {
  const { api, connection, pushEnv } = useDeps();
  const route = useRoute();
  const navigate = useNavigate();
  const frame = useFrame();
  const conn = useApp((s) => s.conn);
  const state = useApp((s) => s.state);
  const updateAvailable = useApp((s) => s.updateAvailable);
  const now = useNow(15_000);
  const needs = useNeedsCount();
  const items = useStripItems(now);
  const pairs = useUsagePairs(now);
  const ceiling = useCeiling();
  const newAlerts = useNewAlerts(route.name === 'alerts');
  const features = useFeatures();
  // v0.6: New session is there while a session can start somewhere (the Mac, or a paired server).
  const canStart = useCanStart();
  const single = useAccountsMode() === 'single';
  const [palette, setPalette] = useState(false);
  const [legend, setLegend] = useState(false);
  const paletteUsed = useRef(false);
  if (palette) paletteUsed.current = true;

  const phone = frame === 'phone';
  const split = isSplit(frame);
  const bare = route.name === 'pair' || conn.status === 'unauthorized';
  const offline = conn.status === 'offline';
  const dashed = offline || conn.status === 'connecting';
  const openSession = (sid: string) => navigate(`/s/${encodeURIComponent(sid)}`);

  // Tab title and favicon say whether anything needs you. A session screen
  // names its own tab.
  useEffect(() => {
    if (typeof document === 'undefined' || route.name === 'session') return;
    document.title = documentTitle(needs);
  }, [needs, route.name]);
  useEffect(() => setFavicon(needs > 0), [needs]);

  // Once connected, quietly make sure the daemon still has this device's push subscription.
  const [pushSynced, setPushSynced] = useState(false);
  useEffect(() => {
    if (pushSynced || (conn.status !== 'live' && conn.status !== 'polling')) return;
    setPushSynced(true);
    void resyncPush(api, pushEnv, savedKinds()).catch(() => undefined);
  }, [conn.status, pushSynced, api, pushEnv]);

  // Desktop keys: Cmd-K, ?, g b/a/l/d (keys.ts), and moving through the ledger.
  useGlobalKeys({
    enabled: !phone && !bare,
    onPalette: () => setPalette(true),
    onLegend: () => setLegend((o) => !o),
    navigate: (to) => navigate(to),
  });
  const ledgerKeys = !phone && !bare && (route.name === 'board' || route.name === 'session');
  useKey(
    ['j', 'k'],
    (e) => {
      const order = boardOrder(state);
      if (!order.length) return;
      const at = route.name === 'session' ? order.findIndex((s) => s.sid === route.sid) : -1;
      const next = e.key === 'j' ? Math.min(order.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
      const s = order[next];
      if (s) openSession(s.sid);
    },
    ledgerKeys,
  );
  useKey(
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Enter'],
    (e) => {
      if (e.key === 'Enter' && (route.name !== 'board' || (e.target as HTMLElement | null)?.closest?.('button, a, [role="listbox"]'))) return;
      const waiting = boardOrder(state).filter((s) => needsYou(state, s.sid));
      const s = waiting[e.key === 'Enter' ? 0 : Number(e.key) - 1];
      if (s) {
        e.preventDefault();
        openSession(s.sid);
      }
    },
    ledgerKeys,
  );
  useKey('Escape', () => navigate('/'), ledgerKeys && split && route.name === 'session' && !palette && !legend);

  // The switches are known once the daemon has said them, or a synced state came from a daemon too old to have them.
  const featuresKnown = state.daemon != null || state.seq > 0;
  let screen: ReactNode;
  if (route.name === 'pair') screen = <PairScreen code={route.code} />;
  else if (conn.status === 'unauthorized') screen = <NotPaired />;
  else {
    switch (route.name) {
      case 'board':
        screen = <Board />;
        break;
      case 'session':
        screen = <SessionScreen key={route.sid} sid={route.sid} pendingId={route.pendingId} />;
        break;
      case 'accounts':
        screen = <Accounts />;
        break;
      case 'alerts':
        screen = <Alerts />;
        break;
      case 'devices':
        screen = <Devices />;
        break;
      // v0.3 places exist only while their switch is on. Until the daemon has said which are on (a
      // cold start, or a cache a new version dropped), they wait: a launch push opens /new at once.
      case 'files': {
        const { name: _name, ...location } = route;
        screen = features.files ? (
          <Suspense fallback={<SkeletonRows count={5} caption="Opening Files…" />}>
            <FilesPlace
              location={location}
              onLocation={(next: FilesLocation, o) => navigate(routePath({ name: 'files', ...next }), o?.replace ? { replace: true } : undefined)}
            />
          </Suspense>
        ) : featuresKnown ? (
          <NotFound off="files on" />
        ) : (
          <SkeletonRows count={5} caption="Opening Files…" />
        );
        break;
      }
      case 'new': {
        const { name: _name, ...props } = route;
        screen = canStart ? (
          <Suspense fallback={<SkeletonRows count={5} caption="Opening New session…" />}>
            <NewSession {...props} />
          </Suspense>
        ) : featuresKnown ? (
          <NotFound off="launch on" />
        ) : (
          <SkeletonRows count={5} caption="Opening New session…" />
        );
        break;
      }
      // v0.4 places: Life's screens while any module is on, the shelf while it is on.
      case 'today':
      case 'todos':
      case 'meds':
      case 'food':
      case 'places':
      case 'money':
      case 'intel': {
        const on = route.name === 'intel' ? features.intel : features.life;
        const caption = route.name === 'intel' ? 'Opening the shelf…' : 'Opening Life…';
        screen = on ? (
          <Suspense fallback={<SkeletonRows count={5} caption={caption} />}>{lifeScreen(route)}</Suspense>
        ) : featuresKnown ? (
          <NotFound off={route.name === 'intel' ? 'intel on' : 'life on <module>'} />
        ) : (
          <SkeletonRows count={5} caption={caption} />
        );
        break;
      }
      // v0.5: Meetings while they are on.
      case 'meetings':
        screen = features.meetings ? (
          <Suspense fallback={<SkeletonRows count={5} caption="Opening Meetings…" />}>
            <Meetings project={route.project} q={route.q} id={route.id} />
          </Suspense>
        ) : featuresKnown ? (
          <NotFound off="meetings on" />
        ) : (
          <SkeletonRows count={5} caption="Opening Meetings…" />
        );
        break;
      // v0.5.3: Ask while it is on.
      case 'ask':
        screen = features.ask ? (
          <Suspense fallback={<SkeletonRows count={5} caption="Opening Ask…" />}>
            <Ask />
          </Suspense>
        ) : featuresKnown ? (
          <NotFound off="ask on" />
        ) : (
          <SkeletonRows count={5} caption="Opening Ask…" />
        );
        break;
      case 'more':
        screen = <More />;
        break;
      case 'notFound':
        screen = <NotFound />;
        break;
    }
  }

  if (bare) {
    return (
      <div className="min-h-dvh bg-bg">
        <main id="main" className="pt-safe pb-safe">
          {screen}
        </main>
        <Toasts />
      </div>
    );
  }

  const badges = { board: needs, alerts: newAlerts };
  const scrollKey = route.name === 'session' ? `s:${route.sid}` : route.name;

  if (phone) {
    const fullScreen = route.name === 'session';
    return (
      <div className="flex h-dvh flex-col bg-bg">
        {fullScreen ? <div className="pt-safe flex-none" /> : <PhoneHeader needs={needs} items={items} dashed={dashed} search={features.intel} onLegend={() => setLegend(true)} onHome={() => connection?.kick()} />}
        {offline ? <OfflineNotice /> : null}
        {updateAvailable ? <UpdateNotice /> : null}
        <main id="main" key={scrollKey} className={fullScreen ? 'pb-safe min-h-0 flex-1 overflow-y-auto' : 'min-h-0 flex-1 overflow-y-auto'}>
          {screen}
        </main>
        {fullScreen ? null : <TabBar route={route.name} badges={badges} />}
        <LegendSheet open={legend} onOpenChange={setLegend} />
        <Toasts />
      </div>
    );
  }

  const ledgerRoute = route.name === 'board' || route.name === 'session';
  let body: ReactNode;
  if (split && ledgerRoute) {
    body = (
      <div className="grid-ledger grid h-full min-h-0">
        <section aria-label="Ledger" className="no-scrollbar min-h-0 overflow-y-auto border-r border-line bg-surface">
          <Board />
        </section>
        <section aria-label="Detail" key={scrollKey} className="min-h-0 min-w-0 overflow-y-auto">
          {route.name === 'session' ? screen : <Desk />}
        </section>
      </div>
    );
  } else {
    body = (
      <div key={scrollKey} className="h-full overflow-y-auto">
        {screen}
      </div>
    );
  }

  return (
    <div className="grid-shell grid h-dvh bg-bg">
      <TopBar
        needs={needs}
        items={items}
        accounts={Object.keys(state.accounts).length}
        known={state.seq > 0}
        dashed={dashed}
        onOpen={openSession}
        onPalette={() => setPalette(true)}
        onHome={() => connection?.kick()}
      />
      <Rail route={route.name} badges={badges} onPalette={() => setPalette(true)} />
      <div className="col-start-2 row-start-2 flex min-h-0 min-w-0 flex-col">
        {offline ? <OfflineNotice /> : null}
        <main id="main" className="relative min-h-0 flex-1">
          {body}
        </main>
      </div>
      <StatusBar
        conn={conn}
        seq={state.seq}
        now={now}
        fetchedAt={state.usage.fetchedAt}
        pairs={pairs}
        single={single}
        ceiling={ceiling}
        route={route.name}
        needs={needs}
        updateAvailable={updateAvailable}
        onAccounts={() => navigate('/accounts')}
        legend={<LegendPopover open={legend} onOpenChange={setLegend} />}
      />
      {paletteUsed.current ? (
        <Suspense fallback={null}>
          <Palette open={palette} onOpenChange={setPalette} now={now} />
        </Suspense>
      ) : null}
      <Toasts />
    </div>
  );
}

/** The v0.4 screen for a Life or Intel route (Shell renders it only while its switch is on). */
function lifeScreen(route: Route): ReactNode {
  switch (route.name) {
    case 'today':
      return <Today dose={route.dose} />;
    case 'todos':
      return <Todos tab={route.tab} project={route.project} id={route.id} />;
    case 'meds':
      return <Meds day={route.day} med={route.med} />;
    case 'food':
      return <Food day={route.day} />;
    case 'places':
      return <Places filter={route.filter} id={route.id} />;
    case 'money':
      return <Money month={route.month} bill={route.bill} />;
    case 'intel':
      return <Intel q={route.q} type={route.type} tag={route.tag} item={route.item} focus={route.focus} />;
    default:
      return null;
  }
}
