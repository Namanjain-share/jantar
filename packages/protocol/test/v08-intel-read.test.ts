/**
 * v0.8 Intel reads links, the protocol's part (wave 0): twelve routes (the
 * phone's and the CLI's reads behind `intelRead`, the jobs, Delete and
 * thumbnails behind `intel`, the Mac-only status and capture keys, the
 * capture door's one route in the `capture` scope, the extension's two
 * reads); strict bodies; the door's one-sentence reply; the rich item
 * fields, all optional; the extension's job and result; the page read's
 * caps; Ask's save card; the switch (off, and on only with the shelf); the
 * two zod-free subpaths. Synthetic values only.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  AskActionSchema,
  AskCardSchema,
  AskSaveActionSchema,
  AskWriteActionSchema,
  CAPTURE_KEY_HEADER,
  CAPTURE_KEY_PREFIX,
  CAPTURE_PREFIX,
  CAPTURE_SAVED_SENTENCE,
  CaptureKeyAddBodySchema,
  CaptureKeyAddReplySchema,
  CaptureKeyRevokeBodySchema,
  CaptureKeySchema,
  CaptureSaveBodySchema,
  CaptureSaveReplySchema,
  ExtReadJobSchema,
  ExtReadResultBodySchema,
  INTEL_CHROME_PLATFORMS,
  INTEL_PLATFORMS,
  INTEL_READ_LIMITS,
  INTEL_READ_NOTES,
  INTEL_READ_REASONS,
  IntelFrameParamsSchema,
  IntelItemSchema,
  IntelJobsResponseSchema,
  IntelListItemSchema,
  IntelReadBodySchema,
  IntelRereadBodySchema,
  JANTAR_FETCH_UA,
  NO_FEATURES,
  PageReadSchema,
  ROUTES,
  SettingsSchema,
  applySettingsPatch,
  defaultSettings,
  settingsFeatures,
  type PageReadParsed,
  type RouteDef,
  type RouteName,
} from '../src/index.js';
import { readPage, type PageRead } from '../src/page-read.js';
import { CHROME_PLATFORMS } from '../src/post-url.js';

const routes = Object.entries(ROUTES) as [RouteName, RouteDef][];
const v08 = routes.filter(([, r]) => r.phase === 'v0.8');
const names = (list: [RouteName, RouteDef][]) => list.map(([n]) => n).sort();
const STAMP = '2026-11-02T10:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('v0.8 routes', () => {
  it('are twelve, each in its scope, behind its switch', () => {
    expect(names(v08)).toEqual(
      ['captureKeyAdd', 'captureKeyList', 'captureKeyRevoke', 'captureSave', 'extReadNext', 'extReadResult', 'intelDelete', 'intelFrame', 'intelJobs', 'intelRead', 'intelReadStatus', 'intelReread'].sort(),
    );
    const want: Partial<Record<RouteName, Pick<RouteDef, 'method' | 'path' | 'scope' | 'ctl'> & { feature?: string; localOnly?: true }>> = {
      intelRead: { method: 'POST', path: '/v1/intel/reads', scope: 'control', ctl: true, feature: 'intelRead' },
      intelReread: { method: 'POST', path: '/v1/intel/items/:id/read', scope: 'control', ctl: true, feature: 'intelRead' },
      intelJobs: { method: 'GET', path: '/v1/intel/jobs', scope: 'control', ctl: true, feature: 'intel' },
      intelDelete: { method: 'DELETE', path: '/v1/intel/items/:id', scope: 'control', ctl: true, feature: 'intel' },
      intelFrame: { method: 'GET', path: '/v1/intel/items/:id/frames/:n', scope: 'control', ctl: false, feature: 'intel' },
      intelReadStatus: { method: 'GET', path: '/v1/intel/read/status', scope: 'admin', ctl: true, localOnly: true },
      captureKeyAdd: { method: 'POST', path: '/v1/intel/capture-keys', scope: 'admin', ctl: true, localOnly: true, feature: 'intel' },
      captureKeyList: { method: 'GET', path: '/v1/intel/capture-keys', scope: 'admin', ctl: true, localOnly: true },
      captureKeyRevoke: { method: 'POST', path: '/v1/intel/capture-keys/revoke', scope: 'admin', ctl: true, localOnly: true },
      captureSave: { method: 'POST', path: '/v1/capture/save', scope: 'capture', ctl: false },
      extReadNext: { method: 'GET', path: '/v1/ext/reads/next', scope: 'extension', ctl: false, feature: 'intelRead' },
      extReadResult: { method: 'POST', path: '/v1/ext/reads/:id', scope: 'extension', ctl: false, feature: 'intelRead' },
    };
    for (const [name, r] of v08) {
      const w = want[name];
      expect({ method: r.method, path: r.path, scope: r.scope, ctl: r.ctl, feature: r.feature, localOnly: r.localOnly }, name).toEqual({ feature: undefined, localOnly: undefined, ...w });
      expect(r.summary.length, name).toBeGreaterThan(5);
    }
    expect(ROUTES.intelFrame.rawResponse).toBe(true);
  });

  it('the capture scope is the door alone, under CAPTURE_PREFIX, 202, with its own small body limit and no switch', () => {
    expect(CAPTURE_PREFIX).toBe('/v1/capture/');
    expect(CAPTURE_KEY_HEADER).toBe('x-jantar-capture-key');
    expect(names(routes.filter(([, r]) => r.scope === 'capture'))).toEqual(['captureSave']);
    for (const [name, r] of routes) if (r.path.startsWith(CAPTURE_PREFIX)) expect(r.scope, name).toBe('capture');
    expect(ROUTES.captureSave).toMatchObject({ status: 202, bodyLimit: 8 * 1024 });
    expect((ROUTES.captureSave as RouteDef).feature).toBeUndefined();
    expect(ROUTES.extReadResult.bodyLimit).toBe(2 * 1024 * 1024);
  });
});

describe('v0.8 bodies', () => {
  it('a read: text with a link or a note, a depth', () => {
    expect(IntelReadBodySchema.parse({ text: '  https://www.instagram.com/reel/AbC123xyz/ dal recipe ', depth: 'full' })).toEqual({ text: 'https://www.instagram.com/reel/AbC123xyz/ dal recipe', depth: 'full' });
    expect(IntelReadBodySchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(IntelReadBodySchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
    expect(IntelReadBodySchema.safeParse({ text: 'x', depth: 'deep' }).success).toBe(false);
    expect(IntelReadBodySchema.safeParse({ text: 'x', via: 'claude' }).success).toBe(false);
    expect(IntelRereadBodySchema.parse({})).toEqual({});
    expect(IntelRereadBodySchema.safeParse({ depth: 'light', url: 'https://example.com/' }).success).toBe(false);
  });

  it('the door: text or url, strict, and the one-sentence reply', () => {
    expect(CaptureSaveBodySchema.safeParse({ text: 'https://example.com/a' }).success).toBe(true);
    expect(CaptureSaveBodySchema.safeParse({ url: 'https://example.com/a', depth: 'light' }).success).toBe(true);
    expect(CaptureSaveBodySchema.safeParse({ depth: 'light' }).success).toBe(false);
    expect(CaptureSaveBodySchema.safeParse({}).success).toBe(false);
    expect(CaptureSaveBodySchema.safeParse({ text: 'x', title: 'y' }).success).toBe(false);
    expect(CaptureSaveBodySchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
    expect(CAPTURE_SAVED_SENTENCE).toBe('Saved to Jantar.');
    expect(CaptureSaveReplySchema.parse({ message: 'Saved to Jantar.' })).toEqual({ message: 'Saved to Jantar.' });
    expect(CaptureSaveReplySchema.safeParse({ message: 'Already saved.' }).success).toBe(false);
    expect(CaptureSaveReplySchema.safeParse({ message: 'Saved to Jantar.', id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR' }).success).toBe(false);
  });

  it('capture keys: jcap_ and 43 base64url characters, a one-line name, one or all revoked', () => {
    const key = `${CAPTURE_KEY_PREFIX}${'A'.repeat(42)}_`;
    expect(CaptureKeySchema.safeParse(key).success).toBe(true);
    expect(CaptureKeySchema.safeParse(`${CAPTURE_KEY_PREFIX}${'A'.repeat(42)}`).success).toBe(false);
    expect(CaptureKeySchema.safeParse(`jext_${'A'.repeat(43)}`).success).toBe(false);
    expect(CaptureKeyAddBodySchema.parse({ name: ' iphone ' })).toEqual({ name: 'iphone' });
    expect(CaptureKeyAddBodySchema.safeParse({ name: 'a\nb' }).success).toBe(false);
    expect(CaptureKeyAddBodySchema.safeParse({ name: 'a‮b' }).success).toBe(false);
    expect(CaptureKeyAddReplySchema.safeParse({ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR', key, name: 'iphone', saveUrl: null }).success).toBe(true);
    expect(CaptureKeyRevokeBodySchema.safeParse({ id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' }).success).toBe(true);
    expect(CaptureKeyRevokeBodySchema.safeParse({ all: true }).success).toBe(true);
    expect(CaptureKeyRevokeBodySchema.safeParse({ all: false }).success).toBe(false);
    expect(CaptureKeyRevokeBodySchema.safeParse({}).success).toBe(false);
  });

  it('a thumbnail is 0 to 6', () => {
    expect(IntelFrameParamsSchema.parse({ id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR', n: '6' }).n).toBe(6);
    expect(IntelFrameParamsSchema.safeParse({ id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR', n: '7' }).success).toBe(false);
    expect(IntelFrameParamsSchema.safeParse({ id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR', n: '-1' }).success).toBe(false);
  });
});

describe('v0.8 items and jobs', () => {
  it('a 0.7 item still parses (every rich field optional), and a read item carries them', () => {
    const base = { id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR', source: 'captures', at: STAMP, title: 'Three ways to cook dal at home', tags: [], fields: [] };
    expect(IntelItemSchema.safeParse(base).success).toBe(true);
    const rich = IntelItemSchema.parse({
      ...base,
      url: 'https://www.instagram.com/reel/AbC123xyz/',
      platform: 'instagram',
      creator: '@example_cook',
      postedAt: STAMP,
      depth: 'standard',
      read: { state: 'saved', depth: 'standard', done: 'standard', tier: 'chrome', at: STAMP, notes: [INTEL_READ_NOTES.coverOnly] },
      caption: 'Soak overnight.',
      onScreen: 'DAL',
      points: ['Soak overnight'],
      note: 'try this',
      frames: 5,
    });
    expect(rich.read?.state).toBe('saved');
    expect(IntelItemSchema.safeParse({ ...base, frames: 8 }).success).toBe(false);
    expect(IntelItemSchema.safeParse({ ...base, transcript: 'x'.repeat(8001) }).success).toBe(false);
    expect(IntelItemSchema.safeParse({ ...base, platform: 'threads' }).success).toBe(false);
    expect(IntelListItemSchema.parse({ ...base, thumb: true, read: { state: 'failed', reason: INTEL_READ_REASONS.stopped } }).thumb).toBe(true);
  });

  it('the jobs reply', () => {
    const job = { id: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR', title: 'Instagram reel', platform: 'instagram', depth: 'standard', state: 'fetching', tier: 'chrome', queuedAt: STAMP };
    expect(IntelJobsResponseSchema.safeParse({ jobs: [job], reading: { on: true, canRun: true } }).success).toBe(true);
    expect(IntelJobsResponseSchema.safeParse({ jobs: [{ ...job, state: 'downloading' }], reading: { on: true, canRun: true } }).success).toBe(false);
    expect(IntelJobsResponseSchema.safeParse({ jobs: Array.from({ length: 151 }, () => job), reading: { on: true, canRun: true } }).success).toBe(false);
  });

  it('platforms: the six post platforms (post-url.ts\'s, spelled out), then web, pdf and note (no threads, no facebook)', () => {
    expect([...INTEL_CHROME_PLATFORMS]).toEqual([...CHROME_PLATFORMS]);
    expect([...INTEL_PLATFORMS]).toEqual([...CHROME_PLATFORMS, 'web', 'pdf', 'note']);
  });
});

describe('v0.8 the extension and the page read', () => {
  const page: PageRead = { finalUrl: 'https://www.instagram.com/reel/AbC123xyz/', title: 'x', meta: [{ k: 'og:title', v: 'x' }], jsonld: [], text: 'caption', media: [], frames: [] };

  it('a job is a rebuilt https URL on one of the six platforms, at most 4 frames', () => {
    const job = { id: 'lease_0123456789', url: 'https://www.instagram.com/reel/AbC123xyz/', platform: 'instagram', frames: 4 };
    expect(ExtReadJobSchema.safeParse(job).success).toBe(true);
    expect(ExtReadJobSchema.safeParse({ ...job, frames: 5 }).success).toBe(false);
    expect(ExtReadJobSchema.safeParse({ ...job, platform: 'web' }).success).toBe(false);
    expect(ExtReadJobSchema.safeParse({ ...job, url: 'http://www.instagram.com/reel/AbC123xyz/' }).success).toBe(false);
    expect(ExtReadJobSchema.safeParse({ ...job, id: 'short' }).success).toBe(false);
  });

  it('a result: a page, or why not', () => {
    expect(ExtReadResultBodySchema.safeParse({ ok: true, page }).success).toBe(true);
    expect(ExtReadResultBodySchema.safeParse({ ok: true, page: { ...page, cookies: 'x' } }).success).toBe(false);
    expect(ExtReadResultBodySchema.safeParse({ ok: false, why: 'redirected' }).success).toBe(true);
    expect(ExtReadResultBodySchema.safeParse({ ok: false, why: 'because' }).success).toBe(false);
  });

  it('a page read is capped: frames as JPEG data URLs of at most 200 KB, https media only', () => {
    const frame = (n: number) => ({ at: 1, jpeg: `data:image/jpeg;base64,${'A'.repeat(n)}` });
    expect(PageReadSchema.safeParse({ ...page, frames: [frame(Math.ceil((200 * 1024) / 3) * 4)] }).success).toBe(true);
    expect(PageReadSchema.safeParse({ ...page, frames: [frame(Math.ceil((200 * 1024) / 3) * 4 + 4)] }).success).toBe(false);
    expect(PageReadSchema.safeParse({ ...page, frames: [{ at: 1, jpeg: 'data:image/png;base64,AAAA' }] }).success).toBe(false);
    expect(PageReadSchema.safeParse({ ...page, frames: Array.from({ length: 21 }, () => frame(4)) }).success).toBe(false);
    expect(PageReadSchema.safeParse({ ...page, media: [{ kind: 'video', url: 'http://cdn.example.com/v.mp4' }] }).success).toBe(false);
    expect(PageReadSchema.safeParse({ ...page, text: 'x'.repeat(INTEL_READ_LIMITS.pageTextMax + 1) }).success).toBe(false);
    expectTypeOf<PageReadParsed>().toEqualTypeOf<PageRead>();
  });

  it('readPage reads the title, the kept meta pairs and the ld+json blocks of the page it runs in', () => {
    const el = (attrs: Record<string, string>, text = '') => ({ getAttribute: (n: string) => attrs[n] ?? null, textContent: text });
    vi.stubGlobal('location', { href: 'https://www.instagram.com/reel/AbC123xyz/' });
    vi.stubGlobal('document', {
      title: '  Example  cook \n',
      querySelectorAll: (sel: string) =>
        sel.startsWith('meta')
          ? [el({ property: 'og:title', content: 'A made up reel' }), el({ name: 'viewport', content: 'width=device-width' }), el({ name: 'description', content: 'x' })]
          : [el({}, ' {"@type":"VideoObject"} '), el({}, '')],
    });
    const read = readPage({ platform: 'instagram', frames: 0, textMax: 40_000 });
    expect(read).toEqual({
      finalUrl: 'https://www.instagram.com/reel/AbC123xyz/',
      title: 'Example cook',
      meta: [
        { k: 'og:title', v: 'A made up reel' },
        { k: 'description', v: 'x' },
      ],
      jsonld: ['{"@type":"VideoObject"}'],
      text: '',
      media: [],
      frames: [],
    });
    expect(PageReadSchema.safeParse(read).success).toBe(true);
  });

  it('readPage runs from its own source alone, as both tiers send it (no import, no closure)', () => {
    const doc = { title: 'A made up page', querySelectorAll: (sel: string) => (sel.startsWith('meta') ? [{ getAttribute: (n: string) => ({ property: 'og:title', content: 'x' })[n] ?? null, textContent: '' }] : []) };
    const read = runInNewContext(`(${readPage.toString()})({ platform: 'web', frames: 0, textMax: 100 })`, { document: doc, location: { href: 'https://example.com/a' } }) as PageRead;
    expect({ ...read, meta: [...read.meta] }).toMatchObject({ finalUrl: 'https://example.com/a', title: 'A made up page', meta: [{ k: 'og:title', v: 'x' }], text: '' });
  });

  it('the two subpaths import no zod and hold no URL literal', () => {
    for (const f of ['post-url.ts', 'page-read.ts']) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/from 'zod'/);
      expect(src, f).not.toMatch(/https?:\/\//);
      // page-read.ts imports one type, erased at build.
      for (const m of src.matchAll(/^import\s.*$/gm)) expect(m[0], f).toMatch(/^import type /);
    }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };
    expect(Object.keys(pkg.exports)).toEqual(expect.arrayContaining(['./post-url', './page-read']));
  });
});

describe('v0.8 Ask, the switch and the fixed sentences', () => {
  it("Ask's save card: an http(s) link and a depth, in both unions; a card's ref may be an Intel id", () => {
    const save = { type: 'save', url: 'https://www.instagram.com/reel/AbC123xyz/', depth: 'full' };
    expect(AskSaveActionSchema.safeParse(save).success).toBe(true);
    expect(AskActionSchema.safeParse(save).success).toBe(true);
    expect(AskWriteActionSchema.safeParse(save).success).toBe(true);
    expect(AskSaveActionSchema.safeParse({ ...save, url: 'javascript:alert(1)' }).success).toBe(false);
    expect(AskSaveActionSchema.safeParse({ ...save, title: 'x' }).success).toBe(false);
    expect(AskCardSchema.safeParse({ action: save, state: 'added', ref: 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR' }).success).toBe(true);
  });

  it('reading is off by default, and on for clients only with the shelf on; settings keep their version', () => {
    const d = defaultSettings();
    expect(d.intel).toMatchObject({ read: false, speechLocale: 'en-IN' });
    expect(d.bins.ytDlp).toBeNull();
    expect(d.version).toBe(2);
    expect(NO_FEATURES.intelRead).toBe(false);
    expect(settingsFeatures(d).intelRead).toBe(false);
    expect(settingsFeatures(SettingsSchema.parse({ intel: { read: true } })).intelRead).toBe(false);
    expect(settingsFeatures(SettingsSchema.parse({ intel: { enabled: true } })).intelRead).toBe(false);
    expect(settingsFeatures(SettingsSchema.parse({ intel: { enabled: true, read: true } })).intelRead).toBe(true);
    expect(applySettingsPatch(d, { intel: { speechLocale: 'hi-IN' } }).ok).toBe(true);
    expect(applySettingsPatch(d, { intel: { speechLocale: 'english' } }).ok).toBe(false);
  });

  it('the reasons and notes are fixed sentences that quote nothing', () => {
    expect(INTEL_READ_REASONS.off).toBe('Reading links is off. Turn it on at your Mac: jantar intel read on');
    expect(INTEL_READ_REASONS.stopped).toBe('Stopped before it finished. Retry.');
    expect(Object.keys(INTEL_READ_REASONS)).toHaveLength(22);
    expect(Object.keys(INTEL_READ_NOTES)).toHaveLength(12);
    for (const s of [...Object.values(INTEL_READ_REASONS), ...Object.values(INTEL_READ_NOTES)]) {
      expect(s.length, s).toBeLessThanOrEqual(200);
      expect(s, s).not.toMatch(/https?:|\$\{/);
    }
    expect(JANTAR_FETCH_UA).toBe('Jantar/0.8 (+https://github.com/Namanjain-share/jantar)');
    expect(INTEL_READ_LIMITS).toMatchObject({ queueMax: 100, perDay: 100, fullPerDay: 30, jobMs: 480_000, ocrFrames: 20, thumbsMax: 7, captureKeysMax: 5 });
    expect(Object.isFrozen(INTEL_READ_LIMITS)).toBe(true);
  });
});
