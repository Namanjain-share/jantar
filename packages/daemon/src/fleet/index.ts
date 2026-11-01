/**
 * v0.6 Fleet: the hub's Fleet part (lane L4 wires it; L1's link server and
 * NodeAuth inside). STUB from wave 0: inert; `target` finds no node, so every
 * route runs on the Mac as in v0.5.2, and the rest refuses (501) until L4
 * replaces this file, keeping `createFleet: Factories['fleet']`.
 *
 * Built on every hub and inert while settings fleet.enabled is off: no
 * listener, no timer, no file. It follows the switch itself: on, the hub key
 * (link/keys.ts loadOrCreateHubKey) and the link server (fleet/socket.ts);
 * off, every link closes 4403 and each node's view and sessions leave the
 * board (node.removed). Started after `notifications`, before `api`.
 */
import type { Factories, FleetService } from '../contracts.js';
import { NodeAuth } from '../auth/nodes.js';
import { createLinkServer } from './socket.js';
import { forwardCall } from './forward.js';

const NOT_BUILT = 'Fleet is not built yet';

export const createFleet: Factories['fleet'] = (ctx): FleetService => {
  const auth = new NodeAuth(ctx);
  const server = createLinkServer(ctx, auth, { onLink: (link) => link.close(4403, 'not built yet') });
  return {
    start: async () => {},
    stop: () => server.stop(),
    target: () => null,
    forward: (target, call) => forwardCall(null, target, call),
    acceptLink: (req, socket, head) => server.accept(req, socket, head),
    pair: async () => ({ ok: false, code: 'not_implemented', reason: NOT_BUILT }),
    makeTokens: async () => ({ ok: false, code: 'not_implemented', reason: NOT_BUILT }),
    list: () => [],
    revoke: async () => ({ ok: false, code: 'not_implemented', reason: NOT_BUILT }),
  };
};
