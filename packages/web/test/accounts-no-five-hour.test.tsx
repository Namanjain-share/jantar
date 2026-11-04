/**
 * 0.14.0: an account with no 5-hour limit (cswap's usage has no fiveHour
 * at all, only weekly windows) next to one whose 5-hour window is there but
 * not started (pct 0, no reset: "no window open"). The first never reads as
 * 0%: Accounts' 5H % and BURN columns, its phone row closed and open, a
 * board row on the Mac, the session's meta line and property column, the
 * status bar and Cmd-K say "no 5-hour limit" (or "no limit" beside "5h"); the
 * second keeps 0 and "no window open". Both from a 0.14.0 daemon (its
 * noFiveHourLimit) and from an older one (windows alone). Made-up accounts.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Account, PlanResponse } from '@jantar/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FIVE_HOUR_LIMIT, fiveHourPct } from '../src/lib/format.js';
import { buildRows, displayLine, runwaySentence, sortRows } from '../src/ui/screens/accounts/model.js';
import { usagePairs } from '../src/ui/shell/data.js';
import { createLayoutStore, layoutAt } from '../src/ui/shell/layout.js';
import { NOW, account, fakeApi, iso, measureAs, opened, preloadPlaces, renderApp, session, stateWith } from './helpers.js';

preloadPlaces('accounts');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const WEEK = { kind: 'seven_day', pct: 50, resetsAt: iso(3 * 86_400_000) };
const MODEL = { kind: 'scoped:Model-A', pct: 70, resetsAt: iso(3 * 86_400_000) };
/** 01: a 5-hour window there but not started (cswap: pct 0 and no reset). */
const idle = account(1, { alias: 'main', windows: [{ kind: 'five_hour', pct: 0 }, { kind: 'seven_day', pct: 20, resetsAt: iso(3 * 86_400_000) }] });
/** 02: no 5-hour window at all, as a 0.14.0 daemon says it. */
const limitless = account(2, { alias: 'team-b', held: true, windows: [WEEK, MODEL], noFiveHourLimit: true });
/** 02 from a daemon before 0.14.0: no flag, the windows alone. */
const older: Account = (({ noFiveHourLimit: _, ...rest }) => rest)(limitless);
/** 03: a 5-hour window open, at 30. */
const busy = account(3, { windows: [{ kind: 'five_hour', pct: 30, resetsAt: iso(2 * 3_600_000) }, WEEK] });

/** ccw's plan as a daemon before 0.14.0 sent it: a 5-hour burn on 02 (Accounts drew +72%/h). */
const plan = (): PlanResponse => ({
  source: 'ccw-legacy',
  next: null,
  accounts: [
    { id: 1, burnPctPerMin: 0, ridesReset: true, usable: true },
    { id: 2, burnPctPerMin: 1.2, ridesReset: true, usable: false, weeklyCap: 50 },
    { id: 3, burnPctPerMin: 0.5, ridesReset: true, usable: true },
  ],
  updatedAt: iso(0),
  ceiling: 97,
  weeklyCeiling: 95,
});

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

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ');

describe.each([
  ['a 0.14.0 daemon', limitless],
  ['a daemon before 0.14.0', older],
] as const)('0.14.0 no 5-hour limit, from %s', (_from, two) => {
  const accounts = [idle, two, busy];

  it('the shared 5-hour reading: no number for it, 0 for a window not open', () => {
    expect(fiveHourPct(two, NOW)).toBeNull();
    expect(fiveHourPct(idle, NOW)).toBe(0);
    expect(usagePairs(stateWith({ accounts }), NOW)).toEqual([
      { id: '01', pct: 0 },
      { id: '02', pct: null, noLimit: true },
      { id: '03', pct: 30 },
    ]);
  });

  it("Accounts' model: no 5-hour %, reset, fill or burn for it, the plan's burn or not; a window not open is 0", () => {
    const state = stateWith({ accounts });
    const rows = buildRows(state, plan(), 97, NOW);
    const [one, r2] = rows;
    expect(r2).toMatchObject({ noLimit: true, h5: null, resetAt: null, fullAt: null, burnPerHour: null, past: false, d7: 50 });
    expect(one).toMatchObject({ noLimit: false, h5: 0, resetAt: null, burnPerHour: null });
    expect(runwaySentence(r2!, state, 97, NOW)[0]?.text).toBe('This account has no 5-hour limit: its weekly cap is what stops it.');
    expect(runwaySentence(buildRows(state, null, 97, NOW)[1]!, state, 97, NOW)[0]?.text).toBe('This account has no 5-hour limit: its weekly use is what stops it.');
    expect(runwaySentence(one!, state, 97, NOW)[0]?.text).toBe('No 5-hour window is open on this account.');
    // most 5-hour room: first by headroom
    expect(sortRows(rows, 'headroom', 97).map((r) => r.id)).toEqual([2, 1, 3]);
    // an account with only that reading is a reading
    expect(displayLine(buildRows(stateWith({ accounts: [two] }), null, 97, NOW))).toBe('All accounts under the ceiling');
  });

  it('the desktop matrix: "no 5-hour limit" in 5H %, no meter, runway words or burn; 01 keeps 0 and "no window open"', async () => {
    viewport(1440);
    measureAs(1384);
    renderApp({ path: '/accounts', api: fakeApi({ getPlan: vi.fn(async () => plan()) }), state: stateWith({ accounts }) });
    await opened('Accounts');
    const table = screen.getByRole('table', { name: 'Accounts' });
    await within(table).findByText('cap 50%');
    const rowOf = (name: string) => within(table).getByRole('button', { name }).closest('[role="row"]')!;
    const r2 = rowOf('02 team-b');
    const r1 = rowOf('01 main');
    const cells = (r: Element) => [...r.querySelectorAll('[role="cell"]')].map(text);
    // ACCT, 5H %, RUNWAY, RESETS, 7D %, BURN, SESSIONS, FLAGS
    expect(cells(r2)[1]).toBe(NO_FIVE_HOUR_LIMIT);
    expect(cells(r2)[2]).toBe(''); // no runway, and not "no window open"
    expect(cells(r2)[5]).toBe('–'); // never +72%/h
    expect(within(table).queryByRole('meter', { name: '02 team-b 5-hour usage' })).toBeNull();
    expect(within(table).getByRole('meter', { name: '02 team-b Weekly usage' })).toBeTruthy();
    expect(text(r2)).not.toMatch(/no window open|\+\d+%\/h/);
    expect(cells(r1)[1]).toBe('0');
    expect(cells(r1)[2]).toBe('no window open');
    expect(within(table).getByRole('meter', { name: '01 main 5-hour usage' }).getAttribute('aria-valuenow')).toBe('0');
    // the expanded row says it in words
    fireEvent.click(within(table).getByRole('button', { name: '02 team-b' }));
    expect(text(table)).toContain('This account has no 5-hour limit: its weekly cap is what stops it.');
  });

  it('a phone row, closed and open: "no 5-hour limit", never "0 5h · no window open"', async () => {
    renderApp({ path: '/accounts', api: fakeApi({ getPlan: vi.fn(async () => plan()) }), state: stateWith({ accounts }) });
    await opened('Accounts');
    const list = screen.getByRole('list', { name: 'Accounts' });
    const [one, r2] = within(list).getAllByRole('listitem');
    await within(r2!).findByText('cap 50%');
    expect(text(r2)).toBe(`02team-bheldcap 50%${NO_FIVE_HOUR_LIMIT}`);
    expect(text(r2)).not.toMatch(/05h|no window open|\+\d+%\/h/);
    expect(within(r2!).queryByRole('meter', { name: '02 team-b 5-hour usage' })).toBeNull();
    expect(text(one)).toContain('05h');
    expect(text(one)).toContain('no window open');
    fireEvent.click(within(r2!).getByRole('button', { name: '02 team-b' }));
    expect(text(r2)).toContain('This account has no 5-hour limit: its weekly cap is what stops it.');
    expect(text(r2)).not.toContain('No 5-hour window is open on this account.');
    expect(within(r2!).getByRole('meter', { name: '02 team-b Weekly usage' })).toBeTruthy();
    fireEvent.click(within(one!).getByRole('button', { name: '01 main' }));
    expect(text(one)).toContain('No 5-hour window is open on this account.');
  });

  it('a board row on the Mac: "02 · no limit" (5h no limit), never "5h 0 %"', () => {
    const sessions = [session('web', { account: 2, status: 'idle' }), session('api', { account: 1, status: 'idle' })];
    renderApp({ state: stateWith({ accounts, sessions }), layout: layoutAt(1440) });
    const acct = (sid: string) => document.querySelector<HTMLElement>(`a[data-sid="${sid}"] [data-acct]`);
    expect(text(acct('web'))).toBe('02 · 5h no limit');
    expect(acct('web')?.querySelector('[title]')?.getAttribute('title')).toBe(NO_FIVE_HOUR_LIMIT);
    expect(text(acct('api'))).toBe('01 · 5h 0%');
  });

  it('the status bar: "02 no limit", named in full on hover, never 0', () => {
    renderApp({ state: stateWith({ accounts, sessions: [session('web', { account: 2 })] }), layout: layoutAt(1440) });
    const pairs = screen.getByRole('button', { name: /5-hour usage per account/ });
    expect(pairs.textContent).toBe('5h01002no limit0330');
    expect(within(pairs).getByTitle(`02: ${NO_FIVE_HOUR_LIMIT}`).textContent).toBe('02no limit');
  });

  it('the session: the meta line and the property column say it, with no meter, resets or burn', () => {
    const sessions = [session('web', { account: 2 }), session('api', { account: 1 })];
    const withBurn = { ...two, projection: { burnPctPerMin: 1.2, ridesReset: true, usable: false } };
    const state = stateWith({ accounts: [idle, withBurn, busy], sessions });
    // 1440: the property column beside the transcript
    measureAs(944);
    const wide = renderApp({ path: '/s/web', state, layout: createLayoutStore(layoutAt(1440)) });
    const props = screen.getByRole('complementary', { name: 'Session properties' });
    const row = (k: string) => [...props.querySelectorAll('dt')].find((d) => d.textContent === k)?.parentElement ?? null;
    expect(text(row('5-hour')).replace(/^5-hour ?/, '')).toBe(NO_FIVE_HOUR_LIMIT);
    expect(row('Resets')).toBeNull();
    expect(row('Burn')).toBeNull();
    expect(within(props).queryByRole('meter')).toBeNull();
    wide.unmount();
    renderApp({ path: '/s/api', state, layout: createLayoutStore(layoutAt(1440)) });
    const p1 = screen.getByRole('complementary', { name: 'Session properties' });
    const row1 = (k: string) => [...p1.querySelectorAll('dt')].find((d) => d.textContent === k)?.parentElement ?? null;
    expect(text(row1('5-hour'))).toBe('5-hour0%');
    expect(text(row1('Resets'))).toBe('Resetsno window open');
  });

  it("the session's meta line: \"02 team-b · no 5-hour limit\", never \"5h 0\"", () => {
    measureAs(784);
    const state = stateWith({ accounts, sessions: [session('web', { account: 2 }), session('api', { account: 1 })] });
    const one = renderApp({ path: '/s/web', state, layout: createLayoutStore(layoutAt(1280)) });
    const line = () => [...document.querySelectorAll('p')].find((p) => p.textContent?.startsWith('02 team-b'));
    expect(text(line())).toMatch(/^02 team-b · no 5-hour limit( · |$)/);
    expect(text(line())).not.toMatch(/5h|resets/);
    one.unmount();
    renderApp({ path: '/s/api', state, layout: createLayoutStore(layoutAt(1280)) });
    const l1 = [...document.querySelectorAll('p')].find((p) => p.textContent?.startsWith('01 main'));
    expect(text(l1)).toMatch(/^01 main · 5h 0( · |$)/);
  });

  it('Cmd-K names it, and never a weekly % as "5h"', async () => {
    renderApp({ state: stateWith({ accounts }), layout: layoutAt(1440) });
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true });
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'team' } });
    await waitFor(() => expect(within(dialog).getByText('team-b')).toBeTruthy());
    const item = within(dialog).getByText('team-b').closest('[cmdk-item]');
    expect(text(item)).toBe(`02team-b${NO_FIVE_HOUR_LIMIT}`);
  });
});
