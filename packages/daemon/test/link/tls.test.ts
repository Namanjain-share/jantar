/**
 * v0.6 Fleet, TLS on the link (S11): servers check the hub's certificate
 * against Node's CA list plus NODE_EXTRA_CA_CERTS, and nothing loosens it. A
 * test CA and certificates for 127.0.0.1 are made per run with `openssl`
 * (no key is kept in the tree). A hub whose certificate chains to a CA the
 * node does not trust, and a self-signed one, each fail the claim and the
 * link with their own line; a node started with NODE_EXTRA_CA_CERTS naming
 * the test CA pairs and links over https and wss. That node runs as its own
 * Node process (tls-node.ts), since Node reads NODE_EXTRA_CA_CERTS only at
 * start.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { linuxNodeSnapshot } from '@jantar/fixtures';
import { decodeJoinToken } from '@jantar/protocol/node-link';
import type { NodeFile } from '../../src/contracts.js';
import { pairWithHub } from '../../src/link/join.js';
import { generateKeyPair, privateKeyPem, writeNodeFile } from '../../src/link/keys.js';
import { createDialer } from '../../src/node/dialer.js';
import { cleanup, onCleanup, startHub, tempHome, testCtx, type TestHub } from './harness.js';

afterEach(cleanup);

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = join(HERE, '..', '..');
const OPENSSL = spawnSync('openssl', ['version']).status === 0;

/** The test CA's config: a CA, a hub certificate it signs, a self-signed one; all for 127.0.0.1. */
const REQ_CNF = [
  '[req]',
  'distinguished_name = dn',
  'prompt = no',
  '[dn]',
  'CN = Jantar Test CA',
  '[v3_ca]',
  'basicConstraints = critical,CA:TRUE',
  'keyUsage = critical,keyCertSign,cRLSign',
  'subjectKeyIdentifier = hash',
  '[v3_hub]',
  'basicConstraints = CA:FALSE',
  'keyUsage = critical,digitalSignature,keyEncipherment',
  'extendedKeyUsage = serverAuth',
  'subjectAltName = IP:127.0.0.1',
  '',
].join('\n');

interface Certs {
  dir: string;
  ca: string;
  hub: { key: string; cert: string };
  self: { key: string; cert: string };
}

let certs: Certs;

async function makeCerts(): Promise<Certs> {
  const dir = await mkdtemp(join(tmpdir(), 'jantar-tls-'));
  const ssl = (args: string[]) => run('openssl', args, { cwd: dir });
  await writeFile(join(dir, 'req.cnf'), REQ_CNF);
  const key = ['-newkey', 'rsa:2048', '-nodes'];
  await ssl(['req', '-x509', ...key, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Jantar Test CA', '-config', 'req.cnf', '-extensions', 'v3_ca']);
  await ssl(['req', '-new', ...key, '-keyout', 'hub.key', '-out', 'hub.csr', '-subj', '/CN=127.0.0.1', '-config', 'req.cnf']);
  await ssl(['x509', '-req', '-in', 'hub.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '2', '-days', '2', '-out', 'hub.pem', '-extfile', 'req.cnf', '-extensions', 'v3_hub']);
  await ssl(['req', '-x509', ...key, '-keyout', 'self.key', '-out', 'self.pem', '-days', '2', '-subj', '/CN=127.0.0.1', '-config', 'req.cnf', '-extensions', 'v3_hub']);
  const read = (f: string) => readFile(join(dir, f), 'utf8');
  return {
    dir,
    ca: join(dir, 'ca.pem'),
    hub: { key: await read('hub.key'), cert: await read('hub.pem') },
    self: { key: await read('self.key'), cert: await read('self.pem') },
  };
}

beforeAll(async () => {
  if (OPENSSL) certs = await makeCerts();
}, 60_000);

afterAll(async () => {
  if (certs) await rm(certs.dir, { recursive: true, force: true });
});

/** A node.json pinning the hub's key from its join line, so the dialler can be tried against `hub` without a claim. */
async function untrustingNode(hub: TestHub) {
  const ctx = await testCtx();
  const d = decodeJoinToken(await hub.token());
  if (!d.ok) throw new Error(d.reason);
  const file: NodeFile = { v: 1, url: hub.url, nodeId: '01JN0DE0000000000000000001', name: 'build-1', hubKey: d.token.hubKey, privateKey: privateKeyPem(generateKeyPair().privateKey), cfAccess: null };
  await writeNodeFile(ctx.paths, file);
  const dialer = createDialer(ctx, ctx.paths.nodeFile, () => ({ os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false }));
  onCleanup(() => dialer.stop());
  return { ctx, dialer };
}

describe.skipIf(!OPENSSL)('TLS against Node\'s CA list plus NODE_EXTRA_CA_CERTS (S11)', () => {
  it('a hub whose certificate chains to a CA this node does not trust: the claim and the link each fail with their own line', async () => {
    const hub = await startHub({ tls: certs.hub });
    expect(hub.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    const r = await pairWithHub(await hub.token(), { os: 'linux', version: '0.6.0', cfAccess: null });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/^The hub's certificate is not trusted here \((UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN)\): servers check it against Node's CA list plus NODE_EXTRA_CA_CERTS\.$/);
    expect(hub.ctx.db.nodes.list()).toEqual([]);
    const { ctx, dialer } = await untrustingNode(hub);
    const links: unknown[] = [];
    dialer.start((l) => links.push(l));
    await vi.waitFor(() => expect(dialer.status().state).toBe('waiting'));
    expect(dialer.status().lastClose?.code).toBe(1006);
    const line = ctx.log.records.find((x) => /certificate is not trusted here/.test(x.msg));
    expect(line).toMatchObject({ level: 'warn', msg: "the hub's certificate is not trusted here (Node's CA list plus NODE_EXTRA_CA_CERTS)" });
    expect(JSON.stringify(line)).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN/);
    expect(links).toEqual([]);
    expect(hub.links).toEqual([]);
  });

  it('a self-signed hub certificate fails the same way', async () => {
    const hub = await startHub({ tls: certs.self });
    const r = await pairWithHub(await hub.token(), { os: 'linux', version: '0.6.0', cfAccess: null });
    expect(r.ok ? '' : r.reason).toMatch(/^The hub's certificate is not trusted here \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)\)/);
    const { dialer } = await untrustingNode(hub);
    dialer.start(() => {});
    await vi.waitFor(() => expect(dialer.status().state).toBe('waiting'));
    expect(hub.links).toEqual([]);
  });

  it('a node started with NODE_EXTRA_CA_CERTS naming the CA pairs over https and links over wss', async () => {
    const hub = await startHub({ tls: certs.hub });
    const { dir: home } = await tempHome();
    const child = spawn(process.execPath, ['--conditions=@jantar/source', '--import', 'tsx', join(HERE, 'tls-node.ts'), await hub.token('build-1'), home], {
      cwd: DAEMON_DIR,
      env: { PATH: process.env.PATH ?? '', HOME: home, NODE_EXTRA_CA_CERTS: certs.ca },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onCleanup(() => {
      child.kill('SIGKILL');
    });
    const lines: Record<string, unknown>[] = [];
    let err = '';
    let partial = '';
    child.stdout.on('data', (c: Buffer) => {
      partial += c.toString('utf8');
      const parts = partial.split('\n');
      partial = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) lines.push(JSON.parse(p) as Record<string, unknown>);
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    await vi.waitFor(() => expect(lines.map((l) => l.step), err).toContain('linked'), { timeout: 45_000, interval: 100 });
    expect(lines[0]).toEqual({ step: 'pair', ok: true, name: 'build-1' });
    expect(lines[1]).toMatchObject({ step: 'linked', status: { state: 'linked', name: 'build-1', hubHost: '127.0.0.1' } });
    await vi.waitFor(() => expect(hub.links[0]?.snapshots).toEqual([linuxNodeSnapshot()]));
    const reply = await hub.links[0]!.link.call({ id: 'c1', route: 'getScreen', params: { sid: 's1' }, query: {}, actor: { deviceId: 'dev1', deviceName: 'iPhone', scopes: ['read'] } });
    expect(reply).toEqual({ status: 200, body: { over: 'wss', route: 'getScreen' } });
  }, 60_000);
});
