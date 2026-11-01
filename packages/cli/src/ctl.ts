/**
 * Client for the daemon's control socket (paths.ctlSock). The socket speaks
 * the same HTTP/1.1 JSON API as the web app (see @jantar/protocol ROUTES,
 * `ctl: true` routes only); the daemon treats the peer as actor "cli".
 * v0.6: on Windows paths.ctlSock is the daemon's named pipe (config.ts
 * pipePath), which node:http reaches the same way.
 */
import { request as httpRequest } from 'node:http';
import { isPipePath } from '@jantar/daemon/config';
import { IDEMPOTENCY_HEADER, type ErrorBody } from '@jantar/protocol';

export interface CtlResponse<T = unknown> {
  status: number;
  body: T | ErrorBody | null;
}

export class CtlUnavailableError extends Error {
  constructor(
    readonly socketPath: string,
    readonly causeCode: string | undefined,
  ) {
    const what = isPipePath(socketPath) ? 'control pipe' : 'control socket';
    super(
      causeCode === 'ENOENT' || causeCode === 'ECONNREFUSED'
        ? `jantard is not running (no ${what} at ${socketPath}). Start it with: jantar install`
        : `cannot reach jantard at ${socketPath}: ${causeCode ?? 'unknown error'}`,
    );
    this.name = 'CtlUnavailableError';
  }
}

export interface CtlRequestOptions {
  idempotencyKey?: string;
  timeoutMs?: number;
}

/** v0.5: a GET whose answer is bytes (a meeting's screenshot). An error still comes as JSON: `type` says which. */
export interface CtlBytesResponse {
  status: number;
  /** The reply's content-type ('' when it sent none). */
  type: string;
  body: Buffer;
}

export interface CtlClient {
  readonly socketPath: string;
  request<T = unknown>(method: string, path: string, body?: unknown, opts?: CtlRequestOptions): Promise<CtlResponse<T>>;
  /** v0.5: GET `path` and take the reply as bytes (rawResponse routes). */
  bytes(path: string, opts?: Pick<CtlRequestOptions, 'timeoutMs'>): Promise<CtlBytesResponse>;
}

export function isErrorBody(b: unknown): b is ErrorBody {
  return typeof b === 'object' && b !== null && 'error' in b && typeof (b as ErrorBody).error?.code === 'string';
}

/** A non-2xx answer from the daemon, carrying its `{error:{code,message}}`. */
export class DaemonError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

/** Request and unwrap: resolves with the body on 2xx, throws DaemonError otherwise. */
export async function callDaemon<T>(
  ctl: CtlClient,
  method: string,
  path: string,
  body?: unknown,
  opts?: CtlRequestOptions,
): Promise<T> {
  const res = await ctl.request<T>(method, path, body, opts);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  if (isErrorBody(res.body)) throw new DaemonError(res.status, res.body.error.code, res.body.error.message);
  throw new DaemonError(res.status, 'internal', `daemon answered HTTP ${res.status}`);
}

export function createCtlClient(socketPath: string): CtlClient {
  return {
    socketPath,
    request<T>(method: string, path: string, body?: unknown, opts: CtlRequestOptions = {}) {
      return new Promise<CtlResponse<T>>((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const headers: Record<string, string> = { accept: 'application/json', host: 'jantar.local' };
        if (payload) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(payload.length);
        }
        if (opts.idempotencyKey) headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;
        const req = httpRequest({ socketPath, method, path, headers, timeout: opts.timeoutMs ?? 10_000 }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = { error: { code: 'internal', message: 'daemon sent invalid JSON' } };
              }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed as T | ErrorBody | null });
          });
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', (e: NodeJS.ErrnoException) => reject(new CtlUnavailableError(socketPath, e.code)));
        if (payload) req.write(payload);
        req.end();
      });
    },
    bytes(path: string, opts: Pick<CtlRequestOptions, 'timeoutMs'> = {}) {
      return new Promise<CtlBytesResponse>((resolve, reject) => {
        const headers = { accept: '*/*', host: 'jantar.local' };
        const req = httpRequest({ socketPath, method: 'GET', path, headers, timeout: opts.timeoutMs ?? 30_000 }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }));
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', (e: NodeJS.ErrnoException) => reject(new CtlUnavailableError(socketPath, e.code)));
        req.end();
      });
    },
  };
}
