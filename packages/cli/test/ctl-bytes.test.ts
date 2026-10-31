/**
 * v0.5: `CtlClient.bytes(path)` takes a GET's answer as bytes over the
 * control socket (a meeting's screenshot for `jantar meetings export`); an
 * error still comes back as JSON, with its content-type, and a missing
 * socket is the usual "daemon is down".
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CtlUnavailableError, createCtlClient } from '../src/index.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

describe('CtlClient.bytes', () => {
  let dir: string;
  let socketPath: string;
  let server: Server;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jantar-ctl-bytes-'));
    socketPath = join(dir, 'ctl.sock');
    server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/meetings/m1/shots/s1') {
        res.setHeader('content-type', 'image/jpeg');
        res.end(JPEG);
      } else {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'no such screenshot' } }));
      }
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  it('answers the bytes as they came, with their type', async () => {
    const r = await createCtlClient(socketPath).bytes('/v1/meetings/m1/shots/s1');
    expect(r.status).toBe(200);
    expect(r.type).toBe('image/jpeg');
    expect(r.body.equals(JPEG)).toBe(true);
  });

  it('an error is JSON, with its status', async () => {
    const r = await createCtlClient(socketPath).bytes('/v1/meetings/m1/shots/nope');
    expect(r.status).toBe(404);
    expect(r.type).toBe('application/json');
    expect(JSON.parse(r.body.toString('utf8')).error.code).toBe('not_found');
  });

  it('a missing socket is the daemon being down', async () => {
    await expect(createCtlClient(join(dir, 'missing.sock')).bytes('/v1/meetings/m1/shots/s1')).rejects.toBeInstanceOf(CtlUnavailableError);
  });
});
