/**
 * Test helpers for Intel's reads: a throwaway self-signed certificate (made
 * with the system's openssl in a temp dir, never committed), local HTTPS
 * servers that stand in for public hosts, and the guard's test seam (a
 * lookup that answers a public address, and a dial that sends that address
 * to the local server). The BlockList is never relaxed: a lookup that
 * answers 127.0.0.1 is refused like any other.
 *
 * Fake helper, yt-dlp and claude answers for ctx.exec live here too: no
 * Swift compile, no real browser, no network.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardNet } from '../../src/intel/read/guard.js';

/** Names the test certificate covers. */
export const TEST_HOSTS = [
  'example.test',
  '*.example.test',
  'www.instagram.com',
  'www.youtube.com',
  'i.ytimg.com',
  'www.tiktok.com',
  'x.com',
  'cdn.syndication.twimg.com',
  'publish.x.com',
  'video.twimg.com',
  'pbs.twimg.com',
  'www.reddit.com',
  'www.linkedin.com',
  'scontent.cdninstagram.com',
  'media.licdn.com',
];

/** A public-looking address the test lookup answers (TEST-NET would be blocked). */
export const PUBLIC_ADDR = '93.184.216.34';

let cert: { cert: string; key: string } | null = null;

function openssl(): string | null {
  for (const p of ['/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl']) if (existsSync(p)) return p;
  return null;
}

export const HAVE_OPENSSL = openssl() !== null;

/** One self-signed certificate (EC P-256) for TEST_HOSTS, made once per test file. */
export function testCert(): { cert: string; key: string } {
  if (cert) return cert;
  const bin = openssl();
  if (!bin) throw new Error('no openssl');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-cert-')));
  try {
    execFileSync(
      bin,
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '2',
        '-subj',
        '/CN=example.test',
        '-addext',
        `subjectAltName=${TEST_HOSTS.map((h) => `DNS:${h}`).join(',')}`,
      ],
      { stdio: 'ignore' },
    );
    cert = { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') };
    return cert;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface TestServer {
  port: number;
  server: Server;
  /** Requests seen: host header and path. */
  seen: { host: string; path: string }[];
  close(): Promise<void>;
}

/** An HTTPS server on 127.0.0.1:0 with the test certificate. */
export async function httpsServer(handler: Handler): Promise<TestServer> {
  const { cert: c, key } = testCert();
  const seen: { host: string; path: string }[] = [];
  const server = createServer({ cert: c, key }, (req, res) => {
    seen.push({ host: String(req.headers.host ?? ''), path: req.url ?? '' });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    server,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** A lookup that answers `addrs[host]` (default PUBLIC_ADDR), recording each name asked. */
export function fakeLookup(addrs: Record<string, string[]> = {}, asked: string[] = []): LookupFunction {
  return ((host: string, _opts: unknown, cb: (err: Error | null, a: { address: string; family: number }[]) => void) => {
    asked.push(host);
    const list = addrs[host] ?? [PUBLIC_ADDR];
    if (list.length === 0) {
      cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      return;
    }
    cb(
      null,
      list.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 })),
    );
  }) as unknown as LookupFunction;
}

/** The guard's seam for a local server: every vetted address is dialed at 127.0.0.1:<port>. */
export function seamFor(port: number, opts: { addrs?: Record<string, string[]>; dialed?: string[]; asked?: string[] } = {}): GuardNet {
  return {
    lookup: fakeLookup(opts.addrs ?? {}, opts.asked ?? []),
    ca: testCert().cert,
    dial: (address, p) => {
      opts.dialed?.push(`${address}:${p}`);
      return { address: '127.0.0.1', port };
    },
  };
}

/** A 1x1 JPEG (magic and markers only, never decoded by the daemon). */
export const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
