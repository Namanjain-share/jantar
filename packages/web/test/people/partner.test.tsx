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
 * - A space a Life restore took out (T20): a note on People and on its old
 *   page with the way to invite them again (synthetic Bea).
 * - The card on his Today.
 * - /people routes parse and print back.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PEOPLE_ROUTES, type PersonToday, type PersonView, type PlanView } from '@jantar/protocol/people';
import { presetAgreement } from '@jantar/protocol/people-core';
import { parseRoute, routePath } from '../../src/lib/router.js';
import { PEOPLE_PATHS, createPeopleClient, fillPath, type PeopleClient } from '../../src/ui/screens/people/client.js';
import { PlanEditor, defaultPlanDay, orderHint, sentMessage } from '../../src/ui/screens/people/PlanEditor.js';
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

  it('builds the real URL for every list item action (camelCase :itemId filled, never left in)', async () => {
    const LIST = '01JLISTAAAAAAAAAAAAAAAAAAA';
    const ITEM = '01JITEMAAAAAAAAAAAAAAAAAAA';
    const TODO = '01JTODOAAAAAAAAAAAAAAAAAAA';
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const c = createPeopleClient({ fetch: fetch as unknown as typeof globalThis.fetch, base: 'https://jantar.test', credentials: { get: async () => null, set: async () => {}, clear: async () => {} } });
    await c.listItemTick(PID, LIST, ITEM, true);
    await c.listItemDelete(PID, LIST, ITEM);
    await c.listItemAssign(PID, LIST, ITEM);
    await c.assignTodo(PID, { title: 'Call the bank' });
    await c.updateTodo(PID, TODO, { title: 'Call the bank today' });
    await c.deleteTodo(PID, TODO);
    await c.todos(PID, true);
    expect(calls).toEqual([
      `POST https://jantar.test/v1/people/${PID}/lists/${LIST}/items/${ITEM}/tick`,
      `DELETE https://jantar.test/v1/people/${PID}/lists/${LIST}/items/${ITEM}`,
      `POST https://jantar.test/v1/people/${PID}/lists/${LIST}/items/${ITEM}/assign`,
      `POST https://jantar.test/v1/people/${PID}/todos`,
      `PATCH https://jantar.test/v1/people/${PID}/todos/${TODO}`,
      `DELETE https://jantar.test/v1/people/${PID}/todos/${TODO}`,
      `GET https://jantar.test/v1/people/${PID}/todos?done=1`,
    ]);
    for (const [, pattern] of Object.values(PEOPLE_PATHS)) expect(fillPath(pattern, { pid: 'p', id: 'i', itemId: 'x', day: 'd', tid: 't', cid: 'c' })).not.toMatch(/:/);
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
    // Each step's fields are labelled on screen; the follow-up says what it is.
    expect(screen.getAllByText('Tell me if not done by').length).toBeGreaterThan(0);
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

describe('the plan editor says what Send did', () => {
  it('"Sent." only when it goes now; "Saved. … gets it" when it waits; a sent plan says it is up to date', () => {
    const now = Date.parse('2026-11-03T18:31:00.000Z');
    const base = { ...planView({ sentAt: undefined }), day: '2026-11-04' };
    expect(sentMessage({ ...base, sendsAt: '2026-11-04T07:00:00.000Z' }, 'Asha', now)).toMatch(/^Saved\. Asha gets it Wed 4 Nov at \d\d:\d\d\.$/);
    expect(sentMessage({ ...base, sendsAt: '2026-11-03T18:31:01.000Z' }, 'Asha', now)).toBe('Sent.');
    expect(sentMessage(base, 'Asha', now)).toBe('Saved.');
    expect(sentMessage(planView(), 'Asha', now)).toBe("Saved. Asha's plan is up to date.");
  });

  it('Send is off with no steps, and a Quick plan typed but not applied is applied by Send', async () => {
    const empty: PlanView = { day: DAY, plan: null, now: null, next: null, late: [], focus: null, slots: {}, counts: { done: 0, total: 0 } };
    const putPlan = vi.fn(async () => ({ ...empty, sendsAt: '2026-11-04T07:00:00.000Z' }));
    const c = client({ plan: vi.fn(async () => empty), templates: vi.fn(async () => ({ templates: [] })), putPlan });
    render(<PlanEditor client={c} pid={PID} name="Asha" day={DAY} editHers={false} onDay={() => {}} />);
    const sendBtn = await screen.findByRole('button', { name: 'Send ▸' });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start from ▾' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quick plan' }));
    fireEvent.change(screen.getByLabelText('Quick plan'), { target: { value: 'Run at 7, then groceries' } });
    expect((screen.getByRole('button', { name: 'Send ▸' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send ▸' }));
    });
    await waitFor(() => expect(putPlan).toHaveBeenCalled());
    const [, , body] = putPlan.mock.calls[0] as unknown as [string, string, { steps: { title: string; at?: string }[] }];
    expect(body.steps.map((x) => x.title.toLowerCase())).toEqual(['run', 'groceries']);
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

  it('Assign: the header action opens the sheet; it sends the title, due, ask, no snooze and the follow-up', async () => {
    const assignTodo = vi.fn(async () => ({ id: '01JTODOAAAAAAAAAAAAAAAAAAA' }));
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person()] })), today: vi.fn(async () => today()), assignTodo, todos: vi.fn(async () => ({ today: DAY, todos: [], projects: [] })) });
    render(<Wrapped client={c} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Assign' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('To-do'), { target: { value: 'Call the bank' } });
    fireEvent.change(within(sheet).getByLabelText('Due day'), { target: { value: '2026-11-04' } });
    fireEvent.change(within(sheet).getByLabelText('Time'), { target: { value: '17:00' } });
    fireEvent.click(within(sheet).getByLabelText('A short report when done'));
    fireEvent.click(within(sheet).getByLabelText('No snooze'));
    fireEvent.change(within(sheet).getByLabelText(/Tell me if not done by/), { target: { value: '18:00' } });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Assign to Asha' }));
    });
    await waitFor(() =>
      expect(assignTodo).toHaveBeenCalledWith(PID, { title: 'Call the bank', due: { day: '2026-11-04', time: '17:00' }, ask: 'report', snoozable: false, followUp: '18:00' }),
    );
  });

  it('the To-do tab lists his items and hers; Edit only where he may (editHers.todos), Nudge on open ones', async () => {
    const mine = { id: '01JTODOAAAAAAAAAAAAAAAAAA1', title: 'From him', priority: 'normal', by: '', createdAt: AT, updatedAt: AT } as const;
    const hers = { id: '01JTODOAAAAAAAAAAAAAAAAAA2', title: 'Her own', priority: 'normal', by: PID, createdAt: AT, updatedAt: AT } as const;
    const sendAlert = vi.fn(async () => ({ id: 'x', delivery: 'sent' }));
    for (const editHers of [true, false]) {
      const base = presetAgreement('everything', 'P2');
      const a = { ...base, version: 1, editHers: { ...base.editHers, todos: editHers } };
      const c = client({
        list: vi.fn(async () => ({ enabled: true, people: [person(a)] })),
        today: vi.fn(async () => today()),
        todos: vi.fn(async (_p: string, done?: boolean) => ({ today: DAY, todos: done ? [] : [mine, hers], projects: [] })),
        sendAlert,
      });
      const r = render(<Wrapped client={c} tab="todos" />);
      expect(await screen.findByText('From him')).toBeTruthy();
      expect(screen.getByText('Her own')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(editHers ? 2 : 1);
      expect(screen.getAllByRole('button', { name: 'Nudge' })).toHaveLength(2);
      r.unmount();
    }
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

describe('a space a restore took out (T20, spec 2.7)', () => {
  const GONE = '01JBEAAAAAAAAAAAAAAAAAAAAA';

  it('is a note on People with the way to invite them again; People stays on its list', async () => {
    const history = memoryHistory('/people');
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [person()], setupAgain: [{ id: GONE, accessEmail: 'bea@example.com' }] })) });
    render(<Wrapped client={c} pid={null} history={history} />);
    const note = await screen.findByRole('region', { name: 'Sharing needs to be set up again' });
    expect(within(note).getByText('Restore removed the space you shared with bea@example.com. Invite them again.')).toBeTruthy();
    expect(within(note).getByText('jantar people add <name> --email bea@example.com')).toBeTruthy();
    expect(within(note).getByText('jantar people invite <name>')).toBeTruthy();
    expect(within(note).getByText(`jantar people remove ${GONE}`)).toBeTruthy();
    // The one person sharing is still listed, and People doesn't jump to her screen over the note.
    expect(screen.getByRole('button', { name: 'Asha' })).toBeTruthy();
    expect(history.entries).toEqual(['/people']);
  });

  it('is what their old /people/:pid shows: no name, none of his controls', async () => {
    const c = client({ list: vi.fn(async () => ({ enabled: true, people: [], setupAgain: [{ id: GONE }] })), today: vi.fn(async () => today()) });
    render(<Wrapped client={c} pid={GONE} />);
    expect(await screen.findByText("Restore removed your partner's space. Invite them again.")).toBeTruthy();
    expect(screen.getByText('jantar people add <name>')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
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
function Wrapped({ client: c, tab, id, pid = PID, history }: { client: PeopleClient; tab?: string; id?: string; pid?: string | null; history?: ReturnType<typeof memoryHistory> }) {
  const [deps] = useState(() => ({ store: createAppStore(), api: fakeApi(), router: createRouter(history ?? memoryHistory(pid ? `/people/${pid}` : '/people')), toasts: createToastStore() }));
  return (
    <AppProvider deps={deps}>
      <Partner {...(pid ? { pid } : {})} client={c} {...(tab ? { tab } : {})} {...(id ? { id } : {})} />
    </AppProvider>
  );
}
