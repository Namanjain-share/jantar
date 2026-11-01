/**
 * v0.6 Fleet: a node's link to its hub (L4's feed and executor inside).
 *
 * Started last on a node, after `api` (whose link app the executor runs
 * calls through): the dialler (node/dialer.ts) on paths.nodeFile; on each
 * verified link the feed (node/feed.ts) attaches (and detaches when the
 * link closes), and the link's calls go to `executor`. Built only on a
 * node; the hub gets modes.ts offNodeLink().
 *
 * `self` (optional, from daemon.ts): the backend and --read-only the node's
 * `auth` frame reports. Without it the node reports its OS's backend
 * (macOS Terminal.app, Linux tmux, Windows none) and not read-only; a
 * read-only node still refuses every write itself.
 */
import type { NodeBackend } from '@jantar/protocol';
import type { CallExecutor, DaemonContext, Factories, NodeLinkService } from '../contracts.js';
import { thisNodeOs } from '../link/handshake.js';
import { createDialer, defaultSelf } from './dialer.js';
import { createNodeFeed } from './feed.js';

/** What daemon.ts may pass: the executor, and what the node reports of itself. */
export interface NodeLinkDeps {
  executor: CallExecutor;
  self?: { backend: NodeBackend; readOnly: boolean };
}

// Its own type, so a caller may pass `self`; still the factory daemon.ts wires.
export const createNodeLink = ((ctx: DaemonContext, deps: NodeLinkDeps): NodeLinkService => {
  const os = thisNodeOs();
  const self = () => ({ ...defaultSelf(ctx, os), ...deps.self });
  const dialer = createDialer(ctx, ctx.paths.nodeFile, self);
  const feed = createNodeFeed(ctx);
  return {
    start: async () => {
      dialer.start((link) => {
        link.onCall((req, bulk) => deps.executor.run(req, bulk));
        const detach = feed.attach(link);
        link.onClose(() => detach());
      });
    },
    stop: () => dialer.stop(),
    status: () => dialer.status(),
  };
}) satisfies Factories['nodeLink'];
