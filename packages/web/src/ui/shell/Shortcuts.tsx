/**
 * Keyboard shortcuts and the legend (0.11, build plan 3.1 and c30;
 * ipad-design.md 4.3): the `?` overlay. **Keys** lists every shortcut, the
 * current place's first; **Legend** is what the squares mean. It opens with
 * ?, from the iPad sidebar's ⋯ → Keyboard shortcuts, and from Devices. On an
 * iPad it replaces the legend sheet: iPadOS has no hold-⌘ panel and a web
 * app can't add to the menu bar, so this is the only list. Its own chunk,
 * loaded on first open.
 *
 * In a browser tab (not the Home Screen app or an installed window), ⌘1–⌘9
 * and ⌘J can belong to the browser: the list says so, and that g then a
 * letter and the Chat button always work.
 */
import { useState } from 'react';
import type { Route } from '../../lib/router.js';
import { Button } from '../kit/Button.js';
import { Legend } from '../kit/Legend.js';
import { Sheet } from '../kit/Sheet.js';
import { Segmented } from '../screens/accounts/Segmented.js';

export interface KeyRow {
  keys: readonly string[];
  does: string;
}

export interface KeyGroup {
  id: 'anywhere' | 'board' | 'session' | 'lists' | 'life' | 'places' | 'posts' | 'chat' | 'sheets';
  title: string;
  rows: readonly KeyRow[];
}

/** Every shortcut, as 3.1's table has them. Each also has a control on screen. */
export const KEY_GROUPS: readonly KeyGroup[] = [
  {
    id: 'anywhere',
    title: 'Anywhere',
    rows: [
      { keys: ['⌘K'], does: 'Search or jump (⌃K outside a text field)' },
      { keys: ['⌘J'], does: 'Chat beside this screen' },
      { keys: ['⌘\\'], does: 'Show or hide the sidebar (iPad)' },
      { keys: ['⌘1–⌘9'], does: 'Board, Today, Chat, Files, Accounts, Alerts, Devices, Intel, Meetings' },
      { keys: ['g', 'b t c l a d i m f'], does: 'Board, Today, Chat, Alerts, Accounts, Devices, Intel, Meetings, Files' },
      { keys: ['Esc', '⌘.'], does: 'Back: close what is open' },
      { keys: ['⌘Z'], does: 'Undo the change shown on screen (outside a text field)' },
      { keys: ['?'], does: 'This list' },
    ],
  },
  {
    id: 'board',
    title: 'Board',
    rows: [
      { keys: ['j', 'k'], does: 'Next or previous session' },
      { keys: ['1–9'], does: 'Open the session waiting nth' },
      { keys: ['↵'], does: 'Open the first session waiting on you' },
    ],
  },
  {
    id: 'session',
    title: 'Session',
    rows: [
      { keys: ['a'], does: 'Allow, approve, or send the answer' },
      { keys: ['d'], does: 'Deny' },
      { keys: ['⌥1–⌥4'], does: "Pick a question's option" },
      { keys: ['⌘↵'], does: 'Send' },
      { keys: ['r'], does: 'Type to Claude' },
      { keys: ['t', 's', 'f'], does: 'Transcript, Screen, Files' },
      { keys: ['n'], does: 'Next session needing you' },
      { keys: ['⌘↑', '⌘↓'], does: 'Previous or next session waiting on you' },
      { keys: ['↑', '↓', '↵'], does: 'On the screen, with Keys open: move and Enter' },
    ],
  },
  {
    id: 'lists',
    title: 'Lists',
    rows: [
      { keys: ['↑', '↓'], does: 'Move (j and k too)' },
      { keys: ['↵'], does: 'Open beside the list' },
      { keys: ['Esc'], does: 'Close it, back to its row' },
      { keys: ['/'], does: 'Search this list' },
    ],
  },
  {
    id: 'life',
    title: 'Todos, Food, Money',
    rows: [
      { keys: ['c'], does: 'New' },
      { keys: ['e'], does: 'Edit the todo you are on' },
      { keys: ['x'], does: 'Mark it done' },
      { keys: ['⌫'], does: 'Delete it (with Undo)' },
    ],
  },
  {
    id: 'places',
    title: 'Cafés',
    rows: [
      { keys: ['c'], does: 'New café' },
      { keys: ['1–5'], does: "The open café's stars (with Undo)" },
      { keys: ['v'], does: 'Log a visit' },
    ],
  },
  {
    id: 'posts',
    title: 'Posts',
    rows: [
      { keys: ['c'], does: 'New post' },
      { keys: ['⌘C'], does: 'Copy the open post (with no text selected)' },
      { keys: ['m'], does: 'Mark it posted' },
      { keys: ['l'], does: 'Log a comment' },
    ],
  },
  {
    id: 'chat',
    title: 'Chat',
    rows: [
      { keys: ['↵'], does: 'Send' },
      { keys: ['⇧↵'], does: 'New line' },
      { keys: ['/'], does: 'Search the chat' },
      { keys: ['⌘⇧A'], does: 'Add a photo' },
    ],
  },
  {
    id: 'sheets',
    title: 'Sheets',
    rows: [
      { keys: ['⌘↵'], does: 'Save' },
      { keys: ['Esc', '⌘.'], does: 'Cancel' },
    ],
  },
];

/** The groups the place `route` uses most, shown first. */
const FIRST: Partial<Record<Route['name'], readonly KeyGroup['id'][]>> = {
  board: ['board'],
  session: ['session'],
  todos: ['life', 'lists'],
  food: ['life', 'lists'],
  money: ['life', 'lists'],
  meds: ['life'],
  places: ['places', 'lists'],
  posts: ['posts', 'lists'],
  intel: ['lists'],
  meetings: ['lists'],
  alerts: ['lists'],
  files: ['lists'],
  chat: ['chat'],
};

/** Every group, the current place's first, then the rest in their own order. */
export function groupsFor(route: Route['name']): KeyGroup[] {
  const first = FIRST[route] ?? [];
  return [...first.map((id) => KEY_GROUPS.find((g) => g.id === id)!), ...KEY_GROUPS.filter((g) => !first.includes(g.id))];
}

/** A browser tab, where the browser may keep ⌘1–⌘9 and ⌘J (not the Home Screen app, not an installed window). */
export function inBrowserTab(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return !standalone && !window.matchMedia('(display-mode: standalone)').matches && !window.matchMedia('(display-mode: window-controls-overlay)').matches;
}

// The list's keys are read, not hints: the mono type (12 px on a touch screen), not the 11 px keycap.
const KEY = 'inline-flex h-24 min-w-24 flex-none items-center justify-center rounded-chip border border-line-strong px-6 type-mono text-ink-2';

export function Shortcuts({ open, onOpenChange, route }: { open: boolean; onOpenChange: (open: boolean) => void; route: Route['name'] }) {
  const [tab, setTab] = useState<'keys' | 'legend'>('keys');
  const tabbed = inBrowserTab();
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      actions={
        <Button variant="text" size="lg" className="-mr-8" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <Segmented
        label="Keys or the legend"
        fill
        segments={[
          { key: 'keys', label: 'Keys' },
          { key: 'legend', label: 'Legend' },
        ]}
        value={tab}
        onChange={setTab}
        className="mb-12"
      />
      {tab === 'legend' ? (
        <Legend layout="stacked" />
      ) : (
        <div data-keys-list className="grid gap-16 pb-8">
          {tabbed ? (
            <p className="type-small text-ink-2">
              In a browser tab, the browser may keep ⌘1–⌘9 and ⌘J. g then a letter, and the Chat button, always work.
            </p>
          ) : null}
          {groupsFor(route).map((g) => (
            <section key={g.id} aria-label={g.title}>
              <h3 className="mb-4 type-rail text-ink-3">{g.title}</h3>
              <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-center gap-x-12 gap-y-6">
                {g.rows.map((r) => (
                  <div key={r.does} className="contents">
                    <dt className="flex flex-wrap items-center gap-4">
                      {r.keys.map((k) => (
                        <kbd key={k} className={KEY}>
                          {k}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="type-small text-ink">{r.does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </Sheet>
  );
}
