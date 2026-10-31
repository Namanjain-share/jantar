/**
 * MA5 (unit part): the extension's key and the pairing kinds.
 *
 * - ExtensionAuth: a 43-character key stored only as its prefixed hash
 *   (never the device prefix), bound to the claim's Origin; a sixth key
 *   revokes the oldest; idle 90 days is revoked; lastSeenAt is written at
 *   most every 5 minutes; revokeAll.
 * - PairingService: a code has a kind; each claim answers `invalid` for the
 *   other kind without spending the code; an extension code is single use
 *   and expires at 10 minutes like a device's.
 */
import { describe, expect, it } from 'vitest';
import { EXTENSION_ID, EXTENSION_IDLE_MS } from '@jantar/protocol';
import { FakeClock } from '../../src/core/clock.js';
import { createMemoryDb } from '../../src/core/memory-db.js';
import { memoryLogger } from '../../src/core/log.js';
import { DeviceAuth, ExtensionAuth, PairingService, hashDeviceKey, hashExtensionKey } from '../../src/auth/index.js';

const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

function rig() {
  const clock = new FakeClock();
  const db = createMemoryDb();
  const log = memoryLogger();
  const devices = new DeviceAuth({ db, clock });
  const extensions = new ExtensionAuth({ db, clock, log });
  const pairing = new PairingService({ clock, devices, extensions, log });
  return { clock, db, log, devices, extensions, pairing };
}

describe('ExtensionAuth', () => {
  it('issues a 43-character key, keeps only its prefixed hash and the Origin, and authenticates it', () => {
    const { db, extensions } = rig();
    const { id, key } = extensions.issue(ORIGIN);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rec = db.extensions.get(id);
    expect(rec).toMatchObject({ keyHash: hashExtensionKey(key), origin: ORIGIN, lastSeenAt: null, revokedAt: null });
    expect(hashExtensionKey(key)).not.toBe(hashDeviceKey(key));
    expect(JSON.stringify(db.extensions.list())).not.toContain(key);
    const r = extensions.authenticate(key);
    expect(r.ok && r.extension.id).toBe(id);
  });

  it('refuses a missing, malformed, unknown or revoked key', () => {
    const { extensions } = rig();
    const { key } = extensions.issue(ORIGIN);
    expect(extensions.authenticate(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(extensions.authenticate('short')).toEqual({ ok: false, reason: 'malformed' });
    expect(extensions.authenticate('A'.repeat(43))).toEqual({ ok: false, reason: 'unknown' });
    expect(extensions.revokeAll()).toBe(1);
    expect(extensions.authenticate(key)).toEqual({ ok: false, reason: 'revoked' });
    expect(extensions.list()).toEqual([]);
  });

  it("a device's key is never an extension's (the hash prefixes differ)", () => {
    const { devices, extensions } = rig();
    const { key } = devices.issue({ name: 'Phone', scopes: ['read', 'control'] });
    expect(extensions.authenticate(key)).toEqual({ ok: false, reason: 'unknown' });
    const ext = extensions.issue(ORIGIN);
    expect(devices.authenticate(ext.key)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('a key idle past 90 days is revoked; one used now and then is not; lastSeenAt is written at most every 5 minutes', () => {
    const { clock, db, extensions } = rig();
    const a = extensions.issue(ORIGIN);
    const b = extensions.issue(ORIGIN);
    expect(extensions.authenticate(b.key).ok).toBe(true);
    const first = db.extensions.get(b.id)?.lastSeenAt;
    expect(first).toBe(clock.iso());
    clock.advance(60_000);
    expect(extensions.authenticate(b.key).ok).toBe(true);
    expect(db.extensions.get(b.id)?.lastSeenAt).toBe(first);
    clock.advance(5 * 60_000);
    expect(extensions.authenticate(b.key).ok).toBe(true);
    expect(db.extensions.get(b.id)?.lastSeenAt).toBe(clock.iso());
    clock.advance(EXTENSION_IDLE_MS - 60_000);
    expect(extensions.authenticate(b.key).ok).toBe(true);
    // `a` was never used: idle since it was paired.
    expect(extensions.authenticate(a.key)).toEqual({ ok: false, reason: 'expired' });
    expect(db.extensions.get(a.id)?.revokedAt).toBeTruthy();
  });

  it('a sixth active key revokes the oldest', () => {
    const { clock, extensions } = rig();
    const keys = Array.from({ length: 6 }, () => {
      clock.advance(1000);
      return extensions.issue(ORIGIN);
    });
    expect(extensions.authenticate(keys[0]?.key)).toEqual({ ok: false, reason: 'revoked' });
    for (const k of keys.slice(1)) expect(extensions.authenticate(k.key).ok).toBe(true);
    expect(extensions.list().map((e) => e.id)).toEqual(keys.slice(1).map((k) => k.id));
  });

  it('logs ids and counts, never a key', () => {
    const { log, extensions } = rig();
    const keys = Array.from({ length: 7 }, () => extensions.issue(ORIGIN).key);
    extensions.revokeAll();
    const text = JSON.stringify(log.records);
    for (const k of keys) expect(text).not.toContain(k);
  });
});

describe('PairingService kinds', () => {
  it('an extension code is invalid at the device claim, and still works at its own', () => {
    const { pairing } = rig();
    const { code } = pairing.start({ kind: 'extension', createdBy: 'cli' });
    expect(pairing.claim({ code, name: 'Phone' })).toMatchObject({ ok: false, code: 'invalid' });
    const r = pairing.claimExtension(code, ORIGIN);
    expect(r.ok).toBe(true);
    // Single use.
    expect(pairing.claimExtension(code, ORIGIN)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it("a device code is invalid at the extension's claim, and still works at its own (the default kind)", () => {
    const { pairing } = rig();
    const { code, scopes } = pairing.start({ createdBy: 'cli' });
    expect(scopes).toEqual(['read', 'control']);
    expect(pairing.claimExtension(code, ORIGIN)).toMatchObject({ ok: false, code: 'invalid' });
    expect(pairing.claim({ code, name: 'Phone' }).ok).toBe(true);
  });

  it('an extension code expires at 10 minutes and is spent by the late try', () => {
    const { clock, pairing } = rig();
    const { code } = pairing.start({ kind: 'extension', createdBy: 'cli' });
    clock.advance(10 * 60_000 + 1);
    expect(pairing.claimExtension(code, ORIGIN)).toMatchObject({ ok: false, code: 'expired' });
    expect(pairing.openCount()).toBe(0);
  });

  it("the claim binds the Origin to the key, and the extension's code carries no scopes", () => {
    const { db, pairing } = rig();
    const start = pairing.start({ kind: 'extension', scopes: ['admin'], createdBy: 'cli' });
    expect(start.scopes).toEqual([]);
    const r = pairing.claimExtension(start.code, ORIGIN);
    if (!r.ok) throw new Error('claim failed');
    expect(db.extensions.get(r.id)?.origin).toBe(ORIGIN);
    expect(db.devices.list()).toEqual([]);
  });

  it('without an ExtensionAuth every extension claim is invalid', () => {
    const clock = new FakeClock();
    const db = createMemoryDb();
    const pairing = new PairingService({ clock, devices: new DeviceAuth({ db, clock }) });
    const { code } = pairing.start({ kind: 'extension', createdBy: 'cli' });
    expect(pairing.claimExtension(code, ORIGIN)).toMatchObject({ ok: false, code: 'invalid' });
  });
});
