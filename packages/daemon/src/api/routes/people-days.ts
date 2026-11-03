/**
 * v0.11 People (P2): the owner's routes for her days (spec 9.3.4): her plan
 * and templates, her evening review, her sleep and journal (reads through
 * `ownerViewOf`, which writes the view mark), his journal comments, alerts
 * with her, and his prefs for pushes about her.
 *
 * Every read of an area that is off, of a person he can't reach, or of a
 * row he may not see answers the one not_found. He never writes in her
 * name: no route here marks a step done, writes a night or a journal
 * entry, sets her status or sends her review (T14).
 */
import type { JournalEntryFull, OwnerAlertSendBody, OwnerPeoplePrefsPatch, PlanApplyBody, PlanPutBody, TemplateBody, TemplatePatch } from '@jantar/protocol/people';
import { ApiError } from '../errors.js';
import { lifeAudit, lifeValue, type Call, type RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';
import { NO_PERSON } from './people.js';

type Pid = { pid: string };
type PidDay = { pid: string; day: string };
type PidId = { pid: string; id: string };
const OK = { ok: true as const };

function people(s: ApiServices) {
  const p = s.deps.life.people;
  if (!p.plans || !p.alerts || !p.journal || !p.sleep || !p.views) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return { plans: p.plans, alerts: p.alerts, journal: p.journal, views: p.views, module: p };
}

/** His read of one area (off, unreachable or unbuilt: the unknown-pid answer). */
function read(s: ApiServices, pid: string, area: 'plan' | 'review' | 'sleep' | 'journal', opts: Record<string, string | undefined>) {
  const v = people(s).views.ownerViewOf(pid, area, opts);
  if (v === null || 'locked' in v) throw new ApiError('not_found', NO_PERSON);
  return v;
}

export const PEOPLE_DAYS_ROUTE_IMPLS: RouteTable = {
  personPlanOwnerGet: {
    handle: (c: Call<PidDay>, s) => read(s, c.params.pid, 'plan', { day: c.params.day }),
  },
  personPlanPut: {
    handle: (c: Call<PidDay, unknown, PlanPutBody>, s) => lifeValue(people(s).plans.put(c.params.pid, c.params.day, c.body)),
    audit: (c: Call<PidDay>) => ({ target: c.params.day }),
  },
  personPlanDelete: {
    handle: (c: Call<PidDay>, s) => (lifeValue(people(s).plans.remove(c.params.pid, c.params.day)), OK),
    audit: (c: Call<PidDay>) => ({ target: c.params.day }),
  },
  personPlanApply: {
    handle: (c: Call<PidDay, unknown, PlanApplyBody>, s) => lifeValue(people(s).plans.apply(c.params.pid, c.params.day, c.body)),
    audit: (c: Call<PidDay>) => ({ target: c.params.day }),
  },
  personOwnerReview: {
    handle: (c: Call<PidDay>, s) => read(s, c.params.pid, 'review', { day: c.params.day }),
  },
  personReviewCarry: {
    handle: (c: Call<PidDay, unknown, { steps: string[]; to?: string }>, s) => (lifeValue(people(s).plans.ownerCarry(c.params.pid, c.params.day, c.body.steps, c.body.to)), OK),
    audit: (c: Call<PidDay>) => ({ target: c.params.day }),
  },
  personTemplates: {
    handle: (c: Call<Pid>, s) => lifeValue(people(s).plans.templates(c.params.pid)),
  },
  personTemplateCreate: {
    handle: (c: Call<Pid, unknown, TemplateBody>, s) => lifeValue(people(s).plans.templateCreate(c.params.pid, c.body)),
    audit: (c, out) => lifeAudit(c as Call<Record<string, string>>, out),
  },
  personTemplateUpdate: {
    handle: (c: Call<{ pid: string; tid: string }, unknown, TemplatePatch>, s) => (lifeValue(people(s).plans.templateUpdate(c.params.pid, c.params.tid, c.body)), OK),
    audit: (c: Call<{ pid: string; tid: string }>) => ({ target: c.params.tid }),
  },
  personTemplateDelete: {
    handle: (c: Call<{ pid: string; tid: string }>, s) => (lifeValue(people(s).plans.templateDelete(c.params.pid, c.params.tid)), OK),
    audit: (c: Call<{ pid: string; tid: string }>) => ({ target: c.params.tid }),
  },
  personOwnerSleep: {
    handle: (c: Call<Pid, { week?: string; from?: string; to?: string }>, s) => read(s, c.params.pid, 'sleep', c.query),
  },
  personOwnerJournal: {
    handle: (c: Call<Pid, { before?: string; day?: string }>, s) => read(s, c.params.pid, 'journal', c.query),
  },
  personOwnerJournalGet: {
    handle: (c: Call<PidId>, s): JournalEntryFull => {
      const v = people(s).views.ownerJournalEntry(c.params.pid, c.params.id);
      if (v === null) throw new ApiError('not_found', NO_PERSON);
      return v;
    },
  },
  personOwnerJournalComment: {
    handle: (c: Call<PidId, unknown, { text: string }>, s) => lifeValue(people(s).journal.comment(c.params.pid, c.params.id, '', c.body.text)),
    audit: (c: Call<PidId>) => ({ target: c.params.id }),
  },
  personOwnerJournalCommentDelete: {
    handle: (c: Call<{ pid: string; id: string; cid: string }>, s) => (lifeValue(people(s).journal.removeComment(c.params.pid, c.params.id, c.params.cid, '')), OK),
    audit: (c: Call<{ pid: string; id: string; cid: string }>) => ({ target: c.params.cid }),
  },
  peopleAlerts: {
    handle: (c: Call<Record<string, string>, { with?: string }>, s) => lifeValue(people(s).alerts.list('', c.query.with ?? null)),
  },
  peopleAlertSend: {
    handle: (c: Call<Record<string, string>, unknown, OwnerAlertSendBody>, s) => {
      const { to, ...body } = c.body;
      return lifeValue(people(s).alerts.send('', to, body));
    },
    audit: (_c, out) => ({ target: (out.body as { id?: string } | null)?.id }),
  },
  peopleAlertSeen: {
    handle: (c: Call<{ id: string }>, s) => (lifeValue(people(s).alerts.seen('', c.params.id)), OK),
    audit: (c: Call<{ id: string }>) => ({ target: c.params.id }),
  },
  peopleAlertReply: {
    handle: (c: Call<{ id: string }, unknown, { kind: never; note?: string }>, s) => (lifeValue(people(s).alerts.reply('', c.params.id, c.body)), OK),
    audit: (c: Call<{ id: string }>) => ({ target: c.params.id }),
  },
  peopleOwnerPrefs: {
    handle: (c: Call<Record<string, string>, unknown, OwnerPeoplePrefsPatch>, s) => lifeValue(people(s).module.setOwnerPrefs(c.body)),
  },
};
