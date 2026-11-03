/**
 * v0.12 People: her Me (Sharing, Activity), "See what Sam sees", and her
 * first steps after joining, against a fake client with synthetic people
 * (Sam and Asha).
 *
 * - Sharing: each level of a switch has its own plain label ("Only
 *   counts"), the switch is named in plain words, each shared area has
 *   "See what Sam sees", and the follow-up pushes are on "told without
 *   looking".
 * - Activity: plain words for every kind of row, under day headers, with
 *   HH:MM, never a raw code or an ISO time.
 * - The mirror renders his view's DTO with the shared components; an area
 *   that is off says so.
 * - After Accept and join: Turn on notifications (with its test), then
 *   Today.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { presetAgreement } from '@jantar/protocol/people-core';
import type { JoinPreview, PersonActivity, PersonMe, PlanView } from '@jantar/protocol/people';
import type { PersonApi } from '../../src/partner/api.js';
import { parsePersonRoute } from '../../src/partner/router.js';
import { Join } from '../../src/partner/screens/Join.js';
import { Me, activityText, byDay, toldWithoutLooking } from '../../src/partner/screens/Me.js';
import Mirror from '../../src/partner/screens/Mirror.js';

const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const AT = '2026-11-03T08:00:00.000Z';

function me(over: Partial<NonNullable<PersonMe['agreement']>> = {}): PersonMe {
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: { ...presetAgreement('everything'), version: 1, ...over },
    pending: null,
    ownerDevices: [],
    built: 'P4',
    lifeBroken: false,
  } as PersonMe;
}

function fakeApi(over: Partial<PersonApi> = {}): PersonApi {
  const base: Partial<PersonApi> = {};
  return new Proxy(base as PersonApi, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

const row = (seq: number, at: string, action: string, over: Partial<PersonActivity> = {}): PersonActivity => ({ seq, at, actor: 'owner', action, ...over }) as PersonActivity;

describe('Sharing', () => {
  it('each level has its own label; the switch says what it is; each shared area opens what Sam sees', () => {
    render(<Me me={me()} api={fakeApi()} reload={() => {}} tab="sharing" />);
    const review = screen.getByLabelText('What Sam sees of your evening review') as HTMLSelectElement;
    expect([...review.options].map((o) => o.textContent)).toEqual(['Off', 'Only counts', 'All']);
    expect(screen.queryByLabelText(/Level for/)).toBeNull();
    const links = screen.getAllByRole('link', { name: 'See what Sam sees' }).map((a) => a.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining(['/p/me?tab=sharing&see=plan', '/p/me?tab=sharing&see=review', '/p/me?tab=sharing&see=journal', '/p/me?tab=sharing&see=chat']));
    expect(screen.getByRole('link', { name: "See Sam's Today of you" }).getAttribute('href')).toBe('/p/me?tab=sharing&see=today');
  });

  it('"told without looking" names the follow-up pushes, in neutral words', () => {
    const lines = toldWithoutLooking(me());
    expect(lines).toContain('When an item Sam asked about ("Tell me if not done by") is still open at that time: its title only');
    expect(lines.join('\n')).not.toMatch(/\bhis\b|\bher\b/);
    expect(toldWithoutLooking(me({ assign: { todos: false, meds: false, plan: false } })).join('\n')).not.toMatch(/Tell me if not done by/);
  });

  it('see= opens the mirror; an unknown area is Sharing', () => {
    expect(parsePersonRoute('/p/me', '?tab=sharing&see=plan')).toEqual({ name: 'me', tab: 'sharing', see: 'plan' });
    expect(parsePersonRoute('/p/me', '?tab=sharing&see=bank')).toEqual({ name: 'me', tab: 'sharing' });
    expect(parsePersonRoute('/p/me', '?tab=activity&see=plan')).toEqual({ name: 'me', tab: 'activity' });
  });
});

describe('Activity', () => {
  it('plain words for every row he can leave, never a raw code', () => {
    const cases: [PersonActivity, string][] = [
      [row(1, AT, 'alert.sent', { fields: ['check_in'] }), 'Sam sent you an alert: Check in, please'],
      [row(2, AT, 'todo.added', { title: 'Call the bank' }), 'Sam added a to-do: Call the bank'],
      [row(3, AT, 'plan.set', { ref: '2026-11-04' }), 'Sam planned Wed 4 Nov'],
      [row(4, AT, 'journal.commented', { title: 'your entry of Thu 5 Nov' }), 'Sam commented on your entry of Thu 5 Nov'],
      [row(5, AT, 'step.edited', { title: 'Mock', changes: [{ field: 'at', from: '08:00', to: '08:30' }] }), 'Sam changed the time of "Mock" 08:00 → 08:30'],
      [row(6, AT, 'view', { area: 'today', ref: 'today' }), 'Sam looked at your Today'],
      [row(7, AT, 'view', { area: 'plan', ref: 'plan' }), 'Sam looked at your plan'],
      [row(8, AT, 'todo.deleted', { title: 'Old' }), 'Sam removed a to-do: Old'],
      [row(9, AT, 'weight.corrected', { ref: '2026-11-02', changes: [{ field: 'kg', from: '61.4', to: '61.2' }] }), 'Sam corrected your weight for Mon 2 Nov: 61.4 → 61.2 kg'],
      [row(10, AT, 'list.deleted', { title: 'Groceries' }), 'Sam deleted a list for both of you: Groceries'],
    ];
    for (const [r, text] of cases) expect(activityText('Sam', r)).toBe(text);
    expect(activityText('Sam', row(11, AT, 'something.new'))).toBe('Sam changed something in your space');
  });

  it('groups rows under day headers with HH:MM, and his views per day and area', async () => {
    const rows = [
      row(5, '2026-11-04T14:05:00', 'alert.sent', { fields: ['thinking_of_you'] }),
      row(4, '2026-11-04T10:00:00', 'view', { area: 'today' }),
      row(3, '2026-11-04T09:00:00', 'view', { area: 'today' }),
      row(2, '2026-11-03T18:33:00', 'todo.added', { title: 'Call the bank' }),
    ];
    expect(byDay(rows).map((d) => [d.day, d.groups.length])).toEqual([
      ['2026-11-04', 2],
      ['2026-11-03', 1],
    ]);
    render(<Me me={me()} api={fakeApi({ activity: vi.fn(async () => ({ activity: rows, before: null })) })} reload={() => {}} tab="activity" />);
    const wed = await screen.findByRole('region', { name: 'Wed 4 Nov' });
    expect(wed.textContent).toMatch(/14:05 Sam sent you an alert: Thinking of you/);
    expect(wed.textContent).toMatch(/Sam looked at your Today 2 times · last 10:00/);
    expect(screen.getByRole('region', { name: 'Tue 3 Nov' }).textContent).toMatch(/18:33 Sam added a to-do: Call the bank/);
    expect(document.body.textContent).not.toMatch(/alert\.sent|todo\.added|2026-11-0\d/);
  });
});

describe('See what Sam sees', () => {
  const plan: PlanView = {
    day: '2026-11-03',
    plan: { id: '01JPLANAAAAAAAAAAAAAAAAAAA', day: '2026-11-03', srev: 1, steps: [{ id: 'STEPAAAAA1', title: 'Mock', at: '08:00', ask: 'checkin', ring: true, focus: false, by: '', status: 'done', doneAt: AT, checkin: { mood: 3, energy: 2, at: AT } }], between: [], createdAt: AT, updatedAt: AT, sentAt: AT },
    now: null,
    next: null,
    late: [],
    focus: null,
    slots: {},
    counts: { done: 1, total: 1 },
  };

  it('draws his view of the plan, check-ins included', async () => {
    const mirror = vi.fn(async () => plan);
    render(<Mirror me={me()} api={fakeApi({ mirror })} area="plan" />);
    expect(await screen.findByText(/08:00 Mock/)).toBeTruthy();
    expect(screen.getByText(/mood 3\/5 · energy 2\/5/)).toBeTruthy();
    expect(mirror).toHaveBeenCalledWith('plan');
    expect(screen.getByText(/What Sam sees of your day plan/)).toBeTruthy();
  });

  it('an area that is off says Sam sees nothing of it', async () => {
    render(<Mirror me={me()} api={fakeApi({ mirror: vi.fn(async () => ({ locked: true })) })} area="journal" />);
    expect(await screen.findByText('Sam sees nothing of this: it is switched off.')).toBeTruthy();
  });
});

describe('after Accept and join', () => {
  it('turns on notifications (with a test push), then goes to Today', async () => {
    location.hash = '#c=AAAAAAAAAAAAAAAAAAAAAA';
    const offer = { ...presetAgreement('everything') };
    const preview: JoinPreview = { owner: 'Sam', name: 'Asha', version: 1, offer, fields: [], built: 'P4', modules: { food: false } } as unknown as JoinPreview;
    const join = vi.fn(async () => ({ personId: ASHA, deviceId: '01JDEVICEAAAAAAAAAAAAAAAAA', deviceSecret: 's' }));
    render(<Join api={fakeApi({ joinPreview: vi.fn(async () => preview), join })} mode="join" />);
    fireEvent.click(await screen.findByLabelText("I'm 18 or older"));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept and join' }));
    });
    await waitFor(() => expect(join).toHaveBeenCalled());
    const heading = await screen.findByRole('heading', { name: 'Turn on notifications' });
    expect(heading).toBeTruthy();
    expect(within(document.body).getByRole('button', { name: 'Turn on notifications' })).toBeTruthy();
    expect(location.hash).toBe('');
  });

  it('"Not now" says nothing was shared (no history to go back to)', async () => {
    location.hash = '#c=AAAAAAAAAAAAAAAAAAAAAA';
    const preview = { owner: 'Sam', name: 'Asha', version: 1, offer: presetAgreement('everything'), fields: [], built: 'P4', modules: { food: false } } as unknown as JoinPreview;
    render(<Join api={fakeApi({ joinPreview: vi.fn(async () => preview) })} mode="join" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.getByText(/Nothing was shared/)).toBeTruthy();
  });
});
