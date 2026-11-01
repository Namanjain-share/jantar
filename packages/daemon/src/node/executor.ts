/**
 * v0.6 Fleet: runs the hub's calls on a node.
 *
 * Only NODE_ROUTES (anything else: 404, nothing run); the path from
 * `buildPath(ROUTES[route], params)` plus the query, never a path from the
 * hub, and only with exactly the route's own path params, each an id
 * (NODE_SUPPLIED_ID: no `/`, no `..`; else 400); through the node's own API
 * (`link.inject`, the `link` transport), as the device `hub.<deviceId>` with
 * the phone's scopes, so every switch, guard, idempotency check and audit
 * row on the node works as on a Mac. An upload's bulk becomes the raw body
 * (L1's link checked its size and sha256 before it got here). A reply too
 * large for the link (over NODE_LIMITS.bulkToHubBytes) is a 500 "reply too
 * large for the link". A call that has not answered when the hub gives up
 * on it (callTimeoutMs, longCallTimeoutMs for LONG_NODE_ROUTES) is a 504
 * here too, so it never holds one of the link's calls in flight. Nothing
 * of a call (body, query, reply) is logged.
 */
import { ROUTES, buildPath, errorBody, type RouteDef } from '@jantar/protocol';
import { LONG_NODE_ROUTES, NODE_LIMITS, NODE_SUPPLIED_ID, isNodeRoute, type NodeCallReply, type NodeCallRequest } from '@jantar/protocol/node-link';
import type { CallExecutor, DaemonContext, LinkInjector, LinkRequest, LinkResponse } from '../contracts.js';
import { jsonBytes } from '../fleet/clip.js';

const PATH_PARAM = /:([A-Za-z0-9_]+)/g;

/** The route's path with exactly its own params, each an id; null when they are not that. */
function pathOf(def: RouteDef, params: Readonly<Record<string, string>>): string | null {
  const names = [...def.path.matchAll(PATH_PARAM)].map((m) => m[1] as string);
  const given = Object.keys(params);
  if (given.length !== names.length || !names.every((n) => Object.hasOwn(params, n) && NODE_SUPPLIED_ID.test(params[n] as string))) return null;
  return buildPath(def, params);
}

function fail(status: number, code: Parameters<typeof errorBody>[0], message: string): NodeCallReply {
  return { status, body: errorBody(code, message) };
}

/** `reply`, or null once `ms` passed (the call itself runs on). */
function within(ctx: DaemonContext, reply: Promise<LinkResponse>, ms: number): Promise<LinkResponse | null> {
  return new Promise((resolve, reject) => {
    const timer = ctx.clock.setTimeout(() => resolve(null), ms);
    reply.then(
      (r) => {
        ctx.clock.clearTimeout(timer);
        resolve(r);
      },
      (e: unknown) => {
        ctx.clock.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function createExecutor(ctx: DaemonContext, link: LinkInjector): CallExecutor {
  const log = ctx.log.child({ part: 'node-calls' });
  return {
    async run(req: NodeCallRequest, bulk?: Buffer): Promise<NodeCallReply> {
      if (!isNodeRoute(req.route)) return fail(404, 'not_found', 'not found');
      // NODE_ROUTES are REST routes (never the event stream): the type says so.
      const def = ROUTES[req.route];
      const path = pathOf(def, req.params);
      if (path === null) return fail(400, 'invalid_request', 'invalid path params');
      const raw = (def as RouteDef).rawBody !== undefined;
      if (bulk !== undefined && !raw) return fail(400, 'invalid_request', 'this call takes no bytes');
      const query = new URLSearchParams(Object.entries(req.query)).toString();
      const call: LinkRequest = { method: def.method, url: query ? `${path}?${query}` : path, actor: req.actor };
      if (req.idem !== undefined) call.idem = req.idem;
      if (raw) call.raw = bulk ?? Buffer.alloc(0);
      else if (req.body !== undefined) call.body = req.body;
      const ms = LONG_NODE_ROUTES.has(req.route) ? NODE_LIMITS.longCallTimeoutMs : NODE_LIMITS.callTimeoutMs;
      let reply: NodeCallReply | null;
      try {
        reply = await within(ctx, link.inject(call), ms);
      } catch (e) {
        // The error's kind only: its message could quote what the call carried.
        log.error('a call from the hub failed', { route: req.route, error: e instanceof Error ? e.name : 'unknown' });
        return fail(500, 'internal', 'internal error');
      }
      if (reply === null) {
        log.warn('a call from the hub timed out', { route: req.route });
        return fail(504, 'node_timeout', 'timed out');
      }
      if (jsonBytes(reply.body) > NODE_LIMITS.bulkToHubBytes) {
        log.warn('a reply too large for the link', { route: req.route });
        return fail(500, 'internal', 'reply too large for the link');
      }
      return reply;
    },
  };
}
