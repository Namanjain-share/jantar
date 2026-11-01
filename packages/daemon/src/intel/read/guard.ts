/**
 * The SSRF guard (spec 13.1): every byte the daemon fetches for Intel comes
 * through here, and the CONNECT proxy (proxy.ts) vets every tunnel with the
 * same rules.
 *
 *   1. WHATWG URL; https only (the user's own http link is tried once as
 *      https at accept); port none or 443; no userinfo; at most 2,000 chars.
 *   2. Host rules before DNS: no IP literal, localhost or *.localhost, no
 *      name without a dot, nothing under .local, .internal, .lan,
 *      .home.arpa, .ts.net or .onion, not the Mac's own name, not the hosts
 *      of remote.publicUrl or remote.allowedOrigins.
 *   3. DNS (all addresses, verbatim): every one must pass one BlockList.
 *   4. The request is pinned to the vetted address (`lookup` answers it),
 *      with the host as the TLS server name, so the certificate is still
 *      checked for the host. No global fetch, no proxy env, no keep-alive.
 *   5. Redirects by hand: each Location goes through 1-4 again, at most 5
 *      hops; never to http.
 *   6. Status 200 only (206 for a range); the content type must fit what was
 *      asked and the magic bytes must agree; sizes count decompressed bytes;
 *      time caps (connect 5 s, first byte 10 s, the total per kind).
 *
 * Bodies, links and hosts are never logged: a failure is a code.
 *
 * Tests only (intel/index.ts IntelNetSeam): `lookup` and `ca` for local
 * HTTPS servers with a test CA, and `dial`, which maps a vetted public
 * address to the local server that stands in for it. The BlockList is never
 * relaxed: a test lookup that answers 127.0.0.1 is refused like any other.
 */
import { createWriteStream } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { hostname as osHostname } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { INTEL_READ_LIMITS, JANTAR_FETCH_UA } from '@jantar/protocol';

/** Blocked IPv4 ranges (spec 13.1). IPv4 rules also match IPv4-mapped IPv6 (::ffff:a.b.c.d). */
export const BLOCKED_V4: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

/** Blocked IPv6 ranges. Never ::ffff:0:0/96: Node would then block every IPv4 address. */
export const BLOCKED_V6: readonly string[] = [
  '::/128',
  '::1/128',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/32',
  '2001:db8::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
];

function buildBlockList(): BlockList {
  const bl = new BlockList();
  for (const r of BLOCKED_V4) {
    const [net, bits] = r.split('/') as [string, string];
    bl.addSubnet(net, Number(bits), 'ipv4');
  }
  for (const r of BLOCKED_V6) {
    const [net, bits] = r.split('/') as [string, string];
    bl.addSubnet(net, Number(bits), 'ipv6');
  }
  return bl;
}

export const BLOCK_LIST = buildBlockList();

/** Whether an address the DNS gave is one the Mac must never open (also anything that is not an address). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCK_LIST.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Name suffixes that are never public (spec 13.1 rule 2). */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.ts.net', '.onion'];

/** The host as compared: lower case, no trailing dot, no IPv6 brackets. */
export function normHost(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** Rule 2: a host refused before any DNS. `own`: the Mac's own names and its door's hosts (normalised). */
export function hostRefused(host: string, own: ReadonlySet<string>): boolean {
  const h = normHost(host);
  if (h === '' || isIP(h) !== 0) return true;
  if (h === 'localhost' || !h.includes('.')) return true;
  if (PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return own.has(h);
}

/** The Mac's own names and the hosts of remote.publicUrl and remote.allowedOrigins, normalised. */
export function ownHosts(remote: { publicUrl: string | null; allowedOrigins: readonly string[]; host?: string }, machine = safeHostname()): Set<string> {
  const out = new Set<string>();
  const add = (h: string | null | undefined) => {
    if (h) out.add(normHost(h));
  };
  add(machine);
  if (machine.includes('.')) add(machine.split('.')[0]);
  for (const u of [remote.publicUrl, ...remote.allowedOrigins]) {
    if (!u) continue;
    try {
      add(new URL(u).hostname);
    } catch {
      // not a URL: nothing to add
    }
  }
  if (remote.host && isIP(remote.host) === 0) add(remote.host);
  return out;
}

function safeHostname(): string {
  try {
    return osHostname();
  } catch {
    return '';
  }
}

export type UrlRefusal = 'badLink' | 'blocked';
export type UrlCheck = { ok: true; url: URL } | { ok: false; why: UrlRefusal };

/**
 * Rules 1 and 2 on a link: https (or http, made https, only when `upgrade`),
 * no port but 443, no userinfo, at most 2,000 chars, a public-looking host.
 * `blocked` for a host that names the inside of a network, `badLink` for
 * anything else.
 */
export function checkUrl(href: string, own: ReadonlySet<string>, opts: { upgrade?: boolean } = {}): UrlCheck {
  if (typeof href !== 'string' || href.length > INTEL_READ_LIMITS.linkMax) return { ok: false, why: 'badLink' };
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { ok: false, why: 'badLink' };
  }
  if (u.protocol === 'http:' && opts.upgrade) {
    u = new URL(`https:${u.href.slice('http:'.length)}`);
    // An explicit :80 stays a port, so it is refused below.
  }
  if (u.protocol !== 'https:') return { ok: false, why: 'badLink' };
  if (u.username !== '' || u.password !== '') return { ok: false, why: 'badLink' };
  if (u.port !== '' && u.port !== '443') return { ok: false, why: 'badLink' };
  if (u.href.length > INTEL_READ_LIMITS.linkMax) return { ok: false, why: 'badLink' };
  if (hostRefused(u.hostname, own)) return { ok: false, why: 'blocked' };
  u.port = '';
  return { ok: true, url: u };
}

// ---------------------------------------------------------------------------
// DNS (rule 3)

/** Tests only: what the guard and the proxy resolve with, trust, and dial. */
export interface GuardNet {
  lookup?: LookupFunction;
  ca?: string | Buffer | (string | Buffer)[];
  /** The address and port actually dialed for a vetted public address (tests' local servers). */
  dial?: (address: string, port: number) => { address: string; port: number };
}

export interface Vetted {
  address: string;
  family: 4 | 6;
}

/** Every address the host resolves to; empty on any DNS failure. */
async function lookupAll(host: string, net: GuardNet | undefined): Promise<Vetted[]> {
  try {
    if (net?.lookup) {
      const fn = net.lookup;
      const got = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        fn(host, { all: true, verbatim: true }, (err, addrs) => {
          if (err) reject(err);
          else resolve(Array.isArray(addrs) ? addrs : [{ address: String(addrs), family: isIP(String(addrs)) }]);
        });
      });
      return got.map((a) => ({ address: a.address, family: isIP(a.address) === 6 ? 6 : 4 }));
    }
    const got = await dnsLookup(host, { all: true, verbatim: true });
    return got.map((a) => ({ address: a.address, family: isIP(a.address) === 6 ? 6 : 4 }));
  } catch {
    return [];
  }
}

export type VetResult = { ok: true; vetted: Vetted } | { ok: false; why: 'blocked' | 'dns' };

/** Rules 2 and 3 on a host: the first address, only when every address passes the BlockList. */
export async function vetHost(host: string, own: ReadonlySet<string>, net?: GuardNet): Promise<VetResult> {
  if (hostRefused(host, own)) return { ok: false, why: 'blocked' };
  const all = await lookupAll(normHost(host), net);
  if (all.length === 0) return { ok: false, why: 'dns' };
  if (all.some((a) => isBlockedAddress(a.address))) return { ok: false, why: 'blocked' };
  return { ok: true, vetted: all[0] as Vetted };
}

// ---------------------------------------------------------------------------
// Bytes: magic and content types (rule 6)

export type Magic = 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'pdf' | 'mp4' | 'ebml';

/** What the first bytes say a file is, or null. */
export function magicOf(b: Uint8Array): Magic | null {
  const at = (i: number) => b[i] ?? -1;
  const ascii = (from: number, s: string) => [...s].every((c, i) => at(from + i) === c.charCodeAt(0));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
  if (at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'png';
  if (ascii(0, 'GIF8')) return 'gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, '%PDF-')) return 'pdf';
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'ebml';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
    return ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif'].includes(brand) ? 'heic' : 'mp4';
  }
  return null;
}

export const IMAGE_MAGIC: ReadonlySet<Magic> = new Set(['jpeg', 'png', 'gif', 'webp', 'heic']);

/** What a fetch asks for. */
export type FetchKind = 'html' | 'json' | 'image' | 'pdf' | 'media' | 'page';

const TYPES: Record<FetchKind, RegExp> = {
  html: /^(text\/html|application\/xhtml\+xml)$/,
  json: /^(application\/json|text\/json|application\/[a-z.+-]*\+json|text\/javascript|application\/javascript|text\/plain)$/,
  image: /^(image\/[a-z0-9.+-]+|application\/octet-stream|binary\/octet-stream)$/,
  pdf: /^(application\/pdf|application\/x-pdf|application\/octet-stream|binary\/octet-stream)$/,
  media: /^(video\/(mp4|quicktime|x-m4v)|audio\/(mp4|x-m4a|m4a|aac)|application\/octet-stream|binary\/octet-stream)$/,
  page: /^(text\/html|application\/xhtml\+xml|application\/pdf)$/,
};

/** The media type of a Content-Type header, lower case. */
export function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Whether the first bytes agree with what was asked (and with the type, for a page). */
function magicFits(kind: FetchKind, type: string, head: Uint8Array): FetchFail | null {
  const m = magicOf(head);
  switch (kind) {
    case 'image':
      return m && IMAGE_MAGIC.has(m) ? null : 'type';
    case 'pdf':
      return m === 'pdf' ? null : 'type';
    case 'media':
      if (m === 'ebml') return 'format';
      return m === 'mp4' ? null : 'type';
    case 'json': {
      const first = firstNonSpace(head);
      return first === 0x7b || first === 0x5b ? null : 'type';
    }
    case 'page':
      if (type.endsWith('pdf')) return m === 'pdf' ? null : 'type';
      return m === null ? null : 'type';
    case 'html':
      return m === null ? null : 'type';
  }
}

function firstNonSpace(b: Uint8Array): number {
  for (const c of b) if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0xef && c !== 0xbb && c !== 0xbf) return c;
  return -1;
}

// ---------------------------------------------------------------------------
// The fetch (rules 4-6)

export type FetchFail = 'badLink' | 'blocked' | 'dns' | 'notFound' | 'status' | 'timeout' | 'tooBig' | 'type' | 'format' | 'network' | 'redirects' | 'aborted';

export type Fetched =
  | { ok: true; url: string; type: string; body: Buffer; bytes: number }
  | { ok: false; why: FetchFail; status?: number; url?: string };

export interface FetchOptions {
  kind: FetchKind;
  maxBytes: number;
  /** The whole fetch, redirects included. */
  totalMs: number;
  signal?: AbortSignal;
  /** Stop at the first 200 (the resolve step): no body is read. */
  headersOnly?: boolean;
  /** Stream the body to this new file (0600, created with 'wx') instead of memory; `body` is then empty. */
  toFile?: string;
  /** The Accept header (a default per kind otherwise). */
  accept?: string;
}

const ACCEPT: Record<FetchKind, string> = {
  html: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  json: 'application/json,text/javascript;q=0.9,*/*;q=0.5',
  image: 'image/jpeg,image/png,image/webp,image/*;q=0.8',
  pdf: 'application/pdf',
  media: 'video/mp4,audio/mp4,*/*;q=0.5',
  page: 'text/html,application/xhtml+xml,application/pdf;q=0.9',
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface GuardOptions {
  /** The Mac's own names and its door's hosts (read per fetch: the settings may change). */
  own: () => ReadonlySet<string>;
  net?: GuardNet;
}

/** One hop's outcome. */
type Hop =
  | { kind: 'redirect'; location: string }
  | { kind: 'done'; status: number; type: string; body: Buffer; bytes: number }
  | { kind: 'fail'; why: FetchFail; status?: number };

export class Guard {
  constructor(private readonly opts: GuardOptions) {}

  own(): ReadonlySet<string> {
    return this.opts.own();
  }

  get net(): GuardNet | undefined {
    return this.opts.net;
  }

  /** Rules 2 and 3 for the CONNECT proxy. */
  vet(host: string): Promise<VetResult> {
    return vetHost(host, this.opts.own(), this.opts.net);
  }

  /** GET `href` under every rule; never throws. */
  async fetch(href: string, o: FetchOptions): Promise<Fetched> {
    const started = Date.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), o.totalMs);
    const onAbort = () => deadline.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let current = href;
      for (let hop = 0; hop <= INTEL_READ_LIMITS.redirectsMax; hop++) {
        const checked = checkUrl(current, this.opts.own());
        if (!checked.ok) return { ok: false, why: checked.why };
        const vet = await vetHost(checked.url.hostname, this.opts.own(), this.opts.net);
        if (!vet.ok) return { ok: false, why: vet.why === 'dns' ? 'dns' : 'blocked' };
        if (deadline.signal.aborted) return { ok: false, why: o.signal?.aborted ? 'aborted' : 'timeout' };
        const r = await this.once(checked.url, vet.vetted, o, deadline.signal, o.totalMs - (Date.now() - started));
        if (r.kind === 'fail') return { ok: false, why: r.why === 'timeout' && o.signal?.aborted ? 'aborted' : r.why, ...(r.status !== undefined ? { status: r.status } : {}), url: checked.url.href };
        if (r.kind === 'done') return { ok: true, url: checked.url.href, type: r.type, body: r.body, bytes: r.bytes };
        let next: URL;
        try {
          next = new URL(r.location, checked.url);
        } catch {
          return { ok: false, why: 'badLink' };
        }
        // Never down to http (nor anything but https).
        if (next.protocol !== 'https:') return { ok: false, why: 'blocked', url: checked.url.href };
        current = next.href;
      }
      return { ok: false, why: 'redirects' };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** One request to the vetted address. */
  private once(url: URL, vetted: Vetted, o: FetchOptions, signal: AbortSignal, leftMs: number): Promise<Hop> {
    if (leftMs <= 0 || signal.aborted) return Promise.resolve({ kind: 'fail', why: 'timeout' });
    const dial = this.opts.net?.dial?.(vetted.address, 443) ?? { address: vetted.address, port: 443 };
    const family = isIP(dial.address) === 6 ? 6 : 4;
    return new Promise<Hop>((resolve) => {
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (h: Hop) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        resolve(h);
      };
      const req = httpsRequest({
        method: 'GET',
        hostname: url.hostname,
        port: dial.port,
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        agent: false,
        ...(this.opts.net?.ca ? { ca: this.opts.net.ca } : {}),
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (opts?.all) cb(null, [{ address: dial.address, family }]);
          else cb(null, dial.address, family);
        }) as unknown as LookupFunction,
        headers: {
          host: url.host,
          'user-agent': JANTAR_FETCH_UA,
          accept: o.accept ?? ACCEPT[o.kind],
          'accept-encoding': 'identity',
          'accept-language': 'en',
          connection: 'close',
        },
      });
      const onAbort = () => {
        req.destroy();
        finish({ kind: 'fail', why: 'timeout' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const connectTimer = setTimeout(() => {
        req.destroy();
        finish({ kind: 'fail', why: 'timeout' });
      }, Math.min(INTEL_READ_LIMITS.connectMs, leftMs));
      timers.push(connectTimer);
      req.on('socket', (s) => {
        s.once('secureConnect', () => {
          clearTimeout(connectTimer);
          timers.push(
            setTimeout(() => {
              if (!gotResponse) {
                req.destroy();
                finish({ kind: 'fail', why: 'timeout' });
              }
            }, Math.min(INTEL_READ_LIMITS.firstByteMs, leftMs)),
          );
        });
      });
      let gotResponse = false;
      req.on('error', () => finish({ kind: 'fail', why: signal.aborted ? 'timeout' : 'network' }));
      req.on('response', (res) => {
        gotResponse = true;
        const status = res.statusCode ?? 0;
        if (REDIRECTS.has(status)) {
          const location = res.headers.location;
          res.destroy();
          finish(typeof location === 'string' && location !== '' ? { kind: 'redirect', location } : { kind: 'fail', why: 'status', status });
          return;
        }
        if (status === 404 || status === 410) {
          res.destroy();
          finish({ kind: 'fail', why: 'notFound', status });
          return;
        }
        if (status !== 200 && status !== 206) {
          res.destroy();
          finish({ kind: 'fail', why: 'status', status });
          return;
        }
        const type = mediaType(res.headers['content-type']);
        if (!TYPES[o.kind].test(type)) {
          res.destroy();
          finish({ kind: 'fail', why: 'type', status });
          return;
        }
        const declared = Number(res.headers['content-length']);
        const encoding = mediaType(res.headers['content-encoding']);
        if (Number.isFinite(declared) && declared > o.maxBytes && (encoding === '' || encoding === 'identity')) {
          res.destroy();
          finish({ kind: 'fail', why: 'tooBig', status });
          return;
        }
        if (o.headersOnly) {
          res.destroy();
          finish({ kind: 'done', status, type, body: Buffer.alloc(0), bytes: 0 });
          return;
        }
        readBody(res, encoding, o, type).then((r) => finish(r.ok ? { kind: 'done', status, type, body: r.body, bytes: r.bytes } : { kind: 'fail', why: r.why, status }));
      });
      req.end();
    });
  }
}

/** The body, decompressed when the server ignored `identity`, counted against the cap, its magic checked. */
function readBody(res: IncomingMessage, encoding: string, o: FetchOptions, type: string): Promise<{ ok: true; body: Buffer; bytes: number } | { ok: false; why: FetchFail }> {
  return new Promise((resolve) => {
    let stream: NodeJS.ReadableStream = res;
    if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(createGunzip());
    else if (encoding === 'deflate') stream = res.pipe(createInflate());
    else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
    else if (encoding !== '' && encoding !== 'identity') {
      res.destroy();
      resolve({ ok: false, why: 'type' });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let head: Buffer | null = null;
    let done = false;
    const file = o.toFile ? createWriteStream(o.toFile, { flags: 'wx', mode: 0o600 }) : null;
    const end = (r: { ok: true; body: Buffer; bytes: number } | { ok: false; why: FetchFail }) => {
      if (done) return;
      done = true;
      if (!r.ok) {
        res.destroy();
        (stream as unknown as { destroy?: () => void }).destroy?.();
      }
      if (file) {
        file.end(() => resolve(r));
        file.on('error', () => resolve({ ok: false, why: 'network' }));
      } else resolve(r);
    };
    file?.on('error', () => end({ ok: false, why: 'network' }));
    stream.on('data', (c: Buffer) => {
      if (done) return;
      bytes += c.length;
      if (bytes > o.maxBytes) {
        end({ ok: false, why: 'tooBig' });
        return;
      }
      if (head === null || head.length < 16) {
        head = head ? Buffer.concat([head, c]).subarray(0, 64) : c.subarray(0, 64);
        if (head.length >= 16 || bytes >= 16) {
          const bad = magicFits(o.kind, type, head);
          if (bad) {
            end({ ok: false, why: bad });
            return;
          }
        }
      }
      if (file) file.write(c);
      else chunks.push(c);
    });
    stream.on('error', () => end({ ok: false, why: 'network' }));
    res.on('aborted', () => end({ ok: false, why: 'network' }));
    stream.on('end', () => {
      const h = head ?? Buffer.alloc(0);
      const bad = h.length < 16 ? magicFits(o.kind, type, h) : null;
      if (bad) end({ ok: false, why: bad });
      else end({ ok: true, body: file ? Buffer.alloc(0) : Buffer.concat(chunks), bytes });
    });
  });
}
