/**
 * v0.6 Fleet: the in-band handshake right after the upgrade. Internal to the
 * link (fleet/socket.ts on the hub, node/dialer.ts on a node).
 *
 *   hub  -> node  challenge {v:1, nonce: nH}
 *   node -> hub   auth {..., sig: Sign_node(linkSigText('node', nodeId, nH, nN))}   within NODE_LIMITS.handshakeMs (4408)
 *   hub  -> node  welcome {name, sig: Sign_hub(linkSigText('hub', nodeId, nH, nN))}
 *
 * Fresh 32-byte nonces from crypto.randomBytes on both sides stop replay;
 * the two labels and the two keys stop reflection; no clocks. The hub
 * accepts nothing but `auth` before it, and the node acts on nothing before
 * a verified `welcome`. Each side reads the other's link version (the
 * challenge's `v`, the auth's `proto`) before the strict parse: another
 * version is 4426 ("update Jantar"), never 4400.
 */
import { randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NodeBackend, NodeOs } from '@jantar/protocol';
import { NODE_LIMITS, NODE_PROTO, type NodeFrameOf } from '@jantar/protocol/node-link';
import { signLink, verifyLink } from './keys.js';

/** A fresh handshake nonce: 32 random bytes, base64url. */
export function newNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** What a node says of itself in its `auth` frame. */
export interface NodeSelf {
  os: NodeOs;
  /** Its Jantar version. */
  version: string;
  backend: NodeBackend;
  /** Started with --read-only. */
  readOnly: boolean;
}

/** The `v` of this version's challenge. */
export const CHALLENGE_V = 1;

/** The hub's first frame on a new socket. */
export function challengeFrame(nonce: string): NodeFrameOf<'challenge'> {
  return { k: 'challenge', v: CHALLENGE_V, nonce };
}

/**
 * A handshake frame's text as a plain object, read before the strict parse
 * (null if it is not one): a newer peer's challenge or auth may carry what
 * this version does not know, and its `v` or `proto` must still be heard as
 * another link version (4426), never as a protocol error.
 */
export function looseFrame(text: string): Record<string, unknown> | null {
  if (Buffer.byteLength(text, 'utf8') > NODE_LIMITS.frameBytes) return null;
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether a loosely read `auth` (another link version's) is signed by `publicKey` for this challenge. */
export function looseAuthValid(publicKey: string, raw: Record<string, unknown>, hubNonce: string): boolean {
  const { nodeId, nonce, sig } = raw;
  return typeof nodeId === 'string' && typeof nonce === 'string' && typeof sig === 'string' && verifyLink(publicKey, 'node', nodeId, hubNonce, nonce, sig);
}

/** The node's answer to a challenge, signed with its own key; `nonce` is the node's fresh nN. */
export function authFrame(
  key: KeyObject,
  nodeId: string,
  hubNonce: string,
  nonce: string,
  self: NodeSelf,
  accessRefused: number,
): NodeFrameOf<'auth'> {
  return {
    k: 'auth',
    nodeId,
    nonce,
    proto: NODE_PROTO,
    version: self.version,
    os: self.os,
    backend: self.backend,
    readOnly: self.readOnly,
    accessRefused,
    sig: signLink(key, 'node', nodeId, hubNonce, nonce),
  };
}

/** Whether an `auth` frame is signed by `publicKey` for this challenge. */
export function authValid(publicKey: string, auth: NodeFrameOf<'auth'>, hubNonce: string): boolean {
  return verifyLink(publicKey, 'node', auth.nodeId, hubNonce, auth.nonce, auth.sig);
}

/** The hub's answer to a valid `auth`: the node's name, and the hub's signature over both nonces. */
export function welcomeFrame(key: KeyObject, name: string, nodeId: string, hubNonce: string, nodeNonce: string): NodeFrameOf<'welcome'> {
  return { k: 'welcome', name, sig: signLink(key, 'hub', nodeId, hubNonce, nodeNonce) };
}

/** Whether a `welcome` comes from the hub whose key was pinned at join. */
export function welcomeValid(hubKey: string, nodeId: string, hubNonce: string, nodeNonce: string, welcome: NodeFrameOf<'welcome'>): boolean {
  return verifyLink(hubKey, 'hub', nodeId, hubNonce, nodeNonce, welcome.sig);
}

/**
 * The machine this node runs on: macOS, Windows, Linux, or Linux inside
 * WSL2 (`microsoft` in /proc/sys/kernel/osrelease).
 */
export function thisNodeOs(platform: NodeJS.Platform = process.platform, osRelease: () => string = readOsRelease): NodeOs {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return /microsoft/i.test(osRelease()) ? 'wsl' : 'linux';
}

function readOsRelease(): string {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8');
  } catch {
    return '';
  }
}
