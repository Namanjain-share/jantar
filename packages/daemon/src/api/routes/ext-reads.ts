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
 * extension's id (`c.auth.extension`).
 *
 * Wave 0: both are stubs that answer 501 until lane A replaces this table.
 */
import { notImplementedRoute, type RouteTable } from '../route-kit.js';

export const EXT_READS_ROUTE_IMPLS: RouteTable = {
  extReadNext: notImplementedRoute('Reading links'),
  extReadResult: notImplementedRoute('Reading links'),
};
