/**
 * Cmd-K: jump to a session or an account. cmdk's <Command> inside a Base UI
 * Dialog (never Command.Dialog, which is Radix and injects styles). --raised,
 * 10 px radius, the one shadow, over the scrim. 0.12: in every chrome (c11),
 * 600 wide at safe top + 56 and never centred, its list as tall as the
 * visual viewport leaves (the on-screen keyboard can't hide it), 44 rows on
 * touch (kit.css .palette-popup, c27).
 *
 * 0.13.0 (W22, design 9): "Search or jump", and the phone's search sheet
 * too (the header's magnifier opens it on every screen, F1). Typing two
 * characters or more asks `GET /v1/search` once it stops for 150 ms (only
 * on a device with control: the route is a control read), and its groups
 * come first, in its order: Clients, Projects, Deals, Todos, Meetings, then
 * the Sessions the phone already knows (at once, with their glyphs), then
 * Intel, Cafés and Posts. Then the places that are on (Work…), and the
 * accounts. "Search Intel only" (the magnifier's old way to the shelf)
 * stays the last row while Intel is on. The palette filters its own rows
 * and keeps the daemon's: they matched on words the row may not show (a
 * phone number, a note). An answer is shown only for the words it was
 * asked for. The search's words are his own and only ever go in the query
 * of an owner route. A search that fails (the Mac out of reach, life.db
 * broken) says the daemon's sentence, never "Nothing matches.". On the
 * phone the sheet has Cancel beside the box (design 6.2).
 */
import { Dialog } from '@base-ui/react/dialog';
import { Command, defaultFilter } from 'cmdk';
import { useEffect, useMemo, useState } from 'react';
import { boardOrder, machineName } from '@jantar/protocol';
import type { SearchGroup, SearchItem, SearchKind } from '@jantar/protocol/work';
import { errorText } from '../../lib/api.js';
import { NO_FIVE_HOUR_LIMIT, accountId, accountName, ago, noFiveHourLimit } from '../../lib/format.js';
import { routePath } from '../../lib/router.js';
import { useApp, useDeps, useNavigate } from '../context.js';
import { Keycap } from '../kit/Keycap.js';
import { StatusGlyph } from '../kit/StatusGlyph.js';
import { glyphStateOf } from '../kit/glyph.js';
import { NewSessionItem } from '../screens/new/PaletteItem.js';
import { hasMachines } from '../screens/session/Info.js';
import { SEARCH_MIN, workClient } from '../screens/work/client.js';
import { useLayer } from '../kit/layer.js';
import { usePlaceFeatures } from './data.js';
import { useLayout } from './layout.js';
import { pairedWithControl } from './lifeStatus.js';
import { navItems } from './nav.js';

/** The search waits this long after the last key (design 9). */
export const SEARCH_WAIT_MS = 150;

const ROW = 'flex h-40 cursor-pointer items-center gap-8 pl-16 pr-20 aria-selected:bg-select coarse:h-44';

/** The daemon's groups' headings, in its order. Sessions are the phone's own list (it knows them all, with glyphs). */
const GROUP_LABEL: Record<SearchKind, string> = {
  client: 'Clients',
  project: 'Projects',
  deal: 'Deals',
  todo: 'Todos',
  meeting: 'Meetings',
  session: 'Sessions',
  intel: 'Intel',
  place: 'Cafés',
  post: 'Posts',
};
/** The daemon's groups that come before the phone's Sessions; the rest come after it. */
const BEFORE_SESSIONS: readonly SearchKind[] = ['client', 'project', 'deal', 'todo', 'meeting'];

/** An app path the daemon answered (one of ours, never another origin). */
function appPath(href: string): string | null {
  return href.startsWith('/') && !href.startsWith('//') ? href : null;
}

/**
 * A result's second line, at most 3/5 of its row (0.13.0), so a deal's long client name is cut and the
 * row never runs sideways on a phone. 0.13.1: its last part ("Fixture Labs and Sample Trading Company ·
 * Contacted": a deal's stage, a client's state, a session's status) stays whole and the part before it
 * gives way first; cut as one, the stage went ("… · Cont…") while the client's name stayed.
 */
function ResultSub({ text }: { text: string }) {
  const cut = text.lastIndexOf(' · ');
  const head = cut > 0 ? text.slice(0, cut) : null;
  const tail = cut > 0 ? text.slice(cut + 3) : text;
  return (
    <span data-sub className="ml-auto flex min-w-0 max-w-3/5 flex-none pl-12 type-mono text-ink-3">
      {head !== null ? (
        <span data-sub-head className="min-w-0 truncate">
          {head}
        </span>
      ) : null}
      {/* A no-break space: the line's own " · ", which white-space: nowrap would drop at the start of a box. */}
      <span data-sub-tail className="max-w-full flex-none truncate">
        {head !== null ? `\u00a0· ${tail}` : tail}
      </span>
    </span>
  );
}

/**
 * GET /v1/search for `query` once typing stops (150 ms), the older ask cancelled: its groups, and the
 * words they are for (an answer for older words is never shown for newer ones).
 */
function useSearch(query: string, on: boolean): { groups: SearchGroup[]; busy: boolean; error: unknown } {
  const { api } = useDeps();
  const q = query.trim();
  const ask = on && q.length >= SEARCH_MIN;
  const [found, setFound] = useState<{ q: string; groups: SearchGroup[]; error?: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ask) {
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      workClient(api)
        .search(q, abort.signal)
        .then(
          (r) => {
            if (abort.signal.aborted) return;
            setFound({ q, groups: r.groups });
            setBusy(false);
          },
          (error: unknown) => {
            if (abort.signal.aborted) return;
            setFound({ q, groups: [], error });
            setBusy(false);
          },
        );
    }, SEARCH_WAIT_MS);
    return () => {
      clearTimeout(t);
      abort.abort();
    };
  }, [api, ask, q]);
  const mine = ask && found?.q === q ? found : null;
  return { groups: mine?.groups ?? [], busy: ask && busy, error: mine?.error ?? null };
}

export function Palette({ open, onOpenChange, now }: { open: boolean; onOpenChange: (o: boolean) => void; now: number }) {
  const layer = useLayer();
  const { keyboard, chrome } = useLayout();
  const state = useApp((s) => s.state);
  const navigate = useNavigate();
  const features = usePlaceFeatures();
  const sessions = useMemo(() => boardOrder(state), [state]);
  // v0.6: once a machine is paired, each session names its machine, and a machine's name finds its sessions.
  const machines = hasMachines(state);
  const accounts = useMemo(() => Object.values(state.accounts).sort((a, b) => a.id - b.id), [state]);
  const places = navItems(features);
  const [query, setQuery] = useState('');
  // A new opening starts empty.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const found = useSearch(query, open && pairedWithControl());
  const q = query.trim();
  /** The palette's own rows, filtered and ranked as cmdk would, best first (the daemon's are kept as it answered them). */
  const matches = (value: string) => !q || defaultFilter(value, q) > 0;
  const ranked = <T,>(items: readonly T[], value: (t: T) => string): T[] =>
    q
      ? items
          .map((t, i) => ({ t, i, score: defaultFilter(value(t), q) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .map((x) => x.t)
      : [...items];
  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  const daemonGroup = (g: SearchGroup) =>
    g.kind === 'session' ? null : (
      <Command.Group key={g.kind} heading={GROUP_LABEL[g.kind]}>
        {g.items.map((it: SearchItem) => {
          const to = appPath(it.href);
          return to ? (
            <Command.Item key={`${it.kind}:${it.id}`} value={`found ${it.kind} ${it.id}`} onSelect={() => go(to)} className={ROW}>
              <span className="min-w-0 truncate type-row font-medium">{it.label}</span>
              {it.sub ? <ResultSub text={it.sub} /> : null}
            </Command.Item>
          ) : null;
        })}
      </Command.Group>
    );
  const shownSessions = ranked(sessions, (s) => `${s.folder} ${s.name ?? ''} ${machines ? machineName(state, s.node) : ''} ${s.sid}`);
  const shownPlaces = ranked(places, (p) => `${p.label} ${p.short ?? ''} go to place`);
  const shownAccounts = ranked(accounts, (a) => `account ${accountName(a.id, a)}`);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <Dialog.Portal container={layer}>
        <Dialog.Backdrop className="fixed inset-0 z-35 bg-scrim animate-fade" />
        <Dialog.Popup className="palette palette-popup fixed left-1/2 z-40 -translate-x-1/2 overflow-hidden rounded-dock bg-raised text-ink shadow-float outline-none animate-pop">
          <Dialog.Title className="sr-only">Search or jump</Dialog.Title>
          <Command label="Search or jump" loop shouldFilter={false}>
            <div className="flex items-center border-b border-line">
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search or jump"
                className="block h-52 min-w-0 flex-1 bg-transparent px-20 type-input text-ink outline-none"
              />
              {/* The phone's sheet has no keys to close it: Cancel, beside the box (design 6.2). */}
              {chrome === 'phone' ? (
                <Dialog.Close className="h-52 flex-none px-16 type-row text-ink-2 transition-colors duration-120 ease-hover hover:text-ink">Cancel</Dialog.Close>
              ) : null}
            </div>
            <Command.List className="no-scrollbar overflow-auto py-4">
              {found.busy ? (
                <Command.Loading>
                  <p className="px-20 py-8 type-small text-ink-3">Searching…</p>
                </Command.Loading>
              ) : found.error ? (
                // A failed search says why (the Mac out of reach, life.db's sentence), never "Nothing matches.".
                <p role="alert" className="px-20 py-12 type-small text-ink-2">
                  {errorText(found.error)}
                </p>
              ) : (
                <Command.Empty className="px-20 py-12 type-small text-ink-3">Nothing matches.</Command.Empty>
              )}
              {matches('new session in a folder start launch') ? <NewSessionItem onSelect={() => go('/new')} /> : null}
              {found.groups.filter((g) => BEFORE_SESSIONS.includes(g.kind)).map(daemonGroup)}
              {shownSessions.length ? (
                <Command.Group heading="Sessions">
                  {shownSessions.map((s) => (
                    <Command.Item
                      key={s.sid}
                      value={`session ${s.sid}`}
                      onSelect={() => go(`/s/${encodeURIComponent(s.sid)}`)}
                      className={ROW}
                    >
                      <StatusGlyph state={glyphStateOf(state, s, now)} />
                      <span className="type-row font-medium">{s.folder}</span>
                      <span className="min-w-0 truncate type-row text-ink-2">{s.name}</span>
                      {machines ? <span className="ml-auto flex-none pl-12 type-mono text-ink-3">{machineName(state, s.node)}</span> : null}
                      <span className={machines ? 'flex-none pl-12 type-mono text-ink-3' : 'ml-auto pl-12 type-mono text-ink-3'}>{ago(s.statusSince, now)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {found.groups.filter((g) => !BEFORE_SESSIONS.includes(g.kind)).map(daemonGroup)}
              {shownPlaces.length ? (
                <Command.Group heading="Places">
                  {shownPlaces.map((p) => {
                    const Icon = p.icon;
                    return (
                      <Command.Item key={p.route} value={`place ${p.route}`} onSelect={() => go(p.href)} className={ROW}>
                        <Icon size={16} aria-hidden="true" className="flex-none text-ink-2" />
                        <span className="type-row">{p.label}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
              {shownAccounts.length ? (
                <Command.Group heading="Accounts">
                  {shownAccounts.map((a) => {
                    // 0.14.0: the 5-hour window's % only (never a weekly one's as "5h"), or no 5-hour limit.
                    const w = a.windows.find((x) => x.kind === 'five_hour');
                    const five = noFiveHourLimit(a) ? NO_FIVE_HOUR_LIMIT : w ? `5h ${Math.round(w.pct)}` : null;
                    return (
                      <Command.Item key={a.id} value={`account ${a.id}`} onSelect={() => go('/accounts')} className={ROW}>
                        <span className="w-16 type-mono text-ink">{accountId(a.id)}</span>
                        <span className="min-w-0 truncate type-row text-ink-2">{a.alias ?? a.emailMasked}</span>
                        {five ? <span className="ml-auto pl-12 type-mono text-ink-3">{five}</span> : null}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
              {/* The magnifier's old way to the shelf (v0.5.3), last: the shelf's own search, with these words. */}
              {features.intel ? (
                <Command.Item
                  value="search intel only"
                  onSelect={() => go(routePath({ name: 'intel', ...(q ? { q: q.slice(0, 200) } : {}), focus: 'search' }))}
                  className={ROW}
                >
                  <span className="type-row text-ink-2">Search Intel only</span>
                  <span aria-hidden="true" className="ml-auto pl-12 text-ink-3">
                    ›
                  </span>
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
          {/* The keys, with a keyboard only (the phone's search sheet has none). */}
          {keyboard ? (
            <div className="flex h-32 items-center gap-6 border-t border-line px-16 type-mono text-ink-3">
              <Keycap size="sm">↑</Keycap>
              <Keycap size="sm">↓</Keycap> move<span aria-hidden="true">·</span>
              <Keycap size="sm">↵</Keycap> open<span aria-hidden="true">·</span>
              <Keycap size="sm">esc</Keycap> close
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
