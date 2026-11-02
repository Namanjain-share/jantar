/**
 * One read, start to end (spec 3, 4): the job's steps, its states and its
 * last line. Degrade, never lose: a failed later step keeps what earlier
 * steps got and adds a note; when no tier gives a good read the item keeps
 * the best partial read with the most specific reason, and no Claude run is
 * spent on it.
 *
 *   fetching      short links resolved through the guard (headers only), a
 *                 web link's resolve step (a PDF found by its type), then the
 *                 platform's page tiers in order (§3.3), first good read wins
 *   preparing     the media helper's one-time build
 *   frames        Standard/Full: frames (§4's order), the cover and post
 *                 images, on-screen text (Vision OCR) on every kept frame
 *   transcribing  Full, where there is a video: YouTube captions, else
 *                 on-device speech on the video or audio file
 *   summarising   Full's related pages (links in the user's note only), then
 *                 the Claude run
 *
 * Everything runs inside the job dir (deleted at the end, whatever the
 * outcome); the CONNECT proxy runs only while the job needs it. Nothing is
 * logged but codes and counts.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  INTEL_READ_LIMITS,
  INTEL_READ_NOTES,
  INTEL_READ_REASONS,
  type AccountId,
  type IntelDepth,
  type IntelPlatform,
  type IntelReadState,
  type IntelTier,
  type PageReadParsed,
} from '@jantar/protocol';
import { chromePostOf, type ChromePlatform } from '@jantar/protocol/post-url';
import type { CcwLegacySource, DaemonContext, Logger, UsageSource } from '../../contracts.js';
import { runClaude, READ_MODEL, READ_PROMPT_VERSION, type ReadInput } from './claude.js';
import { dropJobDir, freshJobDir, mediaBytes, putThumbs } from './files.js';
import type { Guard } from './guard.js';
import { type HelperGap, type MediaHelper } from './media.js';
import { checkPageRead, emptyFields, hasSomething, isGood, isoOf, line as pageLine, type PageFields } from './platforms/common.js';
import { instagramFromPage } from './platforms/instagram.js';
import { linkedinFromPage, redditFromPage, tiktokFromPage, xFromPage } from './platforms/social.js';
import { webFromPage } from './platforms/web.js';
import { ytCoverUrls, ytFrameUrls, youtubeFromPage } from './platforms/youtube.js';
import { ConnectProxy } from './proxy.js';
import type { Job } from './queue.js';
import { relatedPages, type RelatedPage } from './related.js';
import type { CaptureLine } from './store.js';
import type { BrowserTier } from './tiers/browser.js';
import type { ChromeLeases } from './tiers/chrome.js';
import { downloadRead, type TierWhy } from './tiers/download.js';
import { canonical, chromeUrlOf, isShortLink, kindOf, type LinkKind } from './url.js';
import { stamp, type YtDlp } from './ytdlp.js';

type TierName = 'chrome' | 'browser' | 'download' | 'ytdlp';

/** Spec 3.3: each platform's page tiers in the user's order, those known not to work left out. */
export const PAGE_TIERS: Readonly<Record<IntelPlatform, readonly TierName[]>> = {
  instagram: ['chrome', 'browser', 'download', 'ytdlp'],
  youtube: ['chrome', 'download', 'ytdlp'],
  tiktok: ['chrome', 'download', 'ytdlp'],
  x: ['chrome', 'download', 'ytdlp'],
  reddit: ['chrome', 'download'],
  linkedin: ['chrome', 'download'],
  web: ['browser', 'download'],
  pdf: ['download'],
  note: [],
};

/** The most specific reason first. */
const REASON_ORDER = ['tiktok', 'reddit', 'blocked', 'notFound', 'login', 'tooBig', 'timeout'] as const satisfies readonly TierWhy[];

export function reasonOf(whys: readonly TierWhy[], platform: IntelPlatform): string {
  for (const w of REASON_ORDER) if (whys.includes(w)) return INTEL_READ_REASONS[w];
  return platform === 'reddit' ? INTEL_READ_REASONS.reddit : INTEL_READ_REASONS.notFound;
}

export interface PipelineDeps {
  ctx: DaemonContext;
  guard: Guard;
  chrome: ChromeLeases;
  browser: BrowserTier;
  ytdlp: YtDlp;
  helper: MediaHelper;
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
  log: Logger;
  /** Options claude refused that a read can do without. */
  learned: Set<string>;
}

/** The audit row's counts (never a link, a title or text). */
export interface ReadAudit {
  depth: IntelDepth;
  done: IntelDepth | null;
  tier: IntelTier | null;
  frames: number;
  transcriptChars: number;
  ms: number;
  account: AccountId | null;
  outcome: string;
}

/** A frame kept for Claude, OCR and thumbnails: a 768 px JPEG in the job dir. */
interface Frame {
  file: string;
  at: number | null;
}

/** A transcript kept: the head and the tail around "[… cut …]". */
export function keepTranscript(t: string): string {
  const { transcriptMax, transcriptHead, transcriptTail } = INTEL_READ_LIMITS;
  if (t.length <= transcriptMax) return t;
  return `${t.slice(0, transcriptHead).trimEnd()}\n[… cut …]\n${t.slice(t.length - transcriptTail).trimStart()}`.slice(0, transcriptMax);
}

/** `n` items of `list` evenly spaced (all of them when there are fewer). */
export function evenly<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  return Array.from({ length: n }, (_v, k) => list[Math.floor(((k + 0.5) * list.length) / n)] as T);
}

/** Distinct OCR lines in time order, at most 1,000 chars. */
export function onScreenText(perFrame: readonly string[][]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let len = 0;
  for (const lines of perFrame) {
    for (const l of lines) {
      const t = l.replace(/\s+/g, ' ').trim();
      const key = t.toLowerCase();
      if (!t || seen.has(key)) continue;
      seen.add(key);
      if (len + t.length + 1 > INTEL_READ_LIMITS.onScreenMax) return out.join('\n');
      out.push(t);
      len += t.length + 1;
    }
  }
  return out.join('\n');
}

function fromPage(platform: IntelPlatform, page: PageReadParsed): PageFields {
  switch (platform) {
    case 'instagram':
      return instagramFromPage(page);
    case 'youtube':
      return youtubeFromPage(page);
    case 'tiktok':
      return tiktokFromPage(page);
    case 'x':
      return xFromPage(page);
    case 'reddit':
      return redditFromPage(page);
    case 'linkedin':
      return linkedinFromPage(page);
    default:
      return webFromPage(page);
  }
}

/** yt-dlp's `-J` as page fields. */
export function ytdlpFields(json: unknown): PageFields {
  const f = emptyFields();
  if (typeof json !== 'object' || json === null) return f;
  const j = json as Record<string, unknown>;
  const title = pageLine(j.title, 300);
  if (title) f.title = title;
  if (typeof j.description === 'string') f.text = j.description.slice(0, 40_000).trim();
  const creator = pageLine(j.uploader ?? j.channel, 80);
  if (creator) f.creator = creator;
  const at = isoOf(j.timestamp ?? j.upload_date);
  if (at) f.postedAt = at;
  if (typeof j.duration === 'number' && j.duration > 0) f.duration = j.duration;
  return f;
}

class Run {
  readonly notes: string[] = [];
  tier: IntelTier | undefined;
  fields: PageFields = emptyFields();
  link: string | null;
  kind: LinkKind;
  jobDir: string | null = null;
  proxy: ConnectProxy | null = null;
  done: IntelDepth;
  /** Seconds, from the page or the probe (the speech timeout). */
  duration: number | undefined;
  /** Seconds from the helper's probe only: the one duration `<item>` may hold. */
  probed: number | undefined;
  /** Temp names in the job dir. */
  seq = 0;
  /** A local video or audio file (for speech). */
  mediaFile: string | null = null;
  coverClaude: string | null = null;
  coverThumb: string | null = null;
  frames: Frame[] = [];
  /** Frames came from the video (or the browser), not just images. */
  realFrames = false;
  onScreen: { label: string; lines: string[] }[] = [];
  onScreenAll = '';
  transcript = '';
  related: RelatedPage[] = [];
  gap: HelperGap | null = null;
  helperOk = false;
  imagesFetched = 0;

  constructor(
    readonly job: Job,
    readonly d: PipelineDeps,
    readonly update: (state: IntelReadState, tier?: IntelTier) => void,
  ) {
    this.link = job.link;
    this.kind = job.kind;
    this.done = job.depth;
  }

  get signal(): AbortSignal {
    return this.job.abort.signal;
  }

  note(n: string): void {
    if (!this.notes.includes(n)) this.notes.push(n);
  }

  async proxyPort(): Promise<number> {
    this.proxy ??= await ConnectProxy.start({ vet: (h) => this.d.guard.vet(h), maxBytes: INTEL_READ_LIMITS.proxyBytesPerJob, ...(this.d.guard.net ? { net: this.d.guard.net } : {}) });
    return this.proxy.port;
  }

  async dir(name: string): Promise<string> {
    const p = join(this.jobDir as string, name);
    await mkdir(p, { recursive: true, mode: 0o700 });
    return p;
  }
}

/** One read to its end: the item's last line (saved or failed), and the audit counts. */
export async function runRead(job: Job, d: PipelineDeps, update: (state: IntelReadState, tier?: IntelTier) => void): Promise<{ line: CaptureLine; audit: ReadAudit }> {
  const started = d.ctx.clock.now();
  const r = new Run(job, d, update);
  let account: AccountId | null = null;
  let outcome = 'failed';
  try {
    r.jobDir = await freshJobDir(d.ctx.paths.intelDir, job.rid);
    if (!r.jobDir) return finish(r, failed(r, INTEL_READ_REASONS.stopped), 'no_job_dir');
    if (job.link) {
      update('fetching');
      const reason = await fetchPage(r);
      if (reason) return finish(r, failed(r, reason), 'not_read');
    }
    if (r.signal.aborted) return finish(r, failed(r, abortReason(job)), 'stopped');
    await media(r);
    if (r.signal.aborted) return finish(r, failed(r, abortReason(job)), 'stopped');
    if (job.depth === 'full' && job.link && spoken(r)) await transcript(r);
    if (r.signal.aborted) return finish(r, failed(r, abortReason(job)), 'stopped');
    update('summarising');
    if (job.depth === 'full') r.related = await relatedPages(d.guard, job.note, { jobDir: r.jobDir, helper: r.helperOk ? d.helper : null, signal: r.signal });
    const input = await claudeInput(r);
    const res = await runClaude({ ctx: d.ctx, usage: d.usage, ccwLegacy: d.ccwLegacy, log: d.log, learned: d.learned }, input, r.signal);
    account = res.account;
    if (!res.ok) {
      outcome = res.outcome;
      const reason = r.signal.aborted ? abortReason(job) : INTEL_READ_REASONS[res.why];
      // Deleted while Claude ran: its thumbnails are already gone, and none are written again.
      return finish(r, failed(r, reason, job.why === 'deleted' ? baseFrames(r) : await thumbs(r)), outcome, account);
    }
    if (res.noPictures) r.note(INTEL_READ_NOTES.noPictures);
    outcome = 'ok';
    return finish(r, await saved(r, res.answer, job.why === 'deleted' ? baseFrames(r) : await thumbs(r)), outcome, account);
  } catch (e) {
    d.log.error('intel read step failed', { error: (e as { code?: string }).code ?? (e instanceof Error ? e.name : 'error') });
    return finish(r, failed(r, r.signal.aborted ? abortReason(job) : INTEL_READ_REASONS.stopped), 'error', account);
  } finally {
    await r.proxy?.close().catch(() => undefined);
    await dropJobDir(r.jobDir);
  }

  function finish(run: Run, line: CaptureLine, out: string, acct: AccountId | null = null): { line: CaptureLine; audit: ReadAudit } {
    const read = line.read as { state: string };
    return {
      line,
      audit: {
        depth: job.depth,
        done: read.state === 'saved' ? run.done : null,
        tier: run.tier ?? null,
        frames: typeof line.frames === 'number' ? line.frames : 0,
        transcriptChars: run.transcript.length,
        ms: Math.max(0, d.ctx.clock.now() - started),
        account: acct,
        outcome: out,
      },
    };
  }
}

function abortReason(job: Job): string {
  return job.why === 'tooLong' ? INTEL_READ_REASONS.tooLong : INTEL_READ_REASONS.stopped;
}

// ---------------------------------------------------------------- fetching

/** Resolve the link, then the page tiers; a reason when nothing good came back (the partial stays in r.fields). */
async function fetchPage(r: Run): Promise<string | null> {
  const { guard } = r.d;
  let link = r.link as string;
  if (isShortLink(link)) {
    const res = await guard.fetch(link, { kind: 'page', maxBytes: INTEL_READ_LIMITS.pageBytes, totalMs: INTEL_READ_LIMITS.pageMs, headersOnly: true, signal: r.signal });
    if (res.ok) link = canonical(res.url);
    else if (res.why === 'blocked') return INTEL_READ_REASONS.blocked;
    r.link = link;
    r.kind = kindOf(link);
  }
  if (r.kind.platform === 'web') {
    const res = await guard.fetch(link, { kind: 'page', maxBytes: INTEL_READ_LIMITS.pageBytes, totalMs: INTEL_READ_LIMITS.pageMs, headersOnly: true, signal: r.signal });
    if (!res.ok && res.why === 'blocked') return INTEL_READ_REASONS.blocked;
    if (!res.ok && res.why === 'notFound') return INTEL_READ_REASONS.notFound;
    if (res.ok) {
      link = canonical(res.url);
      r.link = link;
      r.kind = res.type.endsWith('pdf') ? { platform: 'pdf', type: 'pdf', post: null } : kindOf(link);
    }
  }
  if (r.kind.platform === 'pdf') return readPdf(r);
  const whys: TierWhy[] = [];
  let best: PageFields | null = null;
  const platform = r.kind.platform;
  const chromeUrl = chromeUrlOf(r.kind.post);
  const wantFrames = r.job.depth === 'light' ? 0 : INTEL_READ_LIMITS.chromeFrames;
  for (const tier of PAGE_TIERS[platform]) {
    if (r.signal.aborted) return abortReason(r.job);
    let got: PageFields | null = null;
    if (tier === 'chrome') {
      if (!chromeUrl || !r.d.chrome.available()) continue;
      r.update('fetching', 'chrome');
      const res = await r.d.chrome.read(chromeUrl, platform as ChromePlatform, wantFrames, r.signal);
      if (!res.ok) {
        if (res.why === 'login') whys.push('login');
        else if (res.why === 'not_found') whys.push('notFound');
        continue;
      }
      const page = checkPageRead(res.page);
      // The page the tab ended on must still be this platform's post (the extension checks it too).
      got = page && chromePostOf(page.finalUrl)?.platform === platform ? fromPage(platform, page) : null;
    } else if (tier === 'browser') {
      if (!r.d.browser.available()) continue;
      r.update('fetching', 'browser');
      const res = await r.d.browser.read(chromeUrl ?? link, platform, r.job.depth === 'light' ? 0 : INTEL_READ_LIMITS.browserFrames, await r.proxyPort(), r.signal);
      if (!res.ok) continue;
      const page = checkPageRead(res.page);
      got = page ? fromPage(platform, page) : null;
    } else if (tier === 'download') {
      r.update('fetching', 'download');
      const res = await downloadRead(r.d.guard, chromeUrl ?? link, r.kind, r.signal);
      if (res.ok) got = res.fields;
      else {
        whys.push(res.why);
        if (res.partial && hasSomething(res.partial) && !hasSomething(best)) best = res.partial;
        if (res.why === 'tiktok' || res.why === 'blocked') break;
        continue;
      }
    } else {
      if (!r.d.ytdlp.found) continue;
      r.update('fetching', 'ytdlp');
      const res = await r.d.ytdlp.run(platform, chromeUrl ?? link, r.jobDir as string, await r.proxyPort(), { kind: 'metadata' }, r.signal);
      if (!res.ok) continue;
      let json: unknown = null;
      try {
        json = JSON.parse(res.stdout);
      } catch {
        // not JSON
      }
      got = ytdlpFields(json);
    }
    if (got && got.why) whys.push(got.why === 'tiktok' ? 'tiktok' : got.why === 'notFound' ? 'notFound' : got.why === 'blocked' ? 'blocked' : got.why === 'reddit' ? 'reddit' : 'login');
    if (got && isGood(platform, got)) {
      r.fields = got;
      r.tier = tier;
      return null;
    }
    if (got && hasSomething(got) && !hasSomething(best)) {
      best = got;
      r.tier = tier;
    }
  }
  if (best) r.fields = best;
  return reasonOf(whys, platform);
}

/** A PDF: the file (≤ 25 MB, %PDF-) through the guard, its text and page 1 from the helper. */
async function readPdf(r: Run): Promise<string | null> {
  r.update('fetching', 'download');
  r.tier = 'download';
  const file = join(r.jobDir as string, 'doc.pdf');
  const res = await r.d.guard.fetch(r.link as string, { kind: 'pdf', maxBytes: INTEL_READ_LIMITS.pdfBytes, totalMs: INTEL_READ_LIMITS.pdfMs, toFile: file, signal: r.signal });
  if (!res.ok) return res.why === 'tooBig' ? INTEL_READ_REASONS.tooBig : res.why === 'blocked' ? INTEL_READ_REASONS.blocked : res.why === 'timeout' ? INTEL_READ_REASONS.timeout : INTEL_READ_REASONS.notFound;
  if (!(await helper(r))) return r.gap === 'noSandbox' ? INTEL_READ_NOTES.noSandbox : INTEL_READ_REASONS.noClt;
  const page1 = join(r.jobDir as string, 'pdf-page1.jpg');
  const p = await r.d.helper.pdf(r.jobDir as string, file, page1, INTEL_READ_LIMITS.claudeEdge, r.signal);
  if (!p.ok) return INTEL_READ_REASONS.format;
  const f = emptyFields();
  f.text = p.value.text.trim();
  const title = pageLine(p.value.title, 300);
  if (title) f.title = title;
  const author = pageLine(p.value.author, 80);
  if (author) f.creator = author;
  r.fields = f;
  if (p.value.image) r.coverClaude = page1;
  return isGood('pdf', f) ? null : INTEL_READ_REASONS.notFound;
}

// ---------------------------------------------------------------- media

/** The helper, built once (state `preparing`); false (with the gap) when it can't run here. */
async function helper(r: Run): Promise<boolean> {
  if (r.helperOk) return true;
  r.gap = r.d.helper.gap();
  if (r.gap) return false;
  if (await r.d.helper.needsBuild()) r.update('preparing');
  r.helperOk = await r.d.helper.ensure();
  if (!r.helperOk) r.gap = 'noClt';
  return r.helperOk;
}

/** Download an image (≤ 8 MB, image magic) and re-encode it at `edge` (sandboxed); its path, or null. */
async function image(r: Run, url: string, prefix: string, edge: number): Promise<string | null> {
  if (r.imagesFetched >= INTEL_READ_LIMITS.imagesPerItem) return null;
  r.imagesFetched += 1;
  const res = await r.d.guard.fetch(url, { kind: 'image', maxBytes: INTEL_READ_LIMITS.imageBytes, totalMs: INTEL_READ_LIMITS.imageMs, signal: r.signal });
  if (!res.ok) return null;
  const name = `${prefix}-${(r.seq += 1)}`;
  const src = join(r.jobDir as string, `${name}.src`);
  await writeFile(src, res.body, { mode: 0o600, flag: 'wx' });
  return encode(r, src, name, edge);
}

/** Any local image re-encoded as a JPEG at `edge` by the helper. */
async function encode(r: Run, src: string, name: string, edge: number): Promise<string | null> {
  const out = join(r.jobDir as string, `${name}-${edge}.jpg`);
  const done = await r.d.helper.image(r.jobDir as string, src, out, edge, r.signal);
  return done.ok ? out : null;
}

/** A video file (≤ 150 MB, ftyp) through the guard, cookie-less; its path, or null (with a note for a format we can't read). */
async function videoFile(r: Run, url: string): Promise<string | null> {
  const file = join(r.jobDir as string, `video-${(r.seq += 1)}.mp4`);
  const res = await r.d.guard.fetch(url, { kind: 'media', maxBytes: INTEL_READ_LIMITS.mediaBytes, totalMs: INTEL_READ_LIMITS.mediaMs, toFile: file, signal: r.signal });
  if (!res.ok) {
    if (res.why === 'format') r.note(INTEL_READ_REASONS.format);
    return null;
  }
  return file;
}

/** Frames from a local video: n = clamp(ceil(duration / 2), 4, 20) at 768 px. */
async function framesOfFile(r: Run, file: string): Promise<Frame[]> {
  const probe = await r.d.helper.probe(r.jobDir as string, file, r.signal);
  if (!probe.ok || probe.value.video === 0) return [];
  r.duration = probe.value.duration || r.duration;
  if (probe.value.duration > 0) r.probed = probe.value.duration;
  const n = Math.max(4, Math.min(INTEL_READ_LIMITS.ocrFrames, Math.ceil((probe.value.duration || 8) / 2)));
  const out = await r.dir('frames');
  const got = await r.d.helper.frames(r.jobDir as string, file, out, n, INTEL_READ_LIMITS.claudeEdge, r.signal);
  return got.ok ? got.value.map((f) => ({ file: f.file, at: f.at })) : [];
}

/** Canvas frames from a page read, written and re-encoded (never trusted as JPEGs). */
async function framesOfPage(r: Run, frames: readonly { at: number; jpeg: Buffer }[]): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const f of frames.slice(0, INTEL_READ_LIMITS.ocrFrames)) {
    const name = `page-${(r.seq += 1)}`;
    const src = join(r.jobDir as string, `${name}.src`);
    await writeFile(src, f.jpeg, { mode: 0o600, flag: 'wx' });
    const enc = await encode(r, src, name, INTEL_READ_LIMITS.claudeEdge);
    if (enc) out.push({ file: enc, at: f.at });
  }
  return out;
}

/** Frames and images (Standard, Full), the cover (every depth), on-screen text. */
async function media(r: Run): Promise<void> {
  const { job } = r;
  const f = r.fields;
  const wantFrames = job.depth !== 'light' && job.link !== null;
  const wantCover = !!f.cover || !!r.coverClaude;
  if (!wantFrames && !wantCover) return;
  if (!(await helper(r))) {
    if (job.depth !== 'light' && job.link !== null) {
      r.note(r.gap === 'noSandbox' ? INTEL_READ_NOTES.noSandbox : INTEL_READ_REASONS.noClt);
      r.done = 'light';
    }
    return;
  }
  if (wantFrames) r.update('frames');
  // The cover: a thumbnail at every depth, shown to Claude from Standard.
  let coverSrc: string | null = r.coverClaude;
  if (!coverSrc && f.cover) {
    const res = await r.d.guard.fetch(f.cover, { kind: 'image', maxBytes: INTEL_READ_LIMITS.imageBytes, totalMs: INTEL_READ_LIMITS.imageMs, signal: r.signal });
    if (res.ok) {
      coverSrc = join(r.jobDir as string, 'cover.src');
      await writeFile(coverSrc, res.body, { mode: 0o600, flag: 'wx' });
      r.imagesFetched += 1;
    }
  }
  if (!coverSrc && r.kind.platform === 'youtube' && r.kind.post?.parts.v) {
    for (const u of ytCoverUrls(r.kind.post.parts.v)) {
      const res = await r.d.guard.fetch(u, { kind: 'image', maxBytes: INTEL_READ_LIMITS.imageBytes, totalMs: INTEL_READ_LIMITS.imageMs, signal: r.signal });
      if (!res.ok) continue;
      coverSrc = join(r.jobDir as string, 'cover.src');
      await writeFile(coverSrc, res.body, { mode: 0o600, flag: 'wx' });
      break;
    }
  }
  if (coverSrc) {
    r.coverThumb = await encode(r, coverSrc, 'cover', INTEL_READ_LIMITS.thumbEdge);
    if (wantFrames) r.coverClaude = await encode(r, coverSrc, 'cover', INTEL_READ_LIMITS.claudeEdge);
  }
  if (!wantFrames || r.signal.aborted) return;

  const platform = r.kind.platform;
  // 1. YouTube's own frames (no download).
  if (platform === 'youtube' && r.kind.post?.parts.v) {
    r.duration ??= f.duration;
    const urls = ytFrameUrls(r.kind.post.parts.v);
    for (const [k, u] of urls.entries()) {
      const p = await image(r, u, 'yt', INTEL_READ_LIMITS.claudeEdge);
      // hq1..hq3 are YouTube's own frames near 25, 50 and 75 %.
      if (p) r.frames.push({ file: p, at: r.duration ? (r.duration * (k + 1)) / (urls.length + 1) : null });
    }
    if (r.frames.length) r.realFrames = true;
  }
  // 2. The canvas frames the page tier drew.
  if (!r.frames.length && f.frames.length) {
    r.frames = await framesOfPage(r, f.frames);
    r.realFrames = r.frames.length > 0;
  }
  // 3. A video file a tier found.
  if (!r.frames.length && f.video) {
    const file = await videoFile(r, f.video);
    if (file) {
      r.mediaFile = file;
      r.frames = await framesOfFile(r, file);
      r.realFrames = r.frames.length > 0;
    }
  }
  // 4. Instagram: the frames-only headless pass (logged out, it draws a reel's frames).
  if (!r.frames.length && platform === 'instagram' && r.tier !== 'browser' && r.d.browser.available() && !r.signal.aborted) {
    const res = await r.d.browser.read(chromeUrlOf(r.kind.post) ?? (r.link as string), 'instagram', INTEL_READ_LIMITS.browserFrames, await r.proxyPort(), r.signal);
    const page = res.ok ? checkPageRead(res.page) : null;
    if (page) {
      const fr = instagramFromPage(page).frames;
      r.frames = await framesOfPage(r, fr);
      r.realFrames = r.frames.length > 0;
      if (page.duration && !r.duration) r.duration = page.duration;
    }
  }
  // 5. yt-dlp's video file.
  if (!r.frames.length && (platform === 'instagram' || platform === 'tiktok' || platform === 'x') && !r.signal.aborted) {
    if (r.d.ytdlp.found) {
      const file = await r.d.ytdlp.file(platform, chromeUrlOf(r.kind.post) ?? (r.link as string), r.jobDir as string, await r.proxyPort(), 'video', r.signal);
      if (file) {
        r.mediaFile = file;
        r.frames = await framesOfFile(r, file);
        r.realFrames = r.frames.length > 0;
      }
    }
  }
  // 6. Images only: the post's images, else the cover.
  if (!r.frames.length) {
    for (const u of f.images) {
      if (r.frames.length >= 4) break;
      const p = await image(r, u, 'img', INTEL_READ_LIMITS.claudeEdge);
      if (p) r.frames.push({ file: p, at: null });
    }
    if (r.frames.length) r.note(INTEL_READ_NOTES.imagesOnly);
    else if (r.coverClaude && (platform !== 'web' && platform !== 'pdf' && platform !== 'linkedin')) r.note(INTEL_READ_NOTES.coverOnly);
  }
  // On-screen text: every kept frame from a video, else the ones Claude sees.
  const shown = evenly(r.frames, job.depth === 'full' ? INTEL_READ_LIMITS.framesFull : INTEL_READ_LIMITS.framesStandard);
  const ocrFrames = (r.realFrames ? r.frames : shown).slice(0, INTEL_READ_LIMITS.ocrFrames);
  const ocrFiles = [...ocrFrames.map((x) => x.file), ...(r.coverClaude && !r.realFrames ? [r.coverClaude] : [])].slice(0, INTEL_READ_LIMITS.ocrFrames);
  if (ocrFiles.length && !r.signal.aborted) {
    const o = await r.d.helper.ocr(r.jobDir as string, ocrFiles, r.signal);
    if (o.ok) {
      r.onScreen = ocrFiles.map((file, i) => {
        const fr = ocrFrames[i];
        const label = fr ? (fr.at !== null ? `Frame at ${stamp(fr.at)}` : `Image ${i + 1}`) : 'Cover';
        return { label: file === r.coverClaude ? 'Cover' : label, lines: o.value[i] ?? [] };
      });
      r.onScreenAll = onScreenText(o.value);
    }
  }
}

// ---------------------------------------------------------------- transcript

/** The platforms whose posts are videos (or may be). */
const VIDEO_PLATFORMS: ReadonlySet<IntelPlatform> = new Set(['instagram', 'youtube', 'tiktok']);

/** Full listens only where there is a video: an article, a PDF or a text post has nothing to transcribe. */
function spoken(r: Run): boolean {
  return VIDEO_PLATFORMS.has(r.kind.platform) || r.realFrames || r.mediaFile !== null || !!r.fields.video || !!r.fields.duration;
}

function segmentsText(segments: readonly { at: number; text: string }[]): string {
  return segments.map((s) => `[${stamp(s.at)}] ${s.text.replace(/\s+/g, ' ').trim()}`).join('\n');
}

/** Full: YouTube's captions, else on-device speech on the video or audio file; else a note (done: standard). */
async function transcript(r: Run): Promise<void> {
  if (!(await helper(r)) && r.kind.platform !== 'youtube') {
    r.done = 'light';
    return;
  }
  r.update('transcribing');
  const platform = r.kind.platform;
  const url = chromeUrlOf(r.kind.post) ?? (r.link as string);
  if (platform === 'youtube' && r.d.ytdlp.found) {
    const port = await r.proxyPort();
    const lang = r.fields.youtube?.lang ?? (await r.d.ytdlp.language(url, r.jobDir as string, port, r.signal)) ?? 'en';
    const caps = await r.d.ytdlp.captions(url, lang, r.jobDir as string, port, r.signal);
    if (caps) {
      r.transcript = caps;
      return;
    }
  }
  if (!r.helperOk) {
    r.note(INTEL_READ_NOTES.noAudio);
    if (r.done === 'full') r.done = 'standard';
    return;
  }
  let file = r.mediaFile;
  if (!file && r.fields.video) file = await videoFile(r, r.fields.video);
  if (!file && (platform === 'instagram' || platform === 'youtube' || platform === 'tiktok' || platform === 'x') && r.d.ytdlp.found) {
    file = await r.d.ytdlp.file(platform, url, r.jobDir as string, await r.proxyPort(), 'audio', r.signal);
  }
  if (!file) {
    r.note(INTEL_READ_NOTES.noAudio);
    if (r.done === 'full') r.done = 'standard';
    return;
  }
  if (r.probed === undefined) {
    const p = await r.d.helper.probe(r.jobDir as string, file, r.signal);
    if (p.ok && p.value.duration > 0) {
      r.probed = p.value.duration;
      r.duration = p.value.duration;
    }
  }
  const locale = r.d.ctx.settings.get().intel.speechLocale;
  const s = await r.d.helper.speech(r.jobDir as string, file, locale, r.duration ?? INTEL_READ_LIMITS.speechMaxSec, r.signal);
  if (!s.ok) {
    r.note(s.why === 'timeout' ? INTEL_READ_NOTES.speechSlow : INTEL_READ_NOTES.noAudio);
    if (r.done === 'full') r.done = 'standard';
    return;
  }
  if ('error' in s.value) {
    const notes: Record<string, string> = {
      noSpeech: INTEL_READ_NOTES.noSpeech,
      noAudio: INTEL_READ_NOTES.noSound,
      noModel: INTEL_READ_NOTES.noSpeechModel,
      denied: INTEL_READ_NOTES.speechDenied,
      format: INTEL_READ_REASONS.format,
      unreadable: INTEL_READ_NOTES.noAudio,
      failed: INTEL_READ_NOTES.noAudio,
    };
    r.note(notes[s.value.error] ?? INTEL_READ_NOTES.noAudio);
    if (r.done === 'full') r.done = 'standard';
    return;
  }
  r.transcript = segmentsText(s.value.segments);
  if (s.value.cut) r.note(INTEL_READ_NOTES.transcriptCut);
  if (!r.transcript && r.done === 'full') {
    r.note(INTEL_READ_NOTES.noSpeech);
    r.done = 'standard';
  }
}

// ---------------------------------------------------------------- Claude and the lines

const POSTS: ReadonlySet<IntelPlatform> = new Set(['instagram', 'youtube', 'tiktok', 'x', 'reddit', 'linkedin']);

async function claudeInput(r: Run): Promise<ReadInput> {
  const f = r.fields;
  const full = r.job.depth === 'full';
  const shown = r.job.depth === 'light' ? [] : evenly(r.frames, full ? INTEL_READ_LIMITS.framesFull : INTEL_READ_LIMITS.framesStandard);
  const images: { label: string; jpeg: Buffer }[] = [];
  if (r.job.depth !== 'light' && r.coverClaude) {
    const b = await readFile(r.coverClaude).catch(() => null);
    if (b) images.push({ label: 'Cover', jpeg: b });
  }
  for (const [k, fr] of shown.entries()) {
    const b = await readFile(fr.file).catch(() => null);
    if (!b) continue;
    const label = fr.at !== null && r.realFrames ? `Frame ${k + 1} of ${shown.length}, at ${stamp(fr.at)}` : `Image ${k + 1} of the post`;
    images.push({ label, jpeg: b });
  }
  let host: string | undefined;
  try {
    if (r.link) host = new URL(r.link).hostname;
  } catch {
    // no host
  }
  const post = POSTS.has(r.kind.platform);
  return {
    item: { platform: r.kind.platform, type: typeOf(r), ...(host ? { host } : {}), depth: r.job.depth, ...(r.probed !== undefined ? { duration: r.probed } : {}) },
    byline: { ...(f.creator || f.handle ? { creator: [f.creator, f.handle].filter(Boolean).join(' ') } : {}), ...(f.postedAt ? { postedAt: f.postedAt } : {}) },
    ...(r.job.note ? { note: r.job.note } : {}),
    ...(post && f.text ? { caption: f.text } : {}),
    ...(f.title ? { title: f.title } : {}),
    ...(!post && f.text ? { pageText: f.text } : {}),
    meta: f.meta,
    ...(f.comments?.length ? { comments: f.comments } : {}),
    onScreen: r.onScreen,
    ...(r.transcript ? { transcript: r.transcript } : {}),
    related: r.related,
    images,
  };
}

function typeOf(r: Run): string {
  if (r.kind.platform === 'web') return r.fields.article ? 'article' : 'link';
  return r.kind.type;
}

/** Thumbnails: the cover (n = 0) and the frames Claude saw, 320 px, ≤ 60 KB each; none past the 1 GiB cap. */
async function thumbs(r: Run): Promise<number> {
  if (!r.helperOk || !r.jobDir) return baseFrames(r);
  const intelDir = r.d.ctx.paths.intelDir;
  if ((await mediaBytes(intelDir)) > INTEL_READ_LIMITS.mediaDirBytes) {
    r.note(INTEL_READ_NOTES.mediaFull);
    return baseFrames(r);
  }
  const files: string[] = [];
  if (r.coverThumb) files.push(r.coverThumb);
  if (r.job.depth !== 'light') {
    const shown = evenly(r.frames, r.job.depth === 'full' ? INTEL_READ_LIMITS.framesFull : INTEL_READ_LIMITS.framesStandard);
    for (const [k, fr] of shown.entries()) {
      const t = await encode(r, fr.file, `thumb-${k}`, INTEL_READ_LIMITS.thumbEdge);
      if (t) files.push(t);
    }
  }
  const bytes: Buffer[] = [];
  for (const file of files.slice(0, INTEL_READ_LIMITS.thumbsMax)) {
    const st = await stat(file).catch(() => null);
    if (!st || st.size > INTEL_READ_LIMITS.thumbBytes) continue;
    const b = await readFile(file).catch(() => null);
    if (b && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) bytes.push(b);
  }
  // None made this time: the item keeps the thumbnails it had.
  if (bytes.length === 0) return baseFrames(r);
  return putThumbs(intelDir, r.job.rid, bytes);
}

function baseFrames(r: Run): number {
  const f = r.job.base.frames;
  return typeof f === 'number' && Number.isInteger(f) && f >= 0 ? Math.min(f, INTEL_READ_LIMITS.thumbsMax) : 0;
}

/** The name and the handle (`Example Cook @example_cook`), so a search for either finds the item; the handle once. */
export function creatorOf(f: Pick<PageFields, 'creator' | 'handle'>): string | undefined {
  if (!f.creator || !f.handle) return f.creator ?? f.handle;
  const bare = f.handle.replace(/^@/, '').toLowerCase();
  return bare && f.creator.toLowerCase().includes(bare) ? f.creator : `${f.creator} ${f.handle}`;
}

/** The fields every last line carries (the item's own, then what the read found). */
function common(r: Run, frames: number): CaptureLine {
  const f = r.fields;
  const base = r.job.base;
  const line: CaptureLine = { id: r.job.rid, captured_at: base.captured_at as string, title: r.job.title };
  if (r.link) line.url = r.link;
  line.platform = r.kind.platform;
  line.type = typeOf(r);
  const creator = creatorOf(f);
  if (creator) line.creator = creator.slice(0, 80);
  if (f.postedAt) line.posted_at = f.postedAt;
  if (f.text) line.caption = f.text.slice(0, INTEL_READ_LIMITS.captionMax);
  if (r.onScreenAll) line.on_screen = r.onScreenAll;
  if (r.transcript) line.transcript = keepTranscript(r.transcript);
  if (r.job.note) line.note = r.job.note;
  if (base.via !== undefined) line.via = base.via;
  if (r.job.userTags.length) line.tags = r.job.userTags;
  line.frames = frames;
  line.depth = r.job.depth;
  return line;
}

function readOf(r: Run, state: 'saved' | 'failed', reason?: string): Record<string, unknown> {
  return {
    state,
    depth: r.job.depth,
    ...(state === 'saved' ? { done: r.done } : {}),
    ...(r.tier ? { tier: r.tier } : {}),
    ...(reason ? { reason } : {}),
    ...(r.notes.length ? { notes: r.notes.slice(0, 3) } : {}),
    at: r.d.ctx.clock.iso(),
  };
}

/**
 * The failed line: the item as it was (a failed Read again keeps its old
 * summary, tags and thumbnails), with what this read found over it.
 */
function failed(r: Run, reason: string, frames = baseFrames(r)): CaptureLine {
  const { read: _queued, ...keep } = r.job.base;
  const found = common(r, frames);
  const line: CaptureLine = { ...keep, id: r.job.rid };
  for (const [k, v] of Object.entries(found)) {
    if (k === 'title' || k === 'tags' || v === undefined) continue;
    line[k] = v;
  }
  if (!r.job.keepTitle && r.fields.title && r.kind.platform !== 'note') line.title = r.fields.title.slice(0, 300);
  line.read = readOf(r, 'failed', reason);
  return line;
}

async function saved(r: Run, a: { title: string; summary: string; tags: string[]; points: string[]; why?: string; creator?: string; background?: string }, frames: number): Promise<CaptureLine> {
  const line = common(r, frames);
  line.title = a.title;
  line.what_it_is = a.summary;
  if (a.why) line.why_it_matters = a.why;
  const tags = [...r.job.userTags];
  for (const t of a.tags) if (!tags.some((x) => x.toLowerCase() === t)) tags.push(t);
  if (tags.length) line.tags = tags.slice(0, 20);
  if (a.points.length) line.points = a.points;
  if (!line.creator && a.creator) line.creator = a.creator;
  if (a.background && r.job.depth === 'full') line.background = a.background;
  line.read = readOf(r, 'saved');
  return line;
}

export { READ_MODEL, READ_PROMPT_VERSION };
