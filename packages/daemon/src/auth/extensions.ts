/**
 * v0.5: the paired Chrome extension's credential (Meetings).
 *
 * Its own kind, not a device scope: one random 32-byte key per pairing,
 * sent in its own header (EXTENSION_KEY_HEADER) and read only on `/v1/ext/`
 * paths (api/app.ts), so it authenticates nothing else. Only
 * `sha256('jantar-extension-key:' + key)` is stored (jantar.db `extensions`):
 * the prefix differs from the device key's, so a device key presented as an
 * extension key, or the reverse, never matches. The Origin the claim came
 * from (`chrome-extension://<EXTENSION_ID>`) is bound to the key; every
 * capture write must carry it.
 *
 * At most MEETING_LIMITS.extensions keys are active: a new one revokes the
 * oldest. A key unused for EXTENSION_IDLE_MS is revoked when next presented.
 * The key is never logged, audited, put in a URL or a cookie.
 */
import { EXTENSION_IDLE_MS, MEETING_LIMITS } from '@jantar/protocol';
import type { Clock, Db, ExtensionRecord, Logger } from '../contracts.js';
import { sha256Hex } from '../core/hash.js';
import { newId, randomToken } from '../core/ids.js';
import { silentLogger } from '../core/log.js';
import { TOUCH_EVERY_MS } from './devices.js';

/** An extension key: 32 random bytes, base64url (43 characters). */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashExtensionKey(key: string): string {
  return sha256Hex(`jantar-extension-key:${key}`);
}

export type ExtensionAuthFailure = 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired';

export type ExtensionAuthResult = { ok: true; extension: ExtensionRecord } | { ok: false; reason: ExtensionAuthFailure };

export interface ExtensionAuthOptions {
  db: Pick<Db, 'extensions'>;
  clock: Pick<Clock, 'now' | 'iso'>;
  log?: Logger;
  /** Default EXTENSION_IDLE_MS. */
  idleMs?: number;
  /** lastSeenAt is written at most this often (default 5 minutes). */
  touchEveryMs?: number;
  /** Active keys kept at most (default MEETING_LIMITS.extensions). */
  max?: number;
}

export class ExtensionAuth {
  private readonly idleMs: number;
  private readonly touchEveryMs: number;
  private readonly max: number;
  private readonly log: Logger;

  constructor(private readonly opts: ExtensionAuthOptions) {
    this.idleMs = opts.idleMs ?? EXTENSION_IDLE_MS;
    this.touchEveryMs = opts.touchEveryMs ?? TOUCH_EVERY_MS;
    this.max = opts.max ?? MEETING_LIMITS.extensions;
    this.log = opts.log ?? silentLogger;
  }

  /** A new key bound to `origin`, returned once and stored only as its hash. Past the cap the oldest active key is revoked. */
  issue(origin: string): { id: string; key: string } {
    const key = randomToken(32);
    const rec: ExtensionRecord = {
      id: newId(),
      keyHash: hashExtensionKey(key),
      origin,
      createdAt: this.opts.clock.iso(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.opts.db.extensions.insert(rec);
    const active = this.list();
    for (const old of active.slice(0, Math.max(0, active.length - this.max))) {
      this.opts.db.extensions.revoke(old.id, this.opts.clock.iso());
      this.log.info('extension key revoked', { extensionId: old.id, why: 'a newer pairing' });
    }
    return { id: rec.id, key };
  }

  authenticate(key: string | undefined | null): ExtensionAuthResult {
    if (!key) return { ok: false, reason: 'missing' };
    if (!KEY_RE.test(key)) return { ok: false, reason: 'malformed' };
    const ext = this.opts.db.extensions.byKeyHash(hashExtensionKey(key));
    if (!ext) return { ok: false, reason: 'unknown' };
    if (ext.revokedAt) return { ok: false, reason: 'revoked' };
    const now = this.opts.clock.now();
    const seen = Date.parse(ext.lastSeenAt ?? ext.createdAt);
    if (Number.isFinite(seen) && now - seen > this.idleMs) {
      this.opts.db.extensions.revoke(ext.id, this.opts.clock.iso(now));
      this.log.info('extension key revoked', { extensionId: ext.id, why: 'idle expiry' });
      return { ok: false, reason: 'expired' };
    }
    if (ext.lastSeenAt === null || !Number.isFinite(seen) || now - seen >= this.touchEveryMs) {
      const at = this.opts.clock.iso(now);
      this.opts.db.extensions.touch(ext.id, at);
      ext.lastSeenAt = at;
    }
    return { ok: true, extension: ext };
  }

  /** The active (not revoked) extensions, oldest first. */
  list(): ExtensionRecord[] {
    return this.opts.db.extensions.list().filter((e) => !e.revokedAt);
  }

  /** Revoke every active key (`jantar meetings unpair`); returns how many. */
  revokeAll(): number {
    const active = this.list();
    const at = this.opts.clock.iso();
    for (const e of active) this.opts.db.extensions.revoke(e.id, at);
    if (active.length > 0) this.log.info('extension keys revoked', { count: active.length });
    return active.length;
  }
}
