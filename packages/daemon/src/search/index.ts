/**
 * v0.13 Work: one search across Jantar (GET /v1/search?q=), for the
 * phone's header magnifier and the wide screens' palette.
 *
 * - No SQL here. Each group asks its own part, in the owner's space, so
 *   each keeps its own rules: the Todos module (projects, todos), Work
 *   (clients and deals, from P2 and P3), Meetings' library, the board's
 *   state (sessions), the Intel shelf, Cafés and Posts. The phone's text is
 *   matched in the daemon (foldText: any case or accent), never in SQL.
 * - A group answers only while its own part is on: Life's groups while
 *   life.db is open and their module (Work: life.work with Todos) is on,
 *   meetings while Meetings is on and meetings.db opens, Intel while the
 *   shelf is on; sessions always (the board is every device's).
 * - At most `limit` results per group, only groups with a match, in
 *   SEARCH_KINDS order. A group that fails is left out and logged by its
 *   kind alone: never the query, never a result.
 * - Labels are the items' own words (a control read on his host); links
 *   are app paths with ids only.
 */
import {
  IntelListQuerySchema,
  PlacesQuerySchema,
  SEARCH_KINDS,
  workOn,
  type ProjectView,
  type SearchItem,
  type SearchKind,
  type SearchResponse,
  type Session,
  type Settings,
  type Todo,
} from '@jantar/protocol';
import type { Actor, IntelService, LifeResult, LifeService, Logger, MeetingsService } from '../contracts.js';
import { foldText, holdsFolded } from '../core/fold.js';

/** What the search reads. Every part is asked on each call (a restore swaps life.db). */
export interface SearchDeps {
  settings(): Settings;
  life: LifeService;
  meetings: MeetingsService;
  intel: IntelService;
  /** The board's sessions (the store's state). */
  sessions(): Readonly<Record<string, Session>>;
  /** The Mac user's home folder: a session's folder is matched below it, so "Users" finds nothing. */
  home: string;
  log: Logger;
}

const LABEL_MAX = 200;

/** `text` cut to the schema's 200 characters. */
function clip(text: string, max = LABEL_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

const valueOr = <T>(r: LifeResult<T>, empty: T): T => (r.ok ? r.value : empty);

/** A project's link: its hub in Work while Work is on, else the Todos screen. */
function projectHref(id: string, s: Settings): string {
  return workOn(s) ? `/work?tab=projects&id=${id}` : `/todos?project=${id}`;
}

function projectSub(p: ProjectView): string | undefined {
  if (p.status !== 'active') return p.status;
  if (p.open === 0) return undefined;
  return p.overdue > 0 ? `${p.open} open · ${p.overdue} overdue` : `${p.open} open`;
}

function todoSub(t: Todo): string | undefined {
  if (t.doneAt) return 'done';
  if (!t.due) return undefined;
  return t.due.time ? `${t.due.day} ${t.due.time}` : t.due.day;
}

/** One group's results: at most `limit`, in the order its part gives them. */
type Group = (q: string, folded: string, limit: number, actor: Actor, d: SearchDeps, s: Settings) => SearchItem[];

const lifeOpen = (d: SearchDeps) => d.life.broken() === null;

const GROUPS: Readonly<Record<SearchKind, Group>> = {
  client: (q, _f, limit, actor, d, s) => {
    if (!workOn(s) || !lifeOpen(d)) return [];
    return valueOr(d.life.work.search(q, limit, actor), { clients: [], deals: [] }).clients;
  },

  project: (_q, folded, limit, _a, d, s) => {
    if (!s.life.todos || !lifeOpen(d)) return [];
    // Active first, then paused, then done, each by name: the projects list's order.
    const projects = valueOr(d.life.todos.listProjects(), { projects: [] }).projects;
    return projects
      .filter((p) => holdsFolded(folded, p.name, p.notes))
      .slice(0, limit)
      .map((p) => {
        const sub = projectSub(p);
        return { kind: 'project' as const, id: p.id, label: clip(p.emoji ? `${p.emoji} ${p.name}` : p.name), ...(sub ? { sub } : {}), href: projectHref(p.id, s) };
      });
  },

  deal: (q, _f, limit, actor, d, s) => {
    if (!workOn(s) || !lifeOpen(d)) return [];
    return valueOr(d.life.work.search(q, limit, actor), { clients: [], deals: [] }).deals;
  },

  todo: (q, _f, limit, _a, d, s) => {
    if (!s.life.todos || !lifeOpen(d)) return [];
    // Open ones by due first, then the newest done.
    const open = valueOr(d.life.todos.listTodos({ done: false, q }), { today: '', todos: [] as Todo[] }).todos;
    const done = open.length >= limit ? [] : valueOr(d.life.todos.listTodos({ done: true, q }), { today: '', todos: [] as Todo[] }).todos;
    return [...open, ...done].slice(0, limit).map((t) => {
      const sub = todoSub(t);
      return { kind: 'todo' as const, id: t.id, label: clip(t.title), ...(sub ? { sub } : {}), href: `/todos?id=${t.id}` };
    });
  },

  meeting: (q, _f, limit, _a, d, s) => {
    if (!s.meetings.enabled || d.meetings.broken() !== null) return [];
    return valueOr(d.meetings.library.search(q, limit), []).map((m) => ({ kind: 'meeting' as const, id: m.id, label: clip(m.name), sub: m.day, href: `/meetings?id=${m.id}` }));
  },

  session: (_q, folded, limit, _a, d) => {
    const home = d.home.replace(/\/+$/, '');
    const below = (cwd: string) => (cwd === home ? '' : cwd.startsWith(`${home}/`) ? cwd.slice(home.length + 1) : cwd);
    return Object.values(d.sessions())
      .filter((x) => holdsFolded(folded, x.name, x.folder, below(x.cwd)))
      .sort((a, b) => b.statusSince.localeCompare(a.statusSince) || a.sid.localeCompare(b.sid))
      .slice(0, limit)
      .map((x) => ({
        kind: 'session' as const,
        id: x.sid,
        label: clip(x.name ?? x.folder),
        sub: clip(x.name ? `${x.folder} · ${x.status}` : x.status),
        href: `/s/${encodeURIComponent(x.sid)}`,
      }));
  },

  intel: (q, _f, limit, _a, d, s) => {
    if (!s.intel.enabled) return [];
    // The shelf's own ranked search (title first), as its screen searches.
    const items = d.intel.list(IntelListQuerySchema.parse({ q, sort: 'best', limit })).items;
    return items.slice(0, limit).map((i) => ({
      kind: 'intel' as const,
      id: i.id,
      label: clip(i.title ?? i.url ?? i.id),
      ...(i.type ? { sub: clip(i.type) } : {}),
      href: `/intel?item=${encodeURIComponent(i.id)}`,
    }));
  },

  place: (q, _f, limit, _a, d, s) => {
    if (!s.life.places || !lifeOpen(d)) return [];
    // Cafés' own search (name, area, dishes, tags and notes), best first, as their screen searches.
    const places = valueOr(d.life.places.list(PlacesQuerySchema.parse({ q })), { places: [], tags: [], areas: [] }).places;
    return places.slice(0, limit).map((p) => ({ kind: 'place' as const, id: p.id, label: clip(p.name), ...(p.area ? { sub: clip(p.area) } : {}), href: `/places?id=${p.id}` }));
  },

  post: (_q, folded, limit, _a, d, s) => {
    if (!s.life.posts || !lifeOpen(d)) return [];
    const empty = { today: '', week: { from: '', to: '', posted: 0, goals: [] }, posts: [] };
    const posts = [...valueOr(d.life.posts.list({ done: false }), empty).posts, ...valueOr(d.life.posts.list({ done: true }), empty).posts];
    return posts
      .filter((p) => holdsFolded(folded, p.title, p.text))
      .slice(0, limit)
      .map((p) => ({ kind: 'post' as const, id: p.id, label: clip(firstLine(p.title ?? p.text ?? '') || p.platform), sub: clip(`${p.platform} · ${p.status}`), href: `/posts?id=${p.id}` }));
  },
};

/** Search every part that is on, for the owner. `q` is 2 to 80 characters, trimmed (the route's schema). */
export function searchAll(q: string, limit: number, actor: Actor, d: SearchDeps): SearchResponse {
  const s = d.settings();
  const folded = foldText(q);
  const groups: SearchResponse['groups'] = [];
  for (const kind of SEARCH_KINDS) {
    let items: SearchItem[];
    try {
      items = GROUPS[kind](q, folded, limit, actor, d, s).slice(0, limit);
    } catch (e) {
      d.log.warn('search group left out', { group: kind, error: e instanceof Error ? e.name : 'unknown' });
      continue;
    }
    if (items.length > 0) groups.push({ kind, items });
  }
  return { groups };
}
