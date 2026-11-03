/**
 * 0.13.0 Work: the owner's client for Work's routes, in Work's lazy chunk
 * (and the palette's, for the search), so the main load carries none of
 * it. The calls go through the app's own `api.request` (the device secret
 * and an Idempotency-Key on a write, as every call). Every path is one of
 * `@jantar/protocol/work`'s WORK_ROUTES, taken here as words so the chunk
 * carries no schema (test/work/client.test.ts compares them).
 *
 * Owner-only: every route here is a control route on his host. Her app
 * (src/partner) never imports this file (test/work/isolation.test.ts).
 *
 * The second part of 0.13.0 adds his clients: the list and one client as a
 * hub, add, change and delete, the similar check (a POST, so a phone or an
 * e-mail never sits in a URL), the log, a meeting's clients, import (a
 * preview first, then the rows he decided, undoable for 7 days), the CSV
 * export (text), Work's settings read, and duplicates with merge.
 *
 * The third part adds his deals: the pipeline (cards and each stage's
 * column), one deal as a hub, add, change, delete and move (Won may make
 * the project in the same save; Lost takes a reason), the stages read and
 * replaced, insights for a period, the deals CSV, and a project's
 * milestones.
 */
import type { OkReply } from '@jantar/protocol';
import type {
  ProjectHub,
  SearchResponse,
  WorkClientCreateBody,
  WorkClientCreateReply,
  WorkClientDeleteReply,
  WorkClientHub,
  WORK_CLIENT_LISTS,
  WORK_CLIENT_SORTS,
  WorkClientListsReply,
  WorkClientNamesReply,
  WorkClientPatch,
  WorkClientSimilarBody,
  WorkClientSimilarReply,
  WorkClientsResponse,
  WorkDealCreateBody,
  WorkDealCreateReply,
  WorkDealDeleteReply,
  WorkDealHub,
  WorkDealMoveBody,
  WorkDealMoveReply,
  WorkDealPatch,
  WorkDealsResponse,
  WorkDuplicatesReply,
  WorkImportBody,
  WorkImportPreviewBody,
  WorkImportPreviewReply,
  WorkImportReply,
  WorkImportsReply,
  WorkImportUndoReply,
  WorkInsightsReply,
  WORK_INSIGHT_PERIODS,
  WorkLogAddBody,
  WorkLogAddReply,
  WorkLogPage,
  WorkLogPatch,
  WorkMeetingClientNewBody,
  WorkMeetingClientsBody,
  WorkMeetingSuggestReply,
  WorkMergeBody,
  WorkMergeConflictsReply,
  WorkMilestonesBody,
  WorkSeedBody,
  WorkSeedReply,
  WorkSettings,
  WorkStagesBody,
  WorkStagesPutReply,
  WorkStagesReply,
  ContactKind,
  ContactState,
} from '@jantar/protocol/work';
import type { Api, ApiRoute } from '../../../lib/api.js';

export const WORK_PATHS = {
  projectGet: { method: 'GET', path: '/v1/projects/:id' },
  search: { method: 'GET', path: '/v1/search' },
  foldersSeed: { method: 'POST', path: '/v1/work/seed' },
  workClientNames: { method: 'GET', path: '/v1/work/clients/names' },
  // --- his clients
  workClients: { method: 'GET', path: '/v1/work/clients' },
  workClientLists: { method: 'GET', path: '/v1/work/clients/lists' },
  workClientCreate: { method: 'POST', path: '/v1/work/clients' },
  workClientSimilar: { method: 'POST', path: '/v1/work/clients/similar' },
  workClientGet: { method: 'GET', path: '/v1/work/clients/:id' },
  workClientLog: { method: 'GET', path: '/v1/work/clients/:id/log' },
  workClientUpdate: { method: 'PATCH', path: '/v1/work/clients/:id' },
  workClientDelete: { method: 'DELETE', path: '/v1/work/clients/:id' },
  workLogAdd: { method: 'POST', path: '/v1/work/clients/:id/log' },
  workLogUpdate: { method: 'PATCH', path: '/v1/work/log/:id' },
  workLogDelete: { method: 'DELETE', path: '/v1/work/log/:id' },
  workMeetingSuggest: { method: 'GET', path: '/v1/work/meetings/:meetingId/suggest' },
  workMeetingClients: { method: 'PUT', path: '/v1/work/meetings/:meetingId/clients' },
  workMeetingClientNew: { method: 'POST', path: '/v1/work/meetings/:meetingId/clients/new' },
  workImportPreview: { method: 'POST', path: '/v1/work/import/preview' },
  workImport: { method: 'POST', path: '/v1/work/import' },
  workImports: { method: 'GET', path: '/v1/work/imports' },
  workImportUndo: { method: 'DELETE', path: '/v1/work/import/:batch' },
  workExport: { method: 'GET', path: '/v1/work/export.csv' },
  workSettings: { method: 'GET', path: '/v1/work/settings' },
  workDuplicates: { method: 'GET', path: '/v1/work/duplicates' },
  workMergeConflicts: { method: 'GET', path: '/v1/work/clients/:id/merge' },
  workMerge: { method: 'POST', path: '/v1/work/clients/:id/merge' },
  workNotDuplicate: { method: 'POST', path: '/v1/work/clients/:id/not-duplicate' },
  // --- his deals
  workDeals: { method: 'GET', path: '/v1/work/deals' },
  workDealCreate: { method: 'POST', path: '/v1/work/deals' },
  workDealGet: { method: 'GET', path: '/v1/work/deals/:id' },
  workDealUpdate: { method: 'PATCH', path: '/v1/work/deals/:id' },
  workDealDelete: { method: 'DELETE', path: '/v1/work/deals/:id' },
  workDealMove: { method: 'POST', path: '/v1/work/deals/:id/move' },
  workStages: { method: 'GET', path: '/v1/work/stages' },
  workStagesUpdate: { method: 'PUT', path: '/v1/work/stages' },
  workInsights: { method: 'GET', path: '/v1/work/insights' },
  workProjectMilestones: { method: 'PUT', path: '/v1/work/projects/:id/milestones' },
} as const satisfies Record<string, ApiRoute>;

/** The search's shortest query, once trimmed (WORK_LIMITS.searchMin). */
export const SEARCH_MIN = 2;
/** And its longest (WORK_LIMITS.searchMax). */
export const SEARCH_MAX = 80;

/** What the Deals list asks for (GET /v1/work/deals's query): open ones unless `open` is false. */
export interface DealsFilter {
  open?: boolean | undefined;
  stage?: string | undefined;
  client?: string | undefined;
  business?: string | undefined;
  closing?: 'week' | 'month' | undefined;
  quiet?: boolean | undefined;
  q?: string | undefined;
}

/** What the Clients list asks for (GET /v1/work/clients's query; the starter lists are P3b's). */
export interface ClientsFilter {
  q?: string | undefined;
  state?: ContactState | undefined;
  kind?: ContactKind | undefined;
  tag?: string | undefined;
  /** A company's people. */
  company?: string | undefined;
  list?: (typeof WORK_CLIENT_LISTS)[number] | undefined;
  sort?: (typeof WORK_CLIENT_SORTS)[number] | undefined;
}

export interface WorkClient {
  /** One project as a hub (GET /v1/projects/:id; the Todos switch). */
  projectHub(id: string): Promise<ProjectHub>;
  /** One search across Jantar: each group only while its part is on (2 to 80 characters). */
  search(q: string, signal?: AbortSignal): Promise<SearchResponse>;
  /** One project per folder under a root, its folder linked; `clients`: a company client each too. */
  seed(body: WorkSeedBody, idempotencyKey?: string): Promise<WorkSeedReply>;
  /** Clients' names by id (at most 100), for the client on a project row or a follow-up. */
  clientNames(ids: readonly string[]): Promise<WorkClientNamesReply>;

  /** His clients and companies, filtered and sorted (500 at most; the rest counted in `more`). */
  clients(filter?: ClientsFilter): Promise<WorkClientsResponse>;
  /** The starter lists, each with how many it holds. */
  clientLists(): Promise<WorkClientListsReply>;
  clientCreate(body: WorkClientCreateBody, idempotencyKey?: string): Promise<WorkClientCreateReply>;
  /** Who this may already be: a warning, never a block (W29). */
  clientSimilar(body: WorkClientSimilarBody): Promise<WorkClientSimilarReply>;
  /** One client as a hub: details, company or people, projects, follow-ups, deals and the newest log. */
  client(id: string): Promise<WorkClientHub>;
  /** The next page of its log, after the cursor the last page gave. */
  clientLog(id: string, before: string): Promise<WorkLogPage>;
  clientUpdate(id: string, patch: WorkClientPatch, idempotencyKey?: string): Promise<OkReply>;
  clientDelete(id: string, idempotencyKey?: string): Promise<WorkClientDeleteReply>;
  /** A call, meeting, e-mail, message or note, and its next step, in one save (W13). */
  logAdd(clientId: string, body: WorkLogAddBody, idempotencyKey?: string): Promise<WorkLogAddReply>;
  logUpdate(id: string, patch: WorkLogPatch, idempotencyKey?: string): Promise<OkReply>;
  logDelete(id: string, idempotencyKey?: string): Promise<OkReply>;
  /** A meeting's clients now, its project's client, and its people's names matched to clients. */
  meetingSuggest(meetingId: string): Promise<WorkMeetingSuggestReply>;
  /** Sets a meeting's clients (replacing them: leaving one out unlinks it). */
  meetingClients(meetingId: string, body: WorkMeetingClientsBody, idempotencyKey?: string): Promise<OkReply>;
  /** A client made from one of the meeting's people (marked as a meeting's words), linked to it. */
  meetingClientNew(meetingId: string, body: WorkMeetingClientNewBody, idempotencyKey?: string): Promise<{ id: string }>;
  importPreview(body: WorkImportPreviewBody, idempotencyKey?: string): Promise<WorkImportPreviewReply>;
  importRun(body: WorkImportBody, idempotencyKey?: string): Promise<WorkImportReply>;
  imports(): Promise<WorkImportsReply>;
  importUndo(batch: string, idempotencyKey?: string): Promise<WorkImportUndoReply>;
  /** Every client as a CSV file's text. */
  exportCsv(): Promise<string>;
  settings(): Promise<WorkSettings>;
  duplicates(): Promise<WorkDuplicatesReply>;
  /** The fields `id` and `loser` hold differently, for the merge picker. */
  mergeConflicts(id: string, loser: string): Promise<WorkMergeConflictsReply>;
  merge(id: string, body: WorkMergeBody, idempotencyKey?: string): Promise<OkReply>;
  notDuplicate(id: string, otherId: string, idempotencyKey?: string): Promise<OkReply>;

  /** His deals as cards (open ones unless asked otherwise), with every stage's column. */
  deals(filter?: DealsFilter): Promise<WorkDealsResponse>;
  dealCreate(body: WorkDealCreateBody, idempotencyKey?: string): Promise<WorkDealCreateReply>;
  /** One deal as a hub: the deal, its card, client, project, open follow-ups and log. */
  deal(id: string): Promise<WorkDealHub>;
  dealUpdate(id: string, patch: WorkDealPatch, idempotencyKey?: string): Promise<OkReply>;
  dealDelete(id: string, idempotencyKey?: string): Promise<WorkDealDeleteReply>;
  /** To any stage: Won (with `project`, the project too), Lost (with a reason), or open again. The reply names the stage it left. */
  dealMove(id: string, body: WorkDealMoveBody, idempotencyKey?: string): Promise<WorkDealMoveReply>;
  stages(): Promise<WorkStagesReply>;
  /** The whole list in its new order (a removed stage that holds deals names where they go). */
  stagesUpdate(body: WorkStagesBody, idempotencyKey?: string): Promise<WorkStagesPutReply>;
  insights(period: (typeof WORK_INSIGHT_PERIODS)[number], business?: string): Promise<WorkInsightsReply>;
  /** Every deal as a CSV file's text. */
  exportDealsCsv(): Promise<string>;
  /** A project's milestones, the whole list in order (one without an id is new). */
  milestones(projectId: string, body: WorkMilestonesBody, idempotencyKey?: string): Promise<OkReply>;
}

const k = (idempotencyKey?: string) => (idempotencyKey ? { idempotencyKey } : {});

export function workClient(api: Api): WorkClient {
  const P = WORK_PATHS;
  return {
    projectHub: (id) => api.request(P.projectGet, { params: { id } }),
    search: (q, signal) => api.request(P.search, { query: { q: q.trim().slice(0, SEARCH_MAX) }, ...(signal ? { signal } : {}) }),
    seed: (body, key) => api.request(P.foldersSeed, { body, ...k(key) }),
    clientNames: (ids) => api.request(P.workClientNames, { query: { ids: ids.slice(0, 100).join(',') } }),

    clients: (f = {}) =>
      api.request(P.workClients, { query: { q: f.q?.trim() || undefined, state: f.state, kind: f.kind, tag: f.tag, company: f.company, list: f.list, sort: f.sort } }),
    clientLists: () => api.request(P.workClientLists),
    clientCreate: (body, key) => api.request(P.workClientCreate, { body, ...k(key) }),
    clientSimilar: (body) => api.request(P.workClientSimilar, { body }),
    client: (id) => api.request(P.workClientGet, { params: { id } }),
    clientLog: (id, before) => api.request(P.workClientLog, { params: { id }, query: { before } }),
    clientUpdate: (id, patch, key) => api.request(P.workClientUpdate, { params: { id }, body: patch, ...k(key) }),
    clientDelete: (id, key) => api.request(P.workClientDelete, { params: { id }, ...k(key) }),
    logAdd: (clientId, body, key) => api.request(P.workLogAdd, { params: { id: clientId }, body, ...k(key) }),
    logUpdate: (id, patch, key) => api.request(P.workLogUpdate, { params: { id }, body: patch, ...k(key) }),
    logDelete: (id, key) => api.request(P.workLogDelete, { params: { id }, ...k(key) }),
    meetingSuggest: (meetingId) => api.request(P.workMeetingSuggest, { params: { meetingId } }),
    meetingClients: (meetingId, body, key) => api.request(P.workMeetingClients, { params: { meetingId }, body, ...k(key) }),
    meetingClientNew: (meetingId, body, key) => api.request(P.workMeetingClientNew, { params: { meetingId }, body, ...k(key) }),
    importPreview: (body, key) => api.request(P.workImportPreview, { body, ...k(key) }),
    importRun: (body, key) => api.request(P.workImport, { body, ...k(key) }),
    imports: () => api.request(P.workImports),
    importUndo: (batch, key) => api.request(P.workImportUndo, { params: { batch }, ...k(key) }),
    exportCsv: () => api.request(P.workExport, { query: { what: 'clients' }, text: true }),
    settings: () => api.request(P.workSettings),
    duplicates: () => api.request(P.workDuplicates),
    mergeConflicts: (id, loser) => api.request(P.workMergeConflicts, { params: { id }, query: { loser } }),
    merge: (id, body, key) => api.request(P.workMerge, { params: { id }, body, ...k(key) }),
    notDuplicate: (id, otherId, key) => api.request(P.workNotDuplicate, { params: { id }, body: { otherId }, ...k(key) }),

    deals: (f = {}) =>
      api.request(P.workDeals, {
        query: {
          open: f.open === false ? '0' : undefined,
          stage: f.stage,
          client: f.client,
          business: f.business,
          closing: f.closing,
          quiet: f.quiet === undefined ? undefined : f.quiet ? '1' : '0',
          q: f.q?.trim() || undefined,
        },
      }),
    dealCreate: (body, key) => api.request(P.workDealCreate, { body, ...k(key) }),
    deal: (id) => api.request(P.workDealGet, { params: { id } }),
    dealUpdate: (id, patch, key) => api.request(P.workDealUpdate, { params: { id }, body: patch, ...k(key) }),
    dealDelete: (id, key) => api.request(P.workDealDelete, { params: { id }, ...k(key) }),
    dealMove: (id, body, key) => api.request(P.workDealMove, { params: { id }, body, ...k(key) }),
    stages: () => api.request(P.workStages),
    stagesUpdate: (body, key) => api.request(P.workStagesUpdate, { body, ...k(key) }),
    insights: (period, business) => api.request(P.workInsights, { query: { period, business } }),
    exportDealsCsv: () => api.request(P.workExport, { query: { what: 'deals' }, text: true }),
    milestones: (projectId, body, key) => api.request(P.workProjectMilestones, { params: { id: projectId }, body, ...k(key) }),
  };
}
