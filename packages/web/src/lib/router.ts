/**
 * A tiny path router. Routes:
 *
 *   /               Board
 *   /s/:sid         Session (optional ?p=<pendingId>, or the daemon's push
 *                   link ?card=<pendingId>, to highlight a card). The view
 *                   rides in the query too, read by the session screen:
 *                   ?view=screen, or ?view=files&root=&path=&tab= (v0.3,
 *                   see sessionView / sessionViewPath).
 *   /files          v0.3 Files place (?root=&path=&tab=; hidden while Files is off)
 *   /new            v0.3 New session (?root=&path=, &start=1 opens the start
 *                   sheet, &account=<n> picks its account (a Board row's "New
 *                   session here"), &launch=<id> its receipt; hidden while
 *                   launching is off)
 *   /accounts       Accounts
 *   /alerts         Alerts
 *   /devices        Devices, pairing, notifications, theme
 *   /pair#c=<code>  Claim a pairing code (the code never leaves the fragment)
 *
 * v0.4, each shown only while its switch is on (Life: any module; the shelf):
 *   /today          Today (?dose=<medId>@<HHMM> opens the dose sheet, from a medicine push)
 *   /todos          Todos (?tab=todos|reminders|projects, ?project=<id>, ?id=<todo id>)
 *   /meds           Medicines (?day=YYYY-MM-DD, ?med=<id>)
 *   /food           Food, calories and weight (?day=)
 *   /places         Cafés (?filter=all|tried|want, ?id=)
 *   /money          Finance (?month=YYYY-MM, ?bill=<id>)
 *   /posts          v0.7 Posts (?filter=open|done, ?id=<post id> opens one, from a post's push)
 *   /intel          The Intel shelf (?q=, ?type=, ?tag=, ?item=<shelf id>; v0.5.3
 *                   ?focus=search, from the header's magnifier, focuses the search box)
 *   /more           The places past the fifth tab
 * v0.5, shown only while Meetings are on:
 *   /meetings       Meetings (?project=<project id>|none, ?q=, ?id=<meeting id> opens one)
 * v0.5.3, shown only while Ask is on:
 *   /ask            Ask: plain words in, suggested Life items out (no query)
 * Ids in a query are read only when they match their pattern (LifeId,
 * IntelId, day and month keys); anything else is left out.
 *
 * The daemon must answer these paths with index.html (SPA fallback); the
 * service worker also serves the cached shell for them once installed.
 */
import { createStore } from 'zustand/vanilla';

/** Where the files viewer stands: a root id, a relative path, and which tab of the viewer. */
export interface FilesLocation {
  root?: string;
  path?: string;
  /** The viewer's tabs: the file itself, or Claude's edits to it (no diffs: decision U9). */
  tab?: 'file' | 'edits';
}

export type Route =
  | { name: 'board' }
  | { name: 'session'; sid: string; pendingId?: string }
  | ({ name: 'files' } & FilesLocation)
  | { name: 'new'; root?: string; path?: string; start?: boolean; account?: number; launch?: string; from?: string }
  | { name: 'accounts' }
  | { name: 'alerts' }
  | { name: 'devices' }
  | { name: 'pair'; code: string | null }
  // v0.4
  | { name: 'today'; dose?: string }
  | { name: 'todos'; tab?: TodosTab; project?: string; id?: string }
  | { name: 'meds'; day?: string; med?: string }
  | { name: 'food'; day?: string }
  | { name: 'places'; filter?: PlacesFilter; id?: string }
  | { name: 'money'; month?: string; bill?: string }
  // v0.7, a Life screen too
  | { name: 'posts'; filter?: PostsFilter; id?: string }
  | { name: 'intel'; q?: string; type?: string; tag?: string; item?: string; focus?: 'search' }
  | { name: 'more' }
  // v0.5
  | { name: 'meetings'; project?: string; q?: string; id?: string }
  // v0.5.3
  | { name: 'ask' }
  | { name: 'notFound'; path: string };

export type TodosTab = 'todos' | 'reminders' | 'projects';
export type PlacesFilter = 'all' | 'tried' | 'want';
/** Posts to make (idea and ready), or the posted and skipped ones. */
export type PostsFilter = 'open' | 'done';

/** The Life screens (v0.4): Today's place in the tabs stands for all of them. */
export const LIFE_ROUTES: readonly Route['name'][] = ['today', 'todos', 'meds', 'food', 'places', 'money', 'posts'];

const LIFE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const DOSE_KEY = /^[0-9A-HJKMNP-TV-Z]{26}@([01]\d|2[0-3])[0-5]\d$/;
const INTEL_ID = /^[\x21-\x7e]{1,160}$/;

/** The query value when it matches `re` (and is not too long), else nothing. */
function matching(q: URLSearchParams, key: string, re: RegExp): string | undefined {
  const v = q.get(key);
  return v !== null && re.test(v) ? v : undefined;
}

/** A free-text query value (search, type, tag), capped. */
function text(q: URLSearchParams, key: string, max: number): string | undefined {
  const v = q.get(key);
  return v ? v.slice(0, max) : undefined;
}

/** `{ ...a }` without its undefined values, so a parsed route compares and serialises cleanly. */
function defined<T extends object>(r: T): T {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as T;
}

function lifeRoute(path: string, q: URLSearchParams): Route | null {
  switch (path) {
    case '/today':
      return defined({ name: 'today' as const, dose: matching(q, 'dose', DOSE_KEY) });
    case '/todos': {
      const tab = q.get('tab');
      return defined({
        name: 'todos' as const,
        tab: (tab === 'todos' || tab === 'reminders' || tab === 'projects' ? tab : undefined) as TodosTab | undefined,
        project: matching(q, 'project', LIFE_ID),
        id: matching(q, 'id', LIFE_ID),
      });
    }
    case '/meds':
      return defined({ name: 'meds' as const, day: matching(q, 'day', DAY_KEY), med: matching(q, 'med', LIFE_ID) });
    case '/food':
      return defined({ name: 'food' as const, day: matching(q, 'day', DAY_KEY) });
    case '/places': {
      const f = q.get('filter');
      const filter = (f === 'all' || f === 'tried' || f === 'want' ? f : undefined) as PlacesFilter | undefined;
      return defined({ name: 'places' as const, filter, id: matching(q, 'id', LIFE_ID) });
    }
    case '/money':
      return defined({ name: 'money' as const, month: matching(q, 'month', MONTH_KEY), bill: matching(q, 'bill', LIFE_ID) });
    case '/posts': {
      const f = q.get('filter');
      const filter = (f === 'open' || f === 'done' ? f : undefined) as PostsFilter | undefined;
      return defined({ name: 'posts' as const, filter, id: matching(q, 'id', LIFE_ID) });
    }
    case '/intel':
      return defined({
        name: 'intel' as const,
        q: text(q, 'q', 200),
        type: text(q, 'type', 40),
        tag: text(q, 'tag', 40),
        item: matching(q, 'item', INTEL_ID),
        focus: q.get('focus') === 'search' ? ('search' as const) : undefined,
      });
    case '/more':
      return { name: 'more' };
    case '/meetings': {
      const p = q.get('project');
      const project = p === 'none' || (p !== null && LIFE_ID.test(p)) ? p : undefined;
      return defined({ name: 'meetings' as const, project, q: text(q, 'q', 100), id: matching(q, 'id', LIFE_ID) });
    }
    default:
      return null;
  }
}

function queryOf(values: Record<string, string | undefined>): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) q.set(k, v);
  return q;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function filesLocation(q: URLSearchParams): FilesLocation {
  const out: FilesLocation = {};
  const root = q.get('root');
  const path = q.get('path');
  const tab = q.get('tab');
  if (root) out.root = root;
  if (path) out.path = path;
  if (tab === 'file' || tab === 'edits') out.tab = tab;
  return out;
}

function filesQuery(loc: FilesLocation, q = new URLSearchParams()): URLSearchParams {
  if (loc.root) q.set('root', loc.root);
  if (loc.path) q.set('path', loc.path);
  if (loc.tab) q.set('tab', loc.tab);
  return q;
}

function withQuery(path: string, q: URLSearchParams): string {
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** The views of a session screen (?view=). */
export type SessionView = 'transcript' | 'screen' | 'files';

/** The session screen's view and, for files, where its viewer stands, from a query string. */
export function sessionView(search: string): { view: SessionView; files: FilesLocation } {
  const q = new URLSearchParams(search);
  const v = q.get('view');
  const view: SessionView = v === 'screen' || v === 'files' ? v : 'transcript';
  return { view, files: view === 'files' ? filesLocation(q) : {} };
}

/** A session's path with its view (the transcript is the default and adds nothing). */
export function sessionViewPath(sid: string, view: SessionView, opts: { pendingId?: string; files?: FilesLocation } = {}): string {
  const q = new URLSearchParams();
  if (opts.pendingId) q.set('p', opts.pendingId);
  if (view !== 'transcript') q.set('view', view);
  if (view === 'files' && opts.files) filesQuery(opts.files, q);
  return withQuery(`/s/${encodeURIComponent(sid)}`, q);
}

export function parseRoute(pathname: string, search = '', hash = ''): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(search);
  if (path === '/') {
    // Older deep links: /?session=<sid>
    const legacy = q.get('session') ?? q.get('s');
    if (legacy) return { name: 'session', sid: legacy };
    return { name: 'board' };
  }
  const m = /^\/s\/([^/]+)$/.exec(path);
  if (m && m[1]) {
    // ?card= is what the daemon's Web Push links carry (notify/format.ts).
    const pendingId = q.get('p') || q.get('card') || undefined;
    return pendingId ? { name: 'session', sid: decode(m[1]), pendingId } : { name: 'session', sid: decode(m[1]) };
  }
  if (path === '/files') return { name: 'files', ...filesLocation(q) };
  if (path === '/new') {
    const r: Extract<Route, { name: 'new' }> = { name: 'new' };
    const root = q.get('root');
    const p = q.get('path');
    const launch = q.get('launch');
    const account = q.get('account');
    if (root) r.root = root;
    if (p) r.path = p;
    if (q.get('start') === '1') r.start = true;
    // An account id, as the Board row had it; anything else is left out (the form starts on Auto).
    if (account && /^\d{1,3}$/.test(account)) r.account = Number(account);
    if (launch) r.launch = launch;
    // "Try again" after a failed launch: the form starts from what that launch had.
    const from = q.get('from');
    if (from && /^[0-9A-Za-z]{1,64}$/.test(from)) r.from = from;
    return r;
  }
  const life = lifeRoute(path, q);
  if (life) return life;
  if (path === '/ask') return { name: 'ask' };
  if (path === '/accounts') return { name: 'accounts' };
  if (path === '/alerts') return { name: 'alerts' };
  if (path === '/devices') return { name: 'devices' };
  if (path === '/pair') {
    const frag = new URLSearchParams(hash.replace(/^#/, ''));
    const code = frag.get('c');
    return { name: 'pair', code: code && /^[A-Za-z0-9_-]{16,128}$/.test(code) ? code : null };
  }
  return { name: 'notFound', path };
}

export function routePath(r: Route): string {
  switch (r.name) {
    case 'board':
      return '/';
    case 'session':
      return `/s/${encodeURIComponent(r.sid)}${r.pendingId ? `?p=${encodeURIComponent(r.pendingId)}` : ''}`;
    case 'files':
      return withQuery('/files', filesQuery(r));
    case 'new': {
      const q = new URLSearchParams();
      if (r.root) q.set('root', r.root);
      if (r.path) q.set('path', r.path);
      if (r.start) q.set('start', '1');
      if (r.account !== undefined) q.set('account', String(r.account));
      if (r.launch) q.set('launch', r.launch);
      if (r.from) q.set('from', r.from);
      return withQuery('/new', q);
    }
    case 'accounts':
      return '/accounts';
    case 'alerts':
      return '/alerts';
    case 'devices':
      return '/devices';
    case 'pair':
      return '/pair';
    case 'today':
      return withQuery('/today', queryOf({ dose: r.dose }));
    case 'todos':
      return withQuery('/todos', queryOf({ tab: r.tab, project: r.project, id: r.id }));
    case 'meds':
      return withQuery('/meds', queryOf({ day: r.day, med: r.med }));
    case 'food':
      return withQuery('/food', queryOf({ day: r.day }));
    case 'places':
      return withQuery('/places', queryOf({ filter: r.filter, id: r.id }));
    case 'money':
      return withQuery('/money', queryOf({ month: r.month, bill: r.bill }));
    case 'posts':
      return withQuery('/posts', queryOf({ filter: r.filter, id: r.id }));
    case 'intel':
      return withQuery('/intel', queryOf({ q: r.q, type: r.type, tag: r.tag, item: r.item, focus: r.focus }));
    case 'more':
      return '/more';
    case 'meetings':
      return withQuery('/meetings', queryOf({ project: r.project, q: r.q, id: r.id }));
    case 'ask':
      return '/ask';
    case 'notFound':
      return r.path;
  }
}

export interface RouterState {
  route: Route;
  navigate(to: string | Route, opts?: { replace?: boolean }): void;
  back(): void;
}

export interface HistoryLike {
  readonly location: { pathname: string; search: string; hash: string };
  push(path: string): void;
  replace(path: string): void;
  back(): void;
  /** Subscribe to back/forward; returns an unsubscribe function. */
  listen(fn: () => void): () => void;
  /** How many entries this app pushed (to know whether "back" stays inside it). */
  readonly depth: number;
}

/** The browser's history. */
export function browserHistory(): HistoryLike {
  let depth = 0;
  return {
    get location() {
      return window.location;
    },
    push(path) {
      depth += 1;
      window.history.pushState(null, '', path);
    },
    replace(path) {
      window.history.replaceState(null, '', path);
    },
    back() {
      depth = Math.max(0, depth - 1);
      window.history.back();
    },
    listen(fn) {
      window.addEventListener('popstate', fn);
      return () => window.removeEventListener('popstate', fn);
    },
    get depth() {
      return depth;
    },
  };
}

/** In-memory history for tests. */
export function memoryHistory(initial = '/'): HistoryLike & { entries: string[] } {
  const entries = [initial];
  let index = 0;
  const listeners = new Set<() => void>();
  const loc = () => {
    const u = new URL(entries[index] ?? '/', 'http://local');
    return { pathname: u.pathname, search: u.search, hash: u.hash };
  };
  return {
    entries,
    get location() {
      return loc();
    },
    push(path) {
      entries.splice(index + 1);
      entries.push(path);
      index += 1;
    },
    replace(path) {
      entries[index] = path;
    },
    back() {
      if (index > 0) {
        index -= 1;
        for (const l of listeners) l();
      }
    },
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get depth() {
      return index;
    },
  };
}

export function createRouter(history: HistoryLike) {
  const current = () => {
    const { pathname, search, hash } = history.location;
    return parseRoute(pathname, search, hash);
  };
  const store = createStore<RouterState>()((set) => ({
    route: current(),
    navigate(to, opts) {
      const path = typeof to === 'string' ? to : routePath(to);
      const { pathname, search } = history.location;
      if (path === `${pathname}${search}` && !opts?.replace) return;
      if (opts?.replace) history.replace(path);
      else history.push(path);
      set({ route: current() });
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        try {
          window.scrollTo(0, 0);
        } catch {
          // jsdom
        }
      }
    },
    back() {
      if (history.depth > 0) {
        history.back();
      } else {
        history.replace('/');
        set({ route: current() });
      }
    },
  }));
  history.listen(() => store.setState({ route: current() }));
  return store;
}

export type Router = ReturnType<typeof createRouter>;
