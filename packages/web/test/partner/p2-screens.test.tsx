/**
 * v0.11 People (P2): her Today, review, journal and sleep screens (spec
 * 3.1, 3.10, 3.11, 3.12; 9.7.4), against a fake client with synthetic data.
 *
 * - Today: Now, Next and Later in plan order with Done collapsed; the
 *   sticky bar goes from Got it to Done: {Now}; a report step opens its
 *   sheet with "Done without a note"; a tick shows Undo; out-of-order ticks
 *   are one tap where the step is; the review card from her review time;
 *   the Going to sleep and Woke up cards.
 * - Review: carry hers, ask him to carry his, send once with the note.
 * - Journal: the header line for each value of see.journal; the check-in
 *   row's five faces and emotion chips.
 * - Sleep: "short" is a plain label and no arrow shows without a trend.
 * - Hostile text renders as text.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { PersonMe, PersonOwnToday, PlanStep, PlanView, ReviewView, SleepWeek as Week } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import { Today, groupSteps } from '../../src/partner/screens/Today.js';
import { Review } from '../../src/partner/screens/Review.js';
import Journal from '../../src/partner/screens/Journal.js';
import { SleepWeek } from '../../src/people-shared/SleepWeek.js';

const DAY = '2026-11-03';
const AT = '2026-11-03T08:00:00.000Z';
const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';

function me(over: Partial<PersonMe['agreement'] & object> = {}): PersonMe {
  const a = { ...presetAgreement('everything', 'P2'), version: 1, ...over };
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: a as PersonMe['agreement'],
    pending: null,
    ownerDevices: [],
    built: 'P2',
    lifeBroken: false,
  } as PersonMe;
}

const step = (id: string, title: string, over: Partial<PlanStep> = {}): PlanStep => ({ id, title, ask: 'none', ring: true, focus: false, by: '', status: 'todo', ...over });

function view(steps: PlanStep[], over: Partial<PlanView> = {}, plan: Partial<NonNullable<PlanView['plan']>> = {}): PlanView {
  return {
    day: DAY,
    plan: { id: '01JPLANAAAAAAAAAAAAAAAAAAA', day: DAY, srev: 1, steps, between: [], createdAt: AT, updatedAt: AT, sentAt: AT, ...plan },
    now: null,
    next: null,
    late: [],
    focus: null,
    slots: {},
    counts: { done: steps.filter((s) => s.status === 'done').length, total: steps.length },
    ...over,
  };
}

function today(plan: PlanView, over: Partial<PersonOwnToday> = {}): PersonOwnToday {
  return {
    day: DAY,
    today: DAY,
    meds: null,
    todos: [],
    overdue: 0,
    plan,
    status: null,
    review: null,
    sleep: { open: null, showStart: false, askWake: null },
    sharingCheckin: false,
    alertsUnseen: 0,
    prompt: 'What went well today?',
    ...over,
  };
}

function fakeApi(over: Partial<PersonApi> = {}): PersonApi {
  const base: Partial<PersonApi> = {};
  return new Proxy(base as PersonApi, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const S1 = 'STEPAAAAA1';
const S2 = 'STEPAAAAA2';
const S3 = 'STEPAAAAA3';
const S4 = 'STEPAAAAA4';

describe('her Today (P2)', () => {
  it('groups Now, Next and Later in plan order, with done and skipped collapsed', () => {
    const steps = [step(S1, 'Mock', { status: 'done' }), step(S2, 'Analysis', { status: 'doing' }), step(S3, 'Interview prep', { at: '11:00' }), step(S4, 'Log practice questions')];
    const g = groupSteps(view(steps, { now: S2, next: S3 }), steps);
    expect(g.map(([l, list]) => [l, list.map((s) => s.title)])).toEqual([
      ['Now', ['Analysis']],
      ['Next', ['Interview prep']],
      ['Later', ['Log practice questions']],
      ['Done', ['Mock']],
    ]);
  });

  it('the bar says Got it while the plan is unacknowledged, then Done: {Now}', async () => {
    const steps = [step(S1, 'Mock', { at: '08:00' }), step(S2, 'Analysis')];
    let t = today(view(steps, { now: S1, next: S2 }));
    const api = fakeApi({ today: vi.fn(async () => t), planAck: vi.fn(async () => undefined) });
    const r = render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    const got = await screen.findByRole('button', { name: 'Got it' });
    fireEvent.click(got);
    await waitFor(() => expect(api.planAck).toHaveBeenCalledWith(DAY));
    t = today(view(steps, { now: S1, next: S2 }, { ackAt: AT }));
    r.rerender(<Today me={me()} api={api} reload={() => {}} tick={1} />);
    expect(await screen.findByRole('button', { name: 'Done: Mock' })).toBeTruthy();
  });

  it('Add a step: one of her own, with or without his plan (Q7): a title, a time that rings her and minutes', async () => {
    const stepAdd = vi.fn(async () => ({ id: S4 }));
    // No plan from him yet: she can still add her own step.
    const api = fakeApi({ today: vi.fn(async () => today({ ...view([]), plan: null })), stepAdd });
    render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a step' }));
    const sheet = screen.getByRole('dialog', { name: 'Add a step' });
    const add = screen.getByRole('button', { name: 'Add step' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Step'), { target: { value: ' Walk ' } });
    fireEvent.change(screen.getByLabelText('Time (optional)'), { target: { value: '18:30' } });
    expect(screen.getByLabelText('Ring me at 18:30')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Minutes (optional)'), { target: { value: '3' } });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Minutes (optional)'), { target: { value: '30' } });
    fireEvent.click(add);
    await waitFor(() => expect(stepAdd).toHaveBeenCalledWith(DAY, { title: 'Walk', at: '18:30', ring: true, minutes: 30 }));
    expect(sheet.isConnected).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '+ Add a step' }));
    fireEvent.change(screen.getByLabelText('Step'), { target: { value: 'Read' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(stepAdd).toHaveBeenLastCalledWith(DAY, { title: 'Read' }));
  });

  it("the two-week check-in's Pause opens Sharing, where Pause is (not Leave)", async () => {
    const sharingCheckin = vi.fn(async () => undefined);
    const api = fakeApi({ today: vi.fn(async () => today(view([]), { sharingCheckin: true })), sharingCheckin });
    history.replaceState(null, '', '/p');
    render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(sharingCheckin).toHaveBeenCalledWith({ answer: 'pause' }));
    await waitFor(() => expect(`${location.pathname}${location.search}`).toBe('/p/me?tab=sharing'));
  });

  it('a report step opens the report sheet with two equal buttons; Done without a note sends no report', async () => {
    const steps = [step(S1, 'Analysis', { ask: 'report' })];
    const api = fakeApi({ today: vi.fn(async () => today(view(steps, { now: S1 }, { ackAt: AT }))), stepState: vi.fn(async () => undefined) });
    render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Done: Analysis', pressed: false }));
    const without = await screen.findByRole('button', { name: 'Done without a note' });
    expect(screen.getByRole('button', { name: 'Save note' })).toBeTruthy();
    fireEvent.click(without);
    await waitFor(() => expect(api.stepState).toHaveBeenCalledWith(DAY, S1, { to: 'done' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('a step done out of order is one tap where it is, and Undo puts it back', async () => {
    const steps = [step(S1, 'Mock'), step(S2, 'Analysis'), step(S3, 'Walk')];
    const api = fakeApi({ today: vi.fn(async () => today(view(steps, { now: S1, next: S2 }, { ackAt: AT }))), stepState: vi.fn(async () => undefined) });
    render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Done: Walk' }));
    await waitFor(() => expect(api.stepState).toHaveBeenCalledWith(DAY, S3, { to: 'done' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.stepState).toHaveBeenLastCalledWith(DAY, S3, { to: 'todo' }));
  });

  it('shows the review card, the Going to sleep button and the Woke up card when due', async () => {
    const api = fakeApi({
      today: vi.fn(async () =>
        today(view([]), { review: { day: DAY, line: '5 done · 2 open', done: 5, open: 2, yesterday: false }, sleep: { open: null, showStart: true, askWake: null } }),
      ),
      sleepStart: vi.fn(async () => ({ id: 'x', night: DAY })),
    });
    const r = render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    expect(await screen.findByText('How did today go?')).toBeTruthy();
    expect(screen.getByText('5 done · 2 open')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Going to sleep' }));
    await waitFor(() => expect(api.sleepStart).toHaveBeenCalled());
    r.unmount();
    const api2 = fakeApi({ today: vi.fn(async () => today(view([]), { sleep: { open: { since: '2026-11-03T23:40:00.000Z', night: DAY }, showStart: false, askWake: null } })) });
    render(<Today me={me()} api={api2} reload={() => {}} tick={0} />);
    expect(await screen.findByRole('button', { name: 'Woke up' })).toBeTruthy();
    expect(screen.getByText(/^Asleep since/)).toBeTruthy();
  });

  it('a late step shows a display-only "late" chip; hostile titles render as text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const steps = [step(S1, hostile, { at: '08:00' })];
    const api = fakeApi({ today: vi.fn(async () => today(view(steps, { now: S1, late: [S1] }, { ackAt: AT, note: '<script>x</script>' }))) });
    const { container } = render(<Today me={me()} api={api} reload={() => {}} tick={0} />);
    expect(await screen.findByText('late')).toBeTruthy();
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.textContent).toContain(hostile);
  });
});

describe('her review', () => {
  const items: Extract<ReviewView, { level: 'full' }>['items'] = [
    { kind: 'step', ref: S1, title: 'Mock', by: '', outcome: 'done', doneAt: '2026-11-03T08:55:00.000Z' },
    { kind: 'step', ref: S2, title: 'Log practice questions', by: ASHA },
    { kind: 'step', ref: S3, title: 'Daily file', by: '' },
    { kind: 'step', ref: S4, title: 'Night check-in', by: '', outcome: 'gone' },
    { kind: 'between', ref: 'BETWEENAAA', title: 'Check applications', by: '', ticks: { done: 3, of: 5 } },
  ];
  const v: ReviewView = { level: 'full', day: DAY, sent: false, items, counts: { done: 1, skipped: 0, excused: 0, moved: 0, missed: 0, gone: 1 }, line: '1 done · 1 gone · 2 open' };

  it('carries hers, asks him to carry his, and sends once with the note and mood', async () => {
    const api = fakeApi({ review: vi.fn(async () => v), reviewSend: vi.fn(async () => undefined) });
    render(<Review me={me()} api={api} day={DAY} tick={0} />);
    expect(await screen.findByText('3 of 5')).toBeTruthy();
    expect(screen.getByText('gone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Carry to tomorrow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Sam to carry' }));
    fireEvent.change(screen.getByLabelText('A note for today (optional)'), { target: { value: 'Long day.' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Mood 4 of 5' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Send review' }));
    await waitFor(() => expect(api.reviewSend).toHaveBeenCalledWith(DAY, { carry: [S2], askCarry: [S3], note: 'Long day.', mood: 4, toJournal: true }));
  });
});

describe('her journal', () => {
  const list = { entries: [], streak: { current: 3, best: 5 }, before: null, prompt: 'What went well today?' };
  for (const [label, over, line] of [
    ['on', {}, 'Sam can read your journal and comment on it.'],
    ['on, no comments', { comment: { journal: false } }, 'Sam can read your journal.'],
    ['off', { see: { ...presetAgreement('everything', 'P2').see, journal: false }, comment: { journal: false } }, "Sam can't open your journal in Jantar. It is stored on Sam's Mac."],
  ] as const) {
    it(`the header says who can read it (${label})`, async () => {
      const api = fakeApi({ journal: vi.fn(async () => list) });
      render(<Journal me={me(over as object)} api={api} id={null} checkin={false} tick={0} />);
      expect(await screen.findByText(line)).toBeTruthy();
    });
  }

  it('the check-in row: five faces, then the emotion chips, at most three', async () => {
    const api = fakeApi({ journal: vi.fn(async () => list), journalCreate: vi.fn(async () => ({ id: 'x' })) });
    render(<Journal me={me()} api={api} id={null} checkin tick={0} />);
    const faces = await screen.findAllByRole('radio', { name: /^Mood \d of 5$/ });
    expect(faces).toHaveLength(5);
    fireEvent.click(faces[1] as HTMLElement);
    for (const e of ['Sad', 'Flat', 'Anxious', 'Angry']) fireEvent.click(screen.getByRole('button', { name: e }));
    expect(screen.getByRole('button', { name: 'Angry', pressed: false })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save check-in' }));
    });
    expect(api.journalCreate).toHaveBeenCalledWith({ kind: 'checkin', mood: 2, emotions: ['sadness', 'flat', 'fear'] });
    expect(screen.getByText('3 days in a row')).toBeTruthy();
  });
});

describe('the sleep week', () => {
  it('"short" is a plain label; no arrow without a trend; missing wake times say so', () => {
    const w: Week = {
      from: '2026-11-02',
      to: '2026-11-08',
      nights: [
        { id: '01JNIGHTAAAAAAAAAAAAAAAAAA', night: '2026-11-02', bedAt: '2026-11-02T23:30:00.000Z', wakeAt: '2026-11-03T04:40:00.000Z', source: 'manual', minutes: 310, short: true, bedHm: '23:30', wakeHm: '04:40', axis: { from: 330, to: 640 } },
        { id: '01JNIGHTBBBBBBBBBBBBBBBBBB', night: '2026-11-03', bedAt: '2026-11-03T23:00:00.000Z', noWake: true, source: 'buttons', bedHm: '23:00', axis: { from: 300, to: 300 } },
      ],
      avgMinutes: 310,
      avgBed: '23:30',
      avgWake: '04:40',
      bedSpreadMin: 0,
      trend: null,
      avgQuality: null,
      open: null,
    };
    const { container } = render(<SleepWeek week={w} />);
    expect(container.textContent).toContain('5 h 10 m short');
    expect(container.textContent).toContain('wake time not logged');
    expect(container.textContent).not.toMatch(/[↑↓]/);
  });
});
