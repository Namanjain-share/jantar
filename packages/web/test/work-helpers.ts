/**
 * 0.13.0 Work's test fixtures: Life status with Work on or off, a project
 * hub, and `api.request` answering Work's routes by path. Every name here
 * is made up (Acme, Northwind, Globex; W42).
 */
import { vi } from 'vitest';
import type { LifeModule, LifeStatus, ProjectView, Todo } from '@jantar/protocol';
import type { ContactView, ProjectHub, SearchResponse, WorkClientHub, WorkClientRow, WorkClientsResponse, WorkDealCard, WorkLogRow, WorkSettings } from '@jantar/protocol/work';
import { ApiError, type Api, type ApiRequest, type ApiRoute } from '../src/lib/api.js';

/** Life status with these modules on (the rest off); `work` needs `todos` on the Mac, as here. */
export function lifeStatus(on: Partial<Record<LifeModule, boolean>> = {}, over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: '2026-01-15',
    currency: 'INR',
    lockScreenDetails: false,
    modules: { todos: false, medicines: false, food: false, places: false, finance: false, posts: false, work: false, ...on },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

/** Work on (with Todos). */
export const WORK_ON = (): LifeStatus => lifeStatus({ todos: true, work: true });

export const IDS = {
  acme: '01JWRKPRJ0000000000000ACME',
  northwind: '01JWRKPRJ00000000000NRTHWD',
  globex: '01JWRKPRJ00000000000GL0BEX',
  client: '01JWRKC11ENT00000000000ACM',
  deal: '01JWRKDEA100000000000000AC',
  todo1: '01JWRKT0D0000000000000000A',
  todo2: '01JWRKT0D0000000000000000B',
  done1: '01JWRKT0D0000000000000000C',
  meeting: '01JWRKMEET00000000000000KC',
  // Clients: Acme and Northwind (companies), Pat Example at Acme and Sam Sample (people).
  pat: '01JWRKC11ENT0000000000PAT0',
  sam: '01JWRKC11ENT0000000000SAM0',
  northwindCo: '01JWRKC11ENT00000000NRTHWD',
  log1: '01JWRK10G00000000000000001',
  log2: '01JWRK10G00000000000000002',
  log3: '01JWRK10G00000000000000003',
  followUp: '01JWRKT0D000000000000F0110',
  batch: '01JWRKBATCH000000000000001',
} as const;

const AT = '2026-01-14T10:00:00.000Z';

export function project(id: string, over: Partial<ProjectView> = {}): ProjectView {
  return { id, name: 'Site rebuild', status: 'active', open: 0, overdue: 0, createdAt: AT, updatedAt: AT, ...over };
}

export function todo(id: string, over: Partial<Todo> = {}): Todo {
  return { id, title: 'Send wireframes', priority: 'normal', createdAt: AT, updatedAt: AT, ...over };
}

export function hub(over: Partial<ProjectHub> = {}): ProjectHub {
  return {
    project: project(IDS.acme, { folder: '/Users/example/Desktop/work/client/acme', open: 2, overdue: 1, notes: 'Wants the store live before the festival.' }),
    open: [todo(IDS.todo1, { title: 'Fix staging login', due: { day: '2026-01-12' }, projectId: IDS.acme }), todo(IDS.todo2, { title: 'Send wireframes', due: { day: '2026-01-15', time: '15:00' }, projectId: IDS.acme })],
    doneThisWeek: 5,
    recentDone: [todo(IDS.done1, { title: 'Kickoff notes', doneAt: AT, projectId: IDS.acme })],
    health: { overdue: 1, nextDue: { todoId: IDS.todo1, due: { day: '2026-01-12' } }, doneByWeek: [0, 0, 0, 0, 0, 0, 2, 5] },
    ...over,
  };
}

type Answer = (init: ApiRequest) => unknown;

/**
 * `api.request` for Work's routes: each answer by "METHOD /path/pattern" (a function gets the request);
 * any other route answers the daemon's 501. The mock records every call.
 */
export function workRequest(answers: Record<string, unknown | Answer>) {
  const fn = vi.fn(async (route: ApiRoute, init: ApiRequest = {}): Promise<unknown> => {
    const key = `${route.method} ${route.path}`;
    if (!(key in answers)) throw new ApiError('not_implemented', 'not built yet', 501);
    const a = answers[key];
    const v = typeof a === 'function' ? (a as Answer)(init) : a;
    if (v instanceof Error) throw v;
    return v;
  });
  // The mock answers whatever the route's reply is; Api['request'] is generic in it.
  return fn as typeof fn & Api['request'];
}

export const NO_RESULTS: SearchResponse = { groups: [] };

// ---------------------------------------------------------------------------
// 0.13.0 Work's clients (made up: Acme, Northwind, Pat Example, Sam Sample; e-mails on .example)

export function clientRow(id: string, over: Partial<WorkClientRow> = {}): WorkClientRow {
  return { id, name: 'Acme', kind: 'company', state: 'client', openDeals: { count: 0, sums: [] }, tags: [], ...over };
}

/** Acme (a client with a deal and a follow-up), Northwind (a lead with an open deal and no next step), Pat at Acme, a past one. */
export function clientRows(): WorkClientRow[] {
  return [
    clientRow(IDS.client, { name: 'Acme', next: { todoId: IDS.followUp, title: 'Send the quote', due: { day: '2026-01-15', time: '15:00' } }, lastTouchAt: '2026-01-13T10:00:00.000Z', openDeals: { count: 2, sums: [{ currency: 'INR', amount: 65_000_000 }] }, tags: ['retail'] }),
    clientRow(IDS.northwindCo, { name: 'Northwind', state: 'lead', openDeals: { count: 1, sums: [{ currency: 'INR', amount: 20_000_000 }] }, lastTouchAt: '2025-12-20T10:00:00.000Z' }),
    clientRow(IDS.pat, { name: 'Pat Example', kind: 'person', company: { id: IDS.client, name: 'Acme' }, title: 'Head of Ops', tags: ['retail'] }),
    clientRow(IDS.sam, { name: 'Sam Sample', kind: 'person', state: 'past', from: 'import' }),
  ];
}

export const CLIENTS = (rows = clientRows(), more = 0): WorkClientsResponse => ({ clients: rows, more });

export function contact(id: string, over: Partial<ContactView> = {}): ContactView {
  return { id, name: 'Pat Example', kind: 'person', state: 'client', phones: [], emails: [], links: [], tags: [], createdAt: AT, updatedAt: AT, ...over };
}

export function logRow(id: string, over: Partial<WorkLogRow> = {}): WorkLogRow {
  return { id, kind: 'call', at: '2026-01-13T10:00:00.000Z', contactId: IDS.pat, ...over };
}

export function dealCard(id: string, over: Partial<WorkDealCard> = {}): WorkDealCard {
  return { id, title: 'Site rebuild', client: { id: IDS.pat, name: 'Pat Example' }, stage: 'proposal', stageName: 'Proposal sent', kind: 'open', value: 45_000_000, currency: 'INR', daysInStage: 12, quiet: false, ...over };
}

/** Pat Example at Acme: two phones, an e-mail, a follow-up, a deal, a project, three log rows and a next page. */
export function clientHub(over: Partial<WorkClientHub> = {}): WorkClientHub {
  return {
    contact: contact(IDS.pat, {
      companyId: IDS.client,
      title: 'Head of Ops',
      phones: [{ value: '98765 43210', label: 'Mobile' }, { value: '+44 20 7946 0000' }],
      emails: ['pat@acme.example'],
      links: ['https://acme.example/team'],
      tags: ['retail'],
      source: 'Referral',
      notes: 'Prefers calls before noon.',
      checkInDays: 30,
      lastTouchAt: '2026-01-13T10:00:00.000Z',
    }),
    company: { id: IDS.client, name: 'Acme', state: 'client' },
    projects: [project(IDS.acme, { name: 'Site rebuild', open: 3, clientId: IDS.pat })],
    followUps: [todo(IDS.followUp, { title: 'Call about scope', due: { day: '2026-01-16', time: '15:00' }, contactId: IDS.pat })],
    log: [
      logRow(IDS.log1, { kind: 'call', direction: 'out', minutes: 25, outcome: 'good', body: 'Wants a quote by Friday.' }),
      logRow(IDS.log2, { kind: 'meeting', meetingId: IDS.meeting, meeting: { name: 'Kickoff call', startedAt: '2026-01-12T10:00:00.000Z' }, auto: true, at: '2026-01-12T10:00:00.000Z' }),
      logRow(IDS.log3, { kind: 'followup', title: 'Send proposal', at: '2026-01-11T10:00:00.000Z' }),
    ],
    logNext: '2026-01-11T10:00:00.000Z~01JWRK10G00000000000000003',
    checkIn: { every: 30, since: 2, due: false },
    openDeals: { count: 1, sums: [{ currency: 'INR', amount: 45_000_000 }] },
    deals: [dealCard(IDS.deal)],
    ...over,
  };
}

export const SETTINGS = (over: Partial<WorkSettings> = {}): WorkSettings => ({ businesses: [], quietDays: 14, lockScreenNames: false, ...over });

/** Every read Clients makes, answered: the list, the starter lists, settings, the companies, one hub. */
export function clientAnswers(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'GET /v1/work/clients': (init: ApiRequest) => (init.query?.kind === 'company' ? CLIENTS(clientRows().filter((c) => c.kind === 'company')) : CLIENTS()),
    'GET /v1/work/clients/lists': { lists: [{ id: 'check-in', name: 'Needs a check-in', description: 'Due a check-in', count: 1 }] },
    'GET /v1/work/settings': SETTINGS({ dialCode: '+91' }),
    'GET /v1/work/clients/:id': clientHub(),
    'POST /v1/work/clients/similar': { matches: [] },
    ...over,
  };
}
