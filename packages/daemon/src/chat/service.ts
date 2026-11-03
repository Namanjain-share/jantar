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
import { OWNER_FALLBACK_NAME } from '@jantar/protocol/people-core';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
  type ChatContext,
  type ChatTurnContext,
} from '@jantar/protocol';
import {
  BUILT_PHASE,
  CHAT_KEEP_DAYS_DEFAULT,
  PERSON_CHAT_SENTENCES,
  PERSON_CHAT_UNFINISHED_MAX,
  chatDisclosure,
  chatThreadOf,
  type OwnerChatView,
  type PersonChatList,
  type PersonChatStatus,
} from '@jantar/protocol/people';
import type { Actor, ChatService, DaemonContext, LifeResult, Logger, TimerId, Unsubscribe } from '../contracts.js';
import { actorId } from '../core/actor.js';
import { newId } from '../core/ids.js';
import { sendLifePush } from '../life/push.js';
import { pickSharedRunAccount, runVia } from '../rewrite/pick.js';
import { DROPPABLE_OPTIONS, execRewrite, initOfLine, initProblem, lineSplitter, prepareRunDir, runDroppingRefused, type RunOutcome } from '../rewrite/run.js';
import { applyWrite, undoJournal, type Journal } from './actions.js';
import { CHAT_BROKEN_REASON, chatPreUpgradeName, openChatDb } from './db.js';
import { Dispatcher } from './dispatcher.js';
import { saveFastPath } from './fast.js';
import { chatStdin, CHAT_HISTORY_TURNS, lookingLine, type HistoryTurn } from './input.js';
import { findMeeting, labelOf } from './items.js';
import { ChatPhotos } from './photos.js';
import { personChatDeps, personOfThread, threadOf } from './person-deps.js';
import { personFoodOn, personOnParts } from './person-tools.js';
import { ChatStore, type PhotoRow, type TurnRecord } from './store.js';
import { dismissCard, runCard, undoChange } from './taps.js';
import { countSentence, cut, line, replyText, speakable } from './text.js';
import { audit, partOn, recordChange, toolsFor, TurnTools } from './tools.js';
import type { ChatDeps, ChatPart, ChatWriteLimiter } from './types.js';

export const CHAT_PROMPT_VERSION = 'v1';
export const CHAT_PROMPT_ASSET = `chat/chat-${CHAT_PROMPT_VERSION}.md`;
/** v0.11 People (P3, spec 7.4): her run's prompt. */
export const PERSON_CHAT_PROMPT_ASSET = `chat/person-${CHAT_PROMPT_VERSION}.md`;
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
  /** v0.11: the turn's thread ('' his, 'p:<pid>' hers). */
  thread: string;
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

/** v0.11 People (C17): her turns' failure words, from a fixed set that never names an account, a limit or a reset. */
function personFailedReason(o: AuditOutcome): string {
  switch (o) {
    case 'no_account':
      return PERSON_CHAT_SENTENCES.busy;
    case 'timeout':
      return PERSON_CHAT_SENTENCES.slow;
    case 'cancelled':
    case 'stopped':
      return PERSON_CHAT_SENTENCES.cancelled;
    default:
      return PERSON_CHAT_SENTENCES.failed;
  }
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
  /** Life's per-device write limit, the API's own instance (daemon.ts): a run's writes count with the sender's. */
  lifeWrites: ChatWriteLimiter;
}

/** The part of Chat each "Looking at" kind belongs to (0.11). */
const LOOKING_PART: Record<ChatContext['kind'], ChatPart> = {
  todo: 'todos',
  medicine: 'medicines',
  meal: 'food',
  place: 'places',
  money: 'finance',
  post: 'posts',
  intel: 'intel',
  meeting: 'meetings',
  session: 'sessions',
};

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
  /** v0.11: each unfinished turn's thread. */
  private readonly turnThreads = new Map<string, string>();
  private unforget: (() => void) | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private sweepTimer: TimerId | undefined;
  private readonly log: Logger;
  private readonly readOnly: boolean;
  private readonly lifeWrites: ChatWriteLimiter;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: ChatDeps,
    opts: ChatOptions,
  ) {
    this.log = ctx.log.child({ part: 'chat' });
    this.readOnly = opts.readOnly === true;
    this.lifeWrites = opts.lifeWrites;
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
    // v0.11 People: her thread is forgotten with her space (Leave with delete, remove --forget, the 30-day forget),
    // and his read-only view and her mirror read it through life/people/views.ts (which checks see.chat).
    try {
      this.unforget ??= this.deps.life.people.onForget((pid) => void this.forgetThread(pid));
      this.deps.life.people.chatThread = (pid, before) => {
        const r = this.threadView(pid, before);
        return r.ok ? r.value : null;
      };
    } catch {
      // a stand-in Life (no People): nothing of hers to read or forget
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unforget?.();
    this.unforget = null;
    try {
      this.deps.life.people.chatThread = null;
    } catch {
      // a stand-in Life
    }
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
    // v0.11: chat.db is copied before it moves to a newer schema (backups/chat-pre-<version>.db).
    const preMigrateCopy = () => {
      mkdirSync(this.ctx.paths.backupsDir, { recursive: true, mode: 0o700 });
      return join(this.ctx.paths.backupsDir, chatPreUpgradeName(this.ctx.version.daemon));
    };
    const r = this.ctx.paths.chatDb === ':memory:' ? openChatDb(this.ctx.paths.chatDb) : openChatDb(this.ctx.paths.chatDb, { preMigrateCopy });
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

  /** Turns a restart left queued or running, in every thread: failed, with the sentence (hers from her fixed set). */
  private failLeftOver(): void {
    const root = this.store;
    if (!root) return;
    for (const thread of root.threads()) {
      const s = root.inThread(thread);
      const reason = thread === '' ? CHAT_SENTENCES.restarted : PERSON_CHAT_SENTENCES.restarted;
      for (const t of s.unfinished()) s.updateTurn(t.id, (x) => ({ ...x, state: 'failed', reason }));
    }
  }

  /** v0.11 People (C17): a thread's keep, in days: his `ask.keepDays`, or her own `chatKeepDays`; 0 for a person who is gone. */
  private keepDaysOf(thread: string): number {
    const pid = personOfThread(thread);
    if (pid === null) return this.ctx.settings.get().ask.keepDays;
    let p = null;
    try {
      p = this.deps.life.people.person(pid);
    } catch {
      return CHAT_KEEP_DAYS_DEFAULT;
    }
    if (!p) return this.deps.life.broken() === null ? 0 : CHAT_KEEP_DAYS_DEFAULT;
    return p.prefs.chatKeepDays;
  }

  /** The retention sweep (B3), thread by thread with each thread's own keep (C17); photos past the folder's cap mark their turn's photo gone. */
  async sweep(): Promise<void> {
    const root = this.store;
    if (!root) return;
    try {
      const now = this.ctx.clock.now();
      for (const thread of root.threads()) {
        const s = root.inThread(thread);
        const keepDays = this.keepDaysOf(thread);
        const r = s.sweep({
          cutoffIso: this.ctx.clock.iso(now - keepDays * DAY_MS),
          maxTurns: CHAT_TURNS_MAX,
          undoCutoffIso: this.ctx.clock.iso(now - CHAT_UNDO_WITHIN_MS),
          unattachedCutoffIso: this.ctx.clock.iso(now - CHAT_UNATTACHED_MS),
        });
        await this.photos.removeFiles(r.photos);
        if (r.turns > 0) this.changed(thread);
      }
      const capped = await this.photos.cap(root);
      this.markGone(capped);
    } catch (e) {
      this.log.warn('chat: the sweep failed', { code: errorKind(e) });
    }
  }

  private markGone(capped: readonly (PhotoRow & { thread: string })[]): void {
    const ids = new Set(capped.map((p) => p.id));
    const byThread = new Map<string, Set<string>>();
    for (const p of capped) if (p.turnId !== null) byThread.set(p.thread, (byThread.get(p.thread) ?? new Set()).add(p.turnId));
    for (const [thread, turnIds] of byThread) {
      const s = this.store?.inThread(thread);
      for (const id of turnIds) s?.updateTurn(id, (t) => ({ ...t, photos: t.photos.map((p) => (ids.has(p.id) ? { ...p, gone: true } : p)) }));
      this.changed(thread);
    }
  }

  /** v0.11 People: her thread forgotten (rows and photo files), its turns stopped. Idempotent. */
  async forgetThread(pid: string): Promise<void> {
    const root = this.store;
    if (!root) return;
    const thread = chatThreadOf(pid);
    const run = this.running;
    this.stopThread(thread, 'cancelled');
    if (run?.thread === thread) await run.done;
    const s = root.inThread(thread);
    const files = s.photosAll();
    s.clear();
    await this.photos.removeFiles(files);
  }

  /** The deps a turn or tap of `actor` reaches: hers are her space alone (person-deps.ts), never his. */
  private depsFor(actor: Actor): ChatDeps {
    return actor.kind === 'person' ? personChatDeps(this.deps, { pid: actor.personId, people: this.deps.life.people }) : this.deps;
  }

  /** v0.11 People: messages she has left today (her `chatPerDay`, counted in the Life zone's day). */
  private leftToday(pid: string, store: ChatStore): { left: number; perDay: number } {
    let perDay = 0;
    try {
      perDay = this.deps.life.people.person(pid)?.limits.chatPerDay ?? 0;
    } catch {
      perDay = 0;
    }
    const now = this.ctx.clock.now();
    const tz = this.zone().timezone;
    const today = dayKeyOf(new Date(now), tz);
    const used = store.turnTimesSince(this.ctx.clock.iso(now - 2 * DAY_MS)).filter((at) => dayKeyOf(new Date(at), tz) === today).length;
    return { left: Math.max(0, perDay - used), perDay };
  }

  /** Whether {owner} can read her chat now (see.chat). */
  private ownerCanRead(pid: string): boolean {
    try {
      return this.deps.life.people.agreement(pid)?.see.chat === true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ the thread

  /** Why Chat can't take a message now. Hers is one fixed sentence (C17): never his switch, his CLI or his runner. */
  private notReady(actor?: Actor): Refusal | null {
    const r = this.notReadyOwner();
    if (r && actor?.kind === 'person') return refuse(r.code, r.code === 'life_unavailable' ? PERSON_CHAT_SENTENCES.off : PERSON_CHAT_SENTENCES.off);
    return r;
  }

  private notReadyOwner(): Refusal | null {
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

  list(actor: Actor, before?: string): LifeResult<ChatList> {
    const root = this.needStore();
    if ('ok' in root) return root;
    const thread = threadOf(actor);
    const store = root.inThread(thread);
    const page = store.page(before, CHAT_PAGE);
    const notReady = this.notReady(actor);
    return {
      ok: true,
      value: {
        turns: page.turns.map((t) => store.full(t)),
        older: page.older,
        ready: notReady ? { ok: false, reason: notReady.reason } : { ok: true },
        keepDays: this.keepDaysOf(thread),
      },
    };
  }

  /** v0.11 People (spec 7.5, 7.6): her thread, messages left today, and the disclosure from the live agreement. */
  personList(actor: Actor, before?: string): LifeResult<PersonChatList> {
    if (actor.kind !== 'person') return refuse('not_found', CHAT_SENTENCES.noTurn);
    const l = this.list(actor, before);
    if (!l.ok) return l;
    const store = (this.store as ChatStore).inThread(threadOf(actor));
    const { left, perDay } = this.leftToday(actor.personId, store);
    const canRead = this.ownerCanRead(actor.personId);
    let owner = OWNER_FALLBACK_NAME;
    try {
      owner = this.deps.life.people.ownerName();
    } catch {
      /* the neutral word */
    }
    const ready = l.value.ready.ok && left === 0 ? { ok: false, reason: PERSON_CHAT_SENTENCES.usedUp } : l.value.ready;
    const food = this.deps.life.people.food?.on(actor.personId) === true;
    return { ok: true, value: { ...l.value, ready, left, perDay, ownerCanRead: canRead, disclosure: chatDisclosure(owner, l.value.keepDays, canRead, BUILT_PHASE, food) } };
  }

  /** v0.11 People: her thread's size (no text), messages left today, and whether it can run. */
  personStatus(actor: Actor): LifeResult<PersonChatStatus> {
    if (actor.kind !== 'person') return refuse('not_found', CHAT_SENTENCES.noTurn);
    const root = this.needStore();
    if ('ok' in root) return refuse('life_unavailable', PERSON_CHAT_SENTENCES.off);
    const store = root.inThread(threadOf(actor));
    const { left, perDay } = this.leftToday(actor.personId, store);
    const notReady = this.notReady(actor);
    const ready = notReady ? { ok: false, reason: notReady.reason } : left === 0 ? { ok: false, reason: PERSON_CHAT_SENTENCES.usedUp } : { ok: true };
    return { ok: true, value: { turns: store.turnCount(), left, perDay, ready } };
  }

  /**
   * v0.11 People (spec 7.8): her thread as she sees it, read only, for {owner}'s view and her mirror. The
   * caller (life/people/views.ts ownerViewOf) has checked `see.chat` and writes the view mark.
   */
  threadView(pid: string, before?: string): LifeResult<OwnerChatView> {
    const root = this.needStore();
    if ('ok' in root) return root;
    const thread = chatThreadOf(pid);
    const store = root.inThread(thread);
    const page = store.page(before, CHAT_PAGE);
    const keep = this.keepDaysOf(thread);
    return { ok: true, value: { turns: page.turns.map((t) => store.full(t)), older: page.older, keepDays: (keep === 1 || keep === 7 ? keep : 30) as OwnerChatView['keepDays'] } };
  }

  /** v0.11 People (spec 7.8): one photo of her thread (another thread's: 404). */
  async threadPhoto(pid: string, id: string): Promise<LifeResult<{ type: string; body: Buffer }>> {
    const root = this.needStore();
    if ('ok' in root) return root;
    const p = root.inThread(chatThreadOf(pid)).photo(id);
    if (!p) return refuse('not_found', CHAT_SENTENCES.noPhoto);
    const body = await this.photos.read(p);
    return body ? { ok: true, value: { type: p.type, body } } : refuse('not_found', CHAT_SENTENCES.noPhoto);
  }

  /** v0.11 People (O21): she deletes one turn of hers: gone for both, with no trace. */
  async deleteTurn(id: string, actor: Actor): Promise<LifeResult> {
    const root = this.needStore();
    if ('ok' in root) return root;
    const thread = threadOf(actor);
    const store = root.inThread(thread);
    const t = store.turn(id);
    if (!t) return refuse('not_found', CHAT_SENTENCES.noTurn);
    if (unfinished(t)) return refuse('conflict', actor.kind === 'person' ? PERSON_CHAT_SENTENCES.wait : CHAT_SENTENCES.busy);
    const files = store.deleteTurn(id);
    if (files === null) return refuse('not_found', CHAT_SENTENCES.noTurn);
    await this.photos.removeFiles(files);
    this.changed(thread);
    return OK;
  }

  send(body: { text: string; photos?: string[]; context?: ChatContext }, actor: Actor, via: 'phone' | 'voice' = 'phone'): LifeResult<{ id: string }> {
    const text = body.text.trim();
    const photoIds = [...new Set(body.photos ?? [])];
    const person = actor.kind === 'person' ? actor.personId : null;
    // v0.11 People: her thread is phone only (no Siri door for her, spec 7.5).
    if (person && via !== 'phone') return refuse('forbidden', PERSON_CHAT_SENTENCES.off);
    if (!text && photoIds.length === 0) return refuse('invalid_request', CHAT_SENTENCES.noText);
    if (text.length > (via === 'voice' ? CHAT_VOICE_TEXT_MAX : CHAT_TEXT_MAX)) return refuse('invalid_request', via === 'voice' ? CHAT_SENTENCES.voiceTooLong : CHAT_SENTENCES.tooLong);
    if (photoIds.length > CHAT_PHOTOS_MAX || (via === 'voice' && photoIds.length > 0)) return refuse('invalid_request', CHAT_SENTENCES.tooManyPhotos);
    const notReady = this.notReady(actor);
    if (notReady) return notReady;
    const thread = threadOf(actor);
    const store = (this.store as ChatStore).inThread(thread);
    if (person) {
      // At most 2 unfinished turns in her thread, and her daily cap (spec 7.5).
      if (store.unfinished().length >= PERSON_CHAT_UNFINISHED_MAX) return refuse('conflict', PERSON_CHAT_SENTENCES.wait);
      if (this.leftToday(person, store).left <= 0) return refuse('rate_limited', PERSON_CHAT_SENTENCES.usedUp);
    } else if (store.unfinished().length >= CHAT_QUEUE_MAX) return refuse('conflict', CHAT_SENTENCES.busy);
    for (const id of photoIds) {
      const p = store.photo(id);
      // Try again: a photo of a turn that failed goes with the new message (B14); one sent and answered does not.
      if (!p || (p.turnId !== null && store.turn(p.turnId)?.state !== 'failed')) return refuse('invalid_request', CHAT_SENTENCES.photoGone);
    }
    const id = newId();
    const at = this.ctx.clock.iso();
    // 0.11: the "Looking at" chip, found here and named by the daemon; an id it doesn't know is dropped.
    // Only his: her thread never names an item of his (v0.11 People).
    const looking = body.context && via === 'phone' && !person ? this.lookingAt(body.context) : null;
    const fast = !person && this.readingLinks() && photoIds.length === 0 ? saveFastPath(text) : null;
    store.tx(() => {
      const photos = store
        .attach(id, photoIds)
        .map((pid) => store.photo(pid))
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => ({ id: p.id, w: p.w, h: p.h, gone: false }));
      store.insertTurn({ id, at, via, text, photos, state: fast ? 'running' : 'queued', tainted: false, refused: 0, by: actorId(actor), ...(looking ? { context: looking } : {}) });
    });
    if (fast) void this.saveFast(id, fast, actor);
    else {
      this.senders.set(id, actor);
      this.turnThreads.set(id, thread);
      this.queue.push(id);
      this.kick();
    }
    this.changed(thread);
    return { ok: true, value: { id } };
  }

  /** The item a "Looking at" chip names, as it is now, or null (gone, unknown, or its part is off). */
  private lookingAt(c: ChatContext): ChatTurnContext | null {
    // A part that is off can't be what Chat helps with: dropped like an unknown id.
    const part: ChatPart = LOOKING_PART[c.kind];
    if (!partOn(this.ctx.settings.get(), this.deps, part)) return null;
    const label = (() => {
      switch (c.kind) {
        case 'session': {
          const s = this.deps.board.state().sessions[c.id];
          return s ? `Session · ${cut(line(s.folder), 80)}` : '';
        }
        case 'meeting': {
          const m = findMeeting(this.deps, c.id);
          return m ? `Meeting · ${cut(line(m.name), 120)}` : '';
        }
        case 'intel': {
          const i = this.deps.intel.get(c.id);
          return i ? `Intel · ${cut(line(i.title), 120)}` : '';
        }
        default:
          try {
            return labelOf(this.deps, { kind: c.kind, id: c.id });
          } catch {
            return '';
          }
      }
    })();
    return label ? { kind: c.kind, id: c.id, label: cut(label, 200) } : null;
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

  cancel(id: string, actor: Actor): LifeResult {
    const root = this.needStore();
    if ('ok' in root) return root;
    const thread = threadOf(actor);
    const store = root.inThread(thread);
    const turn = store.turn(id);
    if (!turn) return refuse('not_found', CHAT_SENTENCES.noTurn);
    if (!unfinished(turn)) return OK;
    this.halt(id);
    store.updateTurn(id, (t) => ({ ...t, state: 'cancelled', reason: thread === '' ? CHAT_SENTENCES.cancelled : PERSON_CHAT_SENTENCES.cancelled }));
    this.ended(id);
    this.changed(thread);
    return OK;
  }

  /** Clear the caller's thread only (v0.11: the other thread, its runs and its photos stay). */
  async clear(actor: Actor, opts: { broken?: boolean } = {}): Promise<LifeResult> {
    if (opts.broken) return this.moveBroken(actor);
    const root = this.needStore();
    if ('ok' in root) return root;
    const thread = threadOf(actor);
    const store = root.inThread(thread);
    const run = this.running;
    this.stopThread(thread, 'cancelled');
    if (run?.thread === thread) await run.done;
    const files = store.photosAll();
    store.clear();
    await this.photos.removeFiles(files);
    audit(this.ctx, actorId(actor), 'chat.clear', 'chat', {}, 'ok');
    this.changed(thread);
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
    const root = this.needStore();
    if ('ok' in root) return root;
    const thread = threadOf(actor);
    const r = await undoChange({ ctx: this.ctx, deps: this.depsFor(actor), store: root.inThread(thread) }, turnId, n, actor, actorId(actor));
    if (thread !== '') this.changed(thread);
    return r;
  }

  async card(turnId: string, n: number, actor: Actor): Promise<LifeResult> {
    const root = this.needStore();
    if ('ok' in root) return root;
    const thread = threadOf(actor);
    const r = await runCard({ ctx: this.ctx, deps: this.depsFor(actor), store: root.inThread(thread) }, turnId, n, actor, actorId(actor));
    this.changed(thread);
    return r;
  }

  dismiss(turnId: string, n: number, actor: Actor): LifeResult {
    const root = this.needStore();
    if ('ok' in root) return root;
    const thread = threadOf(actor);
    const r = dismissCard({ ctx: this.ctx, deps: this.depsFor(actor), store: root.inThread(thread) }, turnId, n, actorId(actor));
    this.changed(thread);
    return r;
  }

  async photoAdd(bytes: Buffer, actor: Actor): Promise<LifeResult<{ id: string }>> {
    const notReady = this.notReady(actor);
    if (notReady) return notReady;
    const root = this.store as ChatStore;
    const store = root.inThread(threadOf(actor));
    // v0.11 People (O19): hers is stripped of location, camera details and thumbnails before it is kept.
    const r = actor.kind === 'person' ? await this.photos.addStripped(bytes, store) : await this.photos.add(bytes, store);
    if (r.ok) this.markGone(await this.photos.cap(root));
    return r;
  }

  /** A photo of the caller's thread (the owner's routes pass no actor: his thread). Another thread's: 404. */
  async photo(id: string, actor?: Actor): Promise<LifeResult<{ type: string; body: Buffer }>> {
    const root = this.needStore();
    if ('ok' in root) return root;
    const store = root.inThread(actor ? threadOf(actor) : '');
    const p = store.photo(id);
    if (!p) return refuse('not_found', CHAT_SENTENCES.noPhoto);
    const body = await this.photos.read(p);
    return body ? { ok: true, value: { type: p.type, body } } : refuse('not_found', CHAT_SENTENCES.noPhoto);
  }

  async photoDelete(id: string, actor: Actor): Promise<LifeResult> {
    const root = this.needStore();
    if ('ok' in root) return root;
    const store = root.inThread(threadOf(actor));
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
    this.turnThreads.delete(turnId);
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

  /** Off or stop(): every thread's run stopped and queued turns cancelled. */
  private stopAll(why: 'cancelled' | 'stopped'): void {
    this.epoch += 1;
    this.stopThread(null, why);
  }

  /** One thread's queued turns cancelled and its run stopped (null: every thread). Clear stops only the caller's. */
  private stopThread(thread: string | null, why: 'cancelled' | 'stopped'): void {
    const root = this.store;
    const reason = (t: string) => (t === '' ? CHAT_SENTENCES.cancelled : PERSON_CHAT_SENTENCES.cancelled);
    for (const id of [...this.queue]) {
      const t = this.turnThreads.get(id) ?? '';
      if (thread !== null && t !== thread) continue;
      this.queue.splice(this.queue.indexOf(id), 1);
      root?.inThread(t).updateTurn(id, (x) => ({ ...x, state: 'cancelled', reason: reason(t) }));
      this.ended(id);
    }
    const run = this.running;
    if (run && (thread === null || run.thread === thread)) {
      run.why ??= why;
      run.abort.abort();
      root?.inThread(run.thread).updateTurn(run.turnId, (t) => (unfinished(t) ? { ...t, state: 'cancelled', reason: reason(run.thread) } : t));
      this.ended(run.turnId);
    }
  }

  /**
   * A thread changed. His: `life.changed {}` as before. Hers (v0.11, spec 7.8): her stream's chat counter,
   * and his devices only while `see.chat` is on, so his stream can't tell him when she chats (C20).
   */
  private changed(thread = ''): void {
    const pid = personOfThread(thread);
    if (pid === null) {
      this.ctx.store.emit({ type: 'life.changed', data: {} });
      return;
    }
    try {
      this.deps.life.people.ticks.bump(pid, 'chat');
      if (this.ownerCanRead(pid)) this.deps.life.people.ownerChanged();
    } catch {
      /* Life closed: her app reloads on its next tick */
    }
  }

  private kick(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const run: Run = { turnId: next, thread: this.turnThreads.get(next) ?? '', epoch: this.epoch, abort: new AbortController() };
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
    const t = this.store?.inThread(run.thread).turn(run.turnId);
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
    const store = this.store?.inThread(run.thread) ?? null;
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
    // Her turn ticks her stream, and his only while see.chat is on (C20): never a bare `life.changed`.
    this.changed(run.thread);

    const single = 'claude' in program;
    const actor: Actor = this.senders.get(run.turnId) ?? { kind: 'system' };
    // v0.11 People: her run reaches her space alone (her deps, her tools, her prompt); his is unchanged.
    const pid = personOfThread(run.thread);
    if (pid !== null && (actor.kind !== 'person' || actor.personId !== pid)) {
      this.finish(run, { failed: 'failed' });
      return;
    }
    const deps = this.depsFor(actor);
    const list = toolsFor(s, deps);
    const tools = new TurnTools({ ctx, deps, store, turnId: run.turnId, actor, actorName: queued.by, message: queued.text, tools: list, lifeWrites: this.lifeWrites, live: () => this.live(run) !== null });
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
      const dir = await prepareRunDir(ctx.paths, { dir: runDir, asset: pid !== null ? PERSON_CHAT_PROMPT_ASSET : CHAT_PROMPT_ASSET });
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
      // C17: her <reach> is a fixed person list, never his switches.
      const on = pid !== null ? personOnParts(personFoodOn(deps)) : onParts(s, this.deps);
      const input = chatStdin({
        ...(pid !== null ? { person: { owner: this.deps.life.people.ownerName(), ownerCanRead: this.ownerCanRead(pid), cafes: false } } : {}),
        today: dayKeyOf(now, z.timezone),
        now: hhmmOf(now, z.timezone),
        timezone: z.timezone,
        channel: via,
        on,
        tools: list.map((t) => t.name),
        currency: z.currency,
        history: this.history(store, run.turnId),
        ...(queued.context ? { looking: lookingLine(queued.context) } : {}),
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
    if (isolation) await this.undoTurn(run, actor, deps);
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
  private async undoTurn(run: Run, actor: Actor, deps: ChatDeps): Promise<void> {
    const store = this.store?.inThread(run.thread);
    if (!store) return;
    const turnId = run.turnId;
    for (const c of [...store.changes(turnId)].reverse()) {
      if (c.state !== 'done') continue;
      const j = store.change(turnId, c.n)?.journal;
      if (!j) continue;
      const r = await undoJournal(deps, j as Journal, actor);
      if (r.ok) store.setChangeState(turnId, c.n, 'undone');
    }
    for (const card of store.cards(turnId)) if (card.state === 'waiting') store.setCardState(turnId, card.n, 'expired');
  }

  private finish(run: Run, end: { reply: string; isolationFailed: boolean } | { failed: AuditOutcome }, force = false): void {
    const store = this.store?.inThread(run.thread);
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
    } else store.updateTurn(run.turnId, (t) => ({ ...t, state: 'failed', reason: run.thread === '' ? failedReason(end.failed) : personFailedReason(end.failed) }));
    this.ended(run.turnId);
    this.changed(run.thread);
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

export function buildChatService(ctx: DaemonContext, deps: ChatDeps, opts: ChatOptions): ChatService {
  return new ChatServiceImpl(ctx, deps, opts);
}
