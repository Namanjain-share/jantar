/**
 * v0.8: the extension's reads (feature `intelRead`), while Read saved links
 * is on in its popup. `extReadNext` hands the paired extension the next post
 * to open in the user's Chrome, as a URL the daemon rebuilt from the
 * platform and the post's parts (never the user's link as typed), leased to
 * that extension; `extReadResult` takes what it read (a PageRead, checked
 * and cut again by the daemon) or why it could not.
 *
 * The pipeline has already run the extension's gate (loopback, no device
 * cookie, its key, its bound Origin, its request limit), the switch and the
 * strict bodies. Each calls `s.deps.intel.extNext` / `extResult` with the
 * extension's id (`c.auth.extension`). A result for a lease the extension
 * did not take (or one already ended) is 404. Nothing is audited: a read
 * job's own audit row counts it.
 */
import type { ExtReadResultBody } from '@jantar/protocol';
import { ApiError } from '../errors.js';
import { lifeValue, type Call, type RouteTable } from '../route-kit.js';

/** The extension's key reached the handler without its id: never expected (the gate sets it). */
function extensionOf(c: Pick<Call, 'auth'>): string {
  const id = c.auth.extension?.id;
  if (!id) throw new ApiError('unauthorized', 'pair the extension first');
  return id;
}

export const EXT_READS_ROUTE_IMPLS: RouteTable = {
  extReadNext: {
    handle: (c: Call, s) => ({ job: s.deps.intel.extNext(extensionOf(c)) }),
  },
  extReadResult: {
    handle: (c: Call<{ id: string }, unknown, ExtReadResultBody>, s) => {
      lifeValue(s.deps.intel.extResult(c.params.id, extensionOf(c), c.body));
      return { ok: true as const };
    },
  },
};
