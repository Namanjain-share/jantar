/**
 * Boot jantard in-process against a synthetic HOME.
 *
 * It runs the production wiring, `startDaemon()` from
 * packages/daemon/src/daemon.ts (the same function main.ts calls), so the
 * end-to-end tests exercise exactly what `jantard` runs. Differences from
 * production, all on purpose:
 *
 * - HOME, JANTAR_HOME and PATH come from makeFakeHome(); every binary in
 *   settings.bins points at a fake one (cswap, ps, osascript, lsof, ...), and
 *   `claude` / `tmux` at paths that do not exist.
 * - The process probe is the fake home's (its pids are made up).
 * - The terminal is ScriptedTerminal (the frozen TerminalBackend contract),
 *   not Terminal.app: nothing here can type into a real tab. With
 *   `noTerminal` the daemon runs as `--no-terminal` and the scripted
 *   terminal is left unwired (its event lists must stay empty).
 * - The TCP port is a free random one on 127.0.0.1; the cswap poller is off.
 * - Web Push sends nothing: its sender records each payload (`webPushes`).
 *   v0.5.3: while `pushOffline()` says so, it fails the way a Mac with no
 *   network does (getaddrinfo ENOTFOUND) and records nothing.
 * - v0.4: a test may pass a clock it moves forward (warp-clock.ts) and
 *   `restart()` the daemon on the same home (a Life catch-up).
 * - v0.4.2: with `terminalApp` the daemon runs the real Terminal.app
 *   backend (the one constant AppleScript, argv only) against the fake
 *   home's `osascript` instead, so a test sees the exact argv of every
 *   compare-and-type write; ScriptedTerminal is then left unwired.
 *
 * `loadFactories()` separately checks that every factory docs/LAYOUT.md
 * promises exists where it says, typed as a function.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createMemoryDb,
  memoryLogger,
  type Clock,
  type DaemonContext,
  type DbOpener,
  type ExecFile,
  type Notification,
  type Notifier,
  type Parts,
  type TerminalBackend,
} from '@jantar/daemon';
import { PANE_LOOKUP_TIMEOUT_MS } from '@jantar/daemon/api/services';
import { startDaemon, type RunningDaemon } from '@jantar/daemon/daemon';
import { TerminalAppBackend } from '@jantar/daemon/terminal/terminal-app/index';
import { makeFakeHome, perfBudgetMs, type FakeHome, type FakeHomeOptions } from '@jantar/fixtures';
import { ScriptedTerminal } from './scripted-terminal.js';

const DAEMON_SRC = fileURLToPath(new URL('../../packages/daemon/src/', import.meta.url));

/** Where each part's factory lives (docs/LAYOUT.md, "Must export"). */
export const FACTORY_MODULES = {
  db: ['db/index.ts', 'openSqliteDb'],
  ccwLegacy: ['sources/ccw-legacy/index.ts', 'createCcwLegacySource'],
  sessions: ['sources/claude-files/index.ts', 'createSessionSource'],
  transcripts: ['sources/transcripts/index.ts', 'createTranscriptReader'],
  transcriptWatcher: ['sources/transcripts/index.ts', 'createTranscriptWatcher'],
  usage: ['sources/cswap/index.ts', 'createUsageSource'],
  hooks: ['hooks/index.ts', 'createHooksBridge'],
  terminal: ['terminal/terminal-app/index.ts', 'createTerminalAppBackend'],
  writer: ['writer/index.ts', 'createWriter'],
  notifiers: ['notify/index.ts', 'createNotifiers'],
  files: ['files/index.ts', 'createFilesService'],
  changes: ['files/index.ts', 'createChangesService'],
  rewrite: ['rewrite/index.ts', 'createRewriteService'],
  launcher: ['launcher/index.ts', 'createLauncher'],
  controls: ['controls/index.ts', 'createControlsService'],
  notifications: ['notify/index.ts', 'createNotificationRouter'],
  api: ['api/index.ts', 'createApiServer'],
} as const satisfies Record<string, readonly [string, string]>;

type FactoryName = keyof typeof FACTORY_MODULES;

export interface FactoryLoad {
  /** "<part> (<file>: <export>)" for every factory whose module is missing. */
  missing: string[];
}

/** Check every documented factory module exists and exports a function. */
export async function loadFactories(): Promise<FactoryLoad> {
  const missing: string[] = [];
  for (const [name, [file, exportName]] of Object.entries(FACTORY_MODULES) as Array<[FactoryName, readonly [string, string]]>) {
    const path = join(DAEMON_SRC, file);
    if (!existsSync(path)) {
      missing.push(`${name} (packages/daemon/src/${file}: ${exportName})`);
      continue;
    }
    const mod = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as Record<string, unknown>;
    if (typeof mod[exportName] !== 'function') throw new Error(`packages/daemon/src/${file} does not export ${exportName} (docs/LAYOUT.md)`);
  }
  return { missing };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

export interface Daemon {
  home: FakeHome;
  ctx: DaemonContext;
  parts: Parts;
  running: RunningDaemon;
  /** The scripted terminal (not wired into the daemon when booted with `noTerminal` or `terminalApp`). */
  terminal: ScriptedTerminal;
  port: number;
  log: ReturnType<typeof memoryLogger>;
  /** Every notification the router fanned out (a recording channel next to Web Push). */
  pushed: Notification[];
  /** Every push Web Push sent: the subscription's endpoint, the payload as it would leave the Mac (JSON, before encryption) and its TTL in seconds. */
  webPushes: Array<{ endpoint: string; payload: string; ttl: number }>;
  /**
   * Stop the daemon and start it again on the same home, settings and clock
   * (ctx, parts and running change); `between` runs while it is down (move
   * the clock, damage a file).
   */
  restart(between?: () => void | Promise<void>): Promise<void>;
  /** Stop every service, close the db, remove the fake home. */
  stop(): Promise<void>;
}

export interface BootOptions {
  home?: FakeHomeOptions;
  /** Extra settings merged into config.json before the daemon starts (or made from the fake home). */
  settings?: Record<string, unknown> | ((home: FakeHome) => Record<string, unknown>);
  /** Runs on the fake home before the daemon first starts (v0.4: a Mac with no cswap). */
  before?: (home: FakeHome) => Promise<void>;
  /** Run as `jantard --read-only`. */
  readOnly?: boolean;
  /** Run as `jantard --no-terminal`. */
  noTerminal?: boolean;
  /** Default: SQLite (openSqliteDb), as in production. */
  openDb?: DbOpener;
  /** A ScriptedTerminal of the test's own (a subclass that adds new windows or control keys). */
  terminal?: (home: FakeHome) => ScriptedTerminal;
  /** Default the system clock (v0.4: a WarpClock the test moves to a Life ping's time). */
  clock?: Clock;
  /** Extra environment for the daemon (v0.4: JANTAR_ACCOUNTS). */
  env?: Record<string, string>;
  /**
   * v0.4.2: the real Terminal.app backend against the fake `osascript` and
   * `ps` (the test sets the osascript rules: a tab's `find` and `contents`).
   * `wrapExec` sees every program that backend runs and may change the fake
   * tab when a write lands, as terminal-app.fakebin.test.ts does in the
   * daemon's own tests.
   */
  terminalApp?: { wrapExec?: (exec: ExecFile, home: FakeHome) => ExecFile };
  /**
   * v0.5.3: no network while this answers true. Web Push then fails as on a
   * Mac asleep or off Wi-Fi (the DNS lookup of the push service), records
   * nothing, and the push counts as one that never left the Mac.
   */
  pushOffline?: () => boolean;
}

/** What Node's fetch of a push service throws with no network: the DNS lookup failed, no HTTP status. */
export function noNetworkError(host = 'fcm.googleapis.com'): Error {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: host });
}

/**
 * The Terminal.app backend on the fake home's binaries. Its platform is
 * darwin whatever the host: the fake osascript is a node script, so this
 * runs on CI's Linux runner too.
 */
function fakeTerminalApp(ctx: DaemonContext, home: FakeHome, opts: NonNullable<BootOptions['terminalApp']>): TerminalBackend {
  const exec = opts.wrapExec ? opts.wrapExec(ctx.exec, home) : ctx.exec;
  return new TerminalAppBackend({ ...ctx, exec }, { platform: 'darwin' });
}

/**
 * settings.bins for a fake home: every binary is a fake, claude and tmux do not
 * exist (a Rewrite reaches the fake claude through `cswap run -- -p` and the
 * fake home's PATH).
 */
export function fakeBinsSettings(home: FakeHome): Record<string, string> {
  const nowhere = join(home.root, 'not-installed');
  return {
    node: process.execPath,
    cswap: home.bins.cswap,
    ps: home.bins.ps,
    osascript: home.bins.osascript,
    lsof: home.bins.lsof,
    terminalNotifier: home.bins.terminalNotifier,
    screencapture: home.bins.screencapture,
    claude: join(nowhere, 'claude'),
    tmux: join(nowhere, 'tmux'),
    sips: home.bins.sips,
  };
}

export async function bootDaemon(opts: BootOptions = {}): Promise<Daemon> {
  // The daemon runs on the real clock, so the synthetic files are dated "now" too
  // (otherwise the usage cache looks months old).
  const home = await makeFakeHome({ now: Date.now(), ...opts.home });
  try {
    await opts.before?.(home);
    const port = await freePort();
    const settings = {
      remote: { port },
      usage: { poller: 'off' },
      notify: { settle_ms: 0 },
      bins: fakeBinsSettings(home),
      ...(typeof opts.settings === 'function' ? opts.settings(home) : opts.settings),
    };
    await writeFile(join(home.jantarHome, 'config.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

    const log = memoryLogger();
    const terminal = opts.terminal ? opts.terminal(home) : new ScriptedTerminal(home);
    const pushed: Notification[] = [];
    const recorder: Notifier = {
      channel: 'webpush',
      async send(n) {
        pushed.push(n);
        return { delivered: 1, failed: 0 };
      },
    };
    const webPushes: Daemon['webPushes'] = [];
    const start = () =>
      startDaemon({
        env: { ...home.env, ...opts.env },
        log,
        usePath: true,
        proc: home.probe,
        readOnly: opts.readOnly === true,
        terminal: opts.noTerminal ? false : opts.terminalApp ? (ctx) => fakeTerminalApp(ctx, home, opts.terminalApp!) : () => terminal,
        rotateLogs: false,
        extraNotifiers: () => [recorder],
        pushSender: async (subscription, payload, options) => {
          if (opts.pushOffline?.()) throw noNetworkError();
          webPushes.push({ endpoint: subscription.endpoint, payload, ttl: options.TTL });
        },
        ...(opts.openDb ? { openDb: opts.openDb } : {}),
        ...(opts.clock ? { clock: opts.clock } : {}),
        // The fake osascript and ps are node scripts: on a busy CI runner the pair can take longer than a Mac's
        // real Terminal gets to find a tab.
        ...(opts.terminalApp ? { api: { paneLookupTimeoutMs: perfBudgetMs(PANE_LOOKUP_TIMEOUT_MS) } } : {}),
      });
    const running = await start();
    const d: Daemon = {
      home,
      ctx: running.ctx,
      parts: running.parts,
      running,
      terminal,
      port: running.address()?.port ?? port,
      log,
      pushed,
      webPushes,
      async restart(between) {
        await d.running.stop();
        await between?.();
        const next = await start();
        Object.assign(d, { running: next, ctx: next.ctx, parts: next.parts, port: next.address()?.port ?? port });
      },
      async stop() {
        try {
          await d.running.stop();
        } finally {
          await home.cleanup();
        }
      },
    };
    return d;
  } catch (e) {
    await home.cleanup();
    throw e;
  }
}

/** The in-memory Db, for a run without SQLite. */
export const memoryDbOpener: DbOpener = () => createMemoryDb();

/** One write the Terminal.app backend sent to a fake tab, and what the fake osascript answered. */
export interface FakeTabWrite {
  /** The tab's tty, as `/dev/ttysNNN`. */
  tty: string;
  /** `type` (a plain `do script`) or `typeif` (compare-and-type). */
  mode: 'type' | 'typeif';
  /** The bytes before Terminal's Return. */
  bytes: string;
  /** typeif only: the text the tab had to still show (v0.5.2: around Claude's countdown, its parts in order). */
  expected?: string | string[];
  /** What the fake printed: `ok`, or `__JANTAR_CHANGED__` when the tab no longer showed `expected`. */
  out: string;
}

/** What a test does around a tab's writes: `before` runs ahead of the write (the Mac changing in the gap), `after` once it is answered (Claude drawing its next screen). */
export interface FakeTabHooks {
  before?: (w: Omit<FakeTabWrite, 'out'>) => void | Promise<void>;
  after?: (w: FakeTabWrite) => void | Promise<void>;
}

/**
 * v0.4.2: Terminal tabs as the fake `osascript` shows them to the real
 * Terminal.app backend (BootOptions.terminalApp). `show(tty, screen)` sets
 * what a tab's `contents` reads (Terminal's text, 44 rows); `wrap` is the
 * backend's exec: it records every write to a tab and runs that tab's
 * hooks. The fake osascript itself decides a `typeif`, comparing like the
 * script (test/fixtures/runtime/fake-bin.mjs).
 */
export class FakeTabs {
  readonly writes: FakeTabWrite[] = [];
  private readonly screens = new Map<string, string>();
  private readonly hooks = new Map<string, FakeTabHooks>();

  constructor(private readonly home: FakeHome) {}

  /** The tab on `tty` now shows `screen`. */
  async show(tty: string, screen: string): Promise<void> {
    this.screens.set(tty, screen);
    const rules = [...this.screens].flatMap(([t, text], i) => [
      { match: { argsPrefix: ['-', t, 'find'] }, stdout: `ok\n${701 + i}\n1\ndemo — claude\n` },
      { match: { argsPrefix: ['-', t, 'contents'] }, stdout: `ok\n44\n${text}\n` },
      { match: { argsPrefix: ['-', t, 'type'] }, stdout: 'ok\n' },
    ]);
    await this.home.setRules('osascript', rules, { stdout: '__JANTAR_MISSING__\n' });
  }

  /** What the tab on `tty` shows now. */
  screen(tty: string): string {
    return this.screens.get(tty) ?? '';
  }

  /** Run `hooks` around every later write to the tab on `tty` (replacing the ones before). */
  on(tty: string, hooks: FakeTabHooks): void {
    this.hooks.set(tty, hooks);
  }

  /** The writes to one tab, in order. */
  writesTo(tty: string): FakeTabWrite[] {
    return this.writes.filter((w) => w.tty === tty);
  }

  /** The backend's exec: writes to a tab are recorded and hooked; every other program runs as it is. */
  wrap(exec: ExecFile): ExecFile {
    return async (file, args, opts) => {
      const mode = args[2];
      const tty = args[1] ?? '';
      if (!file.endsWith('/osascript') || (mode !== 'type' && mode !== 'typeif')) return exec(file, args, opts);
      const expected = args.length > 5 ? args.slice(4) : (args[4] ?? '');
      const w = { tty, mode, bytes: args[3] ?? '', ...(mode === 'typeif' ? { expected } : {}) } as const;
      const hooks = this.hooks.get(tty);
      await hooks?.before?.(w);
      const r = await exec(file, args, opts);
      const done: FakeTabWrite = { ...w, out: r.stdout.trim() };
      this.writes.push(done);
      if (done.out === 'ok') await hooks?.after?.(done);
      return r;
    };
  }
}
