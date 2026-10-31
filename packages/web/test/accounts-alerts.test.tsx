import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Alert, Move } from '@jantar/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeLocal } from '../src/lib/storage.js';
import { buildRows, burnText, displayLine, sortRows } from '../src/ui/screens/accounts/model.js';
import { dayLabel, dur } from '../src/ui/screens/accounts/time.js';
import { ALERTS_SEEN_KEY } from '../src/ui/screens/Alerts.js';
import { sentenceOf, subjectOf } from '../src/ui/screens/alerts/model.js';
import { NOW, account, alert, fakeApi, iso, renderApp, session, stateWith } from './helpers.js';

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

afterEach(() => vi.unstubAllGlobals());

const plan = (over: object = {}) => ({
  source: 'ccw-legacy' as const,
  next: null,
  accounts: [],
  updatedAt: iso(0),
  ceiling: 97,
  weeklyCeiling: 95,
  ...over,
});

describe('accounts model', () => {
  it('formats burn, durations and the display line', () => {
    expect([burnText(36), burnText(6), burnText(4.2), burnText(null)]).toEqual(['+36%/h', '+6%/h', '+4.2%/h', '–']);
    expect([dur(12 * 60_000), dur(122 * 60_000), dur(20_000)]).toEqual(['12m', '2h02', '<1m']);
    const s = stateWith({
      accounts: [
        account(1, { windows: [{ kind: 'five_hour', pct: 40, resetsAt: iso(3 * 3600_000) }] }),
        account(2, {
          windows: [{ kind: 'five_hour', pct: 80, resetsAt: iso(2 * 3600_000) }],
          projection: { burnPctPerMin: 0.6, fullInMin: 20, ridesReset: false, usable: true },
        }),
      ],
    });
    const rows = buildRows(s, null, 97, NOW);
    expect(rows[1]?.fullAt).toBe(NOW + 20 * 60_000);
    expect(displayLine(rows)).toBe('1 account runs out before its reset');
    expect(displayLine(buildRows(s, null, 80, NOW))).toBe('1 account past the ceiling');
    expect(displayLine(rows.slice(0, 1))).toBe('All accounts under the ceiling');
    // most headroom first
    expect(sortRows(rows, 'headroom', 97).map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('accounts screen (phone)', () => {
  const accounts = [
    account(2, {
      alias: 'side',
      windows: [
        { kind: 'seven_day', pct: 35, resetsAt: '2026-01-18T10:05:00.000Z' },
        { kind: 'five_hour', pct: 91, resetsAt: '2026-01-15T12:18:00.000Z' },
        { kind: 'scoped:Opus', pct: 12 },
      ],
      projection: { burnPctPerMin: 1.4, fullInMin: 45, ridesReset: false, usable: true },
      held: true,
    }),
    account(1, { isDefaultLogin: true, usageStatus: 'token_expired', windows: [] }),
  ];

  it('shows each account as a two-line row that expands', () => {
    renderApp({
      path: '/accounts',
      state: stateWith({ accounts, sessions: [session('web-app', { account: 2 }), session('docs', { account: 2, status: 'idle' })], activeAccount: 1 }),
    });
    expect(screen.getByText('1 account runs out before its reset').hasAttribute('data-display')).toBe(true);
    const list = screen.getByRole('list', { name: 'Accounts' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getAllByRole('button')[0]!.getAttribute('aria-label'))).toEqual(['01', '02 side']);
    const two = rows[1]!;
    const meter = within(two).getByRole('meter', { name: '02 side 5-hour usage' });
    expect(meter.getAttribute('aria-valuenow')).toBe('91');
    expect(within(two).getByText(/^in 2h13 ·/)).toBeTruthy();
    expect(within(two).getByText(/^full ~\d\d:\d\d$/)).toBeTruthy();
    expect(within(two).getByText('held')).toBeTruthy();
    const one = rows[0]!;
    expect(within(one).getByText('token expired')).toBeTruthy();
    expect(within(one).getByText('no reading')).toBeTruthy();
    expect(within(one).getByRole('meter').getAttribute('aria-valuetext')).toBe('no reading');

    fireEvent.click(within(two).getByRole('button', { name: '02 side' }));
    expect(within(two).getByRole('button', { name: '02 side' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(two).getAllByRole('meter').map((m) => m.getAttribute('aria-label'))).toEqual([
      '02 side 5-hour usage',
      '02 side Weekly usage',
      '02 side Weekly · Opus usage',
    ]);
    expect(two.textContent).toMatch(/At \+84%\/h it is full at ~\d\d:\d\d, 1h28 before the \d\d:\d\d reset\./);
    const group = within(two).getByRole('group', { name: '2 sessions on this account' });
    expect(within(group).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/s/docs', '/s/web-app']);

    fireEvent.click(within(one).getByRole('button', { name: '01' }));
    expect(one.textContent).toContain('The login token expired');
    expect(within(one).getByText('default login')).toBeTruthy();
  });

  it("shows ccw's read-only next account and the ceiling from /v1/plan", async () => {
    const api = fakeApi({ getPlan: vi.fn(async () => plan({ next: 2, ceiling: 90 })) });
    renderApp({ path: '/accounts', api, state: stateWith({ accounts }) });
    // 91% is past a 90% ceiling, which read-scope devices get from /v1/plan
    expect(await screen.findByText('1 account past the ceiling')).toBeTruthy();
    expect(screen.getByText('next → 02')).toBeTruthy();
    expect(screen.getByText('ccw decides while it runs')).toBeTruthy();
    expect(screen.getByText('90%')).toBeTruthy();
    expect(screen.getByText('next →')).toBeTruthy();
  });

  it('asks for a usage refresh and shows a failure inline', async () => {
    const api = fakeApi({ refreshUsage: vi.fn(async () => ({ queued: false, reason: 'refreshed 20 s ago', nextAllowedAt: null })) });
    renderApp({ path: '/accounts', api, state: stateWith({ accounts }) });
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('Not refreshed: refreshed 20 s ago')).toBeTruthy();
    api.refreshUsage.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('boom');
  });

  it('sorts by headroom and says so in the URL', () => {
    const three = [account(1, { windows: [{ kind: 'five_hour', pct: 70, resetsAt: iso(3600_000) }] }), account(2), account(3, { windows: [] })];
    const { history } = renderApp({ path: '/accounts', state: stateWith({ accounts: three }) });
    const ids = () => within(screen.getByRole('list', { name: 'Accounts' })).getAllByRole('listitem').map((r) => within(r).getAllByRole('button')[0]!.getAttribute('aria-label'));
    expect(ids()).toEqual(['01', '02', '03']);
    fireEvent.click(screen.getByRole('button', { name: 'Headroom' }));
    expect(screen.getByRole('button', { name: 'Headroom' }).getAttribute('aria-pressed')).toBe('true');
    expect(ids()).toEqual(['03', '02', '01']); // 0% (no window), 42%, 70%
    expect(history.entries.at(-1)).toBe('/accounts?sort=headroom');
    fireEvent.click(screen.getByRole('button', { name: 'Number' }));
    expect(history.entries.at(-1)).toBe('/accounts');
  });

  it('draws moves as lanes and names the held accounts', () => {
    const move: Move = { sid: 'search', from: 4, to: 8, step: 'restarting', why: '5-hour window at 92%', since: iso(240_000), folder: 'search', name: 'index rebuild' };
    const s = stateWith({ accounts: [account(4), account(6, { held: true }), account(8)], sessions: [session('search', { account: 4, move })] });
    s.moves = { search: move };
    renderApp({ path: '/accounts', state: s });
    const moves = screen.getByRole('region', { name: /Moves/ });
    expect(within(moves).getByRole('img', { name: 'Move from 04 to 08, in progress' })).toBeTruthy();
    expect(within(moves).getByText('04 → 08')).toBeTruthy();
    expect(within(moves).getByText('restarting · moved 1m ago')).toBeTruthy();
    expect(moves.textContent).toContain('Held account 06 is left out of autoswitch. Its lane is dashed.');
  });

  it('has an empty state', () => {
    renderApp({ path: '/accounts', state: stateWith({}) });
    expect(screen.getByText('No accounts yet')).toBeTruthy();
  });
});

describe('accounts screen (desktop matrix)', () => {
  const accounts = [
    account(3, {
      alias: 'work',
      windows: [
        { kind: 'five_hour', pct: 98, resetsAt: iso(2 * 3600_000) },
        { kind: 'seven_day', pct: 63, resetsAt: iso(3 * 86400_000) },
      ],
      projection: { burnPctPerMin: 0.5, fullInMin: 0, ridesReset: false, usable: false },
    }),
    account(4, { alias: 'build', disabled: true }),
  ];

  it('lays out the matrix with sessions as cells and expands a row in words', async () => {
    viewport(1440);
    const { history } = renderApp({
      path: '/accounts',
      state: stateWith({ accounts, sessions: [session('web-app', { account: 3, status: 'idle' }), session('api', { account: 3 })] }),
    });
    const table = screen.getByRole('table', { name: 'Accounts' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Acct',
      '5h %',
      'Runway · now to reset',
      'Resets',
      '7d %',
      'Burn',
      'Sessions',
      'Flags',
    ]);
    expect(screen.getByText('1 account past the ceiling')).toBeTruthy();
    const meters = within(table).getAllByRole('meter').map((m) => m.getAttribute('aria-label'));
    expect(meters).toEqual(['03 work 5-hour usage', '03 work Weekly usage', '04 build 5-hour usage', '04 build Weekly usage']);
    expect(within(table).getByText('98').className).toContain('text-signal-text');
    expect(screen.getByText('+30%/h')).toBeTruthy();
    expect(screen.getByText('disabled')).toBeTruthy();

    const cells = within(table).getByRole('group', { name: '2 sessions on this account' });
    fireEvent.mouseEnter(within(cells).getAllByRole('link')[0]!);
    expect(screen.getByRole('tooltip').textContent).toBe('web-app · task web-app · Your turn · 5m');

    // An account that runs out before its reset opens with the reason in words (dir-k.html);
    // the rest stay folded until asked.
    const toggle = within(table).getByRole('button', { name: '03 work' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(table).getByRole('button', { name: '04 build' }).getAttribute('aria-expanded')).toBe('false');
    expect(table.textContent).toMatch(/It is past the 97% ceiling\. At \+30%\/h it is full at ~\d\d:\d\d, 1h55 before the \d\d:\d\d reset\./);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(table.textContent).not.toMatch(/It is past the 97% ceiling/);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(within(cells).getAllByRole('link')[1]!);
    await waitFor(() => expect(history.entries.at(-1)).toBe('/s/api'));
  });

  it('names autoswitch and shows Moves only while the legacy ccw tool runs', async () => {
    viewport(1440);
    const none = renderApp({ path: '/accounts', state: stateWith({ accounts }) });
    await waitFor(() => expect(none.api.getPlan).toHaveBeenCalled());
    const text = () => document.body.textContent ?? '';
    expect(text()).toContain('ceiling');
    expect(text()).not.toMatch(/autoswitch|Moves|No moves/);
    none.unmount();

    const api = fakeApi({ getPlan: vi.fn(async () => plan()) });
    renderApp({ path: '/accounts', api, state: stateWith({ accounts }) });
    expect(await screen.findByText(/autoswitch ceiling/)).toBeTruthy();
    expect(screen.getByRole('region', { name: /Moves/ }).textContent).toContain('No moves in progress.');
  });
});

describe('alerts model', () => {
  it('names the subject and joins what and why', () => {
    const sessions = { 'web-app': session('web-app', { name: 'fix login' }) };
    expect(subjectOf(alert('a', { sid: 'web-app' }), sessions)).toBe('web-app · fix login');
    expect(subjectOf(alert('a', { sid: 'gone', label: 'Working · api · refactor' }), sessions)).toBe('api · refactor');
    expect(subjectOf(alert('a', { label: 'acct 03', account: 3 }), sessions)).toBe('acct 03');
    expect(sentenceOf(alert('a', { what: 'Hit an API error: 529 overloaded.', why: 'Retried twice, then stopped.' }))).toBe(
      'Hit an API error: 529 overloaded. Retried twice, then stopped.',
    );
    expect(sentenceOf(alert('a', { what: 'Usage limit reached', why: 'five-hour window' }))).toBe('Usage limit reached · five-hour window');
    expect(dayLabel(NOW - 86400_000, NOW)).toBe('Yesterday');
  });
});

describe('alerts screen', () => {
  const alerts: Alert[] = [
    alert('a3', { kind: 'limit', ts: iso(90_000), label: 'Done · api · refactor', what: 'Usage limit reached', why: 'five-hour window' }),
    alert('a2', { kind: 'error', ts: iso(60_000), sid: 'web-app', what: 'API error 529', full: 'overloaded_error: try again' }),
    alert('a1', { kind: 'blocked', ts: iso(30_000), sid: 'gone', label: 'Working · landing · hero', what: 'Bash was blocked' }),
    alert('a0', { kind: 'rejected', ts: iso(-86400_000), label: 'Done · docs · notes', what: 'A prompt was rejected' }),
  ];
  const rowsText = (c: HTMLElement) => [...c.querySelectorAll('[data-alert]')].map((li) => li.getAttribute('data-alert'));

  it('lists alerts newest first under day rails, new ones marked', () => {
    const { container } = renderApp({ path: '/alerts', state: stateWith({ alerts, sessions: [session('web-app', { name: 'fix login' })] }) });
    expect(screen.getByText('4 new').hasAttribute('data-display')).toBe(true);
    expect(rowsText(container)).toEqual(['a3', 'a2', 'a1', 'a0']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Today', 'Yesterday']);
    expect(screen.getByText('web-app · fix login')).toBeTruthy();
    expect(screen.getByText('api · refactor')).toBeTruthy();
    expect(screen.getByText('landing · hero')).toBeTruthy();
    expect(screen.getByText('Usage limit reached · five-hour window')).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'New' })).toHaveLength(4);
    expect(screen.queryByText('Details')).toBeNull();
    // fewer than 21 alerts: no kind filters
    expect(screen.queryByRole('group', { name: 'Filter alerts' })).toBeNull();
  });

  it('shows what was seen before as seen', () => {
    writeLocal(ALERTS_SEEN_KEY, iso(60_000));
    renderApp({ path: '/alerts', state: stateWith({ alerts }) });
    expect(screen.getByText('1 new')).toBeTruthy();
    expect(document.querySelectorAll('[data-unseen]')).toHaveLength(1);
  });

  it('says nothing is new on a later visit', () => {
    writeLocal(ALERTS_SEEN_KEY, iso(90_000));
    renderApp({ path: '/alerts', state: stateWith({ alerts }) });
    expect(screen.getByText('Nothing new')).toBeTruthy();
  });

  it('expands a row inline to its full text', () => {
    viewport(1440);
    renderApp({ path: '/alerts', state: stateWith({ alerts, sessions: [session('web-app')] }) });
    const row = screen.getByRole('button', { name: /API error 529/ });
    expect(screen.queryByText('overloaded_error: try again')).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('overloaded_error: try again').tagName).toBe('PRE');
  });

  it('links to live sessions only, and limits to Accounts', async () => {
    viewport(1440);
    const { history } = renderApp({ path: '/alerts', state: stateWith({ alerts, sessions: [session('web-app')] }) });
    const links = screen.getAllByRole('link', { name: 'Open session' });
    expect(links.length).toBe(1);
    expect(screen.getAllByRole('link', { name: 'Open accounts' })).toHaveLength(1);
    fireEvent.click(links[0]!);
    await waitFor(() => expect(history.entries.at(-1)).toBe('/s/web-app'));
  });

  it('opens the action from the expanded row on a phone', () => {
    renderApp({ path: '/alerts', state: stateWith({ alerts, sessions: [session('web-app')] }) });
    expect(screen.queryByRole('link', { name: 'Open session' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /API error 529/ }));
    expect(screen.getByRole('link', { name: 'Open session' })).toBeTruthy();
    expect(screen.getByText('overloaded_error: try again')).toBeTruthy();
  });

  it('filters by kind past 20 alerts, in the URL', () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      alert(`m${i}`, { kind: i % 3 === 0 ? 'error' : 'blocked', ts: iso(-i * 60_000), what: `thing ${i}` }),
    );
    const { container, history } = renderApp({ path: '/alerts', state: stateWith({ alerts: many }) });
    const filters = screen.getByRole('group', { name: 'Filter alerts' });
    expect(within(filters).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['All 21', 'Errors 7', 'Blocked 14']);
    fireEvent.click(within(filters).getByRole('button', { name: 'Errors 7' }));
    expect(rowsText(container)).toHaveLength(7);
    expect(history.entries.at(-1)).toBe('/alerts?kind=error');
  });

  it('mutes and unmutes pushes from the header', async () => {
    const api = fakeApi({ mute: vi.fn(async (m: number) => ({ mutedUntil: m ? iso(3600_000) : null })) });
    renderApp({ path: '/alerts', api, state: stateWith({ alerts }) });
    await waitFor(() => expect((screen.getByRole('button', { name: /Mute pushes/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Mute pushes/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mute 1 hour' }));
    expect(api.mute).toHaveBeenCalledWith(60);
    const muted = await screen.findByRole('button', { name: /Muted until \d\d:\d\d/ });
    fireEvent.click(muted);
    expect(screen.queryByRole('menuitem', { name: 'Mute 8 hours' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unmute' }));
    expect(api.mute).toHaveBeenLastCalledWith(0);
    expect(await screen.findByRole('button', { name: /Mute pushes/ })).toBeTruthy();
  });

  it('has an empty state', () => {
    renderApp({ path: '/alerts', state: stateWith({}) });
    expect(screen.getByText('No alerts')).toBeTruthy();
    expect(screen.getByText('Limits, API errors, blocked tools and rejected prompts show up here with what happened.')).toBeTruthy();
  });
});
