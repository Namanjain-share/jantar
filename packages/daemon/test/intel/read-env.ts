/**
 * A daemon-shaped Intel for read tests: a synthetic HOME in a temp dir, the
 * real Files policy, reading on, a fake ctx.exec (claude, and the media
 * helper's tools when a test asks for them), one Claude login (`claude -p`
 * on account 0), the shipped assets, and the tests' seams only:
 *
 * - `net`: a lookup that answers a public address and a dial that sends it
 *   to a local HTTPS server (read-helpers.ts seamFor), or, by default, to a
 *   closed local port: nothing ever leaves the Mac;
 * - `browser`: a fake playwright module, or by default one that fails to
 *   load, so no real browser ever starts in a unit test.
 *
 * No Swift compile, no real browser, no network.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema, type IntelJob, type Settings } from '@jantar/protocol';
import type { Bins, SessionSource } from '../../src/contracts.js';
import { createFakeExec, createTestContext, onCommand, type ExecCall, type ExecHandler, type TestContext } from '../../src/core/testing.js';
import { buildFilesService } from '../../src/files/service.js';
import type { IntelNetSeam, IntelOptions } from '../../src/intel/index.js';
import { IntelShelfService } from '../../src/intel/service.js';
import { FakeCcwLegacy, FakeUsage } from '../api/fakes.js';
import { PUBLIC_ADDR, TINY_JPEG, fakeLookup } from './read-helpers.js';

export const ASSETS = join(import.meta.dirname, '..', '..', 'assets');

const noSessions: SessionSource = {
  start: async () => {},
  stop: async () => {},
  scan: async () => [],
  current: () => [],
  accountForConfigDir: () => null,
};

/** No network: every vetted address is dialed at a closed local port. */
export const NO_NET: IntelNetSeam = {
  lookup: fakeLookup(),
  dial: () => ({ address: '127.0.0.1', port: 1 }),
};

/** No browser: the headless tier's module never loads. */
export const NO_BROWSER: NonNullable<IntelOptions['browser']> = {
  executablePath: '/nonexistent/test-chromium',
  load: async () => {
    throw new Error('no browser in unit tests');
  },
};

export const INIT_LINE = JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
export function resultLine(answer: unknown): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: typeof answer === 'string' ? answer : JSON.stringify(answer) });
}
export const ANSWER = {
  title: 'Three ways to cook dal',
  summary: 'A synthetic reel on cooking dal at home. It shows three ways.',
  tags: ['recipe', 'Dal'],
  points: ['Soak overnight'],
  why: 'A quick weeknight dinner.',
};

/** claude answering `answer` (stream-json with its init line). */
export function fakeClaude(answer: unknown = ANSWER, seen: ExecCall[] = []): ExecHandler {
  return onCommand('claude', (c) => {
    seen.push(c);
    return { stdout: `${INIT_LINE}\n${resultLine(answer)}\n` };
  });
}

/** claude that runs until its signal aborts (a job to stop). */
export function hangingClaude(started: { n: number } = { n: 0 }): ExecHandler {
  return (c) => {
    if (c.file.split('/').pop() !== 'claude') return undefined;
    started.n += 1;
    return new Promise((resolve) => {
      const end = () => resolve({ code: null, signal: 'SIGTERM', stdout: '' });
      if (c.opts.signal?.aborted) end();
      else c.opts.signal?.addEventListener('abort', end, { once: true });
    });
  };
}

/**
 * The media helper on a pretend Mac: Command Line Tools at `clt`, a build
 * that writes a stub binary, and sandbox-exec answering each subcommand the
 * way the Swift helper would (frames and images written into the job dir).
 */
export function fakeHelper(clt: string, o: { duration?: number; ocr?: (i: number) => string[]; speech?: unknown } = {}): ExecHandler[] {
  mkdirSync(join(clt, 'usr', 'bin'), { recursive: true });
  writeFileSync(join(clt, 'usr', 'bin', 'swiftc'), '', { mode: 0o755 });
  return [
    onCommand('xcode-select', { code: 0, stdout: `${clt}\n` }),
    onCommand('swiftc', (c) => {
      if (c.args[0] === '--version') return { stdout: 'Apple Swift version 6.0.3 (synthetic)\n' };
      writeFileSync(c.args[c.args.indexOf('-o') + 1] as string, '#!/bin/sh\n', { mode: 0o700 });
      return { code: 0 };
    }),
    onCommand('sw_vers', { stdout: '25G76\n' }),
    onCommand('sandbox-exec', (c) => {
      // The helper's own path comes after the -D params; the subcommand right after it.
      const helper = c.args.find((a) => a.startsWith('HELPER='))?.slice('HELPER='.length);
      const at = helper ? c.args.indexOf(helper) : -1;
      const sub = c.args[at + 1] as string;
      const args = c.args.slice(at + 2);
      switch (sub) {
        case 'probe':
          return { stdout: `${JSON.stringify({ duration: o.duration ?? 12, size: 1000, video: 1, audio: 1 })}\n` };
        case 'frames': {
          const n = Number(args[2]);
          const frames = Array.from({ length: n }, (_v, k) => {
            const file = `frame-${String(k).padStart(2, '0')}.jpg`;
            writeFileSync(join(args[1] as string, file), TINY_JPEG);
            return { file, at: ((k + 0.5) * (o.duration ?? 12)) / n };
          });
          return { stdout: `${JSON.stringify({ frames })}\n` };
        }
        case 'image':
          writeFileSync(args[1] as string, TINY_JPEG);
          return { stdout: '{"w":320,"h":180}\n' };
        case 'ocr':
          return { stdout: `${JSON.stringify({ results: args.map((file, i) => ({ file, lines: o.ocr ? o.ocr(i) : [`LINE ${i + 1}`] })) })}\n` };
        case 'speech':
          return { stdout: `${JSON.stringify(o.speech ?? { segments: [{ at: 1, text: 'hello from a synthetic voice' }], cut: false })}\n` };
        case 'pdf':
          writeFileSync(args[1] as string, TINY_JPEG);
          return { stdout: '{"text":"A synthetic PDF about example tools.","title":"Example PDF","pages":1,"image":true}\n' };
        case 'locales':
          return { stdout: '{"locales":[{"id":"en-IN","onDevice":true}]}\n' };
        default:
          return { code: 1 };
      }
    }),
  ];
}

/** The helper's bins on a pretend Mac. */
export const HELPER_BINS: Partial<Bins> = { swiftc: '/usr/bin/swiftc', xcodeSelect: '/usr/bin/xcode-select', sandboxExec: '/usr/bin/sandbox-exec' };

export interface ReadEnv {
  base: string;
  home: string;
  ctx: TestContext;
  exec: ReturnType<typeof createFakeExec>;
  intel: IntelShelfService;
  file: string;
  /** captures.jsonl, one object a line. */
  lines(): Record<string, unknown>[];
  /** Each item's last line, by id. */
  items(): Map<string, Record<string, unknown>>;
  /** Wait until no job is queued or running, then for the shelf's next pass. */
  idle(ms?: number): Promise<IntelJob[]>;
  cleanup(): Promise<void>;
}

export async function until<T>(fn: () => T | Promise<T>, ms = 5_000, what = 'a condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function readEnv(
  opts: {
    intel?: Partial<Settings['intel']>;
    remote?: Partial<Settings['remote']>;
    read?: IntelOptions;
    handlers?: ExecHandler[];
    bins?: Partial<Bins>;
    maxItems?: number;
    start?: boolean;
    base?: string;
  } = {},
): Promise<ReadEnv> {
  const base = opts.base ?? realpathSync(mkdtempSync(join(tmpdir(), 'jantar-read-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.jantar'), { recursive: true });
  const settings = SettingsSchema.parse({ intel: { enabled: true, read: true, ...opts.intel }, ...(opts.remote ? { remote: opts.remote } : {}) });
  const exec = createFakeExec(...(opts.handlers ?? [fakeClaude()]));
  const ctx = createTestContext({ userHome: home, home: join(home, '.jantar'), settings, exec, accountsMode: 'single', ...(opts.bins ? { bins: opts.bins } : {}) });
  ctx.paths.assetsDir = ASSETS;
  const files = buildFilesService(ctx, { sessions: noSessions, notifiers: [] });
  await files.start();
  const intel = new IntelShelfService(
    ctx,
    { files, usage: new FakeUsage(), ccwLegacy: new FakeCcwLegacy() },
    { watch: false, ...(opts.maxItems ? { maxItems: opts.maxItems } : {}), read: { net: NO_NET, browser: NO_BROWSER, ...opts.read } },
  );
  if (opts.start !== false) await intel.start();
  const file = join(ctx.paths.intelDir, 'captures.jsonl');
  const lines = () => {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  return {
    base,
    home,
    ctx,
    exec,
    intel,
    file,
    lines,
    items: () => new Map(lines().map((l) => [String(l.id), l])),
    async idle(ms = 8_000) {
      await until(() => {
        const c = intel.queue.counts();
        return c.waiting === 0 && c.running === 0;
      }, ms, 'the read queue to empty');
      await intel.refresh();
      return intel.jobs().jobs;
    },
    async cleanup() {
      await intel.stop();
      await files.stop();
      if (!opts.base) rmSync(base, { recursive: true, force: true });
    },
  };
}

export { PUBLIC_ADDR };
