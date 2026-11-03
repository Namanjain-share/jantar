/**
 * Synthetic v0.11 People for the 0.12 layout matrix
 * (web-v011-layout.integration.test.ts): People on, and one made-up person
 * sharing everything with him ("Asha", her space under its default name),
 * with a day plan of five steps (two done, one late, one now), a status
 * line, a to-do due, a dose not logged, today's weight and one alert of
 * hers he hasn't seen. Enough for his
 * Accountability partner screen's Today tab, the card on his Today, and the
 * place in his nav; every other People read answers as an empty one would.
 *
 * `withPeople(fixture)` turns People on in the fixture's state and answers
 * the People routes before the fixture's own answer. Every DTO is parsed
 * with its protocol schema here, so the fixture can't drift from them.
 */
import {
  AlertsResponseSchema,
  PeopleListSchema,
  PersonTodaySchema,
  presetAgreement,
  type AlertsResponse,
  type PeopleList,
  type PersonToday,
} from '@jantar/protocol/people';
import type { AnsweringFixture } from './browser.js';

/** Her person id (a ULID, as the router's /people/:pid wants). */
export const PEOPLE_PID = '01JASHAAAAAAAAAAAAAAAAAAAA';

const MIN = 60_000;

/** A synthetic ULID-shaped id: Crockford letters only (no I, L, O or U). */
const ulid = (tag: string, n: number) => `01JX${tag}${'A'.repeat(21 - tag.length)}${n}`;

/** What withPeople needs of a fixture: its clock and zone, its state, and its answer (browser.ts AnsweringFixture). */
type Answering = AnsweringFixture & { state: { state: unknown } };

/** The fixture's local day (its clock in its zone), as Today and her plan use it. */
function dayOf(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function peopleData(now: number, timezone: string): { list: PeopleList; today: PersonToday; alerts: AlertsResponse } {
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const day = dayOf(now, timezone);
  const agreement = { ...presetAgreement('everything', 'P4'), version: 1 };
  const list = PeopleListSchema.parse({
    enabled: true,
    ownerName: 'Sam',
    people: [{ id: PEOPLE_PID, name: 'Asha', color: 'teal', state: 'active', joinedAt: iso(14 * 24 * 60), modules: { food: false }, invite: null, agreement, offer: null, pendingProposal: null, chatPerDay: 20 }],
  });
  const step = (n: number, title: string, at: string, status: 'done' | 'todo', extra: Record<string, unknown> = {}) => ({
    id: `STEPAAAAA${n}`,
    title,
    at,
    ask: 'none',
    ring: true,
    focus: false,
    by: '',
    status,
    ...(status === 'done' ? { doneAt: iso(60 * (6 - n)) } : {}),
    ...extra,
  });
  const today = PersonTodaySchema.parse({
    day,
    name: 'Asha',
    state: 'active',
    todos: { open: 3, overdue: 0, due: [{ id: ulid('T', 1), title: 'Send the example invoice', priority: 'normal', by: '', due: { day }, createdAt: iso(600), updatedAt: iso(600) }] },
    meds: { level: 'adherence', pct: 92, notLoggedToday: 1, concern: null },
    weight: { latest: { day, kg: 61.4 } },
    food: null,
    plan: {
      day,
      plan: {
        id: ulid('P', 1),
        day,
        srev: 2,
        steps: [
          step(1, 'Morning walk', '07:00', 'done'),
          step(2, 'Example standup', '09:30', 'done'),
          step(3, 'Write the example report', '11:00', 'todo', { minutes: 90 }),
          step(4, 'Lunch away from the desk', '13:00', 'todo'),
          step(5, 'Read for half an hour', '21:30', 'todo'),
        ],
        between: [],
        createdAt: iso(900),
        updatedAt: iso(120),
        sentAt: iso(840),
      },
      now: 'STEPAAAAA3',
      next: 'STEPAAAAA4',
      late: ['STEPAAAAA3'],
      focus: null,
      slots: {},
      counts: { done: 2, total: 5 },
    },
    status: { level: 'ok', line: 'steady day', at: iso(180), until: iso(-360) },
    review: null,
    sleep: { open: null },
    concerns: [],
  });
  const alerts = AlertsResponseSchema.parse({
    alerts: [{ id: ulid('R', 1), from: PEOPLE_PID, to: '', kind: 'check_in', urgency: 'normal', at: iso(25), delivery: 'sent', expiresAt: iso(25 - 24 * 60) }],
    unseen: 1,
    sheet: { caps: { hour: 6, day: 20, urgentDay: 3, nudgeGapMin: 30, nudgeDay: 6 }, sent: { hour: 0, day: 1, urgentDay: 0 }, hold: null },
  });
  return { list, today, alerts };
}

/** `f` with People on and its routes answered; the fixture's other answers are unchanged. */
export function withPeople<F extends Answering>(f: F): F {
  const daemon = (f.state.state as { daemon: { features: Record<string, unknown> } }).daemon;
  daemon.features = { ...daemon.features, people: true };
  const data = peopleData(f.now, f.timezone);
  const theirs = f.v04.answer;
  const answer: AnsweringFixture['v04']['answer'] = (method, url, body) => {
    const path = url.pathname;
    if (method === 'GET' && path === '/v1/people') return { status: 200, body: data.list };
    if (method === 'GET' && path === `/v1/people/${PEOPLE_PID}/today`) return { status: 200, body: data.today };
    if (method === 'GET' && path === '/v1/people/alerts') return { status: 200, body: data.alerts };
    if (path.startsWith('/v1/people')) return { status: 404, body: { error: { code: 'not_found', message: 'not in the People fixture' } } };
    return theirs(method, url, body);
  };
  return { ...f, v04: { ...f.v04, answer } } as F;
}
