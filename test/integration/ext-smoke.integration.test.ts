/**
 * X0 (v0.5 WP0): the real built extension reaches a real jantard.
 *
 * A harness daemon with Meetings on; a pairing code from extPairStart over
 * ctl.sock; then, from the extension's service worker in playwright-core's
 * Chromium (a fresh temp profile), the claim with `credentials: 'omit'`
 * returns a key. That proves three things at once: the claim's Origin is
 * the pinned `chrome-extension://<EXTENSION_ID>`, the worker's requests come
 * from loopback to a loopback Host, and `cross-origin-resource-policy:
 * same-origin` does not keep the worker from reading the reply. Its GET to
 * /v1/ext/info with the key then gets through the gate (to WP0's stub, 501,
 * until WP-MS builds it).
 * The same claim from a page script on a routed Meet URL fails, and the
 * code it tried still pairs afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTENSION_ID, EXTENSION_KEY_HEADER, type ExtPairStartReply } from '@jantar/protocol';
import { perfBudgetMs } from '@jantar/fixtures';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { extensionReady, launchExtension, type LoadedExtension } from './extension.js';
import { bootDaemon, type Daemon } from './harness.js';
import { eventually } from './http.js';

const ready = await extensionReady('ext-smoke');

describe.skipIf(!ready)('X0: the extension reaches jantard', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let ext: LoadedExtension;

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { meetings: { enabled: true } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    ext = await launchExtension();
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await ext?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  const startCode = async () => (await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start')).code;

  /** fetch from the extension's service worker, as its client will (credentials omitted). */
  const fromWorker = (req: { port: number; path: string; method: 'GET' | 'POST'; body?: unknown; key?: string; header: string }) =>
    ext.worker.evaluate(async (r) => {
      const headers: Record<string, string> = {};
      if (r.body !== undefined) headers['content-type'] = 'application/json';
      if (r.key) headers[r.header] = r.key;
      const res = await fetch(`http://127.0.0.1:${r.port}${r.path}`, {
        method: r.method,
        credentials: 'omit',
        headers,
        ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as unknown };
    }, req);

  it('the loaded extension has the published ID', () => {
    expect(ext.extensionId).toBe(EXTENSION_ID);
  });

  it("the worker's claim returns a key, and its GET with the key gets through the gate", async () => {
    const start = await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start');
    expect(start.port).toBe(d.port);
    const claim = await fromWorker({ port: d.port, path: '/v1/ext/pair', method: 'POST', body: { code: start.code }, header: EXTENSION_KEY_HEADER });
    expect(claim.status).toBe(200);
    const { key } = claim.body as { id: string; key: string };
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const info = await fromWorker({ port: d.port, path: '/v1/ext/info', method: 'GET', key, header: EXTENSION_KEY_HEADER });
    expect([401, 403, 429]).not.toContain(info.status);
    const none = await fromWorker({ port: d.port, path: '/v1/ext/info', method: 'GET', header: EXTENSION_KEY_HEADER });
    expect(none.status).toBe(401);
  });

  it('a page script on a Meet URL cannot claim, and the code still pairs afterwards', async () => {
    const code = await startCode();
    await ext.context.route('https://meet.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Meet</title><p>synthetic call</p>' }));
    const page = await ext.context.newPage();
    try {
      await page.goto('https://meet.google.com/abc-defg-hij');
      const fromPage = await page.evaluate(
        async ({ port, code }) => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/v1/ext/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
            return { status: res.status };
          } catch (e) {
            return { error: String(e) };
          }
        },
        { port: d.port, code },
      );
      expect('status' in fromPage ? fromPage.status : 0).not.toBe(200);
    } finally {
      await page.close();
    }
    const claim = await fromWorker({ port: d.port, path: '/v1/ext/pair', method: 'POST', body: { code }, header: EXTENSION_KEY_HEADER });
    expect(claim.status).toBe(200);
  });
});
