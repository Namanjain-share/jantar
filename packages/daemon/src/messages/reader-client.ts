/**
 * The daemon's side of the reader's socket (0.15): one connection to
 * jantar-messages-reader (paths.messagesReaderSock), opened on the first call
 * and again after it drops, with requests multiplexed by id
 * (reader-protocol.ts). Args are checked before they are sent and every
 * answer before it is used.
 *
 * A call resolves with the op's data or rejects with a ReaderFailure: the
 * reader's own error code, `down` (no socket, refused, or it closed with
 * the call in flight), `timeout` (no answer in READER_TIMEOUT_MS: the reader
 * keeps its own 2 s and 5 s deadlines, so this is a reader that hangs),
 * `bad_request` (args that don't check, never sent) or `unsupported` with
 * READER_MISMATCH (an answer that doesn't check: a reader of another build,
 * which says.ts tells apart from WhatsApp's own `unsupported`). A failure's
 * message is its code and the reader's fixed detail, never data.
 */
import { createConnection, type Socket } from 'node:net';
import type { Clock, TimerId } from '../contracts.js';
import { systemClock } from '../core/clock.js';
import { READER_ARGS, ReaderReplySchema, parseReaderData, type ReaderArgs, type ReaderData, type ReaderError, type ReaderOp } from './reader-protocol.js';
import { READER_MISMATCH } from './says.js';

/** How long a call waits for its answer. */
export const READER_TIMEOUT_MS = 10_000;
/** The longest answer kept (a newSince of READER_NEW_ROWS_MAX lines fits); past it the connection is dropped. */
const REPLY_MAX_CHARS = 64 * 1024 * 1024;
/** Ids wrap here (the reader echoes any non-negative integer). */
const ID_MAX = 0x7fff_ffff;

export class ReaderFailure extends Error {
  constructor(
    readonly code: ReaderError | 'down',
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ReaderFailure';
  }
}

export interface ReaderClient {
  call<O extends ReaderOp>(op: O, args: ReaderArgs[O], opts?: { timeoutMs?: number }): Promise<ReaderData[O]>;
  /** Drops the connection (calls in flight are `down`); a later call opens a new one. */
  close(): void;
}

interface Pending {
  op: ReaderOp;
  resolve(data: unknown): void;
  reject(e: ReaderFailure): void;
  timer: TimerId;
}

class SocketReaderClient implements ReaderClient {
  private socket: Socket | null = null;
  /** The socket being opened, and the promise of it (calls meanwhile share it). */
  private opening: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private parts: string[] = [];
  private partChars = 0;

  constructor(
    private readonly sock: string,
    private readonly clock: Clock,
    private readonly timeoutMs: number,
  ) {}

  async call<O extends ReaderOp>(op: O, args: ReaderArgs[O], opts: { timeoutMs?: number } = {}): Promise<ReaderData[O]> {
    const checked = READER_ARGS[op].safeParse(args);
    if (!checked.success) throw new ReaderFailure('bad_request', `the ${op} arguments don't check`);
    const socket = await this.connect();
    const id = this.nextId;
    this.nextId = this.nextId >= ID_MAX ? 1 : this.nextId + 1;
    return new Promise<ReaderData[O]>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id);
        reject(new ReaderFailure('timeout', `no answer to ${op}`));
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { op, resolve: resolve as (d: unknown) => void, reject, timer });
      socket.write(`${JSON.stringify({ id, op, args: checked.data })}\n`);
    });
  }

  close(): void {
    for (const s of [this.socket, this.opening]) s?.destroy();
    this.socket = null;
    this.opening = null;
    this.connecting = null;
    this.failAll('the connection was closed');
  }

  private connect(): Promise<Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const s = createConnection(this.sock);
    this.opening = s;
    s.setEncoding('utf8');
    this.connecting = new Promise<Socket>((resolve, reject) => {
      let opened = false;
      const down = () => new ReaderFailure('down', "the reader's socket doesn't answer");
      s.once('connect', () => {
        opened = true;
        // close() ran meanwhile.
        if (this.opening !== s) {
          s.destroy();
          reject(down());
          return;
        }
        this.opening = null;
        this.connecting = null;
        this.socket = s;
        this.parts = [];
        this.partChars = 0;
        resolve(s);
      });
      s.on('data', (chunk: string) => this.onData(s, chunk));
      s.on('error', () => undefined);
      s.once('close', () => {
        if (!opened) {
          if (this.opening === s) {
            this.opening = null;
            this.connecting = null;
          }
          reject(down());
        } else if (this.socket === s) {
          this.socket = null;
          this.failAll('the reader closed the connection');
        }
      });
    });
    return this.connecting;
  }

  /** Lines are found in each new chunk only, so a long answer is never scanned twice. */
  private onData(s: Socket, chunk: string): void {
    if (this.socket !== s) return;
    let from = 0;
    for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', from)) {
      this.parts.push(chunk.slice(from, nl));
      const line = this.parts.join('');
      this.parts = [];
      this.partChars = 0;
      from = nl + 1;
      this.onLine(line);
    }
    const rest = chunk.slice(from);
    if (!rest) return;
    this.parts.push(rest);
    this.partChars += rest.length;
    if (this.partChars > REPLY_MAX_CHARS) {
      this.close();
    }
  }

  private onLine(line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const reply = ReaderReplySchema.safeParse(json);
    if (!reply.success) return;
    const p = this.pending.get(reply.data.id);
    if (!p) return;
    this.pending.delete(reply.data.id);
    this.clock.clearTimeout(p.timer);
    if (!reply.data.ok) {
      p.reject(new ReaderFailure(reply.data.error, reply.data.detail));
      return;
    }
    try {
      p.resolve(parseReaderData(p.op, reply.data.data));
    } catch {
      p.reject(new ReaderFailure('unsupported', READER_MISMATCH));
    }
  }

  private failAll(why: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      this.clock.clearTimeout(p.timer);
      p.reject(new ReaderFailure('down', why));
    }
  }
}

/** A client for the reader at `sock`. `clock`: the timeouts' (tests' FakeClock); default the system's. */
export function createReaderClient(sock: string, opts: { clock?: Clock; timeoutMs?: number } = {}): ReaderClient {
  return new SocketReaderClient(sock, opts.clock ?? systemClock, opts.timeoutMs ?? READER_TIMEOUT_MS);
}
