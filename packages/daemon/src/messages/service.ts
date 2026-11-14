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
 *   empty list). A skip.json that won't open is never written over (it may
 *   be the only list): reads and skip changes are refused until it opens.
 *   One deleted or changed by anyone else is written again before the next
 *   read and by status(); a change that fails rewrites it from the table it
 *   rolled back to.
 * - A job left in <messagesDir>/jobs by a crash goes at start.
 * - The morning run answers 501 (NotImplementedError) until it is built.
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
import { MESSAGES_LIMITS, type Settings } from '@jantar/protocol';
import {
  ChatKeySchema,
  type Call,
  type CallsToReturnResponse,
  type Chat,
  type MessagesAmbiguous,
  type MessagesChatsQuery,
  type MessagesChatsResponse,
  type MessagesReadQuery,
  type MessagesReadResponse,
  type MessagesSearchQuery,
  type MessagesSearchResponse,
  type MessagesStatus,
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
  ReadBy,
  Unsubscribe,
  UsageSource,
} from '../contracts.js';
import { notBuilt } from '../core/not-implemented.js';
import { MediaHelper } from '../intel/read/media.js';
import { READS_KEEP, addRead, lastRunAt, listReads, openMessagesDb, readPrefs, type MessagesDb } from './db.js';
import { clearJobs, mediaAnswer, type ImageShrinker } from './media.js';
import { missedCalls } from './morning/collect.js';
import { ReaderFailure, createReaderClient, type ReaderClient } from './reader-client.js';
import { READER_SOURCE, READER_VERSION, readerSourceKey, type ReaderStatus } from './reader-protocol.js';
import { MESSAGES_SAYS, readerSays } from './says.js';
import { createSkipStore, type SkipStore } from './skip.js';

export interface MessagesDeps {
  /** The morning run's todos. */
  life: LifeService;
  /** The morning run's Claude account. */
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
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
}

const DAY_MS = 86_400_000;
/** lastFromMe takes this many chat keys at once (reader-protocol.ts). */
const KEYS_PER_ASK = 500;
const OK: LifeResult = { ok: true, value: true };

type ReaderLine = MessagesStatus['reader'];
type Installed = 'missing' | 'stale' | 'ok';

/** An error's code or class name for a log line: never its message (it can carry a path). */
function errorKind(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}

const chatKeyOf = (msgKey: string) => msgKey.slice(0, msgKey.indexOf('.'));

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
  /** skip.json's keys are in the table since open ('failed': it wouldn't open, so nothing writes over it). */
  private skipFile: 'unread' | 'failed' | 'read' = 'unread';
  private brokenReason: string | null = null;
  private unsub: Unsubscribe | null = null;
  private sourceKeyRead: Promise<string | null> | null = null;
  private readonly log: Logger;
  private readonly dbFile: string;
  private readonly shrinker: ImageShrinker;
  readonly readOnly: boolean;

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
    this.morning = notBuilt<MorningApi>('The morning run');
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
    if (!st.skipOk || this.skipFile === 'failed') {
      // Ours to write again (the reader reads nothing meanwhile), once its own keys are in the table.
      this.mirror();
      if (this.skipFile === 'failed') return { state: 'ok', detail: MESSAGES_SAYS.skipLocked };
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
    for (let i = 0; i < keys.length; i += KEYS_PER_ASK) Object.assign(wrote, await this.reader.call('lastFromMe', { chatKeys: keys.slice(i, i + KEYS_PER_ASK) }));
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
      throw new ApiError('messages_unavailable', this.skipFile === 'failed' ? MESSAGES_SAYS.skipUnreadable : MESSAGES_SAYS.noMirror);
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
  }

  /**
   * The keys skip.json lists, in the table (once per open). A new or reset
   * messages.db keeps what it still lists (it never empties by itself); one
   * that won't open (permissions, a disk error) is tried again before every
   * write of it, which waits until it does.
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
      if (this.skipFile === 'unread') this.log.error("messages: the skip list file's keys were not read", { error: errorKind(e) });
      this.skipFile = 'failed';
      return false;
    }
  }

  private close(): void {
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
    if (next.messages.enabled === prev.messages.enabled) return;
    if (next.messages.enabled) this.open();
    else this.close();
  }
}

/** The Messages part; daemon.ts uses createMessagesService (index.ts). */
export function buildMessagesService(ctx: DaemonContext, deps: MessagesDeps, opts: MessagesOptions = {}): MessagesService {
  return new MessagesShell(ctx, deps, opts);
}
