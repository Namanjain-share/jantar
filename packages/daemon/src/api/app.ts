/**
 * Builds the Fastify app for one transport.
 *
 * TCP (127.0.0.1:<port>, also reached through Tailscale Serve / tunnels):
 *   Host check -> device cookie (and, on `/v1/ext/` only, the extension
 *   key) -> scope -> Origin (writes and WS) -> device secret (control /
 *   launch / admin writes and WS) -> `localOnly` refusal -> feature switch
 *   (v0.3, v0.4, v0.5) -> a broken life.db or meetings.db (503) -> zod
 *   validation -> Idempotency-Key -> handler -> audit (writes).
 *   v0.5's `extension` routes swap the device steps for the extension's:
 *   a loopback peer and Host with no forwarding header, no device cookie,
 *   the key, the Origin bound to it, a per-extension request limit (the
 *   first three already in onRequest, before any body is read).
 *   Plus the web app at `/` with a strict CSP. A `rawResponse` route's
 *   handler returns bytes (RawReply), sent as they are.
 *
 *   v0.4.2: a `rawBody` route (uploads) lives in its own encapsulated scope
 *   with one body parser, application/octet-stream up to its `maxBytes`
 *   (every JSON route still refuses octet-stream, and this one refuses
 *   everything else). Its `preParsing` hook runs the checks above up to
 *   --no-terminal, then the session, the query (`?ext=`), the content type,
 *   the Content-Length (411, 413), the device's uploads in flight and its
 *   byte budget (429), all before a byte of the body is read. Its handler
 *   gets the bytes in `call.raw` (no zod body step) and never replays an
 *   Idempotency-Key.
 *
 * Control socket (0600 Unix socket, the CLI): the same REST API for routes
 * marked `ctl: true` (never approvals), as actor "cli" with every scope, plus
 * the /ctl/* routes. No cookies, no Origin.
 *
 * v0.6 Fleet:
 * - On the hub, a route in NODE_ROUTES whose session, card, launch or
 *   `?node=` names a paired server is forwarded there after the device,
 *   scope, Origin, secret and localOnly checks: then a read-only hub refuses
 *   writes, the body is validated and the Idempotency-Key checked but not
 *   cached (the node's own cache decides replays), the call goes through
 *   `s.fleet.forward`, and a write is audited with its node. The hub's own
 *   switches and --no-terminal apply to its own sessions only. A `?node=`
 *   naming no paired machine is 404, never run on the Mac instead.
 * - `node` routes (NODE_PREFIX: a server's pairing claim) read no cookie,
 *   secret or extension key: 404 while Fleet is off, 403 with any Origin.
 *   The node link's upgrade never reaches Fastify (api/node-upgrade.ts).
 * - On a node, the `link` transport runs the hub's calls in-process (no
 *   listener): NODE_ROUTES only, as the device `hub.<phone's id>` with the
 *   phone's scopes; no Host, cookie, Origin or secret (no browser); scope,
 *   switches, read-only, zod, the node's own idempotency cache, handlers
 *   and audit as on a Mac.
 */
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  DEVICE_COOKIE,
  DEVICE_SECRET_HEADER,
  EVENTS_WS_PROTOCOL,
  EXTENSION_ID,
  EXTENSION_KEY_HEADER,
  EventsQuerySchema,
  FLEET_COPY,
  IDEMPOTENCY_HEADER,
  LEGACY_DEVICE_COOKIE,
  MAX_BODY_BYTES,
  NODE_PREFIX,
  ROUTES,
  errorBody,
  lifeOn,
  secretFromSocketProtocols,
  settingsFeatures,
  type ErrorCode,
  type FeatureSwitch,
  type RouteDef,
  type RouteName,
  type Settings,
} from '@jantar/protocol';
import { NODE_ROUTES, isNodeRoute, type NodeCallActor } from '@jantar/protocol/node-link';
import type { FleetTarget, ForwardCall } from '../contracts.js';
import { proxyHeaderFor, rateLimitKey } from '../auth/client-ip.js';
import { deviceSecretMatches } from '../auth/devices.js';
import { hasScope } from '../auth/scopes.js';
import { auditResult, type AuditInput } from './audit.js';
import { registerCtlRoutes } from './ctl-routes.js';
import {
  ApiError,
  DEVICE_SECRET_REFUSAL,
  UPLOAD_BUDGET,
  UPLOAD_IN_FLIGHT,
  UPLOAD_MEDIA_TYPE,
  UPLOAD_NO_LENGTH,
  UPLOAD_TOO_LARGE,
  toErrorReply,
  zodMessage,
  type ErrorReply,
} from './errors.js';
import { openEventStream } from './events-ws.js';
import { LINK_CALL_HEADER, actorName, cliAuth, type RequestAuth, type Transport } from './request.js';
import { sessionOr404 } from './route-kit.js';
import { ROUTE_IMPLS, isRawReply, type Call, type RouteImpl } from './routes.js';
import { securityHeaders } from './security.js';
import type { ApiServices, WsLike } from './services.js';
import { isApiPath, registerWebApp, serveIndexFallback } from './static.js';
import { NO_TERMINAL_REASON, READ_ONLY_REASON } from '../modes.js';

/**
 * Routes a read-only daemon (jantard --read-only) refuses with 403. The parts
 * refuse these actions themselves as well (modes.ts); this only answers early
 * and clearly. Pairing, device revoke and push subscriptions stay allowed:
 * they only change Jantar's own state. So do v0.4's Life and Intel writes:
 * --read-only is about sessions, and a dose must log. Ask Claude is the one
 * v0.4 route here, for Rewrite's reason.
 */
export const READ_ONLY_REFUSED: ReadonlySet<RouteName> = new Set<RouteName>([
  'sendPrompt',
  'focusSession',
  'decidePending',
  'refreshUsage',
  'patchSettings',
  'muteNotify',
  // v0.3: a Rewrite run spends an account's quota; the rest act on terminals, folders or sessions.
  'rewriteStart',
  'foldersPin',
  'foldersCreate',
  'launchStart',
  'launchAnswer',
  'sessionKey',
  'sessionMode',
  'sessionCommand',
  // v0.4: Ask Claude runs a headless Claude too, which spends an account's quota.
  'foodEstimate',
  // v0.5: so does a meeting's summary. Capture and the phone's edits still work.
  'meetingSummarize',
  // v0.4.2: answers and keys act on a terminal; uploads exist only to be sent.
  'sessionDialog',
  'sessionKeypad',
  'uploadCreate',
  'uploadDelete',
]);

/** Routes that need a terminal backend: with --no-terminal they answer 501 at once. */
export const NO_TERMINAL_REFUSED: ReadonlySet<RouteName> = new Set<RouteName>([
  'getScreen',
  'focusSession',
  'sendPrompt',
  'launchStart',
  'launchAnswer',
  'sessionKey',
  'sessionMode',
  'sessionCommand',
  'sessionScreenshot',
  // v0.4.2
  'sessionDialog',
  'sessionKeypad',
  'uploadCreate',
  'uploadDelete',
]);

/**
 * What a route behind a switch that is off answers (v0.3): the sentence
 * names the command that turns it on. The check runs before validation and
 * before the handler, on both transports.
 */
export const FEATURE_OFF: Readonly<Record<FeatureSwitch, { code: ErrorCode; message: string }>> = {
  files: { code: 'forbidden', message: 'Files are off. Turn them on at your Mac: jantar files on' },
  launch: { code: 'forbidden', message: 'Starting sessions from the phone is off. Turn it on at your Mac: jantar launch on' },
  rewrite: { code: 'forbidden', message: 'Rewrite is off. Turn it on at your Mac: jantar rewrite on' },
  controls: { code: 'forbidden', message: 'Controls are off. Turn them on at your Mac: jantar controls on' },
  screenshots: { code: 'screenshots_off', message: 'Screenshots are off. Turn them on at your Mac: jantar screenshots on' },
  // v0.4
  life: { code: 'forbidden', message: 'Life is off. Turn a part of it on at your Mac: jantar life on todos' },
  todos: { code: 'forbidden', message: 'Todos are off. Turn them on at your Mac: jantar life on todos' },
  medicines: { code: 'forbidden', message: 'Medicines are off. Turn them on at your Mac: jantar life on medicines' },
  food: { code: 'forbidden', message: 'Food is off. Turn it on at your Mac: jantar life on food' },
  places: { code: 'forbidden', message: 'Cafés are off. Turn them on at your Mac: jantar life on places' },
  finance: { code: 'forbidden', message: 'Finance is off. Turn it on at your Mac: jantar life on finance' },
  intel: { code: 'forbidden', message: 'The Intel shelf is off. Turn it on at your Mac: jantar intel on' },
  // v0.5
  meetings: { code: 'forbidden', message: 'Meetings are off. Turn them on at your Mac: jantar meetings on' },
  // v0.6
  fleet: { code: 'forbidden', message: 'Fleet is off. Turn it on at your Mac: jantar fleet on' },
};

/** The switches of Life's routes: while life.db is broken they answer 503 (lifeStatus, lifeBackup and lifeRestore have none). */
export const LIFE_FEATURES: ReadonlySet<FeatureSwitch> = new Set<FeatureSwitch>(['life', 'todos', 'medicines', 'food', 'places', 'finance']);

/**
 * What a `localOnly` route answers over TCP, an admin device included (v0.3,
 * spec G2): a phone, even one reached through the tunnel, must not widen any
 * device's reach. It runs after the device, scope and secret checks, so
 * those refusals keep their own codes.
 */
export const LOCAL_ONLY_REFUSED: Readonly<Partial<Record<RouteName, string>>> = {
  deviceScopes: 'Grant scopes on the Mac: jantar devices grant <device> launch',
  lifeBackup: 'Back Life up on the Mac: jantar life backup',
  lifeRestore: 'Restore Life on the Mac: jantar life restore <file>',
  extPairStart: 'Pair the extension on the Mac: jantar pair --extension',
  extUnpair: 'Unpair on the Mac: jantar meetings unpair',
  // v0.6
  machinesPair: 'Pair servers at the Mac: jantar node pair',
};

/** What an `extension` route answers without a valid extension key (401). */
export const EXTENSION_NOT_PAIRED = 'The Jantar extension is not paired. On your Mac: jantar pair --extension';

/** What a phone write on Meetings answers past V04_LIMITS.lifeWrite (Meetings share Life's per-device write limit). */
export const MEETING_WRITES_LIMITED = 'Too many meeting changes from this device; try again in a minute';

/** The origin a pairing claim must come from: the published extension's. */
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/**
 * Body fields only the Mac's CLI may send (v0.4): over TCP a body carrying
 * one is a 400 before any handler, an admin device included. intelCapture's
 * `cwd` is the folder of the session or shell that ran `jantar intel`; a
 * phone has no folder to claim.
 */
export const CTL_ONLY_FIELDS: Readonly<Partial<Record<RouteName, readonly string[]>>> = {
  intelCapture: ['cwd'],
};

/**
 * Whether a route's switch is on (routes without one are always on). Read
 * from settings, never from state: v0.4's `life` is any module on, a module
 * name reads `life.<module>`, `intel` reads `intel.enabled`.
 */
export function featureOn(def: Pick<RouteDef, 'feature'>, settings: Settings): boolean {
  const f = def.feature;
  switch (f) {
    case undefined:
      return true;
    case 'life':
      return lifeOn(settings);
    case 'todos':
    case 'medicines':
    case 'food':
    case 'places':
    case 'finance':
      return settings.life[f];
    case 'intel':
      return settings.intel.enabled;
    case 'meetings':
      return settings.meetings.enabled;
    default:
      return settingsFeatures(settings)[f];
  }
}

export interface BuildAppOptions {
  /** The TCP address once listening (for /ctl/status). */
  address?: () => { host: string; port: number } | null;
}

function pathOf(req: FastifyRequest): string {
  return req.url.split('?')[0] ?? '/';
}

/** The extension's paths: the only place its key header is read. */
const EXT_PREFIX = '/v1/ext/';

function parseWith<T>(schema: z.ZodType<T> | undefined, value: unknown, where: string): T {
  if (!schema) return value as T;
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError('invalid_request', zodMessage(where, r.error.issues));
  return r.data;
}

/**
 * Whether a route needs the device secret on top of the cookie (SEC-2): every
 * write above read scope, and the event stream. Reads, the pairing claim and
 * push subscriptions (read-scope writes the service worker repeats on its
 * own, without the page) work with the cookie alone.
 */
export function needsDeviceSecret(def: Pick<RouteDef, 'scope' | 'method'>): boolean {
  if (def.method === 'WS') return true;
  return def.method !== 'GET' && (def.scope === 'control' || def.scope === 'launch' || def.scope === 'admin');
}

export { DEVICE_SECRET_REFUSAL };

/** Peer addresses of this Mac itself. */
const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Headers a proxy or tunnel adds: a request carrying one came through it, not from this Mac. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip'] as const;

/**
 * v0.5: the request came from this Mac itself: a loopback peer address,
 * a loopback Host on the bound port, and no forwarding header. Tailscale
 * Serve and tunnels connect from loopback but carry a public Host or a
 * forwarding header; in `lan` mode the Host check is off and a LAN client
 * could send `Host: 127.0.0.1`, which the peer check stops. A condition on
 * top of the extension's key, never a grant.
 */
export function extensionLoopback(req: FastifyRequest, s: Pick<ApiServices, 'boundPort'>): boolean {
  const peer = req.raw.socket?.remoteAddress;
  if (!peer || !LOOPBACK_PEERS.has(peer)) return false;
  const host = headerValue(req.headers.host)?.trim().toLowerCase();
  const port = s.boundPort;
  if (!host || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`)) return false;
  return !FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined);
}

/**
 * v0.5: the part of the extension's gate that needs no body, for the
 * capture routes and the claim: from this Mac, and on a capture route no
 * device cookie and a key that authenticated (answered; null for the
 * claim). Throws ApiError (401 / 403).
 */
function extensionCaller(
  def: Pick<RouteDef, 'scope'>,
  auth: RequestAuth,
  req: FastifyRequest,
  s: Pick<ApiServices, 'boundPort'>,
): NonNullable<RequestAuth['extension']> | null {
  if (!extensionLoopback(req, s)) throw new ApiError('forbidden', 'only the Jantar extension on this Mac can call this');
  if (def.scope !== 'extension') return null;
  // A browser's device cookie never rides into the extension's routes, whatever else it carries.
  if (auth.device) throw new ApiError('forbidden', 'only the paired Jantar extension can call this');
  if (!auth.extension) throw new ApiError('unauthorized', EXTENSION_NOT_PAIRED);
  return auth.extension;
}

/** The routes extensionCaller gates, by `<method> <path pattern>` as Fastify matched them. */
const EXTENSION_GATED: ReadonlyMap<string, RouteDef> = new Map(
  (Object.entries(ROUTES) as [RouteName, RouteDef][])
    .filter(([name, def]) => def.scope === 'extension' || name === 'extPairClaim')
    .map(([, def]) => [`${def.method} ${def.path}`, def]),
);

/**
 * Authentication, scope, Origin and the device secret. Throws ApiError (401 / 403).
 * v0.5: `extension` routes and the extension's pairing claim (`name`) are
 * gated their own way, before any device check.
 */
export function gate(def: Pick<RouteDef, 'scope' | 'method'>, auth: RequestAuth, req: FastifyRequest, s: ApiServices, name?: RouteName): void {
  if (auth.transport === 'ctl') return;
  if (auth.transport === 'link') {
    // v0.6: the hub's call, as the phone it forwarded: its scopes again; no browser is in the way here.
    if (def.scope === 'public' || def.scope === 'extension' || def.scope === 'node') throw new ApiError('forbidden', 'not over the link');
    if (!auth.device || !hasScope(auth.device.scopes, def.scope)) throw new ApiError('forbidden', `this device does not have the ${def.scope} scope`);
    return;
  }
  if (def.scope === 'node') {
    // v0.6: a server's own route. While Fleet is off it does not exist; a browser never gets here.
    if (!s.ctx.settings.get().fleet.enabled) throw new ApiError('not_found', 'not found');
    if (req.headers.origin !== undefined) throw new ApiError('forbidden', 'browsers cannot call this');
    return;
  }
  if (def.scope === 'extension') {
    const bound = extensionCaller(def, auth, req, s)?.origin;
    // The worker's GET carries no Origin; its POST carries the extension's.
    const origin = headerValue(req.headers.origin);
    const ok = bound !== undefined && (def.method === 'GET' ? origin === undefined || origin === bound : origin === bound);
    if (!ok) throw new ApiError('forbidden', 'request origin is not allowed');
    const limited = s.extRequestLimiter.hit(actorName(auth));
    if (!limited.ok) {
      throw new ApiError('rate_limited', 'Too many requests from the Jantar extension; try again in a minute', {
        'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))),
      });
    }
    return;
  }
  if (name === 'extPairClaim') {
    extensionCaller(def, auth, req, s);
    if (headerValue(req.headers.origin) !== EXTENSION_ORIGIN) throw new ApiError('forbidden', 'only the Jantar extension can pair here');
    return;
  }
  if (def.scope !== 'public') {
    if (!auth.device) {
      throw new ApiError('unauthorized', 'this browser is not paired: run `jantar pair` on the Mac and scan the code');
    }
    if (!hasScope(auth.device.scopes, def.scope)) {
      throw new ApiError('forbidden', `this device does not have the ${def.scope} scope`);
    }
  }
  const needsOrigin = def.method !== 'GET';
  if (needsOrigin && !s.origin.originAllowed(req.headers.origin)) {
    throw new ApiError('forbidden', 'request origin is not allowed');
  }
  if (def.scope !== 'public' && needsDeviceSecret(def) && !auth.secretOk) {
    throw new ApiError('unauthorized', DEVICE_SECRET_REFUSAL);
  }
}

/**
 * Whether a request came in on the https public URL (Tailscale Serve, a Cloudflare tunnel), where the
 * device cookie is enough on its own. The device secret (SEC-2) guards against browsers sending a
 * 127.0.0.1 or LAN IP cookie to every port on that host; a cookie set for the public hostname only ever
 * goes to that hostname. An iPhone Home Screen app also copies Safari's cookies but not its IndexedDB,
 * so it would have no secret to send.
 */
export function cookieIsHostBound(host: string | undefined, publicUrl: string | null): boolean {
  if (!host || !publicUrl) return false;
  let u: URL;
  try {
    u = new URL(publicUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.hostname === 'localhost' || /^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[')) return false;
  return u.host === host.trim().toLowerCase();
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The device secret a request presents: the header, or on a WebSocket upgrade the offered subprotocol. */
function presentedSecret(req: FastifyRequest): string | undefined {
  const header = headerValue(req.headers[DEVICE_SECRET_HEADER]);
  if (header !== undefined) return header;
  const upgrade = headerValue(req.headers.upgrade)?.toLowerCase();
  return upgrade === 'websocket' ? secretFromSocketProtocols(req.headers['sec-websocket-protocol']) : undefined;
}

/**
 * The subprotocol the event stream answers with: always ours, never an
 * offered value (the second one carries the device secret). A client that
 * offers none gets none.
 */
export function selectSocketProtocol(offered: Set<string>): string | false {
  return offered.has(EVENTS_WS_PROTOCOL) ? EVENTS_WS_PROTOCOL : false;
}

function jsonParser(_req: FastifyRequest, body: string | Buffer, done: (err: Error | null, value?: unknown) => void): void {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  if (text.trim() === '') {
    done(null, undefined);
    return;
  }
  try {
    // Drop "__proto__" keys: bodies are merged into settings and records.
    done(null, JSON.parse(text, (k, v: unknown) => (k === '__proto__' ? undefined : v)));
  } catch {
    done(new ApiError('invalid_request', 'request body is not valid JSON'));
  }
}

/**
 * v0.6: the paired server a route goes to, or null for the Mac itself. Only
 * NODE_ROUTES, never on the `link` transport (that is the node itself). A
 * `?node=` that names no paired machine (or comes while Fleet is off) is
 * 404: it never runs on the Mac instead.
 */
function forwardTarget(s: ApiServices, name: RouteName, transport: Transport, req: FastifyRequest): FleetTarget | null {
  if (transport === 'link' || !isNodeRoute(name)) return null;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const target = s.fleet.target(name, (req.params ?? {}) as Record<string, string>, query);
  if (target) return target;
  if (NODE_ROUTES[name] === 'query' && query.node !== undefined) throw new ApiError('not_found', 'no such machine');
  return null;
}

/**
 * The pipeline's refusals that need no body: authentication, scope, Origin
 * and the device secret (gate, the extension's own gate included), `localOnly`,
 * the route's switch, a broken life.db or meetings.db, --read-only and
 * --no-terminal. Throws ApiError. A `rawBody` route runs it in `preParsing`
 * (before its body is read) and again in the handler; every other route in
 * the handler. v0.6: returns the paired server the route goes to, or null:
 * a forwarded route skips the Mac's own switch, database and terminal
 * checks (the node runs its own), and a read-only hub forwards no write.
 */
function preBodyChecks(name: RouteName, def: RouteDef, auth: RequestAuth, req: FastifyRequest, s: ApiServices, transport: Transport): FleetTarget | null {
  gate(def, auth, req, s, name);
  if (def.localOnly && transport !== 'ctl') {
    throw new ApiError('forbidden', LOCAL_ONLY_REFUSED[name] ?? 'only the Mac (the jantar CLI) can do this');
  }
  const target = forwardTarget(s, name, transport, req);
  if (target) {
    if (s.mode.readOnly && def.method !== 'GET') throw new ApiError('forbidden', READ_ONLY_REASON);
    return target;
  }
  if (!featureOn(def, s.ctx.settings.get())) {
    const off = FEATURE_OFF[def.feature as FeatureSwitch];
    throw new ApiError(off.code, off.message);
  }
  if (def.feature !== undefined && LIFE_FEATURES.has(def.feature)) {
    const broken = s.deps.life.broken();
    if (broken !== null) throw new ApiError('life_unavailable', broken);
  }
  // v0.5: meetings.db would not open (the file is untouched); the status and pairing sit behind no switch.
  if (def.feature === 'meetings') {
    const broken = s.deps.meetings.broken();
    if (broken !== null) throw new ApiError('meetings_unavailable', broken);
  }
  if (s.mode.readOnly && READ_ONLY_REFUSED.has(name)) throw new ApiError('forbidden', READ_ONLY_REASON);
  if (s.mode.terminal === 'off' && NO_TERMINAL_REFUSED.has(name)) throw new ApiError('not_implemented', NO_TERMINAL_REASON);
  // v0.6: a node with no backend it can type with (native Windows): watch and cards only.
  if (s.mode.terminal === 'none' && NO_TERMINAL_REFUSED.has(name)) throw new ApiError('not_implemented', FLEET_COPY.watchOnlyWindows(''));
  return null;
}

/** v0.6: who a forwarded call is for: the phone (its scopes, never admin), or the hub's CLI. */
function forwardActor(auth: RequestAuth): NodeCallActor {
  if (auth.transport === 'ctl' || !auth.device) return { deviceId: 'cli', deviceName: 'cli', scopes: ['read', 'control', 'launch'] };
  return { deviceId: auth.device.id, deviceName: auth.device.name, scopes: auth.device.scopes.filter((x) => x !== 'admin') };
}

/** v0.6: the wait a forwarded 429 asks for, in seconds (spec 3.6). */
const FORWARDED_RETRY_AFTER_S = '2';

/** v0.6: an Idempotency-Key a forwarded call may carry (it travels in the link's frame). */
const FORWARD_IDEM_KEY = /^[\x21-\x7e]{1,128}$/;

/** The first value of each query field, as the phone sent it (the node parses them again); `node` stays on the hub. */
function forwardQuery(query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (k !== 'node' && typeof first === 'string') out[k] = first;
  }
  return out;
}

/** The audit writers of one request: every row, and a refusal's row (writes from a paired device). */
function auditorFor(s: ApiServices, transport: Transport, name: RouteName, def: RouteDef, impl: RouteImpl, auth: RequestAuth, rawParams: Record<string, string>) {
  const isWrite = def.method !== 'GET';
  // Refusals, failures and read-scope writes from a device share a small
  // per-device budget (services.ts), so they cannot flood the audit log.
  const audit = (input: AuditInput) => {
    const lowValue = input.result !== 'ok' || def.scope === 'read';
    if (lowValue && transport === 'tcp' && !s.noiseAuditAllowed(actorName(auth))) return;
    s.auditor.write(input);
  };
  const auditRefusal = (e: unknown) => {
    if (!isWrite || impl.selfAudit || (transport === 'tcp' && !auth.device)) return;
    const r = toErrorReply(e);
    audit({
      actor: actorName(auth),
      action: name,
      target: rawParams.sid ?? rawParams.id ?? rawParams.day ?? rawParams.jobId,
      result: auditResult(r.status),
      detail: `${r.body.error.code}: ${r.body.error.message}`,
    });
  };
  return { audit, auditRefusal };
}

/** A declared Content-Length, or null when there is none (or it is not a plain number). */
function declaredLength(header: string | string[] | undefined): number | null {
  const v = headerValue(header);
  return v !== undefined && /^\d{1,15}$/.test(v) ? Number(v) : null;
}

/** The media type of a Content-Type header, lower case, without parameters. */
function mediaType(header: string | string[] | undefined): string {
  return (headerValue(header) ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * v0.4.2: errors of a `rawBody` route's own parser, in the uploads' words:
 * a body over its limit (413) and a content type it does not take (415).
 * Everything else as toErrorReply says.
 */
export function rawBodyErrorReply(err: unknown): ErrorReply {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return toErrorReply(new ApiError('payload_too_large', UPLOAD_TOO_LARGE));
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return toErrorReply(new ApiError('unsupported_media_type', UPLOAD_MEDIA_TYPE));
  return toErrorReply(err);
}

function sendError(s: ApiServices, r: ErrorReply, err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  if (r.unexpected) {
    s.log.error('request failed', {
      method: req.method,
      path: pathOf(req),
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
  void reply.code(r.status).headers(r.headers).send(r.body);
}

/**
 * v0.4.2: the `preParsing` checks of a `rawBody` route, and the release of
 * its in-flight count once per request (on the response, or when the client
 * goes away first). Every refusal also closes the connection, so the body
 * left unsent is never read.
 */
function rawBodyHooks(s: ApiServices, transport: Transport, name: RouteName, def: RouteDef, impl: RouteImpl, maxBytes: number) {
  const counted = new WeakMap<FastifyRequest, string>();
  const release = (req: FastifyRequest) => {
    const who = counted.get(req);
    if (who === undefined) return;
    counted.delete(req);
    s.uploadsInFlight.release(who);
  };
  const preParsing = async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const auth = req.ccw;
    const rawParams = (req.params ?? {}) as Record<string, string>;
    try {
      const target = preBodyChecks(name, def, auth, req, s, transport);
      // An unknown or ended session never makes the daemon read a body (the store would refuse it after).
      // v0.6: a paired server's session too, before its upload is forwarded.
      if (rawParams.sid !== undefined && sessionOr404(s, rawParams.sid, { nodeOk: target !== null }).status === 'ended') {
        throw new ApiError('not_found', 'no such session');
      }
      // Nor does a bad query (the upload's ?ext=); the handler parses it again.
      parseWith(def.query, req.query ?? {}, 'query');
      if (mediaType(req.headers['content-type']) !== 'application/octet-stream') throw new ApiError('unsupported_media_type', UPLOAD_MEDIA_TYPE);
      const length = declaredLength(req.headers['content-length']);
      if (length === null) throw new ApiError('length_required', UPLOAD_NO_LENGTH);
      if (length > maxBytes) throw new ApiError('payload_too_large', UPLOAD_TOO_LARGE);
      const who = actorName(auth);
      if (!s.uploadsInFlight.take(who)) throw new ApiError('rate_limited', UPLOAD_IN_FLIGHT, { 'retry-after': '1' });
      counted.set(req, who);
      // A client that sent the whole body and went away before the reply fires neither hook below.
      reply.raw.once('close', () => release(req));
      const count = s.uploadLimiter.hit(who);
      if (!count.ok) throw new ApiError('rate_limited', UPLOAD_BUDGET, { 'retry-after': String(Math.max(1, Math.ceil(count.retryAfterMs / 1000))) });
      const budget = s.uploadBytesBudget.take(who, length);
      if (!budget.ok) {
        throw new ApiError('rate_limited', UPLOAD_BUDGET, { 'retry-after': String(Math.max(1, Math.ceil(budget.retryAfterMs / 1000))) });
      }
    } catch (e) {
      auditorFor(s, transport, name, def, impl, auth, rawParams).auditRefusal(e);
      reply.header('connection', 'close');
      throw e;
    }
    return payload;
  };
  return { preParsing, onResponse: async (req: FastifyRequest) => release(req), onRequestAbort: async (req: FastifyRequest) => release(req) };
}

function registerRoute(app: FastifyInstance, s: ApiServices, transport: Transport, name: RouteName, def: RouteDef, impl: RouteImpl): void {
  if (transport === 'ctl' && !def.ctl) return;
  if (def.method === 'WS') return;
  const isWrite = def.method !== 'GET';
  const raw = def.rawBody;
  app.route({
    method: def.method,
    url: def.path,
    // v0.5: the screenshot upload's own limit (its 413 names it: setErrorHandler below).
    ...(def.bodyLimit !== undefined ? { bodyLimit: def.bodyLimit } : {}),
    ...(raw ? { bodyLimit: raw.maxBytes, ...rawBodyHooks(s, transport, name, def, impl, raw.maxBytes) } : {}),
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = req.ccw;
      const rawParams = (req.params ?? {}) as Record<string, string>;
      const { audit, auditRefusal } = auditorFor(s, transport, name, def, impl, auth, rawParams);

      let call: Call;
      let target: FleetTarget | null;
      try {
        target = preBodyChecks(name, def, auth, req, s, transport);
        const idemHeader = req.headers[IDEMPOTENCY_HEADER];
        call = {
          params: parseWith(def.params, rawParams, 'path'),
          query: parseWith(def.query, req.query ?? {}, 'query'),
          body: raw ? undefined : parseWith(def.body, req.body, 'body'),
          auth,
          req,
          reply,
          scratch: {},
        } as Call;
        if (raw) call.raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (typeof idemHeader === 'string' && idemHeader !== '') call.idempotencyKey = idemHeader;
        if (target && call.idempotencyKey !== undefined && !FORWARD_IDEM_KEY.test(call.idempotencyKey)) {
          throw new ApiError('invalid_request', 'invalid Idempotency-Key: 1 to 128 visible characters');
        }
        if (transport !== 'ctl') {
          const body = call.body;
          const field = CTL_ONLY_FIELDS[name]?.find((f) => typeof body === 'object' && body !== null && Object.hasOwn(body, f));
          if (field) throw new ApiError('invalid_request', `invalid body at ${field}: only the Mac's CLI sends it`);
        }
        // Every Life write counts here, so no route can forget to (estimates have their own limits on top).
        if (isWrite && def.feature !== undefined && LIFE_FEATURES.has(def.feature)) {
          const limited = s.lifeWriteLimiter.hit(actorName(auth));
          if (!limited.ok) {
            throw new ApiError('rate_limited', 'Too many Life changes from this device; try again in a minute', {
              'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)),
            });
          }
        }
        // v0.5: a phone's Meetings writes share that limit (the extension has its own, in the gate).
        if (isWrite && def.feature === 'meetings' && auth.actor?.kind === 'device') {
          const limited = s.lifeWriteLimiter.hit(actorName(auth));
          if (!limited.ok) {
            throw new ApiError('rate_limited', MEETING_WRITES_LIMITED, { 'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)) });
          }
        }
      } catch (e) {
        auditRefusal(e);
        throw e;
      }

      if (target) {
        // v0.6: the node runs it, behind its own switches and guards; only its idempotency cache replays.
        const fwd: ForwardCall = { route: name as ForwardCall['route'], params: { ...rawParams }, query: forwardQuery(req.query), actor: forwardActor(auth) };
        if (raw) fwd.raw = call.raw ?? Buffer.alloc(0);
        else if (call.body !== undefined) fwd.body = call.body;
        if (call.idempotencyKey !== undefined) fwd.idem = `${fwd.actor.deviceId}:${call.idempotencyKey}`;
        const out = await s.fleet.forward(target, fwd);
        if (isWrite) {
          const err = (out.body as { error?: { code: string; message: string } } | null)?.error;
          audit({
            actor: actorName(auth),
            action: name,
            target: rawParams.sid ?? rawParams.id,
            params: { node: target.nodeId },
            result: auditResult(out.status),
            detail: err ? `${err.code}: ${err.message}` : undefined,
          });
        }
        if (auth.transport === 'tcp' && (auth.touched || auth.legacyCookie) && auth.deviceKey && out.status < 400) {
          reply.setCookie(DEVICE_COOKIE, auth.deviceKey, s.cookieOptions());
        }
        // The link carries no headers: a forwarded 429 (17 calls in flight to that server, or its own limit) gets one here.
        if (out.status === 429) reply.header('retry-after', FORWARDED_RETRY_AFTER_S);
        return reply.code(out.status).send(out.body);
      }

      const run = async (): Promise<{ status: number; body: unknown }> => {
        try {
          const body = await impl.handle(call, s);
          return { status: def.status ?? 200, body };
        } catch (e) {
          const r = toErrorReply(e);
          if (r.unexpected) throw e;
          for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
          return { status: r.status, body: r.body };
        }
      };

      let out: { status: number; body: unknown };
      let replayed = false;
      try {
        // Ask Claude's reply is model output about a meal: never kept for replay, whatever the client sends.
        // A raw body (an upload) is never replayed either: a second post makes a second file (v0.4.2).
        if (isWrite && call.idempotencyKey && def.scope !== 'public' && name !== 'foodEstimate' && !raw) {
          const scope = `${actorName(auth)}|${def.method}|${pathOf(req)}`;
          const r = await s.idem.run(scope, call.idempotencyKey, call.body, run);
          out = r.response;
          replayed = r.replayed;
        } else {
          out = await run();
        }
      } catch (e) {
        if (isWrite && !impl.selfAudit) {
          const r = toErrorReply(e);
          audit({
            actor: actorName(auth),
            action: name,
            target: rawParams.sid ?? rawParams.id ?? rawParams.day ?? rawParams.jobId,
            result: auditResult(r.status),
            detail: r.unexpected ? 'internal error' : `${r.body.error.code}: ${r.body.error.message}`,
          });
        }
        throw e;
      }

      if (isWrite && !replayed && !impl.selfAudit) {
        const extra = impl.audit?.(call, out) ?? {};
        const err = (out.body as { error?: { code: string; message: string } } | null)?.error;
        audit({
          actor: actorName(auth),
          action: name,
          target: extra.target ?? rawParams.sid ?? rawParams.id,
          params: extra.params ?? {},
          result: auditResult(out.status),
          detail: err ? `${err.code}: ${err.message}` : undefined,
        });
      }
      if (replayed) reply.header('idempotent-replayed', 'true');
      if (auth.transport === 'tcp' && (auth.touched || auth.legacyCookie) && auth.deviceKey && out.status < 400) {
        reply.setCookie(DEVICE_COOKIE, auth.deviceKey, s.cookieOptions());
      }
      if (def.rawResponse && isRawReply(out.body)) {
        const raw = out.body;
        for (const [k, v] of Object.entries(raw.headers ?? {})) reply.header(k, v);
        reply.header('content-type', raw.type);
        return reply.code(raw.status ?? out.status).send(raw.body);
      }
      return reply.code(out.status).send(out.body);
    },
  });
}

export async function buildApp(s: ApiServices, transport: Transport, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: false,
    forceCloseConnections: true,
    return503OnClosing: true,
    routerOptions: { maxParamLength: 256 },
  });
  app.decorateRequest('ccw', null as unknown as RequestAuth);

  // JSON only; an empty body is "no body".
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: MAX_BODY_BYTES }, jsonParser);

  if (transport === 'tcp') await app.register(fastifyCookie);
  // v0.6: the link app has no sockets of its own (the node link is the hub's, api/node-upgrade.ts).
  if (transport !== 'link') await app.register(fastifyWebsocket, {
    options: { maxPayload: 4096, handleProtocols: selectSocketProtocol },
    errorHandler: (error: Error, socket: WsLike) => {
      s.log.warn('event stream error', { error: error.message });
      try {
        socket.close(1011, 'internal error');
      } catch {
        /* already closed */
      }
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    if (transport === 'ctl') {
      req.ccw = cliAuth();
      return;
    }
    if (transport === 'link') {
      // v0.6: the caller the server's injector registered for this one call (api/server.ts).
      const token = headerValue(req.headers[LINK_CALL_HEADER]);
      const auth = token === undefined ? undefined : s.linkCalls.get(token);
      if (!auth) {
        req.ccw = { transport: 'link', actor: null, device: null, touched: false, rateKey: 'link' };
        await reply.code(401).send(errorBody('unauthorized', 'unknown link call'));
        return reply;
      }
      req.ccw = auth;
      return;
    }
    if (!s.origin.hostAllowed(req.headers.host)) {
      req.ccw = { transport: 'tcp', actor: null, device: null, touched: false, rateKey: 'unknown' };
      await reply.code(403).send(errorBody('forbidden', 'unknown Host header'));
      return reply;
    }
    const auth: RequestAuth = {
      transport: 'tcp',
      actor: null,
      device: null,
      touched: false,
      secretOk: false,
      rateKey: rateLimitKey(
        { remoteAddress: req.raw.socket?.remoteAddress, headers: req.headers },
        proxyHeaderFor(s.ctx.settings.get().remote.mode),
      ),
    };
    const path = pathOf(req);
    // v0.6: a server's own paths read no device cookie (and no secret, nor the extension's key).
    if (isApiPath(path) && !path.startsWith(NODE_PREFIX)) {
      // A phone paired with ccw-v2 (imported with `jantar import-ccw-v2`) still sends the old cookie.
      const current = req.cookies?.[DEVICE_COOKIE];
      const key = current ?? req.cookies?.[LEGACY_DEVICE_COOKIE];
      const r = s.devices.authenticate(key);
      if (r.ok) {
        auth.device = r.device;
        auth.actor = { kind: 'device', deviceId: r.device.id, scopes: r.device.scopes };
        auth.touched = r.touched;
        auth.secretOk =
          deviceSecretMatches(r.device, presentedSecret(req)) ||
          cookieIsHostBound(req.headers.host, s.ctx.settings.get().remote.publicUrl);
        if (key) auth.deviceKey = key;
        if (current === undefined) auth.legacyCookie = true;
      } else {
        auth.authFailure = r.reason;
      }
    }
    // v0.5: the extension's key is read on its own paths only, so it authenticates nothing else.
    if (path.startsWith(EXT_PREFIX)) {
      const key = headerValue(req.headers[EXTENSION_KEY_HEADER]);
      const r = key === undefined ? null : s.extensions.authenticate(key);
      if (r?.ok) {
        auth.extension = { id: r.extension.id, origin: r.extension.origin };
        if (!auth.device) auth.actor = { kind: 'extension', extensionId: r.extension.id };
      }
    }
    req.ccw = auth;
    // v0.5: a caller the extension's gate refuses anyway (from off this Mac, or without the key) is
    // refused here, before Fastify reads and parses its body: the screenshot route takes 6 MB. Matched
    // on the route Fastify found, so an encoded path cannot skip it. A device cookie goes on to the
    // gate, which refuses it there and audits a write.
    const ext = EXTENSION_GATED.get(`${req.routeOptions.method} ${req.routeOptions.url}`);
    if (ext && !auth.device) {
      try {
        extensionCaller(ext, auth, req, s);
      } catch (e) {
        const r = toErrorReply(e);
        await reply.code(r.status).headers(r.headers).send(r.body);
        return reply;
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (transport === 'tcp') {
      for (const [k, v] of Object.entries(securityHeaders(req.headers.host))) {
        if (!reply.hasHeader(k)) reply.header(k, v);
      }
    }
    // A raw reply may say more ("private, no-store"), never less.
    if (isApiPath(pathOf(req)) && !String(reply.getHeader('cache-control') ?? '').includes('no-store')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  // Route pattern and status only: never bodies, query strings or cookies.
  app.addHook('onResponse', async (req, reply) => {
    s.log.debug('request', {
      transport,
      method: req.method,
      route: req.routeOptions?.url ?? 'unmatched',
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  // v0.5: a 413 names the route's own limit (the screenshot upload's), not only MAX_BODY_BYTES.
  app.setErrorHandler((err, req, reply) =>
    sendError(s, toErrorReply(err, { bodyLimit: req.routeOptions?.bodyLimit ?? MAX_BODY_BYTES }), err, req, reply),
  );

  app.setNotFoundHandler((req, reply) => {
    if (transport === 'tcp' && serveIndexFallback(req, reply, s.webAvailable)) return;
    void reply.code(404).send(errorBody('not_found', 'not found'));
  });

  // GET /healthz: public liveness (no data).
  if (transport !== 'link') app.get(ROUTES.health.path, async () => ({ ok: true, protocol: s.ctx.version.protocol, daemonVersion: s.ctx.version.daemon }));

  // WS /v1/events
  const ev = ROUTES.events;
  if (transport !== 'link') app.get(
    ev.path,
    {
      websocket: true,
      preHandler: async (req) => {
        if (req.ccw.transport === 'tcp') {
          gate({ scope: ev.scope, method: 'GET' }, req.ccw, req, s);
          // A WebSocket is not covered by CORS: always require an allowed Origin.
          if (!s.origin.originAllowed(req.headers.origin)) throw new ApiError('forbidden', 'request origin is not allowed');
          // The stream carries everything a device can see: a cookie read on another loopback port is not enough.
          if (!req.ccw.secretOk) throw new ApiError('unauthorized', DEVICE_SECRET_REFUSAL);
        }
        parseWith(EventsQuerySchema, req.query ?? {}, 'query');
      },
    },
    (socket: WsLike, req: FastifyRequest) => {
      const q = EventsQuerySchema.parse(req.query ?? {});
      openEventStream(socket, s, req.ccw, q.after);
    },
  );

  for (const [name, def] of Object.entries(ROUTES) as [RouteName, RouteDef][]) {
    if (name === 'health' || name === 'events') continue;
    // v0.6: the link serves the routes a hub forwards, and nothing else.
    if (transport === 'link' && !isNodeRoute(name)) continue;
    const impl = ROUTE_IMPLS[name];
    if (!impl) throw new Error(`no handler for route ${name}`);
    const raw = def.rawBody;
    if (raw && (transport !== 'ctl' || def.ctl)) {
      // v0.4.2: its own scope, so its parser and error words reach no other route.
      await app.register(async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: raw.maxBytes }, (_req, body, done) => {
          s.rawBodiesRead += 1;
          done(null, body);
        });
        scope.setErrorHandler((err, req, reply) => sendError(s, rawBodyErrorReply(err), err, req, reply));
        registerRoute(scope, s, transport, name, def, impl);
      });
    } else {
      registerRoute(app, s, transport, name, def, impl);
    }
  }

  if (transport === 'ctl') registerCtlRoutes(app, s, opts.address ?? (() => null));

  if (transport === 'tcp' && s.webAvailable && s.webDist) await registerWebApp(app, s.webDist);

  await app.ready();
  return app;
}
