/**
 * v0.6 Fleet: the hub's view of each paired node.
 *
 * Per node: its link (when up), its NodeView (online, since, features,
 * accounts, usage), the sessions, cards, sends and launches it owns on the
 * hub (ownership is always read from the hub's own state, never from an
 * event), the serialized size of all of it against NODE_LIMITS.stateBytes,
 * its refusal and event-rate counters, its last close. Kept in memory only:
 * a hub restart starts empty and each node sends a snapshot.
 *
 * A link's snapshot comes first; events that arrive while it is still being
 * assembled (a bulk's chunks may share the link with them) wait for it. More
 * than NODE_LIMITS.eventsPer10s events in 10 s closes the link 1013, more
 * than NODE_LIMITS.refusalsPerMin refused events in a minute (or a refused
 * snapshot) closes it 4400. Close reasons and log lines carry the node id,
 * the event type, a fixed reason and counts: never a payload.
 */
import type { EventInput, NodeRow, NodeView, State } from '@jantar/protocol';
import { NODE_CLOSE, NODE_LIMITS } from '@jantar/protocol/node-link';
import type { DaemonContext, HubLink, HubLinkInfo, Logger, NodeRecord } from '../contracts.js';
import { jsonBytes } from './clip.js';
import { ingestEvent, ingestSnapshot } from './ingest.js';
import { nodeViewOf } from './view.js';

const EVENT_WINDOW_MS = 10_000;
const REFUSAL_WINDOW_MS = 60_000;
/** A log line's event type, at most this long (a node's frame names it). */
const TYPE_LOG_MAX = 64;

interface NodeRuntime {
  link: HubLink | null;
  /** The latest link's `auth` info (kept after it closes: the Machines list shows the backend). */
  info: HubLinkInfo | null;
  snapshot: boolean;
  /** Events that came before the snapshot was whole. */
  early: unknown[];
  /** Arrival times in the last EVENT_WINDOW_MS / REFUSAL_WINDOW_MS. */
  events: number[];
  refusals: number[];
  lastClose: { code: number; at: string } | null;
}

/** What one node holds on the hub now: its sessions, its open cards, and their serialized size with the rest. */
export interface NodeTally {
  sessions: number;
  cards: number;
  bytes: number;
}

/** Count `now` into a sliding window; true when it holds more than `max`. */
function over(window: number[], now: number, windowMs: number, max: number): boolean {
  while (window.length > 0 && (window[0] as number) <= now - windowMs) window.shift();
  window.push(now);
  return window.length > max;
}

export class NodeRegistry {
  private readonly nodes = new Map<string, NodeRuntime>();
  /** Links the registry closed: nothing more is read from them while the close goes through. */
  private readonly closing = new WeakSet<HubLink>();
  /** Serialized sizes by object: the reducer keeps unchanged objects, so each is measured once. */
  private readonly sizes = new WeakMap<object, number>();
  private readonly log: Logger;

  /**
   * `refusalOf`: the last handshake the link server refused for a node since
   * its last good link (auth/nodes.ts lastRefusal), for the Machines list.
   */
  constructor(
    protected readonly ctx: DaemonContext,
    private readonly refusalOf: (nodeId: string) => { code: number; at: string } | null = () => null,
  ) {
    this.log = ctx.log.child({ part: 'fleet' });
  }

  /** A node's view, or null when the hub has none. */
  view(nodeId: string): NodeView | null {
    const nodes = this.ctx.store.getState().nodes;
    return nodes !== undefined && Object.hasOwn(nodes, nodeId) ? (nodes[nodeId] as NodeView) : null;
  }

  /** GET /v1/machines: every pairing with what the registry knows of it. */
  rows(): NodeRow[] {
    return this.ctx.db.nodes.list().map((rec) => this.rowOf(rec));
  }

  /** One pairing with what the registry knows of it. */
  rowOf(rec: NodeRecord): NodeRow {
    const view = this.view(rec.id);
    const rt = this.nodes.get(rec.id);
    const closed = rt?.lastClose ?? null;
    const refused = this.refusalOf(rec.id);
    const row: NodeRow = {
      id: rec.id,
      name: rec.name,
      os: view?.os ?? rec.os,
      backend: view?.backend ?? rt?.info?.backend ?? null,
      version: view?.version ?? rec.version,
      createdAt: rec.createdAt,
      lastSeenAt: rec.lastSeenAt,
      revokedAt: rec.revokedAt,
      online: (rt?.link ?? null) !== null,
      sessions: Object.values(this.state().sessions).filter((s) => s.node === rec.id).length,
      readOnly: view?.readOnly ?? rt?.info?.readOnly ?? false,
      accessRefused: view?.accessRefused ?? rt?.info?.accessRefused ?? 0,
      // A refused handshake (4426: update Jantar there) is newer than the link it could not replace.
      lastClose: refused && (!closed || refused.at >= closed.at) ? refused : closed,
    };
    if (view?.problem) row.problem = view.problem;
    if (refused?.code === NODE_CLOSE.version) row.problem = 'version';
    return row;
  }

  // ---- what ingest reads and writes ------------------------------------------

  state(): Readonly<State> {
    return this.ctx.store.getState();
  }

  now(): string {
    return this.ctx.clock.iso();
  }

  /** The pairing, while it is live. */
  record(nodeId: string): NodeRecord | null {
    const rec = this.ctx.db.nodes.get(nodeId);
    return rec && rec.revokedAt === null ? rec : null;
  }

  info(nodeId: string): HubLinkInfo | null {
    return this.nodes.get(nodeId)?.info ?? null;
  }

  /** The node's link while it is up (the forwarder's way to it). */
  link(nodeId: string): HubLink | null {
    return this.nodes.get(nodeId)?.link ?? null;
  }

  /** Re-emit into the hub's store (its own seq and time). False if the store refused it: a bug, logged. */
  emit(input: EventInput): boolean {
    try {
      this.ctx.store.emit(input);
      return true;
    } catch (e) {
      this.log.error('cannot re-emit a node event', { type: input.type, error: String(e).slice(0, 200) });
      return false;
    }
  }

  sizeOf(v: object): number {
    let n = this.sizes.get(v);
    if (n === undefined) {
      n = jsonBytes(v);
      this.sizes.set(v, n);
    }
    return n;
  }

  /** What `nodeId` holds on the hub now, read from the hub's own state. */
  tally(nodeId: string): NodeTally {
    const st = this.state();
    const sids = new Set<string>();
    let bytes = 0;
    for (const s of Object.values(st.sessions)) {
      if (s.node !== nodeId) continue;
      sids.add(s.sid);
      bytes += this.sizeOf(s);
    }
    let cards = 0;
    for (const p of Object.values(st.pending)) {
      if (!sids.has(p.sid)) continue;
      cards += 1;
      bytes += this.sizeOf(p);
    }
    for (const j of Object.values(st.sends)) if (sids.has(j.sid)) bytes += this.sizeOf(j);
    for (const l of Object.values(st.launches)) if (l.node === nodeId) bytes += this.sizeOf(l);
    for (const a of st.alerts) if (a.node === nodeId) bytes += this.sizeOf(a);
    const view = this.view(nodeId);
    if (view) bytes += this.sizeOf(view);
    return { sessions: sids.size, cards, bytes };
  }

  // ---- links -----------------------------------------------------------------

  /** A link passed the handshake: its snapshot comes next, then its events. The newest link of a node wins. */
  attach(link: HubLink): void {
    const id = link.nodeId;
    const rt: NodeRuntime = this.nodes.get(id) ?? { link: null, info: null, snapshot: false, early: [], events: [], refusals: [], lastClose: null };
    Object.assign(rt, { link, info: link.info, snapshot: false, early: [], events: [], refusals: [] });
    this.nodes.set(id, rt);
    const live = () => rt.link === link && !this.closing.has(link);
    link.onSnapshot((snap) => {
      if (!live()) return;
      const out = ingestSnapshot(this, id, snap);
      if (!out.ok) {
        this.close(link, NODE_CLOSE.protocol, 'snapshot', out.reason);
        return;
      }
      rt.snapshot = true;
      const early = rt.early;
      rt.early = [];
      for (const ev of early) {
        if (!live()) return;
        this.apply(link, rt, ev);
      }
    });
    link.onEvent((ev) => {
      if (!live()) return;
      if (over(rt.events, this.ctx.clock.now(), EVENT_WINDOW_MS, NODE_LIMITS.eventsPer10s)) {
        this.close(link, NODE_CLOSE.slow, typeOf(ev), 'over the event rate');
        return;
      }
      if (rt.snapshot) this.apply(link, rt, ev);
      else if (rt.early.length < NODE_LIMITS.eventsPer10s) rt.early.push(ev);
      else this.close(link, NODE_CLOSE.protocol, typeOf(ev), 'no snapshot');
    });
    link.onClose((code) => {
      if (rt.link !== link) return;
      rt.link = null;
      rt.early = [];
      const at = this.now();
      rt.lastClose = { code, at };
      const rec = this.record(id);
      const prev = this.view(id);
      // Its sessions and cards stay, greyed, until it is back, removed, or the hub restarts.
      if (rec && prev) this.emit({ type: 'node.updated', data: { node: nodeViewOf(rec, rt.info, prev, false, at) } });
    });
  }

  private apply(link: HubLink, rt: NodeRuntime, ev: unknown): void {
    const out = ingestEvent(this, link.nodeId, ev);
    if (out.ok || out.kind === 'dropped') return;
    if (out.kind === 'close' || over(rt.refusals, this.ctx.clock.now(), REFUSAL_WINDOW_MS, NODE_LIMITS.refusalsPerMin)) {
      this.close(link, NODE_CLOSE.protocol, typeOf(ev), out.reason);
    }
  }

  private close(link: HubLink, code: number, type: string, reason: string): void {
    if (this.closing.has(link)) return;
    this.closing.add(link);
    this.log.warn('node link closed', { node: link.nodeId, code, type, reason });
    link.close(code, code === NODE_CLOSE.slow ? 'too many events' : 'protocol error');
  }

  /** Revoked: forget its link (closed by the caller) and take it off the board. */
  remove(nodeId: string): void {
    const rt = this.nodes.get(nodeId);
    if (rt) rt.link = null;
    this.nodes.delete(nodeId);
    const st = this.state();
    const shown =
      this.view(nodeId) !== null ||
      Object.values(st.sessions).some((s) => s.node === nodeId) ||
      Object.values(st.launches).some((l) => l.node === nodeId);
    if (shown) this.emit({ type: 'node.removed', data: { id: nodeId } });
  }

  /** Fleet off: every node off the board (its pairing stays, so `fleet on` needs no re-join). */
  removeAll(): void {
    const st = this.state();
    const ids = new Set<string>([...this.nodes.keys(), ...Object.keys(st.nodes ?? {})]);
    for (const s of Object.values(st.sessions)) if (s.node !== undefined) ids.add(s.node);
    for (const l of Object.values(st.launches)) if (l.node !== undefined) ids.add(l.node);
    for (const id of ids) this.remove(id);
  }

  /** The daemon stops: forget every link without touching the board. */
  detachAll(): void {
    for (const rt of this.nodes.values()) rt.link = null;
  }
}

function typeOf(ev: unknown): string {
  const t = typeof ev === 'object' && ev !== null ? (ev as { type?: unknown }).type : undefined;
  return typeof t === 'string' ? t.slice(0, TYPE_LOG_MAX) : '?';
}
