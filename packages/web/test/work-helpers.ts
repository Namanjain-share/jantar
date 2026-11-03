/**
 * 0.13.0 Work's test fixtures: Life status with Work on or off, a project
 * hub, and `api.request` answering Work's routes by path. Every name here
 * is made up (Acme, Northwind, Globex; W42).
 */
import { vi } from 'vitest';
import type { LifeModule, LifeStatus, ProjectView, Todo } from '@jantar/protocol';
import type {
  ContactView,
  Deal,
  ProjectHub,
  SearchResponse,
  WorkClientHub,
  WorkClientRow,
  WorkClientsResponse,
  WorkDealCard,
  WorkDealHub,
  WorkDealsResponse,
  WorkInsightsBook,
  WorkInsightsReply,
  WorkLogRow,
  WorkSettings,
  WorkStageColumn,
  WorkStagesReply,
} from '@jantar/protocol/work';
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
  // Deals: Site rebuild (Acme, the one above), AI audit (Northwind) and Brand refresh (Globex, in dollars).
  deal2: '01JWRKDEA100000000000000NW',
  deal3: '01JWRKDEA100000000000000GX',
  globexCo: '01JWRKC11ENT00000000GL0BEX',
  ms1: '01JWRKM11E5T0NE00000000001',
  ms2: '01JWRKM11E5T0NE00000000002',
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

// ---------------------------------------------------------------------------
// 0.13.0 Work's deals (made up: Acme, Northwind, Globex)

/** A stage's column; Won and Lost sum the last 30 days. */
export function stageCol(id: string, name: string, kind: WorkStageColumn['kind'], over: Partial<WorkStageColumn> = {}): WorkStageColumn {
  return { id, name, kind, probability: kind === 'won' ? 100 : kind === 'lost' ? 0 : 50, count: 0, value: [], weighted: [], quiet: 0, ...over };
}

/** The six default stages: Brand refresh (dollars) in New lead; Site rebuild and AI audit (rupees) in Proposal sent; one won in 30 days. */
export function stageCols(): WorkStageColumn[] {
  return [
    stageCol('new', 'New lead', 'open', { probability: 20, count: 1, value: [{ currency: 'USD', amount: 200_000 }], weighted: [{ currency: 'USD', amount: 40_000 }] }),
    stageCol('contacted', 'Contacted', 'open', { probability: 40 }),
    stageCol('proposal', 'Proposal sent', 'open', { probability: 60, count: 2, value: [{ currency: 'INR', amount: 65_000_000 }], weighted: [{ currency: 'INR', amount: 39_000_000 }], quiet: 1 }),
    stageCol('negotiation', 'Negotiation', 'open', { probability: 80 }),
    stageCol('won', 'Won', 'won', { count: 1, value: [{ currency: 'INR', amount: 30_000_000 }], weighted: [{ currency: 'INR', amount: 30_000_000 }] }),
    stageCol('lost', 'Lost', 'lost'),
  ];
}

/** The open deals: Site rebuild (a next step, closes later), AI audit (quiet, no next step), Brand refresh (its close day passed). */
export function dealCards(): WorkDealCard[] {
  return [
    dealCard(IDS.deal, { client: { id: IDS.client, name: 'Acme' }, next: { todoId: IDS.followUp, title: 'Call about scope', due: { day: '2026-01-16', time: '15:00' } }, expectedClose: '2026-01-30', closeState: 'later', source: 'Referral' }),
    dealCard(IDS.deal2, { title: 'AI audit', client: { id: IDS.northwindCo, name: 'Northwind' }, value: 20_000_000, daysInStage: 9, quiet: true }),
    dealCard(IDS.deal3, { title: 'Brand refresh', client: { id: IDS.globexCo, name: 'Globex' }, stage: 'new', stageName: 'New lead', value: 200_000, currency: 'USD', daysInStage: 3, expectedClose: '2026-01-10', closeState: 'overdue', next: { todoId: IDS.todo1, title: 'Send the deck' } }),
  ];
}

export const DEALS = (deals = dealCards(), stages = stageCols()): WorkDealsResponse => ({ deals, more: 0, stages });

/** A won deal, for Won's own list. */
export const WON = (): WorkDealsResponse => ({
  deals: [dealCard('01JWRKDEA10000000000000W0N', { title: 'Shop launch', client: { id: IDS.client, name: 'Acme' }, stage: 'won', stageName: 'Won', kind: 'won', value: 30_000_000, wonAt: '2026-01-10T10:00:00.000Z', daysInStage: 5 })],
  more: 0,
  stages: stageCols(),
});

export function deal(id: string, over: Partial<Deal> = {}): Deal {
  return { id, title: 'Site rebuild', contactId: IDS.client, stage: 'proposal', value: 45_000_000, currency: 'INR', expectedClose: '2026-01-30', source: 'Referral', stageMovedAt: '2026-01-03T10:00:00.000Z', createdAt: '2025-12-20T10:00:00.000Z', updatedAt: AT, ...over };
}

/** Site rebuild for Acme: its card, a follow-up, its project, and its log (a move and a call). */
export function dealHub(over: Partial<WorkDealHub> = {}): WorkDealHub {
  const card = dealCards()[0]!;
  return {
    deal: deal(IDS.deal),
    card,
    client: { id: IDS.client, name: 'Acme', state: 'lead' },
    project: project(IDS.acme, { name: 'Site rebuild', clientId: IDS.client }),
    followUps: [todo(IDS.followUp, { title: 'Call about scope', due: { day: '2026-01-16', time: '15:00' }, contactId: IDS.client, dealId: IDS.deal })],
    log: [
      logRow(IDS.log1, { kind: 'stage', stageFrom: 'contacted', stageTo: 'proposal', contactId: IDS.client, dealId: IDS.deal, at: '2026-01-03T10:00:00.000Z' }),
      logRow(IDS.log2, { kind: 'call', direction: 'out', minutes: 20, body: 'Sent the proposal over.', contactId: IDS.client, dealId: IDS.deal, at: '2026-01-02T10:00:00.000Z' }),
    ],
    ...over,
  };
}

export const STAGES = (): WorkStagesReply => ({
  stages: stageCols().map((c, order) => ({ id: c.id, name: c.name, kind: c.kind, order, effectiveProbability: c.probability, deals: c.kind === 'open' ? c.count : 0, ...(c.id === 'proposal' ? { probability: 60 } : {}) })),
  quietDays: 14,
});

/** One currency's book with nothing in it: every rate null ("—"), never 0 %. */
export function emptyBook(currency: string | null = 'INR'): WorkInsightsBook {
  return {
    currency,
    winRate: { won: 0, lost: 0, closed: 0, open: 0, rate: null },
    cycle: { averageDays: null, sample: 0, fastestDays: null, slowestDays: null },
    revenueByMonth: [],
    losses: [],
    sources: [],
    forecast: { months: [], unscheduled: { value: 0, weighted: 0, count: 0 } },
    trend: [],
    open: { count: 0, value: 0, weighted: 0 },
  };
}

/** Insights over 90 days: a rupee book with wins and a loss, a dollar book with one open deal. */
export function insights(over: Partial<WorkInsightsReply> = {}): WorkInsightsReply {
  return {
    period: { preset: '90d', from: '2025-10-17T00:00:00.000Z', to: '2026-01-15T10:00:00.000Z' },
    books: [
      {
        ...emptyBook('INR'),
        winRate: { won: 2, lost: 1, closed: 3, open: 2, rate: 2 / 3 },
        cycle: { averageDays: 18.5, sample: 2, fastestDays: 12, slowestDays: 25 },
        revenueByMonth: [
          { month: '2025-12', label: 'Dec 2025', value: 20_000_000, count: 1 },
          { month: '2026-01', label: 'Jan 2026', value: 30_000_000, count: 1 },
        ],
        losses: [{ code: 'price', label: 'Price', count: 1, value: 10_000_000, share: 1 }],
        sources: [{ source: 'Referral', deals: 3, won: 2, lost: 0, open: 1, revenue: 50_000_000, openValue: 45_000_000, winRate: 1 }],
        forecast: { months: [{ month: '2026-01', label: 'Jan 2026', value: 45_000_000, weighted: 27_000_000, count: 1 }], unscheduled: { value: 20_000_000, weighted: 12_000_000, count: 1 } },
        open: { count: 2, value: 65_000_000, weighted: 39_000_000 },
      },
      { ...emptyBook('USD'), winRate: { won: 0, lost: 0, closed: 0, open: 1, rate: null }, open: { count: 1, value: 200_000, weighted: 40_000 } },
    ],
    funnel: {
      rows: [
        { stageId: 'new', name: 'New lead', kind: 'open', order: 0, entered: 4, exited: 3, advanced: 3, lostFrom: 0, net: 1, conversionRate: 0.75 },
        { stageId: 'proposal', name: 'Proposal sent', kind: 'open', order: 2, entered: 3, exited: 1, advanced: 1, lostFrom: 0, net: 2, conversionRate: null },
      ],
      unknownEntered: 0,
      unknownExited: 0,
    },
    timeInStage: [{ stageId: 'proposal', name: 'Proposal sent', kind: 'open', order: 2, averageDays: 10.5, medianDays: 9, sample: 2, sittingCount: 2, oldestSittingDays: 12 }],
    ...over,
  };
}

/** Every read Deals makes, answered: the pipeline, Won's list, settings, one hub, a client's (for Won's folder), the stages. */
export function dealAnswers(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'GET /v1/work/deals': (init: ApiRequest) => (init.query?.open === '0' ? WON() : DEALS()),
    'GET /v1/work/deals/:id': dealHub(),
    'GET /v1/work/settings': SETTINGS(),
    'GET /v1/work/stages': STAGES(),
    'GET /v1/work/clients': CLIENTS(),
    'GET /v1/work/clients/:id': clientHub({ contact: contact(IDS.client, { name: 'Acme', kind: 'company', folder: '/Users/example/Desktop/work/client/acme' }) }),
    'GET /v1/work/insights': insights(),
    'POST /v1/work/deals/:id/move': (init: ApiRequest) => ({ id: init.params?.id, from: 'proposal' }),
    ...over,
  };
}
