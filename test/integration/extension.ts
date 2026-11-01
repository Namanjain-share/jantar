/**
 * The Chrome extension in a real browser, for the end-to-end suites
 * (ext-smoke, and wave 2's ext-v05): playwright-core's own Chromium (Chrome
 * for Testing, `channel: 'chromium'`), launched with a fresh temp profile and
 * only the built extension loaded. Never the user's Chrome or its profile:
 * branded Chrome ignores --load-extension anyway.
 *
 * v0.5 wave 2 adds what ext-v05 drives the extension with: the tab id the
 * worker knows a page by, the popup opened for a tab, and the camera
 * button's closed shadow root read and clicked as a person would.
 *
 * v0.5.3 adds the toolbar icon itself (ext-v053): Chromium runs with
 * `--enable-unsafe-extension-debugging`, so the browser's DevTools session
 * has the Extensions domain, and `Extensions.triggerAction` on a tab target
 * is Chrome's own toolbar click (it grants activeTab and opens the action
 * popup). That popup is no Playwright Page: it is reached as a target of
 * its own, and clicked through Input on that target (a trusted click).
 *
 * Needs `pnpm -r build` (packages/extension/dist-test, or dist) and the full
 * Chromium for playwright-core (the headless shell loads no extension):
 * `pnpm exec playwright-core install chromium`. Without them the suites are
 * skipped with a warning, and fail on CI only when JANTAR_EXT_E2E=1.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { perfBudgetMs } from '@jantar/fixtures';
import { chromium, type BrowserContext, type CDPSession, type Page, type Worker } from 'playwright-core';

/** The extension as you load it (optional <all_urls>), and the test build (granted at install). */
export const EXT_DIST = fileURLToPath(new URL('../../packages/extension/dist', import.meta.url));
export const EXT_DIST_TEST = fileURLToPath(new URL('../../packages/extension/dist-test', import.meta.url));

/** True when the suite can run; otherwise says why (and throws on CI with JANTAR_EXT_E2E=1). */
export async function extensionReady(suite: string, build: 'test' | 'dist' = 'test'): Promise<boolean> {
  const dir = build === 'test' ? EXT_DIST_TEST : EXT_DIST;
  const hasBuild = existsSync(join(dir, 'manifest.json'));
  let hasChromium = false;
  try {
    hasChromium = existsSync(chromium.executablePath());
  } catch {
    hasChromium = false;
  }
  if (hasBuild && hasChromium) return true;
  const why = [hasBuild ? '' : `${build === 'test' ? 'dist-test' : 'dist'} of packages/extension is missing (run pnpm -r build)`, hasChromium ? '' : 'no full Chromium for playwright-core'].filter(Boolean).join('; ');
  if (process.env.CI && process.env.JANTAR_EXT_E2E === '1') throw new Error(`extension checks cannot run: ${why}`);
  console.warn(`[${suite}] skipped: ${why}`);
  return false;
}

export interface LoadedExtension {
  context: BrowserContext;
  /** The extension's service worker. */
  worker: Worker;
  /** From the worker's URL: chrome-extension://<id>/background.js. */
  extensionId: string;
  close(): Promise<void>;
}

/** Launch Chromium headless with a fresh temp profile and only the extension (dist-test by default) loaded. */
export async function launchExtension(opts: { build?: 'test' | 'dist' } = {}): Promise<LoadedExtension> {
  const dir = opts.build === 'dist' ? EXT_DIST : EXT_DIST_TEST;
  const profile = await mkdtemp(join(tmpdir(), 'jantar-ext-profile-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      // The last one opens the Extensions domain to the browser's DevTools session (the toolbar icon, ext-v053).
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--enable-unsafe-extension-debugging'],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    const extensionId = new URL(worker.url()).host;
    const ctx = context;
    return {
      context: ctx,
      worker,
      extensionId,
      async close() {
        await ctx.close().catch(() => undefined);
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// v0.5 wave 2: driving the loaded extension (ext-v05)

/** The few chrome.* calls the suites make inside the extension's own pages (no @types/chrome here). */
interface ChromeTab {
  id?: number;
  windowId: number;
  url?: string;
  active: boolean;
}
export interface ChromeLike {
  tabs: {
    query(q: Record<string, unknown>): Promise<ChromeTab[]>;
    create(p: { windowId?: number; url: string; active?: boolean }): Promise<ChromeTab>;
    update(id: number, p: { active?: boolean }): Promise<ChromeTab>;
    remove(id: number): Promise<void>;
  };
  windows: { create(p: { url: string; type: 'popup' | 'normal'; focused?: boolean }): Promise<unknown>; update(id: number, p: { focused: boolean }): Promise<unknown> };
  runtime: { getURL(path: string): string; sendMessage(msg: unknown): Promise<unknown> };
  permissions: { contains(p: { origins: string[] }): Promise<boolean> };
}

/** The tab Chrome shows the worker for `url` (the test build sees every URL; `dist/` only those it was granted). */
export async function tabIdOf(ext: LoadedExtension, url: string): Promise<number> {
  const id = await ext.worker.evaluate(async (u) => {
    const tabs = await (globalThis as unknown as { chrome: ChromeLike }).chrome.tabs.query({});
    return tabs.find((t) => t.url === u)?.id ?? null;
  }, url);
  if (id === null) throw new Error(`no tab at ${url}`);
  return id;
}

/**
 * The popup for `tabId` (spec 8.5): opened by the worker in a window of its
 * own (`popup.html?tab=<id>`), then the meeting page is brought to the front,
 * so the meeting tab stays the active tab of its own window as it would be
 * under a real toolbar popup. Opening it this way grants no activeTab.
 */
export async function openPopup(ext: LoadedExtension, tabId: number, front?: Page): Promise<Page> {
  const opened = ext.context.waitForEvent('page', { predicate: (p) => p.url().includes('/popup.html'), timeout: perfBudgetMs(10_000) });
  await ext.worker.evaluate(async (id) => {
    const c = (globalThis as unknown as { chrome: ChromeLike }).chrome;
    await c.windows.create({ url: c.runtime.getURL(`popup.html?tab=${id}`), type: 'popup' });
  }, tabId);
  const popup = await opened;
  await popup.waitForLoadState('domcontentloaded');
  await front?.bringToFront();
  return popup;
}

/** What the camera button's closed shadow root shows, read through the DevTools protocol (page scripts cannot reach it). */
export interface CameraView {
  /** The host element is on the page. */
  onPage: boolean;
  /** The camera button shows. */
  button: boolean;
  /** The notes-on dot. */
  dot: boolean;
  /** The host is hidden for a shot. */
  hidden: boolean;
  /** The bubble's words while it shows, else null. */
  bubble: string | null;
}

interface DomNode {
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

const attrsOf = (n: DomNode): Map<string, string> => {
  const m = new Map<string, string>();
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) m.set(a[i]!, a[i + 1]!);
  return m;
};

function* walk(n: DomNode): Generator<DomNode> {
  yield n;
  for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) yield* walk(c);
}

const textOf = (n: DomNode): string => [...walk(n)].filter((c) => c.nodeName === '#text').map((c) => c.nodeValue ?? '').join('');

export async function cameraView(page: Page): Promise<CameraView> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const host = [...walk(root)].find((n) => n.nodeName === 'JANTAR-CAMERA');
    if (!host) return { onPage: false, button: false, dot: false, hidden: false, bubble: null };
    const inside = [...walk({ nodeName: '#host', children: host.shadowRoots ?? [] })];
    const byClass = (name: string) => inside.find((n) => (attrsOf(n).get('class') ?? '').split(' ').includes(name));
    const cam = byClass('cam');
    const dot = byClass('dot');
    const tip = byClass('bubble');
    return {
      onPage: true,
      button: cam !== undefined && !attrsOf(cam).has('hidden'),
      dot: dot !== undefined && !attrsOf(dot).has('hidden'),
      hidden: (attrsOf(host).get('style') ?? '').includes('visibility: hidden'),
      bubble: tip && !attrsOf(tip).has('hidden') ? textOf(tip) : null,
    };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** The camera button's box on the page (CSS pixels), or null while it is not there. */
export async function cameraBox(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const host = page.locator('jantar-camera');
  if ((await host.count()) === 0) return null;
  return host.boundingBox();
}

/** A real (trusted) click on the camera button: the mouse at its middle. */
export async function clickCamera(page: Page): Promise<void> {
  const box = await cameraBox(page);
  if (!box) throw new Error('the camera button is not on the page');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// ---------------------------------------------------------------------------
// v0.5.3: the toolbar icon and its real action popup (ext-v053)

/** A DevTools session on the whole browser, for `run`, then detached. */
async function withBrowserCdp<T>(ext: LoadedExtension, run: (cdp: CDPSession) => Promise<T>): Promise<T> {
  const browser = ext.context.browser();
  if (!browser) throw new Error('no browser behind the persistent context');
  const cdp = await browser.newBrowserCDPSession();
  try {
    return await run(cdp);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** What Chromium answers when it has no Extensions domain (an older build, or the flag missing). */
const NO_EXTENSIONS_DOMAIN = /wasn't found|not available|not supported|unknown method/i;

/**
 * A click on the extension's toolbar icon in `page`'s window, as Chrome
 * makes it (`Extensions.triggerAction` on the page's tab target): it grants
 * activeTab for that tab and opens the action popup. False when this
 * Chromium has no Extensions domain (the caller skips with a warning).
 */
export async function clickToolbarIcon(ext: LoadedExtension, page: Page): Promise<boolean> {
  return withBrowserCdp(ext, async (cdp) => {
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = targetInfos.find((t) => t.url === page.url());
    if (!tab) throw new Error(`no tab target at ${page.url()}`);
    try {
      await cdp.send('Extensions.triggerAction', { id: ext.extensionId, targetId: tab.targetId });
      return true;
    } catch (e) {
      if (NO_EXTENSIONS_DOMAIN.test(e instanceof Error ? e.message : String(e))) return false;
      throw e;
    }
  });
}

/** The action popup (the one the toolbar icon opens), driven through its own DevTools target. */
export interface ActionPopup {
  /** `expression` evaluated in the popup's page, by value. */
  evaluate<T>(expression: string): Promise<T>;
  /** A trusted click at (x, y), CSS pixels of the popup. The popup may close itself on it, so the release is not waited for. */
  click(x: number, y: number): Promise<void>;
  /** Close the popup, as a click elsewhere would. */
  close(): Promise<void>;
}

/** The open action popup (`popup.html` with no `?tab=`), once Chrome shows it; its session lives until `close()` or the popup goes. */
export async function actionPopup(ext: LoadedExtension, ms = 10_000): Promise<ActionPopup> {
  const browser = ext.context.browser();
  if (!browser) throw new Error('no browser behind the persistent context');
  const cdp = await browser.newBrowserCDPSession();
  const url = `chrome-extension://${ext.extensionId}/popup.html`;
  const deadline = Date.now() + perfBudgetMs(ms);
  let targetId: string | undefined;
  while (!targetId) {
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
    targetId = targetInfos.find((t) => t.type === 'page' && t.url === url)?.targetId;
    if (targetId) break;
    if (Date.now() > deadline) {
      await cdp.detach().catch(() => undefined);
      throw new Error('the action popup did not open');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const popupTarget = targetId;
  // flatten: false, so the popup's protocol messages ride on this browser session (Playwright has no handle for the popup).
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popupTarget, flatten: false });
  let next = 0;
  const call = (method: string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: { message: string } }> =>
    new Promise((resolve) => {
      const id = ++next;
      const on = (e: { sessionId?: string; message: string }) => {
        if (e.sessionId !== sessionId) return;
        const m = JSON.parse(e.message) as { id?: number; result?: unknown; error?: { message: string } };
        if (m.id !== id) return;
        cdp.off('Target.receivedMessageFromTarget', on);
        resolve(m);
      };
      cdp.on('Target.receivedMessageFromTarget', on);
      void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => undefined);
    });
  return {
    async evaluate<T>(expression: string): Promise<T> {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.error) throw new Error(r.error.message);
      return (r.result as { result?: { value?: T } } | undefined)?.result?.value as T;
    },
    async click(x, y) {
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      void call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId: popupTarget }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}

