/**
 * v0.12 People (P2): his side of her days (spec 4.1–4.3; 9.7.4), with
 * synthetic people (Sam and Asha) and a fake People client.
 *
 * - His People client calls only his People routes, by method and path.
 * - The plan editor: the default day flips at 18:00, the out-of-order hint,
 *   Quick plan's live preview, and Send carrying srev; her steps are
 *   read-only without editHers.plan.
 * - The Partner screen: the header (status, Asleep since, progress), locked
 *   tiles for areas she keeps private, Nudge on an open step, the journal's
 *   comment box only with comment.journal; partial data never throws.
 * - The card on his Today.
 * - /people routes parse and print back.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PEOPLE_ROUTES, type PersonToday, type PersonView, type PlanView } from '@jantar/protocol/people';
import { presetAgreement } from '@jantar/protocol/people-core';
import { parseRoute, routePath } from '../../src/lib/router.js';
import { PEOPLE_PATHS, type PeopleClient } from '../../src/ui/screens/people/client.js';
import { PlanEditor, defaultPlanDay, orderHint } from '../../src/ui/screens/people/PlanEditor.js';
import { peopleLine } from '../../src/ui/screens/people/PeopleCard.js';
import { Partner } from '../../src/ui/screens/people/Partner.js';
import { createRouter, memoryHistory } from '../../src/lib/router.js';
import { createAppStore } from '../../src/store.js';
import { AppProvider, createToastStore } from '../../src/ui/context.js';
import { fakeApi } from '../helpers.js';

const PID = '01JASHAAAAAAAAAAAAAAAAAAAA';
const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';

function client(over: Partial<PeopleClient> = {}): PeopleClient {
  const base: Partial<PeopleClient> = {};
  return new Proxy(base as PeopleClient, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const person = (agreement = { ...presetAgreement('everything', 'P2'), version: 1 }): PersonView =>
  ({ id: PID, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, invite: null, agreement, offer: null, pendingProposal: null }) as PersonView;

const planView = (over: Partial<NonNullable<PlanView['plan']>> = {}): PlanView => ({
  day: DAY,
  plan: {
    id: '01JPLANAAAAAAAAAAAAAAAAAAA',
    day: DAY,
    srev: 3,
    steps: [
      { id: 'STEPAAAAA1', title: 'Mock', at: '08:00', ask: 'none', ring: true, focus: false, by: '', status: 'done', doneAt: '2026-11-03T08:55:00.000Z' },
      { id: 'STEPAAAAA2', title: 'Interview prep', at: '11:00', ask: 'ack', ring: true, focus: false, by: '', status: 'todo' },
      { id: 'STEPAAAAA3', title: 'Call Mum', ask: 'none', ring: true, focus: false, by: PID, status: 'todo' },
    ],
    between: [],
    createdAt: AT,
    updatedAt: AT,
    sentAt: AT,
    ...over,
  },
  now: 'STEPAAAAA2',
  next: 'STEPAAAAA3',
  late: [],
  focus: null,
  slots: {},
  counts: { done: 1, total: 3 },
});

const today = (over: Partial<PersonToday> = {}): PersonToday => ({
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
  ...over,
});

describe('his People client', () => {
  it('calls only his People routes, each with its method', () => {
    const routes = new Set(Object.values(PEOPLE_ROUTES).map((d) => `${d.method} ${d.path}`));
    for (const [key, [method, path]] of Object.entries(PEOPLE_PATHS)) {
      expect(path.startsWith('/v1/people'), key).toBe(true);
      expect(routes.has(`${method} ${path}`), key).toBe(true);
    }
  });
});

describe('the plan editor', () => {
  it('opens on today before 18:00 and tomorrow after; hints when times run out of order', () => {
    expect(defaultPlanDay(DAY, '17:59')).toBe(DAY);
    expect(defaultPlanDay(DAY, '18:00')).toBe('2026-11-04');
    expect(orderHint([{ at: '08:00' }, { at: '' }, { at: '14:00' }, { at: '11:00' }])).toBe('11:00 comes after 14:00');
    expect(orderHint([{ at: '08:00' }, { at: '11:00' }])).toBeNull();
  });

  it('Quick plan previews live; Send carries srev; her steps are read-only without editHers.plan', async () => {
    const putPlan = vi.fn(async () => planView());
    const c = client({ plan: vi.fn(async () => planView()), templates: vi.fn(async () => ({ templates: [] })), putPlan });
    render(<PlanEditor client={c} pid={PID} name="Asha" day={DAY} editHers={false} onDay={() => {}} />);
    expect(await screen.findByText(/Call Mum · Asha's own step/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start from ▾' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quick plan' }));
    fireEvent.change(screen.getByLabelText('Quick plan'), { target: { value: 'Mock at 8, then analysis 45m !report, every 2h 10-18 check applications' } });
    const preview = screen.getByLabelText('Quick plan preview');
    expect(preview.textContent).toMatch(/08:00 Mock/);
    expect(preview.textContent).toMatch(/analysis · 45 min · report/i);
    expect(preview.textContent).toMatch(/Every 120 min 10:00–18:00: check applications/i);
    fireEvent.click(screen.getByRole('button', { name: 'Use these steps' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send ▸' }));
    });
    await waitFor(() => expect(putPlan).toHaveBeenCalled());
    const [, , body] = putPlan.mock.calls[0] as unknown as [string, string, { srev: number; steps: { id?: string; title: string }[]; between: unknown[] }];
    expect(body.srev).toBe(3);
    // His done step and her own step stay; his open one was replaced by the quick plan.
    expect(body.steps.map((s) => [s.id ?? null, s.title])).toEqual([
      ['STEPAAAAA1', 'Mock'],
      ['STEPAAAAA3', 'Call Mum'],
      [null, 'Mock'],
      [null, 'Analysis'],
    ]);
    expect(body.between).toHaveLength(1);
  });
});

describe('his Partner screen', () => {
  it('header: status, progress and Now; Nudge on an open step; locked tiles for private areas', async () => {
    const sendAlert = vi.fn(async () => ({ id: 'x', delivery: 'sent' }));
    const a = { ...presetAgreement('everything', 'P2'), version: 1 };
    const c = client({
      list: vi.fn(async () => ({ enabled: true, people: [person(a)] })),
      today: vi.fn(async () => today({ weight: { locked: true } as never, sleep: { locked: true } as never })),
      sendAlert,
    });
    render(<Wrapped client={c} />);
    expect(await screen.findByText(/Low "long day" · 1 of 3 · Now: Interview prep/)).toBeTruthy();
    expect(screen.getByText('Weight: Asha keeps this private')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Nudge' })[0] as HTMLElement);
    await waitFor(() => expect(sendAlert).toHaveBeenCalledWith({ to: PID, kind: 'nudge', ref: { type: 'step', id: 'STEPAAAAA2', day: DAY } }));
  });

  it('the journal tab: a comment box only with comment.journal; off is a locked tile', async () => {
    const entry = { entry: { id: '01JENTRYAAAAAAAAAAAAAAAAAA', day: DAY, at: AT, kind: 'entry' as const, text: 'A good day.' }, comments: [] };
    for (const [comment, box] of [
      [true, true],
      [false, false],
    ] as const) {
      const a = { ...presetAgreement('everything', 'P2'), version: 1, comment: { journal: comment } };
      const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person(a)] })), today: vi.fn(async () => today()), journalGet: vi.fn(async () => entry) });
      const r = render(<Wrapped client={c} tab="journal" id={entry.entry.id} />);
      expect(await screen.findByText('A good day.')).toBeTruthy();
      expect(screen.queryByLabelText('Comment') !== null).toBe(box);
      r.unmount();
    }
    const off = { ...presetAgreement('everything', 'P2'), version: 1, see: { ...presetAgreement('everything', 'P2').see, journal: false }, comment: { journal: false } };
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person(off)] })), today: vi.fn(async () => today()) });
    render(<Wrapped client={c} tab="journal" />);
    expect(await screen.findByText('Journal: Asha keeps this private')).toBeTruthy();
  });

  it('partial data renders a locked tile or nothing, and never throws', async () => {
    const c = client({
      list: vi.fn(async () => ({ enabled: true, people: [person()] })),
      today: vi.fn(async () => today({ plan: { locked: true }, status: { locked: true }, review: { locked: true }, todos: { locked: true }, sleep: { locked: true } })),
    });
    render(<Wrapped client={c} />);
    expect(await screen.findByText('Day plan: Asha keeps this private')).toBeTruthy();
    expect(screen.getByText('Evening review: Asha keeps this private')).toBeTruthy();
  });
});

describe('the card on his Today and the routes', () => {
  it('one line, per the agreement', () => {
    expect(peopleLine(today())).toBe('Asha · 1 of 3 done · Now: Interview prep 11:00 · Low');
    expect(peopleLine(today({ sleep: { open: { since: '2026-11-03T23:40:00.000Z', night: DAY } } }))).toMatch(/^Asha · 1 of 3 done · Now: Interview prep 11:00 · Asleep since \d\d:\d\d$/);
    expect(peopleLine(today({ plan: { locked: true }, status: { locked: true }, sleep: { locked: true } }))).toBe('Asha');
  });

  it('/people and /people/:pid?tab=&day=&id= parse and print back', () => {
    expect(parseRoute('/people')).toEqual({ name: 'people' });
    const r = parseRoute(`/people/${PID}`, `?tab=alerts&day=${DAY}&id=01JA1ERTAAAAAAAAAAAAAAAAAA&x=1`);
    expect(r).toEqual({ name: 'people', pid: PID, tab: 'alerts', day: DAY, id: '01JA1ERTAAAAAAAAAAAAAAAAAA' });
    expect(routePath(r)).toBe(`/people/${PID}?tab=alerts&day=${DAY}&id=01JA1ERTAAAAAAAAAAAAAAAAAA`);
    expect(parseRoute('/people/not-an-id').name).toBe('notFound');
  });
});

/** The screen inside the app's providers (useNavigate needs the router; Life loads read the store's tick). */
function Wrapped({ client: c, tab, id }: { client: PeopleClient; tab?: string; id?: string }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: fakeApi(), router: createRouter(memoryHistory(`/people/${PID}`)), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner pid={PID} client={c} {...(tab ? { tab } : {})} {...(id ? { id } : {})} />
    </AppProvider>
  );
}
