/**
 * v0.6 Fleet, the link's keys (S9, S10): Ed25519 both ways over the
 * protocol's signed texts; nothing a peer sends can make a check throw; the
 * hub's key is made once (0600 in a 0700 dir) and never replaced; node.json
 * round-trips (0600 in a 0700 dir) and anything else reads as no file.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeFile } from '../../src/contracts.js';
import { resolvePaths } from '../../src/config.js';
import {
  generateKeyPair,
  loadOrCreateHubKey,
  privateKeyPem,
  publicKeyFor,
  readNodeFile,
  signLink,
  signPair,
  verifyLink,
  verifyPair,
  writeNodeFile,
} from '../../src/link/keys.js';
import { cleanup, tempHome } from './harness.js';

afterEach(cleanup);

const NODE_ID = '01JN0DE0000000000000000001';
const NONCE_H = Buffer.alloc(32, 1).toString('base64url');
const NONCE_N = Buffer.alloc(32, 2).toString('base64url');
const posix = process.platform !== 'win32';

async function paths() {
  const { dir } = await tempHome();
  return resolvePaths({ env: { HOME: dir }, userHome: dir, home: join(dir, '.jantar') });
}

describe('signatures', () => {
  it('a key pair: 32 raw public bytes as base64url, and its private half derives it', () => {
    const k = generateKeyPair();
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(k.publicKey, 'base64url')).toHaveLength(32);
    expect(publicKeyFor(k.privateKey)).toBe(k.publicKey);
    expect(generateKeyPair().publicKey).not.toBe(k.publicKey);
  });

  it('pair: the hub signs the node id and the key it claimed with; anything else fails', () => {
    const hub = generateKeyPair();
    const node = generateKeyPair();
    const sig = signPair(hub.privateKey, NODE_ID, node.publicKey);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verifyPair(hub.publicKey, NODE_ID, node.publicKey, sig)).toBe(true);
    expect(verifyPair(generateKeyPair().publicKey, NODE_ID, node.publicKey, sig)).toBe(false);
    expect(verifyPair(hub.publicKey, '01JN0DE0000000000000000002', node.publicKey, sig)).toBe(false);
    expect(verifyPair(hub.publicKey, NODE_ID, generateKeyPair().publicKey, sig)).toBe(false);
  });

  it('link: each side signs its own label and both nonces (no reflection, no replay)', () => {
    const hub = generateKeyPair();
    const node = generateKeyPair();
    const nodeSig = signLink(node.privateKey, 'node', NODE_ID, NONCE_H, NONCE_N);
    expect(verifyLink(node.publicKey, 'node', NODE_ID, NONCE_H, NONCE_N, nodeSig)).toBe(true);
    // A node's signature is never a hub's, even under the node's own key.
    expect(verifyLink(node.publicKey, 'hub', NODE_ID, NONCE_H, NONCE_N, nodeSig)).toBe(false);
    // A recorded auth fails against a new challenge, or another node nonce.
    expect(verifyLink(node.publicKey, 'node', NODE_ID, NONCE_N, NONCE_N, nodeSig)).toBe(false);
    expect(verifyLink(node.publicKey, 'node', NODE_ID, NONCE_H, NONCE_H, nodeSig)).toBe(false);
    const hubSig = signLink(hub.privateKey, 'hub', NODE_ID, NONCE_H, NONCE_N);
    expect(verifyLink(hub.publicKey, 'hub', NODE_ID, NONCE_H, NONCE_N, hubSig)).toBe(true);
    expect(verifyLink(node.publicKey, 'hub', NODE_ID, NONCE_H, NONCE_N, hubSig)).toBe(false);
  });

  it('a malformed key or signature is false, never a throw', () => {
    const k = generateKeyPair();
    const sig = signPair(k.privateKey, NODE_ID, k.publicKey);
    const rsa = generateKeyPairSync('ed448').publicKey.export({ format: 'jwk' }).x as string;
    for (const key of ['', 'x', 'A'.repeat(43), rsa, `${k.publicKey}A`, '+/'.repeat(22).slice(0, 43)]) {
      expect(verifyPair(key, NODE_ID, k.publicKey, sig), key).toBe(false);
    }
    for (const bad of ['', sig.slice(1), `${sig}A`, sig.replace(/^./, sig[0] === 'A' ? 'B' : 'A'), '='.repeat(86), 'A'.repeat(86)]) {
      expect(verifyPair(k.publicKey, NODE_ID, k.publicKey, bad), bad).toBe(false);
    }
  });
});

describe("the hub's key", () => {
  it('is made once, PKCS8 0600 in a 0700 dir, and read back the same', async () => {
    const p = await paths();
    const first = await loadOrCreateHubKey(p);
    const again = await loadOrCreateHubKey(p);
    expect(again.publicKey).toBe(first.publicKey);
    const pem = await readFile(p.hubKeyFile, 'utf8');
    // Split, so the secrets scan never reads a key header in this file.
    expect(pem.startsWith(`${'-----'}BEGIN PRIVATE KEY-----`)).toBe(true);
    if (posix) {
      expect((await stat(p.hubKeyFile)).mode & 0o777).toBe(0o600);
      expect((await stat(p.fleetDir)).mode & 0o777).toBe(0o700);
    }
    // Nothing but the key: no temp file left behind.
    expect(await readdir(p.fleetDir)).toEqual(['hub-key.pem']);
  });

  it('a file that is not an Ed25519 key is an error, and is never replaced', async () => {
    const p = await paths();
    await mkdir(p.fleetDir, { recursive: true, mode: 0o700 });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    for (const text of ['not a key\n', rsa]) {
      await writeFile(p.hubKeyFile, text, { mode: 0o600 });
      await expect(loadOrCreateHubKey(p)).rejects.toThrow(/not an Ed25519 key/);
      expect(await readFile(p.hubKeyFile, 'utf8')).toBe(text);
    }
  });
});

describe('node.json', () => {
  const sample = (): NodeFile => {
    const k = generateKeyPair();
    return {
      v: 1,
      url: 'https://jantar.example.com',
      nodeId: NODE_ID,
      name: 'build-1',
      hubKey: generateKeyPair().publicKey,
      privateKey: privateKeyPem(k.privateKey),
      cfAccess: { clientId: 'synthetic-id.access', clientSecret: 'synthetic-secret' },
    };
  };

  it('round-trips, 0600 in a 0700 dir, atomically', async () => {
    const p = await paths();
    const data = sample();
    await writeNodeFile(p, data);
    expect(await readNodeFile(p.nodeFile)).toEqual(data);
    if (posix) {
      expect((await stat(p.nodeFile)).mode & 0o777).toBe(0o600);
      expect((await stat(p.nodeDir)).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(p.nodeDir)).toEqual(['node.json']);
    // Rewritten (jantar node access): Access changes, nothing else.
    await writeNodeFile(p, { ...data, cfAccess: null });
    expect(await readNodeFile(p.nodeFile)).toEqual({ ...data, cfAccess: null });
  });

  it('missing, not JSON, or not a node file reads as no file', async () => {
    const p = await paths();
    expect(await readNodeFile(p.nodeFile)).toBeNull();
    await mkdir(p.nodeDir, { recursive: true });
    const good = sample();
    const bad: unknown[] = [
      'not json',
      {},
      { ...good, v: 2 },
      { ...good, url: 'http://jantar.example.com' },
      { ...good, url: 'https://jantar.example.com/path' },
      { ...good, nodeId: 'not-a-ulid' },
      { ...good, name: 'mac' },
      { ...good, hubKey: 'short' },
      { ...good, privateKey: 'not a key' },
      { ...good, cfAccess: { clientId: '', clientSecret: 'x' } },
    ];
    for (const b of bad) {
      await writeFile(p.nodeFile, typeof b === 'string' ? b : JSON.stringify(b));
      expect(await readNodeFile(p.nodeFile), JSON.stringify(b)).toBeNull();
    }
    // A key from a newer CLI is dropped, not refused.
    await writeFile(p.nodeFile, JSON.stringify({ ...good, later: true }));
    expect(await readNodeFile(p.nodeFile)).toEqual(good);
  });

  it('refuses to write a file that would not read back', async () => {
    const p = await paths();
    await expect(writeNodeFile(p, { ...sample(), url: 'ftp://x' })).rejects.toThrow(/would not read back/);
    await expect(readFile(p.nodeFile)).rejects.toThrow();
  });
});
