/**
 * Tier 2, headless system Chrome through playwright-core (spec 3.5).
 *
 * - playwright-core 1.63.0 is imported lazily, here only, when this tier runs.
 * - The browser is the system Chrome binary (`channel: 'chrome'`, updated by
 *   Google, so this tier that renders attacker-chosen pages gets Chrome's
 *   security fixes). Never Playwright's own headless shell. No system
 *   Chrome: the tier is unavailable. Tests pass playwright-core's Chromium
 *   only through the service's injected `executablePath` (never settings, env
 *   or CLI), and a fake module through `load`.
 * - `chromium.launch()` only: a fresh temp profile Playwright makes and
 *   deletes, never the user's profile; headless; Chrome's own sandbox on
 *   (`chromiumSandbox: true`: playwright-core otherwise adds --no-sandbox);
 *   every connection through the guard's CONNECT proxy; WebRTC kept off
 *   non-proxied UDP; env only PATH, HOME, TMPDIR and LANG (no proxy
 *   variable, nothing else of the daemon's).
 * - Context: service workers blocked, no downloads, 1280×800, no
 *   permissions, never recordVideo or recordHar, no screenshots.
 * - One page: goto (domcontentloaded, 20 s), 2.5 s settle, the bundled
 *   reader (`@jantar/protocol/page-read`), closed after each job; 30 s for
 *   the whole tier.
 */
import { existsSync } from 'node:fs';
import { INTEL_READ_LIMITS, type IntelPlatform } from '@jantar/protocol';
import { readPage, type PageReadArgs } from '@jantar/protocol/page-read';

/** Where Playwright's `channel: 'chrome'` finds Google Chrome on a Mac. */
export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** What the tier uses of playwright-core (so a test can hand it a fake). */
export interface PwPage {
  goto(url: string, opts: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
}
export interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
export interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
export interface PwModule {
  chromium: { launch(opts: Record<string, unknown>): Promise<PwBrowser> };
}

export interface BrowserOptions {
  /** Tests only: playwright-core's own Chromium (the service's injected seam). */
  executablePath?: string;
  /** Tests only: a fake module instead of `import('playwright-core')`. */
  load?: () => Promise<PwModule>;
  /** The daemon's env; the browser gets only BROWSER_ENV of it. */
  env: Readonly<Record<string, string | undefined>>;
}

/** All of the daemon's env a browser rendering strangers' pages is given (never a proxy variable or a token). */
export const BROWSER_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;

/** The browser's env: BROWSER_ENV of the daemon's, nothing else. */
export function browserEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of BROWSER_ENV) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The launch options (G7 pins them). */
export function launchOptions(proxyPort: number, o: Pick<BrowserOptions, 'executablePath' | 'env'>): Record<string, unknown> {
  return {
    headless: true,
    ...(o.executablePath ? { executablePath: o.executablePath } : { channel: 'chrome' }),
    chromiumSandbox: true,
    proxy: { server: `http://127.0.0.1:${proxyPort}` },
    args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    env: browserEnv(o.env),
    timeout: 15_000,
  };
}

/** The context options (G7 pins them). */
export const CONTEXT_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({
  serviceWorkers: 'block',
  acceptDownloads: false,
  viewport: { width: 1280, height: 800 },
});

export type BrowserRead = { ok: true; page: unknown } | { ok: false; why: 'unavailable' | 'timeout' | 'failed' };

export class BrowserTier {
  constructor(private readonly o: BrowserOptions) {}

  /** System Chrome is on this Mac (or the test seam names a browser). */
  available(): boolean {
    return this.o.executablePath !== undefined || existsSync(SYSTEM_CHROME);
  }

  /** Read `url` (frames: canvas frames from the page's main video, 0..20). The read is untrusted: the caller checks it. */
  async read(url: string, platform: IntelPlatform, frames: number, proxyPort: number, signal?: AbortSignal): Promise<BrowserRead> {
    if (!this.available()) return { ok: false, why: 'unavailable' };
    let pw: PwModule;
    try {
      pw = this.o.load ? await this.o.load() : ((await import('playwright-core')) as unknown as PwModule);
    } catch {
      return { ok: false, why: 'unavailable' };
    }
    let browser: PwBrowser | null = null;
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => void browser?.close().catch(() => undefined);
    try {
      const work = (async (): Promise<BrowserRead> => {
        const b = await pw.chromium.launch(launchOptions(proxyPort, this.o));
        browser = b;
        // The cap or an abort came first: this browser closes at once.
        if (ended || signal?.aborted) {
          await b.close().catch(() => undefined);
          return { ok: false, why: 'timeout' };
        }
        const context = await browser.newContext({ ...CONTEXT_OPTIONS });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(2_500);
        const args: PageReadArgs = { platform, frames: Math.max(0, Math.min(frames, INTEL_READ_LIMITS.browserFrames)), textMax: INTEL_READ_LIMITS.pageTextMax };
        const read = await page.evaluate(readPage, args);
        return { ok: true, page: read };
      })();
      const cap = new Promise<BrowserRead>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, why: 'timeout' }), INTEL_READ_LIMITS.browserMs);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      // A read still going when the cap wins fails later on its closed browser: never an unhandled rejection.
      work.catch(() => undefined);
      return await Promise.race([work, cap]).catch((): BrowserRead => ({ ok: false, why: signal?.aborted ? 'timeout' : 'failed' }));
    } finally {
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await (browser as PwBrowser | null)?.close().catch(() => undefined);
    }
  }
}
