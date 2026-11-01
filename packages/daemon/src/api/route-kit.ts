/**
 * What every route handler file shares: the call shape, the handler table
 * entry, the raw (bytes) reply, and the v0.3 stub helper. routes.ts and the
 * per-feature files in routes/ import from here, never from each other.
 */
import type { Readable } from 'node:stream';
import type { RouteName, Session } from '@jantar/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LifeResult } from '../contracts.js';
import { ApiError, nodeUnsupported } from './errors.js';
import type { RequestAuth } from './request.js';
import type { ApiServices } from './services.js';

export interface Call<P = Record<string, string>, Q = Record<string, unknown>, B = unknown> {
  params: P;
  query: Q;
  body: B;
  auth: RequestAuth;
  req: FastifyRequest;
  reply: FastifyReply;
  idempotencyKey?: string;
  /**
   * v0.4.2: a `rawBody` route's bytes (RouteDef.rawBody), read only after
   * the pipeline's pre-parse checks; `body` is undefined there.
   */
  raw?: Buffer;
  /** Values a handler passes to its own audit() (never sent to the client). */
  scratch: Record<string, unknown>;
}

export interface RouteImpl {
  // Handlers are typed per route below; the table stores them loosely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(c: Call<any, any, any>, s: ApiServices): Promise<unknown> | unknown;
  /** Target and redacted params for the audit entry of a write. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  audit?(c: Call<any, any, any>, out: { status: number; body: unknown }): { target?: string; params?: unknown };
  /** The handler writes its own audit entries (pair claim; v0.3 file reads). */
  selfAudit?: boolean;
  /** A v0.3 placeholder that answers 501 (see notImplementedRoute). The real handler drops it. */
  stub?: true;
}

export type RouteTable = Partial<Record<RouteName, RouteImpl>>;

/**
 * The reply of a `rawResponse` route (RouteDef.rawResponse): bytes and the
 * headers that go with them. app.ts sends it as is; the global security
 * headers are added only where the handler set none (so a per-reply CSP
 * wins), and `cache-control` always keeps `no-store`.
 */
export interface RawReply {
  kind: 'raw';
  /** content-type, from the daemon's own table (never from the file). */
  type: string;
  body: Buffer | Readable;
  headers?: Record<string, string>;
  /** Default: the route's status (200). */
  status?: number;
}

export function isRawReply(v: unknown): v is RawReply {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'raw';
}

/** A v0.3 handler that is not built yet: 501 until its work package replaces it. */
export function notImplementedRoute(feature: string): RouteImpl {
  return {
    stub: true,
    handle: () => {
      throw new ApiError('not_implemented', `${feature} is not built yet`);
    },
  };
}

/**
 * The session a route names, or 404. v0.6: a paired server's session (it
 * carries `node`) is refused with 409 node_unsupported, unless `nodeOk`:
 * the routes the hub answers from its own state (getSession, and the
 * pipeline's pre-checks of a route it forwards). Every route that acts on a
 * server's session is forwarded before its handler runs, so a handler that
 * reaches here with one is a route that works for the Mac's sessions only.
 */
export function sessionOr404(s: ApiServices, sid: string, opts: { nodeOk?: boolean } = {}): Session {
  // An own key only: state.sessions is a plain object, so "constructor" or
  // "__proto__" from a URL would otherwise find Object.prototype's members.
  const sessions = s.ctx.store.getState().sessions;
  const session = Object.hasOwn(sessions, sid) ? sessions[sid] : undefined;
  if (!session) throw new ApiError('not_found', 'no such session');
  if (session.node !== undefined && !opts.nodeOk) throw nodeUnsupported();
  return session;
}

export function needActor(auth: RequestAuth) {
  if (!auth.actor) throw new ApiError('unauthorized', 'pair this device first');
  return auth.actor;
}

// ---------------------------------------------------------------------------
// v0.4 Life and Intel

/**
 * A Life or Intel answer's value, or the API error of the same code (the
 * reason is the module's fixed sentence; rate_limited carries retry-after).
 */
export function lifeValue<T>(r: LifeResult<T>): T {
  if (r.ok) return r.value;
  const headers: Record<string, string> = {};
  if (r.code === 'rate_limited' && r.retryAfterMs !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(r.retryAfterMs / 1000)));
  throw new ApiError(r.code, r.reason, headers);
}

/**
 * What a Life or Intel write audits: its target id and nothing else (no
 * params: Life text never reaches the audit log). The id comes from the path
 * (`:id`, `:day`) or, for a create, from the `{ id }` reply.
 */
export function lifeAudit(c: Call<Record<string, string>>, out: { status: number; body: unknown }): { target?: string } {
  const reply = out.body as { id?: unknown } | null;
  const target = c.params.id ?? c.params.day ?? (typeof reply?.id === 'string' ? reply.id : undefined);
  return target === undefined ? {} : { target };
}
