/**
 * v0.8: Read saved links (spec 3.4, 13.3). With the popup's switch on, the
 * worker's alarm (READ_ALARM, every 30 s) asks the daemon for posts the user
 * saved to Intel (`GET /v1/ext/reads/next`) and reads each one in this
 * Chrome, as the user, one at a time, at most READ_LIMITS.jobsPerWake per
 * wake, each within READ_LIMITS.jobMs:
 *
 * 1. the job's URL must pass `chromePostOf` for the job's platform (the
 *    daemon rebuilt it from the post's parts; anything else is `blocked`),
 *    and Chrome must allow that post site (`no_permission`);
 * 2. a background tab of its own at about:blank (never active); once
 *    about:blank has loaded (≤ READ_LIMITS.blankMs: Chrome hides about:blank
 *    from an extension without the `tabs` permission, so its own late
 *    updates would look like a step off the sites), a `tabs.onUpdated`
 *    listener for that tab, then the post's URL, muted;
 * 3. every update after that which moves the tab (its load state or its
 *    URL) to a URL off the post's shape, or hidden (it left the hosts this
 *    extension may see), closes the tab at once: `login` on the platform's
 *    own sign-in paths, else `redirected`. The mute's own update comes
 *    while the tab still shows the hidden about:blank, and moves nothing;
 * 4. loaded (≤ 20 s) and 2.5 s more, the URL is checked again, the bundled
 *    reader (`@jantar/protocol/page-read`) runs in the ISOLATED world with
 *    at most 4 frames, and the tab is closed, always.
 *
 * It never clicks, types, scrolls, likes or posts; it never fetches media
 * (the daemon fetches what the read names, without cookies) and has no
 * `cookies`, `webRequest`, `debugger`, `history` or `tabs` permission. The
 * switch lives in chrome.storage.local (`readSaved`, no secret); the post
 * sites are the manifest's own optional origins, so this bundle holds no
 * platform URL. Nothing here logs a URL, a title or page text.
 */
import { readPage, type PageRead } from '@jantar/protocol/page-read';
import { CHROME_PLATFORMS, CHROME_POST_HOSTS, chromePostOf, isLoginPath, type ChromePlatform } from '@jantar/protocol/post-url';
import type { Done } from '../shared/messages.js';
import { postOrigins } from '../shared/post-sites.js';
import { READ_ALARM, READ_LIMITS } from '../shared/wire.js';
import type { Ctx } from './ctx.js';
import { READS, TRY_AGAIN } from './sentences.js';

/** chrome.storage.local's key for the switch. */
export const READS_KEY = 'readSaved';

/** Why a read did not happen (ExtReadResultBody's `why`). */
export type ReadWhy = 'login' | 'not_found' | 'redirected' | 'timeout' | 'blocked' | 'no_permission' | 'failed';
export type ReadOutcome = { ok: true; page: PageRead } | { ok: false; why: ReadWhy };

export interface ReadJob {
  id: string;
  url: string;
  platform: ChromePlatform;
  frames: number;
}

/** A read lease's id (ExtReadIdSchema). */
const LEASE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The job the daemon sent: its lease id (null: none to answer), and the job when every field is as the protocol says. */
export function jobOf(v: unknown): { id: string | null; job: ReadJob | null } {
  if (typeof v !== 'object' || v === null) return { id: null, job: null };
  const j = v as Record<string, unknown>;
  const id = typeof j.id === 'string' && LEASE_ID.test(j.id) ? j.id : null;
  if (!id) return { id: null, job: null };
  const ok =
    typeof j.url === 'string' &&
    j.url.length <= 2000 &&
    typeof j.platform === 'string' &&
    (CHROME_PLATFORMS as readonly string[]).includes(j.platform) &&
    typeof j.frames === 'number' &&
    Number.isInteger(j.frames) &&
    j.frames >= 0;
  return { id, job: ok ? { id, url: j.url as string, platform: j.platform as ChromePlatform, frames: Math.min(j.frames as number, READ_LIMITS.frames) } : null };
}

/**
 * Why a tab's URL is not the job's post, or null when it is. Undefined is a
 * URL Chrome hides from this extension: the tab left the sites it may see
 * (about:blank, which Chrome hides too, is never a post).
 */
export function offShape(url: string | undefined, platform: ChromePlatform): ReadWhy | null {
  if (url === undefined) return 'redirected';
  if (chromePostOf(url)?.platform === platform) return null;
  try {
    const u = new URL(url);
    if (u.hostname === CHROME_POST_HOSTS[platform] && isLoginPath(platform, u.pathname)) return 'login';
  } catch {
    // not a URL at all
  }
  return 'redirected';
}

/** A read cut to the daemon's body limit: frames past the cap or too big dropped first, then the newest frames, then the text. */
export function fitRead(page: PageRead): PageRead {
  const frameChars = 'data:image/jpeg;base64,'.length + Math.ceil(READ_LIMITS.frameBytes / 3) * 4;
  const out: PageRead = { ...page, frames: (Array.isArray(page.frames) ? page.frames : []).filter((f) => typeof f?.jpeg === 'string' && f.jpeg.length <= frameChars).slice(0, READ_LIMITS.frames) };
  // The body is `{ ok: true, page }`; keep well inside its limit.
  const budget = READ_LIMITS.resultBytes - 4096;
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  while (out.frames.length > 0 && size() > budget) out.frames = out.frames.slice(0, -1);
  if (size() > budget) out.text = String(out.text ?? '').slice(0, 10_000);
  return out;
}

export interface Reads {
  /** The switch is on here and Chrome allows the post sites. */
  on(): Promise<boolean>;
  /** The popup's switch (it asked Chrome for the sites first, on the click). */
  set(on: boolean): Promise<Done>;
  /** chrome.alarms.onAlarm. */
  onAlarm(alarm: { name: string }): void;
  /** The browser started or the extension was installed or updated: the alarm back if the switch is on. */
  restore(): void;
  /** One wake: up to jobsPerWake reads, one at a time (a second call while one runs joins it). */
  wake(): Promise<void>;
  /** One read (exported for the tests). */
  read(job: ReadJob): Promise<ReadOutcome>;
}

/** How often a new tab's about:blank is asked whether it has loaded. */
const BLANK_POLL_MS = 50;

/** A timer that resolves after `ms`, and can be cancelled. */
function timer(ms: number): { done: Promise<'timeout'>; cancel(): void } {
  let id: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<'timeout'>((resolve) => {
    id = setTimeout(() => resolve('timeout'), ms);
  });
  return { done, cancel: () => clearTimeout(id) };
}

export function createReads(ctx: Pick<Ctx, 'client' | 'sleep'>, opts: { limits?: { jobMs?: number; completeMs?: number } } = {}): Reads {
  const jobMs = opts.limits?.jobMs ?? READ_LIMITS.jobMs;
  const completeMs = opts.limits?.completeMs ?? READ_LIMITS.completeMs;
  const blankMs = READ_LIMITS.blankMs;
  let waking: Promise<void> | null = null;

  async function stored(): Promise<boolean> {
    try {
      return (await chrome.storage.local.get(READS_KEY))[READS_KEY] === true;
    } catch {
      return false;
    }
  }

  async function allowed(): Promise<boolean> {
    const origins = postOrigins();
    if (origins.length === 0) return false;
    try {
      return await chrome.permissions.contains({ origins });
    } catch {
      return false;
    }
  }

  async function startAlarm(): Promise<void> {
    await chrome.alarms.create(READ_ALARM, { periodInMinutes: READ_LIMITS.pollEveryMs / 60_000, delayInMinutes: READ_LIMITS.pollEveryMs / 60_000 });
  }

  /** A new tab's about:blank done loading (or blankMs gone), so none of its own updates reach a read's listener. */
  async function blankLoaded(tabId: number): Promise<void> {
    for (let waited = 0; waited < blankMs; waited += BLANK_POLL_MS) {
      const now = await chrome.tabs.get(tabId).catch(() => null);
      if (now?.status !== 'loading') return;
      await ctx.sleep(BLANK_POLL_MS);
    }
  }

  /** The tab a read made, closed whatever happens (a second close is harmless). */
  async function close(tabId: number | undefined): Promise<void> {
    if (typeof tabId !== 'number') return;
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // already gone
    }
  }

  async function readIn(job: ReadJob, held: { tabId?: number }): Promise<ReadOutcome> {
    if (chromePostOf(job.url)?.platform !== job.platform) return { ok: false, why: 'blocked' };
    let origin: string;
    try {
      origin = `${new URL(job.url).origin}/*`;
    } catch {
      return { ok: false, why: 'blocked' };
    }
    if (!(await chrome.permissions.contains({ origins: [origin] }).catch(() => false))) return { ok: false, why: 'no_permission' };

    let left: ReadWhy | null = null;
    let loaded!: () => void;
    let leave!: (why: ReadWhy) => void;
    const complete = new Promise<'complete'>((resolve) => (loaded = () => resolve('complete')));
    const gone = new Promise<ReadWhy>((resolve) => (leave = resolve));
    const listener = (id: number, info: { status?: string; url?: string }, tab: { url?: string; pendingUrl?: string }) => {
      if (id !== held.tabId || left) return;
      // Only an update that moves the tab (the mute's own comes while it still shows about:blank, hidden).
      if (info.status === undefined && info.url === undefined) return;
      const why = offShape(tab.url || tab.pendingUrl || undefined, job.platform);
      if (why) {
        left = why;
        void close(id);
        leave(why);
        return;
      }
      if (info.status === 'complete') loaded();
    };
    const wait = timer(completeMs);
    try {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      held.tabId = tab.id;
      if (typeof tab.id !== 'number') return { ok: false, why: 'failed' };
      await blankLoaded(tab.id);
      chrome.tabs.onUpdated.addListener(listener);
      await chrome.tabs.update(tab.id, { url: job.url, muted: true });
      const first = await Promise.race([complete, gone, wait.done]);
      if (first !== 'complete') return { ok: false, why: first };
      await ctx.sleep(READ_LIMITS.settleMs);
      if (left) return { ok: false, why: left };
      const now = await chrome.tabs.get(tab.id);
      const why = offShape(now.url, job.platform);
      if (why) return { ok: false, why };
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: readPage,
        args: [{ platform: job.platform, frames: Math.min(job.frames, READ_LIMITS.frames), textMax: READ_LIMITS.textMax }],
      });
      if (left) return { ok: false, why: left };
      const page = result?.result as PageRead | undefined;
      if (!page || typeof page !== 'object' || typeof page.finalUrl !== 'string') return { ok: false, why: 'failed' };
      const after = offShape(page.finalUrl, job.platform);
      if (after) return { ok: false, why: after };
      return { ok: true, page: fitRead(page) };
    } finally {
      wait.cancel();
      chrome.tabs.onUpdated.removeListener(listener);
      await close(held.tabId);
    }
  }

  async function read(job: ReadJob): Promise<ReadOutcome> {
    const held: { tabId?: number } = {};
    const limit = timer(jobMs);
    try {
      return await Promise.race([readIn(job, held).catch((): ReadOutcome => ({ ok: false, why: 'failed' })), limit.done.then((): ReadOutcome => ({ ok: false, why: 'timeout' }))]);
    } finally {
      limit.cancel();
      // Timed out with the tab still open: it closes now, not when the stuck step ends.
      await close(held.tabId);
    }
  }

  function wake(): Promise<void> {
    waking ??= run()
      .catch(() => undefined)
      .finally(() => {
        waking = null;
      });
    return waking;
  }

  async function run(): Promise<void> {
    if (!(await stored())) return;
    for (let n = 0; n < READ_LIMITS.jobsPerWake; n++) {
      const next = await ctx.client.call<{ job?: unknown }>('readNext');
      if (next.kind !== 'ok') return;
      const { id, job } = jobOf(next.body?.job);
      if (!id) return;
      const outcome: ReadOutcome = job ? await read(job) : { ok: false, why: 'blocked' };
      const sent = await ctx.client.call('readResult', { leaseId: id, body: outcome });
      if (sent.kind === 'down' || sent.kind === 'unpaired') return;
    }
  }

  return {
    async on() {
      return (await stored()) && (await allowed());
    },

    async set(on) {
      try {
        if (on && !(await allowed())) return { ok: false, error: READS.denied };
        await chrome.storage.local.set({ [READS_KEY]: on });
        if (on) {
          await startAlarm();
          void wake();
        } else {
          await chrome.alarms.clear(READ_ALARM);
        }
        return { ok: true };
      } catch {
        return { ok: false, error: TRY_AGAIN };
      }
    },

    onAlarm(alarm) {
      if (alarm?.name !== READ_ALARM) return;
      void wake();
    },

    restore() {
      void (async () => {
        if (!(await stored())) return;
        if (!(await chrome.alarms.get(READ_ALARM))) await startAlarm();
      })().catch(() => undefined);
    },

    wake,

    read,
  };
}
