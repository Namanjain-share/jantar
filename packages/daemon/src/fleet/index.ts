/**
 * v0.6 Fleet: the hub's Fleet part. L1's link server (fleet/socket.ts) and
 * NodeAuth (auth/nodes.ts) inside; the registry (fleet/registry.ts) keeps
 * each node's view and re-emits its checked, clipped events; the forwarder
 * (fleet/forward.ts) carries the phone's calls.
 *
 * Built on every hub and inert while settings fleet.enabled is off: no
 * listener, no timer, no file. It follows the switch itself: on, the hub key
 * (NodeAuth.hubKey, link/keys.ts) and the link server (fleet/socket.ts);
 * off, every link closes 4403 and each node's view and sessions leave the
 * board (node.removed; the pairings stay, so turning it on again needs no
 * re-join). Started after `notifications`, before `api`.
 */
import { NodeIdSchema, type MachinesPairReply, type RouteName } from '@jantar/protocol';
import { NODE_CLOSE, NODE_ROUTES, hubOrigin, isNodeRoute } from '@jantar/protocol/node-link';
import type { Actor, Factories, FleetResult, FleetService, FleetTarget, LinkServer, Unsubscribe } from '../contracts.js';
import { NodeAuth } from '../auth/nodes.js';
import { actorId } from '../core/actor.js';
import { refuseUpgrade } from '../api/node-upgrade.js';
import { createLinkServer } from './socket.js';
import { forwardCall, targetOf, typingRefusal } from './forward.js';
import { NodeRegistry } from './registry.js';

/** `jantar fleet on` says the same: a server dials a fixed https address, never a quick tunnel's. */
const NO_DOOR = 'Servers need a fixed front door. Set one up with jantar remote setup.';
const QUICK_TUNNEL = /\.trycloudflare\.com$/i;

export const createFleet: Factories['fleet'] = (ctx): FleetService => {
  const log = ctx.log.child({ part: 'fleet' });
  const auth = new NodeAuth(ctx);
  const registry = new NodeRegistry(ctx, (id) => auth.lastRefusal(id));
  let server: LinkServer | null = null;
  let unsubSettings: Unsubscribe | null = null;
  // Switch changes apply one at a time, in order.
  let switching: Promise<void> = Promise.resolve();

  const enabled = () => ctx.settings.get().fleet.enabled;

  const turnOn = async (): Promise<void> => {
    if (server) return;
    try {
      // Made now, so the first join line and the first link find it (NodeAuth loads it once at a time).
      await auth.hubKey();
    } catch (e) {
      log.error('cannot load the hub key', { error: String(e).slice(0, 200) });
    }
    // The link server touches the pairing (lastSeenAt, os, version) itself.
    server = createLinkServer(ctx, auth, { onLink: (link) => registry.attach(link) });
    log.info('fleet on');
  };

  const turnOff = async (code: number, reason: string, board: boolean): Promise<void> => {
    const s = server;
    server = null;
    if (board) registry.removeAll();
    else registry.detachAll();
    if (!s) return;
    s.closeAll(code, reason);
    await s.stop();
    log.info('fleet off', { closeCode: code });
  };

  const follow = (on: boolean) => {
    switching = switching
      .then(() => (on ? turnOn() : turnOff(NODE_CLOSE.fleetOff, 'Fleet is off', true)))
      .catch((e: unknown) => log.error('fleet switch failed', { error: String(e).slice(0, 200) }));
    return switching;
  };

  const target = (route: RouteName, params: Readonly<Record<string, string>>, query: Readonly<Record<string, unknown>>): FleetTarget | null => {
    const t = targetOf(ctx.store.getState(), route, params, query);
    if (t || !enabled() || !isNodeRoute(route) || NODE_ROUTES[route] !== 'query') return t;
    // A paired server that has not linked since the Mac started: still a machine, offline (503, not 404).
    const id = query.node;
    if (typeof id !== 'string' || !NodeIdSchema.safeParse(id).success) return null;
    const rec = ctx.db.nodes.get(id);
    return rec && rec.revokedAt === null ? { nodeId: rec.id, name: rec.name } : null;
  };

  return {
    async start() {
      if (unsubSettings) return;
      unsubSettings = ctx.settings.subscribe((next, prev) => {
        if (next.fleet.enabled !== prev.fleet.enabled) void follow(next.fleet.enabled);
      });
      if (enabled()) await follow(true);
    },
    async stop() {
      unsubSettings?.();
      unsubSettings = null;
      await switching;
      await turnOff(NODE_CLOSE.goingAway, 'Jantar is stopping', false);
    },
    target,
    forward: async (t, call) => {
      const link = enabled() ? registry.link(t.nodeId) : null;
      // Online, but the phone shows it can't type there: the same sentence, and nothing reaches the node.
      const refused = link ? typingRefusal(ctx.store.getState(), call.route, call.params) : null;
      return refused ?? forwardCall(link, t, call);
    },
    acceptLink(req, socket, head) {
      if (server) server.accept(req, socket, head);
      else refuseUpgrade(socket, 503, 'unavailable', 'The Fleet link is starting; try again in a moment');
    },
    pair: (body, meta) => auth.pair(body, meta),
    async makeTokens(body, actor: Actor): Promise<FleetResult<{ tokens: MachinesPairReply['tokens'] }>> {
      const url = ctx.settings.get().remote.publicUrl;
      const origin = url === null ? null : hubOrigin(url);
      if (!origin || QUICK_TUNNEL.test(new URL(origin).hostname)) return { ok: false, code: 'conflict', reason: NO_DOOR };
      // JANTAR_TEST_LOOPBACK_DOOR=1: the tests' hub on loopback http (never set by Jantar itself).
      return auth.makeTokens(body, { hubUrl: origin, createdBy: actorId(actor), loopbackHttp: ctx.env.JANTAR_TEST_LOOPBACK_DOOR === '1' });
    },
    list: () => registry.rows(),
    async revoke(id, actor) {
      const rec = auth.revoke(id, actorId(actor));
      if (!rec) return { ok: false, code: 'not_found', reason: 'no such machine' };
      // Off the board first, so the closing link does not grey it out on the way.
      registry.remove(id);
      server?.closeNode(id, NODE_CLOSE.unknown, 'removed');
      return { ok: true, machine: registry.rowOf(ctx.db.nodes.get(id) ?? rec) };
    },
  };
};
