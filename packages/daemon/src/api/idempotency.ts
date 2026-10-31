/**
 * `Idempotency-Key` for writes: a repeat of the same request (same caller,
 * route and key) gets the first response back instead of running twice, so
 * a phone that retries on a flaky connection never sends a prompt twice.
 *
 * - A repeat that arrives while the first is still running waits for it.
 * - The same key with a different body is a conflict (409).
 * - Entries live 24 hours, at most MAX_ENTRIES (oldest dropped first).
 */
import type { Clock } from '../contracts.js';
import { canonicalJson, sha256Hex } from '../core/hash.js';
import { ApiError } from './errors.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 1000;
const KEY_RE = /^[\x21-\x7e]{1,128}$/;

export interface StoredResponse {
  status: number;
  body: unknown;
}

interface Entry {
  bodyHash: string;
  at: number;
  result: Promise<StoredResponse>;
}

export function validIdempotencyKey(key: string): boolean {
  return KEY_RE.test(key);
}

export class IdempotencyCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly clock: Pick<Clock, 'now'>) {}

  /**
   * Run `fn` once per (scope, key). `scope` identifies the caller and route.
   * Returns the response and whether it was replayed.
   */
  async run(
    scope: string,
    key: string,
    body: unknown,
    fn: () => Promise<StoredResponse>,
  ): Promise<{ response: StoredResponse; replayed: boolean }> {
    if (!validIdempotencyKey(key)) {
      throw new ApiError('invalid_request', 'Idempotency-Key must be 1-128 printable ASCII characters');
    }
    this.sweep();
    const id = `${scope}\u0000${key}`;
    const bodyHash = sha256Hex(canonicalJson(body ?? null));
    const hit = this.entries.get(id);
    if (hit) {
      if (hit.bodyHash !== bodyHash) {
        throw new ApiError('conflict', 'this Idempotency-Key was already used for a different request');
      }
      return { response: await hit.result, replayed: true };
    }
    const result = fn();
    this.entries.set(id, { bodyHash, at: this.clock.now(), result });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    try {
      return { response: await result, replayed: false };
    } catch (e) {
      // Unexpected failures are not cached: the caller may retry.
      this.entries.delete(id);
      throw e;
    }
  }

  size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.clock.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, e] of this.entries) {
      if (e.at >= cutoff) break; // insertion order = age order
      this.entries.delete(k);
    }
  }
}
