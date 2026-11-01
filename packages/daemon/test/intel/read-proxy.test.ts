/**
 * G6: the CONNECT proxy (spec 13.2). Only `CONNECT <name>:443`, vetted by
 * the guard (a name inside a network, an IP literal, another port and a
 * plain GET with an absolute URI are refused), tunnels to the vetted
 * address (dialed at a local echo server through the test seam), counts
 * bytes against the job's cap, and `close()` ends every tunnel.
 */
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Guard } from '../../src/intel/read/guard.js';
import { ConnectProxy, connectTarget } from '../../src/intel/read/proxy.js';
import { fakeLookup, PUBLIC_ADDR } from './read-helpers.js';

const NONE: ReadonlySet<string> = new Set();
let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** A TCP echo server standing in for the public host. */
async function echo(): Promise<{ port: number; server: Server }> {
  const server = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port: (server.address() as AddressInfo).port, server };
}

async function proxyFor(echoPort: number, opts: { maxBytes?: number; dialed?: string[]; addrs?: Record<string, string[]> } = {}): Promise<ConnectProxy> {
  const net = {
    lookup: fakeLookup(opts.addrs ?? {}),
    dial: (address: string, port: number) => {
      opts.dialed?.push(`${address}:${port}`);
      return { address: '127.0.0.1', port: echoPort };
    },
  };
  const guard = new Guard({ own: () => NONE, net });
  const p = await ConnectProxy.start({ vet: (h) => guard.vet(h), maxBytes: opts.maxBytes ?? 1_000_000, net });
  cleanups.push(() => p.close());
  return p;
}

/** Send raw bytes to the proxy; resolve with what came back before `until` matched (or the socket closed). */
function talk(port: number, request: string, until: RegExp = /\r\n\r\n/): Promise<{ text: string; socket: Socket }> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    socket.on('data', (c) => {
      text += c.toString('latin1');
      if (until.test(text)) resolve({ text, socket });
    });
    socket.on('close', () => resolve({ text, socket }));
    socket.on('error', () => resolve({ text, socket }));
    socket.write(request);
  });
}

describe('G6: the CONNECT proxy', () => {
  it('connectTarget takes a name and port 443 only', () => {
    expect(connectTarget('www.example.test:443')).toBe('www.example.test');
    for (const t of ['www.example.test:80', 'www.example.test:8443', '127.0.0.1:443', '[::1]:443', 'www.example.test', '', undefined]) expect(connectTarget(t), String(t)).toBeNull();
  });

  it('tunnels CONNECT <name>:443 to the vetted address, and counts the bytes', async () => {
    const e = await echo();
    const dialed: string[] = [];
    const p = await proxyFor(e.port, { dialed });
    const { text, socket } = await talk(p.port, 'CONNECT www.example.test:443 HTTP/1.1\r\nHost: www.example.test:443\r\n\r\n');
    expect(text).toMatch(/^HTTP\/1\.1 200/);
    expect(dialed).toEqual([`${PUBLIC_ADDR}:443`]);
    const back = await new Promise<string>((resolve) => {
      socket.once('data', (c) => resolve(c.toString()));
      socket.write('ping through the tunnel');
    });
    expect(back).toBe('ping through the tunnel');
    expect(p.bytes).toBeGreaterThanOrEqual(2 * 'ping through the tunnel'.length);
    socket.destroy();
  });

  it('refuses a plain GET with an absolute URI, another port, an IP literal, an internal name, and a name that resolves inside', async () => {
    const e = await echo();
    const dialed: string[] = [];
    const p = await proxyFor(e.port, { dialed, addrs: { 'inside.example.test': ['10.0.0.5'] } });
    const get = await talk(p.port, 'GET http://www.example.test/ HTTP/1.1\r\nHost: www.example.test\r\n\r\n');
    expect(get.text).toMatch(/^HTTP\/1\.1 403/);
    for (const target of ['www.example.test:80', '127.0.0.1:443', '169.254.169.254:443', 'printer.local:443', 'svc.internal:443', 'inside.example.test:443']) {
      const r = await talk(p.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      expect(r.text, target).toMatch(/^HTTP\/1\.1 403/);
    }
    expect(dialed).toEqual([]);
    expect(p.refused).toBeGreaterThanOrEqual(7);
  });

  it('closes a tunnel past the byte cap, and every tunnel at close()', async () => {
    const e = await echo();
    const p = await proxyFor(e.port, { maxBytes: 100 });
    const { socket } = await talk(p.port, 'CONNECT www.example.test:443 HTTP/1.1\r\n\r\n');
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    socket.write('x'.repeat(200));
    await closed;
    // Over the cap: no new tunnel.
    const again = await talk(p.port, 'CONNECT www.example.test:443 HTTP/1.1\r\n\r\n');
    expect(again.text).toMatch(/^HTTP\/1\.1 403/);

    const p2 = await proxyFor(e.port);
    const open = await talk(p2.port, 'CONNECT www.example.test:443 HTTP/1.1\r\n\r\n');
    const ended = new Promise<void>((r) => open.socket.on('close', () => r()));
    await p2.close();
    await ended;
    expect(open.socket.destroyed).toBe(true);
  });
});
