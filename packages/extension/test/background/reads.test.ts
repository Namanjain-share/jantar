/**
 * G10: Read saved links in the user's Chrome (spec 3.4, 13.3), the worker's
 * side, on the chrome fake with a fake daemon. Synthetic links and pages.
 *
 * - A job off `chromePostOf` (a link shim, a profile, another platform's
 *   post) is refused (`blocked`) and no tab opens; without the post site's
 *   grant, `no_permission`.
 * - The tab is the worker's own, made at about:blank in the background; once
 *   about:blank has loaded, its onUpdated listener is added before the
 *   post's URL goes in, muted. An update that moves nothing (the mute's
 *   own, while Chrome still hides about:blank) is not a step off.
 * - The first update whose URL leaves the post's shape (another host, the
 *   platform's sign-in path, a shim on the same host) or is hidden closes
 *   the tab at once; the platforms' own on-shape redirects go on.
 * - The shape is checked again before the reader runs, in the ISOLATED
 *   world with at most 4 frames; the tab always closes (a timeout and a
 *   failed script too).
 * - The switch: off reads nothing; on asks Chrome first and starts the
 *   alarm; the alarm and a browser start wake it; at most 5 jobs a wake.
 * - Nothing of a post reaches the console.
 */
import { POST_MARKER } from '@jantar/fixtures';
import { readPage, type PageRead } from '@jantar/protocol/page-read';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { READS_KEY, fitRead, offShape } from '../../src/background/reads.js';
import { READS } from '../../src/background/sentences.js';
import { READ_ALARM, READ_LIMITS } from '../../src/shared/wire.js';
import { postOrigins } from '../../src/shared/post-sites.js';
import { POST_ORIGINS } from '../manifest.test.js';
import { setupWorker, watchConsole, type Answer, type WorkerUnderTest } from './chrome.js';
import type { FakeUpdate } from '../helpers/chrome-fake.js';

let w: WorkerUnderTest;
let watched: ReturnType<typeof watchConsole> | undefined;
afterEach(() => {
  if (watched) expect(watched.text()).not.toContain(POST_MARKER);
  watched = undefined;
  w?.close();
});

const LEASE = 'lease_0123456789';
const REEL = 'https://www.instagram.com/reel/AbC123xyz/';
const job = (over: Record<string, unknown> = {}) => ({ id: LEASE, url: REEL, platform: 'instagram', frames: 4, ...over });
const next = (j: unknown): Answer => ({ status: 200, body: { job: j } });

const PAGE: PageRead = {
  finalUrl: REEL,
  title: `Example Cook on Instagram: "${POST_MARKER}"`,
  meta: [],
  jsonld: [],
  text: `Three ways to cook dal ${POST_MARKER}`,
  author: 'example_cook',
  media: [],
  frames: [],
};

/** A paired worker with the switch on, the six sites granted, and one job (then none). */
async function ready(opts: { job?: unknown; grant?: boolean; on?: boolean; limits?: { jobMs?: number; completeMs?: number } } = {}) {
  w = setupWorker({ deps: { readLimits: opts.limits ?? { completeMs: 2_000, jobMs: 4_000 } } });
  if (opts.grant !== false) for (const o of POST_ORIGINS) w.model.granted.add(o);
  if (opts.on !== false) w.model.local.set(READS_KEY, true);
  w.daemon.on('readNext', next(opts.job === undefined ? job() : opts.job), next(null));
  w.model.onScript = () => [{ frameId: 0, result: PAGE }];
  const created: { url?: string; active?: boolean }[] = [];
  const create = w.chrome.tabs.create.bind(w.chrome.tabs);
  w.chrome.tabs.create = async (p) => {
    created.push({ ...p });
    return create(p);
  };
  return { created };
}

/** The navigation as the test scripts it; also records whether the worker listened before the URL went in. */
function navigate(steps: (url: string) => FakeUpdate[]) {
  const listening: boolean[] = [];
  w.model.navigation = (_tabId, url) => {
    listening.push(w.chrome.tabs.onUpdated.hasListeners());
    return steps(url);
  };
  return listening;
}

const result = () => w.daemon.of('readResult')[0];

describe('G10: one read', () => {
  it("opens its own background tab at about:blank, listens, then the post's URL muted; reads in the ISOLATED world; closes the tab", async () => {
    const { created } = await ready();
    watched = watchConsole();
    const listening = navigate((url) => [
      { info: { status: 'loading', url }, url },
      { info: { status: 'complete' }, url },
    ]);
    await w.worker.reads.wake();
    expect(created).toEqual([{ url: 'about:blank', active: false }]);
    expect(listening).toEqual([true]);
    const tabId = w.model.updates[0]?.tabId as number;
    expect(w.model.updates).toEqual([{ tabId, url: REEL, muted: true }]);
    expect(w.model.scripts).toHaveLength(1);
    const script = w.model.scripts[0];
    expect(script?.target).toEqual({ tabId });
    expect(script?.world).toBe('ISOLATED');
    expect(script?.func).toBe(readPage);
    expect(script?.args).toEqual([{ platform: 'instagram', frames: 4, textMax: READ_LIMITS.textMax }]);
    expect(w.model.removed).toEqual([tabId]);
    expect(w.chrome.tabs.onUpdated.hasListeners()).toBe(false);
    expect(result()?.clientId).toBe(LEASE);
    expect(result()?.body).toEqual({ ok: true, page: PAGE });
    expect(w.daemon.ops()).toEqual(['readNext', 'readResult', 'readNext']);
  });

  it("waits out about:blank's own load before listening (Chrome hides about:blank: a late update of its own would look like a step off)", async () => {
    await ready();
    const get = w.chrome.tabs.get.bind(w.chrome.tabs);
    const asked: boolean[] = [];
    w.chrome.tabs.get = async (id) => {
      asked.push(w.chrome.tabs.onUpdated.hasListeners());
      const tab = await get(id);
      return { ...tab, status: asked.length < 3 ? 'loading' : 'complete' };
    };
    const listening = navigate((url) => [
      { info: { status: 'loading', url }, url },
      { info: { status: 'complete' }, url },
    ]);
    await w.worker.reads.wake();
    // Asked while about:blank loaded, with no listener yet; then the listener, then the post.
    expect(asked.slice(0, 3)).toEqual([false, false, false]);
    expect(listening).toEqual([true]);
    expect(result()?.body).toEqual({ ok: true, page: PAGE });
  });

  it("an about:blank that never says it loaded holds the read up at most blankMs; the mute's own hidden update moves nothing", async () => {
    await ready();
    const get = w.chrome.tabs.get.bind(w.chrome.tabs);
    let loading = 0;
    w.chrome.tabs.get = async (id) => {
      const tab = await get(id);
      if (w.model.updates.length > 0) return tab;
      loading += 1;
      return { ...tab, status: 'loading' };
    };
    navigate((url) => [
      { info: {}, url: undefined },
      { info: { status: 'loading', url }, url },
      { info: { status: 'complete' }, url },
    ]);
    await w.worker.reads.wake();
    expect(loading).toBe(READ_LIMITS.blankMs / 50);
    expect(result()?.body).toEqual({ ok: true, page: PAGE });
  });

  it('refuses a job off the post shapes (shims, profiles, logins, another platform), opening no tab', async () => {
    for (const bad of [
      job({ url: 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com' }),
      job({ url: 'https://www.instagram.com/example_cook/' }),
      job({ url: 'https://www.instagram.com/accounts/login/' }),
      job({ url: 'https://instagram.com/reel/AbC123xyz/' }),
      job({ url: 'https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com' , platform: 'youtube' }),
      job({ url: 'https://www.youtube.com/watch?v=Ab3dE6gH9jK' }),
      job({ url: 'http://www.instagram.com/reel/AbC123xyz/' }),
      // The post's shape, but not the URL rebuilt from it: another query, a fragment, the handle's path.
      job({ url: 'https://www.instagram.com/reel/AbC123xyz/?next=https%3A%2F%2Fexample.com' }),
      job({ url: 'https://www.instagram.com/reel/AbC123xyz/#x' }),
      job({ url: 'https://www.instagram.com/example_cook/reel/AbC123xyz/' }),
      job({ url: 'https://x.com/i/status/1850000000000000000?anything=1', platform: 'x' }),
      job({ platform: 'threads' }),
      job({ frames: 'many' }),
    ]) {
      const { created } = await ready({ job: bad });
      await w.worker.reads.wake();
      expect(result()?.body, JSON.stringify(bad)).toEqual({ ok: false, why: 'blocked' });
      expect(created, JSON.stringify(bad)).toEqual([]);
      w.close();
    }
  });

  it('a job with no usable lease id is not answered at all', async () => {
    await ready({ job: { ...job(), id: '../../v1/state' } });
    await w.worker.reads.wake();
    expect(w.daemon.ops()).toEqual(['readNext']);
  });

  it('without the post site granted: no_permission, no tab', async () => {
    const { created } = await ready({ grant: false });
    await w.worker.reads.wake();
    expect(result()?.body).toEqual({ ok: false, why: 'no_permission' });
    expect(created).toEqual([]);
  });

  for (const [what, to, why] of [
    ['another host', 'https://evil.example/landing', 'redirected'],
    ['the sign-in page', 'https://www.instagram.com/accounts/login/?next=%2Freel%2FAbC123xyz%2F', 'login'],
    ['a profile on the same host', 'https://www.instagram.com/example_cook/', 'redirected'],
    ['a link shim', 'https://l.instagram.com/?u=https%3A%2F%2Fevil.example', 'redirected'],
    ['a hidden URL (off the hosts the extension may see)', undefined, 'redirected'],
  ] as const) {
    it(`a redirect to ${what} closes the tab at once and reads nothing: ${why}`, async () => {
      await ready();
      navigate((url) => [
        { info: { status: 'loading', url }, url },
        { info: { status: 'loading', ...(to ? { url: to } : {}) }, url: to },
        { info: { status: 'complete' }, url: to },
      ]);
      await w.worker.reads.wake();
      expect(result()?.body).toEqual({ ok: false, why });
      expect(w.model.scripts).toEqual([]);
      expect(w.model.removed).toHaveLength(1);
    });
  }

  it("the platforms' own on-shape redirects go on (X's /i/status/ to the handle's)", async () => {
    await ready({ job: job({ url: 'https://x.com/i/status/1850000000000000001', platform: 'x' }) });
    w.model.onScript = () => [{ frameId: 0, result: { ...PAGE, finalUrl: 'https://x.com/example_dev/status/1850000000000000001' } }];
    navigate((url) => [
      { info: { status: 'loading', url }, url },
      { info: { status: 'loading', url: 'https://x.com/example_dev/status/1850000000000000001' }, url: 'https://x.com/example_dev/status/1850000000000000001' },
      { info: { status: 'complete' }, url: 'https://x.com/example_dev/status/1850000000000000001' },
    ]);
    await w.worker.reads.wake();
    expect(result()?.body).toMatchObject({ ok: true });
    expect(w.model.scripts).toHaveLength(1);
  });

  it('the shape is checked again right before reading, and on the page the reader saw', async () => {
    await ready();
    const get = w.chrome.tabs.get.bind(w.chrome.tabs);
    w.chrome.tabs.get = async (id) => ({ ...(await get(id)), url: 'https://www.instagram.com/accounts/login/' });
    await w.worker.reads.wake();
    expect(result()?.body).toEqual({ ok: false, why: 'login' });
    expect(w.model.scripts).toEqual([]);
    w.close();

    await ready();
    w.model.onScript = () => [{ frameId: 0, result: { ...PAGE, finalUrl: 'https://evil.example/' } }];
    await w.worker.reads.wake();
    expect(result()?.body).toEqual({ ok: false, why: 'redirected' });
  });

  it('a load that never completes is a timeout; a reader that hangs, the job timeout; a script error, failed; the tab closes each time', async () => {
    await ready({ limits: { completeMs: 30, jobMs: 4_000 } });
    navigate((url) => [{ info: { status: 'loading', url }, url }]);
    await w.worker.reads.wake();
    expect(result()?.body).toEqual({ ok: false, why: 'timeout' });
    expect(w.model.removed).toHaveLength(1);
    w.close();

    await ready({ limits: { completeMs: 2_000, jobMs: 60 } });
    w.model.onScript = () => new Promise(() => undefined);
    await w.worker.reads.wake();
    expect(result()?.body).toEqual({ ok: false, why: 'timeout' });
    expect(w.model.removed).toHaveLength(1);
    w.close();

    await ready();
    w.model.onScript = () => {
      throw new Error('Cannot access contents of the page.');
    };
    await w.worker.reads.wake();
    expect(result()?.body).toEqual({ ok: false, why: 'failed' });
    expect(w.model.removed).toHaveLength(1);
  });

  it('a read past the body limit sends fewer frames, never more than 4', () => {
    const jpeg = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
    const big = fitRead({ ...PAGE, frames: Array.from({ length: 9 }, (_, i) => ({ at: i, jpeg })) });
    expect(big.frames.length).toBeLessThanOrEqual(READ_LIMITS.frames);
    const huge = fitRead({ ...PAGE, text: 'x'.repeat(40_000), frames: [{ at: 0, jpeg: `data:image/jpeg;base64,${'A'.repeat(400_000)}` }] });
    expect(huge.frames).toEqual([]);
  });

  it('offShape: on the shape, sign-in paths, anything else (about:blank, which Chrome hides anyway, is never a post)', () => {
    expect(offShape(REEL, 'instagram')).toBeNull();
    expect(offShape('about:blank', 'instagram')).toBe('redirected');
    expect(offShape(undefined, 'instagram')).toBe('redirected');
    expect(offShape('https://x.com/i/flow/login', 'x')).toBe('login');
    expect(offShape('https://www.linkedin.com/authwall?trk=x', 'linkedin')).toBe('login');
    expect(offShape('https://www.reddit.com/r/selfhosted/comments/abc123/simple_backups/', 'reddit')).toBeNull();
    expect(offShape('https://www.reddit.com/r/selfhosted/comments/abc123/simple_backups/', 'x')).toBe('redirected');
  });
});

describe('G10: the switch, the alarm and the wake', () => {
  it('the post sites come from the manifest, exactly the six', () => {
    w = setupWorker();
    expect(postOrigins()).toEqual(POST_ORIGINS);
  });

  it('off: a wake asks the daemon nothing', async () => {
    await ready({ on: false });
    await w.worker.reads.wake();
    expect(w.daemon.calls).toEqual([]);
  });

  it('on from the popup: refused without the sites; with them, stored, the alarm every 30 s, and a wake at once', async () => {
    await ready({ grant: false, on: false });
    expect(await w.popup({ t: 'reads', on: true })).toEqual({ ok: false, error: READS.denied });
    expect(w.model.local.get(READS_KEY)).toBeUndefined();
    for (const o of POST_ORIGINS) w.model.granted.add(o);
    expect(await w.popup({ t: 'reads', on: true })).toEqual({ ok: true });
    expect(w.model.local.get(READS_KEY)).toBe(true);
    expect(w.model.alarms.get(READ_ALARM)).toEqual({ name: READ_ALARM, periodInMinutes: 0.5, delayInMinutes: 0.5 });
    await vi.waitFor(() => expect(w.daemon.of('readResult')).toHaveLength(1));
    expect((await w.popup({ t: 'state', tabId: 1 })) as { reads: boolean }).toMatchObject({ reads: true });
    expect(await w.popup({ t: 'reads', on: false })).toEqual({ ok: true });
    expect(w.model.alarms.has(READ_ALARM)).toBe(false);
    expect((await w.popup({ t: 'state', tabId: 1 })) as { reads: boolean }).toMatchObject({ reads: false });
  });

  it('the read alarm wakes it; another alarm does not; a browser start puts the alarm back while on', async () => {
    await ready();
    w.chrome.alarms.onAlarm.dispatch({ name: 'something-else', scheduledTime: 0 });
    expect(w.daemon.calls).toEqual([]);
    w.chrome.alarms.onAlarm.dispatch({ name: READ_ALARM, scheduledTime: 0 });
    await vi.waitFor(() => expect(w.daemon.of('readResult')).toHaveLength(1));
    expect(w.model.alarms.has(READ_ALARM)).toBe(false);
    w.chrome.runtime.onStartup.dispatch();
    await vi.waitFor(() => expect(w.model.alarms.has(READ_ALARM)).toBe(true));
  });

  it('at most five jobs a wake, one at a time; a second wake while one runs joins it', async () => {
    await ready();
    w.daemon.on('readNext', next(job()));
    await Promise.all([w.worker.reads.wake(), w.worker.reads.wake()]);
    expect(w.daemon.of('readNext')).toHaveLength(READ_LIMITS.jobsPerWake);
    expect(w.daemon.of('readResult')).toHaveLength(READ_LIMITS.jobsPerWake);
    expect(w.model.removed).toHaveLength(READ_LIMITS.jobsPerWake);
  });

  it('unpaired, or Jantar down or off: the wake stops', async () => {
    w = setupWorker({ paired: false });
    w.model.local.set(READS_KEY, true);
    await w.worker.reads.wake();
    expect(w.daemon.calls).toEqual([]);
    w.close();
    await ready();
    w.daemon.on('readNext', { status: 403, body: { error: { code: 'forbidden', message: 'Reading links is off.' } } });
    await w.worker.reads.wake();
    expect(w.daemon.ops()).toEqual(['readNext']);
  });
});
