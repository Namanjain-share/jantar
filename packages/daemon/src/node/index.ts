/**
 * v0.6 Fleet: a node's link to its hub (lane L1 wires it; L4's feed and
 * executor inside). STUB from wave 0: never dials (status `off`) until L1
 * replaces this file, keeping `createNodeLink: Factories['nodeLink']`.
 *
 * Started last on a node, after `api` (whose link app the executor runs
 * calls through): the dialler (node/dialer.ts) on paths.nodeFile; on each
 * verified link the feed (node/feed.ts) attaches, and the link's calls go to
 * `executor`. Built only on a node; the hub gets modes.ts offNodeLink().
 */
import type { Factories, NodeLinkService } from '../contracts.js';
import { createDialer } from './dialer.js';

export const createNodeLink: Factories['nodeLink'] = (ctx): NodeLinkService => {
  const dialer = createDialer(ctx, ctx.paths.nodeFile);
  return {
    start: async () => {},
    stop: () => dialer.stop(),
    status: () => dialer.status(),
  };
};
