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
 *
 * v0.10 (spec 0.10 B11.2): a second scope, `chat`, for the Siri door
 * (`/v1/capture/chat`): `jchat_` keys stored as
 * `sha256('jantar-chat-key:' + key)` (their own hash domain) in the same
 * table with `scope = 'chat'`. One CaptureKeyAuth per scope: each matches
 * its own prefix, its own hash domain AND the row's scope, so a key of one
 * door never opens the other (a 0.9 daemon's key check refuses `jchat_`
 * outright). At most five active per scope; a sixth revokes that scope's
 * oldest; idle 180 days.
 */
import { CAPTURE_CHAT_PATH, CAPTURE_KEY_PREFIX, CAPTURE_PREFIX, CHAT_KEY_PREFIX, INTEL_READ_LIMITS, type Settings } from '@jantar/protocol';
import type { CaptureKeyRecord, CaptureKeyScope, Clock, Db, Logger } from '../contracts.js';
import { sha256Hex } from '../core/hash.js';
import { newId, randomToken } from '../core/ids.js';
import { silentLogger } from '../core/log.js';
import { TOUCH_EVERY_MS } from './devices.js';

/** Each scope's key prefix and hash domain. */
const SCOPES: Readonly<Record<CaptureKeyScope, { prefix: string; domain: string }>> = {
  capture: { prefix: CAPTURE_KEY_PREFIX, domain: 'jantar-capture-key:' },
  chat: { prefix: CHAT_KEY_PREFIX, domain: 'jantar-chat-key:' },
};

/** A key: its scope's prefix and 32 random bytes, base64url (43 characters). */
const keyRe = (scope: CaptureKeyScope) => new RegExp(`^${SCOPES[scope].prefix}[A-Za-z0-9_-]{43}$`);

/** v0.10: what is stored for a chat key (never the key). */
export function hashChatKey(key: string): string {
  return sha256Hex(`${SCOPES.chat.domain}${key}`);
}

/** v0.10: the name a chat key gets when none is given. */
export const CHAT_KEY_DEFAULT_NAME = 'iphone';

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
  /** v0.10: the door these keys open (default capture). */
  scope?: CaptureKeyScope;
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

/** v0.10: the Siri door's URL for these settings (`<public origin>/v1/capture/chat`), or why there is none. */
export function chatDoor(s: Pick<Settings, 'remote'>): CaptureDoor {
  const d = captureDoor(s);
  return d.open ? { open: true, url: d.url.replace(CAPTURE_SAVE_PATH, CAPTURE_CHAT_PATH) } : d;
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
  readonly scope: CaptureKeyScope;
  private readonly keyRe: RegExp;

  constructor(private readonly opts: CaptureKeyAuthOptions) {
    this.scope = opts.scope ?? 'capture';
    this.keyRe = keyRe(this.scope);
    this.idleMs = opts.idleMs ?? INTEL_READ_LIMITS.captureKeyIdleMs;
    this.touchEveryMs = opts.touchEveryMs ?? TOUCH_EVERY_MS;
    this.max = opts.max ?? INTEL_READ_LIMITS.captureKeysMax;
    this.log = opts.log ?? silentLogger;
  }

  /** A new key named `name`, returned once and stored only as its hash; past the cap the oldest active key is revoked. */
  issue(name: string): { id: string; key: string; name: string } {
    const key = `${SCOPES[this.scope].prefix}${randomToken(32)}`;
    // Strictly after every key made before it, so the oldest is the one made first (keys made in one millisecond would tie, and ids don't order within it).
    const latest = this.opts.db.captureKeys.list(this.scope).reduce((m, k) => Math.max(m, Date.parse(k.createdAt) || 0), 0);
    const rec: CaptureKeyRecord = {
      id: newId(),
      scope: this.scope,
      name,
      keyHash: this.hash(key),
      createdAt: this.opts.clock.iso(Math.max(this.opts.clock.now(), latest + 1)),
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
    if (!this.keyRe.test(key)) return { ok: false, reason: 'malformed' };
    const rec = this.opts.db.captureKeys.byHash(this.hash(key));
    // The prefix, the hash domain and the row's scope must all agree.
    if (!rec || rec.scope !== this.scope) return { ok: false, reason: 'unknown' };
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
    return this.opts.db.captureKeys.list(this.scope).filter((k) => !k.revokedAt);
  }

  private hash(key: string): string {
    return this.scope === 'chat' ? hashChatKey(key) : hashCaptureKey(key);
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
    const n = this.opts.db.captureKeys.revokeAll(this.opts.clock.iso(), this.scope);
    if (n > 0) this.log.info('capture keys revoked', { count: n });
    return n;
  }

  /** Keys that would work now: not revoked and not idle past captureKeyIdleMs (the door exists only while one does). */
  activeCount(): number {
    if (this.opts.db.captureKeys.activeCount(this.scope) === 0) return 0;
    const now = this.opts.clock.now();
    return this.list().filter((k) => !this.idle(k, now)).length;
  }

  private idle(rec: CaptureKeyRecord, now: number): boolean {
    const seen = Date.parse(rec.lastSeenAt ?? rec.createdAt);
    return Number.isFinite(seen) && now - seen > this.idleMs;
  }
}
