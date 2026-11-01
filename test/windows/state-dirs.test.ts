/**
 * W8 (v0.6 native Windows, preview): the state dirs and node.json are
 * written on Windows with no chmod failure (Windows has no file modes: the
 * profile's ACL protects them), and node.json reads back as written.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NODE_IDS } from '@jantar/fixtures';
import type { NodeFile } from '@jantar/daemon';
import { ensureStateDirs, resolvePaths } from '@jantar/daemon/config';
import { readNodeFile, writeNodeFile } from '@jantar/daemon/link/keys';
import { WINDOWS } from './helpers.js';

describe.skipIf(!WINDOWS)('W8: state dirs and node.json on Windows', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'jantar-w8-'));
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('every state dir is made, twice over, and node.json reads back', async () => {
    const paths = resolvePaths({ env: { HOME: root, USERPROFILE: root, JANTAR_HOME: join(root, '.jantar') } });
    await ensureStateDirs(paths);
    await ensureStateDirs(paths);
    for (const dir of [paths.home, paths.runDir, paths.logsDir, paths.pushDir, paths.binDir]) expect((await stat(dir)).isDirectory(), dir).toBe(true);

    const hub = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string;
    const own = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const file: NodeFile = {
      v: 1,
      url: 'https://jantar.example.com',
      nodeId: NODE_IDS.win1,
      name: 'win-1',
      hubKey: hub,
      privateKey: own,
      cfAccess: { clientId: 'synthetic.access', clientSecret: 'synthetic-secret' },
    };
    await writeNodeFile(paths, file);
    await writeNodeFile(paths, file);
    expect(await readNodeFile(paths.nodeFile)).toEqual(file);
  });
});
