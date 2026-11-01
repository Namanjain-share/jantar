/**
 * v0.6 Fleet: what a node sends the hub.
 *
 * On each verified link: one snapshot (its own sessions, live cards,
 * unfinished sends and launches plus the newest 20 each, the newest 20
 * alerts, its switches and accounts mode, its accounts and usage), built
 * from the store and subscribed in the same tick so nothing falls between,
 * clipped with fleet/clip.ts; then its events, clipped, under
 * NODE_LIMITS.eventsPer10s and EVENT_BYTES_PER_10S: when the budget runs short it holds
 * `session.updated` and merges them per session (later values win, `unset`
 * lists joined); a status change and every other event go at once (a held
 * patch of the same session goes with it, or just before it, so nothing
 * arrives out of order). Held patches go out as the budget frees up; they
 * are never dropped while the link is up. Only the events the hub takes
 * (fleet/clip.ts NODE_EVENT_TYPES) are sent.
 *
 * The hub refuses (and counts) anything about a session or card it was
 * never told of, and closes the link after 20 refusals a minute. So the
 * feed keeps a ledger of what it told this link: at most
 * NODE_LIMITS.sessions sessions (the most recently changed first) and
 * NODE_LIMITS.openCards live cards, and it says nothing about the rest. A
 * session left out is told (as `session.added`, as it stands) on its next
 * event once a place is free; a live card left out is told (as
 * `pending.opened`, oldest first) once a place is free, so the phone can
 * still answer it.
 */
import {
  LAUNCH_FINAL_STAGES,
  NO_FEATURES,
  SEND_FINAL_STAGES,
  localSession,
  localSessions,
  type DaemonEvent,
  type EventOf,
  type PendingRequest,
  type SessionOptionalKey,
  type State,
} from '@jantar/protocol';
import { NODE_LIMITS, type NodeSnapshot } from '@jantar/protocol/node-link';
import type { DaemonContext, NodeFeed, NodeLink, TimerId, Unsubscribe } from '../contracts.js';
import {
  ACCOUNTS_MAX,
  EVENT_BYTES_PER_10S,
  NODE_EVENT_TYPES,
  SNAPSHOT_RECENT,
  clipAccount,
  clipAlert,
  clipCard,
  clipEvent,
  clipLaunch,
  clipSend,
  clipSession,
  jsonBytes,
} from '../fleet/clip.js';

/**
 * The node counts its events over 12 s against the hub's 300 in 10 s: a
 * burst sent as the window frees may arrive with an earlier one squeezed
 * up to it, and 2 s covers the link's jitter.
 */
const WINDOW_MS = 12_000;
/** Room kept in every window for what goes at once: held patches only use the rest. */
const URGENT_ROOM = 60;
const URGENT_BYTES = EVENT_BYTES_PER_10S / 4;
/** How often held patches are offered to the budget. */
const FLUSH_MS = 1_000;

type Updated = EventOf<'session.updated'>;

/** A card the hub keeps: open, or decided and waiting for its tool to run. */
const live = (p: PendingRequest): boolean => p.state === 'open' || p.state === 'decided';
const oldestFirst = (a: PendingRequest, b: PendingRequest): number => a.createdAt.localeCompare(b.createdAt);

/** The newest `n` of a record by `updatedAt`, plus every one `keep` says. */
function recent<J extends { id: string; updatedAt: string }>(rec: Readonly<Record<string, J>>, keep: (j: J) => boolean, n: number): J[] {
  const all = Object.values(rec).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return all.filter((j, i) => i < n || keep(j));
}

/** The node's snapshot of itself, clipped as the hub will clip it, within the hub's session and card caps. */
export function nodeSnapshot(ctx: Pick<DaemonContext, 'accountsMode'>, state: Readonly<State>): NodeSnapshot {
  const shown = Object.values(localSessions(state))
    .sort((a, b) => b.statusSince.localeCompare(a.statusSince))
    .slice(0, NODE_LIMITS.sessions);
  const sids = new Set(shown.map((s) => s.sid));
  const pending = Object.values(state.pending)
    .filter((p) => live(p) && sids.has(p.sid))
    .sort(oldestFirst)
    .slice(0, NODE_LIMITS.openCards);
  return {
    sessions: Object.fromEntries(shown.map((s) => [s.sid, clipSession(s)])),
    pending: Object.fromEntries(pending.map((p) => [p.id, clipCard(p)])),
    sends: Object.fromEntries(
      recent(state.sends, (j) => !SEND_FINAL_STAGES.includes(j.stage), SNAPSHOT_RECENT)
        .filter((j) => sids.has(j.sid))
        .map((j) => [j.id, clipSend(j)]),
    ),
    launches: Object.fromEntries(recent(state.launches, (j) => !LAUNCH_FINAL_STAGES.includes(j.stage), SNAPSHOT_RECENT).map((j) => [j.id, clipLaunch(j)])),
    alerts: state.alerts
      .filter((a) => a.sid === undefined || sids.has(a.sid))
      .slice(0, SNAPSHOT_RECENT)
      .map(clipAlert),
    daemon: { features: state.daemon?.features ?? { ...NO_FEATURES }, accountsMode: state.daemon?.accountsMode ?? ctx.accountsMode() },
    accounts: Object.fromEntries(
      Object.entries(state.accounts)
        .slice(0, ACCOUNTS_MAX)
        .map(([k, a]) => [k, clipAccount(a)]),
    ),
    activeAccount: state.activeAccount,
    usage: state.usage,
  };
}

/** `later` applied on top of `earlier`: later values win, and a key set again is no longer unset. */
export function mergeUpdated(earlier: Updated, later: Updated): Updated {
  const patch: Record<string, unknown> = { ...earlier.data.patch };
  const unset = new Set<SessionOptionalKey>(earlier.data.unset ?? []);
  for (const [k, v] of Object.entries(later.data.patch)) {
    patch[k] = v;
    unset.delete(k as SessionOptionalKey);
  }
  for (const k of later.data.unset ?? []) {
    delete patch[k];
    unset.add(k);
  }
  return { ...later, data: { patch, ...(unset.size ? { unset: [...unset] } : {}) } } as Updated;
}

/** One link's sender: what it told the hub, the budget window and the held patches, per session. */
class Sender {
  /** What went out in the last WINDOW_MS, oldest first, and its bytes in all. */
  private readonly sent: { at: number; bytes: number }[] = [];
  private sentBytes = 0;
  private readonly held = new Map<string, Updated>();
  /** Sessions the hub was told of, and live cards (card id -> sid). */
  private readonly sessions: Set<string>;
  private readonly cards: Map<string, string>;
  /** A live card may not be told yet (the snapshot's cap, or a card that found no place). */
  private behind = true;
  private timer: TimerId | undefined;
  private closed = false;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly link: NodeLink,
    snap: NodeSnapshot,
  ) {
    this.sessions = new Set(Object.keys(snap.sessions));
    this.cards = new Map(Object.values(snap.pending).map((p) => [p.id, p.sid]));
  }

  /** Whether held patches may go: the window has room left beyond what is kept for urgent events, in count and bytes. */
  private room(): boolean {
    const cutoff = this.ctx.clock.now() - WINDOW_MS;
    while (this.sent.length > 0 && (this.sent[0] as { at: number }).at <= cutoff) this.sentBytes -= (this.sent.shift() as { bytes: number }).bytes;
    return this.sent.length < NODE_LIMITS.eventsPer10s - URGENT_ROOM && this.sentBytes < EVENT_BYTES_PER_10S - URGENT_BYTES;
  }

  private send(ev: DaemonEvent): void {
    const bytes = jsonBytes(ev);
    this.sent.push({ at: this.ctx.clock.now(), bytes });
    this.sentBytes += bytes;
    this.link.sendEvent(ev);
  }

  /**
   * Whether the hub knows `sid` (told now as it stands, after `ev`, when a
   * place is free). 'told': the `session.added` just sent already holds
   * whatever a `session.updated` would say.
   */
  private reveal(sid: string | undefined, ev: DaemonEvent): boolean | 'told' {
    if (sid === undefined) return false;
    if (this.sessions.has(sid)) return true;
    const s = localSession(this.ctx.store.getState(), sid);
    if (!s || this.sessions.size >= NODE_LIMITS.sessions) return false;
    this.sessions.add(sid);
    this.send(clipEvent({ seq: ev.seq, ts: ev.ts, type: 'session.added', sid, data: { session: s } }));
    return 'told';
  }

  /** Keep the ledger; false: the hub was never told of what `ev` is about, so it is not sent. */
  private admit(ev: DaemonEvent): boolean | 'told' {
    switch (ev.type) {
      case 'session.added': {
        const sid = ev.data.session.sid;
        if (this.sessions.has(sid) || this.sessions.size >= NODE_LIMITS.sessions) return false;
        this.sessions.add(sid);
        return true;
      }
      case 'session.removed': {
        if (ev.sid === undefined || !this.sessions.delete(ev.sid)) return false;
        for (const [id, sid] of this.cards) if (sid === ev.sid) this.cards.delete(id);
        return true;
      }
      case 'pending.opened': {
        const p = ev.data.pending;
        if (this.cards.has(p.id)) return false;
        if (this.cards.size >= NODE_LIMITS.openCards || !this.reveal(p.sid, ev)) {
          this.behind = true;
          return false;
        }
        this.cards.set(p.id, p.sid);
        return true;
      }
      case 'pending.resolved':
        if (!this.cards.has(ev.data.id)) return false;
        if (ev.data.state !== 'decided') this.cards.delete(ev.data.id);
        return true;
      case 'alert.blocked':
      case 'alert.rejected':
      case 'alert.limit':
      case 'alert.error':
        return ev.data.alert.sid === undefined || this.reveal(ev.data.alert.sid, ev) !== false;
      case 'send.progress':
        return this.reveal(ev.data.job.sid, ev) !== false;
      case 'session.updated':
        return this.reveal(ev.sid, ev);
      case 'session.done':
      case 'session.waiting':
        return this.reveal(ev.sid, ev) !== false;
      default:
        // launch.progress, daemon.version, usage.updated: about the node itself.
        return true;
    }
  }

  event(raw: DaemonEvent): void {
    if (this.closed || !NODE_EVENT_TYPES.has(raw.type)) return;
    // A node has no other machine's sessions; never forward one if it ever did.
    if (raw.type === 'session.added' && raw.data.session.node !== undefined) return;
    if (this.admit(raw) === true) this.pass(raw);
    if (this.behind) this.catchUp(raw);
  }

  /**
   * Live cards the hub was not told of, oldest first, while places are free
   * (after `ev`, which may have freed one): each with its session, told first
   * when the hub does not know it yet.
   */
  private catchUp(ev: DaemonEvent): void {
    this.behind = false;
    const cards = Object.values(this.ctx.store.getState().pending)
      .filter((p) => live(p) && !this.cards.has(p.id))
      .sort(oldestFirst);
    for (const p of cards) {
      if (this.cards.size >= NODE_LIMITS.openCards) {
        this.behind = true;
        return;
      }
      if (!this.reveal(p.sid, ev)) {
        this.behind = true;
        continue;
      }
      this.cards.set(p.id, p.sid);
      this.send(clipEvent({ seq: ev.seq, ts: ev.ts, type: 'pending.opened', sid: p.sid, data: { pending: p } }));
    }
  }

  /** An event the hub knows the subject of: at once, or held and merged while the budget is short. */
  private pass(raw: DaemonEvent): void {
    const ev = clipEvent(raw);
    const sid = ev.sid;
    const held = sid !== undefined ? this.held.get(sid) : undefined;
    if (ev.type === 'session.updated' && ev.data.patch.status === undefined && (held !== undefined || !this.room())) {
      this.held.set(ev.sid as string, held ? mergeUpdated(held, ev) : ev);
      this.schedule();
      return;
    }
    if (held !== undefined && sid !== undefined) {
      this.held.delete(sid);
      if (ev.type === 'session.updated') {
        this.send(mergeUpdated(held, ev));
        return;
      }
      // A removed session's patch is moot; anything else about it goes after the patch.
      if (ev.type !== 'session.removed') this.send(held);
    }
    this.send(ev);
  }

  private schedule(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = this.ctx.clock.setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_MS);
  }

  /** Held patches, oldest first, as far as the budget allows; the rest wait for the next round. */
  flush(): void {
    for (const [sid, ev] of this.held) {
      if (this.closed || !this.room()) break;
      this.held.delete(sid);
      this.send(ev);
    }
    if (this.held.size > 0) this.schedule();
  }

  close(): void {
    this.closed = true;
    this.ctx.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.held.clear();
  }
}

export function createNodeFeed(ctx: DaemonContext): NodeFeed {
  const log = ctx.log.child({ part: 'node-feed' });
  return {
    attach(link: NodeLink): Unsubscribe {
      // Read and subscribe in one tick: no event falls between the snapshot and the stream.
      const state = ctx.store.getState();
      const from = state.seq;
      const snap = nodeSnapshot(ctx, state);
      const sender = new Sender(ctx, link, snap);
      const unsub = ctx.store.subscribe((ev) => {
        if (ev.seq > from) sender.event(ev);
      });
      let attached = true;
      const detach = () => {
        if (!attached) return;
        attached = false;
        unsub();
        sender.close();
      };
      link.onClose(detach);
      try {
        link.sendSnapshot(snap);
      } catch (e) {
        log.error('cannot send the snapshot', { error: e instanceof Error ? e.name : 'unknown' });
        detach();
      }
      return detach;
    },
  };
}
