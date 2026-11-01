/**
 * v0.6 Fleet on the phone: the synthetic fleet the screen tests run against,
 * and the warm-up for the hook cards' own chunks. Every machine, name, path
 * and id here is made up (@jantar/fixtures' node snapshots).
 *
 *   build-1  Linux, tmux, 2 config dirs (claude, work): 3 sessions, one
 *            started outside tmux, one open card
 *   build-2  Linux (WSL), tmux, cswap, starting on, an older Jantar and
 *            link version
 *   win-1    native Windows: watch and cards only
 *   mini-1   another Mac: Terminal, cswap, starting on
 *   build-3  Linux, tmux, offline since 14:02, one session left
 *   ro-1     Linux, tmux, joined --read-only
 */
import { screen, waitFor } from '@testing-library/react';
import { beforeAll, expect } from 'vitest';
import type { NodeView, PendingRequest, Session, State } from '@jantar/protocol';
import {
  NODE_IDS,
  linuxCswapNodeSnapshot,
  linuxNodeSnapshot,
  macNodeSnapshot,
  nodeFeatures,
  nodeSession,
  nodeViewFixture,
  windowsNodeSnapshot,
} from '@jantar/fixtures';
import { NOW, pending, renderApp, session, stateWith } from './helpers.js';

export const IDS = {
  build1: NODE_IDS.build1,
  build2: NODE_IDS.build2,
  win1: NODE_IDS.win1,
  mini1: NODE_IDS.mini1,
  build3: NODE_IDS.big,
  ro1: '01JF1EETN0DER0N1Y00000000R',
} as const;

/** When build-3 went offline: today, local time, so the board reads "offline since 14:02". */
export const OFFLINE_AT = (() => {
  const d = new Date(NOW);
  d.setHours(14, 2, 0, 0);
  return d.toISOString();
})();

/** The sessions of the machines, by role. */
export const SID = {
  /** build-1, in tmux, waiting on a permission card. */
  tmux: '7a1c0000-0000-4000-8000-000000000001',
  /** build-1, in tmux, on the "work" config dir. */
  work: '7a1c0000-0000-4000-8000-000000000002',
  /** build-1, started outside tmux. */
  noPane: '7a1c0000-0000-4000-8000-000000000003',
  /** build-2 (cswap). */
  cswap: '7a1c0000-0000-4000-8000-000000000011',
  /** win-1. */
  windows: '7a1c0000-0000-4000-8000-000000000021',
  /** mini-1. */
  mac: '7a1c0000-0000-4000-8000-000000000031',
  /** build-3, offline. */
  offline: '7a1c0000-0000-4000-8000-000000000051',
  /** ro-1, read-only. */
  readOnly: '7a1c0000-0000-4000-8000-000000000061',
} as const;

const stamp = (sessions: Record<string, Session>, node: string): Session[] => Object.values(sessions).map((s) => ({ ...s, node }));

/** Every machine's view, as the Mac would send it. */
export function fleetNodes(): Record<string, NodeView> {
  const cswap = linuxCswapNodeSnapshot();
  const mac = macNodeSnapshot();
  const views: NodeView[] = [
    nodeViewFixture(),
    nodeViewFixture({
      id: IDS.build2,
      name: 'build-2',
      os: 'wsl',
      version: '0.5.9',
      problem: 'version',
      features: cswap.daemon.features,
      accountsMode: 'cswap',
      accounts: cswap.accounts,
      activeAccount: cswap.activeAccount,
      usage: cswap.usage,
    }),
    nodeViewFixture({
      id: IDS.win1,
      name: 'win-1',
      os: 'windows',
      backend: 'none',
      features: windowsNodeSnapshot().daemon.features,
      accounts: windowsNodeSnapshot().accounts,
    }),
    nodeViewFixture({
      id: IDS.mini1,
      name: 'mini-1',
      os: 'macos',
      backend: 'terminal-app',
      features: mac.daemon.features,
      accountsMode: 'cswap',
      accounts: mac.accounts,
      activeAccount: mac.activeAccount,
      usage: mac.usage,
    }),
    nodeViewFixture({ id: IDS.build3, name: 'build-3', online: false, since: OFFLINE_AT }),
    nodeViewFixture({ id: IDS.ro1, name: 'ro-1', readOnly: true, features: nodeFeatures({ launch: true }) }),
  ];
  return Object.fromEntries(views.map((v) => [v.id, v]));
}

/** The machines' sessions (stamped with their `node`) and build-1's open card. */
export function fleetSessions(): { sessions: Session[]; pending: PendingRequest[] } {
  const linux = linuxNodeSnapshot();
  return {
    sessions: [
      ...stamp(linux.sessions, IDS.build1),
      ...stamp(linuxCswapNodeSnapshot().sessions, IDS.build2),
      ...stamp(windowsNodeSnapshot().sessions, IDS.win1),
      ...stamp(macNodeSnapshot().sessions, IDS.mini1),
      { ...nodeSession({ sid: SID.offline, folder: 'tools', cwd: '/home/sam/code/tools', name: 'export', paneId: '%2' }), node: IDS.build3 },
      { ...nodeSession({ sid: SID.readOnly, folder: 'docs', cwd: '/home/sam/code/docs', name: 'notes', paneId: '%5', status: 'idle' }), node: IDS.ro1 },
    ],
    pending: Object.values(linux.pending),
  };
}

/** A state with the Mac's own parts (`stateWith`) plus the whole fleet. */
export function fleetState(parts: Parameters<typeof stateWith>[0] = {}): State {
  const fleet = fleetSessions();
  const s = stateWith({
    ...parts,
    sessions: [...(parts.sessions ?? []), ...fleet.sessions],
    pending: [...(parts.pending ?? []), ...fleet.pending],
  });
  s.nodes = fleetNodes();
  return s;
}

/**
 * The hook cards are their own chunks (v0.6): render each kind once before
 * a file's tests, so every test meets them loaded and can query them at
 * once, as before the split. Call it at the top of a test file.
 */
export function preloadCards(): void {
  beforeAll(async () => {
    const cards: Partial<PendingRequest>[] = [
      { kind: 'permission' },
      { kind: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Warm?', header: 'Warm', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] } },
      { kind: 'plan', tool: 'ExitPlanMode', input: { plan: '# Warm' } },
    ];
    for (const over of cards) {
      const r = renderApp({ path: '/s/warm', state: stateWith({ sessions: [session('warm', { status: 'waiting' })], pending: [pending('warm', over)] }) });
      await waitFor(() => expect(document.querySelector('[data-card-loading]')).toBeNull(), { timeout: 15_000 });
      expect(screen.getByRole('article')).toBeTruthy();
      r.unmount();
    }
  }, 30_000);
}
