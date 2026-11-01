/**
 * Synthetic v0.8 data for the README's pictures (scripts/screenshots.mjs,
 * its default fixture) and the phone's Add post checks
 * (web-v08-intel.integration.test.ts): web-fixture-v051.ts as it is, plus
 * one variant where the Mac reads links. Every creator, title, caption,
 * transcript and link is made up; links are on example.com only.
 *
 * Variants (`variant`): every one of web-fixture-v051.ts, passed through
 * unchanged, and
 * - 'intel-read': Intel reads links (features.intelRead), with six items
 *   read from links among the shelf's 40: a reel by "@example_cook" read at
 *   Full (four pictures, its caption, the text on screen, a transcript and
 *   Claude's background), a video and an article, one waiting, one being
 *   read and one that couldn't be read (a login wall). `GET /v1/intel/jobs` holds the
 *   reel's read (saved ten minutes ago), the one at "Looking at frames",
 *   the one waiting, the one that failed, and the video's read from three
 *   hours ago (the strip leaves it to the list). The pictures are drawn by
 *   the script (SCREENSHOT_ART: a bowl of dal, a pressure cooker, ...) and
 *   served on `GET /v1/intel/items/:id/frames/:n`; a flat grey JPEG stands
 *   in for any left out. Add post answers "Saved. Reading it on your Mac.",
 *   or "Already saved." for the reel's own link; Retry, Read again and
 *   Delete answer as the daemon does and change nothing.
 */
import {
  INTEL_READ_REASONS,
  IntelItemSchema,
  IntelJobsResponseSchema,
  type IntelItem,
  type IntelJob,
  type IntelJobsResponse,
  type IntelListItem,
  type IntelListResponse,
} from '@jantar/protocol';
import { makeJpeg } from '../fixtures/runtime/images.mjs';
import {
  SCREENSHOT_ART as V051_ART,
  webFixtureV051,
  type V051ArtName,
  type V051Variant,
  type WebFixtureV051,
  type WebFixtureV051Options,
} from './web-fixture-v051.js';
import type { V05Reply } from './web-fixture-v05.js';

const MIN = 60_000;

export type V08Variant = V051Variant | 'intel-read';
export type V08ArtName = V051ArtName | 'dal0' | 'dal1' | 'dal2' | 'dal3' | 'bread0' | 'kitchen0';

export interface WebFixtureV08Options extends Omit<WebFixtureV051Options, 'variant' | 'art'> {
  variant?: V08Variant;
  /** The bytes of each picture in SCREENSHOT_ART, drawn by the caller; a flat tile stands in for any left out. */
  art?: Partial<Record<V08ArtName, Buffer>>;
}

/** What `v04.answer` is here: a route's reply (`bytes` and `type` for a picture), given the request's body for a write. */
export type V08Answer = (method: string, url: URL, body?: Buffer | null) => V05Reply | null;

export interface WebFixtureV08 extends Omit<WebFixtureV051, 'variant'> {
  variant: V08Variant;
  /** 'intel-read' only: what the phone reads of Intel's links. */
  v08: { items: IntelItem[]; jobs: IntelJobsResponse; frames: Record<string, Array<{ bytes: Buffer; type: string }>> } | null;
}

// ---------------------------------------------------------------------------
// The pictures: thumbnails as the Mac keeps them (JPEG, 320 px on the long edge)

const FOOD_CSS = `
  body { margin: 0; overflow: hidden; font-family: 'Archivo Variable', sans-serif; }
  .f { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
  .t { position: absolute; left: 0; right: 0; text-align: center; font-weight: 700; font-stretch: 125%; letter-spacing: 0.02em; color: #fffaf0; text-shadow: 0 2px 0 rgb(0 0 0 / 0.35); }
  .bowl { position: absolute; border-radius: 50%; }
`;

/** A 180 x 320 reel frame: a dish seen from above, with the words burnt in. */
const reel = (bg: string, dish: string, words: string, extra = '') => `<div class="f" style="background:${bg}">
  <div class="bowl" style="left:20px;top:92px;width:140px;height:140px;background:#f4efe4"></div>
  <div class="bowl" style="left:34px;top:106px;width:112px;height:112px;background:${dish}"></div>${extra}
  <div class="t" style="top:262px;font-size:19px">${words}</div></div>`;

const ART_EXTRA: Record<Exclude<V08ArtName, V051ArtName>, { width: number; height: number; type: 'jpeg'; name: string; css: string; html: string }> = {
  dal0: {
    width: 180,
    height: 320,
    type: 'jpeg',
    name: 'dal-cover.jpg',
    css: FOOD_CSS,
    html: reel(
      '#7a3b1d',
      '#e0a526',
      'DAL 3 WAYS',
      `<div class="bowl" style="left:70px;top:140px;width:12px;height:12px;background:#2f6b2a"></div><div class="bowl" style="left:96px;top:160px;width:10px;height:10px;background:#2f6b2a"></div>
       <div class="t" style="top:30px;font-size:16px">@example_cook</div>`,
    ),
  },
  dal1: {
    width: 180,
    height: 320,
    type: 'jpeg',
    name: 'dal-1.jpg',
    css: FOOD_CSS,
    html: reel('#5b4636', '#d8b25c', 'SOAK 30 MIN', '<div class="bowl" style="left:58px;top:130px;width:64px;height:64px;background:#c99a3e"></div>'),
  },
  dal2: {
    width: 180,
    height: 320,
    type: 'jpeg',
    name: 'dal-2.jpg',
    css: FOOD_CSS,
    html: `<div class="f" style="background:#3f4a57"><div style="position:absolute;left:40px;top:96px;width:100px;height:120px;background:#b9c0c8;border-radius:12px 12px 20px 20px"></div>
      <div style="position:absolute;left:78px;top:76px;width:24px;height:24px;background:#252b33;border-radius:50%"></div>
      <div class="t" style="top:262px;font-size:19px">3 WHISTLES</div></div>`,
  },
  dal3: {
    width: 180,
    height: 320,
    type: 'jpeg',
    name: 'dal-3.jpg',
    css: FOOD_CSS,
    html: reel(
      '#2e2a26',
      '#e8b33a',
      'TADKA LAST',
      '<div class="bowl" style="left:62px;top:124px;width:16px;height:16px;background:#6b3b12"></div><div class="bowl" style="left:96px;top:150px;width:14px;height:14px;background:#7d2a12"></div><div class="bowl" style="left:78px;top:176px;width:12px;height:12px;background:#6b3b12"></div>',
    ),
  },
  bread0: {
    width: 320,
    height: 180,
    type: 'jpeg',
    name: 'starter.jpg',
    css: FOOD_CSS,
    html: `<div class="f" style="background:#d9c7a7"><div style="position:absolute;left:96px;top:44px;width:128px;height:92px;background:#a8682f;border-radius:60px 60px 18px 18px"></div>
      <div style="position:absolute;left:128px;top:60px;width:64px;height:8px;background:#e8cf9c;border-radius:4px;transform:rotate(-12deg)"></div>
      <div class="t" style="top:142px;font-size:20px;color:#3b2512;text-shadow:none">STARTER 101</div></div>`,
  },
  kitchen0: {
    width: 320,
    height: 180,
    type: 'jpeg',
    name: 'kitchen.jpg',
    css: FOOD_CSS,
    html: `<div class="f" style="background:#efe9dd"><div style="position:absolute;left:24px;right:24px;top:52px;height:6px;background:#8a6b4a"></div>
      <div style="position:absolute;left:24px;right:24px;top:112px;height:6px;background:#8a6b4a"></div>
      <div style="position:absolute;left:40px;top:20px;width:28px;height:32px;background:#c94f2c;border-radius:4px"></div><div style="position:absolute;left:80px;top:26px;width:24px;height:26px;background:#3c7a4a;border-radius:4px"></div>
      <div style="position:absolute;left:150px;top:78px;width:36px;height:34px;background:#e0a526;border-radius:4px"></div><div style="position:absolute;left:200px;top:84px;width:28px;height:28px;background:#5a6f8a;border-radius:4px"></div></div>`,
  },
};

/** What the script draws before it builds the fixture: web-fixture-v051.ts's pictures and the read items' thumbnails. */
export const SCREENSHOT_ART: Record<V08ArtName, { width: number; height: number; type: 'png' | 'jpeg'; name: string; css: string; html: string }> = { ...V051_ART, ...ART_EXTRA };

// ---------------------------------------------------------------------------

/** The six items read from links (newest first), with their thumbnails' pictures. */
export const READ_IDS = {
  dal: 'captures:01JV08READ00000000000000D1',
  bread: 'captures:01JV08READ00000000000000B1',
  kitchen: 'captures:01JV08READ00000000000000K1',
  reading: 'captures:01JV08READ00000000000000R1',
  waiting: 'captures:01JV08READ00000000000000W1',
  failed: 'captures:01JV08READ00000000000000F1',
} as const;

/** The reel's own link: Add post answers "Already saved." for it. */
export const DAL_URL = 'https://www.example.com/reel/AbC123xyz/';

function readItems(iso: (minutesAgo: number) => string): IntelItem[] {
  const items: IntelItem[] = [
    {
      id: READ_IDS.waiting,
      source: 'captures',
      at: iso(1),
      title: 'www.example.com/guides/knife-skills',
      url: 'https://www.example.com/guides/knife-skills',
      type: 'link',
      tags: [],
      fields: [{ key: 'via', value: 'phone' }],
      platform: 'web',
      depth: 'light',
      read: { state: 'queued', depth: 'light' },
    },
    {
      id: READ_IDS.reading,
      source: 'captures',
      at: iso(3),
      title: 'Instagram reel',
      url: 'https://www.example.com/reel/XyZ987abc/',
      type: 'reel',
      tags: [],
      fields: [{ key: 'via', value: 'shortcut' }],
      platform: 'instagram',
      depth: 'standard',
      read: { state: 'queued', depth: 'standard' },
    },
    {
      id: READ_IDS.dal,
      source: 'captures',
      at: iso(12),
      title: 'Three ways to cook dal at home',
      url: DAL_URL,
      type: 'reel',
      tags: ['recipe', 'dal', 'weeknight'],
      summary:
        'A one-minute reel that makes the same dal three ways: soaked and simmered, pressure cooked, and finished with a hot tempering of ghee, cumin and garlic.',
      why: 'The pressure-cooker way is a weeknight dinner in under 30 minutes, with no special pot.',
      fields: [{ key: 'via', value: 'shortcut' }],
      platform: 'instagram',
      creator: '@example_cook',
      postedAt: iso(60 * 50),
      depth: 'full',
      read: { state: 'saved', depth: 'full', done: 'full', tier: 'chrome', at: iso(10) },
      caption: 'Dal three ways. Which one is yours? 1) simmered 2) pressure cooked 3) tadka at the end. Save this one for later.',
      onScreen: 'DAL 3 WAYS\nSOAK 30 MIN\n3 WHISTLES\nTADKA LAST',
      points: ['Soak the lentils for 30 minutes first', 'Pressure cook for three whistles, or simmer for 25 minutes', 'Pour the tempering over at the very end'],
      transcript:
        '[0:00] Three ways to make dal, starting with the easiest.\n[0:09] Soak the lentils for thirty minutes, then simmer.\n[0:24] In a pressure cooker, three whistles is enough.\n[0:41] Heat ghee, add cumin and garlic, and pour it over last.',
      background: 'Tadka, a tempering of whole spices in hot fat, is added at the end so the spices stay bright.',
      note: 'try the pressure cooker one this week',
      frames: 4,
    },
    {
      id: READ_IDS.failed,
      source: 'captures',
      at: iso(40),
      title: 'LinkedIn post',
      url: 'https://www.example.com/posts/example-kitchen-activity-7250000000000000000-AbCd/',
      type: 'post',
      tags: [],
      fields: [{ key: 'via', value: 'ask' }],
      platform: 'linkedin',
      depth: 'standard',
      read: { state: 'failed', depth: 'standard', reason: INTEL_READ_REASONS.login, at: iso(38) },
    },
    {
      id: READ_IDS.bread,
      source: 'captures',
      at: iso(60 * 3),
      title: 'How a sourdough starter really works',
      url: 'https://www.example.com/watch?v=Ex4mple0vid',
      type: 'video',
      tags: ['baking', 'bread'],
      summary: 'A twelve-minute video on feeding a starter: the flour and water ratio, the warm spot, and how to tell it is ready.',
      fields: [{ key: 'via', value: 'phone' }],
      platform: 'youtube',
      creator: 'Example Bakes',
      postedAt: iso(60 * 24 * 9),
      depth: 'full',
      read: { state: 'saved', depth: 'full', done: 'full', tier: 'download', at: iso(60 * 3 - 4) },
      points: ['Feed it equal weights of flour and water', 'Keep it somewhere warm', 'It is ready when it doubles in four to six hours'],
      transcript: '[0:00] Today: what a starter is, and how to keep one going.\n[1:12] Equal weights of flour and water, every day.',
      frames: 1,
    },
    {
      id: READ_IDS.kitchen,
      source: 'captures',
      at: iso(60 * 6),
      title: 'Small kitchens, big batch cooking',
      url: 'https://www.example.com/food/small-kitchens-batch-cooking',
      type: 'article',
      tags: ['cooking', 'planning'],
      summary: 'An article on cooking for the week in a small kitchen: two pots, one tray, and a shelf for the jars.',
      fields: [{ key: 'via', value: 'phone' }],
      platform: 'web',
      creator: 'Example Food Journal',
      depth: 'light',
      read: { state: 'saved', depth: 'light', done: 'light', tier: 'browser', at: iso(60 * 6 - 2) },
      frames: 1,
    },
  ];
  return items.map((x) => IntelItemSchema.parse(x));
}

function jobsOf(iso: (minutesAgo: number) => string): IntelJobsResponse {
  const jobs: IntelJob[] = [
    { id: READ_IDS.reading, title: 'Instagram reel', url: 'https://www.example.com/reel/XyZ987abc/', platform: 'instagram', depth: 'standard', state: 'frames', tier: 'chrome', queuedAt: iso(3), startedAt: iso(2) },
    { id: READ_IDS.waiting, title: 'www.example.com/guides/knife-skills', url: 'https://www.example.com/guides/knife-skills', platform: 'web', depth: 'light', state: 'queued', queuedAt: iso(1) },
    // A finished job carries the title the read found.
    { id: READ_IDS.dal, title: 'Three ways to cook dal at home', url: DAL_URL, platform: 'instagram', depth: 'full', state: 'saved', tier: 'chrome', queuedAt: iso(12), startedAt: iso(12), endedAt: iso(10) },
    {
      id: READ_IDS.failed,
      title: 'LinkedIn post',
      platform: 'linkedin',
      depth: 'standard',
      state: 'failed',
      reason: INTEL_READ_REASONS.login,
      queuedAt: iso(40),
      startedAt: iso(40),
      endedAt: iso(38),
    },
    { id: READ_IDS.bread, title: 'How a sourdough starter really works', platform: 'youtube', depth: 'full', state: 'saved', tier: 'download', queuedAt: iso(60 * 3), startedAt: iso(60 * 3), endedAt: iso(60 * 3 - 4) },
  ];
  return IntelJobsResponseSchema.parse({ jobs, reading: { on: true, canRun: true } });
}

const listItem = (x: IntelItem): IntelListItem => ({
  id: x.id,
  source: x.source,
  at: x.at,
  title: x.title,
  ...(x.url ? { url: x.url } : {}),
  ...(x.type ? { type: x.type } : {}),
  tags: x.tags,
  ...(x.summary ? { summary: x.summary.slice(0, 240) } : {}),
  ...(x.platform ? { platform: x.platform } : {}),
  ...(x.creator ? { creator: x.creator } : {}),
  ...(x.read ? { read: { state: x.read.state, ...(x.read.reason ? { reason: x.read.reason } : {}) } } : {}),
  ...(x.platform ? { thumb: (x.frames ?? 0) > 0 } : {}),
});

/** GET /v1/intel over `all` (newest first), as the daemon filters and pages it. */
function listOf(all: IntelItem[], q: URLSearchParams): IntelListResponse {
  const text = (q.get('q') ?? '').trim().toLowerCase();
  const type = q.get('type');
  const tag = q.get('tag');
  const matching = all.filter(
    (x) =>
      (!text || [x.title, x.summary, x.creator, x.caption, x.transcript, x.onScreen, x.note].join(' ').toLowerCase().includes(text)) &&
      (!type || x.type === type) &&
      (!tag || x.tags.includes(tag)),
  );
  const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? 50) || 50));
  const before = q.get('before');
  const from = before ? matching.findIndex((x) => x.id === before) + 1 : 0;
  const page = matching.slice(from, from + limit);
  const tally = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  return {
    items: page.map(listItem),
    next: from + limit < matching.length ? (page.at(-1)?.id ?? null) : null,
    total: matching.length,
    types: tally(all.flatMap((x) => (x.type ? [x.type] : []))).map(([t, n]) => ({ type: t, n })),
    tags: tally(all.flatMap((x) => x.tags))
      .slice(0, 30)
      .map(([t, n]) => ({ tag: t, n })),
  };
}

const notFound = (message: string): V05Reply => ({ status: 404, body: { error: { code: 'not_found', message } } });

export function webFixtureV08(opts: WebFixtureV08Options = {}): WebFixtureV08 {
  const variant = opts.variant ?? 'default';
  const { art: allArt, variant: _variant, ...rest } = opts;
  // web-fixture-v051.ts draws its own pictures from these; the rest are the read items' thumbnails.
  const v051Art: Partial<Record<V051ArtName, Buffer>> = {};
  for (const k of ['slide', 'slide2', 'photo'] as const) {
    const b = allArt?.[k];
    if (b) v051Art[k] = b;
  }
  const base = webFixtureV051({ ...rest, variant: variant === 'intel-read' ? 'default' : variant, art: v051Art });
  if (variant !== 'intel-read') return { ...base, variant, v08: null };

  const now = base.now;
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();

  // ----- Reading links on: the shelf's switch and reading's -----
  const daemon = (base.state.state as unknown as { daemon: { features: Record<string, unknown> } }).daemon;
  daemon.features = { ...daemon.features, intel: true, intelRead: true };

  const read = readItems(iso);
  const all = [...read, ...base.v04.intel].sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''));
  const jobs = jobsOf(iso);
  const pic = (name: Exclude<V08ArtName, V051ArtName>) => {
    const spec = SCREENSHOT_ART[name];
    return { bytes: allArt?.[name] ?? makeJpeg(spec.width, spec.height), type: 'image/jpeg' };
  };
  const frames: Record<string, Array<{ bytes: Buffer; type: string }>> = {
    [READ_IDS.dal]: [pic('dal0'), pic('dal1'), pic('dal2'), pic('dal3')],
    [READ_IDS.bread]: [pic('bread0')],
    [READ_IDS.kitchen]: [pic('kitchen0')],
  };
  let fresh = 0;

  const v051Answer = base.v04.answer as V08Answer;
  const answer: V08Answer = (method, url, body) => {
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/v1/intel') return { status: 200, body: listOf(all, url.searchParams) };
    if (method === 'GET' && path === '/v1/intel/jobs') return { status: 200, body: jobs };
    if (method === 'GET' && (m = /^\/v1\/intel\/items\/([^/]+)\/frames\/(\d)$/.exec(path))) {
      const f = frames[decodeURIComponent(m[1]!)]?.[Number(m[2])];
      return f ? { status: 200, body: null, bytes: f.bytes, type: f.type } : notFound('That picture is not on the Mac.');
    }
    if (method === 'GET' && (m = /^\/v1\/intel\/items\/([^/]+)$/.exec(path))) {
      const x = all.find((i) => i.id === decodeURIComponent(m![1]!));
      return x ? { status: 200, body: { item: x } } : notFound('no such item on the shelf');
    }
    if (method === 'POST' && path === '/v1/intel/reads') {
      let text = '';
      try {
        text = String((JSON.parse(body?.toString('utf8') ?? '{}') as { text?: unknown }).text ?? '');
      } catch {
        text = '';
      }
      if (text.includes(DAL_URL)) return { status: 200, body: { id: READ_IDS.dal, duplicate: true, queued: false, message: 'Already saved.' } };
      fresh += 1;
      return { status: 200, body: { id: `captures:01JV08NEW${String(fresh).padStart(17, '0')}`, duplicate: false, queued: true, message: 'Saved. Reading it on your Mac.' } };
    }
    if (method === 'POST' && (m = /^\/v1\/intel\/items\/([^/]+)\/read$/.exec(path))) return { status: 200, body: { id: decodeURIComponent(m[1]!) } };
    if (method === 'DELETE' && /^\/v1\/intel\/items\/[^/]+$/.test(path)) return { status: 200, body: { ok: true } };
    return v051Answer(method, url, body);
  };

  return {
    ...base,
    v04: { ...base.v04, intel: all, answer },
    variant,
    v08: { items: read, jobs, frames },
  };
}
