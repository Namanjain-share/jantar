/**
 * v0.8 Intel reads links, end to end: the public web as one local HTTPS
 * server. Nothing here reaches the network.
 *
 * - A throwaway self-signed certificate for SITE_HOSTS, made with the
 *   system's openssl in a temp dir that is removed at once (never
 *   committed); no openssl, no suite (`netReady`).
 * - One HTTPS server on 127.0.0.1 that answers by Host and path from the
 *   test's own table of synthetic pages, recording every request.
 * - Intel's net seam (`DaemonOptions.intel.net`): a lookup that answers one
 *   public address for every name, and a dial that sends that address to
 *   this server. The guard's BlockList is never relaxed: it still checks
 *   the public address.
 * - Intel's browser seam: playwright-core's own Chromium (never the system
 *   Chrome), launched with the daemon's own launch and context options plus
 *   one change, trust in this certificate (ignoreHTTPSErrors), so its pages
 *   come through the daemon's CONNECT proxy to this server. Without that
 *   Chromium the seam's browser can't start, and the tier is unavailable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonOptions } from '@jantar/daemon/daemon';

type IntelSeams = NonNullable<DaemonOptions['intel']>;

/** The names the certificate covers: every host a synthetic page or picture is served at. */
export const SITE_HOSTS = ['www.example.com', 'www.instagram.com', 'scontent.cdninstagram.com', 'x.com', 'cdn.syndication.twimg.com', 'pbs.twimg.com'] as const;

/** A public-looking address the seam's lookup answers (a TEST-NET or loopback one would be blocked). */
export const PUBLIC_ADDR = '93.184.216.34';

function openssl(): string | null {
  for (const p of ['/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl']) if (existsSync(p)) return p;
  return null;
}

/** Whether this machine can make the certificate; warns once per suite when it can't. */
export function netReady(suite: string): boolean {
  if (openssl()) return true;
  console.warn(`[${suite}] skipped: no openssl to make a throwaway test certificate`);
  return false;
}

let made: { cert: string; key: string } | null = null;

/**
 * One RSA self-signed certificate for SITE_HOSTS, valid two days, made once
 * per test file. RSA, not EC: macOS's LibreSSL writes an EC key with
 * explicit curve parameters, which Chromium's TLS refuses.
 */
export function siteCert(): { cert: string; key: string } {
  if (made) return made;
  const bin = openssl();
  if (!bin) throw new Error('no openssl');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-site-cert-')));
  try {
    execFileSync(
      bin,
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2',
        '-subj', '/CN=www.example.com', '-addext', `subjectAltName=${SITE_HOSTS.map((h) => `DNS:${h}`).join(',')}`,
      ],
      { stdio: 'ignore' },
    );
    made = { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') };
    return made;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the server answers for one request: a status, a content type and a body; `hold` never answers (a page that hangs). */
export type Answer = { status?: number; type?: string; body?: string | Buffer; headers?: Record<string, string>; hold?: boolean };

export interface Sites {
  port: number;
  /** Every request: its Host and path (with the query). */
  seen: { host: string; path: string }[];
  /** Requests whose Host and path start with `prefix` ("www.example.com/articles/"). */
  asked(prefix: string): number;
  close(): Promise<void>;
}

/** The HTTPS server: `answer(host, path)` decides (undefined: 404). */
export async function serveSites(answer: (host: string, path: string, req: IncomingMessage) => Answer | undefined): Promise<Sites> {
  const { cert, key } = siteCert();
  const seen: Sites['seen'] = [];
  const held: ServerResponse[] = [];
  const server: Server = createServer({ cert, key }, (req, res) => {
    const host = String(req.headers.host ?? '').replace(/:443$/, '');
    const path = req.url ?? '/';
    seen.push({ host, path });
    const a = answer(host, path, req);
    if (a?.hold) {
      held.push(res);
      return;
    }
    const body = a?.body ?? '';
    res.writeHead(a?.status ?? (a ? 200 : 404), { 'content-type': a?.type ?? 'text/plain', 'content-length': String(Buffer.byteLength(body)), ...a?.headers });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    asked: (prefix) => seen.filter((s) => `${s.host}${s.path}`.startsWith(prefix)).length,
    close: () =>
      new Promise<void>((r) => {
        for (const res of held) res.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Intel's net seam for `sites`: every name is PUBLIC_ADDR, and PUBLIC_ADDR:443 is this server. */
export function netSeam(sites: Pick<Sites, 'port'>, asked: string[] = []): IntelSeams['net'] {
  const lookup = ((host: string, _opts: unknown, cb: (err: Error | null, a: { address: string; family: number }[]) => void) => {
    asked.push(host);
    cb(null, [{ address: PUBLIC_ADDR, family: 4 }]);
  }) as unknown as LookupFunction;
  return {
    lookup,
    ca: siteCert().cert,
    dial: (address, port) => (address === PUBLIC_ADDR && port === 443 ? { address: '127.0.0.1', port: sites.port } : { address, port }),
  };
}

/** What the browser seam saw the daemon ask for: each launch's and each context's options. */
export interface BrowserSeen {
  launches: Record<string, unknown>[];
  contexts: Record<string, unknown>[];
  /** Each request the browser made: its URL and how it ended ("200", or the network error). */
  requests: string[];
}

/**
 * Intel's browser seam: playwright-core's own Chromium with the daemon's
 * options, plus trust in the site certificate. `executablePath` is that
 * Chromium (or a path that does not exist, so the tier fails to start and
 * is passed over: never the system Chrome).
 */
export function browserSeam(executablePath: string | null, seen: BrowserSeen): IntelSeams['browser'] {
  return {
    executablePath: executablePath ?? join(tmpdir(), 'jantar-no-chromium-here'),
    load: async () => {
      if (!executablePath) throw new Error('no Chromium for playwright-core in this run');
      const pw = await import('playwright-core');
      return {
        chromium: {
          async launch(opts: Record<string, unknown>) {
            seen.launches.push(opts);
            const browser = await pw.chromium.launch(opts as Parameters<typeof pw.chromium.launch>[0]);
            return {
              async newContext(o: Record<string, unknown>) {
                seen.contexts.push(o);
                const context = await browser.newContext({ ...o, ignoreHTTPSErrors: true });
                context.on('requestfinished', (r) => void r.response().then((res) => seen.requests.push(`${r.url()} ${res?.status() ?? '?'}`)));
                context.on('requestfailed', (r) => seen.requests.push(`${r.url()} ${r.failure()?.errorText ?? 'failed'}`));
                return context as never;
              },
              close: () => browser.close(),
            };
          },
        },
      };
    },
  };
}
