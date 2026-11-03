/**
 * v0.11 People (P2): her journal (scope `person`), thin handlers over
 * life/journal with her as the caller. Only she writes, edits and deletes
 * her entries; she deletes only her own comments (his: 404).
 */
import type { JournalCreateBody, JournalPatchBody } from '@jantar/protocol/people';
import { ApiError } from '../../errors.js';
import { lifeValue, type Call, type RouteTable } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { her } from './account.js';

type Id = { id: string };
const OK = { ok: true as const };

function journal(s: ApiServices) {
  const m = s.deps.life.people.journal;
  if (!m) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return m;
}

export const PERSON_JOURNAL_ROUTE_IMPLS: RouteTable = {
  personJournal: {
    handle: (c: Call<Record<string, string>, { before?: string; day?: string }>, s) => lifeValue(journal(s).list(her(c.auth).personId, c.query)),
  },
  personJournalGet: {
    handle: (c: Call<Id>, s) => lifeValue(journal(s).get(her(c.auth).personId, c.params.id)),
  },
  personJournalCreate: {
    handle: (c: Call<Record<string, string>, unknown, JournalCreateBody>, s) => lifeValue(journal(s).create(her(c.auth).personId, c.body)),
  },
  personJournalUpdate: {
    handle: (c: Call<Id, unknown, JournalPatchBody>, s) => (lifeValue(journal(s).update(her(c.auth).personId, c.params.id, c.body)), OK),
  },
  personJournalDelete: {
    handle: (c: Call<Id>, s) => (lifeValue(journal(s).remove(her(c.auth).personId, c.params.id)), OK),
  },
  personJournalComment: {
    handle: (c: Call<Id, unknown, { text: string }>, s) => {
      const pid = her(c.auth).personId;
      return lifeValue(journal(s).comment(pid, c.params.id, pid, c.body.text));
    },
  },
  personJournalCommentDelete: {
    handle: (c: Call<{ id: string; cid: string }>, s) => {
      const pid = her(c.auth).personId;
      return (lifeValue(journal(s).removeComment(pid, c.params.id, c.params.cid, pid)), OK);
    },
  },
};
