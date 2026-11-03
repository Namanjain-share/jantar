/**
 * The app shell: picks the chrome for the window (shell/layout.ts), wires the
 * chrome to the store and router, and places the current screen.
 *
 *   phone   PhoneHeader / notices / place / TabBar     (a session is full screen)
 *   desk    TopBar / Rail + place / StatusBar
 *
 * 0.11: one tree for every chrome (the place is always slot 4, so a resize
 * never remounts it), and the place lays itself out by its own width: the
 * board and a session are one SplitPane (kit/SplitPane.tsx: the ledger beside
 * the session or the Desk from a pane of 800, one at a time below), every
 * other place a Pane (kit/Pane.tsx). Every pane is a query container, so a
 * screen's @md: and the rest (640 and up) read its pane's width, not the
 * window's; only the chrome and the Mac's density (desk:) follow the window.
 *
 * Pair and NotPaired are bare: no chrome at all.
 *
 * The v0.3 places, Files and New session, are their own chunks, loaded the
 * first time one opens (skeleton rows meanwhile), so the main chunk carries
 * neither; the service worker precaches them like every other file. So are
 * v0.4's Life screens and the Intel shelf, each shown only while its switch
 * is on (Life: any module; which modules are on is the screen's to ask),
 * v0.5's Meetings, shown only while Meetings are on, v0.10's Chat (v0.5.3's
 * Ask), shown only while Chat is on, and v0.7's Posts, a Life screen. 0.11
 * loads Accounts, Alerts and Devices the same way, to make room in the main
 * load for the wide layouts.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { boardOrder, needsYou } from '@jantar/protocol';
import { documentTitle, setFavicon } from '../../lib/favicon.js';
import { resyncPush } from '../../lib/push.js';
import { useApp, useDeps, useNavigate, useNow, useRoute } from '../context.js';
import { Pane } from '../kit/Pane.js';
import { SkeletonRows } from '../kit/Skeleton.js';
import { SplitPane } from '../kit/SplitPane.js';
import { Board } from '../screens/Board.js';
import { Desk } from '../screens/Desk.js';
import { useCanStart } from '../screens/new/machines.js';
import { NotFound } from '../screens/NotFound.js';
import { NotPaired, PairScreen } from '../screens/Pair.js';
import { SessionScreen } from '../screens/Session.js';
import { savedKinds } from '../screens/devices/kinds.js';
import { routePath, type FilesLocation, type Route } from '../../lib/router.js';
import { useAccountsMode, useCeiling, useFeatures, useNeedsCount, useNewAlerts, useStripItems, useUsagePairs } from './data.js';
import { More } from '../screens/more/More.js';
import { useGlobalKeys, useKey } from './keys.js';
import { useLayout } from './layout.js';
import { LegendPopover, LegendSheet } from './LegendPopover.js';
import { OfflineNotice, UpdateNotice } from './Notices.js';
import { PhoneHeader } from './PhoneHeader.js';
import { Rail } from './Rail.js';
import { StatusBar } from './StatusBar.js';
import { TabBar } from './TabBar.js';
import { Toasts } from './Toasts.js';
import { TopBar } from './TopBar.js';

// 0.11: Accounts, Alerts and Devices, each its own chunk (room in the main load for the wide layouts).
const Accounts = lazy(() => import('../screens/Accounts.js').then((m) => ({ default: m.Accounts })));
const Alerts = lazy(() => import('../screens/Alerts.js').then((m) => ({ default: m.Alerts })));
const Devices = lazy(() => import('../screens/Devices.js').then((m) => ({ default: m.Devices })));
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
// v0.7, a Life screen in its own chunk.
const Posts = lazy(() => import('../screens/life/posts/Posts.js').then((m) => ({ default: m.Posts })));
const Intel = lazy(() => import('../screens/intel/Intel.js').then((m) => ({ default: m.Intel })));
// v0.5, its own chunk.
const Meetings = lazy(() => import('../screens/meetings/Meetings.js').then((m) => ({ default: m.Meetings })));
// v0.5.3, its own chunk.
const Chat = lazy(() => import('../screens/chat/Chat.js').then((m) => ({ default: m.Chat })));
// v0.11 People: his Partner screen, its own chunk.
const Partner = lazy(() => import('../screens/people/Partner.js').then((m) => ({ default: m.Partner })));

export function Shell() {
  const { api, connection, pushEnv } = useDeps();
  const route = useRoute();
  const navigate = useNavigate();
  const layout = useLayout();
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

  const phone = layout.chrome === 'phone';
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
  // 0.11 (build plan 2.13): More is the phone's tab. A wider chrome's rail lists every place, so /more goes to the board.
  const lostMore = route.name === 'more' && !phone;
  useEffect(() => {
    if (lostMore) navigate('/', { replace: true });
  }, [lostMore, navigate]);

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
  // Esc back to the board from a session beside the ledger: the board's SplitPane (kit/SplitPane.tsx).

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
      // 0.11: each loads the first time it opens (skeleton rows meanwhile).
      case 'accounts':
        screen = (
          <Suspense fallback={<SkeletonRows count={5} caption="Opening Accounts…" />}>
            <Accounts />
          </Suspense>
        );
        break;
      case 'alerts':
        screen = (
          <Suspense fallback={<SkeletonRows count={5} caption="Opening Alerts…" />}>
            <Alerts kind={route.kind} id={route.id} />
          </Suspense>
        );
        break;
      case 'devices':
        screen = (
          <Suspense fallback={<SkeletonRows count={5} caption="Opening Devices…" />}>
            <Devices />
          </Suspense>
        );
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
      // v0.4 places: Life's screens while any module is on, the shelf while it is on (v0.7: Posts is a Life screen).
      case 'today':
      case 'todos':
      case 'meds':
      case 'food':
      case 'places':
      case 'money':
      case 'posts':
      case 'people':
      case 'intel': {
        // v0.11: People while it is on (its own switch: Life modules may all be off).
        const on = route.name === 'intel' ? features.intel : route.name === 'people' ? features.people : features.life;
        const caption = route.name === 'intel' ? 'Opening the shelf…' : route.name === 'people' ? 'Opening Accountability partner…' : 'Opening Life…';
        screen = on ? (
          <Suspense fallback={<SkeletonRows count={5} caption={caption} />}>{lifeScreen(route)}</Suspense>
        ) : featuresKnown ? (
          <NotFound off={route.name === 'intel' ? 'intel on' : route.name === 'people' ? 'people on' : 'life on <module>'} />
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
      // v0.10: Chat (v0.5.3's Ask) while it is on.
      case 'chat':
        screen = features.ask ? (
          <Suspense fallback={<SkeletonRows count={5} caption="Opening Chat…" />}>
            <Chat day={route.day} />
          </Suspense>
        ) : featuresKnown ? (
          <NotFound off="chat on" />
        ) : (
          <SkeletonRows count={5} caption="Opening Chat…" />
        );
        break;
      case 'more':
        screen = phone ? <More /> : null;
        break;
      case 'notFound':
        screen = <NotFound />;
        break;
    }
  }

  if (bare) {
    return (
      <div className="min-h-dvh bg-bg">
        <main id="main" className="@container pt-safe pb-safe">
          {screen}
        </main>
        <Toasts />
      </div>
    );
  }

  const badges = { board: needs, alerts: newAlerts };
  // A phone shows a session full screen: no header, no tabs.
  const fullScreen = phone && route.name === 'session';
  // The board and a session are one SplitPane: the ledger beside the session (or the Desk) when the
  // pane is wide enough, one of them otherwise. Every other place is a Pane, its own keyed scroll box,
  // so it opens at its own scroll. main itself never scrolls.
  const place =
    route.name === 'board' || route.name === 'session' ? (
      <SplitPane
        name="board"
        list={<Board />}
        detail={route.name === 'session' ? screen : null}
        selection={route.name === 'session' ? route.sid : undefined}
        empty={<Desk />}
        listLabel="Ledger"
        detailLabel="Detail"
        onClose={() => navigate('/')}
        escape={!palette && !legend}
      />
    ) : (
      <Pane key={route.name} name={route.name}>
        {screen}
      </Pane>
    );

  // One tree at every chrome (build plan 1.6). Each slot keeps its element type and place, so the place
  // in slot 4 is never remounted when the chrome changes (768 on a Mac, a rotation, a window drag):
  // only the chrome around it is swapped, and only classes change.
  return (
    <div data-chrome={layout.chrome} className={phone ? 'flex h-dvh flex-col bg-bg' : 'grid-shell grid h-dvh bg-bg'}>
      {/* 1: the phone's header */}
      {phone ? (
        fullScreen ? (
          <div className="pt-safe flex-none" />
        ) : (
          <PhoneHeader needs={needs} items={items} dashed={dashed} search={features.intel} onLegend={() => setLegend(true)} onHome={() => connection?.kick()} />
        )
      ) : null}
      {/* 2: the Mac's top bar */}
      {phone ? null : (
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
      )}
      {/* 3: the rail */}
      {phone ? null : <Rail route={route.name} badges={badges} onPalette={() => setPalette(true)} />}
      {/* 4: the place, always here */}
      <div className={phone ? 'flex min-h-0 flex-1 flex-col' : 'col-start-2 row-start-2 flex min-h-0 min-w-0 flex-col'}>
        {offline ? <OfflineNotice /> : null}
        {phone && updateAvailable ? <UpdateNotice /> : null}
        <main id="main" className="relative min-h-0 flex-1">
          {place}
        </main>
      </div>
      {/* 5: Chat beside any screen (build plan c28) */}
      {null}
      {/* 6: the phone's tabs, or the Mac's status bar */}
      {phone ? (
        fullScreen ? null : (
          <TabBar route={route.name} badges={badges} />
        )
      ) : (
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
      )}
      {phone ? <LegendSheet open={legend} onOpenChange={setLegend} /> : null}
      {!phone && paletteUsed.current ? (
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
      return <Places {...route} />;
    case 'money':
      return <Money month={route.month} bill={route.bill} />;
    case 'posts':
      return <Posts filter={route.filter} id={route.id} />;
    case 'people':
      return <Partner pid={route.pid} tab={route.tab} day={route.day} id={route.id} />;
    case 'intel':
      return <Intel q={route.q} type={route.type} tag={route.tag} item={route.item} focus={route.focus} />;
    default:
      return null;
  }
}
