/**
 * The tools a read starts, with no real browser, no yt-dlp and no Swift
 * compile (fake modules and a fake ctx.exec):
 * - G7: the headless tier's launch and context options exactly as spec 3.5;
 * - G8: yt-dlp's argv, env and refusals as spec 3.6 3b;
 * - G9: the media helper's build (xcode-select first, its own module
 *   cache), the sandboxed run (argv, env, params), no sandbox-exec → no
 *   run, job-dir files only, the profile's deny rules, no avconvert.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPage } from '@jantar/protocol/page-read';
import { createFakeExec, createTestContext, onCommand, type ExecCall } from '../../src/core/testing.js';
import { HELPER_PROFILE, MediaHelper, checkMagic, insideJob, speechMs } from '../../src/intel/read/media.js';
import { BrowserTier, CONTEXT_OPTIONS, SYSTEM_CHROME, browserEnv, launchOptions, type PwModule, type PwPage } from '../../src/intel/read/tiers/browser.js';
import { AUDIO_FORMAT, VIDEO_FORMAT, YtDlp, json3Lines, stamp, ytdlpArgv } from '../../src/intel/read/ytdlp.js';
import { TINY_JPEG } from './read-helpers.js';

const SRC = join(import.meta.dirname, '..', '..', 'src');
const ASSETS = join(import.meta.dirname, '..', '..', 'assets');
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-tools-')));
  dirs.push(d);
  return d;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// ---------------------------------------------------------------- G7

describe('G7: the headless browser tier', () => {
  function fakePw() {
    const calls: { launch?: Record<string, unknown>; context?: Record<string, unknown>; goto?: unknown[]; evaluated?: unknown; closed: number } = { closed: 0 };
    const mod: PwModule = {
      chromium: {
        launch: async (opts) => {
          calls.launch = opts;
          return {
            newContext: async (c) => {
              calls.context = c;
              return {
                close: async () => {},
                newPage: async () => ({
                  goto: async (...a: unknown[]) => {
                    calls.goto = a;
                    return null;
                  },
                  waitForTimeout: async () => {},
                  evaluate: (async (fn: unknown, arg: unknown) => {
                    calls.evaluated = { fn, arg };
                    return { finalUrl: 'https://www.example.test/a', meta: [], jsonld: [], text: 'hello', media: [], frames: [] };
                  }) as PwPage['evaluate'],
                }),
              };
            },
            close: async () => {
              calls.closed += 1;
            },
          };
        },
      },
    };
    return { mod, calls };
  }

  it('the system Chrome (channel chrome) at runtime; executablePath only from the seam; never a headless shell, video, HAR or screenshot', () => {
    const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.example.test:3128', http_proxy: 'x', NO_PROXY: 'y', HOME: '/h' };
    const run = launchOptions(4321, { env });
    expect(run).toEqual({
      headless: true,
      channel: 'chrome',
      proxy: { server: 'http://127.0.0.1:4321' },
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      env: { PATH: '/usr/bin', HOME: '/h' },
      timeout: 15_000,
    });
    expect(run).not.toHaveProperty('executablePath');
    const seam = launchOptions(4321, { env, executablePath: '/pw/chromium' });
    expect(seam).toMatchObject({ executablePath: '/pw/chromium' });
    expect(seam).not.toHaveProperty('channel');
    expect(CONTEXT_OPTIONS).toEqual({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 } });
    const all = JSON.stringify([run, seam, CONTEXT_OPTIONS]);
    for (const banned of ['recordVideo', 'recordHar', 'headless_shell', 'chromium-headless-shell', 'userDataDir', 'permissions']) expect(all).not.toContain(banned);
    expect(browserEnv({ ALL_PROXY: 'a', Socks_Proxy: 'b', KEEP: 'c' })).toEqual({ KEEP: 'c' });
    expect(SYSTEM_CHROME).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('one page: domcontentloaded, the bundled reader with capped frames, the browser always closed', async () => {
    const { mod, calls } = fakePw();
    const tier = new BrowserTier({ env: {}, executablePath: '/pw/chromium', load: async () => mod });
    const r = await tier.read('https://www.example.test/a', 'web', 99, 5555);
    expect(r.ok).toBe(true);
    expect(calls.launch).toMatchObject({ executablePath: '/pw/chromium', proxy: { server: 'http://127.0.0.1:5555' } });
    expect(calls.context).toEqual(CONTEXT_OPTIONS);
    expect(calls.goto).toEqual(['https://www.example.test/a', { waitUntil: 'domcontentloaded', timeout: 20_000 }]);
    expect(calls.evaluated).toEqual({ fn: readPage, arg: { platform: 'web', frames: 20, textMax: 40_000 } });
    expect(calls.closed).toBe(1);
  });

  it('playwright-core is imported only in tiers/browser.ts, lazily (never a static import)', () => {
    for (const f of walk(join(SRC, 'intel')).filter((p) => p.endsWith('.ts'))) {
      const text = readFileSync(f, 'utf8');
      if (f.endsWith(join('tiers', 'browser.ts'))) {
        expect(text).toMatch(/await import\('playwright-core'\)/);
        expect(text).not.toMatch(/^import [^;]*from 'playwright-core'/m);
      } else expect(text, f).not.toMatch(/from 'playwright-core'|import\('playwright-core'\)|require\('playwright-core'\)/);
    }
  });
});

// ---------------------------------------------------------------- G8

describe('G8: yt-dlp', () => {
  const FORBIDDEN = ['--cookies', '--cookies-from-browser', '--exec', '--remote-components', '--js-runtimes', '--impersonate', '--ffmpeg-location', '-x', '--extract-audio', '--remux-video', '--recode-video', '--load-info-json', '--config-locations'];

  it('the argv is exactly the spec\'s, for every mode', () => {
    const argv = ytdlpArgv('instagram', 'https://www.instagram.com/reel/AbC123xyz/', '/job', 7000, { kind: 'video' });
    expect(argv).toEqual([
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-cookies',
      '--no-cookies-from-browser',
      '--no-cache-dir',
      '--use-extractors',
      'Instagram',
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
      'http://127.0.0.1:7000',
      '-P',
      '/job',
      '-o',
      'media.%(ext)s',
      '--print',
      'after_move:filepath',
      '-f',
      VIDEO_FORMAT,
      '--',
      'https://www.instagram.com/reel/AbC123xyz/',
    ]);
    expect(ytdlpArgv('youtube', 'https://www.youtube.com/watch?v=AbCdEfGhIjK', '/job', 7000, { kind: 'metadata' })?.slice(-4)).toEqual(['--skip-download', '-J', '--', 'https://www.youtube.com/watch?v=AbCdEfGhIjK']);
    expect(ytdlpArgv('x', 'https://x.com/i/status/1234567890', '/job', 7000, { kind: 'audio' })).toContain(AUDIO_FORMAT);
    const caps = ytdlpArgv('youtube', 'https://www.youtube.com/watch?v=AbCdEfGhIjK', '/job', 7000, { kind: 'captions', lang: 'hi' }) as string[];
    expect(caps.slice(caps.indexOf('--skip-download'), -2)).toEqual(['--skip-download', '--write-subs', '--write-auto-subs', '--sub-format', 'json3', '--sub-langs', 'hi-orig,hi']);
    expect(ytdlpArgv('youtube', 'u', '/job', 1, { kind: 'captions', lang: 'x;rm' })).toContain('en-orig,en');
  });

  it('never a forbidden flag, a "+" format, ffmpeg or the generic extractor; Reddit, LinkedIn and web are never handed to it', () => {
    for (const platform of ['instagram', 'youtube', 'x', 'tiktok'] as const) {
      for (const mode of [{ kind: 'metadata' }, { kind: 'video' }, { kind: 'audio' }, { kind: 'captions', lang: 'en' }] as const) {
        const argv = ytdlpArgv(platform, 'https://example.test/', '/job', 1, mode) as string[];
        for (const f of FORBIDDEN) expect(argv, `${platform} ${mode.kind} ${f}`).not.toContain(f);
        expect(argv.join(' ').toLowerCase()).not.toContain('ffmpeg');
        expect(argv[argv.indexOf('--use-extractors') + 1]?.toLowerCase()).not.toBe('generic');
        const f = argv.indexOf('-f');
        if (f >= 0) expect(argv[f + 1]).not.toContain('+');
        expect(argv.at(-2)).toBe('--');
      }
    }
    for (const platform of ['reddit', 'linkedin', 'web', 'pdf', 'note'] as const) expect(ytdlpArgv(platform, 'https://example.test/', '/job', 1, { kind: 'video' })).toBeNull();
  });

  it('runs with PATH /usr/bin:/bin and HOME the job dir; absent, the tier is unavailable and nothing runs', async () => {
    const exec = createFakeExec(onCommand('yt-dlp', { stdout: '/job/media.mp4\n' }));
    const ctx = createTestContext({ exec, bins: { ytDlp: '/opt/fake/yt-dlp' } });
    const y = new YtDlp(ctx);
    await y.run('tiktok', 'https://www.tiktok.com/@example_cook/video/1234567890123', '/job', 9, { kind: 'video' });
    const call = exec.calls[0] as ExecCall;
    expect(call.file).toBe('/opt/fake/yt-dlp');
    expect(call.opts.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/job' });
    expect(call.opts.cwd).toBe('/job');
    expect(call.opts.timeoutMs).toBe(120_000);
    const none = createTestContext({ exec: createFakeExec() });
    const absent = new YtDlp(none);
    expect(absent.found).toBe(false);
    expect(await absent.run('x', 'https://x.com/i/status/1234567', '/job', 9, { kind: 'video' })).toEqual({ ok: false, why: 'unavailable' });
    expect(await absent.version()).toBeNull();
  });

  it('a printed file is used only inside the job dir; json3 captions become [m:ss] lines', async () => {
    const job = tmp();
    writeFileSync(join(job, 'media.mp4'), 'x');
    const outside = tmp();
    writeFileSync(join(outside, 'media.mp4'), 'x');
    const exec = createFakeExec((c) => (c.args.includes('-f') ? { stdout: `${c.args.includes(AUDIO_FORMAT) ? join(outside, 'media.mp4') : join(job, 'media.mp4')}\n` } : undefined));
    const y = new YtDlp(createTestContext({ exec, bins: { ytDlp: '/opt/fake/yt-dlp' } }));
    expect(await y.file('x', 'https://x.com/i/status/1234567', job, 9, 'video')).toBe(join(job, 'media.mp4'));
    expect(await y.file('x', 'https://x.com/i/status/1234567', job, 9, 'audio')).toBeNull();
    const json3 = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'Hello ' }, { utf8: 'there' }] }, { tStartMs: 62_500, segs: [{ utf8: 'second line' }] }, { tStartMs: 63_000, segs: [{ utf8: 'second line' }] }] });
    expect(json3Lines(json3)).toBe('[0:00] Hello there\n[1:02] second line');
    expect(json3Lines('not json')).toBeNull();
    expect(stamp(3725)).toBe('1:02:05');
  });
});

// ---------------------------------------------------------------- G9

describe('G9: the media helper', () => {
  function env(opts: { xcodeSelect?: { code: number; stdout: string }; sandbox?: boolean; cltDir?: string } = {}) {
    const home = tmp();
    const state = join(home, '.jantar');
    const exec = createFakeExec(
      onCommand('xcode-select', opts.xcodeSelect ?? { code: 0, stdout: `${opts.cltDir ?? '/nonexistent/clt'}\n` }),
      onCommand('swiftc', (c) => {
        if (c.args[0] === '--version') return { stdout: 'Apple Swift version 6.0.3 (synthetic)\n' };
        const out = c.args[c.args.indexOf('-o') + 1] as string;
        writeFileSync(out, '#!/bin/sh\n', { mode: 0o700 });
        return { code: 0 };
      }),
      onCommand('sw_vers', { stdout: '25G76\n' }),
      onCommand('sandbox-exec', { stdout: '{"duration":12.5,"size":100,"video":1,"audio":1}\n' }),
    );
    const ctx = createTestContext({
      userHome: home,
      home: state,
      exec,
      bins: { swiftc: '/usr/bin/swiftc', xcodeSelect: '/usr/bin/xcode-select', sandboxExec: opts.sandbox === false ? null : '/usr/bin/sandbox-exec' },
    });
    ctx.paths.assetsDir = ASSETS;
    return { home, ctx, exec, helper: new MediaHelper(ctx) };
  }

  it('checks xcode-select before swiftc; no Command Line Tools: nothing is built, nothing else runs', async () => {
    const e = env({ xcodeSelect: { code: 2, stdout: '' } });
    expect(await e.helper.ensure()).toBe(false);
    expect(e.exec.calls.map((c) => c.file)).toEqual(['/usr/bin/xcode-select']);
    expect(e.exec.calls[0]?.args).toEqual(['-p']);
    // Selected, but the dir holds no swiftc: still nothing.
    const e2 = env();
    expect(await e2.helper.ensure()).toBe(false);
    expect(e2.exec.calls.some((c) => c.file === '/usr/bin/swiftc')).toBe(false);
  });

  it('builds with its own fresh 0700 module cache, PATH /usr/bin:/bin, and keys the build', async () => {
    const clt = tmp();
    mkdirSync(join(clt, 'usr', 'bin'), { recursive: true });
    writeFileSync(join(clt, 'usr', 'bin', 'swiftc'), '', { mode: 0o755 });
    const e = env({ cltDir: clt });
    expect(await e.helper.ensure()).toBe(true);
    const build = e.exec.calls.find((c) => c.file === '/usr/bin/swiftc' && c.args[0] === '-O') as ExecCall;
    expect(build.args.slice(0, 2)).toEqual(['-O', '-module-cache-path']);
    const cache = build.args[2] as string;
    // Its own cache in a fresh build dir under <intelDir>/bin, never the shared one.
    expect(cache.startsWith(join(e.ctx.paths.intelDir, 'bin', 'build-'))).toBe(true);
    expect(cache.endsWith('module-cache')).toBe(true);
    expect(build.args.at(-1)).toBe(join(ASSETS, 'intel', 'jantar-media.swift'));
    expect(build.opts.env?.PATH).toBe('/usr/bin:/bin');
    const xs = e.exec.calls.findIndex((c) => c.file === '/usr/bin/xcode-select');
    expect(xs).toBe(0);
    expect(readFileSync(`${e.helper.helperPath}.key`, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    // The build dir is gone; a second ensure builds nothing.
    expect(readdirSync(join(e.ctx.paths.intelDir, 'bin')).filter((n) => n.startsWith('build-'))).toEqual([]);
    const before = e.exec.calls.length;
    expect(await new MediaHelper(e.ctx).ensure()).toBe(true);
    expect(e.exec.calls.slice(before).some((c) => c.args[0] === '-O')).toBe(false);
  });

  it('runs under sandbox-exec with JOB, HOME and HELPER params and exactly PATH, HOME and TMPDIR; never a URL', async () => {
    const clt = tmp();
    mkdirSync(join(clt, 'usr', 'bin'), { recursive: true });
    writeFileSync(join(clt, 'usr', 'bin', 'swiftc'), '', { mode: 0o755 });
    const e = env({ cltDir: clt });
    await e.helper.ensure();
    const job = join(e.ctx.paths.intelDir, 'jobs', 'J1');
    mkdirSync(job, { recursive: true });
    const video = join(job, 'video.mp4');
    writeFileSync(video, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]));
    const r = await e.helper.probe(job, video);
    expect(r).toEqual({ ok: true, value: { duration: 12.5, size: 100, video: 1, audio: 1 } });
    const call = e.exec.calls.at(-1) as ExecCall;
    const realJob = realpathSync(job);
    expect(call.file).toBe('/usr/bin/sandbox-exec');
    expect(call.args).toEqual([
      '-f',
      join(ASSETS, HELPER_PROFILE),
      '-D',
      `JOB=${realJob}`,
      '-D',
      `HOME=${realpathSync(e.home)}`,
      '-D',
      `HELPER=${realpathSync(e.helper.helperPath)}`,
      '-D',
      `HELPER_DIR=${realpathSync(join(e.ctx.paths.intelDir, 'bin'))}`,
      realpathSync(e.helper.helperPath),
      'probe',
      realpathSync(video),
    ]);
    expect(call.opts.env).toEqual({ PATH: '/usr/bin:/bin', HOME: realJob, TMPDIR: `${realJob}/tmp/` });
    expect(call.opts.maxBuffer).toBe(256 * 1024);
    // Never a URL, a file outside the job dir, a symlink, or the wrong magic.
    const n = e.exec.calls.length;
    expect(await e.helper.probe(job, 'https://www.example.test/v.mp4')).toEqual({ ok: false, why: 'failed' });
    const outside = join(tmp(), 'v.mp4');
    writeFileSync(outside, readFileSync(video));
    expect(await e.helper.probe(job, outside)).toEqual({ ok: false, why: 'failed' });
    symlinkSync(outside, join(job, 'link.mp4'));
    expect(await e.helper.probe(job, join(job, 'link.mp4'))).toEqual({ ok: false, why: 'failed' });
    writeFileSync(join(job, 'page.mp4'), '<html>');
    expect(await e.helper.probe(job, join(job, 'page.mp4'))).toEqual({ ok: false, why: 'failed' });
    expect(e.exec.calls.length).toBe(n);
  });

  it('no sandbox-exec on the Mac: the helper never runs (and is never built)', async () => {
    const e = env({ sandbox: false });
    expect(e.helper.gap()).toBe('noSandbox');
    expect(await e.helper.ensure()).toBe(false);
    const job = tmp();
    writeFileSync(join(job, 'a.jpg'), TINY_JPEG);
    expect(await e.helper.image(job, join(job, 'a.jpg'), join(job, 'b.jpg'), 320)).toEqual({ ok: false, why: 'unavailable' });
    expect(e.exec.calls).toEqual([]);
  });

  it('the shipped profile holds every deny rule and no /private/var/folders; no avconvert or ffmpeg anywhere in intel', () => {
    const sb = readFileSync(join(ASSETS, HELPER_PROFILE), 'utf8');
    const rules = sb.split('\n').filter((l) => !l.trim().startsWith(';')).join('\n');
    for (const rule of [
      '(deny network*)',
      '(deny process-fork)',
      '(deny process-exec*)',
      '(allow process-exec (literal (param "HELPER")))',
      '(deny file-read* (subpath (param "HOME")))',
      '(allow file-read* (literal (param "HELPER")) (subpath (param "JOB")))',
      '(deny file-write*)',
      '(allow file-write* (subpath (param "JOB")) (literal "/dev/null"))',
      '(global-name "com.apple.pasteboard.1")',
      '(global-name "com.apple.coreservices.launchservicesd")',
    ]) {
      expect(rules).toContain(rule);
    }
    expect(rules).not.toContain('/private/var/folders');
    // The one rule added for realpath(3): the metadata of the job dir's own ancestors, nothing wider under HOME.
    expect(rules.match(/\(allow [^)]*file-read[^\n]*/g)).toEqual([
      '(allow file-read* (literal (param "HELPER")) (subpath (param "JOB")))',
      '(allow file-read-metadata (path-ancestors (param "JOB")))',
      '(allow file-read* (literal (param "HELPER_DIR")))',
    ]);
    for (const f of [...walk(join(SRC, 'intel')), ...walk(join(ASSETS, 'intel'))]) {
      const text = readFileSync(f, 'utf8').toLowerCase();
      expect(text, f).not.toMatch(/avconvert|afconvert/);
      // Code only (comments may say why ffmpeg is never used).
      const code = text
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*|;)/.test(l))
        .join('\n');
      expect(code, f).not.toContain('ffmpeg');
    }
  });

  it('job-dir checks, magic, and the speech timeout', async () => {
    const job = tmp();
    writeFileSync(join(job, 'a.webm'), Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]));
    writeFileSync(join(job, 'a.jpg'), TINY_JPEG);
    expect(await checkMagic(join(job, 'a.webm'), 'video')).toBe('format');
    expect(await checkMagic(join(job, 'a.jpg'), 'image')).toBe('ok');
    expect(await checkMagic(join(job, 'a.jpg'), 'pdf')).toBe('type');
    expect(await insideJob(job, join(job, 'a.jpg'))).toBe(join(realpathSync(job), 'a.jpg'));
    expect(await insideJob(job, join(job, '..', 'x'))).toBeNull();
    expect(speechMs(60)).toBe(42_000);
    // 30 s + min(duration, 30 min) / 5, at most 8 minutes.
    expect(speechMs(10_000)).toBe(390_000);
  });
});
