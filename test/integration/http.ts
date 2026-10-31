/**
 * Minimal HTTP and hooks-socket clients for the integration test: plain
 * node:http so the test controls every header (Origin, Cookie, Host).
 */
import { request } from 'node:http';
import { connect } from 'node:net';
import { DEVICE_SECRET_HEADER } from '@jantar/protocol';

/** Device secrets of the cookies paired in this run: `http()` sends one with its cookie, like the web app. */
const SECRETS = new Map<string, string>();

/** Remember the device secret a pairing claim returned, for that device's cookie. */
export function rememberSecret(cookie: string, claimBody: unknown): void {
  const secret = (claimBody as { deviceSecret?: unknown } | null)?.deviceSecret;
  if (typeof secret !== 'string') throw new Error('the pairing claim returned no device secret');
  SECRETS.set(cookie, secret);
}

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  text: string;
}

export function http(
  port: number,
  method: string,
  path: string,
  opts: { body?: unknown; origin?: string | null; cookie?: string; headers?: Record<string, string>; noSecret?: boolean } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { accept: 'application/json', host: `127.0.0.1:${port}`, ...opts.headers };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (opts.origin !== null) headers.origin = opts.origin ?? `http://127.0.0.1:${port}`;
    if (opts.cookie) {
      headers.cookie = opts.cookie;
      const secret = SECRETS.get(opts.cookie);
      if (secret && !opts.noSecret) headers[DEVICE_SECRET_HEADER] = secret;
    }
    const req = request({ host: '127.0.0.1', port, method, path, headers, timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** "name=value" of the first Set-Cookie header named `name`. */
export function cookieFrom(res: HttpResult, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const first = c.split(';')[0] ?? '';
    if (first.startsWith(`${name}=`)) return first;
  }
  return null;
}

export interface HookConnection {
  /** Resolves with the daemon's reply line (parsed), or null on EOF without a line. */
  reply: Promise<unknown | null>;
  close(): void;
}

/** Send one hook event the way jantar-hook does (docs/hook-protocol.md section 6). */
export function sendHook(socketPath: string, payload: Record<string, unknown>, wait: boolean): HookConnection {
  const sock = connect({ path: socketPath });
  let buf = '';
  const reply = new Promise<unknown | null>((resolve, reject) => {
    sock.on('connect', () => {
      sock.write(`${JSON.stringify(payload)}\n`);
      if (!wait) sock.end();
    });
    sock.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
    });
    sock.on('end', () => {
      const line = buf.split('\n')[0]?.trim();
      if (!line) return resolve(null);
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', reject);
  });
  return { reply, close: () => sock.destroy() };
}

export function hookTag(ppid: number, wait: boolean, claudeConfigDir?: string): Record<string, unknown> {
  return {
    v: 1,
    ts: Date.now(),
    mono: process.hrtime.bigint().toString(),
    ppid,
    wait,
    termProgram: 'Apple_Terminal',
    ...(claudeConfigDir ? { claudeConfigDir } : {}),
    hookVersion: 'integration-test',
  };
}

/** Poll `fn` until it returns a truthy value or `ms` passes. */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
