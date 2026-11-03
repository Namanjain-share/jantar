/**
 * The places, in rail and tab order, with their Phosphor icons (v0.4, D2):
 * Board, Today, Chat (v0.10, Ask in v0.5.3), Files, Accounts, Alerts, Devices, Intel,
 * Meetings (v0.5), Accountability partner (v0.11, `people`: its label is PEOPLE_LABEL,
 * "Partner" on a phone tab); Today, Chat, Files, Intel, Meetings and People only
 * while their switch is on (and Chat and People only on a device paired with control:
 * the callers pass data.ts usePlaceFeatures). Chat sits right after Today, so with Life
 * and Chat on it is a phone tab and Accounts moves into More. The rail lists
 * every place that is on. The phone has room for five tabs: with more
 * places on, the fifth tab is More, holding the rest (its badge is theirs
 * added up).
 *
 * 0.12: the touch sidebar and rail (TouchNav.tsx) follow the same order.
 * `group` places each in the sidebar: the top list, or the Library (Intel,
 * Meetings); Accounts and Devices leave the touch list for the accounts
 * strip and the ⋯ menu (`touch: false`), and stay in ⌘K, ⌘5, ⌘7 and the g
 * chords. Today's six places, nested under Today in the sidebar, are in
 * life.ts (their icons load with the sidebar and Today, not the shell).
 * Accountability partner is the top list's last place there, as "Partner"
 * (its `short`) in the 220 sidebar and the 64 wide rail label, with the full
 * label as its name.
 */
import {
  BellIcon,
  BookmarksIcon,
  ChartBarHorizontalIcon,
  ChatCircleDotsIcon,
  DeviceMobileIcon,
  DotsThreeIcon,
  FilesIcon,
  ListBulletsIcon,
  SunIcon,
  VideoConferenceIcon,
  type Icon,
} from '@phosphor-icons/react';
import type { Features } from '@jantar/protocol';
import { LIFE_ROUTES, type Route } from '../../lib/router.js';
import { PeopleGlyph } from './people-glyph.js';

export interface NavItem {
  route: Route['name'];
  href: string;
  label: string;
  /** A shorter label for a phone tab, where the full one would be cut off (the rail and More show `label`). */
  short?: string;
  icon: Icon;
  /** Shown only while this switch is on (Files: v0.3; Life and the shelf: v0.4; Meetings: v0.5; Chat: v0.10, the `ask` switch; People: v0.11). */
  feature?: 'files' | 'life' | 'intel' | 'meetings' | 'ask' | 'people';
  /** 0.12, the touch sidebar: the top list or the Library. */
  group?: 'top' | 'library';
  /** 0.12: false keeps it out of the touch sidebar and rail (Accounts: the strip; Devices: ⋯). */
  touch?: boolean;
}

export const NAV: readonly NavItem[] = [
  { route: 'board', href: '/', label: 'Board', icon: ListBulletsIcon },
  { route: 'today', href: '/today', label: 'Today', icon: SunIcon, feature: 'life' },
  { route: 'chat', href: '/chat', label: 'Chat', icon: ChatCircleDotsIcon, feature: 'ask' },
  { route: 'files', href: '/files', label: 'Files', icon: FilesIcon, feature: 'files' },
  { route: 'accounts', href: '/accounts', label: 'Accounts', icon: ChartBarHorizontalIcon, touch: false },
  { route: 'alerts', href: '/alerts', label: 'Alerts', icon: BellIcon },
  { route: 'devices', href: '/devices', label: 'Devices', icon: DeviceMobileIcon, touch: false },
  { route: 'intel', href: '/intel', label: 'Intel', icon: BookmarksIcon, feature: 'intel', group: 'library' },
  { route: 'meetings', href: '/meetings', label: 'Meetings', icon: VideoConferenceIcon, feature: 'meetings', group: 'library' },
  // v0.11: last, so on a phone it sits in More.
  // The words are people-core's PEOPLE_LABEL and PEOPLE_SHORT_LABEL, spelled out: importing them here would pull
  // people-core into the main load (test/v011-nav.test.tsx compares).
  { route: 'people', href: '/people', label: 'Accountability partner', short: 'Partner', icon: PeopleGlyph, feature: 'people' },
];

/**
 * The places the touch sidebar and rail list (no Accounts, no Devices): the top list, then the Library,
 * each in nav order, so the rail keeps the sidebar's order (Accountability partner, last in NAV, is the
 * top list's last place, above Intel and Meetings).
 */
export function touchItems(features: Readonly<Features>): NavItem[] {
  const items = navItems(features).filter((item) => item.touch !== false);
  return [...items.filter((item) => item.group !== 'library'), ...items.filter((item) => item.group === 'library')];
}

/** The phone's fifth tab when more than five places are on. */
export const MORE: NavItem = { route: 'more', href: '/more', label: 'More', icon: DotsThreeIcon };

/** At most this many tabs on a phone. */
export const MAX_TABS = 5;

/** The places this daemon offers: every one whose switch is on (the rail). */
export function navItems(features: Readonly<Features>): NavItem[] {
  return NAV.filter((item) => !item.feature || features[item.feature]);
}

/** The phone's tabs: every place when five or fewer are on, else the first four and More with the rest. */
export function tabItems(features: Readonly<Features>): { tabs: NavItem[]; more: NavItem[] } {
  const on = navItems(features);
  if (on.length <= MAX_TABS) return { tabs: on, more: [] };
  return { tabs: [...on.slice(0, MAX_TABS - 1), MORE], more: on.slice(MAX_TABS - 1) };
}

/**
 * Whether `item` is the current place: the Board tab while a session is
 * open, Today on any Life screen, More on More and on the places it holds.
 */
export function isCurrent(item: NavItem, route: Route['name'], more: readonly NavItem[] = []): boolean {
  if (item.route === route) return true;
  if (item.route === 'board') return route === 'session';
  if (item.route === 'today') return LIFE_ROUTES.includes(route);
  if (item.route === 'more') return more.some((m) => isCurrent(m, route));
  return false;
}
