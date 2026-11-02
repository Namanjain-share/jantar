/**
 * The Chat part (spec 0.10 B3, B6, B11.4): one thread per Mac in chat.db,
 * one headless Claude run at a time with Jantar's tools over one strict MCP
 * server, and the phone's taps.
 *
 * The thread: shared by every control device and the Siri key; turns,
 * their changes (with the Undo journal) and cards live in chat.db, kept
 * `ask.keepDays` (sweep at start and every hour, whatever the switch).
 * chat.db is refused, never reset: while broken Chat answers 503 with
 * CHAT_BROKEN_REASON until `jantar chat clear --broken` moves it aside.
 *
 * The queue: `queued -> running -> done | failed | cancelled`, at most
 * CHAT_QUEUE_MAX unfinished, one run at a time daemon-wide, oldest first;
 * `kick()` never runs inside the caller's request; an epoch and `live()`
 * drop a run that ends after Cancel, Clear, the switch turning off or
 * stop(). A turn left unfinished by a restart is marked failed at start.
 *
 * The run (B6): the shared runner (rewrite/run.ts) in tools mode, on the
 * account rewrite/pick.ts picks (never a kept or held one; `claude -p` on
 * one login), Rewrite's model at low effort for the phone and
 * `ask.voiceModel` for Siri; a run dir <chatDir>/run/<rid> (0700) with the
 * prompt copy, an empty work/ cwd and mcp.json (0600) naming the bridge
 * (assets/chat/bridge.mjs) with the per-run socket and token; the
 * dispatcher (dispatcher.ts) holds every tool call until the run's init
 * line shows exactly the one server and this turn's tools, and the same
 * check runs on the whole stdout at the end (a failure there undoes every
 * change of the turn). The run dir and socket go in a `finally`.
 *
 * The fast path (v0.8's, moved from Ask): while reading links is on, a
 * message that is only a link, or "save this: <link>", saves it at once
 * with Undo and runs no Claude.
 *
 * No text anywhere but the thread: events are `life.changed {}`; one
 * `chat.run` audit row per run with ids and counts; logs carry codes.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dayKeyOf, hhmmOf, isValidTimeZone } from '@jantar/life-core';
import {
  CHAT_PAGE,
  CHAT_PHOTOS_MAX,
  CHAT_QUEUE_MAX,
  CHAT_TEXT_MAX,
  CHAT_TURNS_MAX,
  CHAT_UNDO_WITHIN_MS,
  CHAT_VOICE_TEXT_MAX,
  type AccountId,
  type ChatList,
  type ChatStatus,
  type RewriteModel,
} from '@jantar/protocol';
import type { Actor, ChatService, DaemonContext, LifeResult, Logger, TimerId, Unsubscribe } from '../contracts.js';
import { actorId } from '../core/actor.js';
import { newId } from '../core/ids.js';
import { sendLifePush } from '../life/push.js';
import { pickSharedRunAccount, runVia } from '../rewrite/pick.js';
import { DROPPABLE_OPTIONS, execRewrite, initOfLine, initProblem, lineSplitter, prepareRunDir, runDroppingRefused, type RunOutcome } from '../rewrite/run.js';
import { applyWrite, undoJournal, type Journal } from './actions.js';
import { CHAT_BROKEN_REASON, openChatDb } from './db.js';
import { Dispatcher } from './dispatcher.js';
import { saveFastPath } from './fast.js';
import { chatStdin, CHAT_HISTORY_TURNS, type HistoryTurn } from './input.js';
import { ChatPhotos } from './photos.js';
import { ChatStore, type TurnRecord } from './store.js';
import { dismissCard, runCard, undoChange } from './taps.js';
import { countSentence, replyText, speakable } from './text.js';
import { audit, partOn, recordChange, toolsFor, TurnTools } from './tools.js';
import type { ChatDeps } from './types.js';

export const CHAT_PROMPT_VERSION = 'v1';
export const CHAT_PROMPT_ASSET = `chat/chat-${CHAT_PROMPT_VERSION}.md`;
export const CHAT_BRIDGE_ASSET = 'chat/bridge.mjs';
export const CHAT_EFFORT = 'low';
/** Phone runs: 12 turns, 120 s; voice: 6 turns, 60 s. The account pick has as long again. */
export const CHAT_TIMEOUT_MS = { phone: 120_000, voice: 60_000 } as const;
export const CHAT_MAX_TURNS = { phone: 12, voice: 6 } as const;
/** Captured stdout of a chat run. */
export const CHAT_RUN_MAX_BUFFER = 4 * 1024 * 1024;
export const CHAT_SWEEP_MS = 60 * 60_000;
/** Photos never sent go after this. */
export const CHAT_UNATTACHED_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** The fixed sentences a turn, a refusal or Siri says. */
export const CHAT_SENTENCES = {
  off: 'Chat is off. Turn it on at your Mac: jantar chat on',
  readOnly: "Chat can't run while Jantar is read-only.",
  noRunner: 'Chat needs Claude Code on this Mac.',
  noAccount: 'No account has room right now. Try again in a while.',
  timeout: 'Claude took too long to answer. Try again.',
  failed: "Claude couldn't answer. Try again.",
  notIsolated: 'Chat stopped: it could not run in its safe mode on this Mac. Check it at the Mac: jantar doctor',
  cancelled: 'Cancelled.',
  restarted: 'Chat stopped when Jantar restarted. Try again.',
  busy: 'Wait for an answer, or stop one.',
  noText: 'Type a message or add a photo first.',
  tooLong: `Keep a message to ${CHAT_TEXT_MAX} characters.`,
  tooManyPhotos: `At most ${CHAT_PHOTOS_MAX} photos a message.`,
  photoGone: 'A photo is gone or already sent. Add it again.',
  noTurn: 'No such message.',
  noPhoto: 'No such photo.',
  photoSent: 'That photo was already sent.',
  done: 'Done.',
  saved: 'Saved to Intel. It is being read now.',
  // Siri
  voiceBusy: 'Jantar is busy. Try again in a minute.',
  voiceLater: 'Still working on it. The answer will be in Jantar.',
  voiceTooLong: `Keep it to ${CHAT_VOICE_TEXT_MAX} characters.`,
  pushBody: 'Your answer is in Chat.',
} as const;

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: LifeResult = { ok: true, value: true };

type AuditOutcome = 'ok' | 'unavailable' | 'no_account' | 'timeout' | 'failed' | 'cancelled' | 'stopped' | 'not_isolated' | 'flags_rejected';

interface Run {
  turnId: string;
  epoch: number;
  abort: AbortController;
  why?: 'cancelled' | 'stopped';
  done?: Promise<void>;
}

const unfinished = (t: Pick<TurnRecord, 'state'>) => t.state === 'queued' || t.state === 'running';

function errorKind(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}

function failedReason(o: AuditOutcome): string {
  switch (o) {
    case 'unavailable':
      return CHAT_SENTENCES.noRunner;
    case 'no_account':
      return CHAT_SENTENCES.noAccount;
    case 'timeout':
      return CHAT_SENTENCES.timeout;
    case 'not_isolated':
    case 'flags_rejected':
      return CHAT_SENTENCES.notIsolated;
    default:
      return CHAT_SENTENCES.failed;
  }
}

export interface ChatOptions {
  readOnly?: boolean;
}

export class ChatServiceImpl implements ChatService {
  private store: ChatStore | null = null;
  private brokenReason: string | null = null;
  private readonly photos: ChatPhotos;
  private readonly queue: string[] = [];
  private running: Run | null = null;
  private epoch = 0;
  private readonly learned = new Set<string>();
  private readonly logged = new Set<string>();
  /** Turns a Siri request waits on: called when the turn ends (or the wait is dropped). */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Voice turns whose request gave up waiting: they push "Your answer is in Chat." when done. */
  private readonly pushWhenDone = new Set<string>();
  /** Who sent each unfinished turn: its run's writes are theirs. */
  private readonly senders = new Map<string, Actor>();
  private unsubscribe: Unsubscribe | null = null;
  private sweepTimer: TimerId | undefined;
  private readonly log: Logger;
  private readonly readOnly: boolean;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: ChatDeps,
    opts: ChatOptions = {},
  ) {
    this.log = ctx.log.child({ part: 'chat' });
    this.readOnly = opts.readOnly === true;
    this.photos = new ChatPhotos(ctx);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    await this.removeAskDir();
    if (this.ctx.settings.get().ask.enabled || (await this.exists(this.ctx.paths.chatDb))) this.open();
    this.failLeftOver();
    await this.sweep();
    this.unsubscribe ??= this.ctx.settings.subscribe((next, prev) => {
      if (prev.ask.enabled && !next.ask.enabled) {
        this.stopAll('cancelled');
        this.changed();
      }
      if (!prev.ask.enabled && next.ask.enabled && !this.store) this.open();
    });
    this.sweepTimer ??= this.ctx.clock.setInterval(() => void this.sweep(), CHAT_SWEEP_MS);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx.clock.clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const run = this.running;
    this.stopAll('stopped');
    await run?.done;
    this.store?.close();
    this.store = null;
  }

  broken(): string | null {
    return this.brokenReason;
  }

  status(): ChatStatus {
    const s = this.store;
    return { turns: s?.turnCount() ?? 0, photos: s?.photoCount() ?? 0, bytes: s?.photoBytes() ?? 0, broken: this.brokenReason };
  }

  private open(): void {
    const r = openChatDb(this.ctx.paths.chatDb);
    if (r.ok) {
      this.store = new ChatStore(r.db);
      this.brokenReason = null;
    } else {
      this.store = null;
      this.brokenReason = CHAT_BROKEN_REASON;
      this.log.error('chat: chat.db would not open', { code: r.code });
    }
  }

  private async exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  /** <home>/ask only ever held Ask's prompt copy and an empty work dir: it goes when that is all it holds. */
  private async removeAskDir(): Promise<void> {
    const dir = this.ctx.paths.askDir;
    try {
      const names = await readdir(dir);
      const known = names.every((n) => n === 'work' || /^assistant-v\d+\.md$/.test(n));
      if (!known) return;
      if (names.includes('work') && (await readdir(join(dir, 'work'))).length > 0) return;
      await rm(dir, { recursive: true, force: true });
    } catch {
      // not there
    }
  }

  /** Turns a restart left queued or running: failed, with the sentence. */
  private failLeftOver(): void {
    const s = this.store;
    if (!s) return;
    for (const t of s.unfinished()) s.updateTurn(t.id, (x) => ({ ...x, state: 'failed', reason: CHAT_SENTENCES.restarted }));
  }

  /** The retention sweep (B3); photos past the store cap mark their turn's photo gone. */
  async sweep(): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const now = this.ctx.clock.now();
      const keepDays = this.ctx.settings.get().ask.keepDays;
      const r = s.sweep({
        cutoffIso: this.ctx.clock.iso(now - keepDays * DAY_MS),
        maxTurns: CHAT_TURNS_MAX,
        undoCutoffIso: this.ctx.clock.iso(now - CHAT_UNDO_WITHIN_MS),
        unattachedCutoffIso: this.ctx.clock.iso(now - CHAT_UNATTACHED_MS),
      });
      await this.photos.removeFiles(r.photos);
      const capped = await this.photos.cap(s);
      this.markGone(capped.map((p) => p.turnId).filter((x): x is string => x !== null), new Set(capped.map((p) => p.id)));
      if (r.turns > 0 || capped.length > 0) this.changed();
    } catch (e) {
      this.log.warn('chat: the sweep failed', { code: errorKind(e) });
    }
  }

  private markGone(turnIds: string[], ids: Set<string>): void {
    for (const id of new Set(turnIds)) this.store?.updateTurn(id, (t) => ({ ...t, photos: t.photos.map((p) => (ids.has(p.id) ? { ...p, gone: true } : p)) }));
  }

  // ------------------------------------------------------------------ the thread

  private notReady(): Refusal | null {
    const s = this.ctx.settings.get();
    if (!s.ask.enabled) return refuse('forbidden', CHAT_SENTENCES.off);
    if (this.brokenReason) return refuse('life_unavailable', this.brokenReason);
    if (!this.store) this.open();
    if (!this.store) return refuse('life_unavailable', this.brokenReason ?? CHAT_BROKEN_REASON);
    if (this.readOnly) return refuse('forbidden', CHAT_SENTENCES.readOnly);
    if (!runVia(this.ctx)) return refuse('conflict', CHAT_SENTENCES.noRunner);
    return null;
  }

  private needStore(): ChatStore | Refusal {
    if (this.brokenReason) return refuse('life_unavailable', this.brokenReason);
    if (!this.store) this.open();
    return this.store ?? refuse('life_unavailable', this.brokenReason ?? CHAT_BROKEN_REASON);
  }

  list(_actor: Actor, before?: string): LifeResult<ChatList> {
    const store = this.needStore();
    if ('ok' in store) return store;
    const page = store.page(before, CHAT_PAGE);
    const notReady = this.notReady();
    return {
      ok: true,
      value: {
        turns: page.turns.map((t) => store.full(t)),
        older: page.older,
        ready: notReady ? { ok: false, reason: notReady.reason } : { ok: true },
        keepDays: this.ctx.settings.get().ask.keepDays,
      },
    };
  }

  send(body: { text: string; photos?: string[] }, actor: Actor, via: 'phone' | 'voice' = 'phone'): LifeResult<{ id: string }> {
    const text = body.text.trim();
    const photoIds = [...new Set(body.photos ?? [])];
    if (!text && photoIds.length === 0) return refuse('invalid_request', CHAT_SENTENCES.noText);
    if (text.length > (via === 'voice' ? CHAT_VOICE_TEXT_MAX : CHAT_TEXT_MAX)) return refuse('invalid_request', via === 'voice' ? CHAT_SENTENCES.voiceTooLong : CHAT_SENTENCES.tooLong);
    if (photoIds.length > CHAT_PHOTOS_MAX || (via === 'voice' && photoIds.length > 0)) return refuse('invalid_request', CHAT_SENTENCES.tooManyPhotos);
    const notReady = this.notReady();
    if (notReady) return notReady;
    const store = this.store as ChatStore;
    if (store.unfinished().length >= CHAT_QUEUE_MAX) return refuse('conflict', CHAT_SENTENCES.busy);
    for (const id of photoIds) {
      const p = store.photo(id);
      // Try again: a photo of a turn that failed goes with the new message (B14); one sent and answered does not.
      if (!p || (p.turnId !== null && store.turn(p.turnId)?.state !== 'failed')) return refuse('invalid_request', CHAT_SENTENCES.photoGone);
    }
    const id = newId();
    const at = this.ctx.clock.iso();
    const fast = this.readingLinks() && photoIds.length === 0 ? saveFastPath(text) : null;
    store.tx(() => {
      const photos = store
        .attach(id, photoIds)
        .map((pid) => store.photo(pid))
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => ({ id: p.id, w: p.w, h: p.h, gone: false }));
      store.insertTurn({ id, at, via, text, photos, state: fast ? 'running' : 'queued', tainted: false, refused: 0, by: actorId(actor) });
    });
    if (fast) void this.saveFast(id, fast, actor);
    else {
      this.senders.set(id, actor);
      this.queue.push(id);
      this.kick();
    }
    this.changed();
    return { ok: true, value: { id } };
  }

  /** v0.8's fast path in Chat: the link saved at once, with Undo; no Claude. */
  private async saveFast(turnId: string, save: { url: string; depth?: string }, actor: Actor): Promise<void> {
    const store = this.store;
    if (!store) return;
    const r = await applyWrite(this.deps, 'intel_save', { url: save.url, ...(save.depth ? { depth: save.depth } : {}) }, actor);
    if (r.ok) recordChange({ ctx: this.ctx, store, turnId, actorName: actorId(actor) }, r.value);
    store.updateTurn(turnId, (t) => ({ ...t, state: r.ok ? 'done' : 'failed', ...(r.ok ? { reply: CHAT_SENTENCES.saved } : { reason: r.reason }) }));
    this.ended(turnId);
    this.changed();
  }

  private readingLinks(): boolean {
    const s = this.ctx.settings.get();
    return s.intel.enabled && s.intel.read;
  }

  cancel(id: string, _actor: Actor): LifeResult {
    const store = this.needStore();
    if ('ok' in store) return store;
    const turn = store.turn(id);
    if (!turn) return refuse('not_found', CHAT_SENTENCES.noTurn);
    if (!unfinished(turn)) return OK;
    this.halt(id);
    store.updateTurn(id, (t) => ({ ...t, state: 'cancelled', reason: CHAT_SENTENCES.cancelled }));
    this.ended(id);
    this.changed();
    return OK;
  }

  async clear(actor: Actor, opts: { broken?: boolean } = {}): Promise<LifeResult> {
    if (opts.broken) return this.moveBroken(actor);
    const store = this.needStore();
    if ('ok' in store) return store;
    const run = this.running;
    this.stopAll('cancelled');
    await run?.done;
    store.clear();
    await this.photos.removeAll();
    audit(this.ctx, actorId(actor), 'chat.clear', 'chat', {}, 'ok');
    this.changed();
    return OK;
  }

  /** `jantar chat clear --broken`: chat.db moved aside as chat.db.broken-<day>, a fresh one opened. */
  private async moveBroken(actor: Actor): Promise<LifeResult> {
    if (!this.brokenReason) return refuse('conflict', 'chat.db opens fine; nothing to move aside.');
    const day = dayKeyOf(new Date(this.ctx.clock.now()), 'UTC');
    let target = `${this.ctx.paths.chatDb}.broken-${day}`;
    for (let n = 2; await this.exists(target); n++) target = `${this.ctx.paths.chatDb}.broken-${day}-${n}`;
    try {
      await rename(this.ctx.paths.chatDb, target);
      for (const suffix of ['-wal', '-shm']) await rename(`${this.ctx.paths.chatDb}${suffix}`, `${target}${suffix}`).catch(() => {});
    } catch (e) {
      this.log.warn('chat: could not move chat.db aside', { code: errorKind(e) });
      return refuse('unavailable', 'chat.db could not be moved aside.');
    }
    this.brokenReason = null;
    this.open();
    audit(this.ctx, actorId(actor), 'chat.clear', 'chat', { broken: true }, this.store ? 'ok' : 'failed');
    this.changed();
    return this.store ? OK : refuse('life_unavailable', this.brokenReason ?? CHAT_BROKEN_REASON);
  }

  async undo(turnId: string, n: number, actor: Actor): Promise<LifeResult> {
    const store = this.needStore();
    if ('ok' in store) return store;
    return undoChange({ ctx: this.ctx, deps: this.deps, store }, turnId, n, actor, actorId(actor));
  }

  async card(turnId: string, n: number, actor: Actor): Promise<LifeResult> {
    const store = this.needStore();
    if ('ok' in store) return store;
    const r = await runCard({ ctx: this.ctx, deps: this.deps, store }, turnId, n, actor, actorId(actor));
    this.changed();
    return r;
  }

  dismiss(turnId: string, n: number, actor: Actor): LifeResult {
    const store = this.needStore();
    if ('ok' in store) return store;
    const r = dismissCard({ ctx: this.ctx, deps: this.deps, store }, turnId, n, actorId(actor));
    this.changed();
    return r;
  }

  async photoAdd(bytes: Buffer, _actor: Actor): Promise<LifeResult<{ id: string }>> {
    const notReady = this.notReady();
    if (notReady) return notReady;
    const store = this.store as ChatStore;
    const r = await this.photos.add(bytes, store);
    if (r.ok) {
      const capped = await this.photos.cap(store);
      this.markGone(capped.map((p) => p.turnId).filter((x): x is string => x !== null), new Set(capped.map((p) => p.id)));
    }
    return r;
  }

  async photo(id: string): Promise<LifeResult<{ type: string; body: Buffer }>> {
    const store = this.needStore();
    if ('ok' in store) return store;
    const p = store.photo(id);
    if (!p) return refuse('not_found', CHAT_SENTENCES.noPhoto);
    const body = await this.photos.read(p);
    return body ? { ok: true, value: { type: p.type, body } } : refuse('not_found', CHAT_SENTENCES.noPhoto);
  }

  async photoDelete(id: string, _actor: Actor): Promise<LifeResult> {
    const store = this.needStore();
    if ('ok' in store) return store;
    const p = store.photo(id);
    if (!p) return refuse('not_found', CHAT_SENTENCES.noPhoto);
    if (p.turnId !== null) return refuse('conflict', CHAT_SENTENCES.photoSent);
    store.removePhoto(id);
    await this.photos.removeFiles([p]);
    return OK;
  }

  // ------------------------------------------------------------------ Siri

  /**
   * B11.4: queue a voice turn and wait for it at most `waitMs`. Done: the
   * spoken reply and the daemon's count sentence; failed: its reason; not
   * done: "Still working on it…" and a push when it is; the queue full:
   * busy. A request that goes away does not cancel the turn.
   */
  async voice(text: string, actor: Actor, waitMs: number): Promise<{ message: string; outcome: 'answered' | 'later' | 'busy' | 'refused'; turnId?: string }> {
    const sent = this.send({ text }, actor, 'voice');
    if (!sent.ok) {
      if (sent.reason === CHAT_SENTENCES.busy) return { message: CHAT_SENTENCES.voiceBusy, outcome: 'busy' };
      return { message: sent.reason, outcome: 'refused' };
    }
    const turnId = sent.value.id;
    await this.waitFor(turnId, waitMs);
    const store = this.store;
    const turn = store?.turn(turnId);
    // What the turn is now decides, not whether the wait timed out: one that ended just after the timeout is
    // answered here (its ended() has run, so a push it waited for would never come).
    if (!turn || unfinished(turn)) {
      this.pushWhenDone.add(turnId);
      return { message: CHAT_SENTENCES.voiceLater, outcome: 'later', turnId };
    }
    if (turn.state !== 'done') return { message: turn.reason ?? CHAT_SENTENCES.failed, outcome: 'answered', turnId };
    const full = (store as ChatStore).full(turn);
    const spoken = [speakable(turn.reply ?? ''), countSentence(full.changes, full.cards)].filter(Boolean).join(' ');
    return { message: spoken.slice(0, 600) || CHAT_SENTENCES.done, outcome: 'answered', turnId };
  }

  private waitFor(turnId: string, ms: number): Promise<boolean> {
    const t = this.store?.turn(turnId);
    if (t && !unfinished(t)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: TimerId | undefined;
      const set = this.waiters.get(turnId) ?? new Set();
      const done = () => {
        this.ctx.clock.clearTimeout(timer);
        set.delete(done);
        resolve(true);
      };
      set.add(done);
      this.waiters.set(turnId, set);
      timer = this.ctx.clock.setTimeout(() => {
        set.delete(done);
        resolve(false);
      }, Math.max(0, ms));
    });
  }

  /** A turn ended: its Siri waiters hear it, and a voice turn whose request gave up pushes. */
  private ended(turnId: string): void {
    this.senders.delete(turnId);
    const set = this.waiters.get(turnId);
    this.waiters.delete(turnId);
    for (const w of [...(set ?? [])]) w();
    if (this.pushWhenDone.delete(turnId)) void this.pushAnswer();
  }

  private async pushAnswer(): Promise<void> {
    try {
      await sendLifePush(this.ctx, this.deps.notifiers, { kind: 'life', title: 'Jantar', body: CHAT_SENTENCES.pushBody, url: '/chat', tag: 'chat:answer' });
    } catch (e) {
      this.log.warn('chat: the answer push failed', { code: errorKind(e) });
    }
  }

  // ------------------------------------------------------------------ the queue and the run

  private halt(turnId: string): void {
    const at = this.queue.indexOf(turnId);
    if (at >= 0) this.queue.splice(at, 1);
    const run = this.running;
    if (run && run.turnId === turnId) {
      run.why = 'cancelled';
      run.abort.abort();
    }
  }

  /** Off, Clear or stop(): the run stopped, the queue's turns cancelled. */
  private stopAll(why: 'cancelled' | 'stopped'): void {
    this.epoch += 1;
    const store = this.store;
    for (const id of this.queue.splice(0)) {
      store?.updateTurn(id, (t) => ({ ...t, state: 'cancelled', reason: CHAT_SENTENCES.cancelled }));
      this.ended(id);
    }
    const run = this.running;
    if (run) {
      run.why ??= why;
      run.abort.abort();
      store?.updateTurn(run.turnId, (t) => (unfinished(t) ? { ...t, state: 'cancelled', reason: CHAT_SENTENCES.cancelled } : t));
      this.ended(run.turnId);
    }
  }

  private changed(): void {
    this.ctx.store.emit({ type: 'life.changed', data: {} });
  }

  private kick(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const run: Run = { turnId: next, epoch: this.epoch, abort: new AbortController() };
    this.running = run;
    run.done = Promise.resolve()
      .then(() => this.run(run))
      .catch((e: unknown) => {
        this.log.error('chat: a run failed', { error: errorKind(e) });
        this.finish(run, { failed: 'failed' });
      })
      .finally(() => {
        this.running = null;
        this.kick();
      });
  }

  /** The turn while `run` still counts: null after Cancel, Clear, the switch turning off or stop(). */
  private live(run: Run): TurnRecord | null {
    if (run.epoch !== this.epoch || run.abort.signal.aborted) return null;
    const t = this.store?.turn(run.turnId);
    return t && unfinished(t) ? t : null;
  }

  private zone(): { timezone: string; currency: string | null } {
    const s = this.ctx.settings.get().life;
    try {
      const st = this.deps.life.status();
      return { timezone: st.timezone, currency: st.currency };
    } catch {
      const tz = s.timezone && isValidTimeZone(s.timezone) ? s.timezone : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
      return { timezone: tz, currency: s.currency };
    }
  }

  private async pick(run: Run, timeoutMs: number): Promise<AccountId | null | 'cancelled' | 'timeout'> {
    const { signal } = run.abort;
    let timer: TimerId | undefined;
    let onAbort = () => {};
    const cut = new Promise<'cancelled' | 'timeout'>((resolve) => {
      onAbort = () => resolve('cancelled');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      timer = this.ctx.clock.setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      return await Promise.race([pickSharedRunAccount(this.ctx, { usage: this.deps.usage, ccwLegacy: this.deps.ccwLegacy, log: this.log }), cut]);
    } finally {
      this.ctx.clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private history(store: ChatStore, turnId: string): HistoryTurn[] {
    return store.before(turnId, CHAT_HISTORY_TURNS).map((t) => {
      const full = store.full(t);
      return { text: t.text, photos: t.photos.length, ...(t.reply ? { reply: t.reply } : {}), ...(t.reason ? { reason: t.reason } : {}), changes: full.changes, cards: full.cards };
    });
  }

  private async run(run: Run): Promise<void> {
    const { ctx } = this;
    const store = this.store;
    const queued = this.live(run);
    if (!store || !queued || queued.state !== 'queued') return;
    const via = queued.via;
    const s = ctx.settings.get();
    const model: RewriteModel = via === 'voice' ? s.ask.voiceModel : s.rewrite.model;
    const fallbackModel: RewriteModel = via === 'voice' ? 'haiku' : s.rewrite.fallbackModel;
    const timeoutMs = CHAT_TIMEOUT_MS[via];
    const base = { model, via, photos: queued.photos.length };

    const program = runVia(ctx);
    if (!program) {
      this.auditRun(run, queued, { ...base, ms: 0, account: null, outcome: 'unavailable' });
      this.finish(run, { failed: 'unavailable' });
      return;
    }
    const account = await this.pick(run, timeoutMs);
    if (!this.live(run) || account === 'cancelled') {
      this.auditRun(run, queued, { ...base, ms: 0, account: null, outcome: run.why ?? 'cancelled' });
      return;
    }
    if (account === null || account === 'timeout') {
      const outcome = account === null ? 'no_account' : 'timeout';
      this.auditRun(run, queued, { ...base, ms: 0, account: null, outcome });
      this.finish(run, { failed: outcome });
      return;
    }
    store.updateTurn(run.turnId, (t) => ({ ...t, state: 'running' }));
    this.changed();

    const single = 'claude' in program;
    const actor: Actor = this.senders.get(run.turnId) ?? { kind: 'system' };
    const list = toolsFor(s, this.deps);
    const tools = new TurnTools({ ctx, deps: this.deps, store, turnId: run.turnId, actor, actorName: queued.by, message: queued.text, tools: list, live: () => this.live(run) !== null });
    const allowed = list.map((t) => `mcp__jantar__${t.name}`);
    const rid = randomBytes(4).toString('hex');
    const runDir = join(ctx.paths.chatDir, 'run', rid);
    const sock = socketPath(ctx.paths.runDir, rid);
    const token = randomBytes(32).toString('base64url');
    let isolation: 'not_isolated' | null = null;
    const stopNotIsolated = () => {
      isolation = 'not_isolated';
      dispatcher.abort();
      run.abort.abort();
    };
    const dispatcher = new Dispatcher({ path: sock, token, tools, list, clock: ctx.clock, version: ctx.version.daemon, onFail: () => stopNotIsolated() });
    const started = ctx.clock.now();
    let outcome: RunOutcome | null = null;
    let finalInit: ReturnType<typeof initOfLine> = null;
    let sawInit = false;
    try {
      await mkdir(join(ctx.paths.chatDir, 'run'), { recursive: true, mode: 0o700 });
      await chmod(ctx.paths.chatDir, 0o700);
      await chmod(join(ctx.paths.chatDir, 'run'), 0o700);
      const dir = await prepareRunDir(ctx.paths, { dir: runDir, asset: CHAT_PROMPT_ASSET });
      const mcpConfig = join(runDir, 'mcp.json');
      const server = { type: 'stdio', command: ctx.bins.node, args: [join(ctx.paths.assetsDir, CHAT_BRIDGE_ASSET)], env: { JANTAR_CHAT_SOCK: sock, JANTAR_CHAT_TOKEN: token } };
      await writeFile(mcpConfig, JSON.stringify({ mcpServers: { jantar: server } }), { mode: 0o600 });
      await chmod(mcpConfig, 0o600);
      await mkdir(ctx.paths.runDir, { recursive: true, mode: 0o700 });
      await dispatcher.listen();

      const photoRows = store.photosOf(run.turnId);
      const photoBlocks = [];
      for (const p of photoRows) {
        const b64 = await this.photos.base64(p);
        if (b64) photoBlocks.push({ type: p.type, base64: b64 });
      }
      const now = new Date(ctx.clock.now());
      const z = this.zone();
      const on = onParts(s, this.deps);
      const input = chatStdin({
        today: dayKeyOf(now, z.timezone),
        now: hhmmOf(now, z.timezone),
        timezone: z.timezone,
        channel: via,
        on,
        tools: list.map((t) => t.name),
        currency: z.currency,
        history: this.history(store, run.turnId),
        text: queued.text,
        photos: photoBlocks,
      });
      const lines = lineSplitter((line) => {
        if (sawInit) return;
        const init = initOfLine(line);
        if (!init) return;
        sawInit = true;
        if (initProblem(init, 'jantar', allowed) !== null) stopNotIsolated();
        else dispatcher.release();
      });
      const once = (dropped: ReadonlySet<string>) =>
        execRewrite(ctx, {
          via: program,
          flags: { account: single ? null : account, model, fallbackModel, effort: CHAT_EFFORT, systemPromptFile: dir.systemPromptFile, dropped, tools: { mcpConfig, allowed, maxTurns: CHAT_MAX_TURNS[via] } },
          input: input.line,
          cwd: dir.cwd,
          timeoutMs,
          signal: run.abort.signal,
          maxBuffer: CHAT_RUN_MAX_BUFFER,
          onStdout: (chunk) => lines.push(chunk),
        });
      if (run.abort.signal.aborted) outcome = { kind: 'cancelled' };
      else {
        const r = await runDroppingRefused(once, this.learned, (option) => this.refused(option), run.abort.signal);
        outcome = r.outcome;
        finalInit = r.init ?? null;
        lines.end();
      }
    } catch (e) {
      this.log.error('chat: a run could not start', { code: errorKind(e) });
    } finally {
      await dispatcher.close().catch(() => {});
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
    }

    const ms = Math.max(0, ctx.clock.now() - started);
    // The second belt: the whole stdout's init line, checked again (a run that never printed one, too).
    if (!isolation && outcome?.kind === 'ok' && initProblem(finalInit, 'jantar', allowed) !== null) isolation = 'not_isolated';
    if (isolation) await this.undoTurn(run.turnId, actor);
    const kept = this.live(run) !== null || (isolation !== null && run.why === undefined);
    let kind: AuditOutcome;
    if (isolation) kind = 'not_isolated';
    else if (run.why) kind = run.why;
    else if (!kept) kind = 'cancelled';
    else if (!outcome) kind = 'failed';
    else if (outcome.kind === 'ok') kind = 'ok';
    else if (outcome.kind === 'flags') kind = 'flags_rejected';
    else if (outcome.kind === 'timeout' || outcome.kind === 'unavailable' || outcome.kind === 'cancelled') kind = outcome.kind;
    else kind = 'failed';
    const c = tools.counts;
    this.auditRun(run, queued, { ...base, ms, account, outcome: kind, toolCalls: c.calls, reads: c.reads, writes: c.writes, cards: c.cards, refused: c.refused, tainted: c.tainted });
    this.log.info('chat: run ended', { outcome: kind, ms, calls: c.calls, writes: c.writes, cards: c.cards, refused: c.refused });
    store.updateTurn(run.turnId, (t) => ({ ...t, tainted: c.tainted, refused: c.refused }));
    if (kind === 'ok' && outcome?.kind === 'ok') this.finish(run, { reply: outcome.result, isolationFailed: false });
    else if (kind === 'not_isolated') this.finish(run, { failed: 'not_isolated' }, true);
    else if (kind === 'failed' && outcome?.kind === 'model' && store.changes(run.turnId).length + store.cards(run.turnId).length > 0) {
      // A run that hit its turn cap after doing things still answers with what it did ("Done.").
      this.finish(run, { reply: '', isolationFailed: false });
    } else this.finish(run, { failed: kind });
  }

  /** Every change of a turn undone through its journal (the init check failed at the end). */
  private async undoTurn(turnId: string, actor: Actor): Promise<void> {
    const store = this.store;
    if (!store) return;
    for (const c of [...store.changes(turnId)].reverse()) {
      if (c.state !== 'done') continue;
      const j = store.change(turnId, c.n)?.journal;
      if (!j) continue;
      const r = await undoJournal(this.deps, j as Journal, actor);
      if (r.ok) store.setChangeState(turnId, c.n, 'undone');
    }
    for (const card of store.cards(turnId)) if (card.state === 'waiting') store.setCardState(turnId, card.n, 'expired');
  }

  private finish(run: Run, end: { reply: string; isolationFailed: boolean } | { failed: AuditOutcome }, force = false): void {
    const store = this.store;
    if (!store) return;
    const turn = store.turn(run.turnId);
    if (!turn || (!force && !this.live(run))) {
      this.ended(run.turnId);
      return;
    }
    if ('reply' in end) {
      const changes = store.changes(run.turnId).length + store.cards(run.turnId).length;
      const reply = replyText(end.reply) || (changes > 0 ? CHAT_SENTENCES.done : '');
      store.updateTurn(run.turnId, (t) => ({ ...t, state: 'done', ...(reply ? { reply } : {}) }));
    } else store.updateTurn(run.turnId, (t) => ({ ...t, state: 'failed', reason: failedReason(end.failed) }));
    this.ended(run.turnId);
    this.changed();
  }

  private refused(option: string | null): void {
    const key = option ?? '';
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log.warn('chat: claude refused an option', { option, dropped: option !== null && DROPPABLE_OPTIONS.includes(option) });
  }

  private auditRun(
    run: Run,
    turn: TurnRecord,
    r: { ms: number; account: AccountId | null; model: RewriteModel; via: string; outcome: AuditOutcome; photos: number; toolCalls?: number; reads?: number; writes?: number; cards?: number; refused?: number; tainted?: boolean },
  ): void {
    audit(
      this.ctx,
      turn.by,
      'chat.run',
      run.turnId,
      {
        turnId: run.turnId,
        via: r.via,
        ms: r.ms,
        account: r.account,
        model: r.model,
        promptVersion: CHAT_PROMPT_VERSION,
        outcome: r.outcome,
        toolCalls: r.toolCalls ?? 0,
        reads: r.reads ?? 0,
        writes: r.writes ?? 0,
        cards: r.cards ?? 0,
        refused: r.refused ?? 0,
        tainted: r.tainted ?? false,
        photos: r.photos,
      },
      r.outcome === 'ok' ? 'ok' : 'failed',
    );
  }
}

/** A Unix socket path holds at most this many bytes (macOS: 104 with its NUL). */
export const SOCKET_PATH_MAX = 103;

/**
 * The run's socket in the daemon's short run dir: `chat-<rid>.sock`, or
 * `<rid>.s` when a long state dir would push the first past the limit
 * (the run then fails to start rather than bind a cut name).
 */
export function socketPath(runDir: string, rid: string): string {
  const long = join(runDir, `chat-${rid}.sock`);
  return Buffer.byteLength(long) <= SOCKET_PATH_MAX ? long : join(runDir, `${rid}.s`);
}

/** The parts that are on, as <reach> names them. */
function onParts(s: ReturnType<DaemonContext['settings']['get']>, d: ChatDeps): string[] {
  const names: Array<[Parameters<typeof partOn>[2], string]> = [
    ['todos', 'todos and reminders'],
    ['medicines', 'medicines'],
    ['food', 'food and weight'],
    ['places', 'cafés'],
    ['finance', 'money'],
    ['posts', 'posts'],
    ['intel', 'the Intel shelf'],
    ['meetings', 'meetings'],
    ['sessions', 'Claude Code sessions, waiting prompts and usage (read only)'],
  ];
  return names.filter(([p]) => partOn(s, d, p)).map(([, n]) => n);
}

export function buildChatService(ctx: DaemonContext, deps: ChatDeps, opts: ChatOptions = {}): ChatService {
  return new ChatServiceImpl(ctx, deps, opts);
}
