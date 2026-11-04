/**
 * 0.14.0 Switching rules: the owner's two routes on the legacy ccw tool's
 * switch.json (the Accounts screen's Switching rules sheet).
 *
 * - getSwitchRules (GET /v1/accounts/switching): the rules as the file
 *   holds them now: hold, the 5-hour and weekly ceilings, lead_min and each
 *   account's weekly ramp.
 * - patchSwitchRules (PATCH): saves the keys the body names, through
 *   sources/ccw-legacy/write.ts (only those five keys change, the old file
 *   is kept as switch.json.prev, and the new one is renamed into place); the
 *   reply is the rules as saved. Its audit row names the keys it changed,
 *   no values.
 *
 * Both are control routes of his (a phone paired with control may change
 * them); her host never serves them (api/people-fence.ts). Without ccw
 * (or on a paired server, whose ccw reader is inert) they answer 404
 * ccw_absent; a file that won't parse, or is missing, 409 with the
 * sentence the sheet shows; a read-only daemon refuses the save
 * (READ_ONLY_REFUSED answers first; the check here is the guard itself).
 */
import type { SwitchRules, SwitchRulesPatch } from '@jantar/protocol';
import { READ_ONLY_REASON } from '../../modes.js';
import { SWITCH_COPY, readSwitchRules, writeSwitchRules } from '../../sources/ccw-legacy/write.js';
import { ApiError } from '../errors.js';
import type { Call, RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';

function ccwHere(s: ApiServices): void {
  if (!s.deps.ccwLegacy.present()) throw new ApiError('ccw_absent', SWITCH_COPY.absent);
}

export const SWITCHING_ROUTE_IMPLS: RouteTable = {
  getSwitchRules: {
    handle: async (_c, s): Promise<SwitchRules> => {
      ccwHere(s);
      const r = await readSwitchRules(s.ctx.paths);
      if (!r.ok) throw new ApiError(r.code, r.message);
      return r.rules;
    },
  },

  patchSwitchRules: {
    handle: async (c: Call<Record<string, string>, unknown, SwitchRulesPatch>, s): Promise<SwitchRules> => {
      if (s.mode.readOnly) throw new ApiError('forbidden', READ_ONLY_REASON);
      ccwHere(s);
      const r = await writeSwitchRules(s.ctx.paths, c.body);
      if (!r.ok) {
        if (r.code === 'unavailable') s.log.warn('could not save switch.json', {});
        throw new ApiError(r.code, r.message);
      }
      return r.rules;
    },
    audit: (c: Call<Record<string, string>, unknown, SwitchRulesPatch>) => ({
      params: { keys: Object.keys(c.body ?? {}).filter((k) => (c.body as Record<string, unknown>)[k] !== undefined).sort() },
    }),
  },
};
