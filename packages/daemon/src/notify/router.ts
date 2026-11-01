/**
 * Notification router: turns bus events into notifications and fans them out.
 *
 * - Cards (pending.opened): pushed after the settle window (`settleUntil`,
 *   and at least `notify.settle_ms` for permission cards), and only if the
 *   card is still open then. Auto-approved requests close inside the window.
 * - A session Claude says is waiting with no card (the hook-less path) is
 *   pushed after the same settle delay, unless a card turns up meanwhile.
 * - Reminders: while a session still needs you, `session.reminder` is
 *   emitted at each of `notify.reminders_min` (10 and 30 min) and pushed.
 *   Reminder marks are kept in the db so a restart does not repeat them.
 * - session.done, alert.*, usage.threshold and failed sends map to their
 *   kinds; failed sends are pushed at once. The text (format.ts) gets what it
 *   needs from state here: how long a turn ran, when an account resets, who
 *   is on it.
 * - Filters: `notify.kinds` (a reminder passes when its base kind does),
 *   `notify.muted_until` (failed sends are never muted: an unsent prompt
 *   must be loud; nor is a medicine, v0.4), and the per-channel switches
 *   `notify.webpush|mac|telegram`. Life pushes do not come through here
 *   (life/push.ts sends them with direct.ts), but if one ever did, mute
 *   still could not silence a medicine.
 * - v0.5.3, the urgent alert (countdown.ts, while `notify.urgent` is on,
 *   `notify.kinds` holds permission, the kind it goes out as, nothing is
 *   muted and a channel is on): when a subagent-info card opens (once more
 *   while it is open if the read failed), and before a waiting push, the
 *   session's screen is read once for Claude's 2-minute auto-block
 *   countdown. One ask gets one urgent `permission` push with its deadline
 *   (and at most one repeat); while that read shows it open the session's
 *   plain waiting push is not sent. A read that failed or took over
 *   URGENT_ANSWER_MS lets the waiting push go. It goes through the same
 *   filters as every push (kinds, mute, channels, each device's kinds).
 *   Without `terminal` and `panes` there is no urgent alert.
 * - v0.6 Fleet: a paired server's pushes name it (format.ts, the name the
 *   Mac gave it), and each server gets at most NODE_LIMITS.pushesPerMin a
 *   minute, on top of the mute (a server cannot flood the phone); the Mac's
 *   own pushes never count against it. The urgent alert is the Mac's own
 *   sessions' only: a server's screen is never read for it (the Mac's
 *   terminal can't show it), so a server's unattended ask gets its plain
 *   waiting push.
 */
import { accountsOf, machineName, type Alert, type DaemonEvent, type NotifyKind, type PendingRequest, type Session, type State } from '@jantar/protocol';
import { NODE_LIMITS } from '@jantar/protocol/node-link';
import type { DaemonContext, NotificationRouter, Notifier, PaneFinder, TerminalBackend, TimerId, Unsubscribe } from '../contracts.js';
import { CountdownWatch, createCountdownProbe, type UrgentPush } from './countdown.js';
import {
  alertNotification,
  cardKind,
  cardNotification,
  doneNotification,
  reminderNotification,
  sendFailedNotification,
  urgentNotification,
  usageNotification,
  waitingKind,
  waitingNotification,
  type LimitContext,
  type RoutedNotification,
  type TextContext,
  type UsageContext,
} from './format.js';
import { channelOn, isMuted } from './direct.js';

const TOLD_KEY = 'notify.reminders.told';
/** Reminder marks older than this are forgotten. */
const TOLD_TTL_MS = 48 * 60 * 60 * 1000;
/** Dedupe memory for one-shot pushes (failed sends, waiting episodes). */
const SENT_CAP = 2000;
/** v0.6: the window of a server's push budget. */
const PUSH_WINDOW_MS = 60_000;

interface Waiting {
  since: string;
  baseKind: NotifyKind;
  card?: PendingRequest;
}

interface ReminderTrack {
  since: string;
  timers: TimerId[];
}

type ToldMap = Record<string, { at: number; mins: number[] }>;

export interface RouterDeps {
  notifiers: Notifier[];
  /**
   * v0.5.3: the terminal and daemon.ts's shared PaneLookup, for the urgent
   * alert's screen read (countdown.ts). Without both there is none.
   */
  terminal?: TerminalBackend;
  panes?: PaneFinder;
}

export type RouterContext = Pick<DaemonContext, 'store' | 'settings' | 'clock' | 'log' | 'db'>;

/**
 * For a limit push: which window ran out, when it resets, and the folders on that account.
 * v0.6: on the alert's own machine (a server's account 1 is not the Mac's): its accounts
 * (accountsOf) and its sessions only.
 */
export function limitContext(state: Readonly<State>, alert: Alert): LimitContext {
  const session = alert.sid && Object.hasOwn(state.sessions, alert.sid) ? state.sessions[alert.sid] : undefined;
  const account = alert.account ?? session?.account ?? undefined;
  if (account === undefined || account === null) return {};
  const node = alert.node ?? session?.node;
  const accounts = accountsOf(state, node);
  const a = Object.hasOwn(accounts, String(account)) ? accounts[String(account)] : undefined;
  const ctx: LimitContext = {};
  const full = a?.windows.find((w) => w.pct >= 100) ?? a?.windows.find((w) => w.kind === 'five_hour');
  if (full) {
    if (full.kind === 'five_hour') ctx.window = '5-hour';
    else if (full.kind === 'seven_day') ctx.window = 'weekly';
    if (full.resetsAt) ctx.resetsAt = full.resetsAt;
  }
  const folders = Object.values(state.sessions)
    .filter((s) => s.node === node && s.account === account && s.status !== 'ended')
    .map((s) => s.folder)
    .filter(Boolean);
  if (folders.length) ctx.folders = [...new Set(folders)];
  return ctx;
}

/** For a usage push: when the window resets and when it is full at the current burn. */
export function usageContext(state: Readonly<State>, account: number, window: string, nowMs: number): UsageContext {
  const a = state.accounts[String(account)];
  const w = a?.windows.find((x) => x.kind === window);
  const ctx: UsageContext = {};
  if (w?.resetsAt) ctx.resetsAt = w.resetsAt;
  if (w?.projectedExhaustionAt) ctx.fullAt = w.projectedExhaustionAt;
  else if (window === 'five_hour' && a?.projection?.fullInMin !== undefined) ctx.fullAt = new Date(nowMs + a.projection.fullInMin * 60_000).toISOString();
  return ctx;
}

/** v0.6: the paired server a session runs on (undefined: the Mac's own). */
export function nodeOf(state: Readonly<State>, sid: string | undefined): string | undefined {
  return sid !== undefined && Object.hasOwn(state.sessions, sid) ? state.sessions[sid]?.node : undefined;
}

/** v0.6: the machine word for a push: a server's name as the Mac gave it; nothing for the Mac. */
export function machineContext(state: Readonly<State>, node: string | undefined): TextContext {
  return node === undefined ? {} : { machine: machineName(state, node) };
}

/** The oldest open card (not subagent info) of a session, or Claude's own "waiting". */
export function waitingOf(state: Readonly<State>, sid: string): Waiting | null {
  const session = state.sessions[sid];
  const cards = Object.values(state.pending)
    .filter((p) => p.sid === sid && p.state === 'open' && cardKind(p) !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const card = cards[0];
  if (card) return { since: card.createdAt, baseKind: cardKind(card) as NotifyKind, card };
  if (session?.status === 'waiting') return { since: session.statusSince, baseKind: waitingKind(session.waitingFor) };
  return null;
}

export class NotificationRouterImpl implements NotificationRouter {
  private unsub: Unsubscribe | null = null;
  private unsubSettings: Unsubscribe | null = null;
  private readonly settle = new Map<string, TimerId>();
  private readonly reminders = new Map<string, ReminderTrack>();
  private readonly sent = new Set<string>();
  /** sid -> when the current turn started working; sid -> how long the last turn ran (for "finished · 7m"). */
  private readonly workStart = new Map<string, string>();
  private readonly ranFor = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();
  /** v0.5.3: Claude's countdown episodes (null without a terminal, or while stopped). */
  private countdown: CountdownWatch | null = null;
  /** v0.6: node id -> when its recent pushes went out (the last PUSH_WINDOW_MS). */
  private readonly nodePushes = new Map<string, number[]>();
  private readonly log;

  constructor(
    private readonly ctx: RouterContext,
    private readonly deps: RouterDeps,
  ) {
    this.log = ctx.log.child({ part: 'notify' });
  }

  async start(): Promise<void> {
    if (this.unsub) return;
    const { terminal, panes } = this.deps;
    if (terminal && panes) {
      this.countdown = new CountdownWatch({
        clock: this.ctx.clock,
        probe: createCountdownProbe({ store: this.ctx.store, clock: this.ctx.clock, log: this.log }, { terminal, panes }),
        enabled: () => this.urgentOn(),
        push: (u) => this.onUrgent(u),
        track: (p) => this.track(p),
      });
    }
    this.unsub = this.ctx.store.subscribe((ev) => this.onEvent(ev));
    this.unsubSettings = this.ctx.settings.subscribe((next, prev) => {
      if (JSON.stringify(next.notify.reminders_min) !== JSON.stringify(prev.notify.reminders_min)) this.rescanReminders(true);
    });
    this.rescanReminders(false);
  }

  async stop(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    this.unsubSettings?.();
    this.unsubSettings = null;
    for (const t of this.settle.values()) this.ctx.clock.clearTimeout(t);
    this.settle.clear();
    for (const r of this.reminders.values()) for (const t of r.timers) this.ctx.clock.clearTimeout(t);
    this.reminders.clear();
    this.countdown?.stop();
    this.countdown = null;
    await this.whenIdle();
  }

  /** Resolves when every send started so far has finished (tests). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // -------------------------------------------------------------------------

  private onEvent(ev: DaemonEvent): void {
    const state = this.ctx.store.getState();
    switch (ev.type) {
      case 'pending.opened':
        this.onCardOpened(ev.data.pending);
        this.reevaluate(ev.data.pending.sid);
        return;
      case 'pending.resolved': {
        const t = this.settle.get(`card:${ev.data.id}`);
        if (t !== undefined) {
          this.ctx.clock.clearTimeout(t);
          this.settle.delete(`card:${ev.data.id}`);
        }
        if (ev.sid) this.reevaluate(ev.sid);
        return;
      }
      case 'session.waiting':
        if (ev.sid && !ev.data.pendingId) this.onSessionWaiting(ev.sid);
        if (ev.sid) this.reevaluate(ev.sid);
        return;
      case 'session.updated':
        if (ev.sid) {
          this.trackWork(ev.sid);
          if (ev.data.patch.status === 'waiting') this.onSessionWaiting(ev.sid);
          this.reevaluate(ev.sid);
        }
        return;
      case 'session.added':
        this.trackWork(ev.data.session.sid);
        if (ev.data.session.status === 'waiting') this.onSessionWaiting(ev.data.session.sid);
        this.reevaluate(ev.data.session.sid);
        return;
      case 'session.removed':
        if (ev.sid) this.forget(ev.sid);
        return;
      case 'node.removed': {
        // v0.6: its sessions and cards left the board with it; nothing more is timed or pushed for them.
        this.nodePushes.delete(ev.data.id);
        const sids = new Set([...this.workStart.keys(), ...this.ranFor.keys(), ...this.reminders.keys()]);
        for (const k of this.settle.keys()) if (k.startsWith('wait:')) sids.add(k.slice('wait:'.length).split(':')[0] ?? '');
        for (const sid of sids) if (!Object.hasOwn(state.sessions, sid)) this.forget(sid);
        for (const [k, t] of [...this.settle]) {
          if (!k.startsWith('card:') || Object.hasOwn(state.pending, k.slice('card:'.length))) continue;
          this.ctx.clock.clearTimeout(t);
          this.settle.delete(k);
        }
        return;
      }
      case 'session.done': {
        if (!ev.sid) return;
        const s = state.sessions[ev.sid];
        const ts = this.ctx.clock.iso();
        const node = nodeOf(state, ev.sid);
        this.dispatch(doneNotification(ev.sid, s, ev.data.lastReply, this.bodies(), ts, this.takeRan(ev.sid, ts), machineContext(state, node)), node);
        return;
      }
      case 'session.reminder':
        if (ev.sid) this.onReminder(ev.sid, ev.data.afterMin);
        return;
      case 'alert.blocked':
      case 'alert.rejected':
      case 'alert.limit':
      case 'alert.error': {
        const a = ev.data.alert;
        const node = a.node ?? nodeOf(state, a.sid);
        const ctx = { ...limitContext(state, a), ...machineContext(state, node) };
        this.dispatch(alertNotification(a, a.sid ? state.sessions[a.sid] : null, this.bodies(), this.ctx.clock.iso(), ctx), node);
        return;
      }
      case 'usage.threshold':
        if (ev.account !== undefined) {
          const ctx = usageContext(state, ev.account, ev.data.window, this.ctx.clock.now());
          this.dispatch(usageNotification(ev.account, ev.data, this.bodies(), this.ctx.clock.iso(), ctx));
        }
        return;
      case 'send.progress': {
        const job = ev.data.job;
        if (job.stage !== 'failed') return;
        if (!this.once(`send-failed:${job.id}`)) return;
        const node = nodeOf(state, job.sid);
        this.dispatch(sendFailedNotification(job, state.sessions[job.sid], this.bodies(), this.ctx.clock.iso(), machineContext(state, node)), node);
        return;
      }
      default:
        return;
    }
  }

  private bodies() {
    return this.ctx.settings.get().notify.bodies;
  }

  /** Remember when a turn starts working, and how long it ran once it stops. */
  private trackWork(sid: string): void {
    const s = this.ctx.store.getState().sessions[sid];
    if (!s) return;
    if (s.status === 'working' || s.status === 'compacting') {
      if (!this.workStart.has(sid)) this.workStart.set(sid, s.statusSince);
      return;
    }
    if (s.status === 'waiting') return; // still the same turn
    const start = this.workStart.get(sid);
    if (start === undefined) return;
    this.workStart.delete(sid);
    const ms = Date.parse(s.statusSince) - Date.parse(start);
    if (Number.isFinite(ms) && ms >= 0) this.ranFor.set(sid, ms);
  }

  /** How long the turn that just finished ran (once), if this daemon saw it start. */
  private takeRan(sid: string, ts: string): number | undefined {
    let ms = this.ranFor.get(sid);
    this.ranFor.delete(sid);
    const start = this.workStart.get(sid);
    if (ms === undefined && start !== undefined) {
      this.workStart.delete(sid);
      ms = Date.parse(ts) - Date.parse(start);
    }
    return ms !== undefined && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }

  private once(key: string): boolean {
    if (this.sent.has(key)) return false;
    this.sent.add(key);
    if (this.sent.size > SENT_CAP) {
      const first = this.sent.values().next().value;
      if (first !== undefined) this.sent.delete(first);
    }
    return true;
  }

  private onCardOpened(p: PendingRequest): void {
    if (cardKind(p) === null) {
      // Subagent info: shown in the app, never pushed. Hooks can't answer it, so it may be Claude's countdown.
      // A sid not on the board yet is the Mac's (a server's card comes only for a session the hub holds): read, and retry.
      const session = this.ctx.store.getState().sessions[p.sid];
      if (session ? this.urgentFor(session) : this.urgentOn()) {
        this.countdown?.check(p.sid, p.createdAt, { retry: () => this.ctx.store.getState().pending[p.id]?.state === 'open' });
      }
      return;
    }
    const now = this.ctx.clock.now();
    let delay = Math.max(0, Date.parse(p.settleUntil) - now);
    if (p.kind === 'permission') {
      const settleMs = this.ctx.settings.get().notify.settle_ms;
      delay = Math.max(delay, Date.parse(p.createdAt) + settleMs - now);
    }
    const key = `card:${p.id}`;
    const fire = () => {
      this.settle.delete(key);
      const state = this.ctx.store.getState();
      const card = state.pending[p.id];
      if (!card || card.state !== 'open') return;
      if (!this.once(key)) return;
      const node = nodeOf(state, card.sid);
      const n = cardNotification(card, state.sessions[card.sid], this.bodies(), this.ctx.clock.iso(), machineContext(state, node));
      if (n) this.dispatch(n, node);
    };
    if (delay <= 0) fire();
    else this.settle.set(key, this.ctx.clock.setTimeout(fire, delay));
  }

  private onSessionWaiting(sid: string): void {
    const s0 = this.ctx.store.getState().sessions[sid];
    if (!s0 || s0.status !== 'waiting') return;
    const since = s0.statusSince;
    const key = `wait:${sid}:${since}`;
    if (this.settle.has(key) || this.sent.has(key)) return;
    /** The session still waits since `since`, with no card of its own (whose push covers it). */
    const still = () => {
      const state = this.ctx.store.getState();
      const s = state.sessions[sid];
      if (!s || s.status !== 'waiting' || s.statusSince !== since) return null;
      return waitingOf(state, sid)?.card ? null : s;
    };
    const send = () => {
      const s = still();
      if (s) this.dispatch(waitingNotification(s, this.bodies(), this.ctx.clock.iso(), machineContext(this.ctx.store.getState(), s.node)), s.node);
    };
    const fire = () => {
      this.settle.delete(key);
      const s = still();
      if (!s || !this.once(key)) return;
      // v0.5.3: Claude's countdown on screen sends the urgent push instead.
      if (this.countdown && this.urgentFor(s)) {
        this.countdown.check(sid, since, {
          then: (open) => {
            if (!open) send();
          },
        });
      } else send();
    };
    const settleMs = this.ctx.settings.get().notify.settle_ms;
    if (settleMs <= 0) fire();
    else this.settle.set(key, this.ctx.clock.setTimeout(fire, settleMs));
  }

  /** A session gone from the board: its timers and what was tracked for it. */
  private forget(sid: string): void {
    this.workStart.delete(sid);
    this.ranFor.delete(sid);
    this.clearReminder(sid);
    this.countdown?.drop(sid);
    for (const [k, t] of [...this.settle]) {
      if (!k.startsWith(`wait:${sid}:`)) continue;
      this.ctx.clock.clearTimeout(t);
      this.settle.delete(k);
    }
  }

  // ---- reminders -----------------------------------------------------------

  private rescanReminders(reset: boolean): void {
    const state = this.ctx.store.getState();
    if (reset) for (const sid of [...this.reminders.keys()]) this.clearReminder(sid);
    for (const sid of Object.keys(state.sessions)) this.reevaluate(sid);
    for (const sid of [...this.reminders.keys()]) if (!state.sessions[sid]) this.clearReminder(sid);
  }

  private clearReminder(sid: string): void {
    const r = this.reminders.get(sid);
    if (!r) return;
    for (const t of r.timers) this.ctx.clock.clearTimeout(t);
    this.reminders.delete(sid);
  }

  private reevaluate(sid: string): void {
    const w = waitingOf(this.ctx.store.getState(), sid);
    const cur = this.reminders.get(sid);
    if (!w) {
      this.clearReminder(sid);
      return;
    }
    if (cur && cur.since === w.since) return;
    this.clearReminder(sid);
    const sinceMs = Date.parse(w.since);
    if (!Number.isFinite(sinceMs)) return;
    const mins = [...new Set(this.ctx.settings.get().notify.reminders_min)].sort((a, b) => a - b);
    const told = new Set(this.toldFor(sid, w.since));
    const now = this.ctx.clock.now();
    const track: ReminderTrack = { since: w.since, timers: [] };
    this.reminders.set(sid, track);
    const overdue = mins.filter((m) => !told.has(m) && sinceMs + m * 60_000 <= now);
    for (const m of mins) {
      if (told.has(m)) continue;
      const at = sinceMs + m * 60_000;
      if (at <= now) continue;
      track.timers.push(this.ctx.clock.setTimeout(() => this.fireReminder(sid, w.since, m), at - now));
    }
    // After a restart (or a settings change) only the latest missed reminder is sent, once.
    const latest = overdue[overdue.length - 1];
    if (latest !== undefined) {
      this.markTold(sid, w.since, overdue);
      this.emitReminder(sid, w.since, latest);
    }
  }

  private fireReminder(sid: string, since: string, m: number): void {
    const w = waitingOf(this.ctx.store.getState(), sid);
    if (!w || w.since !== since) return;
    if (this.toldFor(sid, since).includes(m)) return;
    this.markTold(sid, since, [m]);
    this.emitReminder(sid, since, m);
  }

  private emitReminder(sid: string, since: string, m: number): void {
    try {
      this.ctx.store.emit({ type: 'session.reminder', sid, data: { afterMin: m, waitingSince: since } });
    } catch (e) {
      this.log.error('cannot emit reminder', { sid, error: String(e) });
    }
  }

  private onReminder(sid: string, afterMin: number): void {
    const state = this.ctx.store.getState();
    const w = waitingOf(state, sid);
    const session = state.sessions[sid];
    if (!w || !session) return;
    const mode = this.bodies();
    const ts = this.ctx.clock.iso();
    const ctx = machineContext(state, session.node);
    const base = w.card ? cardNotification(w.card, session, mode, ts, ctx) : waitingNotification(session, mode, ts, ctx);
    if (!base) return;
    this.dispatch(reminderNotification(base, afterMin, mode, ts), session.node);
  }

  private toldMap(): ToldMap {
    return this.ctx.db.kv.get<ToldMap>(TOLD_KEY) ?? {};
  }

  private toldFor(sid: string, since: string): number[] {
    return this.toldMap()[`${sid}|${since}`]?.mins ?? [];
  }

  private markTold(sid: string, since: string, mins: number[]): void {
    const now = this.ctx.clock.now();
    const map = this.toldMap();
    const key = `${sid}|${since}`;
    const prev = map[key]?.mins ?? [];
    map[key] = { at: now, mins: [...new Set([...prev, ...mins])] };
    for (const [k, v] of Object.entries(map)) if (now - v.at > TOLD_TTL_MS) delete map[k];
    this.ctx.db.kv.set(TOLD_KEY, map);
  }

  // ---- the urgent alert (v0.5.3) ------------------------------------------------

  /**
   * notify.urgent, permission in notify.kinds, no mute and a channel on:
   * without them the urgent push could never go out, so nothing is read.
   * The waiting push is held the same way (allowed()), so none goes instead.
   */
  private urgentOn(): boolean {
    const n = this.ctx.settings.get().notify;
    if (!n.urgent || !n.kinds.includes('permission') || isMuted(n, this.ctx.clock.now())) return false;
    return this.deps.notifiers.some((x) => this.channelOn(x));
  }

  /** v0.6: the urgent alert reads the Mac's own sessions only (a server's screen is not the Mac's to read). */
  private urgentFor(session: Session): boolean {
    return session.node === undefined && this.urgentOn();
  }

  private onUrgent(u: UrgentPush): void {
    const session = this.ctx.store.getState().sessions[u.sid];
    if (!session) return;
    const n = urgentNotification(session, u.left, u.deadline, this.bodies(), this.ctx.clock.iso());
    this.dispatch(n, session.node, { urgent: true, left: u.left, repeat: u.repeat });
  }

  // ---- fan-out ---------------------------------------------------------------

  /** Whether settings let this notification out at all. */
  allowed(n: RoutedNotification): boolean {
    const s = this.ctx.settings.get().notify;
    if (n.kind !== 'send-failed' && n.kind !== 'med' && isMuted(s, this.ctx.clock.now())) return false;
    if (s.kinds.includes(n.kind)) return true;
    return n.kind === 'reminder' && n.baseKind !== undefined && s.kinds.includes(n.baseKind);
  }

  private channelOn(n: Notifier): boolean {
    return channelOn(this.ctx.settings.get().notify, n);
  }

  /**
   * v0.6: whether a server still has push budget this minute (and spend one).
   * Only pushes that would go out count; the Mac's own never do.
   */
  private nodeBudget(node: string): boolean {
    const now = this.ctx.clock.now();
    const recent = (this.nodePushes.get(node) ?? []).filter((t) => t > now - PUSH_WINDOW_MS);
    if (recent.length >= NODE_LIMITS.pushesPerMin) {
      this.nodePushes.set(node, recent);
      return false;
    }
    recent.push(now);
    this.nodePushes.set(node, recent);
    return true;
  }

  /**
   * `node`: the paired server the push is about (v0.6), undefined for the Mac's own.
   * `extra`: more fields for the log line (the urgent alert's `urgent`, `left` and `repeat`; never text).
   */
  private dispatch(n: RoutedNotification, node?: string, extra: Record<string, unknown> = {}): void {
    if (!this.allowed(n)) return;
    if (node !== undefined && !this.nodeBudget(node)) {
      this.log.info('server push budget spent', { node, kind: n.kind });
      return;
    }
    for (const notifier of this.deps.notifiers) {
      if (!this.channelOn(notifier)) continue;
      this.track(
        (async () => {
          try {
            const r = await notifier.send(n);
            this.log.info('notification sent', { channel: notifier.channel, kind: n.kind, sid: n.sid, ...extra, ...r });
          } catch (e) {
            this.log.error('notifier failed', { channel: notifier.channel, kind: n.kind, error: String(e) });
          }
        })(),
      );
    }
  }

  /** Keep `p` until it settles (whenIdle and stop wait for it); a rejection is logged, never thrown. */
  private track(p: Promise<unknown>): void {
    const q = p.then(
      () => undefined,
      (e: unknown) => this.log.error('notify task failed', { error: e instanceof Error ? e.name : typeof e }),
    );
    this.inflight.add(q);
    void q.finally(() => this.inflight.delete(q));
  }
}
