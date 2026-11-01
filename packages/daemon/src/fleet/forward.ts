/**
 * v0.6 Fleet: the phone's calls for a node (lane L4). STUB from wave 0:
 * targetOf finds nothing and forwardCall answers 501 until L4 replaces this
 * file, keeping each name and signature.
 *
 * targetOf: NODE_ROUTES only; `sid` -> `state.sessions[sid].node`, `card` ->
 * its session's node, `launch` -> `state.launches[id].node`, `query` -> the
 * live node `?node=` names (own keys only; ids checked first). forwardCall:
 * at most NODE_LIMITS.callsInFlight per node (then 429, retry-after 2),
 * NODE_LIMITS.callTimeoutMs (longCallTimeoutMs for LONG_NODE_ROUTES), an
 * upload's bytes as the call's bulk; never queued across a disconnect: a
 * call on a link that drops ends node_offline (api/errors.ts nodeFailureReply).
 */
import { errorBody, type RouteName, type State } from '@jantar/protocol';
import type { NodeCallReply } from '@jantar/protocol/node-link';
import type { FleetTarget, ForwardCall, HubLink } from '../contracts.js';

export function targetOf(
  _state: Readonly<State>,
  _route: RouteName,
  _params: Readonly<Record<string, string>>,
  _query: Readonly<Record<string, unknown>>,
): FleetTarget | null {
  return null;
}

/** One call over the node's link (`link` null: the node is offline). Never rejects. */
export async function forwardCall(_link: HubLink | null, _target: FleetTarget, _call: ForwardCall): Promise<NodeCallReply> {
  return { status: 501, body: errorBody('not_implemented', 'Forwarding to servers is not built yet') };
}
