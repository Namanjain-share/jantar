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
 * presented, and no longer counts as active meanwhile (the door exists only
 * while a live key does). A key is never logged, audited, put in a URL, a
 * cookie or an event; logs carry a key's id at most.
 *
 * `captureDoor` says where the door is: only in `tailscale` or `cloudflare`
 * mode with an https public URL (both put TLS in front). In `loopback` the
 * iPhone can't reach the Mac, and `lan` is plain HTTP, where a bearer key
 * would cross the Wi-Fi in clear: no door.
 */
import { CAPTURE_KEY_PREFIX, CAPTURE_PREFIX, INTEL_READ_LIMITS, type Settings } from '@jantar/protocol';
import type { CaptureKeyRecord, Clock, Db, Logger } from '../contracts.js';
import { sha256Hex } from '../core/hash.js';
import { newId, randomToken } from '../core/ids.js';
import { silentLogger } from '../core/log.js';
import { TOUCH_EVERY_MS } from './devices.js';

/** A capture key: the prefix and 32 random bytes, base64url (43 characters). */
const KEY_RE = new RegExp(`^${CAPTURE_KEY_PREFIX}[A-Za-z0-9_-]{43}$`);

/** The name a key gets when none is given. */
export const CAPTURE_KEY_DEFAULT_NAME = 'iphone';

/** The door's one route, under CAPTURE_PREFIX. */
export const CAPTURE_SAVE_PATH = `${CAPTURE_PREFIX}save`;

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
  /** Default INTEL_READ_LIMITS.captureKeyIdleMs. */
  idleMs?: number;
  /** lastSeenAt is written at most this often (default 5 minutes). */
  touchEveryMs?: number;
  /** Active keys kept at most (default INTEL_READ_LIMITS.captureKeysMax). */
  max?: number;
}

/** Where the capture door is, or why there is none (a plain sentence). */
export type CaptureDoor = { open: true; url: string } | { open: false; url: null; why: string };

/**
 * The capture door's URL for these settings: `<public origin>/v1/capture/save`
 * in tailscale or cloudflare mode with an https public URL; else closed, with
 * why. Whether a key exists and Intel is on is the caller's to add.
 */
export function captureDoor(s: Pick<Settings, 'remote'>): CaptureDoor {
  const r = s.remote;
  if (r.mode === 'loopback') return { open: false, url: null, why: 'Jantar listens on this Mac only (loopback), so the iPhone cannot reach it. Set up Tailscale or Cloudflare: jantar remote setup' };
  if (r.mode === 'lan') return { open: false, url: null, why: 'LAN mode is plain http, where the key would cross the Wi-Fi in clear. Use Tailscale or Cloudflare: jantar remote setup' };
  if (!r.publicUrl) return { open: false, url: null, why: 'No public address is set. Run jantar remote setup' };
  let u: URL;
  try {
    u = new URL(r.publicUrl);
  } catch {
    return { open: false, url: null, why: 'The public address is not a URL. Run jantar remote setup' };
  }
  if (u.protocol !== 'https:') return { open: false, url: null, why: 'The public address is not https. Run jantar remote setup' };
  return { open: true, url: `${u.origin}${CAPTURE_SAVE_PATH}` };
}

/** Whether `remote.mode` puts TLS in front of the daemon (the door may exist). */
export function captureModeOk(s: Pick<Settings, 'remote'>): boolean {
  return s.remote.mode === 'tailscale' || s.remote.mode === 'cloudflare';
}

export class CaptureKeyAuth {
  private readonly idleMs: number;
  private readonly touchEveryMs: number;
  private readonly max: number;
  private readonly log: Logger;

  constructor(private readonly opts: CaptureKeyAuthOptions) {
    this.idleMs = opts.idleMs ?? INTEL_READ_LIMITS.captureKeyIdleMs;
    this.touchEveryMs = opts.touchEveryMs ?? TOUCH_EVERY_MS;
    this.max = opts.max ?? INTEL_READ_LIMITS.captureKeysMax;
    this.log = opts.log ?? silentLogger;
  }

  /** A new key named `name`, returned once and stored only as its hash; past the cap the oldest active key is revoked. */
  issue(name: string): { id: string; key: string; name: string } {
    const key = `${CAPTURE_KEY_PREFIX}${randomToken(32)}`;
    const rec: CaptureKeyRecord = {
      id: newId(),
      name,
      keyHash: hashCaptureKey(key),
      createdAt: this.opts.clock.iso(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.opts.db.captureKeys.insert(rec);
    const active = this.list();
    for (const old of active.slice(0, Math.max(0, active.length - this.max))) {
      this.opts.db.captureKeys.revoke(old.id, this.opts.clock.iso());
      this.log.info('capture key revoked', { keyId: old.id, why: 'a newer key' });
    }
    return { id: rec.id, key, name };
  }

  /** The key's record when it is live (lastSeenAt refreshed now and then). */
  authenticate(key: string | undefined | null): CaptureKeyAuthResult {
    if (!key) return { ok: false, reason: 'missing' };
    if (!KEY_RE.test(key)) return { ok: false, reason: 'malformed' };
    const rec = this.opts.db.captureKeys.byHash(hashCaptureKey(key));
    if (!rec) return { ok: false, reason: 'unknown' };
    if (rec.revokedAt) return { ok: false, reason: 'revoked' };
    const now = this.opts.clock.now();
    if (this.idle(rec, now)) {
      this.opts.db.captureKeys.revoke(rec.id, this.opts.clock.iso(now));
      this.log.info('capture key revoked', { keyId: rec.id, why: 'idle expiry' });
      return { ok: false, reason: 'expired' };
    }
    const seen = Date.parse(rec.lastSeenAt ?? rec.createdAt);
    if (rec.lastSeenAt === null || !Number.isFinite(seen) || now - seen >= this.touchEveryMs) {
      const at = this.opts.clock.iso(now);
      this.opts.db.captureKeys.touch(rec.id, at);
      rec.lastSeenAt = at;
    }
    return { ok: true, key: rec };
  }

  /** The active (not revoked) keys, oldest first. */
  list(): CaptureKeyRecord[] {
    return this.opts.db.captureKeys.list().filter((k) => !k.revokedAt);
  }

  /** Revoke one active key; false for an unknown or already revoked id. */
  revoke(id: string): boolean {
    const rec = this.list().find((k) => k.id === id);
    if (!rec) return false;
    this.opts.db.captureKeys.revoke(id, this.opts.clock.iso());
    this.log.info('capture key revoked', { keyId: id, why: 'at the Mac' });
    return true;
  }

  /** Revoke every active key; returns how many. */
  revokeAll(): number {
    const n = this.opts.db.captureKeys.revokeAll(this.opts.clock.iso());
    if (n > 0) this.log.info('capture keys revoked', { count: n });
    return n;
  }

  /** Keys that would work now: not revoked and not idle past captureKeyIdleMs (the door exists only while one does). */
  activeCount(): number {
    if (this.opts.db.captureKeys.activeCount() === 0) return 0;
    const now = this.opts.clock.now();
    return this.list().filter((k) => !this.idle(k, now)).length;
  }

  private idle(rec: CaptureKeyRecord, now: number): boolean {
    const seen = Date.parse(rec.lastSeenAt ?? rec.createdAt);
    return Number.isFinite(seen) && now - seen > this.idleMs;
  }
}
