/**
 * v0.6 Fleet, PairingService's `node` kind (S8): a server's join code is
 * 128 bits, 10 minutes, single use, kept only as its hash, and carries the
 * name the Mac reserved; each claim refuses another kind's code without
 * spending it; a store without devices (the hub's server codes) issues no
 * device.
 */
import { describe, expect, it } from 'vitest';
import { PAIR_CODE_TTL_MS } from '@jantar/protocol';
import { DeviceAuth, ExtensionAuth, PairingService } from '../../src/auth/index.js';
import { FakeClock } from '../../src/core/clock.js';
import { createMemoryDb } from '../../src/core/memory-db.js';

function setup() {
  const clock = new FakeClock();
  const db = createMemoryDb();
  const devices = new DeviceAuth({ db, clock });
  const extensions = new ExtensionAuth({ db, clock });
  return { clock, db, pairing: new PairingService({ clock, devices, extensions }) };
}

describe('PairingService, kind node', () => {
  it('a node code carries its reserved name and no scopes; claimed once', () => {
    const { pairing } = setup();
    const start = pairing.start({ kind: 'node', name: 'build-1', createdBy: 'cli' });
    expect(start.scopes).toEqual([]);
    expect(Buffer.from(start.code, 'base64url')).toHaveLength(16);
    expect(pairing.reservedNames()).toEqual(['build-1']);
    expect(pairing.claimNode(start.code)).toMatchObject({ ok: true, name: 'build-1', pairId: start.pairId });
    expect(pairing.claimNode(start.code)).toMatchObject({ ok: false, code: 'invalid' });
    expect(pairing.reservedNames()).toEqual([]);
  });

  it('a device or extension claim refuses a node code without spending it, and the reverse', () => {
    const { pairing } = setup();
    const node = pairing.start({ kind: 'node', name: 'build-1', createdBy: 'cli' }).code;
    expect(pairing.claim({ code: node, name: 'phone' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(pairing.claimExtension(node, 'chrome-extension://x')).toMatchObject({ ok: false, code: 'invalid' });
    const device = pairing.start({ createdBy: 'cli' }).code;
    const ext = pairing.start({ kind: 'extension', createdBy: 'cli' }).code;
    expect(pairing.claimNode(device)).toMatchObject({ ok: false, code: 'invalid' });
    expect(pairing.claimNode(ext)).toMatchObject({ ok: false, code: 'invalid' });
    // None was spent.
    expect(pairing.claimNode(node)).toMatchObject({ ok: true });
    expect(pairing.claim({ code: device, name: 'phone' })).toMatchObject({ ok: true });
    expect(pairing.claimExtension(ext, 'chrome-extension://x')).toMatchObject({ ok: true });
  });

  it('expires after 10 minutes, and an expired code is spent too', () => {
    const { pairing, clock } = setup();
    const code = pairing.start({ kind: 'node', name: 'build-1', createdBy: 'cli' }).code;
    clock.advance(PAIR_CODE_TTL_MS + 1);
    expect(pairing.claimNode(code)).toMatchObject({ ok: false, code: 'expired' });
    expect(pairing.claimNode(code)).toMatchObject({ ok: false, code: 'invalid' });
    const later = pairing.start({ kind: 'node', name: 'build-2', createdBy: 'cli' });
    clock.advance(PAIR_CODE_TTL_MS + 1);
    expect(pairing.reservedNames()).toEqual([]);
    expect(pairing.openCount()).toBe(0);
    expect(later.code).not.toBe(code);
  });

  it('malformed codes are invalid', () => {
    const { pairing } = setup();
    for (const code of ['', 'short', '!'.repeat(22), 'a'.repeat(200)]) expect(pairing.claimNode(code)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('a store of server codes only (no devices) never issues a device', () => {
    const clock = new FakeClock();
    const pairing = new PairingService({ clock });
    const device = pairing.start({ createdBy: 'cli' }).code;
    expect(pairing.claim({ code: device, name: 'phone' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(pairing.claimNode(pairing.start({ kind: 'node', name: 'node-1', createdBy: 'cli' }).code)).toMatchObject({ ok: true, name: 'node-1' });
  });
});
