/**
 * The fixture pages by name, and what each one builds (pages.ts renders
 * them; driver.ts builds them in the page). No Node import here: the
 * driver's bundle includes this file.
 */
import type { MeetOptions } from './meet.js';
import type { TeamsOptions } from './teams.js';

export type FixturePageSpec = { site: 'meet'; options: MeetOptions; title: string } | { site: 'teams'; options: TeamsOptions; title: string };

export const PAGE_SPECS = {
  'meet-call': { site: 'meet', options: { state: 'call' }, title: 'Meet – Weekly sync' },
  'meet-waiting': { site: 'meet', options: { state: 'waiting' }, title: 'Meet – Weekly sync' },
  'meet-renamed': { site: 'meet', options: { state: 'call', renamed: true }, title: 'Meet – Weekly sync' },
  'teams-v2': { site: 'teams', options: { layout: 'v2' }, title: 'Weekly sync | Microsoft Teams' },
  'teams-2026-bottom': { site: 'teams', options: { layout: '2026-bottom' }, title: 'Weekly sync | Microsoft Teams' },
  'teams-2026-right': { site: 'teams', options: { layout: '2026-right' }, title: 'Weekly sync | Microsoft Teams' },
  'teams-loose': { site: 'teams', options: { layout: 'loose' }, title: 'Weekly sync | Microsoft Teams' },
  'teams-lobby': { site: 'teams', options: { layout: '2026-bottom', state: 'lobby' }, title: 'Weekly sync | Microsoft Teams' },
  'teams-anon': { site: 'teams', options: { layout: 'v2', anon: true }, title: 'Meet now | Microsoft Teams' },
  // v0.9.1: the screens before the call (Start when I join).
  'meet-prejoin': { site: 'meet', options: { state: 'prejoin' }, title: 'Meet – Weekly sync' },
  'meet-lobby': { site: 'meet', options: { state: 'lobby' }, title: 'Meet – Weekly sync' },
  'teams-prejoin': { site: 'teams', options: { layout: '2026-bottom', state: 'prejoin' }, title: 'Weekly sync | Microsoft Teams' },
  'teams-waiting': { site: 'teams', options: { layout: '2026-bottom', state: 'waiting' }, title: 'Weekly sync | Microsoft Teams' },
  'teams-light-waiting': { site: 'teams', options: { layout: 'v2', state: 'waiting', light: true }, title: 'Weekly sync | Microsoft Teams' },
  // v0.9.1: calls whose captions are off (captions on when notes start): a light-meetings guest (More › Captions; the
  // guest's caption tree, shown once someone speaks), and Meet's "Captions and translation" pop-up.
  'teams-light-call': { site: 'teams', options: { layout: 'guest', light: true, hangupId: true, captions: false, lateRegion: true }, title: 'Weekly sync | Microsoft Teams' },
  'meet-popup-off': { site: 'meet', options: { state: 'call', cc: 'popup', captions: false }, title: 'Meet – Weekly sync' },
} satisfies Record<string, FixturePageSpec>;

/** v0.9.1: the fixture pages that open before the call (each reaches the call with `join`). */
export const BEFORE_CALL_PAGES: readonly string[] = ['meet-waiting', 'teams-lobby', 'meet-prejoin', 'meet-lobby', 'teams-prejoin', 'teams-waiting', 'teams-light-waiting'];

export type FixturePageName = keyof typeof PAGE_SPECS;

/** The fixture pages' background (MX3: what a shot shows where the hidden button sat). */
export const PAGE_BACKGROUND = 'rgb(47, 111, 79)';
