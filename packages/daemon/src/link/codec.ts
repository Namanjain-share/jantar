/**
 * v0.6 Fleet: frames and bulks (lane L1). STUB from wave 0: every function
 * throws NotImplementedError until L1 replaces this file, keeping each name
 * and signature.
 *
 * One mechanism both ways for anything larger than a frame: the head frame
 * carries `bulk: {size, sha256}`, then `chunk` frames carry its bytes in
 * order (base64, at most NODE_LIMITS.chunkBytes each), sent while the
 * socket's bufferedAmount is under CHUNK_HIGH_WATER; other frames may go
 * between them. The receiver hands the bytes on only once exactly `size`
 * arrived and the sha256 matches. At most NODE_LIMITS.bulkInFlight bulks per
 * direction per link. Frames are text, one JSON message each, at most
 * NODE_LIMITS.frameBytes. A frame's body is never logged: its kind and size
 * only.
 */
import type { Bulk, NodeFrame, NodeFrameKind, NodeFrameOf } from '@jantar/protocol/node-link';
import { NotImplementedError } from '../core/not-implemented.js';

const L1 = 'The Fleet link (codec)';

/** The sender waits while the socket holds more than this unsent. */
export const CHUNK_HIGH_WATER = 2 * 1024 * 1024;

/** A frame read from the wire, or why not. `unknown-kind`: a kind this version does not know (ignored after welcome, 4400 before). */
export type DecodedFrame =
  | { ok: true; frame: NodeFrame }
  | { ok: false; problem: 'size' | 'json' | 'unknown-kind' | 'shape'; kind?: NodeFrameKind };

/** What the codec writes to: a `ws` socket fits. */
export interface FrameSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
}

/** One frame as text (throws on a frame over NODE_LIMITS.frameBytes: a programming error). */
export function encodeFrame(_frame: NodeFrame): string {
  throw new NotImplementedError(L1);
}

/** Parse and check one frame's text against its kind's schema. */
export function decodeFrame(_text: string): DecodedFrame {
  throw new NotImplementedError(L1);
}

/**
 * Send `head`; with `bytes`, first set its `bulk` (size and sha256) and then
 * send the bytes as chunks with the head's id (`snapshot` for a snapshot).
 * Resolves when the last chunk is handed to the socket.
 */
export async function sendWithBulk(_sock: FrameSocket, _head: NodeFrame, _bytes?: Buffer): Promise<void> {
  throw new NotImplementedError(L1);
}

/** What the assembler says about a frame: wait for more, a whole bulk's bytes, or a refusal (the link closes 4400; a bad upload is the call's 400). */
export type BulkStep = { ok: true; done?: Buffer } | { ok: false; problem: 'unknown-id' | 'order' | 'size' | 'sha256' | 'too-many' | 'too-large' };

/** Collects the bulks coming in on one link (one per direction). */
export class BulkAssembler {
  constructor(_opts: { maxBytes: number; maxInFlight: number }) {}

  /** A head frame announced a bulk for `id`. */
  begin(_id: string, _bulk: Bulk): BulkStep {
    throw new NotImplementedError(L1);
  }

  /** One chunk; `done` once the bulk is whole and its sha256 matches. */
  add(_chunk: NodeFrameOf<'chunk'>): BulkStep {
    throw new NotImplementedError(L1);
  }

  /** Forget everything (the link closed). */
  clear(): void {}
}
