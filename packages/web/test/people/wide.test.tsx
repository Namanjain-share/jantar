/**
 * 0.12, the wide layouts meet v0.11 People (spec 9.10), with synthetic
 * people (Sam and Asha) and a fake People client:
 *
 * - From a pane of 800 his screen for her is a SplitPane: the header and the
 *   tabs one under the other in the list column, the tab (or the plan
 *   editor) beside them under its name: her Today as cards across the
 *   detail, a tab of rows 720 wide at most. Below 800, and on a phone, it is
 *   0.12's one column: the header, the tabs in a row, the tab.
 * - The tab's section is the same at every width: a plan being written stays
 *   when the pane crosses 800 (an iPad turned, a window dragged).
 * - The People list is 720 wide at most.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonToday, PersonView, PlanView } from '@jantar/protocol/people';
import { presetAgreement } from '@jantar/protocol/people-core';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import type { PeopleClient } from '../../src/ui/screens/people/client.js';
import { createLayoutStore, layoutAt, LayoutProvider, type Layout } from '../../src/ui/shell/layout.js';
import { fakeApi, measureAs } from '../helpers.js';

const PID = '01JASHAAAAAAAAAAAAAAAAAAAA';
const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';

function client(over: Partial<PeopleClient> = {}): PeopleClient {
  const base: Partial<PeopleClient> = {};
  return new Proxy(base as PeopleClient, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const person = (): PersonView =>
  ({ id: PID, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement: { ...presetAgreement('everything', 'P2'), version: 1 }, offer: null, pendingProposal: null }) as PersonView;

const planView = (): PlanView => ({
  day: DAY,
  plan: {
    id: '01JPLANAAAAAAAAAAAAAAAAAAA',
    day: DAY,
    srev: 3,
    steps: [{ id: 'STEPAAAAA1', title: 'Mock', at: '08:00', ask: 'none', ring: true, focus: false, by: '', status: 'todo' }],
    between: [],
    createdAt: AT,
    updatedAt: AT,
    sentAt: AT,
  },
  now: 'STEPAAAAA1',
  next: null,
  late: [],
  focus: null,
  slots: {},
  counts: { done: 0, total: 1 },
});

const today = (): PersonToday => ({
  day: DAY,
  name: 'Asha',
  state: 'active',
  todos: { open: 0, overdue: 0, due: [] },
  meds: null,
  weight: { latest: null },
  food: null,
  plan: planView(),
  status: { level: 'low', line: 'long day', at: AT, until: '2026-11-03T20:00:00.000Z' },
  review: null,
  sleep: { open: null },
  concerns: [],
});

const herClient = () =>
  client({
    list: vi.fn(async () => ({ enabled: true, people: [person()] })),
    today: vi.fn(async () => today()),
    alerts: vi.fn(async () => ({ alerts: [], unseen: 2 }) as never),
    todos: vi.fn(async () => ({ today: DAY, todos: [], projects: [] })),
    plan: vi.fn(async () => planView()),
    templates: vi.fn(async () => ({ templates: [] })),
  });

function Wrapped({ c, layout, tab, pid = PID }: { c: PeopleClient; layout: Layout; tab?: string; pid?: string | null }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: fakeApi(), router: createRouter(memoryHistory(pid ? `/people/${pid}` : '/people')), toasts: createToastStore() }));
  const [store] = useState(() => createLayoutStore(layout));
  return (
    <AppProvider deps={deps}>
      <LayoutProvider value={store}>
        <Partner {...(pid ? { pid } : {})} client={c} {...(tab ? { tab } : {})} day={DAY} />
      </LayoutProvider>
    </AppProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('his screen for her, by its pane', () => {
  it('from 800: the header and the tabs in the list column, the tab beside them under its name', async () => {
    measureAs(1384);
    render(<Wrapped c={herClient()} layout={layoutAt(1440)} />);
    const side = await screen.findByRole('region', { name: 'Asha' });
    expect(within(side).getByRole('heading', { level: 1, name: 'Asha' })).toBeTruthy();
    expect(within(side).getByRole('button', { name: 'Plan' })).toBeTruthy();
    const tabs = within(side).getByRole('tablist');
    expect(tabs.getAttribute('aria-orientation')).toBe('vertical');
    expect(within(tabs).getAllByRole('tab').map((t) => t.querySelector('span')?.textContent)).toEqual(['Today', 'To-do', 'Health', 'Journal', 'Chat', 'Lists', 'Alerts', 'Sharing', 'Activity']);
    expect(within(tabs).getByRole('tab', { name: 'Today' }).getAttribute('aria-selected')).toBe('true');
    // Her unseen alerts are a count on the Alerts row.
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: /Alerts/ }).textContent).toContain('2'));
    const tab = screen.getByRole('region', { name: 'Today' });
    expect(within(tab).getByRole('heading', { level: 2, name: 'Today' })).toBeTruthy();
    expect(within(tab).queryByRole('heading', { level: 1 })).toBeNull();
    expect(within(tab).queryByRole('tablist')).toBeNull();
    // Her Today beside the tabs is cards across the detail: her plan, and her day's other lines.
    const plan = within(tab).getByRole('region', { name: 'Day plan' });
    expect(await within(plan).findByText('08:00 Mock')).toBeTruthy();
    expect(within(tab).getByRole('region', { name: 'Her day' }).textContent).toContain('To-do today: 0');
    expect(tab.firstElementChild?.className).not.toContain('max-w-720');
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
  });

  it('from 800, a tab of rows (To-do) reads 720 wide at most', async () => {
    measureAs(1384);
    render(<Wrapped c={herClient()} layout={layoutAt(1440)} tab="todos" />);
    const tab = await screen.findByRole('region', { name: 'To-do' });
    expect(tab.firstElementChild?.className).toContain('max-w-720');
  });

  it('below 800 and on a phone: one column, the header, the tabs in a row, the tab', async () => {
    for (const [layout, width] of [
      [layoutAt(1440), 600],
      [layoutAt(390, { coarse: true }), 390],
    ] as const) {
      const spy = measureAs(width);
      const r = render(<Wrapped c={herClient()} layout={layout} />);
      expect(await screen.findByRole('heading', { level: 1, name: 'Asha' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Asha' })).toBeNull();
      const tabs = screen.getByRole('tablist');
      expect(tabs.getAttribute('aria-orientation')).toBeNull();
      expect(within(tabs).getAllByRole('tab')).toHaveLength(9);
      expect(screen.queryByRole('heading', { level: 2, name: 'Today' })).toBeNull();
      expect(await screen.findByText('08:00 Mock')).toBeTruthy();
      // 0.12's one column: no cards below 640.
      expect(screen.queryByRole('region', { name: 'Day plan' })).toBeNull();
      r.unmount();
      spy.mockRestore();
    }
  });

  it('a plan being written stays when the pane crosses 800, both ways', async () => {
    let width = 1384;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 800, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, toJSON: () => ({}) }));
    // Every observer and what it watches: a resize reaches the SplitPane's own (its box is .split).
    type Cb = (entries: Array<{ contentRect: { width: number } }>) => void;
    const watching: Array<{ cb: Cb; el: Element }> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: Cb) {}
        observe(el: Element) {
          watching.push({ cb: this.cb, el });
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const resize = (w: number) => act(() => watching.filter((x) => x.el.classList.contains('split')).forEach((x) => x.cb([{ contentRect: { width: w } }])));
    const c = herClient();
    render(<Wrapped c={c} layout={layoutAt(1180, { coarse: true })} tab="plan" />);
    const add = await screen.findByRole('textbox', { name: 'Add step' });
    expect(screen.getByRole('region', { name: 'Plan' })).toBeTruthy();
    fireEvent.change(add, { target: { value: 'Call the bank' } });
    // An iPad turned to portrait: the rail's pane is 748.
    width = 748;
    resize(width);
    expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Asha' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Add step' }) as HTMLInputElement).value).toBe('Call the bank');
    // And back.
    width = 960;
    resize(width);
    expect(screen.getByRole('region', { name: 'Plan' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Add step' }) as HTMLInputElement).value).toBe('Call the bank');
    expect(c.plan).toHaveBeenCalledTimes(1);
  });
});

describe('the People list', () => {
  it('is 720 wide at most, in any pane', async () => {
    measureAs(1384);
    const two = [person(), { ...person(), id: '01JBEAAAAAAAAAAAAAAAAAAAAA', name: 'Bea' }];
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: two })) });
    render(<Wrapped c={c} layout={layoutAt(1440)} pid={null} />);
    const title = await screen.findByRole('heading', { level: 1, name: 'Accountability partner' });
    expect(title.parentElement?.className).toContain('max-w-720');
    expect(await screen.findByRole('button', { name: /^Bea/ })).toBeTruthy();
  });
});
