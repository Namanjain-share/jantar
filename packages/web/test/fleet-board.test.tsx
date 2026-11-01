/**
 * v0.6 Fleet on the Board (spec 0.3 and 6): once a machine is paired every
 * row names its machine before the account ("Mac" for the hub's own), the
 * account comes from that machine (a config dir by its alias), an offline
 * machine's rows are muted with "offline since 14:02", the order is the
 * one needs-you-first list across machines, and there is no filter row.
 * With no machine paired (or an older daemon that sends no `nodes`) the
 * Board is exactly v0.5's. Alerts from a machine start with its name.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { boardOrder, emptyState } from '@jantar/protocol';
import { ledgerGroups, deskAlerts } from '../src/ui/screens/board/model.js';
import { subjectOf } from '../src/ui/screens/alerts/model.js';
import { account, alert, NOW, pending, renderApp, session, stateWith } from './helpers.js';
import { fleetNodes, fleetState, IDS, SID } from './fleet-helpers.js';

const row = (sid: string) => document.querySelector<HTMLElement>(`a[data-sid="${sid}"]`)!;
const chip = (sid: string) => row(sid).querySelector<HTMLElement>('[data-machine]');
const acct = (sid: string) => row(sid).querySelector<HTMLElement>('[data-acct]');

describe('the machine chip', () => {
  it('names every row\'s machine once a machine is paired: "Mac" for the hub\'s own', () => {
    renderApp({ state: fleetState({ sessions: [session('a', { status: 'idle' })], accounts: [account(1)] }) });
    expect(chip('a')?.textContent).toBe('Mac');
    expect(chip(SID.tmux)?.textContent).toBe('build-1');
    expect(chip(SID.cswap)?.textContent).toBe('build-2');
    expect(chip(SID.windows)?.textContent).toBe('win-1');
    expect(chip(SID.mac)?.textContent).toBe('mini-1');
    expect(chip(SID.offline)?.textContent).toBe('build-3');
    // Before the account, on line 2.
    const line2 = row(SID.tmux).querySelector<HTMLElement>('[data-line2]')!;
    expect(line2.contains(chip(SID.tmux))).toBe(true);
    expect(chip(SID.tmux)!.compareDocumentPosition(acct(SID.tmux)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads a server's account from that server: a config dir by its alias, cswap by its number and %", () => {
    // The Mac's account 1 is at 42%: a server's account 1 must not borrow it.
    renderApp({ state: fleetState({ sessions: [session('a')], accounts: [account(1)] }) });
    expect(acct(SID.tmux)?.textContent).toMatch(/^claude/);
    expect(acct(SID.work)?.textContent).toMatch(/^work/);
    expect(acct(SID.cswap)?.textContent).toContain('01');
    expect(acct(SID.cswap)?.textContent).toContain('35');
    expect(acct(SID.cswap)?.textContent).not.toContain('42');
    expect(acct('a')?.textContent).toContain('42');
  });

  it('mutes an offline machine\'s rows and says since when, where the age was', () => {
    renderApp({ state: fleetState() });
    const off = row(SID.offline);
    expect(off.querySelector('[data-offline]')).not.toBeNull();
    expect(off.textContent).toContain('offline since 14:02');
    expect(row(SID.tmux).querySelector('[data-offline]')).toBeNull();
  });

  it('keeps one needs-you-first list across machines, and no filter row', () => {
    const s = fleetState({ sessions: [session('a', { status: 'working' }), session('b', { status: 'waiting' })], pending: [pending('b')] });
    renderApp({ state: s });
    const order = [...document.querySelectorAll<HTMLElement>('a[data-sid]')].map((a) => a.dataset.sid);
    const groups = ledgerGroups(s, NOW);
    expect(order).toEqual(groups.flatMap((g) => g.rows.map((r) => r.sid)));
    expect(groups[0]?.key).toBe('needs');
    expect(groups[0]?.rows.map((r) => r.sid)).toEqual(expect.arrayContaining(['b', SID.tmux]));
    expect(boardOrder(s).length).toBe(order.length);
    // No machine filter: no group of machine buttons anywhere on the Board.
    expect(screen.queryByRole('group', { name: /machine/i })).toBeNull();
  });

  it('shows on an ended row too (line 1, which is all it has)', () => {
    const s = fleetState({ sessions: [session('e', { status: 'ended' })] });
    renderApp({ state: s });
    expect(chip('e')?.textContent).toBe('Mac');
  });
});

describe('with no machine paired', () => {
  it('draws no chip and the v0.5 row, with nodes empty or absent', () => {
    for (const nodes of [{}, undefined]) {
      const s = stateWith({ sessions: [session('a', { status: 'idle' })], accounts: [account(1)] });
      if (nodes) s.nodes = nodes;
      else delete s.nodes;
      const { unmount } = renderApp({ state: s });
      expect(document.querySelector('[data-machine]')).toBeNull();
      expect(row('a').querySelector('[data-offline]')).toBeNull();
      expect(acct('a')?.textContent).toContain('01');
      unmount();
    }
  });

  it('keeps the row model as v0.5 had it (no machine)', () => {
    const s = stateWith({ sessions: [session('a')] });
    expect(ledgerGroups(s, NOW)[0]?.rows[0]?.machine).toBeNull();
  });
});

describe('alerts from a machine', () => {
  it('start with the machine on the Desk and in the Alerts timeline', () => {
    const s = fleetState({ alerts: [alert('x', { sid: SID.tmux, node: IDS.build1 }), alert('y')] });
    const desk = deskAlerts(s, '');
    expect(desk.find((d) => d.alert.id === 'x')?.subject).toBe('build-1 · api-server · fix-tests');
    expect(desk.find((d) => d.alert.id === 'y')?.subject).toBe('web-app · fix login');
    expect(subjectOf(s.alerts[0]!, s.sessions, s.nodes)).toBe('build-1 · api-server · fix-tests');
    // Without the machines (as before Fleet), the subject is the session's.
    expect(subjectOf(s.alerts[0]!, s.sessions)).toBe('api-server · fix-tests');
    expect(subjectOf(s.alerts[0]!, s.sessions, {})).toBe('api-server · fix-tests');
    expect(subjectOf(alert('z', { node: IDS.build3, label: 'Working · tools · export' }), {}, fleetNodes())).toBe('build-3 · tools · export');
    const empty = emptyState();
    expect(deskAlerts({ ...empty, alerts: [alert('y')] }, '')[0]?.subject).toBe('web-app · fix login');
  });
});
