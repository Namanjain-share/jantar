/**
 * Messages (0.15): the daemon's part. It reads the owner's WhatsApp through
 * jantar-messages-reader (reader-client.ts) for the phone, the CLI and
 * `jantar mcp`, keeps messages.db (db.ts) and the skip list (skip.ts), and
 * hands images to jantar-media (media.ts).
 *
 * - messages.db opens when `messages.enabled` turns on (at start, or on a
 *   settings change) and closes when it turns off. A failed open makes
 *   `broken()` the fixed sentence (every messages route answers 503 with it)
 *   and logs the code only; turning Messages off and on tries again. At
 *   open the keys skip.json lists that the table hasn't (a new or reset
 *   messages.db) are kept, then the mirror is written, before any read;
 *   until it has been, reads are refused (to the reader no skip.json is an
 *   empty list). A skip.json that won't open, or whose keys messages.db
 *   won't take, is never written over (it may be the only list): reads and
 *   skip changes are refused until its keys are in.
 *   One deleted or changed by anyone else is written again before the next
 *   read and by status(); a change that fails rewrites it from the table it
 *   rolled back to.
 * - A job left in <messagesDir>/jobs by a crash goes at start.
 * - The morning run (MorningApi): one at a time (409), never under
 *   --read-only (it spends quota), its reads checked like any other
 *   (needReads). It collects what the reader has since the cursor, cuts it
 *   to the budget, runs Claude with no tools, and applies the answer
 *   (morning/: collect, budget, input, run, apply). Each run's report is in
 *   messages.db (a dry run's without its preview); the cursor moves only
 *   after a run that went well and wasn't dry. A run the reader or Claude
 *   fails is stored failed with a fixed sentence; nothing new makes no
 *   Claude run. A timer or Run now run that made anything sends one push,
 *   counts only. Every chat sent to Claude is in the read log (`morning`).
 * - The morning timer (morning/timer.ts) runs while messages.db is open
 *   (never under --read-only), at the morning time in the Life zone; a time
 *   or zone change rearms it, and a timer run that went well marks its day.
 * - Reads need messages.db open (each is logged there: via, the MCP
 *   caller's pid and folder, the op, the chat key, a count) and answer the
 *   reader's data or throw its ReaderFailure; one that finds messages.db
 *   closed after its await drops the answer (ApiError messages_unavailable).
 * - status() asks the reader whatever the switch says (setup polls it) and
 *   never throws: not_installed (no reader built), update_needed (a reader
 *   built from another source, or speaking another protocol version), down,
 *   then the reader's own flags.
 * - Nothing here logs a name, a number or text: chat keys and counts only.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { instantAt, isValidTimeZone } from '@jantar/life-core';
import { MESSAGES_LIMITS, type Settings } from '@jantar/protocol';
import {
  ChatKeySchema,
  DraftSchema,
  MessagesPrefsSchema,
  type Call,
  type CallsToReturnResponse,
  type Chat,
  type Draft,
  type DraftState,
  type MessagesAmbiguous,
  type MessagesChatsQuery,
  type MessagesChatsResponse,
  type MessagesReadQuery,
  type MessagesReadResponse,
  type MessagesSearchQuery,
  type MessagesSearchResponse,
  type MessagesPrefs,
  type MessagesStatus,
  type MessagesTodayResponse,
  type MorningPreview,
  type MorningRun,
  type MorningTrigger,
  type ReadLogEntry,
} from '@jantar/protocol/messages';
import { ApiError } from '../api/errors.js';
import type {
  Actor,
  CcwLegacySource,
  DaemonContext,
  LifeResult,
  LifeService,
  Logger,
  MessagesMediaAnswer,
  MessagesService,
  MorningApi,
  Notifier,
  ReadBy,
  Unsubscribe,
  UsageSource,
} from '../contracts.js';
import { newId } from '../core/ids.js';
import type { ClaudeFail } from '../intel/read/claude.js';
import { MediaHelper } from '../intel/read/media.js';
import { createLifeSend, morningPush, pushNotice, type LifeSend } from '../life/push.js';
import { CONTROL, LINE_END } from '../rewrite/guards.js';
import {
  LAST_DAY_KEY,
  READS_KEEP,
  addRead,
  failRunning,
  lastRunAt,
  listReads,
  newestRun,
  openMessagesDb,
  putRun,
  readCursor,
  readPrefs,
  writeCursor,
  writePrefs,
  type MessagesDb,
} from './db.js';
import { clearJobs, mediaAnswer, type ImageShrinker } from './media.js';
import { CALLBACK_TITLE, applyMorning, undoMorning, type ApplyResult } from './morning/apply.js';
import { budget } from './morning/budget.js';
import { collect, missedCalls, type Batch } from './morning/collect.js';
import { OWNER_NAME, morningInput } from './morning/input.js';
import { morningImages, pickImages, runMorning } from './morning/run.js';
import { MorningTimer, type WhatsAppReady } from './morning/timer.js';
import { ReaderFailure, createReaderClient, type ReaderClient } from './reader-client.js';
import { READER_KEYS_MAX, READER_SOURCE, READER_VERSION, readerSourceKey, type ReaderStatus } from './reader-protocol.js';
import { MESSAGES_SAYS, readerSays } from './says.js';
import { SkipFileUnreadable, createSkipStore, type SkipStore } from './skip.js';

export interface MessagesDeps {
  /** The morning run's todos. */
  life: LifeService;
  /** The morning run's Claude account. */
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
  /** The morning push goes to the Web Push one only (life/push.ts). */
  notifiers?: readonly Notifier[];
}

export interface MessagesOptions {
  /** jantard --read-only: reads and the skip list work, the morning run never runs (it spends quota). */
  readOnly?: boolean;
  /** What shrinks images: daemon.ts passes the jantar-media helper Intel uses (built on first use). Default: one of its own. */
  shrinker?: ImageShrinker;
  /** Default paths.messagesDb; tests pass ":memory:". */
  dbFile?: string;
  /** Default reader-client.ts READER_TIMEOUT_MS. */
  readerTimeoutMs?: number;
  /** How the morning push goes out (default: Web Push through deps.notifiers, life/push.ts); tests pass a spy. */
  send?: LifeSend;
}

const DAY_MS = 86_400_000;
const OK: LifeResult = { ok: true, value: true };

type ReaderLine = MessagesStatus['reader'];
type Installed = 'missing' | 'stale' | 'ok';

/** An error's code or class name for a log line: never its message (it can carry a path). */
function errorKind(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}

const chatKeyOf = (msgKey: string) => msgKey.slice(0, msgKey.indexOf('.'));

/** Today's drafts and call-backs, at most. */
const TODAY_MAX = 50;
/** A run report's per-chat list of what the budget left out, at most (its count has them all). */
const REPORT_DROPPED_MAX = 50;
const NO_COUNTS: MorningRun['counts'] = { chats: 0, messages: 0, calls: 0, todos: 0, replies: 0, callbacks: 0, dropped: 0 };
const NO_PREVIEW: MorningPreview = { todos: [], callbacks: [], replies: [], dropped: [] };

/** A failed Claude run's sentence. */
const CLAUDE_SAYS: Record<ClaudeFail, string> = {
  noClaude: MESSAGES_SAYS.morningNoClaude,
  noAccount: MESSAGES_SAYS.morningNoAccount,
  unreadable: MESSAGES_SAYS.morningUnreadable,
  notIsolated: MESSAGES_SAYS.morningNotIsolated,
  stopped: MESSAGES_SAYS.morningStopped,
  tooLong: MESSAGES_SAYS.morningTooLong,
};

/** A run that threw: the reader's sentence for what the owner can fix, else the general one. */
function morningFailSays(e: unknown): string {
  return (e instanceof ReaderFailure ? readerSays(e.code, e.detail) : null) ?? MESSAGES_SAYS.morningFailed;
}

/** What a dry run would make, for the CLI's table: no ids, no number. */
function previewOf(a: ApplyResult): MorningPreview {
  return {
    todos: a.todos.map((t) => ({ title: t.title })),
    callbacks: a.callbacks.map((c) => ({ who: c.who, ...(c.at ? { at: c.at } : {}) })),
    replies: a.replies.map((d) => ({ chatName: d.chatName, theyAsked: d.theyAsked, draft: d.draft })),
    dropped: a.dropped,
  };
}

interface DraftRow {
  id: string;
  run_id: string;
  chat_key: string;
  chat_name: string;
  phone: string | null;
  they_asked: string;
  draft: string;
  at: string;
  state: string;
}

class MessagesShell implements MessagesService {
  readonly skip: MessagesService['skip'];
  readonly morning: MorningApi;
  /** The reader's client (the morning run collects through it). */
  readonly reader: ReaderClient;
  private db: MessagesDb | null = null;
  private skipStore: SkipStore | null = null;
  /** skip.json was written since messages.db opened. */
  private mirrored = false;
  /** skip.json's stamp when it was last written (SkipStore.stamp). */
  private mirrorStamp: string | null = null;
  /**
   * skip.json's keys are in the table since open. Until then nothing writes
   * over it: 'locked', it wouldn't open; 'unsaved', messages.db wouldn't
   * take its keys (a full disk, a busy database).
   */
  private skipFile: 'unread' | 'locked' | 'unsaved' | 'read' = 'unread';
  private brokenReason: string | null = null;
  private unsub: Unsubscribe | null = null;
  private sourceKeyRead: Promise<string | null> | null = null;
  private readonly log: Logger;
  private readonly dbFile: string;
  private readonly shrinker: ImageShrinker;
  readonly readOnly: boolean;
  private readonly send: LifeSend;
  private readonly timer: MorningTimer;
  /** Options claude refused that the morning run can do without (this daemon's life). */
  private readonly learned = new Set<string>();
  /** The morning run going (one at a time). */
  private going: { id: string; abort: AbortController } | null = null;

  constructor(
    private readonly ctx: DaemonContext,
    readonly deps: MessagesDeps,
    opts: MessagesOptions,
  ) {
    this.log = ctx.log.child({ part: 'messages' });
    this.dbFile = opts.dbFile ?? ctx.paths.messagesDb;
    this.shrinker = opts.shrinker ?? new MediaHelper(ctx);
    this.readOnly = opts.readOnly === true;
    this.reader = createReaderClient(ctx.paths.messagesReaderSock, { clock: ctx.clock, ...(opts.readerTimeoutMs ? { timeoutMs: opts.readerTimeoutMs } : {}) });
    this.skip = {
      list: () => this.need().skip.list(),
      add: (chatKey, actor) => this.skipAdd(chatKey, actor),
      remove: (chatKey, actor) => this.skipRemove(chatKey, actor),
    };
    this.send = opts.send ?? createLifeSend(ctx, deps.notifiers ?? []);
    this.timer = new MorningTimer(ctx.clock, this.log, {
      tz: () => this.zone(),
      at: () => (this.db ? readPrefs(this.db).morningAt : null),
      lastDay: () => this.db?.meta(LAST_DAY_KEY) ?? null,
      ready: () => this.whatsAppReady(),
      run: (stale, day) => this.timerRun(stale, day),
    });
    this.morning = {
      prefs: () => readPrefs(this.need().db),
      setPrefs: (p, actor) => this.setPrefs(p, actor),
      run: (o) => this.morningRun(o.trigger),
      today: () => this.today(),
      setDraft: (id, state, actor) => this.setDraft(id, state, actor),
      undo: (runId, actor) => this.undo(runId, actor),
      last: () => newestRun(this.need().db, false),
    };
  }

  async start(): Promise<void> {
    // No image job runs before start.
    await clearJobs(this.ctx.paths.messagesDir);
    this.unsub ??= this.ctx.settings.subscribe((next, prev) => this.onSettings(next, prev));
    if (this.ctx.settings.get().messages.enabled) this.open();
  }

  async stop(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    this.close();
  }

  broken(): string | null {
    return this.brokenReason;
  }

  // ---------------------------------------------------------------- status

  async status(): Promise<MessagesStatus> {
    let whatsapp: MessagesStatus['whatsapp'] = { found: false, running: false, newestAt: null, schemaOk: false };
    let phone = { readable: false };
    let readerSkipped = 0;
    let reader: ReaderLine;
    const installed = await this.installed().catch((): Installed => 'missing');
    if (installed === 'missing') {
      reader = { state: 'not_installed', detail: MESSAGES_SAYS.notInstalled };
    } else {
      try {
        const st = await this.reader.call('status', {});
        whatsapp = { found: st.whatsapp.found, running: st.whatsapp.running, newestAt: st.whatsapp.newestAt, schemaOk: st.whatsapp.schemaOk };
        phone = { readable: st.phone.readable };
        readerSkipped = st.skipped;
        reader = installed === 'stale' || st.version !== READER_VERSION ? { state: 'update_needed', detail: MESSAGES_SAYS.updateNeeded } : this.readerLine(st);
        // The reader enforces another list than the table's (skip.json changed outside the daemon): ours again.
        if (st.skipOk && this.mirrorDiffers(st.skipped)) this.mirror();
      } catch (e) {
        reader = installed === 'stale' ? { state: 'update_needed', detail: MESSAGES_SAYS.updateNeeded } : this.failedLine(e);
      }
    }
    const db = this.db;
    const safe = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    return {
      enabled: this.ctx.settings.get().messages.enabled,
      reader,
      whatsapp,
      phone,
      skipped: this.skipStore ? safe(() => this.skipStore!.list().length, readerSkipped) : readerSkipped,
      morning: db ? safe(() => ({ at: readPrefs(db).morningAt, lastRunAt: lastRunAt(db) }), { at: null, lastRunAt: null }) : { at: null, lastRunAt: null },
    };
  }

  /** The reader answered: what its flags say, the first that applies. */
  private readerLine(st: ReaderStatus): ReaderLine {
    if (!st.whatsapp.found) return { state: 'ok', detail: MESSAGES_SAYS.noWhatsApp };
    if (!st.whatsapp.schemaOk) return { state: 'unsupported', detail: MESSAGES_SAYS.unsupported };
    if (!st.whatsapp.contactsOk) return { state: 'no_access', detail: MESSAGES_SAYS.contacts };
    if (!st.skipOk || this.skipFile === 'locked' || this.skipFile === 'unsaved') {
      // Ours to write again (the reader reads nothing meanwhile), once its own keys are in the table.
      this.mirror();
      if (this.skipFile === 'locked') return { state: 'ok', detail: MESSAGES_SAYS.skipLocked };
      if (this.skipFile === 'unsaved') return { state: 'ok', detail: MESSAGES_SAYS.skipUnsaved };
      if (!st.skipOk) return { state: 'ok', detail: MESSAGES_SAYS.skipBroken };
    }
    if (st.whatsapp.walMtime === null) return { state: 'ok', detail: MESSAGES_SAYS.closed };
    return { state: 'ok' };
  }

  /** The reader didn't answer status. Its answer not checking is a reader of another build. */
  private failedLine(e: unknown): ReaderLine {
    const code = e instanceof ReaderFailure ? e.code : 'down';
    switch (code) {
      case 'no_access':
        return { state: 'no_access', detail: readerSays(code, e instanceof ReaderFailure ? e.detail : undefined) ?? MESSAGES_SAYS.noAccess };
      case 'unsupported':
        return { state: 'update_needed', detail: MESSAGES_SAYS.updateNeeded };
      default:
        return { state: 'down', detail: readerSays(code) ?? MESSAGES_SAYS.down };
    }
  }

  /** Whether a reader is built (paths.messagesReaderBin) and from this release's source (its .key). */
  private async installed(): Promise<Installed> {
    const bin = this.ctx.paths.messagesReaderBin;
    const st = await stat(bin).catch(() => null);
    if (!st?.isFile()) return 'missing';
    const have = (await readFile(`${bin}.key`, 'utf8').catch(() => '')).trim();
    this.sourceKeyRead ??= readFile(join(this.ctx.paths.assetsDir, READER_SOURCE), 'utf8').then(readerSourceKey, () => null);
    const want = await this.sourceKeyRead;
    return want !== null && have === want ? 'ok' : 'stale';
  }

  // ---------------------------------------------------------------- reads

  async chats(q: MessagesChatsQuery, by: ReadBy): Promise<MessagesChatsResponse> {
    this.needReads();
    const r = await this.reader.call('chats', {
      limit: q.limit,
      ...(q.q ? { q: q.q } : {}),
      ...(q.since ? { since: q.since } : {}),
      ...(q.waiting === 'true' ? { waiting: true } : {}),
    });
    this.logRead('chats', by, undefined, r.chats.length);
    return r;
  }

  async read(chatKey: string, q: MessagesReadQuery, by: ReadBy): Promise<MessagesReadResponse> {
    this.needReads();
    const r = await this.reader.call('read', { chatKey, limit: q.limit, ...(q.since ? { since: q.since } : {}), ...(q.before ? { before: q.before } : {}) });
    this.logRead('read', by, r.chat.chatKey, r.messages.length);
    return r;
  }

  async readByName(name: string, q: MessagesReadQuery, by: ReadBy): Promise<MessagesReadResponse | MessagesAmbiguous> {
    this.needReads();
    const r = await this.reader.call('readByName', { name, limit: q.limit, ...(q.since ? { since: q.since } : {}), ...(q.before ? { before: q.before } : {}) });
    if ('ambiguous' in r) this.logRead('readByName', by, undefined, 0);
    else this.logRead('readByName', by, r.chat.chatKey, r.messages.length);
    return r;
  }

  async search(q: MessagesSearchQuery, by: ReadBy): Promise<MessagesSearchResponse> {
    this.needReads();
    const r = await this.reader.call('search', { q: q.q, limit: q.limit, ...(q.since ? { since: q.since } : {}), ...(q.chat ? { chatKey: q.chat } : {}) });
    this.logRead('search', by, q.chat, r.hits.length);
    return r;
  }

  async media(msgKey: string, by: ReadBy): Promise<MessagesMediaAnswer> {
    this.needReads();
    const got = await this.reader.call('media', { msgKey, maxBytes: MESSAGES_LIMITS.mediaMaxBytes });
    const answer = await mediaAnswer(got, { messagesDir: this.ctx.paths.messagesDir, shrinker: this.shrinker });
    this.logRead('media', by, chatKeyOf(msgKey), 1);
    return answer;
  }

  async callsToReturn(by: ReadBy): Promise<CallsToReturnResponse> {
    this.needReads();
    const sinceMs = this.ctx.clock.now() - MESSAGES_LIMITS.waitingDays * DAY_MS;
    const since = this.ctx.clock.iso(sinceMs);
    const wa = await this.reader.call('waCalls', { since });
    // The iPhone log needs Full Disk Access on the reader; WhatsApp's calls count without it.
    const phone = await this.reader.call('phoneCalls', { since }).catch((e: unknown) => {
      if (e instanceof ReaderFailure && e.code === 'no_access') return { calls: [] as Call[] };
      throw e;
    });
    const calls = [...wa.calls, ...phone.calls].filter((c) => Date.parse(c.at) >= sinceMs);
    const keys = [...new Set(calls.flatMap((c) => (c.incoming && c.missed && c.chatKey ? [c.chatKey] : [])))];
    const wrote: Record<string, string | null> = {};
    for (let i = 0; i < keys.length; i += READER_KEYS_MAX) Object.assign(wrote, await this.reader.call('lastFromMe', { chatKeys: keys.slice(i, i + READER_KEYS_MAX) }));
    // Returned (the morning run's rule too): a later message from the owner, a later call the owner made, or a later call that connected.
    const open = missedCalls(calls, wrote).filter((c) => !c.returned);
    open.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    this.logRead('calls', by, undefined, open.length);
    return { calls: open.map((c) => ({ ...c, returned: false as const })) };
  }

  reads(limit: number): ReadLogEntry[] {
    return listReads(this.need().db, Math.max(1, Math.min(Math.floor(limit), READS_KEEP)));
  }

  // ---------------------------------------------------------------- skip list

  private async skipAdd(chatKey: string, actor: Actor): Promise<LifeResult> {
    if (!ChatKeySchema.safeParse(chatKey).success) return { ok: false, code: 'invalid_request', reason: MESSAGES_SAYS.notAChat };
    if (this.need().skip.list().some((e) => e.chatKey === chatKey)) return OK;
    if (!this.keepSkipFile()) return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
    let chat: Chat;
    try {
      // Its name and kind, for the list: one line read, never logged or kept.
      chat = (await this.reader.call('read', { chatKey, limit: 1 })).chat;
    } catch (e) {
      if (e instanceof ReaderFailure && e.code === 'not_found') return { ok: false, code: 'not_found', reason: MESSAGES_SAYS.notAChat };
      throw e;
    }
    const { db, skip } = this.need();
    // Messages may have gone off and on during the read: a skip.json the new open couldn't keep is never written over.
    if (!this.keepSkipFile()) return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
    try {
      db.tx(() => {
        skip.add({ chatKey, name: chat.name, kind: chat.kind, addedAt: this.ctx.clock.iso() });
        skip.writeMirror();
      });
      this.wrote();
    } catch (e) {
      this.log.error('messages: a skip was not saved', { error: errorKind(e) });
      // The mirror may have been written before the commit failed: the table it rolled back to again.
      this.mirror();
      return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
    }
    this.log.info('messages: a chat is skipped', { chatKey, by: actor.kind });
    return OK;
  }

  private skipRemove(chatKey: string, actor: Actor): LifeResult {
    // Removing widens what Jantar reads: the Mac's own CLI only, whatever route got here.
    if (actor.kind !== 'cli') return { ok: false, code: 'forbidden', reason: MESSAGES_SAYS.skipRemoveMacOnly };
    const { db, skip } = this.need();
    if (!skip.list().some((e) => e.chatKey === chatKey)) return { ok: false, code: 'not_found', reason: MESSAGES_SAYS.notSkipped };
    if (!this.keepSkipFile()) return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
    try {
      db.tx(() => {
        skip.remove(chatKey);
        skip.writeMirror();
      });
      this.wrote();
    } catch (e) {
      this.log.error('messages: a skip was not removed', { error: errorKind(e) });
      // A mirror written before a failed commit would leave the chat readable: the table it rolled back to again.
      this.mirror();
      return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
    }
    this.log.info('messages: a chat is read again', { chatKey });
    return OK;
  }

  // ---------------------------------------------------------------- the morning run

  /** The Life zone (Life's own; its setting, else the Mac's, while Life isn't there). */
  private zone(): string {
    try {
      const tz = this.deps.life.status().timezone;
      if (tz) return tz;
    } catch {
      // Life not built: the setting, else the Mac's zone.
    }
    const s = this.ctx.settings.get().life.timezone;
    return s && isValidTimeZone(s) ? s : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  }

  /** The timer's question: WhatsApp open and quiet (no -wal: its database is closed, nothing reads yet). */
  private async whatsAppReady(): Promise<WhatsAppReady> {
    const w = (await this.reader.call('status', {})).whatsapp;
    const wal = w.walMtime === null ? Number.NaN : Date.parse(w.walMtime);
    return { running: w.found && w.schemaOk && w.running, walQuietMs: Number.isNaN(wal) ? 0 : Math.max(0, this.ctx.clock.now() - wal) };
  }

  /** The timer's run: the day is marked once a run went well; a refusal (a Run now going, Messages off) is logged. */
  private async timerRun(stale: boolean, day: string): Promise<void> {
    let run: MorningRun;
    try {
      run = await this.morningRun('timer', stale);
    } catch (e) {
      this.log.warn('messages: the morning run did not start', { event: 'messages.morning', error: errorKind(e) });
      return;
    }
    if (run.state === 'ok') this.db?.setMeta(LAST_DAY_KEY, day);
  }

  /** messages.db is still the one the run started with; else the run's answer is dropped. */
  private live(db: MessagesDb): void {
    if (this.db !== db) throw new ApiError('messages_unavailable', this.brokenReason ?? MESSAGES_SAYS.off);
  }

  /**
   * One run (see the file comment). `timerStale`: the timer's say on
   * WhatsApp's freshness; otherwise stale when WhatsApp isn't running.
   */
  private async morningRun(trigger: MorningTrigger, timerStale?: boolean): Promise<MorningRun> {
    const { db } = this.need();
    if (this.readOnly) throw new ApiError('forbidden', MESSAGES_SAYS.morningReadOnly);
    if (this.going) throw new ApiError('conflict', MESSAGES_SAYS.morningBusy);
    this.needReads();
    const going = { id: newId(), abort: new AbortController() };
    this.going = going;
    try {
      const base: MorningRun = { id: going.id, at: this.ctx.clock.iso(), trigger, state: 'running', stale: false, newestAt: null, counts: NO_COUNTS, dropped: [], todoIds: [] };
      putRun(db, base);
      let run: MorningRun;
      try {
        run = await this.morningPass(db, base, timerStale, going.abort.signal);
      } catch (e) {
        this.live(db);
        if (!(e instanceof ReaderFailure)) this.log.error('messages: the morning run failed', { event: 'messages.morning', error: errorKind(e) });
        run = { ...base, state: 'failed', why: morningFailSays(e) };
      }
      putRun(db, run);
      const c = run.counts;
      this.log.info('messages: a morning run', { event: 'messages.morning', runId: run.id, trigger, state: run.state, stale: run.stale, ...c });
      if (run.state === 'ok' && trigger !== 'dry' && c.todos + c.replies + c.callbacks > 0) {
        void pushNotice(this.ctx, this.send, morningPush({ todos: c.todos, replies: c.replies, callbacks: c.callbacks }));
      }
      return run;
    } finally {
      if (this.going === going) this.going = null;
    }
  }

  private async morningPass(db: MessagesDb, base: MorningRun, timerStale: boolean | undefined, signal: AbortSignal): Promise<MorningRun> {
    const dry = base.trigger === 'dry';
    const st = await this.reader.call('status', {});
    this.live(db);
    const now = new Date(this.ctx.clock.now());
    const tz = this.zone();
    const batch = await collect(this.reader, readCursor(db), now);
    this.live(db);
    const { kept, dropped } = budget(batch);
    const head: MorningRun = {
      ...base,
      stale: timerStale ?? !st.whatsapp.running,
      newestAt: st.whatsapp.newestAt ?? batch.newestAt,
      counts: {
        ...NO_COUNTS,
        chats: kept.chats.length,
        messages: kept.chats.reduce((n, c) => n + c.messages.length, 0),
        calls: kept.calls.length,
        dropped: dropped.reduce((n, d) => n + d.left, 0),
      },
      dropped: dropped.slice(0, REPORT_DROPPED_MAX),
      // A calls store the run couldn't read: its missed calls aren't in it.
      ...(batch.waCalls ? {} : { waCalls: false as const }),
      ...(batch.phone ? {} : { phoneCalls: false as const }),
    };
    // Nothing new: no Claude run.
    if (kept.chats.length === 0 && kept.calls.length === 0) return this.ranWell(db, batch, { ...head, state: 'ok', ...(dry ? { preview: NO_PREVIEW } : {}) });
    const { text, refs } = morningInput(kept, { now, tz, ownerName: OWNER_NAME });
    const images = await morningImages(pickImages(kept, refs), { reader: this.reader, messagesDir: this.ctx.paths.messagesDir, shrinker: this.shrinker, log: this.log });
    this.live(db);
    // What goes to Claude, in the read log: each chat and the calls.
    for (const c of kept.chats) this.logRead('morning', { via: 'morning' }, c.chat.chatKey, c.messages.length + c.earlier.length);
    if (kept.calls.length > 0) this.logRead('morning', { via: 'morning' }, undefined, kept.calls.length);
    const r = await runMorning({ ctx: this.ctx, usage: this.deps.usage, ccwLegacy: this.deps.ccwLegacy, log: this.log, learned: this.learned }, { text, images }, signal);
    this.live(db);
    if (!r.ok) return { ...head, state: 'failed', why: CLAUDE_SAYS[r.why] };
    const applied = applyMorning(r.answer, refs, kept, { life: this.deps.life, db, now, tz, prefs: readPrefs(db), runId: base.id, dryRun: dry });
    const summary = r.answer.summary.replace(LINE_END, '\n').replace(CONTROL, '').trim();
    return this.ranWell(db, batch, {
      ...head,
      state: 'ok',
      counts: { ...head.counts, todos: applied.todos.length, replies: applied.replies.length, callbacks: applied.callbacks.length },
      todoIds: applied.todos.flatMap((t) => (t.id ? [t.id] : [])),
      ...(summary ? { summary } : {}),
      ...(dry ? { preview: previewOf(applied) } : {}),
    });
  }

  /** A run that went well: the cursor moves on (a dry run's never does). */
  private ranWell(db: MessagesDb, batch: Batch, run: MorningRun): MorningRun {
    if (run.trigger !== 'dry') writeCursor(db, batch.cursor);
    return run;
  }

  private setPrefs(p: Partial<MessagesPrefs>, actor: Actor): LifeResult {
    const { db } = this.need();
    const sent = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
    const next = MessagesPrefsSchema.safeParse({ ...readPrefs(db), ...sent });
    if (!next.success) return { ok: false, code: 'invalid_request', reason: MESSAGES_SAYS.badPrefs };
    writePrefs(db, next.data);
    this.timer.rearm();
    this.log.info('messages: the morning times changed', { by: actor.kind, morning: next.data.morningAt !== null, callback: next.data.callbackAt !== null });
    return OK;
  }

  /** The newest run (not a dry one), the open reply drafts and the call-back todos still open, newest first. */
  private today(): MessagesTodayResponse {
    const { db } = this.need();
    const rows = db.prepare("SELECT id, run_id, chat_key, chat_name, phone, they_asked, draft, at, state FROM drafts WHERE state = 'open' ORDER BY at DESC, rowid DESC LIMIT ?").all(TODAY_MAX) as unknown as DraftRow[];
    const drafts = rows.flatMap((r): Draft[] => {
      const d = DraftSchema.safeParse({
        id: r.id,
        runId: r.run_id,
        chatKey: r.chat_key,
        chatName: r.chat_name,
        ...(r.phone !== null ? { phone: r.phone } : {}),
        theyAsked: r.they_asked,
        draft: r.draft,
        at: r.at,
        state: r.state,
      });
      return d.success ? [d.data] : [];
    });
    return { run: newestRun(db, true), drafts, callbacks: this.callbacks(db) };
  }

  /** The call-back todos the morning made that are still open in Life (who: the title after CALLBACK_TITLE; at: when it rings). */
  private callbacks(db: MessagesDb): MessagesTodayResponse['callbacks'] {
    const ids = (db.prepare("SELECT target_id FROM made WHERE kind = 'callback' AND target_id IS NOT NULL ORDER BY rowid DESC").all() as { target_id: string }[]).map((r) => r.target_id);
    if (ids.length === 0) return [];
    let open;
    try {
      open = this.deps.life.todos.listTodos({ done: false });
    } catch {
      return [];
    }
    if (!open.ok) return [];
    const byId = new Map(open.value.todos.map((t) => [t.id, t]));
    const tz = this.zone();
    const out: MessagesTodayResponse['callbacks'] = [];
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) continue;
      const who = t.title.startsWith(CALLBACK_TITLE) ? t.title.slice(CALLBACK_TITLE.length) : t.title;
      out.push({ todoId: id, who, ...(t.due?.time ? { at: instantAt(t.due.day, t.due.time, tz).toISOString() } : {}) });
      if (out.length >= TODAY_MAX) break;
    }
    return out;
  }

  private setDraft(id: string, state: DraftState, actor: Actor): LifeResult {
    const { db } = this.need();
    const r = db.prepare('UPDATE drafts SET state = ? WHERE id = ?').run(state, id);
    if (Number(r.changes) === 0) return { ok: false, code: 'not_found', reason: MESSAGES_SAYS.noDraft };
    this.log.info('messages: a reply draft changed', { draftId: id, state, by: actor.kind });
    return OK;
  }

  private undo(runId: string, actor: Actor): LifeResult {
    const { db } = this.need();
    if (this.going?.id === runId) return { ok: false, code: 'conflict', reason: MESSAGES_SAYS.morningBusy };
    const r = undoMorning({ life: this.deps.life, db }, runId, actor);
    if (!r.ok) return r;
    this.log.info('messages: a morning run was undone', { runId, removed: r.value.removed, dismissed: r.value.dismissed, by: actor.kind });
    return OK;
  }

  // ---------------------------------------------------------------- messages.db

  /** messages.db and the skip list, open; else ApiError messages_unavailable (broken, or Messages off). */
  private need(): { db: MessagesDb; skip: SkipStore } {
    if (this.db && this.skipStore) return { db: this.db, skip: this.skipStore };
    throw new ApiError('messages_unavailable', this.brokenReason ?? MESSAGES_SAYS.off);
  }

  /**
   * As need(), before a read: fails closed until skip.json has been written
   * since open (to the reader a missing file is an empty list), and writes
   * it again first when it is gone or changed since (one stat).
   */
  private needReads(): void {
    this.need();
    if ((!this.mirrored || this.mirrorMoved()) && !this.mirror()) {
      throw new ApiError('messages_unavailable', this.skipFile === 'locked' ? MESSAGES_SAYS.skipUnreadable : MESSAGES_SAYS.noMirror);
    }
  }

  /** The reader counts `skipped` keys, or skip.json isn't the one last written; false while messages.db is closed. */
  private mirrorDiffers(skipped: number): boolean {
    try {
      return this.skipStore !== null && (skipped !== this.skipStore.count() || this.mirrorMoved());
    } catch {
      return false;
    }
  }

  /** skip.json isn't the one last written (deleted, replaced or edited). */
  private mirrorMoved(): boolean {
    return this.skipStore !== null && this.skipStore.stamp() !== this.mirrorStamp;
  }

  /** skip.json was just written. */
  private wrote(): void {
    this.mirrored = true;
    this.mirrorStamp = this.skipStore?.stamp() ?? null;
  }

  private logRead(op: string, by: ReadBy, chatKey: string | undefined, count: number): void {
    addRead(this.need().db, {
      at: this.ctx.clock.iso(),
      via: by.via,
      ...(by.pid !== undefined ? { pid: by.pid } : {}),
      ...(by.folder ? { folder: by.folder } : {}),
      op,
      ...(chatKey ? { chatKey } : {}),
      count,
    });
  }

  /** skip.json from messages.db; false (logged by code) when it can't be written, or its own keys won't read. */
  private mirror(): boolean {
    if (!this.skipStore || !this.keepSkipFile()) return false;
    try {
      this.skipStore.writeMirror();
      this.wrote();
      return true;
    } catch (e) {
      this.log.error('messages: the skip list mirror was not written', { error: errorKind(e) });
      return false;
    }
  }

  private open(): void {
    if (this.db) return;
    const r = openMessagesDb(this.dbFile);
    if (!r.ok) {
      this.brokenReason = r.reason;
      this.log.error('messages is broken', { event: 'messages.broken', code: r.code });
      return;
    }
    this.brokenReason = null;
    this.db = r.db;
    this.skipStore = createSkipStore(r.db, this.ctx.paths.messagesDir);
    // Before any read: the reader enforces what the daemon lists.
    this.mirror();
    try {
      // Runs the daemon stopped during.
      const stopped = failRunning(r.db, MESSAGES_SAYS.morningRestarted);
      if (stopped > 0) this.log.warn('messages: morning runs stopped by a restart', { count: stopped });
    } catch (e) {
      this.log.error('messages: the morning runs were not read', { error: errorKind(e) });
    }
    // The morning run spends quota: never on its own under --read-only.
    if (!this.readOnly) this.timer.start();
  }

  /**
   * The keys skip.json lists, in the table (once per open). A new or reset
   * messages.db keeps what it still lists (it never empties by itself); a
   * file that won't open (permissions, a disk error), or keys messages.db
   * won't take, are tried again before every write of it, which waits until
   * they go in.
   */
  private keepSkipFile(): boolean {
    if (this.skipFile === 'read') return true;
    if (!this.skipStore) return false;
    try {
      const kept = this.skipStore.keep(this.ctx.clock.iso());
      if (kept > 0) this.log.warn('messages: kept skipped chats the skip list file listed', { count: kept });
      this.skipFile = 'read';
      return true;
    } catch (e) {
      if (this.skipFile === 'unread') this.log.error("messages: the skip list file's keys were not kept", { error: errorKind(e) });
      this.skipFile = e instanceof SkipFileUnreadable ? 'locked' : 'unsaved';
      return false;
    }
  }

  private close(): void {
    this.timer.stop();
    this.going?.abort.abort();
    this.reader.close();
    this.mirrored = false;
    this.mirrorStamp = null;
    this.skipFile = 'unread';
    this.skipStore = null;
    this.db?.close();
    this.db = null;
    this.brokenReason = null;
  }

  private onSettings(next: Settings, prev: Settings): void {
    // The Life zone moved the morning time: once Life has taken the change (its own subscriber).
    if (next.life.timezone !== prev.life.timezone) queueMicrotask(() => this.timer.rearm());
    if (next.messages.enabled === prev.messages.enabled) return;
    if (next.messages.enabled) this.open();
    else this.close();
  }
}

/** The Messages part; daemon.ts uses createMessagesService (index.ts). */
export function buildMessagesService(ctx: DaemonContext, deps: MessagesDeps, opts: MessagesOptions = {}): MessagesService {
  return new MessagesShell(ctx, deps, opts);
}
