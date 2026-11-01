/**
 * v0.6 Fleet: what a node sends the hub (lane L4). STUB from wave 0: sends
 * nothing until L4 replaces this file, keeping the name and signature.
 *
 * On each verified link: one snapshot (its own sessions, open cards,
 * unfinished sends and launches plus the newest 20 each, the newest 20
 * alerts, its switches and accounts mode, its accounts and usage), built
 * from the store and subscribed in the same tick so nothing falls between,
 * clipped with fleet/clip.ts; then its events, clipped, under
 * NODE_LIMITS.eventsPer10s: when the budget runs short it holds
 * `session.updated` and merges them per session (later values win, `unset`
 * lists joined); a status change and every other event go at once.
 */
import type { DaemonContext, NodeFeed } from '../contracts.js';

export function createNodeFeed(_ctx: DaemonContext): NodeFeed {
  return { attach: () => () => {} };
}
