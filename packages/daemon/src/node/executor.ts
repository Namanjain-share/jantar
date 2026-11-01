/**
 * v0.6 Fleet: runs the hub's calls on a node (lane L4). STUB from wave 0:
 * answers every call 501 until L4 replaces this file, keeping the name and
 * signature.
 *
 * Only NODE_ROUTES (anything else: 404); the path from
 * `buildPath(ROUTES[route], params)` plus the query, never a path from the
 * hub; through the node's own API (`link.inject`, the `link` transport), as
 * the device `hub.<deviceId>` with the phone's scopes, so every switch,
 * guard, idempotency check and audit row on the node works as on a Mac. An
 * upload's bulk becomes the raw body. A reply too large for the link
 * (over NODE_LIMITS.bulkToHubBytes) is a 500 "reply too large for the link".
 */
import { errorBody } from '@jantar/protocol';
import type { CallExecutor, DaemonContext, LinkInjector } from '../contracts.js';

export function createExecutor(_ctx: DaemonContext, _link: LinkInjector): CallExecutor {
  return {
    run: async () => ({ status: 501, body: errorBody('not_implemented', 'Calls from the hub are not built yet') }),
  };
}
