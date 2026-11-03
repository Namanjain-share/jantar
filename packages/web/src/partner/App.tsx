/**
 * v0.12 People: her app (P1 shell). Tab bar Today · Me (To-do and Health
 * join as their routes land); a banner for paused, ending and People off;
 * live reloads on her stream's ticks (WS /v1/p/events).
 */
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import type { PersonMe } from '@jantar/protocol/people';
import { PersonApiError, type PersonApi } from './api.js';
import { Sheet } from './ui.js';
import { parsePersonRoute, type PersonRoute } from './router.js';
import { Join } from './screens/Join.js';
import { Left } from './screens/Left.js';
import { Me } from './screens/Me.js';
import { Review } from './screens/Review.js';
import { Today } from './screens/Today.js';
import { Todos } from './screens/Todos.js';

// Her Journal, Health and Alerts load when opened (spec 9.4): her first load stays Today.
const Journal = lazy(() => import('./screens/Journal.js'));
const Health = lazy(() => import('./screens/Health.js'));
const Alerts = lazy(() => import('./screens/Alerts.js'));

import { navigate } from './nav.js';

export { navigate };

function useRoute(): PersonRoute {
  const read = () => parsePersonRoute(location.pathname, location.search);
  const [route, setRoute] = useState<PersonRoute>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return route;
}

/** Her counters: reload when one moves (she never gets State, ids or titles over it). */
function useTicks(enabled: boolean, onTick: () => void): void {
  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') return;
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/p/events`, ['jantar']);
      ws.onmessage = (e) => {
        try {
          if ((JSON.parse(String(e.data)) as { kind?: string }).kind === 'tick') onTick();
        } catch {
          /* ignore */
        }
      };
      ws.onclose = (e) => {
        if (stop || e.code === 4401) return;
        retry = setTimeout(open, 5000);
      };
    };
    open();
    return () => {
      stop = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [enabled, onTick]);
}

export function App({ api }: { api: PersonApi }) {
  const route = useRoute();
  const [me, setMe] = useState<PersonMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.me().then(
      (m) => {
        setMe(m);
        setError(null);
      },
      (e: unknown) => {
        if (e instanceof PersonApiError && (e.status === 401 || e.status === 404)) setMe(null);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, [api]);
  const needsMe = route.name !== 'join' && route.name !== 'link';
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (needsMe) load();
  }, [needsMe, load]);
  const onTick = useCallback(() => {
    load();
    setTick((n) => n + 1);
  }, [load]);
  useTicks(needsMe && me !== null, onTick);

  if (route.name === 'join' || route.name === 'link') return <Join api={api} mode={route.name} />;
  if (route.name === 'left') return <Left me={me} api={api} />;
  if (route.name === 'notFound') return <Page title="Not here">This page isn't part of your space.</Page>;
  if (!me) {
    return (
      <Page title="Not linked yet">
        <p>{error ?? 'Loading…'}</p>
        <p className="mt-12 text-ink-2">
          If this app isn't linked yet, open your invite link again, or on a linked device open Me › Devices › Link another device and
          enter the code on <a className="underline" href="/p/link">this page</a>.
        </p>
      </Page>
    );
  }
  if (me.person.state === 'left') return <Left me={me} api={api} />;
  return (
    <div className="mx-auto flex min-h-dvh max-w-[42rem] flex-col">
      <Banner me={me} />
      <main className="flex-1 px-16 pb-96 pt-16">
        <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
          {route.name === 'today' ? <Today me={me} api={api} reload={load} tick={tick} /> : null}
          {route.name === 'review' ? <Review me={me} api={api} day={route.day} tick={tick} /> : null}
          {route.name === 'todos' ? <Todos me={me} api={api} tick={tick} /> : null}
          {route.name === 'health' ? <Health api={api} tab={route.tab} week={route.week} tick={tick} /> : null}
          {route.name === 'journal' ? <Journal me={me} api={api} id={route.id} checkin={route.checkin} tick={tick} /> : null}
          {route.name === 'alerts' ? <Alerts me={me} api={api} id={route.id} tick={tick} /> : null}
          {route.name === 'me' ? <Me me={me} api={api} reload={load} tab={route.tab} /> : null}
        </Suspense>
      </main>
      <TabBar route={route} />
    </div>
  );
}

/** Today · To-do · Journal · More (P2: Chat joins in P3; More holds Health, Alerts and Me, and Lists in P4). */
function TabBar({ route }: { route: PersonRoute }) {
  const [more, setMore] = useState(false);
  const inMore = route.name === 'health' || route.name === 'alerts' || route.name === 'me';
  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-[42rem]">
        <TabLink to="/p" label="Today" on={route.name === 'today' || route.name === 'review'} />
        <TabLink to="/p/todos" label="To-do" on={route.name === 'todos'} />
        <TabLink to="/p/journal" label="Journal" on={route.name === 'journal'} />
        <button type="button" aria-current={inMore ? 'page' : undefined} onClick={() => setMore(true)} className={`flex min-h-44 flex-1 items-center justify-center text-row ${inMore ? 'font-medium text-ink' : 'text-ink-2'}`}>
          More
        </button>
      </div>
      <Sheet open={more} onOpenChange={setMore} title="More">
        <div className="flex flex-col pb-24" onClick={() => setMore(false)}>
          <TabLink to="/p/health" label="Health" on={route.name === 'health'} />
          <TabLink to="/p/alerts" label="Alerts" on={route.name === 'alerts'} />
          <TabLink to="/p/me" label="Me" on={route.name === 'me'} />
        </div>
      </Sheet>
    </nav>
  );
}

function TabLink({ to, label, on }: { to: string; label: string; on: boolean }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
      aria-current={on ? 'page' : undefined}
      className={`flex min-h-44 flex-1 items-center justify-center text-row ${on ? 'font-medium text-ink' : 'text-ink-2'}`}
    >
      {label}
    </a>
  );
}

function Banner({ me }: { me: PersonMe }) {
  const owner = me.owner.name;
  let text: string | null = null;
  if (!me.peopleOn) text = `${owner} turned sharing off for now. You can still download your data or leave.`;
  else if (me.person.state === 'paused') text = `Paused: ${owner} can see but not add or send.`;
  else if (me.person.state === 'ending') text = `${owner} ended sharing. Download your data before ${me.person.endingUntil?.slice(0, 10) ?? 'the end of the week'}.`;
  if (!text) return null;
  return (
    <div role="status" className="border-b border-line bg-hover px-16 py-12 text-small">
      {text}
    </div>
  );
}

export function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[42rem] px-16 py-24">
      <h1 className="mb-12 text-title font-semibold">{title}</h1>
      <div className="text-row">{children}</div>
    </div>
  );
}
