/**
 * v0.6 Fleet: a node's events and snapshots into the hub's state.
 *
 * An event's `type` is looked up in the hub's own EVENT table first: an
 * unknown type is dropped and not counted, and so is a known type a node
 * never sends (NODE_EVENT_TYPES). Then parseEvent, clipping, ids
 * (NODE_SUPPLIED_ID, own keys only), ownership against the hub's state, the
 * counts (64 sessions, 32 open cards) and the 4 MiB state budget; a refusal
 * is dropped and counted (the registry closes 4400 after 20 a minute, logged
 * without the payload). Accepted events are re-emitted into the hub's own
 * store with `node` stamped (spec 3.5's table), with the hub's own seq and
 * time; a node's `daemon.version` and `usage.updated` become one
 * `node.updated`.
 *
 * A snapshot is diffed against the hub's last view of the node: cards gone
 * are closed, sessions gone removed, new ones added, changed ones patched,
 * and only cards the hub does not have are opened (a card it already has is
 * never re-opened, so a dropped link never pushes it twice). Its view goes
 * first, so a push fired by a card already names the machine.
 */
import {
  LAUNCH_FINAL_STAGES,
  SEND_FINAL_STAGES,
  SessionOptionalKeySchema,
  isEventType,
  parseEvent,
  type Account,
  type Alert,
  type DaemonEvent,
  type EventInput,
  type LaunchJob,
  type NodeView,
  type PendingRequest,
  type SendJob,
  type Session,
  type SessionOptionalKey,
  type SessionPatch,
  type State,
} from '@jantar/protocol';
import { NODE_LIMITS, NODE_SUPPLIED_ID, NodeSnapshotSchema, type NodeSnapshot } from '@jantar/protocol/node-link';
import { NODE_EVENT_TYPES, SNAPSHOT_RECENT, clipAccount, clipAlert, clipCard, clipEvent, clipLaunch, clipSend, clipSession } from './clip.js';
import type { NodeRegistry } from './registry.js';
import { nodeViewOf } from './view.js';

/** What happened to one event or snapshot. `refused` counts toward the node's refusals; `dropped` (an unknown type) does not. */
export type IngestOutcome = { ok: true } | { ok: false; kind: 'dropped' | 'refused' | 'close'; reason: string };

/** Sends or launches one snapshot may carry: the unfinished ones (one per session at most) and the newest few. */
const SNAPSHOT_JOBS_MAX = NODE_LIMITS.sessions + SNAPSHOT_RECENT;

const OK: IngestOutcome = { ok: true };
const dropped = (reason: string): IngestOutcome => ({ ok: false, kind: 'dropped', reason });
const refused = (reason: string): IngestOutcome => ({ ok: false, kind: 'refused', reason });
const closing = (reason: string): IngestOutcome => ({ ok: false, kind: 'close', reason });

const OPTIONAL_KEYS: ReadonlySet<string> = new Set(SessionOptionalKeySchema.options);
const isOptionalKey = (k: string): k is SessionOptionalKey => OPTIONAL_KEYS.has(k);

function idOk(id: unknown): id is string {
  return typeof id === 'string' && NODE_SUPPLIED_ID.test(id);
}

/** The hub's session `sid`, when it is this node's (ids checked first; own keys only). */
function ownSession(st: Readonly<State>, nodeId: string, sid: string | undefined): Session | null {
  if (!idOk(sid) || !Object.hasOwn(st.sessions, sid)) return null;
  const s = st.sessions[sid] as Session;
  return s.node === nodeId ? s : null;
}

function own<T>(rec: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return rec !== undefined && Object.hasOwn(rec, id) ? rec[id] : undefined;
}

function emitted(reg: NodeRegistry, input: EventInput): IngestOutcome {
  return reg.emit(input) ? OK : refused('not accepted');
}

/** Whether replacing `old` with `next` keeps the node within NODE_LIMITS.stateBytes. */
function fits(reg: NodeRegistry, nodeId: string, old: object | undefined, next: object): boolean {
  const { bytes } = reg.tally(nodeId);
  return bytes - (old ? reg.sizeOf(old) : 0) + reg.sizeOf(next) <= NODE_LIMITS.stateBytes;
}

/** `prev` with `apply` merged in, as a full view (the node's link info and the hub's name). */
function viewWith(reg: NodeRegistry, nodeId: string, apply: (base: NodeView) => NodeView): NodeView | null {
  const rec = reg.record(nodeId);
  if (!rec) return null;
  const prev = reg.view(nodeId);
  const base = prev ?? nodeViewOf(rec, reg.info(nodeId), null, reg.link(nodeId) !== null, reg.now());
  return nodeViewOf(rec, reg.info(nodeId), apply(base), base.online, base.since);
}

function accountsRecord(list: readonly Account[]): Record<string, Account> {
  return Object.fromEntries(list.map((a) => [String(a.id), a]));
}

export function ingestEvent(reg: NodeRegistry, nodeId: string, event: unknown): IngestOutcome {
  const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
  if (typeof type !== 'string' || !isEventType(type)) return dropped('unknown type');
  if (!NODE_EVENT_TYPES.has(type)) return dropped('not a node event');
  let ev: DaemonEvent;
  try {
    ev = clipEvent(parseEvent(event));
  } catch {
    return refused('invalid');
  }
  const st = reg.state();
  switch (ev.type) {
    case 'session.added': {
      const s = ev.data.session;
      if (!idOk(s.sid) || ev.sid !== s.sid) return refused('bad id');
      if (Object.hasOwn(st.sessions, s.sid)) return refused('known session');
      if (reg.tally(nodeId).sessions >= NODE_LIMITS.sessions) return refused('too many sessions');
      // The hub stamps the machine; whatever the node put there is overwritten.
      const session: Session = { ...s, node: nodeId };
      if (!fits(reg, nodeId, undefined, session)) return refused('over the state budget');
      return emitted(reg, { type: 'session.added', sid: s.sid, data: { session } });
    }
    case 'session.updated': {
      const prev = ownSession(st, nodeId, ev.sid);
      if (!prev) return refused('not its session');
      const next: Session = { ...prev, ...ev.data.patch };
      for (const k of ev.data.unset ?? []) delete (next as Partial<Session>)[k];
      if (!fits(reg, nodeId, prev, next)) return refused('over the state budget');
      return emitted(reg, { type: 'session.updated', sid: prev.sid, data: ev.data });
    }
    case 'session.removed':
    case 'session.done': {
      const s = ownSession(st, nodeId, ev.sid);
      if (!s) return refused('not its session');
      return emitted(reg, { type: ev.type, sid: s.sid, data: ev.data } as EventInput);
    }
    case 'session.waiting': {
      const s = ownSession(st, nodeId, ev.sid);
      if (!s) return refused('not its session');
      if (ev.data.pendingId !== undefined && !idOk(ev.data.pendingId)) return refused('bad id');
      return emitted(reg, { type: 'session.waiting', sid: s.sid, data: ev.data });
    }
    case 'pending.opened': {
      const p = ev.data.pending;
      if (!idOk(p.id) || p.sid !== ev.sid) return refused('bad id');
      if (!ownSession(st, nodeId, p.sid)) return refused('not its session');
      if (Object.hasOwn(st.pending, p.id)) return refused('known card');
      if (reg.tally(nodeId).cards >= NODE_LIMITS.openCards) return refused('too many cards');
      if (!fits(reg, nodeId, undefined, p)) return refused('over the state budget');
      return emitted(reg, { type: 'pending.opened', sid: p.sid, data: { pending: p } });
    }
    case 'pending.resolved': {
      const card = idOk(ev.data.id) ? own(st.pending, ev.data.id) : undefined;
      if (!card) return refused('unknown card');
      if (!ownSession(st, nodeId, card.sid)) return refused('not its card');
      if (ev.data.state === 'decided' && !fits(reg, nodeId, card, { ...card, ...ev.data })) return refused('over the state budget');
      return emitted(reg, { type: 'pending.resolved', sid: card.sid, data: ev.data });
    }
    case 'send.progress': {
      const job = ev.data.job;
      if (!idOk(job.id) || job.sid !== ev.sid) return refused('bad id');
      if (!ownSession(st, nodeId, job.sid)) return refused('not its session');
      const known = own(st.sends, job.id);
      if (known && known.sid !== job.sid) return refused('not its send');
      if (!fits(reg, nodeId, known, job)) return refused('over the state budget');
      return emitted(reg, { type: 'send.progress', sid: job.sid, data: { job } });
    }
    case 'launch.progress': {
      const job = ev.data.job;
      if (!idOk(job.id)) return refused('bad id');
      const known = own(st.launches, job.id);
      if (known && known.node !== nodeId) return refused('not its launch');
      const stamped: LaunchJob = { ...job, node: nodeId };
      if (!fits(reg, nodeId, known, stamped)) return refused('over the state budget');
      return emitted(reg, { type: 'launch.progress', data: { job: stamped } });
    }
    case 'alert.blocked':
    case 'alert.rejected':
    case 'alert.limit':
    case 'alert.error': {
      const a = ev.data.alert;
      if (!idOk(a.id)) return refused('bad id');
      if (a.sid !== undefined && !ownSession(st, nodeId, a.sid)) return refused('not its session');
      const known = st.alerts.find((x) => x.id === a.id);
      if (known && known.node !== nodeId) return refused('not its alert');
      const alert: Alert = { ...a, node: nodeId };
      if (!fits(reg, nodeId, known, alert)) return refused('over the state budget');
      return emitted(reg, { type: ev.type, ...(a.sid !== undefined ? { sid: a.sid } : {}), data: { alert } } as EventInput);
    }
    case 'daemon.version': {
      const { features, accountsMode } = ev.data;
      return nodeUpdated(reg, nodeId, (base) => ({ ...base, features: features ?? base.features, accountsMode: accountsMode ?? base.accountsMode }));
    }
    case 'usage.updated': {
      const u = ev.data;
      return nodeUpdated(reg, nodeId, (base) => ({
        ...base,
        accounts: accountsRecord(u.accounts),
        activeAccount: u.activeAccount,
        usage: { fetchedAt: u.fetchedAt, source: u.source },
      }));
    }
    default:
      return dropped('not a node event');
  }
}

/** A node's `daemon.version` or `usage.updated` as one `node.updated` (none when nothing changed). */
function nodeUpdated(reg: NodeRegistry, nodeId: string, apply: (base: NodeView) => NodeView): IngestOutcome {
  const next = viewWith(reg, nodeId, apply);
  if (!next) return refused('not paired');
  const prev = reg.view(nodeId);
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return OK;
  if (!fits(reg, nodeId, prev ?? undefined, next)) return refused('over the state budget');
  return emitted(reg, { type: 'node.updated', data: { node: next } });
}

/** Every field whose value changed, and the optional fields `before` has and `after` lacks. */
function sessionDiff(before: Session, after: Session): { patch: SessionPatch; unset: SessionOptionalKey[] } {
  const patch: Record<string, unknown> = {};
  const unset: SessionOptionalKey[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (k === 'sid' || k === 'node') continue;
    if (JSON.stringify(v) !== JSON.stringify((before as Record<string, unknown>)[k])) patch[k] = v;
  }
  for (const k of Object.keys(before)) if (isOptionalKey(k) && !Object.hasOwn(after, k)) unset.push(k);
  return { patch: patch as SessionPatch, unset };
}

const sendDone = (j: SendJob): boolean => SEND_FINAL_STAGES.includes(j.stage);
const launchDone = (j: LaunchJob): boolean => LAUNCH_FINAL_STAGES.includes(j.stage);

/**
 * A job worth re-emitting: an unfinished one that changed, or one that
 * finished while the link was down (the hub saw it unfinished). An old
 * finished one the hub never saw is not news (no failed-send push after a
 * hub restart).
 */
function jobNews<J>(next: J, known: J | undefined, done: (j: J) => boolean): boolean {
  if (known !== undefined && JSON.stringify(known) === JSON.stringify(next)) return false;
  return done(next) ? known !== undefined && !done(known) : true;
}

export function ingestSnapshot(reg: NodeRegistry, nodeId: string, snap: NodeSnapshot): IngestOutcome {
  // The link checked it against the schema; check again, so the registry never trusts its transport.
  const parsed = NodeSnapshotSchema.safeParse(snap);
  if (!parsed.success) return closing('invalid snapshot');
  const s = parsed.data;
  const rec = reg.record(nodeId);
  if (!rec) return closing('not paired');
  const st = reg.state();
  let bad = 0;

  // Keep what this node may report, clipped; drop the rest and count it.
  const sessions = new Map<string, Session>();
  for (const raw of Object.values(s.sessions)) {
    const known = idOk(raw.sid) ? own(st.sessions, raw.sid) : undefined;
    if (!idOk(raw.sid) || (known && known.node !== nodeId) || sessions.has(raw.sid) || sessions.size >= NODE_LIMITS.sessions) {
      bad += 1;
      continue;
    }
    sessions.set(raw.sid, { ...clipSession(raw), node: nodeId });
  }
  const cards = new Map<string, PendingRequest>();
  for (const raw of Object.values(s.pending)) {
    if (raw.state !== 'open') continue;
    const known = idOk(raw.id) ? own(st.pending, raw.id) : undefined;
    if (!idOk(raw.id) || !sessions.has(raw.sid) || (known && !ownSession(st, nodeId, known.sid)) || cards.size >= NODE_LIMITS.openCards) {
      bad += 1;
      continue;
    }
    cards.set(raw.id, clipCard(raw));
  }
  const sends: SendJob[] = [];
  for (const raw of Object.values(s.sends)) {
    const known = idOk(raw.id) ? own(st.sends, raw.id) : undefined;
    if (!idOk(raw.id) || !sessions.has(raw.sid) || (known && known.sid !== raw.sid) || sends.length >= SNAPSHOT_JOBS_MAX) {
      bad += 1;
      continue;
    }
    sends.push(clipSend(raw));
  }
  const launches: LaunchJob[] = [];
  for (const raw of Object.values(s.launches)) {
    const known = idOk(raw.id) ? own(st.launches, raw.id) : undefined;
    if (!idOk(raw.id) || (known && known.node !== nodeId) || launches.length >= SNAPSHOT_JOBS_MAX) {
      bad += 1;
      continue;
    }
    launches.push({ ...clipLaunch(raw), node: nodeId });
  }
  const alerts: Alert[] = [];
  for (const raw of s.alerts.slice(0, SNAPSHOT_RECENT)) {
    const known = idOk(raw.id) ? st.alerts.find((x) => x.id === raw.id) : undefined;
    if (!idOk(raw.id) || (raw.sid !== undefined && !sessions.has(raw.sid)) || (known && known.node !== nodeId)) {
      bad += 1;
      continue;
    }
    alerts.push({ ...clipAlert(raw), node: nodeId });
  }
  if (bad > NODE_LIMITS.refusalsPerMin) return closing('snapshot refused');

  const prevView = reg.view(nodeId);
  const view = nodeViewOf(
    rec,
    reg.info(nodeId),
    {
      ...(prevView ?? nodeViewOf(rec, reg.info(nodeId), null, true, reg.now())),
      features: s.daemon.features,
      accountsMode: s.daemon.accountsMode,
      accounts: Object.fromEntries(Object.values(s.accounts).map((a) => [String(a.id), clipAccount(a)])),
      activeAccount: s.activeAccount,
      usage: s.usage,
    },
    true,
    reg.now(),
  );

  // The budget counts what the hub would keep, clipped.
  let bytes = reg.sizeOf(view);
  for (const x of [...sessions.values(), ...cards.values(), ...sends, ...launches, ...(prevView ? alerts : [])]) bytes += reg.sizeOf(x);
  if (bytes > NODE_LIMITS.stateBytes) return closing('over the state budget');

  reg.emit({ type: 'node.updated', data: { node: view } });
  const now = reg.state();
  const before = Object.values(now.sessions).filter((x) => x.node === nodeId);
  const beforeSids = new Set(before.map((x) => x.sid));
  for (const p of Object.values(now.pending)) {
    if (beforeSids.has(p.sid) && !cards.has(p.id)) reg.emit({ type: 'pending.resolved', sid: p.sid, data: { id: p.id, state: 'closed' } });
  }
  for (const old of before) if (!sessions.has(old.sid)) reg.emit({ type: 'session.removed', sid: old.sid, data: { reason: 'gone' } });
  for (const next of sessions.values()) {
    const old = beforeSids.has(next.sid) ? own(now.sessions, next.sid) : undefined;
    if (!old) {
      reg.emit({ type: 'session.added', sid: next.sid, data: { session: next } });
      continue;
    }
    const { patch, unset } = sessionDiff(old, next);
    if (Object.keys(patch).length === 0 && unset.length === 0) continue;
    reg.emit({ type: 'session.updated', sid: next.sid, data: { patch, ...(unset.length ? { unset } : {}) } });
  }
  // Only cards the hub does not have: one it already has (a dropped link) is never opened, or pushed, again.
  for (const p of cards.values()) if (!Object.hasOwn(reg.state().pending, p.id)) reg.emit({ type: 'pending.opened', sid: p.sid, data: { pending: p } });
  for (const job of sends) if (jobNews(job, own(now.sends, job.id), sendDone)) reg.emit({ type: 'send.progress', sid: job.sid, data: { job } });
  for (const job of launches) if (jobNews(job, own(now.launches, job.id), launchDone)) reg.emit({ type: 'launch.progress', data: { job } });
  // Alerts only on a reconnect (what happened while the link was down); after a hub restart they are old news.
  if (prevView) {
    for (const a of [...alerts].reverse()) {
      if (now.alerts.some((x) => x.id === a.id)) continue;
      reg.emit({ type: `alert.${a.kind}`, ...(a.sid !== undefined ? { sid: a.sid } : {}), data: { alert: a } } as EventInput);
    }
  }
  return OK;
}
