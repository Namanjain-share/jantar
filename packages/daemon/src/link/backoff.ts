/**
 * v0.6 Fleet: the node's reconnect waits (lane L1). STUB from wave 0:
 * throws NotImplementedError until L1 replaces this file, keeping the name
 * and signature.
 *
 * Full jitter: `random(0, min(cap, 1 s x 2^attempt))`, the attempt count
 * reset after NODE_LIMITS.backoffResetMs connected. The cap comes from how
 * the last link ended (spec 3.8): NODE_LIMITS.backoffCapMs for drops, 1013,
 * 1009, 4400 and a bad welcome; slowRetryMs for 4409, Fleet off and Access
 * refusals; hourlyRetryMs for 4401 and 4426; a 429's retry-after as told.
 */
import { NotImplementedError } from '../core/not-implemented.js';

/** How long to wait before attempt number `attempt` (0 first), at most `capMs`. `random` in [0, 1). */
export function backoffDelay(_attempt: number, _capMs: number, _random: () => number = Math.random): number {
  throw new NotImplementedError('The Fleet link (backoff)');
}
