/**
 * v0.6 Fleet: paired servers' keys on the hub (L4's fleet/index.ts wires
 * these methods into the FleetService).
 *
 * - Join lines: one pairing code each (PairingService kind `node`: 128 bits,
 *   10 minutes, single use, only its sha256 kept, in memory; at most
 *   MAX_OPEN_JOIN_LINES waiting, so a line once printed is never dropped for
 *   a newer one), with the name the Mac gave it reserved beside the code's
 *   hash. Names
 *   `^[a-z0-9][a-z0-9-]{0,23}$`, unique among live nodes and open join
 *   lines, never `mac`; default `node-<n>` (the lowest free n); `--count K`
 *   gives `<name>-1..K` (K <= 20; without a name, the K lowest free
 *   `node-<n>`).
 * - A claim spends the code, inserts `{id: ulid, name, publicKey, os,
 *   version}` into `nodes` (the route audits it), and the hub signs
 *   pairSigText(nodeId, publicKey) with its key. Every bad code is the same
 *   401 sentence (no oracle); a link version that differs is 426 and spends
 *   nothing; claims are rate limited per caller (`rateKey`, a budget that
 *   grows with open join lines and pairings: NODE_CLAIMS_PER_MIN).
 * - The hub keeps public keys only. A node unseen for 90 days
 *   (EXTENSION_IDLE_MS) is revoked when it next connects; `lastSeenAt` is
 *   written at most every 5 minutes (the link touches it on every
 *   heartbeat, so a node linked for months never looks idle).
 * - The hub's key (link/keys.ts loadOrCreateHubKey) is read here for each
 *   signature, so a key replaced on purpose (docs/fleet.md) is used from the
 *   next `fleet on` without a restart; one load runs at a time, so two
 *   first uses never make two keys.
 */
import {
  EXTENSION_IDLE_MS,
  NodeNameSchema,
  type MachinesPairBody,
  type MachinesPairReply,
  type NodeOs,
  type NodePairBody,
  type NodePairReply,
} from '@jantar/protocol';
import { NODE_LIMITS, NODE_PROTO, encodeJoinToken, hubOrigin } from '@jantar/protocol/node-link';
import type { DaemonContext, FleetResult, Logger, NodeRecord } from '../contracts.js';
import { newId } from '../core/ids.js';
import { loadOrCreateHubKey, signPair, type LinkKeyPair } from '../link/keys.js';
import { TOUCH_EVERY_MS } from './devices.js';
import { PairingService } from './pairing.js';
import { SlidingWindowLimiter, type RateLimitOptions } from './rate-limit.js';

/** The one sentence every refused claim gets (no oracle: used, expired, mistyped or another kind's). */
export const JOIN_LINE_INVALID = 'this join line is not valid (used, expired or mistyped): make a new one at the Mac';

/** Join lines per `jantar node pair --count`. */
export const MAX_JOIN_LINES = 20;

/** Join lines waiting at once (two full `--count 20`); past it a new one is refused, never an older one dropped. */
export const MAX_OPEN_JOIN_LINES = 2 * MAX_JOIN_LINES;

/**
 * Pairing claims per caller per minute: this, plus 2 for each open join line
 * and each live pairing (a claim turns one into the other, so the budget
 * holds through a burst). Ten or twenty servers behind one NAT running
 * `node join` at once all fit.
 */
export const NODE_CLAIMS_PER_MIN = NODE_LIMITS.handshakesPerMin;

/** Why a handshake's node id is refused (the link closes 4401). */
export type NodeVerdict = { ok: true; node: NodeRecord } | { ok: false; why: 'unknown' | 'revoked' | 'idle' };

export class NodeAuth {
  private readonly pairing: PairingService;
  private readonly claims: SlidingWindowLimiter;
  private readonly claimLimits: RateLimitOptions;
  private readonly log: Logger;
  private keyLoad: Promise<LinkKeyPair> | null = null;
  private readonly refusals = new Map<string, { code: number; at: string }>();

  constructor(private readonly ctx: Pick<DaemonContext, 'db' | 'clock' | 'log' | 'paths'>) {
    this.log = ctx.log.child({ part: 'fleet' });
    this.pairing = new PairingService({ clock: ctx.clock, log: this.log, maxOpen: MAX_OPEN_JOIN_LINES });
    this.claimLimits = { limit: NODE_CLAIMS_PER_MIN, windowMs: 60_000, clock: ctx.clock };
    this.claims = new SlidingWindowLimiter(this.claimLimits);
  }

  /** The hub's key pair (made on first use; one load at a time). */
  hubKey(): Promise<LinkKeyPair> {
    this.keyLoad ??= loadOrCreateHubKey(this.ctx.paths).finally(() => {
      this.keyLoad = null;
    });
    return this.keyLoad;
  }

  /** POST /v1/node/pair: spend the code, keep the key, sign the reply with the hub's key. */
  async pair(body: NodePairBody, meta: { rateKey: string }): Promise<FleetResult<{ reply: NodePairReply; nodeId: string }>> {
    this.claimLimits.limit = NODE_CLAIMS_PER_MIN + NODE_LIMITS.handshakesPerNode * (this.pairing.openCount() + this.pairedCount());
    const limited = this.claims.hit(meta.rateKey);
    if (!limited.ok) {
      return {
        ok: false,
        code: 'rate_limited',
        reason: 'Too many pairing attempts: wait a minute and try again.',
        headers: { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) },
      };
    }
    if (body.proto !== NODE_PROTO) {
      return { ok: false, code: 'node_version', reason: 'This server runs another link version than the Mac: update Jantar on both, then join with this line.' };
    }
    const claim = this.pairing.claimNode(body.code);
    if (!claim.ok || this.ctx.db.nodes.byName(claim.name)) return { ok: false, code: 'unauthorized', reason: JOIN_LINE_INVALID };
    const key = await this.hubKey();
    const rec: NodeRecord = {
      id: newId(),
      name: claim.name,
      publicKey: body.publicKey,
      os: body.os,
      version: body.version,
      createdAt: this.ctx.clock.iso(),
      lastSeenAt: null,
      revokedAt: null,
    };
    try {
      this.ctx.db.nodes.insert(rec);
    } catch {
      return { ok: false, code: 'unauthorized', reason: JOIN_LINE_INVALID };
    }
    this.log.info('server paired', { nodeId: rec.id, name: rec.name, os: rec.os });
    return { ok: true, reply: { nodeId: rec.id, name: rec.name, sig: signPair(key.privateKey, rec.id, rec.publicKey) }, nodeId: rec.id };
  }

  /** POST /v1/machines/pair: one join line per name (`hubUrl`: remote.publicUrl; `createdBy`: the audit actor). */
  async makeTokens(body: MachinesPairBody, opts: { hubUrl: string; createdBy: string }): Promise<FleetResult<{ tokens: MachinesPairReply['tokens'] }>> {
    const url = hubOrigin(opts.hubUrl);
    if (!url) return { ok: false, code: 'conflict', reason: 'Servers need a fixed front door. Set one up with jantar remote setup.' };
    const names = this.namesFor(body);
    if (!names.ok) return names;
    if (this.pairing.openCount() + names.names.length > MAX_OPEN_JOIN_LINES) {
      return { ok: false, code: 'conflict', reason: 'Too many join lines are waiting: use them, or make more once they run out (10 minutes).' };
    }
    const key = await this.hubKey();
    const tokens: MachinesPairReply['tokens'] = names.names.map((name) => {
      const start = this.pairing.start({ kind: 'node', name, createdBy: opts.createdBy });
      return { name, token: encodeJoinToken({ url, code: start.code, hubKey: key.publicKey }), expiresAt: start.expiresAt };
    });
    this.log.info('join lines made', { count: tokens.length, by: opts.createdBy });
    return { ok: true, tokens };
  }

  /** The node record a handshake names, if any (no side effects: the signature is checked before verify). */
  lookup(nodeId: string): NodeRecord | null {
    return this.ctx.db.nodes.get(nodeId);
  }

  /** A handshake's node: live, or why not (an idle one is revoked here). */
  verify(nodeId: string): NodeVerdict {
    const node = this.ctx.db.nodes.get(nodeId);
    if (!node) return { ok: false, why: 'unknown' };
    if (node.revokedAt) return { ok: false, why: 'revoked' };
    const now = this.ctx.clock.now();
    const seen = Date.parse(node.lastSeenAt ?? node.createdAt);
    if (Number.isFinite(seen) && now - seen > EXTENSION_IDLE_MS) {
      this.ctx.db.nodes.revoke(node.id, this.ctx.clock.iso(now));
      this.log.info('server removed', { nodeId: node.id, why: 'idle expiry' });
      return { ok: false, why: 'idle' };
    }
    return { ok: true, node };
  }

  /** The node linked: lastSeenAt (at most every 5 minutes), and the OS and version it reported. */
  touch(nodeId: string, info: { os: NodeOs; version: string }): void {
    const node = this.ctx.db.nodes.get(nodeId);
    if (!node || node.revokedAt) return;
    if (node.os !== info.os || node.version !== info.version) this.ctx.db.nodes.setInfo(nodeId, info);
    const now = this.ctx.clock.now();
    const seen = node.lastSeenAt ? Date.parse(node.lastSeenAt) : Number.NaN;
    if (!Number.isFinite(seen) || now - seen >= TOUCH_EVERY_MS) this.ctx.db.nodes.touch(nodeId, this.ctx.clock.iso(now));
  }

  /** Revoke (the row stays, for the audit log); null for an unknown id. `by`: the audit actor. */
  revoke(id: string, by: string): NodeRecord | null {
    const node = this.ctx.db.nodes.get(id);
    if (!node) return null;
    if (node.revokedAt) return node;
    const done = this.ctx.db.nodes.revoke(id, this.ctx.clock.iso());
    this.log.info('server removed', { nodeId: id, by });
    return done;
  }

  /** Every pairing, revoked ones included, oldest first. */
  list(): NodeRecord[] {
    return this.ctx.db.nodes.list();
  }

  /** Live pairings (the link server's budgets grow with them). */
  pairedCount(): number {
    return this.ctx.db.nodes.list().filter((n) => !n.revokedAt).length;
  }

  /** The link server notes a handshake it refused for a live node (4426: link versions differ), for the Machines line. */
  noteRefusal(nodeId: string, code: number): void {
    if (!this.ctx.db.nodes.get(nodeId)) return;
    this.refusals.delete(nodeId);
    this.refusals.set(nodeId, { code, at: this.ctx.clock.iso() });
    for (const old of this.refusals.keys()) {
      if (this.refusals.size <= MAX_REFUSALS_KEPT) break;
      this.refusals.delete(old);
    }
  }

  /** The last handshake refused for this node since the hub started (cleared by a good link), if any. */
  lastRefusal(nodeId: string): { code: number; at: string } | null {
    return this.refusals.get(nodeId) ?? null;
  }

  /** A good link: its earlier refusals no longer matter. */
  clearRefusal(nodeId: string): void {
    this.refusals.delete(nodeId);
  }

  /** The names for one `jantar node pair` (each free among live nodes and open join lines), or why not. */
  private namesFor(body: MachinesPairBody): FleetResult<{ names: string[] }> {
    const count = body.count ?? 1;
    const taken = new Set([...this.ctx.db.nodes.list().flatMap((n) => (n.revokedAt ? [] : [n.name])), ...this.pairing.reservedNames()]);
    let names: string[];
    if (body.name !== undefined) {
      names = count === 1 ? [body.name] : Array.from({ length: count }, (_v, i) => `${body.name}-${i + 1}`);
    } else {
      names = [];
      for (let n = 1; names.length < count; n += 1) if (!taken.has(`node-${n}`)) names.push(`node-${n}`);
    }
    const tooLong = names.find((n) => !NodeNameSchema.safeParse(n).success);
    if (tooLong !== undefined) {
      return { ok: false, code: 'invalid_request', reason: `${tooLong} is not a machine name: lower-case letters, digits and dashes, at most 24 characters.` };
    }
    const clash = names.find((n) => taken.has(n));
    if (clash !== undefined) {
      return { ok: false, code: 'conflict', reason: `${clash} is already paired or has a join line waiting: pick another name, or jantar node revoke ${clash} first.` };
    }
    return { ok: true, names };
  }
}

/** Refused handshakes remembered for the Machines line. */
const MAX_REFUSALS_KEPT = 256;
