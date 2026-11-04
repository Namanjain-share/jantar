/**
 * 0.14.0 Switching rules: an account's weekly cap on its row (from ccw's
 * plan). Made-up accounts only.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRows, capText } from '../src/ui/screens/accounts/model.js';
import { dayClock } from '../src/ui/screens/accounts/time.js';
import { NOW, account, fakeApi, iso, opened, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('accounts');

afterEach(() => {
  vi.restoreAllMocks();
});

const UNTIL = iso(2 * 86_400_000 + 12 * 3_600_000);
const plan = (over: object = {}) => ({
  source: 'ccw-legacy' as const,
  next: null,
  accounts: [
    { id: 1, burnPctPerMin: 0, ridesReset: true, usable: true },
    { id: 2, burnPctPerMin: 0, ridesReset: true, usable: true, weeklyCap: 50, capUntil: UNTIL, nextCap: 75 },
  ],
  updatedAt: iso(0),
  ceiling: 97,
  weeklyCeiling: 95,
  ...over,
});
const accounts = [
  account(1, { windows: [{ kind: 'five_hour', pct: 20, resetsAt: iso(3_600_000) }, { kind: 'seven_day', pct: 30, resetsAt: iso(4 * 86_400_000) }] }),
  account(2, { alias: 'side', windows: [{ kind: 'five_hour', pct: 10, resetsAt: iso(3_600_000) }, { kind: 'seven_day', pct: 40, resetsAt: iso(4 * 86_400_000) }] }),
  account(3, { held: true }),
];

describe('0.14.0 the weekly cap on an account', () => {
  it('reads the cap from the plan and says it with the next one', () => {
    const rows = buildRows(stateWith({ accounts }), plan(), 97, NOW);
    expect(rows.map((r) => r.cap)).toEqual([null, { now: 50, until: Date.parse(UNTIL), next: 75 }, null]);
    expect(capText(rows[1]!.cap!, NOW)).toBe(`cap 50% · 75% ${dayClock(Date.parse(UNTIL), NOW)}`);
    expect(capText({ now: 95, until: null, next: null }, NOW)).toBe('cap 95%');
    expect(rows[1]!.flags.map((f) => f.text)).toContain('cap 50%');
    // a paired server's accounts have no ccw plan
    expect(buildRows(stateWith({ accounts }), plan({ source: 'none' }), 97, NOW).every((r) => r.cap === null)).toBe(true);
  });

  it('shows it beside the weekly use in the phone row', async () => {
    renderApp({ path: '/accounts', api: fakeApi({ getPlan: vi.fn(async () => plan()) }), state: stateWith({ accounts }) });
    await opened('Accounts');
    const list = screen.getByRole('list', { name: 'Accounts' });
    const two = within(list).getAllByRole('listitem')[1]!;
    expect(await within(two).findByText('cap 50%')).toBeTruthy(); // its flag on the closed row
    fireEvent.click(within(two).getByRole('button', { name: '02 side' }));
    expect(within(two).getByText(`cap 50% · 75% ${dayClock(Date.parse(UNTIL), NOW)}`)).toBeTruthy();
  });
});
