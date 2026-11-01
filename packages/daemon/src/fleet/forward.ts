/**
 * v0.6 Fleet: the phone's calls for a node.
 *
 * targetOf: NODE_ROUTES only; `sid` -> `state.sessions[sid].node`, `card` ->
 * its session's node, `launch` -> `state.launches[id].node`, `query` -> the
 * node `?node=` names (own keys only; ids checked first). An offline node is
 * still a target: the forward then answers 503 at once.
 *
 * forwardCall: at most NODE_LIMITS.callsInFlight per node (then 429), an
 * upload's bytes as the call's bulk; never queued across a disconnect. The
 * link owns the timeout (callTimeoutMs, longCallTimeoutMs for
 * LONG_NODE_ROUTES) and ends a call on a link that drops node_offline; the
 * hub's own sentences (api/errors.ts nodeFailureReply) always name the
 * machine as the hub named it. A node's `unauthorized` (about the hub's
 * device there, never the phone's pairing) becomes a 500, so the phone never
 * reads it as "this device is not paired". Idempotency is the node's alone:
 * the call carries `idem`, the hub caches nothing. A launch job in the
 * reply carries the node (as state.launches does). typingRefusal: a typing
 * call where the phone shows Jantar can't type gets the phone's sentence
 * from the hub.
 */
import { EVENT, FLEET_COPY, NodeIdSchema, SEND_FINAL_STAGES, errorBody, machineName, typeRefusal, type RouteName, type SendJob, type State } from '@jantar/protocol';
import { NODE_LIMITS, NODE_ROUTES, NODE_SUPPLIED_ID, isNodeRoute, type NodeCallReply } from '@jantar/protocol/node-link';
import type { Clock, FleetTarget, ForwardCall, HubLink, Store } from '../contracts.js';
import { newId } from '../core/ids.js';
import { nodeFailureReply } from '../api/errors.js';

function own<T>(rec: Readonly<Record<string, T>> | undefined, id: string | undefined): T | undefined {
  return rec !== undefined && typeof id === 'string' && NODE_SUPPLIED_ID.test(id) && Object.hasOwn(rec, id) ? rec[id] : undefined;
}

export function targetOf(
  state: Readonly<State>,
  route: RouteName,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, unknown>>,
): FleetTarget | null {
  if (!isNodeRoute(route)) return null;
  let node: string | undefined;
  switch (NODE_ROUTES[route]) {
    case 'sid':
      node = own(state.sessions, params.sid)?.node;
      break;
    case 'card': {
      const card = own(state.pending, params.id);
      node = card ? own(state.sessions, card.sid)?.node : undefined;
      break;
    }
    case 'launch':
      node = own(state.launches, params.id)?.node;
      break;
    case 'query': {
      const q = query.node;
      node = typeof q === 'string' && NodeIdSchema.safeParse(q).success && state.nodes !== undefined && Object.hasOwn(state.nodes, q) ? q : undefined;
      break;
    }
  }
  return node === undefined ? null : { nodeId: node, name: machineName(state, node) };
}

/** The routes that type into a session's terminal: refused on the hub where the phone says Jantar can't type. */
const TYPING_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>(['sendPrompt', 'sessionKey', 'sessionMode', 'sessionCommand', 'sessionDialog', 'sessionKeypad']);

/**
 * A typing call to a node session the phone shows as one Jantar can't type
 * into (typeRefusal: outside tmux, native Windows, a watch-only server),
 * answered on the hub with the phone's own sentence, naming the machine as
 * the hub named it; nothing goes to the node. Offline is forwardCall's (503).
 */
export function typingRefusal(state: Readonly<State>, route: RouteName, params: Readonly<Record<string, string>>): NodeCallReply | null {
  if (!TYPING_ROUTES.has(route)) return null;
  const session = own(state.sessions, params.sid);
  if (!session || session.node === undefined) return null;
  const key = typeRefusal(state, session);
  if (key === null || key === 'offline') return null;
  return { status: 422, body: errorBody('refused', FLEET_COPY[key](machineName(state, session.node))) };
}

/** A launch job in a node's reply, stamped with the node as the hub's state has it (the node never names itself). */
export function stampLaunchReply(reply: NodeCallReply, target: FleetTarget): NodeCallReply {
  const body = reply.body as { job?: unknown } | null;
  if (reply.status >= 400 || typeof body !== 'object' || body === null || typeof body.job !== 'object' || body.job === null) return reply;
  return { ...reply, body: { ...body, job: { ...body.job, node: target.nodeId } } };
}

/** Calls in flight per link (a new link starts at none). */
const inFlight = new WeakMap<HubLink, number>();

/** One call over the node's link (`link` null: the node is offline). Never rejects. */
export async function forwardCall(link: HubLink | null, target: FleetTarget, call: ForwardCall): Promise<NodeCallReply> {
  if (!link) return nodeFailureReply('node_offline', target.name);
  const busy = inFlight.get(link) ?? 0;
  if (busy >= NODE_LIMITS.callsInFlight) {
    return { status: 429, body: errorBody('rate_limited', `${target.name} has too many calls waiting; try again in a few seconds`) };
  }
  inFlight.set(link, busy + 1);
  try {
    const req = {
      id: newId(),
      route: call.route,
      params: call.params,
      query: call.query,
      actor: call.actor,
      ...(call.body !== undefined ? { body: call.body } : {}),
      ...(call.idem !== undefined ? { idem: call.idem } : {}),
    };
    const reply = await link.call(req, call.raw);
    // The link's own failures say so in the hub's words, with the hub's name for the machine.
    const code = (reply.body as { error?: { code?: unknown } } | null)?.error?.code;
    if (reply.status === 503 && code === 'node_offline') return nodeFailureReply('node_offline', target.name);
    if (reply.status === 504 && code === 'node_timeout') return nodeFailureReply('node_timeout', target.name);
    if (reply.status === 401 || code === 'unauthorized') return { status: 500, body: errorBody('internal', `${target.name} refused the call`) };
    return NODE_ROUTES[call.route] === 'launch' || call.route === 'launchStart' ? stampLaunchReply(reply, target) : reply;
  } catch {
    // HubLink.call never rejects; if one ever did, nothing is known to have run.
    return nodeFailureReply('node_offline', target.name);
  } finally {
    const n = (inFlight.get(link) ?? 1) - 1;
    if (n > 0) inFlight.set(link, n);
    else inFlight.delete(link);
  }
}

/**
 * GET /ctl/sends/:jobId/wait for a prompt the CLI sent to a node's session:
 * the hub's writer never had that job, so the wait follows its re-emitted
 * `send.progress` in the hub's store until it reaches a final stage, leaves
 * the hub's state (its node removed), or `timeoutMs` passes (the job as it
 * stood last). Undefined when the hub has no such job.
 */
export function waitForStoreSend(store: Store, clock: Clock, jobId: string, timeoutMs?: number): Promise<SendJob | undefined> {
  const now = own(store.getState().sends, jobId);
  if (!now || SEND_FINAL_STAGES.includes(now.stage)) return Promise.resolve(now);
  return new Promise((resolve) => {
    let job: SendJob = now;
    let timer: ReturnType<Clock['setTimeout']> | undefined;
    const done = () => {
      unsub();
      clock.clearTimeout(timer);
      resolve(job);
    };
    const unsub = store.subscribe((ev) => {
      if (ev.type === EVENT.SEND_PROGRESS && ev.data.job.id === jobId) job = ev.data.job;
      if (SEND_FINAL_STAGES.includes(job.stage) || !own(store.getState().sends, jobId)) done();
    });
    if (timeoutMs !== undefined) timer = clock.setTimeout(done, Math.max(0, timeoutMs));
  });
}
