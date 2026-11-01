/**
 * v0.6 Fleet: clipping what a node supplies (lane L4), shared by the hub's
 * ingest and the node's own sender. STUB from wave 0: throws
 * NotImplementedError until L4 replaces this file, keeping each name and
 * signature.
 *
 * Session text to the Mac's own caps (REPLY_TEXT_MAX, NOW_TEXT_MAX,
 * AWAY_TEXT_MAX, ERROR_TEXT_MAX from sources/transcripts/parse.ts), every
 * other string field to NODE_LIMITS.fieldMax; a card's input leaves to
 * cardStringMax, arrays to cardArrayMax, depth to cardDepthMax, and an input
 * still over cardInputBytes becomes {} (the phone shows FLEET_COPY.cardTooLarge);
 * suggestions and questions to their caps; alerts', sends' and launches'
 * free text to fieldMax. The node keeps its own unclipped card for the
 * decision it builds.
 */
import type { DaemonEvent, PendingRequest, Session } from '@jantar/protocol';
import { NotImplementedError } from '../core/not-implemented.js';

const L4 = 'Fleet (clipping)';

export function clipSession(_s: Session): Session {
  throw new NotImplementedError(L4);
}

export function clipCard(_p: PendingRequest): PendingRequest {
  throw new NotImplementedError(L4);
}

/** Any event a node may send, clipped as above; other events as they are. */
export function clipEvent(_ev: DaemonEvent): DaemonEvent {
  throw new NotImplementedError(L4);
}
