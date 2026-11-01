/**
 * v0.6 Fleet: paired servers' keys on the hub (lane L1). STUB from wave 0:
 * every method refuses until L1 replaces this file, keeping the class name
 * and every method's signature (L4's fleet/index.ts wires them into the
 * FleetService).
 *
 * - Join lines: one pairing code each (PairingService kind `node`: 128 bits,
 *   10 minutes, single use, only its sha256 kept, in memory), with the name
 *   the Mac gave it reserved beside the code's hash. Names
 *   `^[a-z0-9][a-z0-9-]{0,23}$`, unique among live nodes, never `mac`;
 *   default `node-<n>`; `--count K` gives `<name>-1..K` (K <= 20).
 * - A claim spends the code, inserts `{id: ulid, name, publicKey, os,
 *   version}` into `nodes`, audits it, and the hub signs pairSigText(nodeId,
 *   publicKey) with its key. Every bad code is the same 401 sentence (no
 *   oracle); claims are rate limited per caller (`rateKey`).
 * - The hub keeps public keys only. A node unseen for 90 days
 *   (EXTENSION_IDLE_MS) is revoked when it next connects; `lastSeenAt` is
 *   written at most every 5 minutes.
 */
import type { MachinesPairBody, MachinesPairReply, NodeOs, NodePairBody, NodePairReply } from '@jantar/protocol';
import type { DaemonContext, FleetResult, NodeRecord } from '../contracts.js';

const NOT_BUILT = 'Pairing servers is not built yet';

/** Why a handshake's node id is refused (the link closes 4401). */
export type NodeVerdict = { ok: true; node: NodeRecord } | { ok: false; why: 'unknown' | 'revoked' | 'idle' };

export class NodeAuth {
  constructor(private readonly ctx: Pick<DaemonContext, 'db' | 'clock' | 'log' | 'paths'>) {}

  /** POST /v1/node/pair: spend the code, keep the key, sign the reply with the hub's key. */
  async pair(_body: NodePairBody, _meta: { rateKey: string }): Promise<FleetResult<{ reply: NodePairReply; nodeId: string }>> {
    return { ok: false, code: 'not_implemented', reason: NOT_BUILT };
  }

  /** POST /v1/machines/pair: one join line per name (`hubUrl`: remote.publicUrl; `createdBy`: the audit actor). */
  async makeTokens(_body: MachinesPairBody, _opts: { hubUrl: string; createdBy: string }): Promise<FleetResult<{ tokens: MachinesPairReply['tokens'] }>> {
    return { ok: false, code: 'not_implemented', reason: NOT_BUILT };
  }

  /** A handshake's node: live, or why not (an idle one is revoked here). */
  verify(_nodeId: string): NodeVerdict {
    return { ok: false, why: 'unknown' };
  }

  /** The node linked: lastSeenAt (at most every 5 minutes), and the OS and version it reported. */
  touch(_nodeId: string, _info: { os: NodeOs; version: string }): void {}

  /** Revoke (the row stays, for the audit log); null for an unknown id. `by`: the audit actor. */
  revoke(_id: string, _by: string): NodeRecord | null {
    return null;
  }

  /** Every pairing, revoked ones included, oldest first. */
  list(): NodeRecord[] {
    return [];
  }

  /** Live pairings (the link server's budgets grow with them). */
  pairedCount(): number {
    return 0;
  }
}
