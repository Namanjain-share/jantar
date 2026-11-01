/**
 * v0.6 Fleet: the link's keys.
 *
 * - Ed25519 through node:crypto on every OS. Public keys travel as their 32
 *   raw bytes in base64url (a JWK's `x`); private keys stay as PKCS8 PEM.
 * - The hub's key: paths.hubKeyFile (0600, in paths.fleetDir 0700), made by
 *   the first `jantar fleet on`. Only its public half leaves the Mac.
 * - A node's file: paths.nodeFile (0600, in paths.nodeDir 0700; on Windows
 *   the modes are no-ops and the profile's ACL protects it).
 * - The texts signed are protocol (`pairSigText`, `linkSigText` in
 *   @jantar/protocol/node-link): never rebuilt here. Nothing is ever logged.
 * - A malformed key or signature is a `false`, never a throw: whatever a
 *   peer sends goes through here.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { NodeIdSchema, NodeNameSchema } from '@jantar/protocol';
import { hubOrigin, linkSigText, pairSigText } from '@jantar/protocol/node-link';
import type { NodeFile, Paths } from '../contracts.js';
import { writeFileAtomic } from '../config.js';

/** A key pair: the public key as base64url raw bytes, the private one as a KeyObject. */
export interface LinkKeyPair {
  publicKey: string;
  privateKey: KeyObject;
}

const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

/** The public half as 32 raw bytes, base64url. */
function rawPublic(key: KeyObject): string {
  const x = (key.export({ format: 'jwk' }) as { x?: unknown }).x;
  if (typeof x !== 'string') throw new Error('not an Ed25519 key');
  return x;
}

/** A base64url raw public key as a KeyObject, or null when it is not one. */
function publicKeyOf(raw: string): KeyObject | null {
  if (!PUBLIC_KEY_RE.test(raw) || Buffer.from(raw, 'base64url').length !== 32) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

/** A PKCS8 PEM as an Ed25519 private key, or null. */
export function privateKeyOf(pem: string): KeyObject | null {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function signText(key: KeyObject, text: string): string {
  return sign(null, Buffer.from(text, 'utf8'), key).toString('base64url');
}

function verifyText(publicKey: string, text: string, sig: string): boolean {
  const key = publicKeyOf(publicKey);
  if (!key || !SIG_RE.test(sig)) return false;
  const bytes = Buffer.from(sig, 'base64url');
  if (bytes.length !== 64) return false;
  try {
    return verify(null, Buffer.from(text, 'utf8'), key, bytes);
  } catch {
    return false;
  }
}

/** A new Ed25519 key pair (a node at join; the hub at the first `fleet on`). */
export function generateKeyPair(): LinkKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: rawPublic(publicKey), privateKey };
}

/** The PEM of a private key (what node.json and hub-key.pem hold). */
export function privateKeyPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** The base64url raw public key of a private key. */
export function publicKeyFor(key: KeyObject): string {
  return rawPublic(createPublicKey(key));
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch (e) {
    if (process.platform !== 'win32') throw e;
  }
}

/**
 * The hub's key pair, made once (PKCS8, 0600 in a 0700 dir) when the file is
 * missing. A file that is there but is not an Ed25519 key is an error, never
 * replaced: a new key would orphan every pairing (docs/fleet.md says how to
 * replace it on purpose).
 */
export async function loadOrCreateHubKey(paths: Pick<Paths, 'fleetDir' | 'hubKeyFile'>): Promise<LinkKeyPair> {
  let pem: string | null = null;
  try {
    pem = await readFile(paths.hubKeyFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (pem !== null) {
    const key = privateKeyOf(pem);
    if (!key) throw new Error("the hub's key file is not an Ed25519 key: move it aside to make a new one (every server then joins again)");
    return { publicKey: publicKeyFor(key), privateKey: key };
  }
  await ensurePrivateDir(paths.fleetDir);
  const pair = generateKeyPair();
  await writeFileAtomic(paths.hubKeyFile, privateKeyPem(pair.privateKey), { mode: 0o600 });
  return pair;
}

/** The hub's signature over pairSigText(nodeId, publicKey) (base64url, 64 bytes). */
export function signPair(key: KeyObject, nodeId: string, publicKey: string): string {
  return signText(key, pairSigText(nodeId, publicKey));
}

/** Whether `sig` is the pinned hub key's signature over pairSigText(nodeId, publicKey). */
export function verifyPair(hubKey: string, nodeId: string, publicKey: string, sig: string): boolean {
  return verifyText(hubKey, pairSigText(nodeId, publicKey), sig);
}

/** One side's handshake signature over linkSigText(side, nodeId, hubNonce, nodeNonce). */
export function signLink(key: KeyObject, side: 'node' | 'hub', nodeId: string, hubNonce: string, nodeNonce: string): string {
  return signText(key, linkSigText(side, nodeId, hubNonce, nodeNonce));
}

/**
 * Whether `sig` is `publicKey`'s signature over linkSigText(side, nodeId,
 * hubNonce, nodeNonce). Ed25519 verification compares nothing secret: the
 * gate is the signature itself.
 */
export function verifyLink(publicKey: string, side: 'node' | 'hub', nodeId: string, hubNonce: string, nodeNonce: string, sig: string): boolean {
  return verifyText(publicKey, linkSigText(side, nodeId, hubNonce, nodeNonce), sig);
}

/** node.json as it must be; extra keys from a newer CLI are dropped, not refused. */
const NodeFileSchema = z.object({
  v: z.literal(1),
  url: z
    .string()
    .max(2048)
    .refine((u) => hubOrigin(u) === u, { message: 'not a hub origin' }),
  nodeId: NodeIdSchema,
  name: NodeNameSchema,
  hubKey: z.string().refine((k) => publicKeyOf(k) !== null, { message: 'not a public key' }),
  privateKey: z
    .string()
    .max(4096)
    .refine((pem) => privateKeyOf(pem) !== null, { message: 'not an Ed25519 private key' }),
  cfAccess: z.object({ clientId: z.string().min(1).max(256), clientSecret: z.string().min(1).max(1024) }).nullable(),
});

/** node.json, checked; null when it is missing or not a node file. */
export async function readNodeFile(file: string): Promise<NodeFile | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = NodeFileSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Write node.json atomically (0600 in a 0700 dir). Throws on data that would not read back (a programming error). */
export async function writeNodeFile(paths: Pick<Paths, 'nodeDir' | 'nodeFile'>, data: NodeFile): Promise<void> {
  const parsed = NodeFileSchema.safeParse(data);
  if (!parsed.success) throw new Error('node.json would not read back: refusing to write it');
  await ensurePrivateDir(paths.nodeDir);
  await writeFileAtomic(paths.nodeFile, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600 });
}
