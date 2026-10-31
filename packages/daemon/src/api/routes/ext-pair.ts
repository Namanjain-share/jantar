/**
 * Pairing the Chrome extension (v0.5, WP0; frozen for wave 1):
 *
 * - extPairStart (`localOnly`: ctl.sock only, `jantar pair --extension`): a
 *   one-time extension code from the one pairing service (10 minutes,
 *   single use, only its hash kept) and the TCP port the extension must
 *   call, so the CLI can print `jantar-ext:<port>:<code>`.
 * - extPairClaim (public): the pipeline has already required a loopback
 *   peer and Host with no forwarding header and the Origin
 *   `chrome-extension://<EXTENSION_ID>` (api/app.ts gate). Rate limited per
 *   caller like the device claim. The key comes back once and is stored only
 *   as its hash, bound to that Origin. Audited here as `ext.pair`, never
 *   with the code or the key.
 * - extUnpair (`localOnly`, `jantar meetings unpair`): revokes every key;
 *   the extension's next call is 401.
 */
import type { ExtPairClaimBody } from '@jantar/protocol';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import type { Call, RouteTable } from '../route-kit.js';

export const EXT_PAIR_ROUTE_IMPLS: RouteTable = {
  extPairStart: {
    handle: (c: Call, s) => {
      const r = s.pairing.start({ kind: 'extension', createdBy: actorName(c.auth) });
      c.scratch.pairId = r.pairId;
      return { code: r.code, port: s.boundPort > 0 ? s.boundPort : null, expiresAt: r.expiresAt };
    },
    audit: (c: Call, out) => ({
      target: typeof c.scratch.pairId === 'string' ? c.scratch.pairId : undefined,
      params: { kind: 'extension', ok: out.status < 400 },
    }),
  },

  extPairClaim: {
    selfAudit: true,
    handle: (c: Call<Record<string, string>, unknown, ExtPairClaimBody>, s) => {
      const limited = s.claimLimiter.hit(c.auth.rateKey);
      if (!limited.ok) {
        throw new ApiError('rate_limited', 'too many pairing attempts; wait a minute and try again', {
          'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)),
        });
      }
      // The gate let only the published extension's Origin through.
      const origin = String(c.req.headers.origin);
      const r = s.pairing.claimExtension(c.body.code, origin);
      if (!r.ok) {
        if (s.claimFailAudit.hit('claim').ok) s.auditor.write({ actor: 'anonymous', action: 'ext.pair', result: 'refused', detail: r.code });
        throw new ApiError('forbidden', r.message);
      }
      s.auditor.write({ actor: `extension:${r.id}`, action: 'ext.pair', target: r.id, params: { pairId: r.pairId }, result: 'ok' });
      // The key is shown once, here, and never stored: the extension keeps it in its own IndexedDB.
      return { id: r.id, key: r.key };
    },
  },

  extUnpair: {
    handle: (_c: Call, s) => ({ ok: true as const, revoked: s.extensions.revokeAll() }),
    audit: (_c: Call, out) => ({ params: { revoked: (out.body as { revoked?: number } | null)?.revoked } }),
  },
};
