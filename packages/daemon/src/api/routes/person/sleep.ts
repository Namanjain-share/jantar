/**
 * v0.12 People (P2): her sleep log (scope `person`), thin handlers over
 * life/sleep with her as the caller. Only she writes a night.
 */
import type { SleepPutBody, SleepWakeBody } from '@jantar/protocol/people';
import { ApiError } from '../../errors.js';
import { lifeValue, type Call, type RouteTable } from '../../route-kit.js';
import type { ApiServices } from '../../services.js';
import { her } from './account.js';

const OK = { ok: true as const };

function sleep(s: ApiServices) {
  const m = s.deps.life.people.sleep;
  if (!m) throw new ApiError('unavailable', 'Life is not open right now. Try again in a moment.');
  return m;
}

export const PERSON_SLEEP_ROUTE_IMPLS: RouteTable = {
  personSleep: {
    handle: (c: Call<Record<string, string>, { week?: string; from?: string; to?: string }>, s) => lifeValue(sleep(s).week(her(c.auth).personId, c.query)),
  },
  personSleepStart: {
    handle: (c: Call<Record<string, string>, unknown, { at?: string; clientId: string }>, s) => lifeValue(sleep(s).start(her(c.auth).personId, c.body.at, c.body.clientId)),
  },
  personSleepWake: {
    handle: (c: Call<Record<string, string>, unknown, SleepWakeBody>, s) => (lifeValue(sleep(s).wake(her(c.auth).personId, c.body)), OK),
  },
  personSleepPut: {
    handle: (c: Call<{ night: string }, unknown, SleepPutBody>, s) => (lifeValue(sleep(s).put(her(c.auth).personId, c.params.night, c.body)), OK),
  },
  personSleepDelete: {
    handle: (c: Call<{ night: string }>, s) => (lifeValue(sleep(s).remove(her(c.auth).personId, c.params.night)), OK),
  },
};
