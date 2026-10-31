/**
 * The worker's only way to the daemon: a fixed table of operations, each
 * one route on `http://127.0.0.1:<port>`, called with `credentials: 'omit'`
 * (a device cookie the browser may hold for 127.0.0.1 never rides along)
 * and the key in its own header. A page or the popup never names a path or
 * a URL; they name an operation through a message, and only the worker
 * fills in a client id it made itself. Only GET and POST: an extension
 * fetch's GET carries no Origin and its POST `chrome-extension://<id>`,
 * which is what the daemon checks.
 *
 * The table mirrors the protocol's ROUTES (the extension cannot import them:
 * zod); test/background/client.test.ts pins the two equal.
 */
import { DAEMON_ORIGIN, EXTENSION_KEY_HEADER } from '../shared/wire.js';
import type { KeyStore, Pairing } from './store.js';

export const EXT_ROUTES = Object.freeze({
  /** extInfo: the connection and the assign sheet's projects. */
  info: { method: 'GET', path: '/v1/ext/info' },
  /** extPairClaim: trade the pasted code for the key (no key yet). */
  claim: { method: 'POST', path: '/v1/ext/pair' },
  /** extMeetingOpen: Start, or a screenshot before Start (an upsert on the client id). */
  open: { method: 'POST', path: '/v1/ext/meetings/:clientId' },
  /** extMeetingLines: caption lines; an empty list is the keep-alive. */
  lines: { method: 'POST', path: '/v1/ext/meetings/:clientId/lines' },
  /** extMeetingShot: one screenshot as a JPEG data URL. */
  shot: { method: 'POST', path: '/v1/ext/meetings/:clientId/shots' },
  /** extMeetingEnd */
  end: { method: 'POST', path: '/v1/ext/meetings/:clientId/end' },
} as const);

export type Op = keyof typeof EXT_ROUTES;
/** The operations that carry the key. */
export type KeyedOp = Exclude<Op, 'claim'>;

/** How long a call may take before it counts as no answer (a screenshot uploads megabytes). */
export const CALL_TIMEOUT_MS = 5_000;
export const SHOT_TIMEOUT_MS = 15_000;

export type Reply<T = unknown> =
  /** 2xx, with the parsed body (null when it was not JSON). */
  | { kind: 'ok'; status: number; body: T }
  /** Jantar answered with an error: its status and its sentence. */
  | { kind: 'error'; status: number; sentence: string }
  /** No answer: Jantar is not running, or it took too long. */
  | { kind: 'down' }
  /** No key here; `forgotten`: Jantar answered 401, so the key was dropped just now. */
  | { kind: 'unpaired'; forgotten?: true };

export interface ClientDeps {
  keys: KeyStore;
  fetch: typeof fetch;
  /** After a 401 dropped the key: tell the tabs (the button goes, notes stop). */
  onUnpaired(): Promise<void>;
  timeouts?: { call: number; shot: number };
}

export interface Client {
  /** A capture or info call with the stored key. */
  call<T = unknown>(op: KeyedOp, req?: { clientId?: string; body?: unknown }): Promise<Reply<T>>;
  /** The pairing claim on `port` (no key). */
  claim(port: number, code: string): Promise<Reply<{ id?: unknown; key?: unknown }>>;
}

/** A client id is a uuid the worker made; anything else never reaches a path. */
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The daemon's sentence from an error body, else a plain one with the status. */
async function sentenceOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } } | null;
    const message = body?.error?.message;
    if (typeof message === 'string' && message.trim() !== '') return message.trim().slice(0, 300);
  } catch {
    // not JSON
  }
  return `Jantar answered with an error (${res.status}).`;
}

export function createClient(deps: ClientDeps): Client {
  const timeouts = deps.timeouts ?? { call: CALL_TIMEOUT_MS, shot: SHOT_TIMEOUT_MS };

  async function send<T>(port: number, op: Op, clientId: string | undefined, body: unknown, key: string | null): Promise<Reply<T>> {
    const route = EXT_ROUTES[op];
    let path: string = route.path;
    if (path.includes(':clientId')) {
      if (!clientId || !CLIENT_ID.test(clientId)) throw new Error('bad client id');
      path = path.replace(':clientId', clientId);
    }
    const headers: Record<string, string> = {};
    if (key) headers[EXTENSION_KEY_HEADER] = key;
    if (route.method === 'POST') headers['content-type'] = 'application/json';
    let res: Response;
    try {
      // `${DAEMON_ORIGIN}:${port}`, never `http://${DAEMON_HOST}`: the bundle test reads every URL in the built file.
      res = await deps.fetch(`${DAEMON_ORIGIN}:${port}${path}`, {
        method: route.method,
        credentials: 'omit',
        headers,
        ...(route.method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(op === 'shot' ? timeouts.shot : timeouts.call),
      });
    } catch {
      return { kind: 'down' };
    }
    if (res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { kind: 'ok', status: res.status, body: parsed as T };
    }
    return { kind: 'error', status: res.status, sentence: await sentenceOf(res) };
  }

  return {
    async call<T>(op: KeyedOp, req: { clientId?: string; body?: unknown } = {}): Promise<Reply<T>> {
      const pairing: Pairing | null = await deps.keys.get();
      if (!pairing) return { kind: 'unpaired' };
      const reply = await send<T>(pairing.port, op, req.clientId, req.body, pairing.key);
      if (reply.kind === 'error' && reply.status === 401) {
        // Jantar no longer knows this key (unpaired at the Mac, idle 90 days, or a sixth extension paired).
        // Forget it only if it is still the one stored: a pairing that landed meanwhile stays.
        const now = await deps.keys.get();
        if (now?.key === pairing.key) {
          await deps.keys.clear();
          await deps.onUnpaired();
        }
        return { kind: 'unpaired', forgotten: true };
      }
      return reply;
    },
    claim(port, code) {
      return send(port, 'claim', undefined, { code }, null);
    },
  };
}
