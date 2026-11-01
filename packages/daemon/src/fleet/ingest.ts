/**
 * v0.6 Fleet: a node's events and snapshots into the hub's state (lane L4).
 * STUB from wave 0: throws NotImplementedError until L4 replaces this file,
 * keeping each name and signature.
 *
 * An event's `type` is looked up in the hub's own EVENT table first: an
 * unknown type is dropped and not counted. Then ids (NODE_SUPPLIED_ID, own
 * keys only), parseEvent, clipping, ownership against the hub's state, the
 * counts (64 sessions, 32 open cards) and the 4 MiB state budget; a refusal
 * is dropped and counted (20 a minute closes 4400, logged without the
 * payload). Accepted events are re-emitted into the hub's own store with
 * `node` stamped (spec 3.5's table). A snapshot is diffed against the hub's
 * last view of the node: a card the hub already has is never re-opened.
 */
import type { NodeSnapshot } from '@jantar/protocol/node-link';
import { NotImplementedError } from '../core/not-implemented.js';
import type { NodeRegistry } from './registry.js';

/** What happened to one event or snapshot. `refused` counts toward the node's refusals; `dropped` (an unknown type) does not. */
export type IngestOutcome = { ok: true } | { ok: false; kind: 'dropped' | 'refused' | 'close'; reason: string };

export function ingestEvent(_reg: NodeRegistry, _nodeId: string, _event: unknown): IngestOutcome {
  throw new NotImplementedError('Fleet (ingest)');
}

export function ingestSnapshot(_reg: NodeRegistry, _nodeId: string, _snap: NodeSnapshot): IngestOutcome {
  throw new NotImplementedError('Fleet (ingest)');
}
