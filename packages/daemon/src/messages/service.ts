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
 *   empty list). A skip.json that won't open or that the reader would
 *   refuse, or whose keys messages.db won't take, is never written over (it
 *   may be the only list): reads and skip changes are refused until its
 *   keys are in.
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
 *   counts only. Every chat sent to Claude is in the read log, under who
 *   started it (Run now and a dry run: the CLI, a session or the phone; the
 *   timer: `morning`), and in run_chats. A skip added while a run is going
 *   stops it (stored failed, nothing made), whatever step it is at, when
 *   the run collected that chat (or a call with it); before the run has
 *   collected, as soon as it has. Before it applies, the drafts of chats
 *   the owner has written to since are dismissed; with Life's Todos off it
 *   drafts replies only.
 * - A skip takes from view what the morning made from that chat: its open
 *   drafts are dismissed and a run that read it loses its summary (in the
 *   skip's transaction), then its open todos and call-backs leave Life, as
 *   Undo takes them (as whoever skipped it). Today leaves out a skipped
 *   chat's drafts and call-backs whatever happened before. The chat is
 *   owed to Life (SKIP_OWED_KEY, written in the skip's transaction) until
 *   its todos went: while life.db is closed (never opened since the daemon
 *   started, every Life module and People off; or Life broken) the skip
 *   still answers at once, with MESSAGES_SAYS.skipTodosLater, and they are
 *   tried again (as the system, but at a skip of that chat) as life.db
 *   opens (LifeService.onOpen, before its first sweep), as messages.db
 *   opens, at every skip, status() and Today, and before a morning run that
 *   isn't dry (settleOwed). As life.db and messages.db open, every skipped
 *   chat's open todos and call-backs go too, so a restored Life backup
 *   made before a skip can't bring them back (clearSkipped).
 * - The morning timer (morning/timer.ts) runs while messages.db is open
 *   (never under --read-only), at the morning time in the Life zone; a time
 *   or zone change rearms it, a run refused (another going) is asked for
 *   again, and a timer run that went well marks its morning's due time.
 * - Reads need messages.db open (each is logged there: via, the MCP
 *   caller's pid and folder, the op, the chat key, a count) and answer the
 *   reader's data or throw its ReaderFailure; one that finds messages.db
 *   closed after its await drops the answer (ApiError messages_unavailable).
 * - status() asks the reader whatever the switch says (setup polls it) and
 *   never throws: not_installed (no reader built), update_needed (a reader
 *   built from another source, or speaking another protocol version), down
 *   (its sentence names the fix), then the reader's own flags. It carries
 *   messages.db's broken sentence, and the morning times only while
 *   messages.db is open (else unknown).
 * - Calls to return leave out a calls store the reader may not or can't
 *   read, as the morning run does, and say which (waCalls, phoneCalls).
 * - Today lists each run of the Life zone's day that made something, so
 *   each keeps its Undo.
 * - Nothing here logs a name, a number or text: chat keys and counts only.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dayKeyOf, instantAt, isValidTimeZone } from '@jantar/life-core';
import { MESSAGES_LIMITS, type Settings } from '@jantar/protocol';
import {
  ChatKeySchema,
  DraftSchema,
  MessagesPrefsSchema,
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
  type MessagesSkipReset,
  type MessagesStatus,
  type MessagesTodayResponse,
  type MorningPreview,
  type MorningRun,
  type MorningTrigger,
  type ReadLogEntry,
  type SkipEntry,
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
import { SYSTEM_ACTOR } from '../core/actor.js';
import { newId } from '../core/ids.js';
import type { ClaudeFail } from '../intel/read/claude.js';
import { MediaHelper } from '../intel/read/media.js';
import { createLifeSend, morningPush, pushNotice, type LifeSend } from '../life/push.js';
import { CONTROL, LINE_END } from '../rewrite/guards.js';
import {
  LAST_MORNING_KEY,
  PASSED_MORNING_KEY,
  READS_KEEP,
  addRead,
  addRunChats,
  failRunning,
  forgetChat,
  lastRunAt,
  listReads,
  madeRuns,
  newestRun,
  openMessagesDb,
  putRun,
  readCursor,
  readOwed,
  readPrefs,
  writeCursor,
  writeOwed,
  writePrefs,
  type MessagesDb,
} from './db.js';
import { clearJobs, mediaAnswer, type ImageShrinker } from './media.js';
import { CALLBACK_TITLE, applyMorning, dismissAnswered, removeChatTodos, removeSkippedTodos, undoMorning, type ApplyResult } from './morning/apply.js';
import { budget, droppedReport } from './morning/budget.js';
import { callsFrom, collect, missedCalls, type Batch } from './morning/collect.js';
import { OWNER_NAME, morningInput } from './morning/input.js';
import { morningImages, pickImages, runMorning } from './morning/run.js';
import { MorningTimer, type NextMorning, type WhatsAppReady } from './morning/timer.js';
import { ReaderFailure, createReaderClient, type ReaderClient } from './reader-client.js';
import { READER_CHATS_MAX, READER_KEYS_MAX, READER_SOURCE, READER_VERSION, readerSourceKey, type ReaderChats, type ReaderStatus } from './reader-protocol.js';
import { MESSAGES_SAYS, readerSays } from './says.js';
import { SKIP_KEPT_NAME, SkipFileUnreadable, createSkipStore, saltLost, type LostEntry, type SkipStore } from './skip.js';

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
/** The reader's longest chat name to look for (its `q`). */
const NAME_MAX = 100;
/** A name as the reader matches it: case and accents aside. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Today's drafts and call-backs, at most. */
const TODAY_MAX = 50;
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

/** The run going, when a skip of a chat it read lands: it stops (see Going). */
class SkippedDuringRun extends Error {
  constructor() {
    super('a chat was skipped during the morning run');
    this.name = 'SkippedDuringRun';
  }
}

/**
 * The morning run going. `skips`: chats skipped since it started; `chats`:
 * those it collected (and its calls' 1:1s), null until it has; `skipped`
 * once one of them is skipped (it then stops and makes nothing).
 */
interface Going {
  id: string;
  abort: AbortController;
  skips: Set<string>;
  chats: Set<string> | null;
  skipped: boolean;
}

/** A skip that hits the run's chats stops it. */
function hit(going: Going): void {
  if (going.skipped || going.chats === null) return;
  for (const k of going.skips) {
    if (!going.chats.has(k)) continue;
    going.skipped = true;
    going.abort.abort();
    return;
  }
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
  private going: Going | null = null;
  /** The morning (its due time) whose refused timer run was logged: once each, the timer asks every minute. */
  private refusedLogged: number | null = null;

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
      reset: (o, actor) => this.skipReset(o, actor),
    };
    this.send = opts.send ?? createLifeSend(ctx, deps.notifiers ?? []);
    this.timer = new MorningTimer(ctx.clock, this.log, {
      tz: () => this.zone(),
      at: () => (this.db ? readPrefs(this.db).morningAt : null),
      // The newer of a timer run's mark and a new time's (passed).
      lastAt: () => {
        const marks = [LAST_MORNING_KEY, PASSED_MORNING_KEY].map((k) => Date.parse(this.db?.meta(k) ?? '')).filter((ms) => !Number.isNaN(ms));
        return marks.length > 0 ? Math.max(...marks) : null;
      },
      passed: (dueAt) => this.morningPassed(dueAt),
      ready: () => this.whatsAppReady(),
      run: (stale, morning) => this.timerRun(stale, morning),
    });
    // As life.db opens (a start, a switch, a restore), before its first sweep could ring one: a skipped chat's todos go,
    // those still owed and those a restored backup brought back.
    try {
      deps.life.onOpen(() => {
        if (this.db) this.clearSkipped(this.db);
      });
    } catch {
      // A stand-in Life (a node's parts, a test's) never opens.
    }
    this.morning = {
      prefs: () => readPrefs(this.need().db),
      setPrefs: (p, actor) => this.setPrefs(p, actor),
      run: (o) => this.morningRun(o.trigger, { by: o.by ?? { via: 'morning' } }),
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
    let skipUnmatched: number | undefined;
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
        if (st.skipUnmatched !== undefined) skipUnmatched = st.skipUnmatched;
      } catch (e) {
        // A reader that won't start over a skip list its lost salt can't match says why.
        if (installed !== 'stale' && this.saltGone()) reader = { state: 'down', detail: MESSAGES_SAYS.saltLost };
        else reader = installed === 'stale' ? { state: 'update_needed', detail: MESSAGES_SAYS.updateNeeded } : this.failedLine(e);
      }
    }
    const db = this.db;
    // Life may answer again: what a skip still owes it goes.
    if (db) this.settleOwed(db);
    const safe = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    return {
      enabled: this.ctx.settings.get().messages.enabled,
      ...(this.brokenReason ? { broken: this.brokenReason } : {}),
      reader,
      whatsapp,
      phone,
      skipped: this.skipStore ? safe(() => this.skipStore!.list().length, readerSkipped) : readerSkipped,
      ...(skipUnmatched !== undefined ? { skipUnmatched } : {}),
      // Unknown while messages.db is closed (off, or broken): never "off, never ran".
      morning: db ? safe(() => ({ at: readPrefs(db).morningAt, lastRunAt: lastRunAt(db) }), null) : null,
    };
  }

  /** The reader answered: what its flags say, the first that applies. */
  private readerLine(st: ReaderStatus): ReaderLine {
    if (!st.whatsapp.found) return { state: 'ok', detail: MESSAGES_SAYS.noWhatsApp };
    if (!st.whatsapp.schemaOk) return { state: 'unsupported', detail: MESSAGES_SAYS.unsupported };
    if (!st.whatsapp.contactsOk) return { state: 'no_access', detail: MESSAGES_SAYS.contacts };
    if (this.resetGoing()) return { state: 'ok', detail: MESSAGES_SAYS.skipResetLeft };
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

  /**
   * The reader didn't answer status. Its answer not checking is a reader of
   * another build; down, or hung (a timeout: setup restarts it), its own
   * sentence names the fix, never status itself (the 503s keep
   * MESSAGES_SAYS.down and MESSAGES_SAYS.timeout).
   */
  private failedLine(e: unknown): ReaderLine {
    const code = e instanceof ReaderFailure ? e.code : 'down';
    switch (code) {
      case 'no_access':
        return { state: 'no_access', detail: readerSays(code, e instanceof ReaderFailure ? e.detail : undefined) ?? MESSAGES_SAYS.noAccess };
      case 'unsupported':
        return { state: 'update_needed', detail: MESSAGES_SAYS.updateNeeded };
      case 'down':
      case 'timeout':
        return { state: 'down', detail: MESSAGES_SAYS.readerDown };
      default:
        return { state: 'down', detail: readerSays(code) ?? MESSAGES_SAYS.readerDown };
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
    // As the morning run: a store refused (the iPhone's without Full Disk Access) or changed by an update is left out, and named.
    const wa = await callsFrom(this.reader, 'waCalls', since);
    const phone = await callsFrom(this.reader, 'phoneCalls', since);
    const calls = [...wa.calls, ...phone.calls].filter((c) => Date.parse(c.at) >= sinceMs);
    const keys = [...new Set(calls.flatMap((c) => (c.incoming && c.missed && c.chatKey ? [c.chatKey] : [])))];
    const wrote: Record<string, string | null> = {};
    for (let i = 0; i < keys.length; i += READER_KEYS_MAX) Object.assign(wrote, await this.reader.call('lastFromMe', { chatKeys: keys.slice(i, i + READER_KEYS_MAX) }));
    // Returned (the morning run's rule too): a later message from the owner, a later call the owner made, or a later call that connected.
    const open = missedCalls(calls, wrote).filter((c) => !c.returned);
    open.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    this.logRead('calls', by, undefined, open.length);
    return {
      calls: open.map((c) => ({ ...c, returned: false as const })),
      ...(wa.read ? {} : { waCalls: false as const }),
      ...(phone.read ? {} : { phoneCalls: false as const }),
    };
  }

  reads(limit: number): ReadLogEntry[] {
    return listReads(this.need().db, Math.max(1, Math.min(Math.floor(limit), READS_KEEP)));
  }

  // ---------------------------------------------------------------- skip list

  private async skipAdd(chatKey: string, actor: Actor): Promise<LifeResult<{ note?: string }>> {
    if (!ChatKeySchema.safeParse(chatKey).success) return { ok: false, code: 'invalid_request', reason: MESSAGES_SAYS.notAChat };
    const was = this.need();
    if (was.skip.list().some((e) => e.chatKey === chatKey)) return { ok: true, value: this.skipNote(this.settleOwed(was.db, { chatKey, actor }), chatKey) };
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
    let dismissed = 0;
    try {
      db.tx(() => {
        skip.add({ chatKey, name: chat.name, kind: chat.kind, addedAt: this.ctx.clock.iso() });
        skip.writeMirror();
        dismissed = forgetChat(db, chatKey);
        // Its todos and call-backs are owed to Life until they went (settleOwed): a Life that refuses now can't lose them.
        writeOwed(db, [...readOwed(db), chatKey]);
      });
      this.wrote();
    } catch (e) {
      this.log.error('messages: a skip was not saved', { error: errorKind(e) });
      // The mirror may have been written before the commit failed: the table it rolled back to again.
      this.mirror();
      return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
    }
    // A run going that read the chat (or will find it read, once it has collected): it stops, and makes nothing.
    if (this.going) {
      this.going.skips.add(chatKey);
      hit(this.going);
    }
    const owed = this.settleOwed(db, { chatKey, actor });
    const later = owed.left.includes(chatKey);
    // removed -1: Life refused, its todos owed till it answers.
    this.log.info('messages: a chat is skipped', { chatKey, by: actor.kind, dismissed, removed: later ? -1 : (owed.removed ?? 0) });
    return { ok: true, value: this.skipNote(owed, chatKey) };
  }

  /** The skip's answer: says when `chatKey`'s todos are still owed to Life. */
  private skipNote(owed: { left: readonly string[] }, chatKey: string): { note?: string } {
    return owed.left.includes(chatKey) ? { note: MESSAGES_SAYS.skipTodosLater } : {};
  }

  /**
   * Each skipped chat still owed to Life (SKIP_OWED_KEY): the open todos and
   * call-backs the morning made from it leave Life (removeChatTodos, as Undo
   * takes them), and it is owed no more once they went. Life refusing (life.db
   * closed, or broken) leaves it owed, quietly: this runs on every status()
   * poll. `just`: the chat a skip is for, removed as whoever skipped it, its
   * count in `removed` for the skip's own log line; every other chat goes as
   * the system (nobody asked for it now), logged here. `left`: the chats
   * still owed. Never throws.
   */
  private settleOwed(db: MessagesDb, just?: { chatKey: string; actor: Actor }): { left: string[]; removed?: number } {
    let owed: string[];
    try {
      owed = readOwed(db);
    } catch (e) {
      this.log.warn('messages: the skipped chats owed to Life were not read', { error: errorKind(e) });
      return { left: [] };
    }
    if (owed.length === 0) return { left: owed };
    let removed: number | undefined;
    const left = owed.filter((chatKey) => {
      let r: LifeResult<number>;
      try {
        r = removeChatTodos({ life: this.deps.life, db }, chatKey, chatKey === just?.chatKey ? just.actor : SYSTEM_ACTOR);
      } catch {
        return true;
      }
      if (!r.ok) return true;
      if (chatKey === just?.chatKey) removed = r.value;
      else this.log.info("messages: a skipped chat's todos left Life", { chatKey, removed: r.value });
      return false;
    });
    if (left.length < owed.length) {
      try {
        writeOwed(db, left);
      } catch (e) {
        // Still marked: the next try finds nothing open of them, and clears it.
        this.log.warn('messages: the skipped chats owed to Life were not saved', { error: errorKind(e) });
      }
    }
    return { left, ...(removed !== undefined ? { removed } : {}) };
  }

  /**
   * As life.db or messages.db opens: what a skip still owes Life goes
   * (settleOwed), and so does every skipped chat's open todo and call-back a
   * restored Life backup made before its skip brought back (removeSkippedTodos,
   * as the system). Only a skipped chat the morning made something from costs
   * a look at Life. Life refusing is quiet. Never throws.
   */
  private clearSkipped(db: MessagesDb): void {
    this.settleOwed(db);
    let r: LifeResult<number>;
    try {
      r = removeSkippedTodos({ life: this.deps.life, db }, SYSTEM_ACTOR);
    } catch (e) {
      this.log.warn("messages: the skipped chats' todos were not looked for", { error: errorKind(e) });
      return;
    }
    if (r.ok && r.value > 0) this.log.info("messages: skipped chats' todos left Life again", { removed: r.value });
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

  /**
   * After the reader's salt was lost (the reader won't start over keys it
   * can't match): the old keys go at once, set aside by name and kind, so it
   * can start with a new salt; then each is looked for in the chats and
   * every chat of that exact name and kind is skipped again (a shared name
   * skips each: more hidden, never less). Reads stay refused while any is
   * left, until the owner lets them go (`forget`, answered with their names)
   * and skips them by hand; `forget` is refused until a lookup went through
   * with the reader back, so it never empties a list nobody looked for.
   * `waiting` while the reader isn't back. The Mac's CLI only.
   */
  private async skipReset(o: { forget?: boolean }, actor: Actor): Promise<LifeResult<MessagesSkipReset>> {
    // It drops every key on the list: the Mac's own CLI only, whatever route got here.
    if (actor.kind !== 'cli') return { ok: false, code: 'forbidden', reason: MESSAGES_SAYS.skipResetMacOnly };
    const { skip } = this.need();
    let left = skip.resetLeft();
    if (left === null) {
      if (!skip.saltLost()) return { ok: false, code: 'conflict', reason: MESSAGES_SAYS.skipResetNotNeeded };
      // Nothing looked up yet: nothing to let go.
      if (o.forget === true) return { ok: false, code: 'conflict', reason: MESSAGES_SAYS.skipForgetFirst };
      try {
        // Over a skip.json that won't read too: its keys were made with the lost salt.
        left = skip.resetStart();
        this.skipFile = 'read';
        this.wrote();
      } catch (e) {
        this.log.error('messages: the skip list was not reset', { error: errorKind(e) });
        this.mirror();
        return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
      }
      this.log.warn('messages: the skip list was reset after the salt was lost', { count: left.length });
    }
    if (o.forget === true) {
      // Only what a lookup with the reader back couldn't find (not while it is coming back).
      if (!skip.resetLooked()) return { ok: false, code: 'conflict', reason: MESSAGES_SAYS.skipForgetFirst };
      try {
        skip.setResetLeft([]);
      } catch (e) {
        this.log.error('messages: the skip list reset was not ended', { error: errorKind(e) });
        return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
      }
      if (left.length > 0) this.log.warn('messages: chats not found after a reset were let go', { count: left.length });
      // Named, so the owner knows which to skip again by hand.
      return { ok: true, value: { skipped: [], left: [], forgot: left, waiting: false } };
    }

    const found = new Map<string, SkipEntry>();
    const still: LostEntry[] = [];
    let waiting = false;
    for (const e of left) {
      if (waiting || e.name === SKIP_KEPT_NAME || e.name.length > NAME_MAX) {
        still.push(e);
        continue;
      }
      let r: ReaderChats;
      try {
        // Names only, to find each chat: never logged or kept beyond its entry.
        r = await this.reader.call('chats', { q: e.name, limit: READER_CHATS_MAX });
      } catch (err) {
        if (!(err instanceof ReaderFailure)) throw err;
        // A name the reader won't take is left to the owner; anything else, the reader isn't back yet.
        if (err.code !== 'bad_request' && err.code !== 'not_found') waiting = true;
        still.push(e);
        continue;
      }
      const same = r.chats.filter((c) => c.kind === e.kind && fold(c.name) === fold(e.name));
      for (const c of same) found.set(c.chatKey, { chatKey: c.chatKey, name: c.name, kind: c.kind, addedAt: this.ctx.clock.iso() });
      // Not found, or more chats hold the name than one answer lists (one of that name may be past them).
      if (same.length === 0 || r.total > r.chats.length) still.push(e);
    }
    // Messages may have gone off and on during the reads: the store open now.
    const { db, skip: now } = this.need();
    const skipped = [...found.values()].sort((a, b) => (a.chatKey < b.chatKey ? -1 : 1));
    try {
      db.tx(() => {
        for (const e of skipped) now.add(e);
        now.writeMirror();
        now.setResetLeft(still, !waiting);
      });
      this.wrote();
    } catch (e) {
      this.log.error('messages: the chats found after a reset were not skipped', { error: errorKind(e) });
      this.mirror();
      return { ok: false, code: 'unavailable', reason: MESSAGES_SAYS.skipWrite };
    }
    this.log.info('messages: chats skipped again after a reset', { count: skipped.length, left: still.length });
    return { ok: true, value: { skipped, left: still, waiting } };
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

  /**
   * The timer's run: its morning is marked once a run went well. A refusal
   * (another run going, Messages unavailable) is logged and answers false:
   * the timer asks again.
   */
  private async timerRun(stale: boolean, morning: NextMorning): Promise<boolean> {
    let run: MorningRun;
    try {
      run = await this.morningRun('timer', { stale, by: { via: 'morning' } });
    } catch (e) {
      if (this.refusedLogged !== morning.dueAt) this.log.warn('messages: the morning run did not start', { event: 'messages.morning', error: errorKind(e) });
      this.refusedLogged = morning.dueAt;
      return false;
    }
    if (run.state === 'ok') this.db?.setMeta(LAST_MORNING_KEY, new Date(morning.dueAt).toISOString());
    return true;
  }

  /** A new morning time left the morning due at `dueAt` as done: saved, so a restart inside its wait leaves it too. */
  private morningPassed(dueAt: number): void {
    try {
      this.db?.setMeta(PASSED_MORNING_KEY, new Date(dueAt).toISOString());
    } catch (e) {
      // Kept in the timer's memory still: only a restart today would run it.
      this.log.warn("messages: today's passed morning wasn't saved as done", { event: 'messages.morning', error: errorKind(e) });
    }
  }

  /** messages.db is still the one the run started with; else the run's answer is dropped. */
  private live(db: MessagesDb): void {
    if (this.db !== db) throw new ApiError('messages_unavailable', this.brokenReason ?? MESSAGES_SAYS.off);
  }

  /**
   * One run (see the file comment). `stale`: the timer's say on WhatsApp's
   * freshness; otherwise stale when WhatsApp isn't running. `by`: who
   * started it, for the read log.
   */
  private async morningRun(trigger: MorningTrigger, o: { stale?: boolean; by: ReadBy }): Promise<MorningRun> {
    const { db } = this.need();
    if (this.readOnly) throw new ApiError('forbidden', MESSAGES_SAYS.morningReadOnly);
    if (this.going) throw new ApiError('conflict', MESSAGES_SAYS.morningBusy);
    this.needReads();
    const going: Going = { id: newId(), abort: new AbortController(), skips: new Set(), chats: null, skipped: false };
    this.going = going;
    try {
      const base: MorningRun = { id: going.id, at: this.ctx.clock.iso(), trigger, state: 'running', stale: false, newestAt: null, counts: NO_COUNTS, dropped: [], todoIds: [] };
      putRun(db, base);
      let run: MorningRun;
      try {
        run = await this.morningPass(db, base, o, going);
      } catch (e) {
        this.live(db);
        if (!(e instanceof ReaderFailure) && !going.skipped) this.log.error('messages: the morning run failed', { event: 'messages.morning', error: errorKind(e) });
        run = { ...base, state: 'failed', why: morningFailSays(e) };
      }
      // A skip during the run: whatever stopped it (Claude aborted, a read refused), that is why.
      if (going.skipped && run.state !== 'ok') run = { ...base, state: 'failed', why: MESSAGES_SAYS.morningSkipped };
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

  private async morningPass(db: MessagesDb, base: MorningRun, o: { stale?: boolean; by: ReadBy }, going: Going): Promise<MorningRun> {
    const dry = base.trigger === 'dry';
    // What a skip still owes Life goes first (a dry run writes nothing).
    if (!dry) this.settleOwed(db);
    // After every wait: messages.db is still the run's, and no chat it collected was skipped.
    const still = () => {
      this.live(db);
      if (going.skipped) throw new SkippedDuringRun();
    };
    const st = await this.reader.call('status', {});
    still();
    const now = new Date(this.ctx.clock.now());
    const tz = this.zone();
    const batch = await collect(this.reader, readCursor(db), now);
    // What a skip from now on (or one since the run started) must not let through.
    going.chats = new Set([...batch.chats.map((c) => c.chat.chatKey), ...batch.calls.flatMap((c) => (c.chatKey ? [c.chatKey] : []))]);
    hit(going);
    still();
    const { kept, dropped } = budget(batch);
    const head: MorningRun = {
      ...base,
      stale: o.stale ?? !st.whatsapp.running,
      newestAt: st.whatsapp.newestAt ?? batch.newestAt,
      counts: {
        ...NO_COUNTS,
        chats: kept.chats.length,
        messages: kept.chats.reduce((n, c) => n + c.messages.length, 0),
        calls: kept.calls.length,
        dropped: dropped.reduce((n, d) => n + (d.call ? 0 : d.left), 0),
      },
      ...droppedReport(dropped),
      // A calls store the run couldn't read: its missed calls aren't in it.
      ...(batch.waCalls ? {} : { waCalls: false as const }),
      ...(batch.phone ? {} : { phoneCalls: false as const }),
    };
    // Nothing new: no Claude run.
    if (kept.chats.length === 0 && kept.calls.length === 0) return this.ranWell(db, batch, { ...head, state: 'ok', ...(dry ? { preview: NO_PREVIEW } : {}) });
    const { text, refs } = morningInput(kept, { now, tz, ownerName: OWNER_NAME });
    const images = await morningImages(pickImages(kept, refs), { reader: this.reader, messagesDir: this.ctx.paths.messagesDir, shrinker: this.shrinker, log: this.log });
    still();
    // What goes to Claude, in the read log under who started the run (each chat and the calls) and run_chats (a later skip of one takes the summary).
    for (const c of kept.chats) this.logRead('morning', o.by, c.chat.chatKey, c.messages.length + c.earlier.length);
    if (kept.calls.length > 0) this.logRead('morning', o.by, undefined, kept.calls.length);
    addRunChats(db, base.id, [...kept.chats.map((c) => c.chat.chatKey), ...kept.calls.flatMap((c) => (c.chatKey ? [c.chatKey] : []))]);
    const r = await runMorning({ ctx: this.ctx, usage: this.deps.usage, ccwLegacy: this.deps.ccwLegacy, log: this.log, learned: this.learned }, { text, images }, going.abort.signal);
    still();
    if (!r.ok) return { ...head, state: 'failed', why: CLAUDE_SAYS[r.why] };
    // Answered in WhatsApp itself since: off Today, before a new draft could join them.
    if (!dry) dismissAnswered(db, batch.wroteAt);
    // Claude and the pictures can take minutes: a due time must be ahead of now, not of the run's start.
    const applyAt = new Date(this.ctx.clock.now());
    const todosOn = this.ctx.settings.get().life.todos;
    const applied = applyMorning(r.answer, refs, kept, { life: this.deps.life, db, now, applyAt, tz, prefs: readPrefs(db), runId: base.id, dryRun: dry, todosOn });
    const summary = r.answer.summary.replace(LINE_END, '\n').replace(CONTROL, '').trim();
    return this.ranWell(db, batch, {
      ...head,
      state: 'ok',
      counts: { ...head.counts, todos: applied.todos.length, replies: applied.replies.length, callbacks: applied.callbacks.length },
      todoIds: applied.todos.flatMap((t) => (t.id ? [t.id] : [])),
      ...(applied.lifeRefused ? { lifeRefused: applied.lifeRefused } : {}),
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
    const before = readPrefs(db);
    const next = MessagesPrefsSchema.safeParse({ ...before, ...sent });
    if (!next.success) return { ok: false, code: 'invalid_request', reason: MESSAGES_SAYS.badPrefs };
    writePrefs(db, next.data);
    // A morning time already past today waits for tomorrow.
    if (next.data.morningAt !== before.morningAt) this.timer.retime();
    this.log.info('messages: the morning times changed', { by: actor.kind, morning: next.data.morningAt !== null, callback: next.data.callbackAt !== null });
    return OK;
  }

  /** The newest run (not a dry one), the Life zone day's runs that made something, the open reply drafts and the call-back todos still open, newest first; never a skipped chat's. */
  private today(): MessagesTodayResponse {
    const { db } = this.need();
    // Life may answer again: a skipped chat's todos owed to it go before Today lists anything.
    this.settleOwed(db);
    const rows = db
      .prepare("SELECT id, run_id, chat_key, chat_name, phone, they_asked, draft, at, state FROM drafts WHERE state = 'open' AND chat_key NOT IN (SELECT chat_key FROM skip) ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(TODAY_MAX) as unknown as DraftRow[];
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
    const tz = this.zone();
    const dayStart = instantAt(dayKeyOf(new Date(this.ctx.clock.now()), tz), '00:00', tz).toISOString();
    return { run: newestRun(db, true), made: madeRuns(db, dayStart), drafts, callbacks: this.callbacks(db) };
  }

  /** The call-back todos the morning made that are still open in Life, none from a skipped chat (who: the title after CALLBACK_TITLE; at: when it rings). */
  private callbacks(db: MessagesDb): MessagesTodayResponse['callbacks'] {
    const ids = (
      db
        .prepare("SELECT target_id FROM made WHERE kind = 'callback' AND target_id IS NOT NULL AND (chat_key IS NULL OR chat_key NOT IN (SELECT chat_key FROM skip)) ORDER BY rowid DESC")
        .all() as { target_id: string }[]
    ).map((r) => r.target_id);
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
    // A reset after a lost salt: nothing reads until its chats are skipped again.
    if (this.resetGoing()) throw new ApiError('messages_unavailable', MESSAGES_SAYS.skipResetLeft);
    if ((!this.mirrored || this.mirrorMoved()) && !this.mirror()) {
      throw new ApiError('messages_unavailable', this.skipFile === 'locked' ? MESSAGES_SAYS.skipUnreadable : MESSAGES_SAYS.noMirror);
    }
  }

  /** A reset after a lost salt has chats still to find (or its record won't read); false while messages.db is closed. */
  private resetGoing(): boolean {
    try {
      return this.skipStore !== null && this.skipStore.resetLeft() !== null;
    } catch {
      return this.skipStore !== null;
    }
  }

  /** The reader's salt is gone while the skip list holds keys made with it (skip.ts saltLost); with messages.db closed, skip.json's. */
  private saltGone(): boolean {
    try {
      return this.skipStore ? this.skipStore.saltLost() : saltLost(this.ctx.paths.messagesDir, 0);
    } catch {
      return false;
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
    // What a skip still owes Life (it was closed then, or Messages went off first), and what a restore brought back.
    this.clearSkipped(r.db);
    // The morning run spends quota: never on its own under --read-only.
    if (!this.readOnly) this.timer.start();
  }

  /**
   * The keys skip.json lists, in the table (once per open). A new or reset
   * messages.db keeps what it still lists (it never empties by itself); a
   * file that won't open (permissions, a disk error) or that the reader
   * would refuse (`locked`), or keys messages.db won't take (`unsaved`), are
   * tried again before every write of it, which waits until they go in.
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
