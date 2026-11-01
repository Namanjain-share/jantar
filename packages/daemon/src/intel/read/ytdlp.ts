/**
 * yt-dlp, the last way to a video file (spec 3.6 3b): optional (absent, the
 * tier is unavailable with its note), for Instagram, YouTube, X and TikTok
 * only, with the platform's own extractor (never `generic`), single-file
 * formats only (no `+` merge, so ffmpeg is never needed), and every
 * connection through the guard's CONNECT proxy.
 *
 * Every run: `ctx.exec` (argv only), cwd and HOME = the job dir,
 * PATH=/usr/bin:/bin (no Homebrew, so no ffmpeg is reachable), 120 s. Never
 * `--cookies…` (other than the `--no-` forms), `--exec`,
 * `--remote-components`, `--js-runtimes`, `--impersonate`,
 * `--ffmpeg-location`, `-x`, `--embed-*`, `--remux-video` or
 * `--recode-video` (test G8 pins the argv).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { INTEL_READ_LIMITS, type IntelPlatform } from '@jantar/protocol';
import type { DaemonContext } from '../../contracts.js';
import { insideJob } from './media.js';

/** Each platform's yt-dlp extractor (its IE_NAME): never `generic`. */
export const YTDLP_EXTRACTORS: Partial<Record<IntelPlatform, string>> = {
  instagram: 'Instagram',
  youtube: 'youtube',
  x: 'twitter',
  tiktok: 'TikTok',
};

/** One-file mp4 with sound over http, avc1 first (AVFoundation reads it; no merge). */
export const VIDEO_FORMAT = 'b[ext=mp4][vcodec^=avc1][acodec!=none][protocol^=http]/b[ext=mp4][acodec!=none][protocol^=http]';
export const AUDIO_FORMAT = 'ba[ext=m4a][protocol^=http]';

export type YtdlpMode = { kind: 'metadata' } | { kind: 'video' } | { kind: 'audio' } | { kind: 'captions'; lang: string };

/** The argv for one run (everything before the link is ours; the link comes after `--`). */
export function ytdlpArgv(platform: IntelPlatform, url: string, jobDir: string, proxyPort: number, mode: YtdlpMode): string[] | null {
  const extractor = YTDLP_EXTRACTORS[platform];
  if (!extractor) return null;
  const lang = mode.kind === 'captions' && /^[a-z]{2,3}$/.test(mode.lang) ? mode.lang : 'en';
  const modeFlags: string[] =
    mode.kind === 'metadata'
      ? ['--skip-download', '-J']
      : mode.kind === 'video'
        ? ['-f', VIDEO_FORMAT]
        : mode.kind === 'audio'
          ? ['-f', AUDIO_FORMAT]
          : ['--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'json3', '--sub-langs', `${lang}-orig,${lang}`];
  return [
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-cookies',
    '--no-cookies-from-browser',
    '--no-cache-dir',
    '--use-extractors',
    extractor,
    '--no-playlist',
    '--socket-timeout',
    '20',
    '--retries',
    '1',
    '--max-filesize',
    '150M',
    '--no-part',
    '--no-mtime',
    '--no-progress',
    '--quiet',
    '--no-warnings',
    '--fixup',
    'never',
    '--proxy',
    `http://127.0.0.1:${proxyPort}`,
    '-P',
    jobDir,
    '-o',
    'media.%(ext)s',
    ...(mode.kind === 'metadata' ? [] : ['--print', 'after_move:filepath']),
    ...modeFlags,
    '--',
    url,
  ];
}

export type YtdlpResult = { ok: true; stdout: string } | { ok: false; why: 'unavailable' | 'failed' | 'timeout' };

export class YtDlp {
  private versionCache: string | null | undefined;

  constructor(private readonly ctx: Pick<DaemonContext, 'exec' | 'bins'>) {}

  get found(): boolean {
    return this.ctx.bins.ytDlp !== null;
  }

  /** `yt-dlp --version` (status), cached. */
  async version(): Promise<string | null> {
    const bin = this.ctx.bins.ytDlp;
    if (!bin) return null;
    if (this.versionCache !== undefined) return this.versionCache;
    const r = await this.ctx.exec(bin, ['--version'], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 15_000, maxBuffer: 4096 });
    const v = r.code === 0 ? r.stdout.trim().slice(0, 40) : '';
    this.versionCache = /^[0-9A-Za-z._-]{1,40}$/.test(v) ? v : null;
    return this.versionCache;
  }

  async run(platform: IntelPlatform, url: string, jobDir: string, proxyPort: number, mode: YtdlpMode, signal?: AbortSignal): Promise<YtdlpResult> {
    const bin = this.ctx.bins.ytDlp;
    const argv = ytdlpArgv(platform, url, jobDir, proxyPort, mode);
    if (!bin || !argv) return { ok: false, why: 'unavailable' };
    const r = await this.ctx.exec(bin, argv, {
      cwd: jobDir,
      env: { PATH: '/usr/bin:/bin', HOME: jobDir },
      timeoutMs: INTEL_READ_LIMITS.ytdlpMs,
      maxBuffer: mode.kind === 'metadata' ? 8 * 1024 * 1024 : 64 * 1024,
      ...(signal ? { signal } : {}),
    });
    if (r.timedOut) return { ok: false, why: 'timeout' };
    if (r.spawnError) return { ok: false, why: 'unavailable' };
    if (r.code !== 0) return { ok: false, why: 'failed' };
    return { ok: true, stdout: r.stdout };
  }

  /** The file a download wrote (`--print after_move:filepath`), checked to be inside the job dir. */
  async file(platform: IntelPlatform, url: string, jobDir: string, proxyPort: number, kind: 'video' | 'audio', signal?: AbortSignal): Promise<string | null> {
    const r = await this.run(platform, url, jobDir, proxyPort, { kind }, signal);
    if (!r.ok) return null;
    const printed = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    return printed ? insideJob(jobDir, printed) : null;
  }

  /** The video's language (`-J`), for its captions. */
  async language(url: string, jobDir: string, proxyPort: number, signal?: AbortSignal): Promise<string | null> {
    const r = await this.run('youtube', url, jobDir, proxyPort, { kind: 'metadata' }, signal);
    if (!r.ok) return null;
    try {
      const j = JSON.parse(r.stdout) as { language?: unknown };
      return typeof j.language === 'string' && /^[a-z]{2,3}/.test(j.language) ? j.language.slice(0, 3).replace(/[^a-z]/g, '') : null;
    } catch {
      return null;
    }
  }

  /** YouTube's captions (json3) as `[m:ss] text` lines, or null. */
  async captions(url: string, lang: string, jobDir: string, proxyPort: number, signal?: AbortSignal): Promise<string | null> {
    const r = await this.run('youtube', url, jobDir, proxyPort, { kind: 'captions', lang }, signal);
    if (!r.ok) return null;
    const files = (await readdir(jobDir).catch(() => [])).filter((f) => f.startsWith('media.') && f.endsWith('.json3')).sort();
    // The original language's ASR track first ("<lang>-orig"), else the manual one.
    const pick = files.find((f) => f.includes('-orig.')) ?? files[0];
    if (!pick) return null;
    const path = await insideJob(jobDir, join(jobDir, pick));
    if (!path) return null;
    const text = await readFile(path, 'utf8').catch(() => '');
    return json3Lines(text.length > 8 * 1024 * 1024 ? '' : text);
  }
}

/** "m:ss" (or "h:mm:ss"). */
export function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** json3 caption events as `[m:ss] text` lines (consecutive repeats dropped). */
export function json3Lines(text: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const events = (j as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return null;
  const out: string[] = [];
  let last = '';
  for (const e of events) {
    if (typeof e !== 'object' || e === null) continue;
    const ev = e as { tStartMs?: unknown; segs?: unknown };
    if (!Array.isArray(ev.segs)) continue;
    const words = ev.segs
      .map((s) => (typeof s === 'object' && s !== null && typeof (s as { utf8?: unknown }).utf8 === 'string' ? (s as { utf8: string }).utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!words || words === last) continue;
    last = words;
    out.push(`[${stamp(Number(ev.tStartMs ?? 0) / 1000)}] ${words}`);
  }
  return out.length ? out.join('\n') : null;
}
