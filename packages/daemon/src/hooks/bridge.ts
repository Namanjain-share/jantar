/**
 * The hooks bridge (work package C): a Unix socket server for jantar-hook,
 * the pending-card map and hook-derived session status.
 * Spec: docs/hook-protocol.md sections 5-8.
 *
 * Card lifecycle
 *   blocking PermissionRequest            -> open (pending.opened; settleUntil = now + notify.settle_ms)
 *   PermissionRequest with agent_id       -> open, kind subagent-info (informational; the hook already returned)
 *   AskUserQuestion whose questions
 *         don't parse, or ExitPlanMode
 *         whose input is not an object    -> no card: "no decision" at once, the session waits, and the
 *                                            phone answers Claude's own dialog through the screen
 *   open --decide()-->                    decided (reply written to the hook; pending.resolved {state:'decided'})
 *   decided --PostToolUse(Failure)-->     confirmed (only now is "approved" recorded), except a decided
 *                                         deny: the tool ran anyway, so the terminal allowed it first
 *                                         -> handled-in-terminal (reason deny-too-late)
 *   open --hook connection EOF-->         handled-in-terminal
 *   open --PostToolUse(Failure)-->        handled-in-terminal (the terminal allowed it first)
 *   open --session file leaves "waiting"
 *         after the card opened-->        handled-in-terminal (answered at the Mac; Claude keeps the
 *                                         hook connected while the tool runs, so EOF comes late)
 *   open|decided --PermissionDenied, UserPromptSubmit, Stop, StopFailure, SessionEnd, transcript tool_result--> closed
 *
 * Events are processed in client-timestamp order (ReorderBuffer). A rule that
 * closes cards only touches cards opened before the event that triggers it.
 *
 * Security: the socket accepts hook events only. Decisions come exclusively
 * through decide(), which only accepts paired devices with the control scope.
 */
import { join } from 'node:path';
import {
  DecisionBodySchema,
  HookPayloadSchema,
  localSession,
  type DaemonEvent,
  type DecisionBody,
  type EventInput,
  type HookPayload,
  type PendingRequest,
  type PendingState,
  type Question,
  type Session,
  type SessionOptionalKey,
  type SessionPatch,
} from '@jantar/protocol';
import type {
  Actor,
  DaemonContext,
  DecideResult,
  HooksBridge,
  SessionSource,
  TimerId,
  TranscriptReader,
  Unsubscribe,
} from '../contracts.js';
import { actorId } from '../core/actor.js';
import { canonicalJson } from '../core/hash.js';
import { newSecretId } from '../core/ids.js';
import { mergeStatus, type StatusObservation } from '../core/status.js';
import { AUTO_PLAN_MODES, buildDecision, DEFAULT_PLAN_MODES, HOOK_PLAN_AUTO, redactedDecision, replyLine } from './decisions.js';
import {
  cardKey,
  displayCopy,
  errorText,
  isPlainObject,
  isSubagentPayload,
  kindForTool,
  parseQuestions,
  toolSummary,
} from './keys.js';
import { compareKeys, parseMono, ReorderBuffer, type OrderKey } from './ordering.js';
import { HOOKS_KEY_FILE, listenHookSocket, type HookConn, type HookSocketServer } from './socket.js';
import { notificationKind, statusForEvent, type HookStatus } from './status-map.js';
import { ToolResultWatcher } from './transcript-check.js';

export interface HooksBridgeDeps {
  sessions: SessionSource;
  transcripts: TranscriptReader;
}

export interface HooksBridgeOptions {
  /** Default: ctx.paths.hooksSock */
  socketPath?: string;
  /** Hold events this long to put out-of-order async hooks back in order. 0 = process at once. Default 100. */
  reorderMs?: number;
  /** Poll interval of the transcript tool_result fallback. 0 = off. Default 2000. */
  transcriptPollMs?: number;
  /** Look up the session's tty with `ps` when no source has set it yet. Default true. */
  resolveTty?: boolean;
  /** Blocking hooks held open at once; beyond this the hook gets "no decision" at once. Default 256. */
  maxBlocking?: number;
  /** Debounce for asking the session source to rescan after a SessionStart for an unknown session. Default 300. */
  scanDelayMs?: number;
  /**
   * Plan cards offer "Yes, and use auto mode" once the session ran in auto
   * mode. Default HOOK_PLAN_AUTO (off until spike SP8's hook half passes).
   */
  planAuto?: boolean;
}

interface Incoming {
  payload: HookPayload;
  /** Set for a blocking PermissionRequest that is waiting for a reply. */
  conn?: HookConn;
  key: OrderKey;
}

interface CardRec {
  card: PendingRequest;
  /** Claude's original tool_input (the card carries a display copy). */
  input: unknown;
  suggestions: unknown[];
  questions?: Question[];
  conn?: HookConn;
  key: OrderKey;
  toolUseId?: string;
  agentId?: string;
  account?: number;
}

interface SessState {
  lastPromptKey?: OrderKey;
  subagents: number;
  ttyTried: boolean;
  configDir?: string;
  /**
   * A main-conversation payload carried `permission_mode: "auto"`: the
   * account may use auto mode, so plan cards offer it as Claude does (only
   * while `planAuto` is on).
   */
  autoSeen?: boolean;
}

interface SessionChange {
  obs?: StatusObservation;
  patch?: SessionPatch;
  unset?: SessionOptionalKey[];
}

interface Deferred {
  obs?: StatusObservation;
  patch: SessionPatch;
  unset: Set<SessionOptionalKey>;
}

const LIVE: ReadonlySet<PendingState> = new Set<PendingState>(['open', 'decided']);
const TOOL_USE_CACHE = 5000;
const FINISHED_CACHE = 500;
const DEFERRED_CAP = 256;
const SESS_CAP = 2000;
const SEEN_CAP = 10_000;

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}

function isControlDevice(actor: Actor): boolean {
  return actor.kind === 'device' && actor.scopes.includes('control');
}

export class HooksBridgeImpl implements HooksBridge {
  readonly socketPath: string;

  private readonly log;
  private readonly buffer: ReorderBuffer<Incoming>;
  private readonly watcher: ToolResultWatcher;
  private readonly resolveTty: boolean;
  private readonly maxBlocking: number;
  private readonly scanDelayMs: number;
  private readonly planAuto: boolean;

  private server: HookSocketServer | undefined;
  private unsubStore: Unsubscribe | undefined;
  private scanTimer: TimerId | undefined;
  private running = false;
  private stopped = false;
  private arrival = 0;
  private liveBlocking = 0;

  private readonly cards = new Map<string, CardRec>();
  private readonly finished = new Map<string, PendingRequest>();
  /** tool_use_id -> correlation key, from PreToolUse. */
  private readonly toolUse = new Map<string, { sid: string; key: string; agentId?: string }>();
  /** correlation key -> tool_use_id of a call that has not completed yet. */
  private readonly inflightByKey = new Map<string, string>();
  private readonly sess = new Map<string, SessState>();
  private readonly deferred = new Map<string, Deferred>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(p: HookPayload) => void>();

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: HooksBridgeDeps,
    opts: HooksBridgeOptions = {},
  ) {
    this.socketPath = opts.socketPath ?? ctx.paths.hooksSock;
    this.log = ctx.log.child({ module: 'hooks' });
    this.resolveTty = opts.resolveTty ?? true;
    this.maxBlocking = opts.maxBlocking ?? 256;
    this.scanDelayMs = opts.scanDelayMs ?? 300;
    this.planAuto = opts.planAuto ?? HOOK_PLAN_AUTO;
    this.buffer = new ReorderBuffer<Incoming>(ctx.clock, opts.reorderMs ?? 100, (inc) => this.handle(inc), this.log);
    this.watcher = new ToolResultWatcher({
      clock: ctx.clock,
      transcripts: deps.transcripts,
      log: this.log,
      pollMs: opts.transcriptPollMs ?? 2000,
      onToolResult: (id) => {
        const rec = this.cards.get(id);
        if (rec && rec.card.state === 'open') this.finish(rec, 'closed', 'tool-result');
      },
    });
  }

  // -------------------------------------------------------------------------
  // Service

  async start(): Promise<void> {
    if (this.running) return;
    this.stopped = false;
    this.watcher.resume();
    this.unsubStore = this.ctx.store.subscribe((ev) => this.onStoreEvent(ev));
    try {
      this.server = await listenHookSocket({
        path: this.socketPath,
        log: this.log,
        // v0.6, a Windows pipe: the key the hook client checks the pipe's owner with (ignored on a Unix socket).
        keyFile: join(this.ctx.paths.runDir, HOOKS_KEY_FILE),
        onLine: (conn, line) => this.onLine(conn, line),
      });
    } catch (e) {
      this.unsubStore();
      this.unsubStore = undefined;
      throw e;
    }
    this.running = true;
    this.log.info('hooks socket listening', { path: this.socketPath });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // Process what already arrived, then let every waiting hook go with
    // "no decision" so Claude's own dialog stays in charge.
    this.buffer.flushAll();
    this.stopped = true;
    for (const rec of [...this.cards.values()]) this.finish(rec, 'closed', 'daemon-stopped');
    this.watcher.stop();
    this.ctx.clock.clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.unsubStore?.();
    this.unsubStore = undefined;
    await this.server?.close();
    this.server = undefined;
  }

  // -------------------------------------------------------------------------
  // HooksBridge

  open(): PendingRequest[] {
    return [...this.cards.values()]
      .map((r) => r.card)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): PendingRequest | undefined {
    const live = this.cards.get(id);
    if (live) return live.card;
    const done = this.finished.get(id);
    if (done) return done;
    try {
      return this.ctx.db.pending.get(id) ?? undefined;
    } catch {
      return undefined;
    }
  }

  onHookEvent(fn: (payload: HookPayload) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  hasHooks(sid: string): boolean {
    return this.seen.has(sid);
  }

  async decide(id: string, decision: DecisionBody, actor: Actor): Promise<DecideResult> {
    const refuse = (code: Exclude<DecideResult, { ok: true }>['code'], message: string, rec?: CardRec): DecideResult => {
      this.audit(actor, 'pending.decide', id, { code, ...(rec ? this.auditCardParams(rec) : {}) }, 'refused', message);
      return { ok: false, code, message };
    };

    // Unprivileged callers learn nothing about which cards exist.
    if (!isControlDevice(actor)) return refuse('forbidden', 'only a paired device with the control scope can answer a card');

    const rec = this.cards.get(id);
    if (!rec) {
      if (this.get(id)) return refuse('conflict', 'this card is already closed');
      return refuse('not_found', 'no such card');
    }
    const parsed = DecisionBodySchema.safeParse(decision);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refuse('invalid_request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid decision', rec);
    }
    if (rec.card.state !== 'open') return refuse('conflict', `this card is already ${rec.card.state}`, rec);
    if (rec.card.kind === 'subagent-info') {
      return refuse('conflict', 'a subagent request is answered from the dialog in the app, or at the Mac', rec);
    }
    if (!rec.conn || !rec.conn.alive) {
      this.finish(rec, 'handled-in-terminal', 'hook-closed');
      return refuse('conflict', 'this request was already answered in the terminal', rec);
    }

    const built = buildDecision(
      {
        kind: rec.card.kind,
        tool: rec.card.tool,
        input: rec.input,
        suggestions: rec.suggestions,
        ...(rec.questions ? { questions: rec.questions } : {}),
        ...(rec.card.planModes ? { planModes: rec.card.planModes } : {}),
      },
      parsed.data,
    );
    if (!built.ok) return refuse(built.code, built.message, rec);

    if (!rec.conn.reply(replyLine(built.output))) {
      this.finish(rec, 'handled-in-terminal', 'hook-closed');
      return refuse('conflict', 'this request was already answered in the terminal', rec);
    }

    const by = actorId(actor);
    rec.card = { ...rec.card, state: 'decided', decidedBy: by, decision: built.record };
    this.emit({
      type: 'pending.resolved',
      sid: rec.card.sid,
      ...(rec.account !== undefined ? { account: rec.account } : {}),
      data: { id, state: 'decided', decidedBy: by, decision: built.record },
    });
    this.record(rec.card);
    this.audit(actor, 'pending.decide', id, { ...this.auditCardParams(rec), ...redactedDecision(built.record) }, 'ok');

    // The session moves on: Claude runs the tool (or carries on after a deny),
    // unless the deny also interrupted the turn.
    if (!this.hasOpenMainCard(rec.card.sid)) {
      const status = built.record.behavior === 'deny' && built.record.interrupt ? 'idle' : 'working';
      this.patchSession(rec.card.sid, { obs: { status, source: 'hook', at: this.afterCard(rec) } });
    }
    return { ok: true, pending: rec.card };
  }

  // -------------------------------------------------------------------------
  // Socket input

  private onLine(conn: HookConn, line: string): void {
    if (this.stopped || !this.running) {
      conn.destroy();
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.log.debug('hooks: dropped a line that is not JSON');
      conn.destroy();
      return;
    }
    const r = HookPayloadSchema.safeParse(json);
    if (!r.success) {
      const issue = r.error.issues[0];
      this.log.debug('hooks: dropped a line that is not a hook event', { path: issue?.path.join('.') });
      conn.destroy();
      return;
    }
    const payload = r.data;
    const tag = payload._jantar;
    let hold: HookConn | undefined;
    if (tag.wait && !isSubagentPayload(payload)) {
      if (payload.hook_event_name === 'PermissionRequest' && this.liveBlocking < this.maxBlocking && this.interactive(payload.session_id)) {
        hold = conn;
        this.liveBlocking += 1;
        conn.onGone(() => {
          this.liveBlocking -= 1;
        });
      } else {
        conn.reply(replyLine(null));
      }
    } else {
      conn.close();
    }
    const key: OrderKey = { ts: tag.ts, seq: ++this.arrival };
    const mono = parseMono(tag.mono);
    if (mono !== undefined) key.mono = mono;
    this.buffer.push(hold ? { payload, conn: hold, key } : { payload, key }, key);
  }

  // -------------------------------------------------------------------------
  // Event handling (in client-timestamp order)

  private handle(inc: Incoming): void {
    if (this.stopped) {
      inc.conn?.reply(replyLine(null));
      return;
    }
    const p = inc.payload;
    const sid = p.session_id;
    const at = p._jantar.ts;
    const subagent = isSubagentPayload(p);
    this.markSeen(sid);
    const st = this.sessState(sid);
    if (p._jantar.claudeConfigDir) st.configDir = p._jantar.claudeConfigDir;

    const patch: SessionPatch = {};
    if (!subagent && p.permission_mode) patch.mode = p.permission_mode;
    if (!subagent && p.permission_mode === 'auto') st.autoSeen = true;
    if (!subagent && p.transcript_path) patch.transcriptPath = p.transcript_path;
    const after: EventInput[] = [];
    let status: HookStatus | null = statusForEvent(p);
    const stale = st.lastPromptKey !== undefined && compareKeys(inc.key, st.lastPromptKey) < 0;

    switch (p.hook_event_name) {
      case 'SessionStart':
        st.subagents = 0;
        patch.subagentsRunning = 0;
        this.maybeScan(sid);
        break;
      case 'UserPromptSubmit':
        this.closeSessionCards(sid, inc.key, 'user-prompt');
        if (!stale) st.lastPromptKey = inc.key;
        break;
      case 'PreToolUse':
        this.rememberToolUse(inc);
        if (p.tool_name) patch.now = { kind: 'tool', tool: p.tool_name, text: toolSummary(p.tool_name, p.tool_input) };
        break;
      case 'PermissionRequest':
        status = this.openCard(inc, after);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.settleByTool(inc, 'post');
        if (p.tool_use_id) this.completeToolUse(p.tool_use_id);
        break;
      case 'PermissionDenied':
        this.settleByTool(inc, 'denied');
        if (p.tool_use_id) this.completeToolUse(p.tool_use_id);
        break;
      case 'Stop': {
        this.closeSessionCards(sid, inc.key, 'stop');
        if (!stale && !subagent) {
          const text = p.last_assistant_message;
          const lastReply = typeof text === 'string' && text.length > 0 ? { text, at: this.ctx.clock.iso(at) } : undefined;
          if (lastReply) patch.lastReply = lastReply;
          after.push({ type: 'session.done', sid, data: lastReply ? { lastReply } : {} });
        }
        break;
      }
      case 'StopFailure': {
        this.closeSessionCards(sid, inc.key, 'stop-failure');
        const err = errorText(p.error);
        if (err && !stale) patch.errorLast = err;
        break;
      }
      case 'SessionEnd':
        this.closeSessionCards(sid, inc.key, 'session-end');
        delete st.autoSeen;
        break;
      case 'SubagentStart':
        st.subagents += 1;
        patch.subagentsRunning = st.subagents;
        break;
      case 'SubagentStop':
        st.subagents = Math.max(0, st.subagents - 1);
        patch.subagentsRunning = st.subagents;
        if (typeof p.agent_id === 'string') this.closeAgentCards(sid, p.agent_id, inc.key);
        break;
      case 'Notification':
        if (notificationKind(p) === 'permission' && !stale && !this.hasOpenMainCard(sid)) {
          // No card to answer (e.g. a subagent's dialog): still tell the user.
          after.push({ type: 'session.waiting', sid, data: { waitingFor: 'permission' } });
        }
        break;
      default:
        break;
    }

    // While a main-conversation card is open the session is waiting for the
    // human; other activity (parallel tools, subagents) does not hide that.
    if (status && status.status !== 'waiting' && status.status !== 'ended' && this.hasOpenMainCard(sid)) status = null;
    // An event older than the latest prompt cannot change the status again
    // (a card that is really open, i.e. its hook is still connected, can).
    if (status && stale && status.status !== 'ended' && p.hook_event_name !== 'PermissionRequest') status = null;
    // A SessionEnd older than the session's latest status comes from a process
    // that is gone: the session lives on in another one (resumed elsewhere).
    if (status?.status === 'ended') {
      const s = localSession(this.ctx.store.getState(), sid);
      if (s && s.status !== 'ended' && at < Date.parse(s.statusAt ?? s.statusSince)) status = null;
    }

    const change: SessionChange = { patch };
    if (status) {
      const obs: StatusObservation = { status: status.status, source: 'hook', at };
      if (status.waitingFor) obs.waitingFor = status.waitingFor;
      change.obs = obs;
    }
    this.patchSession(sid, change);
    const account = this.accountFor(sid);
    for (const ev of after) this.emit(account !== undefined ? ({ ...ev, account } as EventInput) : ev);

    if (p.hook_event_name === 'SessionEnd') this.deferred.delete(sid);
    this.maybeResolveTty(sid);

    for (const fn of [...this.listeners]) {
      try {
        fn(p);
      } catch (e) {
        this.log.error('hooks: event listener threw', { error: String(e) });
      }
    }
  }

  private openCard(inc: Incoming, after: EventInput[]): HookStatus | null {
    const p = inc.payload;
    const sid = p.session_id;
    const tool = p.tool_name ?? 'unknown';
    const input: unknown = p.tool_input ?? {};
    const subagent = isSubagentPayload(p);
    const kind = subagent ? 'subagent-info' : kindForTool(tool);
    const questions = kind === 'question' ? parseQuestions(input) : undefined;

    if (!subagent) {
      if (!inc.conn) {
        // Not registered as blocking (or too many waiting): nobody can answer
        // from here, but the session is waiting for the person at the Mac.
        after.push({ type: 'session.waiting', sid, data: { waitingFor: kind } });
        return { status: 'waiting', waitingFor: kind };
      }
      if (!inc.conn.alive) {
        this.log.debug('hooks: permission request settled before it was processed', { sid, tool });
        return null;
      }
      if ((kind === 'question' && !questions) || (kind === 'plan' && !isPlainObject(input))) {
        // A card could not show (or answer) this, and while it is open the
        // screen path stays shut: let Claude's own dialog take it at once.
        inc.conn.reply(replyLine(null));
        after.push({ type: 'session.waiting', sid, data: { waitingFor: kind } });
        return { status: 'waiting', waitingFor: kind };
      }
    }

    const now = this.ctx.clock.now();
    const key = cardKey(sid, tool, input);
    const settleMs = this.ctx.settings.get().notify.settle_ms;
    const suggestions = !subagent && Array.isArray(p.permission_suggestions) ? [...p.permission_suggestions] : [];
    const card: PendingRequest = {
      id: newSecretId(),
      sid,
      kind,
      tool,
      input: displayCopy(input),
      suggestions: displayCopy(suggestions) as unknown[],
      correlationKey: key,
      createdAt: this.ctx.clock.iso(now),
      settleUntil: this.ctx.clock.iso(now + settleMs),
      state: 'open',
    };
    if (questions) card.questions = displayCopy(questions) as Question[];
    if (kind === 'plan') card.planModes = [...(this.planAuto && this.sessState(sid).autoSeen ? AUTO_PLAN_MODES : DEFAULT_PLAN_MODES)];
    if (subagent) card.agentId = p.agent_id as string;

    const rec: CardRec = { card, input, suggestions, key: inc.key };
    if (questions) rec.questions = questions;
    if (inc.conn) rec.conn = inc.conn;
    if (subagent) rec.agentId = p.agent_id as string;
    const account = this.accountFor(sid);
    if (account !== undefined) rec.account = account;
    const inflight = this.inflightByKey.get(key);
    if (inflight) {
      const tu = this.toolUse.get(inflight);
      if (tu && (tu.agentId ?? '') === (rec.agentId ?? '')) rec.toolUseId = inflight;
    }

    this.cards.set(card.id, rec);
    this.emit({
      type: 'pending.opened',
      sid,
      ...(account !== undefined ? { account } : {}),
      data: { pending: card },
    });
    this.record(card);
    rec.conn?.onGone(() => this.onConnGone(card.id));

    if (subagent) return null;
    if (p.transcript_path) void this.watcher.watch(card.id, sid, key, p.transcript_path, rec.toolUseId);
    after.push({ type: 'session.waiting', sid, data: { waitingFor: kind, pendingId: card.id } });
    return { status: 'waiting', waitingFor: kind };
  }

  private onConnGone(id: string): void {
    const rec = this.cards.get(id);
    if (!rec || rec.card.state !== 'open' || this.stopped) return;
    this.finish(rec, 'handled-in-terminal', 'hook-closed');
    if (!this.hasOpenMainCard(rec.card.sid)) {
      // Answered at the Mac: Claude carries on (a newer session-file or hook
      // observation corrects this if the turn was interrupted instead).
      this.patchSession(rec.card.sid, { obs: { status: 'working', source: 'hook', at: this.afterCard(rec) } });
    }
  }

  /** PostToolUse / PostToolUseFailure / PermissionDenied: find the card of this call. */
  private settleByTool(inc: Incoming, mode: 'post' | 'denied'): void {
    const p = inc.payload;
    const sid = p.session_id;
    const tool = p.tool_name;
    if (!tool) return;
    const keys = new Set<string>([cardKey(sid, tool, p.tool_input ?? {})]);
    if (p.tool_use_id) {
      const cached = this.toolUse.get(p.tool_use_id);
      if (cached && cached.sid === sid) keys.add(cached.key);
    }
    const agent = typeof p.agent_id === 'string' ? p.agent_id : '';
    const cands = [...this.cards.values()].filter(
      (r) =>
        r.card.sid === sid &&
        keys.has(r.card.correlationKey) &&
        (r.agentId ?? '') === agent &&
        compareKeys(r.key, inc.key) < 0 &&
        !(r.toolUseId && p.tool_use_id && r.toolUseId !== p.tool_use_id),
    );
    if (cands.length === 0) return;
    const rec =
      (p.tool_use_id ? cands.find((r) => r.toolUseId === p.tool_use_id) : undefined) ??
      cands.sort((a, b) => compareKeys(a.key, b.key))[0];
    if (!rec) return;
    if (mode === 'denied') {
      this.finish(rec, 'closed', 'permission-denied');
    } else if (rec.card.state === 'decided' && (rec.card.decision as { behavior?: string } | undefined)?.behavior === 'deny') {
      // The tool ran although our reply denied it: the terminal answered first and Claude dropped the reply.
      this.finish(rec, 'handled-in-terminal', 'deny-too-late');
    } else if (rec.card.state === 'decided') {
      this.finish(rec, 'confirmed', p.hook_event_name === 'PostToolUseFailure' ? 'post-tool-use-failure' : 'post-tool-use');
    } else {
      this.finish(rec, 'handled-in-terminal', 'post-tool-use');
    }
  }

  private closeSessionCards(sid: string, key: OrderKey, reason: string): void {
    for (const rec of [...this.cards.values()]) {
      if (rec.card.sid === sid && compareKeys(rec.key, key) < 0) this.finish(rec, 'closed', reason);
    }
  }

  private closeAgentCards(sid: string, agentId: string, key: OrderKey): void {
    for (const rec of [...this.cards.values()]) {
      if (rec.card.sid === sid && rec.agentId === agentId && compareKeys(rec.key, key) < 0) {
        this.finish(rec, 'closed', 'subagent-stop');
      }
    }
  }

  private finish(rec: CardRec, state: Exclude<PendingState, 'open' | 'decided'>, reason: string): void {
    const prev = rec.card;
    if (!LIVE.has(prev.state)) return;
    const card: PendingRequest = { ...prev, state, closedAt: this.ctx.clock.iso(), closeReason: reason };
    rec.card = card;
    this.cards.delete(card.id);
    lruSet(this.finished, card.id, card, FINISHED_CACHE);
    // A hook still waiting gets "no decision": Claude's own flow continues.
    if (rec.conn?.alive) rec.conn.reply(replyLine(null));
    this.watcher.unwatch(card.id);
    this.emit({
      type: 'pending.resolved',
      sid: card.sid,
      ...(rec.account !== undefined ? { account: rec.account } : {}),
      data: {
        id: card.id,
        state,
        ...(card.decidedBy !== undefined ? { decidedBy: card.decidedBy } : {}),
        ...(card.decision !== undefined ? { decision: card.decision } : {}),
        reason,
      },
    });
    this.record(card);
    if (state === 'confirmed') {
      this.auditRaw(card.decidedBy ?? 'system', 'pending.confirmed', card.id, this.auditCardParams(rec), 'ok', reason);
    } else if (reason === 'deny-too-late') {
      this.auditRaw(
        card.decidedBy ?? 'system',
        'pending.superseded',
        card.id,
        this.auditCardParams(rec),
        'failed',
        'the deny arrived after the request was allowed in the terminal; the tool ran',
      );
    }
  }

  /**
   * Observation time for something that happened to a card (a decision, an
   * EOF): now, but never before the request itself, so it supersedes the
   * "waiting" the request caused even if clocks disagree by a little.
   */
  private afterCard(rec: CardRec): number {
    return Math.max(this.ctx.clock.now(), rec.key.ts + 1);
  }

  private hasOpenMainCard(sid: string): boolean {
    for (const r of this.cards.values()) {
      if (r.card.sid === sid && r.card.state === 'open' && r.card.kind !== 'subagent-info') return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Tool-use cache (PreToolUse -> correlation key)

  private rememberToolUse(inc: Incoming): void {
    const p = inc.payload;
    if (!p.tool_use_id || !p.tool_name) return;
    const sid = p.session_id;
    const key = cardKey(sid, p.tool_name, p.tool_input ?? {});
    const entry: { sid: string; key: string; agentId?: string } = { sid, key };
    if (typeof p.agent_id === 'string' && p.agent_id) entry.agentId = p.agent_id;
    lruSet(this.toolUse, p.tool_use_id, entry, TOOL_USE_CACHE);
    lruSet(this.inflightByKey, key, p.tool_use_id, TOOL_USE_CACHE);
    // A card opened before this (late) PreToolUse arrived: attach the id.
    for (const rec of this.cards.values()) {
      if (
        rec.card.sid === sid &&
        rec.card.correlationKey === key &&
        !rec.toolUseId &&
        (rec.agentId ?? '') === (entry.agentId ?? '') &&
        compareKeys(inc.key, rec.key) < 0
      ) {
        rec.toolUseId = p.tool_use_id;
        this.watcher.addToolUseId(rec.card.id, p.tool_use_id);
      }
    }
  }

  private completeToolUse(toolUseId: string): void {
    const entry = this.toolUse.get(toolUseId);
    if (!entry) return;
    this.toolUse.delete(toolUseId);
    if (this.inflightByKey.get(entry.key) === toolUseId) this.inflightByKey.delete(entry.key);
  }

  // -------------------------------------------------------------------------
  // Sessions

  private markSeen(sid: string): void {
    this.seen.delete(sid);
    this.seen.add(sid);
    if (this.seen.size > SEEN_CAP) {
      const first = this.seen.values().next();
      if (!first.done) this.seen.delete(first.value);
    }
  }

  private sessState(sid: string): SessState {
    let st = this.sess.get(sid);
    if (!st) {
      st = { subagents: 0, ttyTried: false };
      lruSet(this.sess, sid, st, SESS_CAP);
    }
    return st;
  }

  private accountFor(sid: string): number | undefined {
    const s = localSession(this.ctx.store.getState(), sid);
    if (s && s.account !== null) return s.account;
    const dir = this.sess.get(sid)?.configDir ?? this.ctx.paths.claudeHome;
    try {
      return this.deps.sessions.accountForConfigDir(dir) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Apply a change to a known session, or keep it until the session appears. */
  private patchSession(sid: string, change: SessionChange): void {
    const s = localSession(this.ctx.store.getState(), sid);
    if (!s) {
      this.defer(sid, change);
      return;
    }
    const patch: SessionPatch = {};
    const unset = new Set<SessionOptionalKey>();
    for (const [k, v] of Object.entries(change.patch ?? {}) as [keyof SessionPatch, unknown][]) {
      if (v === undefined) continue;
      if (k === 'lastReply') {
        const cur = s.lastReply;
        const next = v as { at: string };
        if (cur && Date.parse(cur.at) > Date.parse(next.at)) continue;
      }
      if (canonicalJson((s as Record<string, unknown>)[k]) !== canonicalJson(v)) {
        (patch as Record<string, unknown>)[k] = v;
      }
    }
    for (const k of change.unset ?? []) if ((s as Partial<Session>)[k] !== undefined) unset.add(k);
    if (change.obs) {
      const m = mergeStatus(s, change.obs);
      if (m) {
        Object.assign(patch, m.patch);
        for (const k of m.unset) unset.add(k);
      }
    }
    if (Object.keys(patch).length === 0 && unset.size === 0) return;
    this.emit({
      type: 'session.updated',
      sid,
      data: unset.size > 0 ? { patch, unset: [...unset] } : { patch },
    });
  }

  private defer(sid: string, change: SessionChange): void {
    let d = this.deferred.get(sid);
    if (!d) {
      d = { patch: {}, unset: new Set() };
      lruSet(this.deferred, sid, d, DEFERRED_CAP);
    }
    if (change.obs && (!d.obs || change.obs.at >= d.obs.at || change.obs.status === 'ended')) {
      if (d.obs?.status !== 'ended') d.obs = change.obs;
    }
    for (const [k, v] of Object.entries(change.patch ?? {})) {
      if (v !== undefined) (d.patch as Record<string, unknown>)[k] = v;
    }
    for (const k of change.unset ?? []) d.unset.add(k);
  }

  private onStoreEvent(ev: DaemonEvent): void {
    if (this.stopped || !ev.sid) return;
    // v0.6: a paired server's sessions have their own bridge, there.
    if (ev.type === 'session.added' && ev.data.session.node !== undefined) return;
    if (ev.type === 'session.added') {
      const d = this.deferred.get(ev.sid);
      if (d) {
        this.deferred.delete(ev.sid);
        const change: SessionChange = { patch: d.patch, unset: [...d.unset] };
        if (d.obs) change.obs = d.obs;
        this.patchSession(ev.sid, change);
      }
      if (this.seen.has(ev.sid)) this.maybeResolveTty(ev.sid);
    } else if (ev.type === 'session.removed') {
      for (const rec of [...this.cards.values()]) {
        if (rec.card.sid === ev.sid) this.finish(rec, 'closed', 'session-removed');
      }
      this.deferred.delete(ev.sid);
    } else if (ev.type === 'session.updated') {
      this.onSessionFileStatus(ev.sid, ev.data.patch);
    }
  }

  /**
   * Claude's session file left "waiting" after a card opened: the request was
   * answered at the Mac. Claude keeps the PermissionRequest hook connected
   * until the tool finishes, so the EOF would come too late: until then the
   * card would still take a decision, keep the session "waiting" and be
   * pushed as needing approval.
   */
  private onSessionFileStatus(sid: string, patch: SessionPatch): void {
    if (patch.statusSource !== 'session-file' || !patch.status || !patch.statusAt) return;
    if (patch.status === 'waiting' || patch.status === 'ended') return;
    const at = Date.parse(patch.statusAt);
    if (Number.isNaN(at)) return;
    for (const rec of [...this.cards.values()]) {
      if (rec.card.sid !== sid || rec.card.state !== 'open' || rec.card.kind === 'subagent-info') continue;
      if (at > rec.key.ts) this.finish(rec, 'handled-in-terminal', 'session-moved-on');
    }
  }

  /**
   * Only a live interactive terminal session ("cli") is worth holding: Claude shows its own dialog there and the
   * first answer wins. Headless runs (`claude -p`, the SDK) await the hook, so holding one would stall it until
   * the phone answers; discovery drops them, so a session the store doesn't know gets "no decision" at once.
   */
  private interactive(sid: string): boolean {
    const s = localSession(this.ctx.store.getState(), sid);
    return s !== undefined && s.entrypoint === 'cli' && s.status !== 'ended';
  }

  private maybeScan(sid: string): void {
    if (localSession(this.ctx.store.getState(), sid) || this.scanTimer !== undefined) return;
    this.scanTimer = this.ctx.clock.setTimeout(() => {
      this.scanTimer = undefined;
      if (this.stopped) return;
      try {
        this.deps.sessions.scan().catch((e: unknown) => this.log.debug('hooks: session rescan failed', { error: String(e) }));
      } catch (e) {
        this.log.debug('hooks: session rescan failed', { error: String(e) });
      }
    }, this.scanDelayMs);
  }

  private maybeResolveTty(sid: string): void {
    if (!this.resolveTty) return;
    const st = this.sess.get(sid);
    const s = localSession(this.ctx.store.getState(), sid);
    if (!st || st.ttyTried || !s || s.tty || s.status === 'ended' || !(s.pid > 0)) return;
    st.ttyTried = true;
    void this.lookupTty(sid, s.pid);
  }

  private async lookupTty(sid: string, pid: number): Promise<void> {
    const r = await this.ctx.exec(this.ctx.bins.ps, ['-o', 'tty=', '-p', String(pid)], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
      timeoutMs: 3000,
    });
    if (this.stopped || r.code !== 0) return;
    const tty = r.stdout.trim();
    if (!/^[A-Za-z0-9._/-]{1,64}$/.test(tty) || tty === '??' || tty === '-') return;
    const s = localSession(this.ctx.store.getState(), sid);
    if (!s || s.tty || s.pid !== pid) return;
    this.patchSession(sid, { patch: { tty } });
  }

  // -------------------------------------------------------------------------
  // Persistence and audit

  private emit(input: EventInput): void {
    this.ctx.store.emit(input);
  }

  private record(card: PendingRequest): void {
    try {
      this.ctx.db.pending.record(card);
    } catch (e) {
      this.log.warn('hooks: could not store card history', { error: String(e) });
    }
  }

  private auditCardParams(rec: CardRec): Record<string, unknown> {
    return { sid: rec.card.sid, kind: rec.card.kind, tool: rec.card.tool };
  }

  private audit(
    actor: Actor,
    action: string,
    target: string,
    params: Record<string, unknown>,
    result: 'ok' | 'refused' | 'failed',
    detail?: string,
  ): void {
    this.auditRaw(actorId(actor), action, target, params, result, detail);
  }

  private auditRaw(
    actor: string,
    action: string,
    target: string,
    params: Record<string, unknown>,
    result: 'ok' | 'refused' | 'failed',
    detail?: string,
  ): void {
    try {
      this.ctx.db.audit.append({
        ts: this.ctx.clock.iso(),
        actor,
        action,
        target,
        params,
        result,
        ...(detail ? { detail } : {}),
      });
    } catch (e) {
      this.log.warn('hooks: could not write the audit log', { error: String(e) });
    }
  }
}

export function createHooksBridgeImpl(ctx: DaemonContext, deps: HooksBridgeDeps, opts?: HooksBridgeOptions): HooksBridgeImpl {
  return new HooksBridgeImpl(ctx, deps, opts);
}
