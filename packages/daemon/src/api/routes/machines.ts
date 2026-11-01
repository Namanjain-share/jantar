/**
 * v0.6 Fleet: the routes of paired servers (wave 0; frozen for wave 1). Thin:
 * each one calls the Fleet part (s.fleet, fleet/index.ts), which owns the
 * pairing codes, the keys and the links.
 *
 * - nodePair (scope `node`, NODE_PREFIX): a server claims its join line's
 *   code with its public key. The pipeline has checked Fleet is on (else
 *   404) and that no Origin came (403), and read no cookie, secret or
 *   extension key. Every bad code is the same 401 (no oracle), a link
 *   version that differs is 426. Audited here as `node.pair`, never with
 *   the code or a key; failed claims share the pairing claims' audit budget.
 * - machinesList (admin, ctl): every pairing, revoked ones included.
 * - machinesPair (admin, localOnly, behind the fleet switch): the Mac only
 *   (`jantar node pair`); one join line per server.
 * - machineRevoke (admin): an admin phone may remove a machine too (two
 *   taps): it only narrows access, like revoking a device.
 */
import type { MachinesPairBody, NodePairBody } from '@jantar/protocol';
import type { FleetResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { needActor, type Call, type RouteTable } from '../route-kit.js';

type Id = { id: string };

/** A Fleet answer's value, or the API error of the same code. */
function fleetValue<T extends object>(r: FleetResult<T>): T {
  if (!r.ok) throw new ApiError(r.code, r.reason, r.headers);
  const { ok: _ok, ...value } = r;
  return value as unknown as T;
}

export const MACHINES_ROUTE_IMPLS: RouteTable = {
  nodePair: {
    selfAudit: true,
    handle: async (c: Call<Record<string, string>, unknown, NodePairBody>, s) => {
      const r = await s.fleet.pair(c.body, { rateKey: c.auth.rateKey });
      if (!r.ok) {
        if (r.code !== 'rate_limited' && s.claimFailAudit.hit('claim').ok) {
          s.auditor.write({ actor: 'anonymous', action: 'node.pair', result: 'refused', detail: r.code });
        }
        throw new ApiError(r.code, r.reason, r.headers);
      }
      s.auditor.write({ actor: `node:${r.nodeId}`, action: 'node.pair', target: r.nodeId, params: { name: r.reply.name, os: c.body.os }, result: 'ok' });
      return r.reply;
    },
  },

  machinesList: {
    handle: (_c: Call, s) => ({ machines: s.fleet.list() }),
  },

  machinesPair: {
    handle: async (c: Call<Record<string, string>, unknown, MachinesPairBody>, s) => fleetValue(await s.fleet.makeTokens(c.body, needActor(c.auth))),
    // Names only: a join line holds a one-time code, never audited.
    audit: (c: Call<Record<string, string>, unknown, MachinesPairBody>, out) => ({
      params: { name: c.body.name, count: c.body.count ?? 1, made: (out.body as { tokens?: unknown[] } | null)?.tokens?.length },
    }),
  },

  machineRevoke: {
    handle: async (c: Call<Id>, s) => {
      const r = fleetValue(await s.fleet.revoke(c.params.id, needActor(c.auth)));
      return { machine: r.machine };
    },
    audit: (c: Call<Id>) => ({ target: c.params.id }),
  },
};
