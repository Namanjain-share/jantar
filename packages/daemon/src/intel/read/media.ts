/**
 * The Mac's media helper, `jantar-media` (spec 5.1): one Swift program
 * (assets/intel/jantar-media.swift) built once on the Mac and run under
 * sandbox-exec for every untrusted file. No ffmpeg, no avconvert: Apple's
 * AVFoundation, Speech, Vision and PDFKit inside the helper.
 *
 * Build (state `preparing`, once): only when /usr/bin/xcode-select -p exits
 * 0 and the dir it prints holds usr/bin/swiftc (Command Line Tools) or the
 * Xcode toolchain's, then `/usr/bin/swiftc -O -module-cache-path <fresh 0700
 * dir> -o <tmp> <src>` (env PATH=/usr/bin:/bin, HOME = the build dir, 180 s),
 * renamed into <intelDir>/bin (0700). The key (jantar-media.key) is
 * sha256(source) + `swiftc --version` + `sw_vers -buildVersion`: a change
 * rebuilds. Without the tools nothing is built (never the CLT install
 * dialog), and without /usr/bin/sandbox-exec the helper never runs.
 *
 * Run: `/usr/bin/sandbox-exec -f <profile> -D JOB=<real job dir> -D
 * HOME=<real home> -D HELPER=<real helper> <helper> <sub> …`, env exactly
 * PATH, HOME (the job dir) and TMPDIR (<job>/tmp/), each with a timeout and
 * a 256 KB output cap, one JSON line out, checked with zod. The helper is
 * only ever given regular files inside the job dir (real path checked here
 * and again in the helper), never a URL, and only after their magic bytes.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { z } from 'zod';
import { INTEL_READ_LIMITS } from '@jantar/protocol';
import type { DaemonContext } from '../../contracts.js';
import { ensureDir, intelDirs } from './files.js';
import { magicOf, IMAGE_MAGIC } from './guard.js';

export const HELPER_NAME = 'jantar-media';
export const HELPER_SOURCE = 'intel/jantar-media.swift';
export const HELPER_PROFILE = 'intel/jantar-media.sb';
/** The helper's environment PATH: no Homebrew, so no ffmpeg can be found. */
export const SAFE_PATH = '/usr/bin:/bin';
const SW_VERS = '/usr/bin/sw_vers';
const BUILD_MS = 180_000;
const OUTPUT_MAX = 256 * 1024;

/** Each subcommand's timeout (spec 5.1). */
export const HELPER_MS = {
  probe: 15_000,
  frames: 45_000,
  image: 15_000,
  ocr: 45_000,
  pdf: 30_000,
  locales: 15_000,
} as const;

/** speech: 30 s + min(duration, maxSec) / 5, at most 8 minutes. */
export function speechMs(durationSec: number, maxSec: number = INTEL_READ_LIMITS.speechMaxSec): number {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? Math.min(durationSec, maxSec) : maxSec;
  return Math.min(30_000 + (d / 5) * 1000, 8 * 60_000);
}

/** Why the helper can't run here (a note on the item), or null. */
export type HelperGap = 'noClt' | 'noSandbox';

// ---------------------------------------------------------------- output shapes

export const ProbeSchema = z.object({ duration: z.number().min(0), size: z.number().min(0), video: z.number().int().min(0), audio: z.number().int().min(0) });
export type Probe = z.infer<typeof ProbeSchema>;
export const FramesSchema = z.object({ frames: z.array(z.object({ file: z.string().regex(/^frame-\d{2}\.jpg$/), at: z.number().min(0) })).max(INTEL_READ_LIMITS.ocrFrames) });
export const ImageSchema = z.object({ w: z.number().int().min(1), h: z.number().int().min(1) });
export const OcrSchema = z.object({ results: z.array(z.object({ file: z.string().max(200), lines: z.array(z.string().max(500)).max(200) })).max(INTEL_READ_LIMITS.ocrFrames) });
export const SpeechSchema = z.union([
  z.object({ segments: z.array(z.object({ at: z.number().min(0), text: z.string().max(20_000) })).max(5_000), cut: z.boolean() }),
  z.object({ error: z.enum(['noSpeech', 'unreadable', 'format', 'noModel', 'denied', 'noAudio', 'failed']) }),
]);
export type SpeechOut = z.infer<typeof SpeechSchema>;
export const PdfSchema = z.object({
  text: z.string().max(INTEL_READ_LIMITS.pageTextMax + 100),
  title: z.string().max(2000).optional(),
  author: z.string().max(2000).optional(),
  pages: z.number().int().min(0),
  image: z.boolean(),
});
export const LocalesSchema = z.object({ locales: z.array(z.object({ id: z.string().max(40), onDevice: z.boolean() })).max(500) });

// ---------------------------------------------------------------- paths

/** The real path of `file` when it is a regular file inside `jobDir` (no symlink on the way), else null. */
export async function insideJob(jobDir: string, file: string): Promise<string | null> {
  try {
    const realJob = await realpath(jobDir);
    const real = await realpath(file);
    if (!real.startsWith(`${realJob}${sep}`)) return null;
    const st = await lstat(file);
    return st.isFile() && !st.isSymbolicLink() ? real : null;
  } catch {
    return null;
  }
}

/** The first bytes of a file. */
export async function headOf(file: string, n = 32): Promise<Buffer> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** What the helper may be given: `video` (mp4/mov/m4a), `image`, `pdf`; webm and mkv are `format`. */
export async function checkMagic(file: string, want: 'video' | 'image' | 'pdf'): Promise<'ok' | 'format' | 'type'> {
  const m = magicOf(await headOf(file).catch(() => Buffer.alloc(0)));
  if (want === 'video') return m === 'mp4' ? 'ok' : m === 'ebml' ? 'format' : 'type';
  if (want === 'image') return m && IMAGE_MAGIC.has(m) ? 'ok' : 'type';
  return m === 'pdf' ? 'ok' : 'type';
}

// ---------------------------------------------------------------- the helper

export type HelperRun<T> = { ok: true; value: T } | { ok: false; why: 'timeout' | 'failed' | 'unavailable' };

export class MediaHelper {
  private building: Promise<boolean> | null = null;
  private builtPath: string | null = null;

  constructor(private readonly ctx: Pick<DaemonContext, 'exec' | 'bins' | 'paths' | 'log'>) {}

  /** Why the helper can't run on this Mac, or null (it may still need building). */
  gap(): HelperGap | null {
    if (!this.ctx.bins.sandboxExec) return 'noSandbox';
    if (!this.ctx.bins.swiftc || !this.ctx.bins.xcodeSelect) return 'noClt';
    return null;
  }

  get helperPath(): string {
    return join(intelDirs(this.ctx.paths.intelDir).bin, HELPER_NAME);
  }

  /** Whether a helper built from this source is in place (status). */
  async built(): Promise<boolean> {
    if (this.builtPath) return true;
    try {
      await access(this.helperPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether Command Line Tools (or Xcode) are selected and hold swiftc; never starts their install. */
  async toolsFound(): Promise<boolean> {
    const xs = this.ctx.bins.xcodeSelect;
    if (!xs || !this.ctx.bins.swiftc) return false;
    const r = await this.ctx.exec(xs, ['-p'], { env: { PATH: SAFE_PATH }, timeoutMs: 10_000, maxBuffer: 8 * 1024 });
    if (r.code !== 0) return false;
    const dir = r.stdout.trim();
    if (!dir.startsWith('/') || dir.includes('\n')) return false;
    for (const p of [join(dir, 'usr', 'bin', 'swiftc'), join(dir, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin', 'swiftc')]) {
      try {
        await access(p, constants.X_OK);
        return true;
      } catch {
        // try the other
      }
    }
    return false;
  }

  /**
   * The helper, built when missing or its key changed (one build at a time).
   * False when it can't be (no tools, no sandbox, a failed build).
   */
  ensure(): Promise<boolean> {
    if (this.gap()) return Promise.resolve(false);
    this.building ??= this.build().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  /** Whether `ensure()` would have to build (the job then shows `preparing`). */
  async needsBuild(): Promise<boolean> {
    if (this.gap()) return false;
    const key = await this.key().catch(() => null);
    if (!key) return true;
    const have = await readFile(`${this.helperPath}.key`, 'utf8').catch(() => '');
    return have !== key || !(await this.built());
  }

  private async key(): Promise<string | null> {
    const swiftc = this.ctx.bins.swiftc;
    if (!swiftc) return null;
    const src = await readFile(join(this.ctx.paths.assetsDir, HELPER_SOURCE));
    const v = await this.ctx.exec(swiftc, ['--version'], { env: { PATH: SAFE_PATH }, timeoutMs: 30_000, maxBuffer: 16 * 1024 });
    const os = await this.ctx.exec(SW_VERS, ['-buildVersion'], { env: { PATH: SAFE_PATH }, timeoutMs: 10_000, maxBuffer: 1024 });
    if (v.code !== 0) return null;
    return createHash('sha256').update(src).update('\0').update(v.stdout.trim()).update('\0').update(os.stdout.trim()).digest('hex');
  }

  private async build(): Promise<boolean> {
    const swiftc = this.ctx.bins.swiftc;
    if (!swiftc || !(await this.toolsFound())) return false;
    const key = await this.key();
    if (!key) return false;
    const { bin } = intelDirs(this.ctx.paths.intelDir);
    if (!(await ensureDir(this.ctx.paths.intelDir)) || !(await ensureDir(bin))) return false;
    const have = await readFile(`${this.helperPath}.key`, 'utf8').catch(() => '');
    if (have === key && (await this.built())) {
      this.builtPath = this.helperPath;
      return true;
    }
    const work = await mkdtemp(join(bin, 'build-'));
    try {
      await ensureDir(work);
      const cache = join(work, 'module-cache');
      await ensureDir(cache);
      const tmp = join(work, HELPER_NAME);
      const r = await this.ctx.exec(swiftc, ['-O', '-module-cache-path', cache, '-o', tmp, join(this.ctx.paths.assetsDir, HELPER_SOURCE)], {
        cwd: work,
        env: { PATH: SAFE_PATH, HOME: work },
        timeoutMs: BUILD_MS,
        maxBuffer: 256 * 1024,
      });
      if (r.code !== 0) {
        this.ctx.log.warn('intel media helper did not build', { code: r.code, timedOut: r.timedOut });
        return false;
      }
      await rename(tmp, this.helperPath);
      const fh = await open(this.helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      await fh.chmod(0o700).finally(() => fh.close());
      await writeFile(`${this.helperPath}.key`, key, { mode: 0o600 });
      this.builtPath = this.helperPath;
      this.ctx.log.info('intel media helper built');
      return true;
    } catch (e) {
      this.ctx.log.warn('intel media helper did not build', { code: (e as NodeJS.ErrnoException).code ?? 'error' });
      return false;
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The exact argv and env of one sandboxed run (G9 pins them). */
  async command(jobDir: string, sub: string, args: readonly string[]): Promise<{ file: string; args: string[]; env: Record<string, string> } | null> {
    const sandbox = this.ctx.bins.sandboxExec;
    if (!sandbox) return null;
    const job = await realpath(jobDir);
    const home = await realpath(this.ctx.paths.userHome).catch(() => this.ctx.paths.userHome);
    const helper = await realpath(this.helperPath).catch(() => null);
    if (!helper) return null;
    const profile = join(this.ctx.paths.assetsDir, HELPER_PROFILE);
    await ensureDir(join(job, 'tmp'));
    return {
      file: sandbox,
      args: ['-f', profile, '-D', `JOB=${job}`, '-D', `HOME=${home}`, '-D', `HELPER=${helper}`, helper, sub, ...args],
      env: { PATH: SAFE_PATH, HOME: job, TMPDIR: `${job}/tmp/` },
    };
  }

  /** One run, its one JSON line checked by `schema`. */
  async run<T>(jobDir: string, sub: string, args: readonly string[], schema: z.ZodType<T>, timeoutMs: number, signal?: AbortSignal): Promise<HelperRun<T>> {
    if (this.gap() || !(await this.built())) return { ok: false, why: 'unavailable' };
    const cmd = await this.command(jobDir, sub, args);
    if (!cmd) return { ok: false, why: 'unavailable' };
    const r = await this.ctx.exec(cmd.file, cmd.args, { cwd: jobDir, env: cmd.env, timeoutMs, maxBuffer: OUTPUT_MAX, ...(signal ? { signal } : {}) });
    if (r.timedOut) return { ok: false, why: 'timeout' };
    const line = r.stdout.trim().split('\n').pop() ?? '';
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { ok: false, why: 'failed' };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, why: 'failed' };
  }

  /** Inputs inside the job dir (real paths), or null when one is not. */
  private async inputs(jobDir: string, files: readonly string[]): Promise<string[] | null> {
    const out: string[] = [];
    for (const f of files) {
      const real = await insideJob(jobDir, f);
      if (!real) return null;
      out.push(real);
    }
    return out;
  }

  async probe(jobDir: string, file: string, signal?: AbortSignal): Promise<HelperRun<Probe>> {
    const [f] = (await this.inputs(jobDir, [file])) ?? [];
    if (!f || (await checkMagic(f, 'video')) !== 'ok') return { ok: false, why: 'failed' };
    return this.run(jobDir, 'probe', [f], ProbeSchema, HELPER_MS.probe, signal);
  }

  /** n frames at `edge` px into `outDir` (inside the job dir). */
  async frames(jobDir: string, file: string, outDir: string, n: number, edge: number, signal?: AbortSignal): Promise<HelperRun<{ file: string; at: number }[]>> {
    const [f] = (await this.inputs(jobDir, [file])) ?? [];
    if (!f || (await checkMagic(f, 'video')) !== 'ok') return { ok: false, why: 'failed' };
    const out = await realpath(outDir).catch(() => null);
    const job = await realpath(jobDir);
    if (!out || !out.startsWith(`${job}${sep}`)) return { ok: false, why: 'failed' };
    const r = await this.run(jobDir, 'frames', [f, out, String(Math.max(1, Math.min(n, INTEL_READ_LIMITS.ocrFrames))), String(edge)], FramesSchema, HELPER_MS.frames, signal);
    return r.ok ? { ok: true, value: r.value.frames.map((x) => ({ file: join(out, x.file), at: x.at })) } : r;
  }

  /** Any still image re-encoded as a JPEG at `edge` px (no metadata). */
  async image(jobDir: string, input: string, output: string, edge: number, signal?: AbortSignal): Promise<HelperRun<{ w: number; h: number }>> {
    const [f] = (await this.inputs(jobDir, [input])) ?? [];
    if (!f || (await checkMagic(f, 'image')) !== 'ok') return { ok: false, why: 'failed' };
    const job = await realpath(jobDir);
    if (!output.startsWith(`${job}${sep}`)) return { ok: false, why: 'failed' };
    return this.run(jobDir, 'image', [f, output, String(edge)], ImageSchema, HELPER_MS.image, signal);
  }

  /** On-screen text of each image (≤ 20), in order. */
  async ocr(jobDir: string, files: readonly string[], signal?: AbortSignal): Promise<HelperRun<string[][]>> {
    const fs = await this.inputs(jobDir, files.slice(0, INTEL_READ_LIMITS.ocrFrames));
    if (!fs || fs.length === 0) return { ok: false, why: 'failed' };
    const r = await this.run(jobDir, 'ocr', fs, OcrSchema, HELPER_MS.ocr, signal);
    return r.ok ? { ok: true, value: fs.map((_f, i) => r.value.results[i]?.lines ?? []) } : r;
  }

  async speech(jobDir: string, file: string, locale: string, durationSec: number, signal?: AbortSignal): Promise<HelperRun<SpeechOut>> {
    const [f] = (await this.inputs(jobDir, [file])) ?? [];
    if (!f) return { ok: false, why: 'failed' };
    const magic = await checkMagic(f, 'video');
    if (magic === 'format') return { ok: true, value: { error: 'format' } };
    if (magic !== 'ok') return { ok: false, why: 'failed' };
    if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(locale)) return { ok: true, value: { error: 'noModel' } };
    const maxSec = INTEL_READ_LIMITS.speechMaxSec;
    return this.run(jobDir, 'speech', [f, locale, String(maxSec)], SpeechSchema, speechMs(durationSec, maxSec), signal);
  }

  /** PDF text (first 30 pages, ≤ 40,000 chars), title/author, page 1 as a JPEG. */
  async pdf(jobDir: string, file: string, out: string, edge: number, signal?: AbortSignal): Promise<HelperRun<z.infer<typeof PdfSchema>>> {
    const [f] = (await this.inputs(jobDir, [file])) ?? [];
    if (!f || (await checkMagic(f, 'pdf')) !== 'ok') return { ok: false, why: 'failed' };
    return this.run(jobDir, 'pdf', [f, out, String(edge), '30', String(INTEL_READ_LIMITS.pageTextMax)], PdfSchema, HELPER_MS.pdf, signal);
  }

  /** On-device speech locales (status). */
  async locales(jobDir: string): Promise<HelperRun<z.infer<typeof LocalesSchema>>> {
    return this.run(jobDir, 'locales', [], LocalesSchema, HELPER_MS.locales);
  }
}
