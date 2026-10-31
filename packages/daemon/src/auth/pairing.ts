/**
 * One-time pairing codes (SECURITY.md, "Authentication and authorisation").
 *
 * - A code is 128 random bits (base64url), valid for 10 minutes, single use.
 *   Only its sha256 is kept, in memory: a daemon restart invalidates every
 *   outstanding code, which is the safe direction.
 * - Codes are created only through the local admin channel: the CLI on the
 *   0600 control socket, or a device that already holds the admin scope. A
 *   TCP connection from 127.0.0.1 never counts as local (Tailscale Serve and
 *   tunnels connect from loopback too).
 * - The pairing link carries the code in the URL fragment
 *   (`<base>/pair#c=<code>`), so it never reaches a server log or a Referer.
 * - v0.5: a code has a kind. A device code is claimed with `claim()` (a
 *   phone or browser); an extension code with `claimExtension()` (the Chrome
 *   extension, `jantar pair --extension`). Each claim answers `invalid` for
 *   the other kind's code without spending it. One store, one set of rules.
 */
import { PAIR_CODE_TTL_MS, type Device, type Scope } from '@jantar/protocol';
import type { Clock, Logger } from '../contracts.js';
import { sha256Hex } from '../core/hash.js';
import { newId, randomToken } from '../core/ids.js';
import { silentLogger } from '../core/log.js';
import type { DeviceAuth } from './devices.js';
import type { ExtensionAuth } from './extensions.js';
import { DEFAULT_DEVICE_SCOPES, normalizeScopes } from './scopes.js';

/** Outstanding codes kept at most; the oldest is dropped first. */
export const MAX_OPEN_CODES = 20;

export type PairKind = 'device' | 'extension';

interface CodeEntry {
  pairId: string;
  kind: PairKind;
  scopes: Scope[];
  name?: string;
  expiresAt: number;
  createdBy: string;
}

export interface PairStartInput {
  /** Default 'device'. An extension code carries no scopes (its key reaches the capture routes only). */
  kind?: PairKind;
  name?: string;
  scopes?: readonly Scope[];
  /** Audit actor id of whoever asked. */
  createdBy: string;
}

export interface PairStartResult {
  pairId: string;
  code: string;
  scopes: Scope[];
  expiresAt: string;
}

export type PairClaimResult =
  | { ok: true; device: Device; key: string; secret: string; pairId: string }
  | { ok: false; code: 'invalid' | 'expired'; message: string };

export type ExtensionClaimResult =
  | { ok: true; id: string; key: string; pairId: string }
  | { ok: false; code: 'invalid' | 'expired'; message: string };

export interface PairingOptions {
  clock: Pick<Clock, 'now' | 'iso'>;
  devices: DeviceAuth;
  /** v0.5: issues the extension's key on an extension claim (without it, every extension claim is invalid). */
  extensions?: ExtensionAuth;
  log?: Logger;
  ttlMs?: number;
  maxOpen?: number;
}

const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;

function hashCode(code: string): string {
  return sha256Hex(`jantar-pair:${code}`);
}

/** The pairing link shown as a QR code: the code rides in the fragment. */
export function pairingUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/pair#c=${encodeURIComponent(code)}`;
}

export class PairingService {
  private readonly codes = new Map<string, CodeEntry>();
  private readonly ttlMs: number;
  private readonly maxOpen: number;
  private readonly log: Logger;

  constructor(private readonly opts: PairingOptions) {
    this.ttlMs = opts.ttlMs ?? PAIR_CODE_TTL_MS;
    this.maxOpen = opts.maxOpen ?? MAX_OPEN_CODES;
    this.log = opts.log ?? silentLogger;
  }

  start(input: PairStartInput): PairStartResult {
    this.sweep();
    const code = randomToken(16);
    const now = this.opts.clock.now();
    const kind = input.kind ?? 'device';
    const entry: CodeEntry = {
      pairId: newId(),
      kind,
      scopes: kind === 'extension' ? [] : normalizeScopes(input.scopes && input.scopes.length > 0 ? input.scopes : DEFAULT_DEVICE_SCOPES),
      expiresAt: now + this.ttlMs,
      createdBy: input.createdBy,
    };
    if (input.name) entry.name = input.name;
    this.codes.set(hashCode(code), entry);
    while (this.codes.size > this.maxOpen) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    this.log.info('pairing code created', { pairId: entry.pairId, kind, scopes: entry.scopes, by: input.createdBy });
    return { pairId: entry.pairId, code, scopes: [...entry.scopes], expiresAt: this.opts.clock.iso(entry.expiresAt) };
  }

  /**
   * Trade a code for a new device. The code is used up even when it has
   * expired. An extension's code is `invalid` here and is not used up.
   */
  claim(input: { code: string; name: string; userAgent?: string }): PairClaimResult {
    if (!CODE_RE.test(input.code)) return { ok: false, code: 'invalid', message: 'pairing code is not valid' };
    const h = hashCode(input.code);
    const entry = this.codes.get(h);
    if (!entry || entry.kind !== 'device') return { ok: false, code: 'invalid', message: 'pairing code is not valid' };
    this.codes.delete(h);
    if (this.opts.clock.now() > entry.expiresAt) {
      return { ok: false, code: 'expired', message: 'pairing code has expired; create a new one with: jantar pair' };
    }
    const issueInput: { name: string; scopes: Scope[]; userAgent?: string } = {
      name: entry.name ?? input.name,
      scopes: entry.scopes,
    };
    if (input.userAgent) issueInput.userAgent = input.userAgent;
    const { device, key, secret } = this.opts.devices.issue(issueInput);
    this.log.info('device paired', { pairId: entry.pairId, deviceId: device.id, scopes: device.scopes });
    return { ok: true, device, key, secret, pairId: entry.pairId };
  }

  /**
   * v0.5: trade an extension code for the extension's key, bound to `origin`
   * (the route has already checked it is the published extension's). The
   * code is used up even when it has expired; a device's code is `invalid`
   * here and is not used up.
   */
  claimExtension(code: string, origin: string): ExtensionClaimResult {
    if (!CODE_RE.test(code)) return { ok: false, code: 'invalid', message: 'pairing code is not valid' };
    const h = hashCode(code);
    const entry = this.codes.get(h);
    if (!entry || entry.kind !== 'extension' || !this.opts.extensions) return { ok: false, code: 'invalid', message: 'pairing code is not valid' };
    this.codes.delete(h);
    if (this.opts.clock.now() > entry.expiresAt) {
      return { ok: false, code: 'expired', message: 'pairing code has expired; create a new one with: jantar pair --extension' };
    }
    const { id, key } = this.opts.extensions.issue(origin);
    this.log.info('extension paired', { pairId: entry.pairId, extensionId: id });
    return { ok: true, id, key, pairId: entry.pairId };
  }

  /** Codes not yet used or expired. */
  openCount(): number {
    this.sweep();
    return this.codes.size;
  }

  private sweep(): void {
    const now = this.opts.clock.now();
    for (const [h, e] of this.codes) if (now > e.expiresAt) this.codes.delete(h);
  }
}
