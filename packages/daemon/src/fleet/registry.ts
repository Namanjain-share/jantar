/**
 * v0.6 Fleet: the hub's view of each paired node (lane L4). STUB from wave
 * 0: L4 replaces this file, keeping the class name and constructor.
 *
 * Per node: its link (when up), its NodeView (online, since, features,
 * accounts, usage), the sessions, cards, sends and launches it owns on the
 * hub (ownership is always read from the hub's own state, never from an
 * event), the serialized size of all of it against NODE_LIMITS.stateBytes,
 * its refusal and event-rate counters, its last close. Kept in memory only:
 * a hub restart starts empty and each node sends a snapshot.
 */
import type { NodeRow, NodeView } from '@jantar/protocol';
import type { DaemonContext } from '../contracts.js';
import { NotImplementedError } from '../core/not-implemented.js';

export class NodeRegistry {
  constructor(protected readonly ctx: DaemonContext) {}

  /** A node's view, or null when the hub has none. */
  view(_nodeId: string): NodeView | null {
    throw new NotImplementedError('Fleet (the node registry)');
  }

  /** GET /v1/machines: every pairing with what the registry knows of it. */
  rows(): NodeRow[] {
    throw new NotImplementedError('Fleet (the node registry)');
  }
}
