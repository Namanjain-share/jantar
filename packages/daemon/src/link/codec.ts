/**
 * v0.6 Fleet: frames and bulks.
 *
 * One mechanism both ways for anything larger than a frame: the head frame
 * carries `bulk: {size, sha256}`, then `chunk` frames carry its bytes in
 * order (base64, at most NODE_LIMITS.chunkBytes each), sent while the
 * socket's bufferedAmount is under CHUNK_HIGH_WATER; other frames may go
 * between them. The receiver hands the bytes on only once exactly `size`
 * arrived and the sha256 matches. At most NODE_LIMITS.bulkInFlight bulks per
 * direction per link (`bulkLane` on the sender, `maxInFlight` on the
 * receiver). Frames are text, one JSON message each, at most
 * NODE_LIMITS.frameBytes. A frame's body is never logged: its kind and size
 * only.
 */
import {
  NODE_FRAME_SCHEMAS,
  NODE_LIMITS,
  isNodeFrameKind,
  type Bulk,
  type NodeFrame,
  type NodeFrameKind,
  type NodeFrameOf,
} from '@jantar/protocol/node-link';
import { safeEqual, sha256Hex } from '../core/hash.js';

/** The sender waits while the socket holds more than this unsent. */
export const CHUNK_HIGH_WATER = 2 * 1024 * 1024;

/** The id a snapshot's chunks carry. */
export const SNAPSHOT_BULK_ID = 'snapshot';

/** A frame read from the wire, or why not. `unknown-kind`: a kind this version does not know (ignored after welcome, 4400 before). */
export type DecodedFrame =
  | { ok: true; frame: NodeFrame }
  | { ok: false; problem: 'size' | 'json' | 'unknown-kind' | 'shape'; kind?: NodeFrameKind };

/**
 * What the codec writes to: a `ws` socket fits. `send`'s callback runs once
 * the data is written out (or failed): sendWithBulk waits on it while the
 * socket holds more than CHUNK_HIGH_WATER.
 */
export interface FrameSocket {
  readonly bufferedAmount: number;
  send(data: string, cb?: (err?: Error) => void): void;
}

/** One frame as text (throws on a frame over NODE_LIMITS.frameBytes: a programming error). */
export function encodeFrame(frame: NodeFrame): string {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, 'utf8') > NODE_LIMITS.frameBytes) throw new RangeError(`a ${frame.k} frame is over the link's frame size`);
  return text;
}

/** Parse and check one frame's text against its kind's schema. */
export function decodeFrame(text: string): DecodedFrame {
  if (Buffer.byteLength(text, 'utf8') > NODE_LIMITS.frameBytes) return { ok: false, problem: 'size' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'json' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, problem: 'shape' };
  const k = (json as { k?: unknown }).k;
  if (typeof k !== 'string') return { ok: false, problem: 'shape' };
  if (!isNodeFrameKind(k)) return { ok: false, problem: 'unknown-kind' };
  const parsed = NODE_FRAME_SCHEMAS[k].safeParse(json);
  return parsed.success ? { ok: true, frame: parsed.data as NodeFrame } : { ok: false, problem: 'shape', kind: k };
}

/** The frame a bulk's head becomes: the bytes' place taken by `bulk`. */
function withBulk(head: NodeFrame, bulk: Bulk): { frame: NodeFrame; id: string } {
  switch (head.k) {
    case 'snapshot':
      return { frame: { k: 'snapshot', bulk } as NodeFrame, id: SNAPSHOT_BULK_ID };
    case 'result': {
      const { body: _body, ...rest } = head;
      return { frame: { ...rest, bulk } as NodeFrame, id: head.id };
    }
    case 'call':
      return { frame: { ...head, bulk }, id: head.id };
    default:
      throw new Error(`a ${head.k} frame carries no bulk`);
  }
}

/**
 * Send `head`; with `bytes`, first set its `bulk` (size and sha256) and then
 * send the bytes as chunks with the head's id (`snapshot` for a snapshot).
 * Resolves when the last chunk is handed to the socket; rejects when the
 * socket fails while it waits.
 */
export async function sendWithBulk(sock: FrameSocket, head: NodeFrame, bytes?: Buffer): Promise<void> {
  if (!bytes) {
    sock.send(encodeFrame(head));
    return;
  }
  const { frame, id } = withBulk(head, { size: bytes.length, sha256: sha256Hex(bytes) });
  sock.send(encodeFrame(frame));
  let written: Promise<Error | undefined> = Promise.resolve(undefined);
  for (let i = 0, at = 0; at < bytes.length; i += 1, at += NODE_LIMITS.chunkBytes) {
    if (sock.bufferedAmount > CHUNK_HIGH_WATER) {
      // Everything sent so far is written out once the previous chunk is.
      const err = await written;
      if (err) throw err;
    }
    const text = encodeFrame({ k: 'chunk', id, i, data: bytes.subarray(at, at + NODE_LIMITS.chunkBytes).toString('base64') });
    written = new Promise((resolve) => sock.send(text, (err) => resolve(err ?? undefined)));
  }
}

/**
 * At most `max` bulks being sent at once on one link: the receiver
 * assembles no more than that. Each `run` waits for a free place.
 */
export function bulkLane(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let busy = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy >= max) await new Promise<void>((resolve) => queue.push(resolve));
    busy += 1;
    try {
      return await fn();
    } finally {
      busy -= 1;
      queue.shift()?.();
    }
  };
}

/** What the assembler says about a frame: wait for more, a whole bulk's bytes, or a refusal (the link closes 4400; a bad upload is the call's 400). */
export type BulkStep = { ok: true; done?: Buffer } | { ok: false; problem: 'unknown-id' | 'order' | 'size' | 'sha256' | 'too-many' | 'too-large' };

interface OpenBulk {
  size: number;
  sha256: string;
  next: number;
  got: number;
  parts: Buffer[];
}

/** Refused ids remembered so their trailing chunks are dropped, not taken for strangers. */
const REFUSED_KEPT = 64;

/** Collects the bulks coming in on one link (one per direction). */
export class BulkAssembler {
  private readonly open = new Map<string, OpenBulk>();
  private readonly refused = new Set<string>();

  constructor(private readonly opts: { maxBytes: number; maxInFlight: number }) {}

  /** A head frame announced a bulk for `id` (`done` at once for an empty one). */
  begin(id: string, bulk: Bulk): BulkStep {
    if (this.open.has(id)) return this.refuse(id, 'order');
    if (bulk.size > this.opts.maxBytes) return this.refuse(id, 'too-large');
    if (this.open.size >= this.opts.maxInFlight) return this.refuse(id, 'too-many');
    this.refused.delete(id);
    if (bulk.size === 0) return this.finish(id, bulk.sha256, Buffer.alloc(0));
    this.open.set(id, { size: bulk.size, sha256: bulk.sha256, next: 0, got: 0, parts: [] });
    return { ok: true };
  }

  /** One chunk; `done` once the bulk is whole and its sha256 matches. A chunk of a refused bulk is dropped. */
  add(chunk: NodeFrameOf<'chunk'>): BulkStep {
    const b = this.open.get(chunk.id);
    if (!b) return this.refused.has(chunk.id) ? { ok: true } : { ok: false, problem: 'unknown-id' };
    if (chunk.i !== b.next) return this.refuse(chunk.id, 'order');
    const bytes = Buffer.from(chunk.data, 'base64');
    if (bytes.length === 0 || b.got + bytes.length > b.size) return this.refuse(chunk.id, 'size');
    b.parts.push(bytes);
    b.got += bytes.length;
    b.next += 1;
    if (b.got < b.size) return { ok: true };
    this.open.delete(chunk.id);
    return this.finish(chunk.id, b.sha256, Buffer.concat(b.parts, b.size));
  }

  /** Bulks being assembled now. */
  inFlight(): number {
    return this.open.size;
  }

  /** Forget everything (the link closed). */
  clear(): void {
    this.open.clear();
    this.refused.clear();
  }

  private finish(id: string, sha256: string, bytes: Buffer): BulkStep {
    if (!safeEqual(sha256Hex(bytes), sha256)) return this.refuse(id, 'sha256');
    return { ok: true, done: bytes };
  }

  private refuse(id: string, problem: Exclude<BulkStep, { ok: true }>['problem']): BulkStep {
    this.open.delete(id);
    this.refused.add(id);
    for (const old of this.refused) {
      if (this.refused.size <= REFUSED_KEPT) break;
      this.refused.delete(old);
    }
    return { ok: false, problem };
  }
}
