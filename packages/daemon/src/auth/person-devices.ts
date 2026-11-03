/**
 * v0.11 People: her devices (jantar.db `person_devices`), modelled on
 * auth/devices.ts. Each holds a random 32-byte key in the
 * `__Host-jantar_person` cookie and a second random 32-byte secret her app
 * keeps in IndexedDB `jantar-person`. Only prefixed sha256 hashes are stored
 * (`jantar-person-device:`, a prefix the owner's devices never use), so an
 * owner key can never match a person row or the reverse. The same 30-day idle
 * expiry as his devices.
 *
 * A person device has no scopes: it reaches her routes (scope `person`) and
 * nothing else. The cookie is read only on PERSON_PREFIX and only on the
 * people host (api/app.ts).
 */
import { DEVICE_IDLE_EXPIRY_DAYS } from '@jantar/protocol';
import { PERSON_DEVICES_MAX, type PersonDevicePublic } from '@jantar/protocol/people';
import type { Clock, Db, Logger, PersonDeviceRecord } from '../contracts.js';
import { safeEqual, sha256Hex } from '../core/hash.js';
import { newId, randomToken } from '../core/ids.js';
import { silentLogger } from '../core/log.js';

/** A key or secret: 32 random bytes, base64url (43 characters). */
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export function hashPersonKey(key: string): string {
  return sha256Hex(`jantar-person-device:${key}`);
}

export function hashPersonSecret(secret: string): string {
  return sha256Hex(`jantar-person-device-secret:${secret}`);
}

export type PersonAuthResult = { ok: true; device: PersonDeviceRecord } | { ok: false; reason: 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired' };

export function personSecretMatches(device: Pick<PersonDeviceRecord, 'secretHash'>, presented: string | undefined | null): boolean {
  if (!device.secretHash || !presented || !KEY_RE.test(presented)) return false;
  return safeEqual(hashPersonSecret(presented), device.secretHash);
}

/** Her device as both sides list it: never a hash, never last-seen for him (C20). */
export function publicPersonDevice(d: PersonDeviceRecord): PersonDevicePublic {
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    ...(d.accessEmail ? { accessEmail: d.accessEmail } : {}),
    ...(d.revokedAt ? { revokedAt: d.revokedAt } : {}),
  };
}

export class PersonDeviceAuth {
  private readonly idleMs: number;
  private readonly log: Logger;

  constructor(private readonly opts: { db: Pick<Db, 'people'>; clock: Pick<Clock, 'now' | 'iso'>; log?: Logger; idleDays?: number }) {
    this.idleMs = (opts.idleDays ?? DEVICE_IDLE_EXPIRY_DAYS) * DAY_MS;
    this.log = opts.log ?? silentLogger;
  }

  cookieMaxAgeS(): number {
    return Math.floor(this.idleMs / 1000);
  }

  authenticate(key: string | undefined | null): PersonAuthResult {
    if (!key) return { ok: false, reason: 'missing' };
    if (!KEY_RE.test(key)) return { ok: false, reason: 'malformed' };
    const device = this.opts.db.people.devices.byKeyHash(hashPersonKey(key));
    if (!device) return { ok: false, reason: 'unknown' };
    if (device.revokedAt) return { ok: false, reason: 'revoked' };
    const now = this.opts.clock.now();
    const last = Date.parse(device.lastSeenAt);
    if (Number.isFinite(last) && now - last > this.idleMs) {
      this.revoke(device.id, 'idle expiry');
      return { ok: false, reason: 'expired' };
    }
    if (!Number.isFinite(last) || now - last >= TOUCH_EVERY_MS) {
      const at = this.opts.clock.iso(now);
      this.opts.db.people.devices.touch(device.id, at);
      device.lastSeenAt = at;
    }
    return { ok: true, device };
  }

  /** A new device of hers; the key and secret are returned once and never stored. */
  issue(input: { personId: string; name: string; userAgent?: string | undefined; accessEmail?: string | undefined }): { device: PersonDeviceRecord; key: string; secret: string } {
    const key = randomToken(32);
    const secret = randomToken(32);
    const at = this.opts.clock.iso();
    const device: PersonDeviceRecord = {
      id: newId(),
      personId: input.personId,
      name: input.name.slice(0, 64),
      keyHash: hashPersonKey(key),
      secretHash: hashPersonSecret(secret),
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 256) : null,
      accessEmail: input.accessEmail ? input.accessEmail.slice(0, 200) : null,
    };
    this.opts.db.people.devices.insert(device);
    return { device, key, secret };
  }

  get(id: string): PersonDeviceRecord | null {
    return this.opts.db.people.devices.get(id);
  }

  list(personId: string): PersonDeviceRecord[] {
    return this.opts.db.people.devices.listFor(personId);
  }

  active(personId: string): PersonDeviceRecord[] {
    return this.list(personId).filter((d) => !d.revokedAt);
  }

  /** Whether another device may be linked (PERSON_DEVICES_MAX). */
  roomForAnother(personId: string): boolean {
    return this.active(personId).length < PERSON_DEVICES_MAX;
  }

  /**
   * Revoke one device, drop its push subscriptions and void the unspent
   * link codes it minted (M4: a stolen phone's code dies with it). Null for
   * an unknown id.
   */
  revoke(id: string, why = 'revoked'): PersonDeviceRecord | null {
    const at = this.opts.clock.iso();
    const d = this.opts.db.people.devices.revoke(id, at);
    if (!d) return null;
    const subs = this.opts.db.people.pushSubs.removeForDevice(id);
    const codes = this.opts.db.people.linkCodes.revokeByDevice(id, at);
    this.log.info('person device revoked', { deviceId: id, why, pushSubsRemoved: subs, linkCodesVoided: codes });
    return d;
  }

  /** Revoke every device of hers, her push list and her unspent link codes. */
  revokeAllFor(personId: string, why: string): number {
    let n = 0;
    for (const d of this.active(personId)) if (this.revoke(d.id, why)) n += 1;
    this.opts.db.people.pushSubs.removeForPerson(personId);
    this.opts.db.people.linkCodes.revokeAllFor(personId, this.opts.clock.iso());
    return n;
  }

  /**
   * His revoke of one device of hers (C18): never her last active one, so a
   * stolen admin phone can't cut her off quietly. `last_device` then.
   */
  revokeByOwner(personId: string, id: string): 'ok' | 'not_found' | 'last_device' {
    const d = this.get(id);
    if (!d || d.personId !== personId || d.revokedAt) return 'not_found';
    if (this.active(personId).length <= 1) return 'last_device';
    this.revoke(id, 'owner');
    return 'ok';
  }
}
