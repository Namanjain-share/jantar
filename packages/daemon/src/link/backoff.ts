/**
 * v0.6 Fleet: the node's reconnect waits.
 *
 * Full jitter: `random(0, min(cap, 1 s x 2^attempt))`, the attempt count
 * reset after NODE_LIMITS.backoffResetMs connected. The cap comes from how
 * the last link ended (spec 3.8):
 *
 * | ended with                                             | wait                          |
 * |--------------------------------------------------------|-------------------------------|
 * | 1001, 1006, 1009, 1013, 4400, 4408, a network or TLS   | backoff, cap backoffCapMs     |
 * | error, a 5xx, a redirect, a timeout, a bad welcome     |                               |
 * | 4409 (a newer link with this key)                      | backoff, cap slowRetryMs      |
 * | 4403 / HTTP 404 (Fleet off), HTTP 403 (Access refused) | slowRetryMs                   |
 * | 4401 (removed), 4426 (link versions differ)            | hourlyRetryMs                 |
 * | HTTP 429                                               | its retry-after, plus up to   |
 * |                                                        | as much again at random, so   |
 * |                                                        | refused servers do not all    |
 * |                                                        | come back together            |
 */
import { NODE_CLOSE, NODE_LIMITS } from '@jantar/protocol/node-link';

/** How long to wait before attempt number `attempt` (0 first), at most `capMs`. `random` in [0, 1). */
export function backoffDelay(attempt: number, capMs: number, random: () => number = Math.random): number {
  const n = Math.max(0, Math.min(Math.floor(attempt), 30));
  const ceiling = Math.min(capMs, 1000 * 2 ** n);
  return Math.floor(Math.max(0, Math.min(random(), 1)) * ceiling);
}

/**
 * How a link (or an attempt at one) ended, as the dialler saw it.
 * - `closed`: a WebSocket close code (after the upgrade, or 1006 for a socket that died).
 * - `http`: the upgrade was answered with a status, not 101 (`access`: a 403 with no Jantar body).
 * - `redirect`, `tls`, `network`, `timeout`, `impostor` (the welcome's signature failed), `protocol` (a bad frame from the hub).
 */
export type LinkEnding =
  | { kind: 'closed'; code: number }
  | { kind: 'http'; status: number; access?: boolean; retryAfterMs?: number }
  | { kind: 'redirect'; status: number }
  | { kind: 'tls' | 'network'; error: string }
  | { kind: 'timeout' | 'impostor' | 'protocol' };

/** What `lastClose.code` shows for an ending: the close code, the HTTP status, or 1006 (no close frame). */
export function endingCode(e: LinkEnding): number {
  if (e.kind === 'closed') return e.code;
  if (e.kind === 'http' || e.kind === 'redirect') return e.status;
  if (e.kind === 'impostor' || e.kind === 'protocol') return NODE_CLOSE.protocol;
  return 1006;
}

/** The wait before the next attempt after `e`, the attempt count before it. */
export function retryWait(e: LinkEnding, attempt: number, random: () => number = Math.random): number {
  const backoff = (cap: number) => backoffDelay(attempt, cap, random);
  switch (e.kind) {
    case 'closed':
      if (e.code === NODE_CLOSE.unknown || e.code === NODE_CLOSE.version) return NODE_LIMITS.hourlyRetryMs;
      if (e.code === NODE_CLOSE.fleetOff) return NODE_LIMITS.slowRetryMs;
      if (e.code === NODE_CLOSE.replaced) return backoff(NODE_LIMITS.slowRetryMs);
      return backoff(NODE_LIMITS.backoffCapMs);
    case 'http':
      if (e.status === 404 || e.status === 403) return NODE_LIMITS.slowRetryMs;
      if (e.status === 429) {
        const after = Math.min(Math.max(e.retryAfterMs ?? NODE_LIMITS.backoffCapMs, 1000), NODE_LIMITS.hourlyRetryMs);
        return Math.min(after + Math.floor(Math.max(0, Math.min(random(), 1)) * after), NODE_LIMITS.hourlyRetryMs);
      }
      return backoff(NODE_LIMITS.backoffCapMs);
    default:
      return backoff(NODE_LIMITS.backoffCapMs);
  }
}
