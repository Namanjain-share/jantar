/**
 * v0.6 Fleet, the node's reconnect waits (spec 3.8): full jitter under a cap
 * that doubles from 1 s, and the wait each way a link can end gets.
 */
import { describe, expect, it } from 'vitest';
import { NODE_CLOSE, NODE_LIMITS } from '@jantar/protocol/node-link';
import { backoffDelay, endingCode, retryWait, type LinkEnding } from '../../src/link/backoff.js';

const top = () => 0.999999;
const zero = () => 0;

describe('backoffDelay', () => {
  it('is random(0, min(cap, 1 s x 2^attempt))', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, NODE_LIMITS.backoffCapMs, top))).toEqual([
      999, 1999, 3999, 7999, 15999, 31999, 59999, 59999,
    ]);
    expect(backoffDelay(5, NODE_LIMITS.backoffCapMs, zero)).toBe(0);
    expect(backoffDelay(3, NODE_LIMITS.backoffCapMs, () => 0.5)).toBe(4000);
  });

  it('never overflows or goes negative', () => {
    expect(backoffDelay(10_000, NODE_LIMITS.slowRetryMs, top)).toBe(NODE_LIMITS.slowRetryMs - 1);
    expect(backoffDelay(-3, NODE_LIMITS.backoffCapMs, top)).toBe(999);
    expect(backoffDelay(2, NODE_LIMITS.backoffCapMs, () => 5)).toBe(4000);
    expect(backoffDelay(2, NODE_LIMITS.backoffCapMs, () => -1)).toBe(0);
  });

  it('spreads ten nodes waking together across the window', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const waits = Array.from({ length: 10 }, () => backoffDelay(6, NODE_LIMITS.backoffCapMs, random));
    expect(new Set(waits).size).toBe(10);
    expect(Math.max(...waits) - Math.min(...waits)).toBeGreaterThan(NODE_LIMITS.backoffCapMs / 3);
  });
});

describe('retryWait', () => {
  const cases: [string, LinkEnding, number][] = [
    ['a dropped link', { kind: 'closed', code: 1006 }, 59999],
    ['the hub going away', { kind: 'closed', code: NODE_CLOSE.goingAway }, 59999],
    ['too slow (1013)', { kind: 'closed', code: NODE_CLOSE.slow }, 59999],
    ['a frame too big (1009)', { kind: 'closed', code: NODE_CLOSE.tooBig }, 59999],
    ['a protocol error (4400)', { kind: 'closed', code: NODE_CLOSE.protocol }, 59999],
    ['a handshake timeout (4408)', { kind: 'closed', code: NODE_CLOSE.handshakeTimeout }, 59999],
    ['replaced (4409)', { kind: 'closed', code: NODE_CLOSE.replaced }, NODE_LIMITS.slowRetryMs - 1],
    ['Fleet off (4403)', { kind: 'closed', code: NODE_CLOSE.fleetOff }, NODE_LIMITS.slowRetryMs],
    ['removed (4401)', { kind: 'closed', code: NODE_CLOSE.unknown }, NODE_LIMITS.hourlyRetryMs],
    ['link versions differ (4426)', { kind: 'closed', code: NODE_CLOSE.version }, NODE_LIMITS.hourlyRetryMs],
    ['Fleet off (HTTP 404)', { kind: 'http', status: 404 }, NODE_LIMITS.slowRetryMs],
    ['Access refused (HTTP 403)', { kind: 'http', status: 403, access: true }, NODE_LIMITS.slowRetryMs],
    // Its retry-after, plus up to as much again (16999 at the top of the range).
    ['rate limited (HTTP 429)', { kind: 'http', status: 429, retryAfterMs: 17_000 }, 33_999],
    ['a 502 from the tunnel', { kind: 'http', status: 502 }, 59999],
    ['a redirect', { kind: 'redirect', status: 302 }, 59999],
    ['an untrusted certificate', { kind: 'tls', error: 'SELF_SIGNED_CERT_IN_CHAIN' }, 59999],
    ['no route', { kind: 'network', error: 'ECONNREFUSED' }, 59999],
    ['an impostor', { kind: 'impostor' }, 59999],
  ];
  for (const [name, ending, wait] of cases) {
    it(name, () => {
      expect(retryWait(ending, 20, top)).toBe(wait);
    });
  }

  it('a retry-after is kept between 1 s and an hour, and jittered up to as much again', () => {
    const none = () => 0;
    expect(retryWait({ kind: 'http', status: 429, retryAfterMs: 1 }, 0, none)).toBe(1000);
    expect(retryWait({ kind: 'http', status: 429, retryAfterMs: 9e9 }, 0, none)).toBe(NODE_LIMITS.hourlyRetryMs);
    expect(retryWait({ kind: 'http', status: 429, retryAfterMs: 9e9 }, 0, top)).toBe(NODE_LIMITS.hourlyRetryMs);
    expect(retryWait({ kind: 'http', status: 429 }, 0, none)).toBe(NODE_LIMITS.backoffCapMs);
    // Ten servers refused together come back spread over the next 5 s, never before the hub's 5.
    const waits = [0, 0.1, 0.5, 0.9].map((r) => retryWait({ kind: 'http', status: 429, retryAfterMs: 5000 }, 0, () => r));
    expect(waits).toEqual([5000, 5500, 7500, 9500]);
  });

  it('the code a status shows for each ending', () => {
    expect(endingCode({ kind: 'closed', code: 4409 })).toBe(4409);
    expect(endingCode({ kind: 'http', status: 403, access: true })).toBe(403);
    expect(endingCode({ kind: 'redirect', status: 301 })).toBe(301);
    expect(endingCode({ kind: 'impostor' })).toBe(NODE_CLOSE.protocol);
    expect(endingCode({ kind: 'tls', error: 'X' })).toBe(1006);
  });
});
