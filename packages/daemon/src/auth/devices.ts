/**
 * Paired devices: each one holds a random 32-byte key in an HttpOnly cookie
 * and a second random 32-byte device secret that the web app keeps in
 * IndexedDB (SEC-2). Only sha256 of each is stored. The cookie alone is
 * enough to read; writes and the event stream also need the secret, because
 * browsers send a 127.0.0.1 cookie to every port on 127.0.0.1 while
 * IndexedDB is per origin. Devices stop working after 30 idle days (they are
 * then marked revoked) or when revoked from the devices screen / CLI.
 */
import {
  DEVICE_COOKIE,
  DEVICE_IDLE_EXPIRY_DAYS,
  type Device,
  type DevicePublic,
  type Scope,
} from '@jantar/protocol';
import type { Clock, Db, Logger } from '../contracts.js';
import { safeEqual, sha256Hex } from '../core/hash.js';
import { newId, randomToken } from '../core/ids.js';
import { silentLogger } from '../core/log.js';
import { normalizeScopes } from './scopes.js';

export { DEVICE_COOKIE };

/** A device key or device secret: 32 random bytes, base64url (43 characters). */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** lastSeenAt is written at most this often per device. */
export const TOUCH_EVERY_MS = 5 * 60 * 1000;

export type AuthFailure = 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired';

export type AuthResult =
  | { ok: true; device: Device; /** lastSeenAt was just refreshed (re-issue the cookie). */ touched: boolean }
  | { ok: false; reason: AuthFailure };

export interface DeviceAuthOptions {
  db: Pick<Db, 'devices' | 'pushSubs'>;
  clock: Pick<Clock, 'now' | 'iso'>;
  log?: Logger;
  idleDays?: number;
  touchEveryMs?: number;
}

export function publicDevice(d: Device): DevicePublic {
  const { keyHash: _key, secretHash: _secret, ...rest } = d;
  return rest;
}

// The prefixes keep the old name (ccw-v2): the hashes are stored, and a
// database brought over by `jantar import-ccw-v2` must still match its devices.
export function hashDeviceKey(key: string): string {
  return sha256Hex(`ccw-v2-device:${key}`);
}

export function hashDeviceSecret(secret: string): string {
  return sha256Hex(`ccw-v2-device-secret:${secret}`);
}

/**
 * Whether `presented` is this device's secret. The presented value is hashed
 * and the hashes are compared in constant time. A device paired before
 * secrets existed has none, so nothing matches it.
 */
export function deviceSecretMatches(device: Pick<Device, 'secretHash'>, presented: string | undefined | null): boolean {
  if (!device.secretHash || !presented || !KEY_RE.test(presented)) return false;
  return safeEqual(hashDeviceSecret(presented), device.secretHash);
}

export class DeviceAuth {
  readonly idleMs: number;
  private readonly touchEveryMs: number;
  private readonly log: Logger;

  constructor(private readonly opts: DeviceAuthOptions) {
    this.idleMs = (opts.idleDays ?? DEVICE_IDLE_EXPIRY_DAYS) * DAY_MS;
    this.touchEveryMs = opts.touchEveryMs ?? TOUCH_EVERY_MS;
    this.log = opts.log ?? silentLogger;
  }

  /** Cookie lifetime in seconds (matches the idle expiry; refreshed on touch). */
  cookieMaxAgeS(): number {
    return Math.floor(this.idleMs / 1000);
  }

  authenticate(key: string | undefined | null): AuthResult {
    if (!key) return { ok: false, reason: 'missing' };
    if (!KEY_RE.test(key)) return { ok: false, reason: 'malformed' };
    const device = this.opts.db.devices.byKeyHash(hashDeviceKey(key));
    if (!device) return { ok: false, reason: 'unknown' };
    if (device.revokedAt) return { ok: false, reason: 'revoked' };
    const now = this.opts.clock.now();
    const lastSeen = Date.parse(device.lastSeenAt);
    if (Number.isFinite(lastSeen) && now - lastSeen > this.idleMs) {
      this.revoke(device.id, 'idle expiry');
      return { ok: false, reason: 'expired' };
    }
    let touched = false;
    if (!Number.isFinite(lastSeen) || now - lastSeen >= this.touchEveryMs) {
      const at = this.opts.clock.iso(now);
      this.opts.db.devices.touch(device.id, at);
      device.lastSeenAt = at;
      touched = true;
    }
    return { ok: true, device, touched };
  }

  /** Create a device, its key and its secret. Both are returned once and never stored. */
  issue(input: { name: string; scopes: readonly Scope[]; userAgent?: string }): { device: Device; key: string; secret: string } {
    const key = randomToken(32);
    const secret = randomToken(32);
    const at = this.opts.clock.iso();
    const device: Device = {
      id: newId(),
      name: input.name.slice(0, 64),
      keyHash: hashDeviceKey(key),
      secretHash: hashDeviceSecret(secret),
      scopes: normalizeScopes(input.scopes),
      createdAt: at,
      lastSeenAt: at,
    };
    if (input.userAgent) device.userAgent = input.userAgent.slice(0, 256);
    this.opts.db.devices.insert(device);
    return { device, key, secret };
  }

  get(id: string): Device | null {
    return this.opts.db.devices.get(id);
  }

  list(): Device[] {
    return this.opts.db.devices.list();
  }

  /**
   * Replace a device's scopes (normalized). Null for an unknown or revoked
   * device. The caller decides who may do this: deviceScopes is `localOnly`,
   * so only the Mac's CLI reaches it (api/app.ts refuses it over TCP).
   */
  setScopes(id: string, scopes: readonly Scope[]): Device | null {
    const d = this.opts.db.devices.get(id);
    if (!d || d.revokedAt) return null;
    const next = this.opts.db.devices.setScopes(id, normalizeScopes(scopes));
    if (next) this.log.info('device scopes changed', { deviceId: id, scopes: next.scopes });
    return next;
  }

  /** Revoke a device and drop its push subscriptions. Returns null for an unknown id. */
  revoke(id: string, why = 'revoked'): Device | null {
    const d = this.opts.db.devices.revoke(id, this.opts.clock.iso());
    if (!d) return null;
    const removed = this.opts.db.pushSubs.removeForDevice(id);
    this.log.info('device revoked', { deviceId: id, why, pushSubsRemoved: removed });
    return d;
  }
}
