/**
 * The SSRF guard (spec 13.1), tests G1-G5, against local HTTPS servers that
 * stand in for public hosts (read-helpers.ts): the BlockList (G1), the URL
 * and host rules (G2), DNS (every address checked; the socket gets exactly
 * the vetted one: G3), redirects re-checked (G4), and caps on decompressed
 * bytes, content type against magic, and timeouts (G5). Synthetic hosts on
 * .test only; no real network.
 */
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCKED_V6, Guard, checkUrl, hostRefused, isBlockedAddress, magicOf, ownHosts } from '../../src/intel/read/guard.js';
import { acceptText } from '../../src/intel/read/url.js';
import { HAVE_OPENSSL, PUBLIC_ADDR, TINY_JPEG, httpsServer, seamFor, type TestServer } from './read-helpers.js';

const NONE: ReadonlySet<string> = new Set();
let servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

async function serve(handler: Parameters<typeof httpsServer>[0]): Promise<TestServer> {
  const s = await httpsServer(handler);
  servers.push(s);
  return s;
}

describe('G1: the BlockList', () => {
  it('blocks loopback, private, link-local, CGNAT, metadata, ULA, NAT64, multicast and broadcast; passes public addresses', () => {
    for (const a of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.169.254',
      'fd7a:115c:a1e0::1',
      'fe80::1',
      '64:ff9b::a00:1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      'not an address',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '::ffff:8.8.8.8', '2606:4700::1', PUBLIC_ADDR]) expect(isBlockedAddress(a), a).toBe(false);
  });

  it('never lists ::ffff:0:0/96 (Node would then block every IPv4 address)', () => {
    expect(BLOCKED_V6.some((r) => r.toLowerCase().startsWith('::ffff'))).toBe(false);
  });
});

describe('G2: the URL and host rules', () => {
  const own = ownHosts({ publicUrl: 'https://mac.example-door.test', allowedOrigins: ['https://door2.example.test'] }, 'my-mac.example.test');

  it('refuses each case before any DNS', () => {
    const refused: [string, 'badLink' | 'blocked'][] = [
      ['ftp://example.test/a', 'badLink'],
      ['https://user:pw@example.test/a', 'badLink'],
      ['https://example.test:8443/a', 'badLink'],
      ['https://127.0.0.1/a', 'blocked'],
      ['https://[::1]/a', 'blocked'],
      ['https://0x7f000001/a', 'blocked'],
      ['https://localhost/a', 'blocked'],
      ['https://api.localhost/a', 'blocked'],
      ['https://intranet/a', 'blocked'],
      ['https://printer.local/a', 'blocked'],
      ['https://svc.internal/a', 'blocked'],
      ['https://nas.lan/a', 'blocked'],
      ['https://router.home.arpa/a', 'blocked'],
      ['https://mac.tailnet.ts.net/a', 'blocked'],
      ['https://hidden.onion/a', 'blocked'],
      ['https://my-mac.example.test/a', 'blocked'],
      ['https://mac.example-door.test/v1/capture/save', 'blocked'],
      ['https://door2.example.test/', 'blocked'],
      [`https://example.test/${'a'.repeat(2001)}`, 'badLink'],
      ['http://example.test/a', 'badLink'],
    ];
    for (const [href, why] of refused) expect(checkUrl(href, own), href).toEqual({ ok: false, why });
    expect(hostRefused('Example.TEST.', own)).toBe(false);
    expect(checkUrl('https://www.example.test/a?b=1', own).ok).toBe(true);
    expect(checkUrl('https://www.example.test:443/a', own).ok).toBe(true);
  });

  it('an http link the user sent is upgraded to https once; another port stays refused', () => {
    expect(acceptText('see http://www.example.test/post', NONE)).toEqual({ ok: true, link: 'https://www.example.test/post', note: 'see' });
    // :80 is http's own port (the URL parser drops it), so the link is the same without it.
    expect(acceptText('http://www.example.test:80/post', NONE)).toEqual({ ok: true, link: 'https://www.example.test/post', note: null });
    expect(acceptText('http://www.example.test:8080/post', NONE)).toEqual({ ok: false, why: 'badLink' });
  });
});

describe.skipIf(!HAVE_OPENSSL)('G3: DNS', () => {
  it('one bad address in the set refuses, and nothing is dialed', async () => {
    const s = await serve((_q, r) => r.end('<p>hi</p>'));
    const dialed: string[] = [];
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port, { addrs: { 'a.example.test': [PUBLIC_ADDR, '10.0.0.9'] }, dialed }) });
    const r = await guard.fetch('https://a.example.test/', { kind: 'html', maxBytes: 1000, totalMs: 5000 });
    expect(r).toMatchObject({ ok: false, why: 'blocked' });
    expect(dialed).toEqual([]);
    expect(s.seen).toEqual([]);
  });

  it('a name that resolves only to 127.0.0.1 is refused like a literal', async () => {
    const s = await serve((_q, r) => r.end('x'));
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port, { addrs: { 'loop.example.test': ['127.0.0.1'] } }) });
    expect(await guard.fetch('https://loop.example.test/', { kind: 'html', maxBytes: 1000, totalMs: 5000 })).toMatchObject({ ok: false, why: 'blocked' });
  });

  it('the socket gets exactly the vetted address (pinned), with the host as the TLS name and Host header', async () => {
    const s = await serve((q, r) => {
      r.setHeader('content-type', 'text/html; charset=utf-8');
      r.end(`<p>${q.headers['user-agent']}</p>`);
    });
    const dialed: string[] = [];
    const asked: string[] = [];
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port, { addrs: { 'b.example.test': ['8.8.4.4', PUBLIC_ADDR] }, dialed, asked }) });
    const r = await guard.fetch('https://b.example.test/x?y=1', { kind: 'html', maxBytes: 10_000, totalMs: 5000 });
    expect(r.ok).toBe(true);
    expect(asked).toEqual(['b.example.test']);
    expect(dialed).toEqual(['8.8.4.4:443']);
    expect(s.seen).toEqual([{ host: 'b.example.test', path: '/x?y=1' }]);
    if (r.ok) expect(r.body.toString()).toContain('Jantar/0.8');
  });

  it('no address at all is a dns failure, never a request', async () => {
    const s = await serve((_q, r) => r.end('x'));
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port, { addrs: { 'gone.example.test': [] } }) });
    expect(await guard.fetch('https://gone.example.test/', { kind: 'html', maxBytes: 100, totalMs: 5000 })).toMatchObject({ ok: false, why: 'dns' });
    expect(s.seen).toEqual([]);
  });
});

describe.skipIf(!HAVE_OPENSSL)('G4: redirects', () => {
  it('each hop is checked again: a public hop is followed, the inside of a network and http are refused', async () => {
    const s = await serve((q, r) => {
      if (q.url === '/start') return void r.writeHead(302, { location: 'https://c.example.test/next' }).end();
      if (q.url === '/next') return void r.writeHead(200, { 'content-type': 'text/html' }).end('<p>landed</p>');
      if (q.url === '/to-loopback') return void r.writeHead(301, { location: 'https://127.0.0.1/admin' }).end();
      if (q.url === '/to-private-name') return void r.writeHead(307, { location: 'https://evil.example.test/' }).end();
      if (q.url === '/to-http') return void r.writeHead(308, { location: 'http://c.example.test/next' }).end();
      if (q.url === '/to-local') return void r.writeHead(302, { location: 'https://printer.local/' }).end();
      r.writeHead(404).end();
    });
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port, { addrs: { 'evil.example.test': ['169.254.169.254'] } }) });
    const ok = await guard.fetch('https://c.example.test/start', { kind: 'html', maxBytes: 1000, totalMs: 5000 });
    expect(ok).toMatchObject({ ok: true, url: 'https://c.example.test/next' });
    for (const path of ['/to-loopback', '/to-private-name', '/to-http', '/to-local']) {
      expect(await guard.fetch(`https://c.example.test${path}`, { kind: 'html', maxBytes: 1000, totalMs: 5000 }), path).toMatchObject({ ok: false, why: 'blocked' });
    }
    expect(s.seen.map((x) => x.path)).not.toContain('/admin');
  });

  it('five hops are followed; the sixth is refused', async () => {
    const s = await serve((q, r) => {
      const n = Number(q.url?.slice(1));
      if (n < 99) return void r.writeHead(302, { location: `/${n + 1}` }).end();
      r.end();
    });
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port) });
    const five = await serve((q, r) => {
      const n = Number(q.url?.slice(1));
      if (n < 5) return void r.writeHead(302, { location: `/${n + 1}` }).end();
      r.writeHead(200, { 'content-type': 'text/html' }).end('<p>end</p>');
    });
    const guard5 = new Guard({ own: () => NONE, net: seamFor(five.port) });
    expect(await guard5.fetch('https://d.example.test/0', { kind: 'html', maxBytes: 1000, totalMs: 5000 })).toMatchObject({ ok: true, url: 'https://d.example.test/5' });
    expect(await guard.fetch('https://d.example.test/0', { kind: 'html', maxBytes: 1000, totalMs: 5000 })).toMatchObject({ ok: false, why: 'redirects' });
    expect(s.seen).toHaveLength(6);
  });
});

describe.skipIf(!HAVE_OPENSSL)('G5: caps, types and time', () => {
  it('counts decompressed bytes: a small gzip that inflates past the cap is tooBig', async () => {
    const big = gzipSync(Buffer.alloc(2_000_000, 0x61));
    const s = await serve((_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': String(big.length) });
      r.end(big);
    });
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port) });
    expect(big.length).toBeLessThan(100_000);
    expect(await guard.fetch('https://e.example.test/', { kind: 'html', maxBytes: 1_000_000, totalMs: 5000 })).toMatchObject({ ok: false, why: 'tooBig' });
    const fits = await guard.fetch('https://e.example.test/', { kind: 'html', maxBytes: 3_000_000, totalMs: 5000 });
    expect(fits.ok && fits.body.length).toBe(2_000_000);
  });

  it('a declared length over the cap is refused before the body', async () => {
    const s = await serve((_q, r) => {
      r.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '9000000' });
      r.end(TINY_JPEG);
    });
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port) });
    expect(await guard.fetch('https://e.example.test/i.jpg', { kind: 'image', maxBytes: 8_000_000, totalMs: 5000 })).toMatchObject({ ok: false, why: 'tooBig' });
  });

  it('the type must fit what was asked, and the magic bytes must agree', async () => {
    const s = await serve((q, r) => {
      if (q.url === '/html-as-image') return void r.writeHead(200, { 'content-type': 'image/jpeg' }).end('<html><body>not a picture, padding</body></html>');
      if (q.url === '/image') return void r.writeHead(200, { 'content-type': 'image/jpeg' }).end(TINY_JPEG);
      if (q.url === '/page-asked-image') return void r.writeHead(200, { 'content-type': 'text/html' }).end('<p>x</p>');
      if (q.url === '/webm') return void r.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40)]));
      if (q.url === '/pdf-as-html') return void r.writeHead(200, { 'content-type': 'text/html' }).end(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(40)]));
      r.writeHead(500).end();
    });
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port) });
    const get = (path: string, kind: 'html' | 'image' | 'media') => guard.fetch(`https://f.example.test${path}`, { kind, maxBytes: 100_000, totalMs: 5000 });
    expect(await get('/html-as-image', 'image')).toMatchObject({ ok: false, why: 'type' });
    expect(await get('/image', 'image')).toMatchObject({ ok: true });
    expect(await get('/page-asked-image', 'image')).toMatchObject({ ok: false, why: 'type' });
    expect(await get('/webm', 'media')).toMatchObject({ ok: false, why: 'format' });
    expect(await get('/pdf-as-html', 'html')).toMatchObject({ ok: false, why: 'type' });
    expect(await get('/nope', 'html')).toMatchObject({ ok: false, why: 'status', status: 500 });
  });

  it('a server that never answers ends at the total time cap', async () => {
    const s = await serve(() => {
      /* never answers */
    });
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port) });
    const t0 = Date.now();
    expect(await guard.fetch('https://g.example.test/', { kind: 'html', maxBytes: 1000, totalMs: 300 })).toMatchObject({ ok: false, why: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('404 and 410 are notFound; headers-only stops at the first 200', async () => {
    const s = await serve((q, r) => {
      if (q.url === '/gone') return void r.writeHead(410).end();
      r.writeHead(200, { 'content-type': 'application/pdf' }).end(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1000)]));
    });
    const guard = new Guard({ own: () => NONE, net: seamFor(s.port) });
    expect(await guard.fetch('https://h.example.test/gone', { kind: 'page', maxBytes: 1000, totalMs: 5000 })).toMatchObject({ ok: false, why: 'notFound' });
    const head = await guard.fetch('https://h.example.test/doc', { kind: 'page', maxBytes: 10, totalMs: 5000, headersOnly: true });
    expect(head).toMatchObject({ ok: true, type: 'application/pdf', bytes: 0 });
  });

  it('magicOf knows the formats the helper takes, and webm/mkv', () => {
    expect(magicOf(TINY_JPEG)).toBe('jpeg');
    expect(magicOf(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(magicOf(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('mp4');
    expect(magicOf(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBe('heic');
    expect(magicOf(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe('ebml');
    expect(magicOf(Buffer.from('<html>'))).toBeNull();
  });
});
