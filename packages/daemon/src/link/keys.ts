/**
 * v0.6 Fleet: the link's keys (lane L1). STUB from wave 0: every function
 * throws NotImplementedError until L1 replaces this file, keeping each name
 * and signature.
 *
 * - Ed25519 through node:crypto on every OS. Public keys travel as their 32
 *   raw bytes in base64url (a JWK's `x`); private keys stay as PKCS8 PEM.
 * - The hub's key: paths.hubKeyFile (0600, in paths.fleetDir 0700), made by
 *   the first `jantar fleet on`. Only its public half leaves the Mac.
 * - A node's file: paths.nodeFile (0600, in paths.nodeDir 0700; on Windows
 *   the modes are no-ops and the profile's ACL protects it).
 * - The texts signed are protocol (`pairSigText`, `linkSigText` in
 *   @jantar/protocol/node-link): never rebuilt here. Nothing is ever logged.
 */
import type { KeyObject } from 'node:crypto';
import type { NodeFile, Paths } from '../contracts.js';
import { NotImplementedError } from '../core/not-implemented.js';

const L1 = 'The Fleet link (keys)';

/** A key pair: the public key as base64url raw bytes, the private one as a KeyObject. */
export interface LinkKeyPair {
  publicKey: string;
  privateKey: KeyObject;
}

/** A new Ed25519 key pair (a node at join; the hub at the first `fleet on`). */
export function generateKeyPair(): LinkKeyPair {
  throw new NotImplementedError(L1);
}

/** The hub's key pair, made once (PKCS8, 0600 in a 0700 dir) when the file is missing. */
export async function loadOrCreateHubKey(_paths: Pick<Paths, 'fleetDir' | 'hubKeyFile'>): Promise<LinkKeyPair> {
  throw new NotImplementedError(L1);
}

/** The hub's signature over pairSigText(nodeId, publicKey) (base64url, 64 bytes). */
export function signPair(_key: KeyObject, _nodeId: string, _publicKey: string): string {
  throw new NotImplementedError(L1);
}

/** Whether `sig` is the pinned hub key's signature over pairSigText(nodeId, publicKey). */
export function verifyPair(_hubKey: string, _nodeId: string, _publicKey: string, _sig: string): boolean {
  throw new NotImplementedError(L1);
}

/** One side's handshake signature over linkSigText(side, nodeId, hubNonce, nodeNonce). */
export function signLink(_key: KeyObject, _side: 'node' | 'hub', _nodeId: string, _hubNonce: string, _nodeNonce: string): string {
  throw new NotImplementedError(L1);
}

/** Whether `sig` is `publicKey`'s signature over linkSigText(side, nodeId, hubNonce, nodeNonce). Constant-time where it gates. */
export function verifyLink(_publicKey: string, _side: 'node' | 'hub', _nodeId: string, _hubNonce: string, _nodeNonce: string, _sig: string): boolean {
  throw new NotImplementedError(L1);
}

/** node.json, checked; null when it is missing or not a node file. */
export async function readNodeFile(_file: string): Promise<NodeFile | null> {
  throw new NotImplementedError(L1);
}

/** Write node.json atomically (0600 in a 0700 dir). */
export async function writeNodeFile(_paths: Pick<Paths, 'nodeDir' | 'nodeFile'>, _data: NodeFile): Promise<void> {
  throw new NotImplementedError(L1);
}
