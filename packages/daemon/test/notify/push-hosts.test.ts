/**
 * SEC-3: the daemon only ever POSTs to real push services. A subscription is
 * a URL a paired device hands us; without a host check, a read-only device
 * could make the Mac call loopback, LAN, tailnet or metadata addresses on
 * every notification.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PUSH_SUBS_PER_DEVICE, pushEndpointProblem } from '../../src/notify/push-hosts.js';
import { h, makeApi, pairCookie, type TestApi } from '../api/fakes.js';

const GOOD = [
  'https://web.push.apple.com/QGuQyavXutnMH2-c',
  'https://api.push.apple.com/3/device/abc',
  'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91b',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
  'https://wns2-by3p.notify.windows.com/w/?token=BQYAAA',
  'https://FCM.GoogleAPIs.com/fcm/send/upper',
];

const BAD: Record<string, string> = {
  'http, not https': 'http://fcm.googleapis.com/fcm/send/x',
  'IPv4 literal': 'https://142.250.72.10/fcm/send/x',
  'loopback': 'https://127.0.0.1:8443/admin/reset',
  'localhost': 'https://localhost:631/',
  'IPv6 loopback': 'https://[::1]/x',
  'IPv6 literal': 'https://[2607:f8b0:4005:80a::200a]/x',
  'IPv4-mapped IPv6': 'https://[::ffff:10.0.0.1]/x',
  'private 10/8': 'https://10.0.0.1:8443/internal/hook',
  'private 192.168/16': 'https://192.168.1.1/cgi-bin/x',
  'link-local metadata': 'https://169.254.169.254/latest',
  'decimal IPv4': 'https://2130706433/x',
  '.local': 'https://printer.local/x',
  '.ts.net': 'https://mac.tailnet-example.ts.net/x',
  'unknown host': 'https://push.example.com/send/xyz',
  'look-alike suffix': 'https://evilpush.apple.com/x',
  'allowed name as a subdomain of another': 'https://fcm.googleapis.com.evil.example/x',
  'trailing dot': 'https://fcm.googleapis.com./x',
  'explicit port': 'https://fcm.googleapis.com:8443/x',
  'credentials': 'https://user:pass@fcm.googleapis.com/x', // jantar-secrets-allow (synthetic userinfo, not an address)
  'not a URL': 'nope',
};

describe('pushEndpointProblem', () => {
  it('accepts the push services browsers use', () => {
    for (const url of GOOD) expect(pushEndpointProblem(url), url).toBeNull();
    // :443 is the https default, so the URL drops it.
    expect(pushEndpointProblem('https://fcm.googleapis.com:443/fcm/send/x')).toBeNull();
  });

  for (const [what, url] of Object.entries(BAD)) {
    it(`refuses ${what}`, () => {
      expect(pushEndpointProblem(url)).toMatch(/push/);
    });
  }
});

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const sub = (endpoint: string) => ({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });

describe('POST /v1/push/subscribe', () => {
  it('refuses endpoints that are not a known push service (nothing is stored)', async () => {
    api = await makeApi();
    const { cookie } = await pairCookie(api, ['read']);
    for (const [what, url] of Object.entries(BAD)) {
      if (!url.startsWith('https://')) continue;
      const res = await api.tcp.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h(cookie), payload: sub(url) });
      expect(res.statusCode, what).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    expect(api.ctx.db.pushSubs.list()).toHaveLength(0);
  });

  it(`keeps at most ${MAX_PUSH_SUBS_PER_DEVICE} subscriptions per device, dropping the oldest`, async () => {
    api = await makeApi();
    const phone = await pairCookie(api, ['read']);
    const other = await pairCookie(api, ['read']);
    await api.tcp.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h(other.cookie), payload: sub('https://web.push.apple.com/other') });
    for (let i = 0; i < 12; i++) {
      api.ctx.clock.advance(1000);
      const res = await api.tcp.inject({
        method: 'POST',
        url: '/v1/push/subscribe',
        headers: h(phone.cookie),
        payload: sub(`https://fcm.googleapis.com/fcm/send/n${i}`),
      });
      expect(res.statusCode).toBe(200);
    }
    const mine = api.ctx.db.pushSubs.list().filter((r) => r.deviceId === phone.deviceId);
    expect(mine.map((r) => r.subscription.endpoint).sort()).toEqual(
      [7, 8, 9, 10, 11].map((i) => `https://fcm.googleapis.com/fcm/send/n${i}`).sort(),
    );
    // Another device's subscription is untouched.
    expect(api.ctx.db.pushSubs.list().filter((r) => r.deviceId === other.deviceId)).toHaveLength(1);
    // Re-subscribing an endpoint it already has does not evict anything.
    api.ctx.clock.advance(1000);
    await api.tcp.inject({ method: 'POST', url: '/v1/push/subscribe', headers: h(phone.cookie), payload: sub('https://fcm.googleapis.com/fcm/send/n7') });
    expect(api.ctx.db.pushSubs.list().filter((r) => r.deviceId === phone.deviceId)).toHaveLength(5);
  });
});
