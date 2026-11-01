/**
 * v0.8: the iOS Shortcut's capture keys (Intel's capture door).
 *
 * Its own credential kind, modelled on auth/extensions.ts: `jcap_` and 32
 * random bytes, base64url, sent in CAPTURE_KEY_HEADER and read only on
 * CAPTURE_PREFIX paths (api/app.ts), so it authenticates nothing else.
 * Only `sha256('jantar-capture-key:' + key)` is stored (jantar.db
 * `capture_keys`): the prefix differs from the device and extension hashes,
 * so no key can pose as another kind. Made at the Mac only (`jantar intel
 * shortcut add`); at most INTEL_READ_LIMITS.captureKeysMax active (a new one
 * revokes the oldest); unused for captureKeyIdleMs it is revoked when next
 * presented. A key is never logged, audited, put in a URL, a cookie or an
 * event.
 *
 * Wave 0: the shape lane C builds. Until then no key authenticates, and
 * issuing or revoking one answers 501.
 */
import type { CaptureKeyRecord, Clock, Db, Logger } from '../contracts.js';
import { sha256Hex } from '../core/hash.js';
import { NotImplementedError } from '../core/not-implemented.js';

/** What is stored for a key (never the key). */
export function hashCaptureKey(key: string): string {
  return sha256Hex(`jantar-capture-key:${key}`);
}

export type CaptureKeyAuthFailure = 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired';

export type CaptureKeyAuthResult = { ok: true; key: CaptureKeyRecord } | { ok: false; reason: CaptureKeyAuthFailure };

export interface CaptureKeyAuthOptions {
  db: Pick<Db, 'captureKeys'>;
  clock: Pick<Clock, 'now' | 'iso'>;
  log?: Logger;
}

const KEYS = 'Shortcut keys';

export class CaptureKeyAuth {
  constructor(private readonly opts: CaptureKeyAuthOptions) {}

  /** A new key named `name`, returned once and stored only as its hash; past the cap the oldest active key is revoked. */
  issue(_name: string): { id: string; key: string; name: string } {
    throw new NotImplementedError(KEYS);
  }

  /** The key's record when it is live (lastSeenAt refreshed now and then). Wave 0: none is. */
  authenticate(key: string | undefined | null): CaptureKeyAuthResult {
    return { ok: false, reason: key ? 'unknown' : 'missing' };
  }

  /** The active (not revoked) keys, oldest first. */
  list(): CaptureKeyRecord[] {
    return this.opts.db.captureKeys.list().filter((k) => !k.revokedAt);
  }

  /** Revoke one key; false for an unknown or already revoked id. */
  revoke(_id: string): boolean {
    throw new NotImplementedError(KEYS);
  }

  /** Revoke every active key; returns how many. */
  revokeAll(): number {
    throw new NotImplementedError(KEYS);
  }

  /** Keys not revoked (the door exists only while one does). */
  activeCount(): number {
    return this.opts.db.captureKeys.activeCount();
  }
}
