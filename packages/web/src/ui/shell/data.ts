/**
 * Shell-wide derived data, computed once from the store: the strip, the
 * needs-you count, new alerts, the per-account 5h pairs, the ceiling and the
 * v0.3 feature switches. Every selector returns the store's own objects or
 * memoised values.
 */
import { useMemo } from 'react';
import {
  NO_FEATURES,
  boardOrder,
  machineName,
  needsYou,
  pendingFor,
  type AccountsMode,
  type Features,
  type LaunchJob,
  type PendingRequest,
  type State,
} from '@jantar/protocol';
import { accountId, ago, fiveHourPct } from '../../lib/format.js';
import { readLocal } from '../../lib/storage.js';
import { useApp } from '../context.js';
import { GLYPH_WORD, glyphStateOf, type GlyphState } from '../kit/glyph.js';
import type { StripItem } from '../kit/Strip.js';
import { ALERTS_SEEN_KEY } from '../screens/Alerts.js';
import { useCanStart } from '../screens/new/machines.js';
import { hasMachines } from '../screens/session/Info.js';

/** The autoswitch ceiling: read from /v1/plan through one shared feed. */
export { DEFAULT_CEILING, useCeiling } from '../plan.js';

/**
 * Which v0.3 features the Mac has switched on (daemon.version). Everything
 * is off until the daemon says otherwise, so nothing new shows on an older
 * daemon or before the first sync.
 */
export function useFeatures(): Readonly<Features> {
  return useApp((s) => s.state.daemon?.features) ?? NO_FEATURES;
}

/**
 * v0.4: one Claude login ("single") or cswap's accounts. A daemon from
 * before v0.4 sends none: cswap, as it always was. Single hides usage,
 * holds and autoswitch.
 */
export function useAccountsMode(): AccountsMode {
  return useApp((s) => s.state.daemon?.accountsMode) ?? 'cswap';
}

const KIND_WORD: Record<PendingRequest['kind'], string> = {
  question: 'Question',
  permission: 'Permission',
  plan: 'Plan',
  'subagent-info': 'Subagent waiting',
};

/** "Question", "Permission · Bash", "Plan", "Waiting in the terminal". */
export function needsWord(state: State, sid: string): string {
  const open = pendingFor(state, sid).find((p) => p.state === 'open' && p.kind !== 'subagent-info');
  if (!open) return 'Waiting in the terminal';
  if (open.kind === 'permission') return `Permission · ${open.tool}`;
  return KIND_WORD[open.kind];
}

export function stripItems(state: State, now: number): StripItem[] {
  // v0.6: once a machine is paired, each label names its machine (the same repo may run on ten).
  const machines = hasMachines(state);
  return boardOrder(state).map((s) => {
    const g: GlyphState = glyphStateOf(state, s, now);
    const word = g === 'needs' ? needsWord(state, s.sid) : GLYPH_WORD[g];
    const age = ago(s.statusSince, now);
    return { id: s.sid, state: g, label: [s.folder, machines ? machineName(state, s.node) : '', word, age].filter(Boolean).join(' · ') };
  });
}

/**
 * Launches waiting on a startup dialog's card (U8), oldest first: the ghost
 * rows whose glyph is needs-you. Their session has no row yet (Claude
 * writes it past the trust dialog), so the sessions alone miss them.
 */
export function launchesNeedingYou(state: State): LaunchJob[] {
  return Object.values(state.launches ?? {})
    .filter((j) => j.stage === 'dialog' && !Object.hasOwn(state.sessions, j.sid))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Sessions that need you, and, while starting is on somewhere (the Mac or a server), launches waiting on a dialog card. */
export function needsCount(state: State, launchOn = false): number {
  let n = 0;
  for (const sid of Object.keys(state.sessions)) if (needsYou(state, sid)) n += 1;
  return launchOn ? n + launchesNeedingYou(state).length : n;
}

export interface UsagePair {
  id: string;
  /** 5-hour % (rounded), or null with no reading. */
  pct: number | null;
}

export function usagePairs(state: State, now: number = Date.now()): UsagePair[] {
  return Object.values(state.accounts)
    .sort((a, b) => a.id - b.id)
    .map((a) => ({ id: accountId(a.id), pct: fiveHourPct(a, now) }));
}

export function useNeedsCount(): number {
  const state = useApp((s) => s.state);
  // Each machine's own switch, as the Board's ghost rows: a server's launch counts with the Mac's starting off.
  const launch = useCanStart();
  return useMemo(() => needsCount(state, launch), [state, launch]);
}

export function useStripItems(now: number): StripItem[] {
  const state = useApp((s) => s.state);
  return useMemo(() => stripItems(state, now), [state, now]);
}

export function useUsagePairs(now: number): UsagePair[] {
  const state = useApp((s) => s.state);
  return useMemo(() => usagePairs(state, now), [state, now]);
}

/** Alerts newer than the last visit to the Alerts screen (0 while it is open). */
export function useNewAlerts(onAlerts: boolean): number {
  const alerts = useApp((s) => s.state.alerts);
  return useMemo(() => {
    if (onAlerts) return 0;
    const seen = readLocal<string>(ALERTS_SEEN_KEY, '');
    return alerts.filter((a) => a.ts > seen).length;
  }, [alerts, onAlerts]);
}
