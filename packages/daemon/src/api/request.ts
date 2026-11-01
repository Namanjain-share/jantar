/**
 * Who is calling, attached to every request as `req.ccw`.
 *
 * - On the control socket the caller is the CLI: actor "cli", every scope.
 * - On TCP the caller is the paired device whose key is in the HttpOnly
 *   cookie, or nobody. Nothing else grants access: not the peer address, not
 *   a header, not a query parameter. Writes above read scope and the event
 *   stream also need that device's secret (`secretOk`, SEC-2), which on its
 *   own grants nothing.
 * - v0.5: on `/v1/ext/` paths only, the paired Chrome extension's key in
 *   EXTENSION_KEY_HEADER makes the caller that extension (actor
 *   `extension`). It reaches the extension's capture routes and nothing
 *   else; anywhere else the header is never read. The loopback peer and
 *   Host the gate also asks for there are extra conditions, never a grant.
 * - v0.8: on CAPTURE_PREFIX paths only, a capture key in CAPTURE_KEY_HEADER
 *   makes the caller the iOS Shortcut (actor `capture`, by the key's id). It
 *   reaches the capture door and nothing else; no device cookie is read
 *   there, and anywhere else the header is never read.
 * - v0.6: on a node, the `link` transport is the hub's calls, run in-process
 *   (no listener): the caller is the phone as the hub forwarded it, a device
 *   `hub.<device id>` with the phone's scopes, never stored. Nothing outside
 *   the process can reach it.
 */
import type { Device, Scope } from '@jantar/protocol';
import type { NodeCallActor } from '@jantar/protocol/node-link';
import type { Actor } from '../contracts.js';
import type { AuthFailure } from '../auth/devices.js';
import { actorId } from '../core/actor.js';
import { ALL_SCOPES } from '../auth/scopes.js';

export type Transport = 'tcp' | 'ctl' | 'link';

export interface RequestAuth {
  transport: Transport;
  /** null: no valid device cookie (TCP only). */
  actor: Actor | null;
  device: Device | null;
  authFailure?: AuthFailure;
  /** The device key from the cookie, kept only to refresh the cookie's lifetime. */
  deviceKey?: string;
  /** lastSeenAt was refreshed on this request: re-issue the cookie. */
  touched: boolean;
  /** The key came in ccw-v2's cookie: re-issue it under the current name. */
  legacyCookie?: boolean;
  /** The request carried this device's secret (header, or WebSocket subprotocol). Always false without a device. */
  secretOk?: boolean;
  /** v0.5: the paired extension whose key came in EXTENSION_KEY_HEADER (read on `/v1/ext/` paths only), and the Origin bound to it. */
  extension?: { id: string; origin: string };
  /** v0.8: the capture key that came in CAPTURE_KEY_HEADER (read on CAPTURE_PREFIX paths only), by its id. */
  capture?: { id: string };
  /** Rate-limit key (address based; never used for trust). */
  rateKey: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    ccw: RequestAuth;
  }
}

export function cliAuth(): RequestAuth {
  return { transport: 'ctl', actor: { kind: 'cli' }, device: null, touched: false, rateKey: 'ctl' };
}

export function scopesOf(auth: RequestAuth): readonly Scope[] {
  if (auth.transport === 'ctl') return ALL_SCOPES;
  return auth.device?.scopes ?? [];
}

/** Audit / decidedBy name of the caller. */
export function actorName(auth: RequestAuth): string {
  return auth.actor ? actorId(auth.actor) : 'anonymous';
}

/**
 * v0.6: the header that names one in-process `link` call (a random token the
 * server's injector maps to its RequestAuth for that call only).
 */
export const LINK_CALL_HEADER = 'x-jantar-link-call';

/** The device a forwarded call becomes on a node: `hub.<phone's id>`, the phone's scopes, never stored. */
export function linkAuth(actor: NodeCallActor, at: string): RequestAuth {
  const deviceId = `hub.${actor.deviceId}`;
  const scopes = [...actor.scopes];
  const device: Device = { id: deviceId, name: actor.deviceName, keyHash: '', scopes, createdAt: at, lastSeenAt: at };
  return {
    transport: 'link',
    actor: { kind: 'device', deviceId, scopes },
    device,
    touched: false,
    secretOk: true,
    rateKey: `link:${deviceId}`,
  };
}
