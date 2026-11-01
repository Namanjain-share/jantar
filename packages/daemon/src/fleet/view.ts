/**
 * v0.6 Fleet: a node's NodeView (lane L4). STUB from wave 0: throws
 * NotImplementedError until L4 replaces this file, keeping the name and
 * signature.
 *
 * From the hub's pairing row (the name, never the node's own), the link's
 * `auth` info (os, backend, readOnly, accessRefused, version: `problem`
 * when its link version differs), and the node's last `daemon.version` and
 * `usage.updated` (features with files, rewrite, screenshots, life, intel,
 * meetings and fleet always off; accounts mode; accounts; usage).
 */
import type { NodeView } from '@jantar/protocol';
import type { HubLinkInfo, NodeRecord } from '../contracts.js';
import { NotImplementedError } from '../core/not-implemented.js';

export function nodeViewOf(_rec: NodeRecord, _info: HubLinkInfo | null, _prev: NodeView | null, _online: boolean, _since: string): NodeView {
  throw new NotImplementedError('Fleet (the node view)');
}
