/// <reference lib="dom" />
/**
 * v0.8 G10, end to end: Read saved links in a real browser. The extension's
 * test build (built here into a temp folder: the six post sites and
 * `<all_urls>` granted at install) in playwright-core's own Chromium with a
 * fresh temp profile, synthetic signed-in post pages served at the real
 * platform URLs by `context.route` (@jantar/fixtures POST_PAGES), and a
 * small stand-in for the daemon's extension routes on an ephemeral
 * loopback port (pairing, info, `GET /v1/ext/reads/next` handing out the
 * jobs this test queues, `POST /v1/ext/reads/:id` recording each result).
 * The daemon's own side of the reads is v08-intel-read's.
 *
 * 1. Pairing through the popup, then Settings › Read saved links on: the
 *    worker asks for a post at once.
 * 2. An Instagram reel: read in a tab of the extension's own (opened at
 *    about:blank, in the background), the post's caption and author, never
 *    the signed-in user's name planted in the nav, the account menu and the
 *    comment box; the tab is closed after.
 * 3. A post whose page redirects to another host: the tab is closed at once
 *    and the result says `redirected`; one that redirects to the platform's
 *    sign-in page says `login`; X's own redirect from /i/status/ to the
 *    handle's status page is followed and read.
 * 4. A job off the post shapes (a link shim) is `blocked` and opens nothing.
 * 5. Off again: the worker stops asking.
 *
 * Needs the full Chromium for playwright-core; skipped with a warning
 * without it (extension.ts).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { POST_PAGES, SIGNED_IN_MARKER, perfBudgetMs } from '@jantar/fixtures';
import { EXTENSION_ID, EXTENSION_KEY_HEADER } from '@jantar/protocol';
import { buildExtension } from '../../packages/extension/scripts/build.mjs';
import { extensionReady, launchExtension, openPopup, tabIdOf, type LoadedExtension } from './extension.js';
import { eventually } from './http.js';

// The suite builds its own copy, so it needs Chromium only (extensionReady also wants a dist-test to exist).
const ready = await extensionReady('ext-v08-reads');

const CODE = 'C0DEc0de_C0DE-c0deC0de';
const KEY = 'SYNTHkey_0123456789-abcdefghijklmnopqrstuvw';
const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

const REEL = POST_PAGES.instagram.url;
const REDIRECTED = 'https://www.instagram.com/p/Redirect12/';
const LOGIN_WALL = 'https://x.com/i/status/1850000000000000009';
const X_SHORT = 'https://x.com/i/status/1850000000000000001';
const X_FULL = POST_PAGES.x.url;
const SHIM = 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2F';

interface Job {
  id: string;
  url: string;
  platform: string;
  frames: number;
}
interface Result {
  id: string;
  origin: string | undefined;
  body: { ok: boolean; why?: string; page?: { text: string; author?: string; finalUrl: string; frames: unknown[] } };
}

/** The daemon's extension routes, as far as the extension uses them, with its key and Origin checks. */
function standIn() {
  const jobs: Job[] = [];
  const results: Result[] = [];
  let polls = 0;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const bodyOf = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      const body = await bodyOf(req);
      if (req.method === 'POST' && path === '/v1/ext/pair') {
        if (req.headers.origin !== EXT_ORIGIN || (body as { code?: string } | undefined)?.code !== CODE) return send(res, 400, { error: { code: 'invalid_request', message: 'bad claim' } });
        return send(res, 200, { id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR', key: KEY });
      }
      if (req.headers[EXTENSION_KEY_HEADER] !== KEY) return send(res, 401, { error: { code: 'unauthorized', message: 'not paired' } });
      if (req.method === 'GET' && path === '/v1/ext/info') return send(res, 200, { projects: null });
      if (req.method === 'GET' && path === '/v1/ext/reads/next') {
        polls += 1;
        return send(res, 200, { job: jobs.shift() ?? null });
      }
      const m = /^\/v1\/ext\/reads\/([A-Za-z0-9_-]{8,64})$/.exec(path);
      if (req.method === 'POST' && m?.[1]) {
        results.push({ id: m[1], origin: req.headers.origin, body: body as Result['body'] });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: { code: 'not_found', message: 'not found' } });
    })();
  });
  return {
    server,
    jobs,
    results,
    polls: () => polls,
    async listen(): Promise<number> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Requests the browser made, by URL (every one is answered here: nothing reaches the network). */
const seen: string[] = [];

async function servePosts(context: BrowserContext): Promise<void> {
  const page = (html: string) => ({ status: 200, contentType: 'text/html', body: html });
  await context.route(/^https:\/\/(www\.instagram\.com|x\.com|l\.instagram\.com|evil\.example|example\.com)\//, (route) => {
    const url = route.request().url();
    seen.push(url);
    if (url === REEL) return route.fulfill(page(POST_PAGES.instagram.html));
    if (url === REDIRECTED) return route.fulfill({ status: 302, headers: { location: 'https://evil.example/landing' }, body: '' });
    if (url === LOGIN_WALL) return route.fulfill({ status: 302, headers: { location: 'https://x.com/i/flow/login?redirect_after_login=%2Fi%2Fstatus' }, body: '' });
    if (url === X_SHORT) return route.fulfill({ status: 302, headers: { location: X_FULL }, body: '' });
    if (url === X_FULL) return route.fulfill(page(POST_PAGES.x.html));
    if (url.startsWith('https://x.com/i/flow/login')) return route.fulfill(page(`<!doctype html><title>Log in to X</title><main><input type="password"><p>${SIGNED_IN_MARKER}</p></main>`));
    if (url.startsWith('https://evil.example/')) return route.fulfill(page(`<!doctype html><title>Elsewhere</title><p>${SIGNED_IN_MARKER}</p>`));
    return route.fulfill(page('<!doctype html><title>Example</title><p>Another site</p>'));
  });
}

describe.skipIf(!ready)('G10: Read saved links in a real browser', () => {
  let ext: LoadedExtension;
  let stand: ReturnType<typeof standIn>;
  let port: number;
  let buildDir: string;
  let anchor: Page;

  beforeAll(async () => {
    buildDir = await mkdtemp(join(tmpdir(), 'jantar-ext-v08-'));
    const dir = await buildExtension({ outDir: join(buildDir, 'dist-test'), test: true });
    stand = standIn();
    port = await stand.listen();
    ext = await launchExtension({ dir });
    await servePosts(ext.context);
    anchor = await ext.context.newPage();
    await anchor.goto('https://example.com/start', { waitUntil: 'load' });
  }, perfBudgetMs(90_000));

  afterAll(async () => {
    await ext?.close();
    await stand?.close();
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  }, perfBudgetMs(30_000));

  const popupFor = async () => openPopup(ext, await tabIdOf(ext, anchor.url()), anchor);
  const postTabs = () => ext.context.pages().filter((p) => /instagram\.com|x\.com|evil\.example/.test(p.url()));
  const resultFor = (id: string) => eventually(async () => stand.results.find((r) => r.id === id), 60_000, `the result of ${id}`);

  it('pairs through the popup, and Read saved links on makes the worker ask at once', async () => {
    const popup = await popupFor();
    await popup.locator('#code').fill(`jantar-ext:${port}:${CODE}`);
    await popup.getByRole('button', { name: 'Pair' }).click();
    await popup.getByRole('button', { name: 'Settings' }).waitFor({ timeout: perfBudgetMs(10_000) });
    await popup.getByRole('button', { name: 'Settings' }).click();
    const toggle = popup.locator('#reads');
    expect(await toggle.isChecked()).toBe(false);
    stand.jobs.push(
      { id: 'lease_reel00001', url: REEL, platform: 'instagram', frames: 2 },
      { id: 'lease_redir0002', url: REDIRECTED, platform: 'instagram', frames: 0 },
      { id: 'lease_login0003', url: LOGIN_WALL, platform: 'x', frames: 0 },
      { id: 'lease_xpost0004', url: X_SHORT, platform: 'x', frames: 0 },
      { id: 'lease_shim00005', url: SHIM, platform: 'instagram', frames: 0 },
    );
    await toggle.check();
    await eventually(async () => stand.polls() > 0, 15_000, 'a poll after the switch');
    await eventually(async () => (await toggle.isChecked()) === true, 10_000, 'the switch shown on');
    await popup.close();
  });

  it("reads the reel in a background tab of its own: the post's caption and author, never the signed-in user; the tab closed", async () => {
    const r = await resultFor('lease_reel00001');
    expect(r.origin).toBe(EXT_ORIGIN);
    expect(r.body.ok).toBe(true);
    expect(r.body.page?.finalUrl).toBe(REEL);
    expect(r.body.page?.text).toContain(POST_PAGES.instagram.caption);
    expect(r.body.page?.author).toBe('example_cook');
    expect(JSON.stringify(r.body)).not.toContain(SIGNED_IN_MARKER);
    // The blob video never loads in this page: no frames, and no error for it.
    expect(r.body.page?.frames).toEqual([]);
  });

  it('a redirect to another host closes the tab at once: redirected; to the sign-in page: login', async () => {
    expect((await resultFor('lease_redir0002')).body).toEqual({ ok: false, why: 'redirected' });
    expect((await resultFor('lease_login0003')).body).toEqual({ ok: false, why: 'login' });
    for (const r of stand.results) expect(JSON.stringify(r.body)).not.toContain(SIGNED_IN_MARKER);
  });

  it("X's own redirect to the handle's status page is followed and read", async () => {
    const r = await resultFor('lease_xpost0004');
    expect(r.body.ok).toBe(true);
    expect(r.body.page?.finalUrl).toBe(X_FULL);
    expect(r.body.page?.text).toContain(POST_PAGES.x.caption);
    expect(r.body.page?.text).not.toContain('A reply above the post');
  });

  it('a job off the post shapes is blocked and opens nothing; every read tab is closed', async () => {
    expect((await resultFor('lease_shim00005')).body).toEqual({ ok: false, why: 'blocked' });
    expect(seen.some((u) => u.startsWith('https://l.instagram.com/'))).toBe(false);
    await eventually(async () => postTabs().length === 0, 10_000, 'every read tab closed');
  });

  it('off: the worker stops asking', async () => {
    const popup = await popupFor();
    await popup.getByRole('button', { name: 'Settings' }).click();
    const toggle = popup.locator('#reads');
    await eventually(async () => (await toggle.isChecked()) === true, 10_000, 'the switch shown on');
    await toggle.uncheck();
    await eventually(async () => (await toggle.isChecked()) === false, 10_000, 'the switch shown off');
    const alarm = await ext.worker.evaluate(async () => (await (globalThis as unknown as { chrome: { alarms: { get(n: string): Promise<unknown> } } }).chrome.alarms.get('jantar-reads')) ?? null);
    expect(alarm).toBeNull();
    await popup.close();
  });
});
