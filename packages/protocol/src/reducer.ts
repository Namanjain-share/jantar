/**
 * The shared reducer: `reduce(state, event) -> state`.
 *
 * Pure and immutable: it never modifies its inputs. Applying an event always
 * returns a new object, because `seq` advances even for moment events.
 *
 * Events whose `seq` is not greater than `state.seq` are ignored, which makes
 * replays after a reconnect safe. A client that sees `ev.seq > state.seq + 1`
 * has missed events and should resync (`hasGap`).
 */
import { ALERTS_CAP, LAUNCH_CAP, NODE_ALERTS_CAP, NODE_SENDS_CAP, REWRITE_CAP, SENDS_CAP } from './constants.js';
import { MOVE_FINAL_EVENT_TYPES, isAlertEvent, isMoveEvent, type DaemonEvent } from './events.js';
import {
  LAUNCH_FINAL_STAGES,
  REWRITE_FINAL_STATES,
  SEND_FINAL_STAGES,
  type Account,
  type Alert,
  type LaunchJob,
  type PendingRequest,
  type RewriteJob,
  type SendJob,
  type Session,
} from './models.js';
import type { State } from './state.js';

export function reduce(state: State, ev: DaemonEvent): State {
  if (ev.seq <= state.seq) return state;
  return { ...apply(state, ev), seq: ev.seq };
}

export function reduceAll(state: State, events: Iterable<DaemonEvent>): State {
  let s = state;
  for (const ev of events) s = reduce(s, ev);
  return s;
}

/** True when `ev` is not the next event after `state` (events were missed). */
export function hasGap(state: State, ev: DaemonEvent): boolean {
  return ev.seq > state.seq + 1;
}

function apply(s: State, ev: DaemonEvent): State {
  if (isAlertEvent(ev)) {
    const alert = ev.data.alert;
    const rest = s.alerts.filter((a) => a.id !== alert.id);
    return { ...s, alerts: capAlerts([alert, ...rest]) };
  }
  if (isMoveEvent(ev) || ev.type === 'move.cleared') {
    return applyMove(s, ev);
  }

  switch (ev.type) {
    case 'session.added': {
      const session = ev.data.session;
      return { ...s, sessions: { ...s.sessions, [session.sid]: session } };
    }
    case 'session.updated': {
      const sid = ev.sid;
      const prev = sid ? s.sessions[sid] : undefined;
      if (!sid || !prev) return s;
      const next: Session = { ...prev, ...ev.data.patch, sid };
      for (const key of ev.data.unset ?? []) delete (next as Partial<Session>)[key];
      return { ...s, sessions: { ...s.sessions, [sid]: next } };
    }
    case 'session.removed': {
      const sid = ev.sid;
      if (!sid || !(sid in s.sessions)) return s;
      const sessions = { ...s.sessions };
      delete sessions[sid];
      const pending = omitWhere(s.pending, (p) => p.sid === sid);
      const out: State = { ...s, sessions, pending };
      // v0.6: a server's sends go with its session, so every send left is known to be the Mac's or a live server session's.
      if (s.sessions[sid]?.node !== undefined) out.sends = omitWhere(s.sends, (j) => j.sid === sid);
      if (s.fileTicks && Object.hasOwn(s.fileTicks, sid)) {
        const fileTicks = { ...s.fileTicks };
        delete fileTicks[sid];
        out.fileTicks = fileTicks;
      }
      return out;
    }
    case 'pending.opened': {
      const p = ev.data.pending;
      return { ...s, pending: { ...s.pending, [p.id]: p } };
    }
    case 'pending.resolved': {
      const { id, state, decidedBy, decision } = ev.data;
      const prev = s.pending[id];
      if (!prev) return s;
      if (state === 'decided') {
        const next: PendingRequest = { ...prev, state };
        if (decidedBy !== undefined) next.decidedBy = decidedBy;
        if (decision !== undefined) next.decision = decision;
        return { ...s, pending: { ...s.pending, [id]: next } };
      }
      const pending = { ...s.pending };
      delete pending[id];
      return { ...s, pending };
    }
    case 'usage.updated': {
      const accounts: Record<string, Account> = {};
      for (const a of ev.data.accounts) accounts[String(a.id)] = a;
      return {
        ...s,
        accounts,
        activeAccount: ev.data.activeAccount,
        usage: { fetchedAt: ev.data.fetchedAt, source: ev.data.source },
      };
    }
    case 'send.progress': {
      const job = ev.data.job;
      return { ...s, sends: pruneSends({ ...s.sends, [job.id]: job }, s.sessions) };
    }
    case 'rewrite.progress': {
      const job = ev.data.job;
      return { ...s, rewrites: pruneRewrites({ ...s.rewrites, [job.id]: job }) };
    }
    case 'launch.progress': {
      const job = ev.data.job;
      return { ...s, launches: pruneLaunches({ ...s.launches, [job.id]: job }) };
    }
    case 'daemon.version':
      return { ...s, daemon: { ...ev.data } };
    case 'files.changed': {
      // Only the count: the event's path and tool stay out of the state.
      const sid = ev.sid;
      if (!sid || !Object.hasOwn(s.sessions, sid)) return s;
      const ticks = s.fileTicks ?? {};
      const prev = Object.hasOwn(ticks, sid) ? (ticks[sid] ?? 0) : 0;
      return { ...s, fileTicks: { ...ticks, [sid]: prev + 1 } };
    }
    case 'life.changed':
      return { ...s, lifeTick: (s.lifeTick ?? 0) + 1 };
    case 'primer.status':
      return { ...s, primer: ev.data.status };
    case 'node.updated': {
      const node = ev.data.node;
      return { ...s, nodes: { ...(s.nodes ?? {}), [node.id]: node } };
    }
    case 'node.removed':
      return removeNode(s, ev.data.id);

    // Moment events: no state change.
    case 'session.done':
    case 'session.waiting':
    case 'session.reminder':
    case 'usage.threshold':
    case 'planner.no_room':
    case 'device.pending':
      return s;
    default:
      return s;
  }
}

function applyMove(s: State, ev: DaemonEvent): State {
  const sid = ev.sid;
  if (!sid) return s;
  const session = s.sessions[sid];
  if (MOVE_FINAL_EVENT_TYPES.includes(ev.type)) {
    if (!(sid in s.moves) && !session?.move) return s;
    const moves = { ...s.moves };
    delete moves[sid];
    let sessions = s.sessions;
    if (session?.move) {
      const next = { ...session };
      delete next.move;
      sessions = { ...s.sessions, [sid]: next };
    }
    return { ...s, moves, sessions };
  }
  if (!isMoveEvent(ev)) return s;
  const move = ev.data.move;
  const sessions = session ? { ...s.sessions, [sid]: { ...session, move } } : s.sessions;
  return { ...s, moves: { ...s.moves, [sid]: move }, sessions };
}

/** v0.6: a paired machine goes, with its sessions, their cards, sends and file ticks, and its launches. */
function removeNode(s: State, id: string): State {
  const sids = new Set(Object.values(s.sessions).filter((x) => x.node === id).map((x) => x.sid));
  const known = s.nodes !== undefined && Object.hasOwn(s.nodes, id);
  const launches = omitWhere(s.launches, (l) => l.node === id);
  if (!known && sids.size === 0 && launches === s.launches) return s;
  const out: State = {
    ...s,
    sessions: omitWhere(s.sessions, (x) => sids.has(x.sid)),
    pending: omitWhere(s.pending, (p) => sids.has(p.sid)),
    sends: omitWhere(s.sends, (j) => sids.has(j.sid)),
    launches,
  };
  if (known) {
    const nodes = { ...s.nodes };
    delete nodes[id];
    out.nodes = nodes;
  }
  if (s.fileTicks) out.fileTicks = omitWhere(s.fileTicks, (_n, sid) => sids.has(sid));
  return out;
}

/** `rec` without the entries `pred` picks (the same object when none). Built with fromEntries: every key stays an own key. */
function omitWhere<T>(rec: Record<string, T>, pred: (v: T, k: string) => boolean): Record<string, T> {
  const entries = Object.entries(rec);
  const kept = entries.filter(([k, v]) => !pred(v, k));
  return kept.length === entries.length ? rec : Object.fromEntries(kept);
}

/** The Mac's newest ALERTS_CAP alerts and each server's newest NODE_ALERTS_CAP (newest first, as given). */
function capAlerts(alerts: Alert[]): Alert[] {
  const seen = new Map<string, number>();
  return alerts.filter((a) => {
    const n = (seen.get(a.node ?? '') ?? 0) + 1;
    seen.set(a.node ?? '', n);
    return n <= (a.node === undefined ? ALERTS_CAP : NODE_ALERTS_CAP);
  });
}

/** Keep at most SENDS_CAP of the Mac's jobs and NODE_SENDS_CAP of each server's, dropping the oldest finished ones first. */
function pruneSends(sends: Record<string, SendJob>, sessions: State['sessions']): Record<string, SendJob> {
  const machine = (j: SendJob) => (Object.hasOwn(sessions, j.sid) ? sessions[j.sid]?.node : undefined);
  return pruneEach(sends, machine, SENDS_CAP, NODE_SENDS_CAP, (j) => SEND_FINAL_STAGES.includes(j.stage));
}

/** Keep at most REWRITE_CAP rewrite jobs: the oldest finished first, then the oldest of the rest. */
function pruneRewrites(jobs: Record<string, RewriteJob>): Record<string, RewriteJob> {
  return pruneJobs(jobs, REWRITE_CAP, (j) => REWRITE_FINAL_STATES.includes(j.state), true);
}

/** Keep at most LAUNCH_CAP launches of each machine: the oldest finished first, then the oldest of the rest. */
function pruneLaunches(jobs: Record<string, LaunchJob>): Record<string, LaunchJob> {
  return pruneEach(jobs, (j) => j.node, LAUNCH_CAP, LAUNCH_CAP, (j) => LAUNCH_FINAL_STAGES.includes(j.stage), true);
}

/**
 * pruneJobs on each machine's jobs alone: the Mac's (`machine` undefined) to
 * `hubCap`, each server's to `nodeCap`. So a server's jobs, whatever their
 * number or `updatedAt`, never push out the Mac's or another server's.
 */
function pruneEach<J extends { id: string; updatedAt: string }>(
  jobs: Record<string, J>,
  machine: (j: J) => string | undefined,
  hubCap: number,
  nodeCap: number,
  finished: (j: J) => boolean,
  hard = false,
): Record<string, J> {
  const groups = new Map<string, J[]>();
  for (const j of Object.values(jobs)) {
    const k = machine(j) ?? '';
    const g = groups.get(k);
    if (g) g.push(j);
    else groups.set(k, [j]);
  }
  let out = jobs;
  for (const [k, list] of groups) {
    const cap = k === '' ? hubCap : nodeCap;
    if (list.length <= cap) continue;
    const kept = pruneJobs(Object.fromEntries(list.map((j) => [j.id, j])), cap, finished, hard);
    if (out === jobs) out = { ...jobs };
    for (const j of list) if (!Object.hasOwn(kept, j.id)) delete out[j.id];
  }
  return out;
}

/**
 * Drop jobs past `cap`, the oldest finished ones first. With `hard`, the
 * oldest unfinished ones go next, so the record never grows past `cap`
 * (sends keep every unfinished job: each is a prompt in flight).
 */
function pruneJobs<J extends { id: string; updatedAt: string }>(
  jobs: Record<string, J>,
  cap: number,
  finished: (j: J) => boolean,
  hard = false,
): Record<string, J> {
  const ids = Object.keys(jobs);
  if (ids.length <= cap) return jobs;
  const all = ids.map((id) => jobs[id] as J).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const order = [...all.filter(finished), ...(hard ? all.filter((j) => !finished(j)) : [])];
  const out = { ...jobs };
  let extra = ids.length - cap;
  for (const j of order) {
    if (extra <= 0) break;
    delete out[j.id];
    extra -= 1;
  }
  return out;
}
