import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@jantar/protocol';
import { FakeClock } from '../../src/core/clock.js';
import { createMemoryDb } from '../../src/core/memory-db.js';
import {
  DeviceAuth,
  OriginPolicy,
  PairingService,
  SlidingWindowLimiter,
  hashDeviceKey,
  hasScope,
  isLoopbackAddress,
  normalizeScopes,
  pairingUrl,
  publicDevice,
  proxyHeaderFor,
  rateLimitKey,
} from '../../src/auth/index.js';

const DAY = 24 * 3600_000;

describe('scopes', () => {
  it('nest: admin > launch > control > read', () => {
    expect(normalizeScopes(['admin'])).toEqual(['read', 'control', 'launch', 'admin']);
    expect(normalizeScopes(['launch'])).toEqual(['read', 'control', 'launch']);
    expect(normalizeScopes(['control', 'control'])).toEqual(['read', 'control']);
    expect(normalizeScopes(['read'])).toEqual(['read']);
    expect(hasScope(['control'], 'read')).toBe(true);
    expect(hasScope(['read', 'control'], 'admin')).toBe(false);
  });
});

describe('SlidingWindowLimiter', () => {
  it('limits per key over a sliding window and keeps the key map bounded', () => {
    const clock = new FakeClock();
    const l = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, clock, maxKeys: 5 });
    expect([1, 2, 3].map(() => l.hit('a').ok)).toEqual([true, true, true]);
    const refused = l.hit('a');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBe(60_000);
    expect(l.hit('b').ok).toBe(true); // other callers are unaffected
    clock.advance(30_000);
    expect(l.hit('a').ok).toBe(false);
    clock.advance(30_001);
    expect(l.hit('a').ok).toBe(true);
    for (let i = 0; i < 20; i++) l.hit(`k${i}`);
    expect(l.size()).toBeLessThanOrEqual(5);
  });
});

describe('DeviceAuth', () => {
  const setup = () => {
    const clock = new FakeClock();
    const db = createMemoryDb();
    return { clock, db, auth: new DeviceAuth({ db, clock }) };
  };

  it('issues a 32-byte key and stores only its hash', () => {
    const { db, auth } = setup();
    const { device, key } = auth.issue({ name: 'Phone', scopes: ['control'], userAgent: 'UA' });
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key, 'base64url')).toHaveLength(32);
    expect(device.keyHash).toBe(hashDeviceKey(key));
    expect(device.keyHash).not.toContain(key);
    expect(device.scopes).toEqual(['read', 'control']);
    expect(JSON.stringify(db.devices.list())).not.toContain(key);
    expect(publicDevice(device)).not.toHaveProperty('keyHash');
  });

  it('authenticates, rejecting missing, malformed, unknown and revoked keys', () => {
    const { auth } = setup();
    const { device, key } = auth.issue({ name: 'Phone', scopes: ['read'] });
    expect(auth.authenticate(key)).toMatchObject({ ok: true, device: { id: device.id } });
    expect(auth.authenticate(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(auth.authenticate('short')).toEqual({ ok: false, reason: 'malformed' });
    expect(auth.authenticate('B'.repeat(43))).toEqual({ ok: false, reason: 'unknown' });
    auth.revoke(device.id);
    expect(auth.authenticate(key)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('touches lastSeenAt at most every 5 minutes and expires after 30 idle days', () => {
    const { clock, db, auth } = setup();
    const { device, key } = auth.issue({ name: 'Phone', scopes: ['read'] });
    clock.advance(60_000);
    expect(auth.authenticate(key)).toMatchObject({ ok: true, touched: false });
    clock.advance(5 * 60_000);
    expect(auth.authenticate(key)).toMatchObject({ ok: true, touched: true });
    expect(db.devices.get(device.id)?.lastSeenAt).toBe(clock.iso());
    clock.advance(30 * DAY + 1);
    expect(auth.authenticate(key)).toEqual({ ok: false, reason: 'expired' });
    expect(db.devices.get(device.id)?.revokedAt).toBe(clock.iso());
  });

  it('revoke drops the device push subscriptions', () => {
    const { db, auth } = setup();
    const { device } = auth.issue({ name: 'Phone', scopes: ['read'] });
    db.pushSubs.upsert({ subscription: { endpoint: 'https://push.example.com/1', keys: { p256dh: 'p', auth: 'a' } }, deviceId: device.id, createdAt: '2026-01-15T10:00:00.000Z' });
    expect(auth.revoke(device.id)?.revokedAt).toBeTruthy();
    expect(db.pushSubs.list()).toEqual([]);
    expect(auth.revoke('nope')).toBeNull();
  });
});

describe('PairingService', () => {
  const setup = (maxOpen?: number) => {
    const clock = new FakeClock();
    const db = createMemoryDb();
    const devices = new DeviceAuth({ db, clock });
    return { clock, db, pairing: new PairingService({ clock, devices, ...(maxOpen ? { maxOpen } : {}) }) };
  };

  it('makes 128-bit single-use codes that default to read + control', () => {
    const { pairing } = setup();
    const a = pairing.start({ createdBy: 'cli' });
    expect(Buffer.from(a.code, 'base64url')).toHaveLength(16);
    expect(a.scopes).toEqual(['read', 'control']);
    const r = pairing.claim({ code: a.code, name: 'Phone' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.device.scopes).toEqual(['read', 'control']);
    expect(pairing.claim({ code: a.code, name: 'Phone' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(pairing.claim({ code: '../../etc', name: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('codes expire after 10 minutes and are used up by a late claim', () => {
    const { clock, pairing } = setup();
    const a = pairing.start({ createdBy: 'cli', scopes: ['admin'] });
    expect(a.scopes).toEqual(['read', 'control', 'launch', 'admin']);
    clock.advance(10 * 60_000);
    const b = pairing.start({ createdBy: 'cli' });
    clock.advance(1);
    expect(pairing.claim({ code: a.code, name: 'x' })).toMatchObject({ ok: false, code: 'expired' });
    expect(pairing.claim({ code: a.code, name: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(pairing.claim({ code: b.code, name: 'x' }).ok).toBe(true);
  });

  it('keeps at most N outstanding codes (oldest dropped)', () => {
    const { pairing } = setup(3);
    const codes = [1, 2, 3, 4].map(() => pairing.start({ createdBy: 'cli' }).code);
    expect(pairing.openCount()).toBe(3);
    expect(pairing.claim({ code: codes[0] as string, name: 'x' }).ok).toBe(false);
    expect(pairing.claim({ code: codes[3] as string, name: 'x' }).ok).toBe(true);
  });

  it('puts the code in the URL fragment', () => {
    expect(pairingUrl('https://mac.example.ts.net/', 'abc_DEF-123')).toBe('https://mac.example.ts.net/pair#c=abc_DEF-123');
  });
});

describe('OriginPolicy', () => {
  const policy = (remote: Record<string, unknown> = {}, port = 7420) => {
    const settings = SettingsSchema.parse({ remote });
    return new OriginPolicy({ settings: () => settings, port: () => port });
  };

  it('allows the loopback origins on the bound port only', () => {
    const p = policy();
    expect(p.originAllowed('http://127.0.0.1:7420')).toBe(true);
    expect(p.originAllowed('http://localhost:7420')).toBe(true);
    expect(p.originAllowed('http://[::1]:7420')).toBe(true);
    expect(p.originAllowed('http://127.0.0.1:7421')).toBe(false);
    expect(p.originAllowed('https://127.0.0.1:7420')).toBe(false);
    expect(p.originAllowed('null')).toBe(false);
    expect(p.originAllowed(undefined)).toBe(false);
    expect(p.originAllowed('chrome-extension://abc')).toBe(false);
    expect(p.originAllowed('not a url')).toBe(false);
  });

  it('adds remote.publicUrl and remote.allowedOrigins', () => {
    const p = policy({ publicUrl: 'https://Mac.Example.ts.net/', allowedOrigins: ['https://alt.example:8443', 'bogus'] });
    expect(p.originAllowed('https://mac.example.ts.net')).toBe(true);
    expect(p.originAllowed('https://alt.example:8443')).toBe(true);
    expect(p.hostAllowed('mac.example.ts.net')).toBe(true);
    expect(p.hostAllowed('alt.example:8443')).toBe(true);
    expect(p.hostAllowed('127.0.0.1:7420')).toBe(true);
    expect(p.hostAllowed('evil.example')).toBe(false);
    expect(p.hostAllowed(undefined)).toBe(false);
  });

  it('skips the Host check only in lan mode', () => {
    expect(policy({ mode: 'lan' }).hostAllowed('192.168.1.20:7420')).toBe(true);
    expect(policy({ mode: 'lan' }).originAllowed('http://192.168.1.20:7420')).toBe(false);
  });
});

describe('rateLimitKey', () => {
  it('uses the socket peer by default: forwarded headers are client-chosen values', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('100.64.1.2')).toBe(false);
    expect(rateLimitKey({ remoteAddress: '127.0.0.1', headers: {} })).toBe('ip:127.0.0.1');
    const spoofed = { 'x-forwarded-for': '100.64.0.7', 'cf-connecting-ip': '203.0.113.5', 'x-real-ip': '198.51.100.1' };
    for (const mode of ['loopback', 'lan'] as const) {
      expect(proxyHeaderFor(mode)).toBeNull();
      expect(rateLimitKey({ remoteAddress: '127.0.0.1', headers: spoofed }, proxyHeaderFor(mode)), mode).toBe('ip:127.0.0.1');
    }
    expect(rateLimitKey({ remoteAddress: '127.0.0.1', headers: spoofed })).toBe('ip:127.0.0.1');
  });

  it('behind Tailscale Serve: only the last X-Forwarded-For hop (the one tailscaled added)', () => {
    const p = proxyHeaderFor('tailscale');
    expect(p).toBe('x-forwarded-for');
    expect(rateLimitKey({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': 'spoofed, 100.64.0.7' } }, p)).toBe('fwd:100.64.0.7');
    // Serve passes a client's own CF-Connecting-IP through: it must not pick the bucket.
    expect(rateLimitKey({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '100.64.0.7', 'cf-connecting-ip': '203.0.113.5' } }, p)).toBe(
      'fwd:100.64.0.7',
    );
    expect(rateLimitKey({ remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.5', 'x-real-ip': '1.1.1.1' } }, p)).toBe('ip:127.0.0.1');
  });

  it('behind a Cloudflare tunnel: only CF-Connecting-IP', () => {
    const p = proxyHeaderFor('cloudflare');
    expect(p).toBe('cf-connecting-ip');
    expect(rateLimitKey({ remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '1.2.3.4' } }, p)).toBe(
      'fwd:203.0.113.5',
    );
    expect(rateLimitKey({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } }, p)).toBe('ip:127.0.0.1');
  });

  it('a non-loopback peer cannot pick its own bucket in any mode', () => {
    for (const mode of ['loopback', 'lan', 'tailscale', 'cloudflare'] as const) {
      const headers = { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' };
      expect(rateLimitKey({ remoteAddress: '192.168.1.9', headers }, proxyHeaderFor(mode)), mode).toBe('ip:192.168.1.9');
    }
  });
});
