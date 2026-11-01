/**
 * v0.6 Fleet (lane L4) test helpers: a hub test context with paired servers
 * (synthetic build-1, build-2, win-1), the Mac's own session and card in its
 * state, and memory links (fixtures memoryLinkPair) attached to a registry.
 * Nothing here opens a socket.
 */
import { NODE_IDS, memoryLinkPair, type MemoryLinkOptions, type MemoryLinkPair } from '@jantar/fixtures';
import type { DaemonEvent, NodeOs, PendingRequest, Session } from '@jantar/protocol';
import type { HubLink, NodeRecord } from '../../src/contracts.js';
import { createTestContext, type TestContext, type TestContextOptions } from '../../src/core/testing.js';
import { NodeRegistry } from '../../src/fleet/registry.js';
import { makeCard, makeSession } from '../api/fakes.js';

export { NODE_IDS };

export const T0 = '2026-01-15T10:00:00.000Z';

/** The Mac's own session and card, in every hub context here. */
export const MAC_SID = 'sess-aaaa-1111';
export const MAC_CARD = '01JF1EETMACCARD0000000000AAbbCCddEEffGGhh00';

export function nodeRecord(id: string, name: string, os: NodeOs = 'linux'): NodeRecord {
  return { id, name, publicKey: 'A'.repeat(43), os, version: '0.6.0', createdAt: T0, lastSeenAt: null, revokedAt: null };
}

/** A hub: build-1, build-2 and win-1 paired; the Mac's session and its open card in the state. */
export function hubContext(opts: TestContextOptions = {}): TestContext {
  const ctx = createTestContext(opts);
  ctx.db.nodes.insert(nodeRecord(NODE_IDS.build1, 'build-1'));
  ctx.db.nodes.insert(nodeRecord(NODE_IDS.build2, 'build-2'));
  ctx.db.nodes.insert(nodeRecord(NODE_IDS.win1, 'win-1', 'windows'));
  const s: Session = makeSession({ sid: MAC_SID });
  ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
  const card: PendingRequest = makeCard({ id: MAC_CARD, sid: MAC_SID });
  ctx.store.emit({ type: 'pending.opened', sid: MAC_SID, data: { pending: card } });
  return ctx;
}

/** Let the memory link's queued deliveries run. */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A memory link for `nodeId`, attached to the registry (as the link server's onLink would). */
export function linkTo(reg: NodeRegistry, nodeId: string = NODE_IDS.build1, opts: MemoryLinkOptions = {}): MemoryLinkPair {
  const pair = memoryLinkPair({ nodeId, ...opts });
  reg.attach(pair.hub as HubLink);
  return pair;
}

/** Events the hub's store emits from now on. */
export function record(ctx: TestContext): DaemonEvent[] {
  const out: DaemonEvent[] = [];
  ctx.store.subscribe((ev) => out.push(ev));
  return out;
}

/** The warn lines the registry wrote. */
export function warnings(ctx: TestContext) {
  return ctx.log.records.filter((r) => r.level === 'warn');
}
