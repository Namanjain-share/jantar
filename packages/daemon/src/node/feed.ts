/**
 * v0.6 Fleet: what a node sends the hub.
 *
 * On each verified link: one snapshot (its own sessions, open cards,
 * unfinished sends and launches plus the newest 20 each, the newest 20
 * alerts, its switches and accounts mode, its accounts and usage), built
 * from the store and subscribed in the same tick so nothing falls between,
 * clipped with fleet/clip.ts; then its events, clipped, under
 * NODE_LIMITS.eventsPer10s: when the budget runs short it holds
 * `session.updated` and merges them per session (later values win, `unset`
 * lists joined); a status change and every other event go at once (a held
 * patch of the same session goes with it, or just before it, so nothing
 * arrives out of order). Held patches go out as the budget frees up; they
 * are never dropped while the link is up. Only the events the hub takes
 * (fleet/clip.ts NODE_EVENT_TYPES) are sent.
 */
import {
  LAUNCH_FINAL_STAGES,
  NO_FEATURES,
  SEND_FINAL_STAGES,
  localSessions,
  type DaemonEvent,
  type EventOf,
  type SessionOptionalKey,
  type State,
} from '@jantar/protocol';
import { NODE_LIMITS, type NodeSnapshot } from '@jantar/protocol/node-link';
import type { DaemonContext, NodeFeed, NodeLink, TimerId, Unsubscribe } from '../contracts.js';
import { NODE_EVENT_TYPES, SNAPSHOT_RECENT, clipAccount, clipAlert, clipCard, clipEvent, clipLaunch, clipSend, clipSession } from '../fleet/clip.js';

const WINDOW_MS = 10_000;
/** Room kept in every 10 s for what goes at once: held patches only use the rest. */
const URGENT_ROOM = 60;
/** How often held patches are offered to the budget. */
const FLUSH_MS = 1_000;

type Updated = EventOf<'session.updated'>;

/** The newest `n` of a record by `updatedAt`, plus every one `keep` says. */
function recent<J extends { id: string; updatedAt: string }>(rec: Readonly<Record<string, J>>, keep: (j: J) => boolean, n: number): J[] {
  const all = Object.values(rec).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return all.filter((j, i) => i < n || keep(j));
}

/** The node's snapshot of itself, clipped as the hub will clip it. */
export function nodeSnapshot(ctx: Pick<DaemonContext, 'accountsMode'>, state: Readonly<State>): NodeSnapshot {
  const sessions = localSessions(state);
  const pending = Object.values(state.pending).filter((p) => p.state === 'open' && Object.hasOwn(sessions, p.sid));
  return {
    sessions: Object.fromEntries(Object.values(sessions).map((s) => [s.sid, clipSession(s)])),
    pending: Object.fromEntries(pending.map((p) => [p.id, clipCard(p)])),
    sends: Object.fromEntries(
      recent(state.sends, (j) => !SEND_FINAL_STAGES.includes(j.stage), SNAPSHOT_RECENT)
        .filter((j) => Object.hasOwn(sessions, j.sid))
        .map((j) => [j.id, clipSend(j)]),
    ),
    launches: Object.fromEntries(recent(state.launches, (j) => !LAUNCH_FINAL_STAGES.includes(j.stage), SNAPSHOT_RECENT).map((j) => [j.id, clipLaunch(j)])),
    alerts: state.alerts.slice(0, SNAPSHOT_RECENT).map(clipAlert),
    daemon: { features: state.daemon?.features ?? { ...NO_FEATURES }, accountsMode: state.daemon?.accountsMode ?? ctx.accountsMode() },
    accounts: Object.fromEntries(Object.entries(state.accounts).map(([k, a]) => [k, clipAccount(a)])),
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

/** One link's sender: the budget window and the held patches, per session. */
class Sender {
  private readonly sent: number[] = [];
  private readonly held = new Map<string, Updated>();
  private timer: TimerId | undefined;
  private closed = false;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly link: NodeLink,
  ) {}

  /** What the window holds now. */
  private used(): number {
    const cutoff = this.ctx.clock.now() - WINDOW_MS;
    while (this.sent.length > 0 && (this.sent[0] as number) <= cutoff) this.sent.shift();
    return this.sent.length;
  }

  private room(): number {
    return NODE_LIMITS.eventsPer10s - URGENT_ROOM - this.used();
  }

  private send(ev: DaemonEvent): void {
    this.sent.push(this.ctx.clock.now());
    this.link.sendEvent(ev);
  }

  event(raw: DaemonEvent): void {
    if (this.closed || !NODE_EVENT_TYPES.has(raw.type)) return;
    // A node has no other machine's sessions; never forward one if it ever did.
    if (raw.type === 'session.added' && raw.data.session.node !== undefined) return;
    const ev = clipEvent(raw);
    const sid = ev.sid;
    const held = sid !== undefined ? this.held.get(sid) : undefined;
    if (ev.type === 'session.updated' && ev.data.patch.status === undefined && (held !== undefined || this.room() <= 0)) {
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
      if (this.closed || this.room() <= 0) break;
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
      const sender = new Sender(ctx, link);
      // Read and subscribe in one tick: no event falls between the snapshot and the stream.
      const state = ctx.store.getState();
      const from = state.seq;
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
        link.sendSnapshot(nodeSnapshot(ctx, state));
      } catch (e) {
        log.error('cannot send the snapshot', { error: String(e).slice(0, 200) });
        detach();
      }
      return detach;
    },
  };
}
