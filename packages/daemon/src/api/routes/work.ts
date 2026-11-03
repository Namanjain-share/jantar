/**
 * v0.13 Work's routes (feature `work`: life.work with life.todos; owner
 * routes on his host, never under /v1/p/). P1: foldersSeed, "Start from
 * your client folders": one project per folder he picked, its folder
 * linked (P2: and a company client each). Never automatic.
 *
 * P2: clients, the log, meetings linked to clients, import and export,
 * settings and client_here. P3: deals, their moves (Won's project in the
 * same save), stages and insights; a deal's log names its meetings here
 * as a client's does. Each calls `s.deps.life.work`; the replies to
 * writes are ids (and counts); the audit row is the target id alone (no
 * params: a client's words never reach the audit log). Work never reads
 * meetings.db: the meeting routes read the meeting here (Meetings' off
 * sentence while Meetings is off) and hand Work its id, project, start and
 * people; a client's log names its meetings here too, and a row whose
 * meeting is gone is left out.
 *
 * The folders come as the browsers address them (a root id and a path
 * under it), so a phone without admin, which never sees an absolute path,
 * can send them. Each must sit under a configured root (folders.roots),
 * checked by the one path policy Files and New session use (no symlink out,
 * nothing protected), and the call needs one of those two browsers on:
 * Work adds no new way to list the Mac's folders. Any refusal refuses the
 * whole call before a project is made.
 *
 * The pipeline has checked control scope, the switch, a broken life.db,
 * the strict body and the Life write limit. The reply is ids and a count;
 * the audit row has no target and no params: a folder's name can be a
 * client's.
 */
import type {
  FolderClientQuery,
  FolderClientResponse,
  WorkClientCreateBody,
  WorkClientLogQuery,
  WorkClientNamesQuery,
  WorkClientPatch,
  WorkClientSimilarBody,
  WorkClientsQuery,
  WorkDealCreateBody,
  WorkDealMoveBody,
  WorkDealPatch,
  WorkDealsQuery,
  WorkExportQuery,
  WorkImportBody,
  WorkImportPreviewBody,
  WorkLogAddBody,
  WorkLogPatch,
  WorkMeetingClientNewBody,
  WorkMeetingClientsBody,
  WorkSeedBody,
  WorkSettingsPatch,
  WorkInsightsQuery,
  WorkMilestonesBody,
  WorkStagesBody,
} from '@jantar/protocol/work';
import type { LifeResult } from '../../contracts.js';
import { isRefusal, refusalResult } from '../../launcher/folders.js';
import { ApiError } from '../errors.js';
import { lifeAudit, lifeValue, needActor, type Call, type RawReply, type RouteTable } from '../route-kit.js';
import { meetingOf, namedMeetings } from '../work-meetings.js';

type Id = { id: string };
type MeetingParams = { meetingId: string };
const OK = { ok: true as const };

/** What the seed says while neither folder browser is on (W40). */
export const SEED_NEEDS_BROWSER = 'Picking folders needs Files or New session on. Turn one on at your Mac: jantar files on';
/** A folder outside the configured roots (a live session's own folder is not one). */
export const SEED_NEEDS_ROOT = 'Pick a folder inside one of your folders. Add one at your Mac, for example: jantar folders add-root ~/Desktop';

export const WORK_ROUTE_IMPLS: RouteTable = {
  foldersSeed: {
    handle: async (c: Call<Record<string, string>, unknown, WorkSeedBody>, s) => {
      const actor = needActor(c.auth);
      const settings = s.ctx.settings.get();
      if (!settings.files.enabled && !settings.launch.enabled) throw new ApiError('forbidden', SEED_NEEDS_BROWSER);
      const items: { folder: string; name: string }[] = [];
      for (const item of c.body.items) {
        const dir = await s.deps.files.policy.resolveDir(item.root, item.path);
        if (isRefusal(dir)) {
          const r = refusalResult(dir);
          throw new ApiError(r.code, r.reason);
        }
        if (dir.root.kind !== 'configured' || dir.rel === '') throw new ApiError('invalid_request', SEED_NEEDS_ROOT);
        items.push({ folder: dir.real, name: item.name });
      }
      return lifeValue(s.deps.life.work.seed(items, actor, { clients: c.body.clients === true }));
    },
    // No target and no params: the folders and names stay out of the audit log.
    audit: () => ({}),
  },

  // --- P2: clients
  workClients: {
    handle: (c: Call<Id, WorkClientsQuery>, s) => lifeValue(s.deps.life.work.clients(c.query, needActor(c.auth))),
  },
  workClientCreate: {
    handle: (c: Call<Id, unknown, WorkClientCreateBody>, s) => lifeValue(s.deps.life.work.createClient(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  // A POST read (a phone or an e-mail never sits in a URL): its pipeline row has no target and no params.
  workClientSimilar: {
    handle: (c: Call<Id, unknown, WorkClientSimilarBody>, s) => lifeValue(s.deps.life.work.similar(c.body, needActor(c.auth))),
  },
  workClientNames: {
    handle: (c: Call<Id, WorkClientNamesQuery>, s) => lifeValue(s.deps.life.work.names(c.query.ids, needActor(c.auth))),
  },
  workClientGet: {
    handle: (c: Call<Id>, s) => {
      const hub = lifeValue(s.deps.life.work.client(c.params.id, needActor(c.auth)));
      return { ...hub, log: namedMeetings(s, hub.log) };
    },
  },
  workClientLog: {
    handle: (c: Call<Id, WorkClientLogQuery>, s) => {
      const page = lifeValue(s.deps.life.work.clientLog(c.params.id, c.query.before, needActor(c.auth)));
      return { ...page, log: namedMeetings(s, page.log) };
    },
  },
  workClientUpdate: {
    handle: (c: Call<Id, unknown, WorkClientPatch>, s) => {
      lifeValue(s.deps.life.work.updateClient(c.params.id, c.body, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
  workClientDelete: {
    handle: (c: Call<Id>, s) => ({ ok: true as const, removed: lifeValue(s.deps.life.work.removeClient(c.params.id, needActor(c.auth))) }),
    audit: lifeAudit,
  },

  // --- P2: the log
  workLogAdd: {
    handle: (c: Call<Id, unknown, WorkLogAddBody>, s) => lifeValue(s.deps.life.work.addLog(c.params.id, c.body, needActor(c.auth))),
    // The client's id (the path), not the new row's.
    audit: lifeAudit,
  },
  workLogUpdate: {
    handle: (c: Call<Id, unknown, WorkLogPatch>, s) => {
      lifeValue(s.deps.life.work.updateLog(c.params.id, c.body, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
  workLogDelete: {
    handle: (c: Call<Id>, s) => {
      lifeValue(s.deps.life.work.removeLog(c.params.id, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },

  // --- P2: meetings linked to clients (Meetings' off sentence while it is off)
  workMeetingClients: {
    handle: (c: Call<MeetingParams, unknown, WorkMeetingClientsBody>, s) => {
      const m = meetingOf(s, c.params.meetingId);
      lifeValue(s.deps.life.work.setMeetingClients(m, c.body.clientIds, needActor(c.auth)));
      return OK;
    },
    audit: (c: Call<MeetingParams>) => ({ target: c.params.meetingId }),
  },
  workMeetingSuggest: {
    handle: (c: Call<MeetingParams>, s) => lifeValue(s.deps.life.work.meetingSuggest(meetingOf(s, c.params.meetingId), needActor(c.auth))),
  },
  workMeetingClientNew: {
    handle: (c: Call<MeetingParams, unknown, WorkMeetingClientNewBody>, s) => lifeValue(s.deps.life.work.meetingClientNew(meetingOf(s, c.params.meetingId), c.body, needActor(c.auth))),
    audit: lifeAudit,
  },

  // --- P2: import and export
  // A POST read (the preview keeps the file in memory for the import): its row has no target and no params.
  workImportPreview: {
    handle: (c: Call<Id, unknown, WorkImportPreviewBody>, s) => lifeValue(s.deps.life.work.importPreview(c.body, needActor(c.auth))),
  },
  workImport: {
    handle: (c: Call<Id, unknown, WorkImportBody>, s) => lifeValue(s.deps.life.work.importRows(c.body, needActor(c.auth))),
    audit: (_c: Call, out: { status: number; body: unknown }) => {
      const batch = (out.body as { batch?: unknown } | null)?.batch;
      return typeof batch === 'string' ? { target: batch } : {};
    },
  },
  workImports: {
    handle: (c: Call, s) => lifeValue(s.deps.life.work.imports(needActor(c.auth))),
  },
  workImportUndo: {
    handle: (c: Call<{ batch: string }>, s) => lifeValue(s.deps.life.work.undoImport(c.params.batch, needActor(c.auth))),
    audit: (c: Call<{ batch: string }>) => ({ target: c.params.batch }),
  },
  workExport: {
    handle: (c: Call<Id, WorkExportQuery>, s): RawReply => {
      const what = c.query.what;
      const csv = lifeValue(s.deps.life.work.exportCsv(needActor(c.auth), what));
      return { kind: 'raw', type: 'text/csv; charset=utf-8', body: Buffer.from(csv, 'utf8'), headers: { 'content-disposition': `attachment; filename="jantar-${what}.csv"` } };
    },
  },

  // --- P2: settings, and client_here (ctl.sock only)
  workSettings: {
    handle: (c: Call, s) => lifeValue(s.deps.life.work.settingsGet(needActor(c.auth))),
  },
  workSettingsUpdate: {
    handle: (c: Call<Id, unknown, WorkSettingsPatch>, s) => {
      lifeValue(s.deps.life.work.settingsUpdate(c.body, needActor(c.auth)));
      return OK;
    },
    audit: () => ({}),
  },
  // --- P3: deals, stages and insights (audit rows: the deal's id alone)
  workDeals: {
    handle: (c: Call<Id, WorkDealsQuery>, s) => lifeValue(s.deps.life.work.deals(c.query, needActor(c.auth))),
  },
  workDealCreate: {
    handle: (c: Call<Id, unknown, WorkDealCreateBody>, s) => lifeValue(s.deps.life.work.createDeal(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  workDealGet: {
    handle: (c: Call<Id>, s) => {
      const hub = lifeValue(s.deps.life.work.deal(c.params.id, needActor(c.auth)));
      return { ...hub, log: namedMeetings(s, hub.log) };
    },
  },
  workDealUpdate: {
    handle: (c: Call<Id, unknown, WorkDealPatch>, s) => {
      lifeValue(s.deps.life.work.updateDeal(c.params.id, c.body, needActor(c.auth)));
      return OK;
    },
    audit: lifeAudit,
  },
  workDealDelete: {
    handle: (c: Call<Id>, s) => ({ ok: true as const, removed: lifeValue(s.deps.life.work.removeDeal(c.params.id, needActor(c.auth))) }),
    audit: lifeAudit,
  },
  workDealMove: {
    handle: (c: Call<Id, unknown, WorkDealMoveBody>, s) => lifeValue(s.deps.life.work.moveDeal(c.params.id, c.body, needActor(c.auth))),
    // The deal's id (the path); its stage names and a project's name stay out.
    audit: lifeAudit,
  },
  workStages: {
    handle: (c: Call, s) => lifeValue(s.deps.life.work.stagesGet(needActor(c.auth))),
  },
  workStagesUpdate: {
    handle: (c: Call<Id, unknown, WorkStagesBody>, s) => ({ ok: true as const, ...lifeValue(s.deps.life.work.stagesPut(c.body, needActor(c.auth))) }),
    audit: () => ({}),
  },
  workInsights: {
    handle: (c: Call<Id, WorkInsightsQuery>, s) => lifeValue(s.deps.life.work.insights(c.query, needActor(c.auth))),
  },
  workProjectMilestones: {
    handle: (c: Call<Id, unknown, WorkMilestonesBody>, s) => {
      lifeValue(s.deps.life.work.setMilestones(c.params.id, c.body, needActor(c.auth)));
      return OK;
    },
    // The project's id; the milestones' names stay out.
    audit: lifeAudit,
  },

  workClientHere: {
    handle: (c: Call<Id, FolderClientQuery>, s) => {
      // Life not open answers with its refusal (life/service.ts closedModule).
      const r = s.deps.life.work.forFolder(c.query.folder) as FolderClientResponse | LifeResult<never>;
      return 'ok' in r ? lifeValue(r) : r;
    },
  },
};
