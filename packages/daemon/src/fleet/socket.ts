/**
 * v0.6 Fleet: the hub's link server (lane L1). STUB from wave 0: refuses
 * every upgrade with 503 until L1 replaces this file, keeping the name and
 * signature.
 *
 * Its own `ws` server (link/ws-client.ts loadWs) at NODE_LIMITS.frameBytes
 * (the phone's /v1/events stays at 4096); the handshake limiter keyed by
 * `rateKey` (10 + 2 x paired nodes a minute) and the cap on unauthenticated
 * sockets (8 + paired nodes); the handshake (link/handshake.ts) within
 * NODE_LIMITS.handshakeMs; pings every 20 s and app heartbeats; exactly one
 * snapshot per link (a second closes 4400); the newest link with a key
 * replaces the older (4409, logged). Frames are logged by kind, size, node
 * id and close code only.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DaemonContext, LinkServer, LinkServerHooks } from '../contracts.js';
import { refuseUpgrade } from '../api/node-upgrade.js';
import type { NodeAuth } from '../auth/nodes.js';

export function createLinkServer(_ctx: DaemonContext, _auth: NodeAuth, _hooks: LinkServerHooks): LinkServer {
  return {
    accept(_req: IncomingMessage, socket: Duplex, _head: Buffer) {
      refuseUpgrade(socket, 503, 'unavailable', 'The Fleet link is not built yet');
    },
    closeNode() {},
    closeAll() {},
    linked: () => [],
    stop: async () => {},
  };
}
