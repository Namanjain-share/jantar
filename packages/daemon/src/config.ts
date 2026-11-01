/**
 * Paths, settings and binaries.
 *
 * - Everything Jantar owns lives under `~/.jantar` (or $JANTAR_HOME), mode 0700.
 * - config.json is written atomically (temp file in the same dir, fsync,
 *   rename) with mode 0600, and only by the daemon.
 * - Read-only inputs (Claude's and cswap's files, ccw's files) are derived
 *   from the user home, which tests replace with a synthetic one.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_NAME,
  HOME_ENV,
  HOOK_NAME,
  LEGACY_DB_FILE,
  LEGACY_HOME_ENV,
  LIFE_DB_FILE,
  MEETINGS_DB_FILE,
  PRODUCT_NAME,
  SETTINGS_VERSION,
  STATE_DIR_NAME,
  SettingsSchema,
  V03_LAUNCH_FLAGS,
  applySettingsPatch,
  defaultSettings,
  type AccountsMode,
  type PatchResult,
  type Settings,
} from '@jantar/protocol';
import type { Bins, DaemonRole, Logger, Paths, SettingsStore, Unsubscribe } from './contracts.js';
import { silentLogger } from './core/log.js';

export type Env = Readonly<Record<string, string | undefined>>;

/** Overrides the built web app location (dev and packaging). */
export const WEB_DIST_ENV = 'JANTAR_WEB_DIST';

const here = dirname(fileURLToPath(import.meta.url));
/** packages/daemon (both from src/ and from dist/). */
const daemonPackageDir = resolve(here, '..');

export interface ResolvePathsOptions {
  env?: Env;
  /** The user home whose Claude / cswap / ccw files are read. Default: $HOME, then os.homedir(). */
  userHome?: string;
  /** The Jantar state dir. Default: $JANTAR_HOME, then the old $CCW_V2_HOME, then <userHome>/.jantar. */
  home?: string;
  /** v0.6: the platform the paths are for (cswap's folder, the sockets as named pipes on win32). Default: process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * v0.6: where cswap keeps its files. `~/.claude-swap-backup` on macOS and
 * Windows; on Linux (and WSL) `${XDG_DATA_HOME:-~/.local/share}/claude-swap`,
 * read only while that folder exists, so a Linux machine with no cswap there
 * (and the test homes, which lay cswap out the macOS way) reads as before.
 */
export function cswapRootFor(userHome: string, env: Env, platform: NodeJS.Platform): string {
  const legacy = join(userHome, '.claude-swap-backup');
  if (platform !== 'linux') return legacy;
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(userHome, '.local', 'share');
  const linux = join(xdg, 'claude-swap');
  return existsSync(linux) ? linux : legacy;
}

/**
 * v0.6: the named pipe that stands for a Unix socket on Windows:
 * `\\.\pipe\jantar-<first 16 hex of sha256(norm(stateDir))>-<kind>`, where
 * norm resolves the path, writes it with backslashes, drops a trailing one
 * and lower-cases it, so every spelling of one state dir gives one name.
 * The hook client (packages/hook/bin/jantar-hook.mjs) repeats these lines.
 */
export function pipePath(stateDir: string, kind: 'hooks' | 'ctl'): string {
  const norm = win32.resolve(stateDir).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const hash = createHash('sha256').update(norm).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\jantar-${hash}-${kind}`;
}

/** v0.6: a node when `<state dir>/node/node.json` exists (written by `jantar node join`), else the hub. */
export function roleOf(paths: Pick<Paths, 'nodeFile'>): DaemonRole {
  return existsSync(paths.nodeFile) ? 'node' : 'hub';
}

/** The state dir the environment names: $JANTAR_HOME, else the old $CCW_V2_HOME, else none. */
export function stateDirFromEnv(env: Env): string | undefined {
  return env[HOME_ENV] || env[LEGACY_HOME_ENV] || undefined;
}

/** The one-line deprecation warning while only the old $CCW_V2_HOME names the state dir, else null. */
export function legacyHomeWarning(env: Env): string | null {
  if (env[HOME_ENV] || !env[LEGACY_HOME_ENV]) return null;
  return `${LEGACY_HOME_ENV} is deprecated: set ${HOME_ENV} instead (using ${env[LEGACY_HOME_ENV]} for now).`;
}

/**
 * Why jantard and the CLI refuse to run on this state dir, or null. A
 * ccw-v2 state dir (its ccw-v2.db and no jantar.db, typically named by the
 * old $CCW_V2_HOME) would get an empty jantar.db beside the old one, so
 * every paired phone and push subscription would be gone, and its
 * config.json would be migrated in place. The way over is the import.
 */
export function legacyStateDirRefusal(paths: Pick<Paths, 'home' | 'dbFile'>): string | null {
  if (!existsSync(join(paths.home, LEGACY_DB_FILE)) || existsSync(paths.dbFile)) return null;
  return `${paths.home} is a ccw-v2 state dir. Set ${HOME_ENV} to a new folder and run: ${CLI_NAME} import-ccw-v2 --from ${paths.home}`;
}

export function resolvePaths(opts: ResolvePathsOptions = {}): Paths {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  // Windows: the profile Claude Code uses (USERPROFILE, as os.homedir()), never a HOME that MSYS2 or Emacs set.
  const userHome = resolve(opts.userHome ?? ((platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()));
  const home = resolve(opts.home ?? (stateDirFromEnv(env) || join(userHome, STATE_DIR_NAME)));
  const runDir = join(home, 'run');
  const claudeHome = join(userHome, '.claude');
  const cswapRoot = cswapRootFor(userHome, env, platform);
  const ccwDir = join(userHome, '.config', 'ccw');
  const ccwSwitchDir = join(ccwDir, 'switch');
  return {
    home,
    configFile: join(home, 'config.json'),
    dbFile: join(home, 'jantar.db'),
    runDir,
    // v0.6: Windows has no Unix sockets; the daemon and its clients meet on named pipes.
    hooksSock: platform === 'win32' ? pipePath(home, 'hooks') : join(runDir, 'hooks.sock'),
    ctlSock: platform === 'win32' ? pipePath(home, 'ctl') : join(runDir, 'ctl.sock'),
    logsDir: join(home, 'logs'),
    pushDir: join(home, 'push'),
    vapidFile: join(home, 'push', 'vapid.json'),
    binDir: join(home, 'bin'),
    hookBin: join(home, 'bin', HOOK_NAME),
    webDist: resolve(env[WEB_DIST_ENV] || join(daemonPackageDir, '..', 'web', 'dist')),
    shotsDir: join(runDir, 'shots'),
    rewriteDir: join(home, 'rewrite'),
    assetsDir: join(daemonPackageDir, 'assets'),
    lifeDb: join(home, LIFE_DB_FILE),
    backupsDir: join(home, 'backups'),
    intelDir: join(home, 'intel'),
    foodEstimateDir: join(home, 'food-estimate'),
    uploadsDir: join(home, 'uploads'),
    meetingsDb: join(home, MEETINGS_DB_FILE),
    meetingsDir: join(home, 'meetings'),
    meetingSummaryDir: join(home, 'meeting-summary'),
    fleetDir: join(home, 'fleet'),
    hubKeyFile: join(home, 'fleet', 'hub-key.pem'),
    nodeDir: join(home, 'node'),
    nodeFile: join(home, 'node', 'node.json'),

    userHome,
    claudeHome,
    claudeSettings: join(claudeHome, 'settings.json'),
    claudeProjects: join(claudeHome, 'projects'),
    cswapRoot,
    cswapProfiles: join(cswapRoot, 'sessions'),
    cswapSequence: join(cswapRoot, 'sequence.json'),
    cswapUsageCache: join(cswapRoot, 'cache', 'usage.json'),
    ccwDir,
    ccwSwitchDir,
    ccwSwitchJson: join(ccwDir, 'switch.json'),
    ccwBurnJson: join(ccwSwitchDir, 'burn.json'),
    ccwActiveJson: join(ccwDir, 'active.json'),
  };
}

/** macOS caps Unix socket paths at 104 bytes (including the NUL). */
export const MAX_SOCKET_PATH = 103;

export function socketPathOk(path: string): boolean {
  // v0.6: a Windows named pipe has no such limit.
  return isPipePath(path) || Buffer.byteLength(path) <= MAX_SOCKET_PATH;
}

/** v0.6: a Windows named pipe (`\\.\pipe\...`), not a socket file: no lstat, chmod or unlink. */
export function isPipePath(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\');
}

/**
 * Create the state dirs (0700). Never touches anything outside `paths.home`.
 * v0.6: on Windows the modes do nothing and a failed chmod is not an error
 * (the profile's ACL protects the folder).
 */
export async function ensureStateDirs(paths: Paths, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (const dir of [paths.home, paths.runDir, paths.logsDir, paths.pushDir, paths.binDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(dir, 0o700);
    } catch (e) {
      if (platform !== 'win32') throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic file writes

export interface AtomicWriteOptions {
  /** File mode (default 0o600). */
  mode?: number;
  /**
   * Write to the symlink's target instead of replacing the symlink (so other
   * links pointing at the same target keep working). Default false.
   */
  followSymlink?: boolean;
}

/** Write `data` to `path` via a temp file in the same directory, fsync and rename. */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  let target = path;
  if (opts.followSymlink) {
    try {
      target = await realpath(path);
    } catch {
      target = path;
    }
  }
  const mode = opts.mode ?? 0o600;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const fh = await open(tmp, 'wx', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  try {
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Settings

export interface LoadedSettings {
  settings: Settings;
  /** Set when config.json exists but could not be used; defaults were returned and the file left alone. */
  error?: string;
  /** False when config.json does not exist yet. */
  exists: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A config file written before v0.4: version 1, or no version at all. */
function isVersion1(json: Record<string, unknown>): boolean {
  return !('version' in json) || json.version === 1;
}

/**
 * The version-1 to version-2 change, in memory: v0.3's launch defaults
 * (skip, Chrome, ultracode) and its `cs-shell` mode where the file set none
 * (v0.4's defaults are the safe ones, and `claude` mode), then version 2.
 * Nothing about accounts: `accounts.kept` starts empty and ccw's hold list
 * keeps being read live. A file v0.3 wrote already holds every key, so only
 * the version changes for it.
 */
export function upgradeV1Settings(json: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const launch: Record<string, unknown> = isPlainObject(json.launch) ? { ...json.launch } : {};
  if (!('defaultFlags' in launch)) launch.defaultFlags = { ...V03_LAUNCH_FLAGS };
  if (!('mode' in launch)) launch.mode = 'cs-shell';
  return { ...json, launch, version: SETTINGS_VERSION };
}

export async function loadSettings(paths: Pick<Paths, 'configFile'>): Promise<LoadedSettings> {
  let raw: string;
  try {
    raw = await readFile(paths.configFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { settings: defaultSettings(), exists: false };
    return { settings: defaultSettings(), exists: true, error: `cannot read config: ${(e as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { settings: defaultSettings(), exists: true, error: `config is not valid JSON: ${(e as Error).message}` };
  }
  // A version-1 file not migrated yet (the CLI reading it while no daemon runs) reads as it will after the migration.
  if (isPlainObject(json) && isVersion1(json)) json = upgradeV1Settings(json);
  const parsed = SettingsSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      settings: defaultSettings(),
      exists: true,
      error: `config is invalid at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`,
    };
  }
  return { settings: parsed.data, exists: true };
}

export async function saveSettings(paths: Pick<Paths, 'configFile'>, settings: Settings): Promise<void> {
  const valid = SettingsSchema.parse(settings);
  await mkdir(dirname(paths.configFile), { recursive: true, mode: 0o700 });
  await writeFileAtomic(paths.configFile, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Settings file migration (version 1 -> 2, v0.4)

/** What the migration answers while another daemon owns the state dir (the daemon exits 1, the CLI 2). */
export function anotherDaemonReason(home: string): string {
  return `Another ${PRODUCT_NAME} daemon is using ${home}. Stop it first, or point ${HOME_ENV} at a test folder.`;
}

/** Whether something accepts connections on the Unix socket at `sock` (a stale socket file refuses them). */
export function socketAnswers(sock: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    const c = connect(sock);
    const finish = (yes: boolean) => {
      clearTimeout(timer);
      c.removeAllListeners();
      c.destroy();
      done(yes);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    c.once('connect', () => finish(true));
    c.once('error', () => finish(false));
  });
}

export type MigrateResult = { ok: true; migrated: boolean } | { ok: false; reason: string };

export interface MigrateOptions {
  /** Whether a daemon answers on the control socket (tests). Default: a connect to the socket. */
  daemonAnswers?: (sock: string) => Promise<boolean>;
}

/**
 * Migrate config.json from version 1 to 2 (spec 3.2). Called by the daemon
 * before its settings store opens and by the CLI before it writes the file
 * itself. Only a file whose version is 1 or missing is touched, so a second
 * call does nothing:
 *
 *   0. while a daemon answers on paths.ctlSock, nothing is written and the
 *      answer is the sentence that says so (a stale socket file is no daemon)
 *   1. the file is copied byte for byte to config.json.v1 (0600), only when
 *      that copy does not exist yet: rolling back to v0.3 is copying it back
 *   2. upgradeV1Settings, then an atomic 0600 write
 *
 * A missing file, one that is not JSON, or one that is not an object is
 * left alone (loadSettings reports it).
 */
export async function migrateSettingsFile(paths: Pick<Paths, 'configFile' | 'ctlSock' | 'home'>, opts: MigrateOptions = {}): Promise<MigrateResult> {
  let raw: string;
  try {
    raw = await readFile(paths.configFile, 'utf8');
  } catch {
    return { ok: true, migrated: false };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: true, migrated: false };
  }
  if (!isPlainObject(json) || !isVersion1(json)) return { ok: true, migrated: false };
  const answers = opts.daemonAnswers ?? ((sock: string) => socketAnswers(sock));
  if (await answers(paths.ctlSock)) return { ok: false, reason: anotherDaemonReason(paths.home) };
  const backup = `${paths.configFile}.v1`;
  try {
    await copyFile(paths.configFile, backup, fsConstants.COPYFILE_EXCL);
    await chmod(backup, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  await writeFileAtomic(paths.configFile, `${JSON.stringify(upgradeV1Settings(json), null, 2)}\n`, { mode: 0o600 });
  return { ok: true, migrated: true };
}

// ---------------------------------------------------------------------------
// Accounts mode (v0.4)

/** JANTAR_ACCOUNTS=single forces single-account mode (tests, and trying it on a Mac that has cswap). */
export const ACCOUNTS_ENV = 'JANTAR_ACCOUNTS';

/**
 * One Claude login or many, decided once at start: "cswap" when cswap is
 * there (bins.cswap) and so are its profiles (paths.cswapProfiles), else
 * "single". No setting: the environment variable forces single.
 *
 * v0.6, on a node: Windows has no cswap, so its config dirs are its accounts
 * ("dirs"); Linux with no cswap is "dirs" too. A Mac node, and every hub,
 * keeps the rule above.
 */
export function resolveAccountsMode(
  bins: Pick<Bins, 'cswap'>,
  paths: Pick<Paths, 'cswapProfiles'>,
  env: Env,
  where: { role?: DaemonRole; platform?: NodeJS.Platform } = {},
): AccountsMode {
  const platform = where.platform ?? process.platform;
  if (where.role === 'node' && platform === 'win32') return 'dirs';
  if (env[ACCOUNTS_ENV] === 'single') return 'single';
  if (bins.cswap && existsSync(paths.cswapProfiles)) return 'cswap';
  return where.role === 'node' && platform === 'linux' ? 'dirs' : 'single';
}

/**
 * The daemon's settings: one in-memory copy, writes serialized so concurrent
 * patches never lose each other's changes.
 */
export class FileSettingsStore implements SettingsStore {
  private current: Settings;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(next: Settings, prev: Settings) => void>();

  constructor(
    private readonly paths: Pick<Paths, 'configFile'>,
    initial: Settings,
    private readonly log: Logger = silentLogger,
  ) {
    this.current = initial;
  }

  static async open(paths: Pick<Paths, 'configFile'>, log: Logger = silentLogger): Promise<FileSettingsStore> {
    const loaded = await loadSettings(paths);
    if (loaded.error) log.warn('using default settings', { error: loaded.error });
    return new FileSettingsStore(paths, loaded.settings, log);
  }

  get(): Settings {
    return this.current;
  }

  patch(patch: unknown): Promise<PatchResult> {
    const run = async (): Promise<PatchResult> => {
      const result = applySettingsPatch(this.current, patch);
      if (!result.ok) return result;
      await saveSettings(this.paths, result.settings);
      const prev = this.current;
      this.current = result.settings;
      for (const fn of [...this.listeners]) {
        try {
          fn(this.current, prev);
        } catch (e) {
          this.log.error('settings listener threw', { error: String(e) });
        }
      }
      return result;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  subscribe(fn: (next: Settings, prev: Settings) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

/** Settings held in memory only (tests). */
export class MemorySettingsStore implements SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<(next: Settings, prev: Settings) => void>();

  constructor(initial: Settings = defaultSettings()) {
    this.current = initial;
  }

  get(): Settings {
    return this.current;
  }

  async patch(patch: unknown): Promise<PatchResult> {
    const result = applySettingsPatch(this.current, patch);
    if (result.ok) {
      const prev = this.current;
      this.current = result.settings;
      for (const fn of [...this.listeners]) fn(this.current, prev);
    }
    return result;
  }

  subscribe(fn: (next: Settings, prev: Settings) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

// ---------------------------------------------------------------------------
// Binaries

const WELL_KNOWN: Record<keyof Omit<Bins, 'node'>, (userHome: string) => string[]> = {
  ps: () => ['/bin/ps', '/usr/bin/ps'],
  osascript: () => ['/usr/bin/osascript'],
  lsof: () => ['/usr/sbin/lsof', '/usr/bin/lsof'],
  cswap: (h) => [join(h, '.local', 'bin', 'cswap'), '/opt/homebrew/bin/cswap', '/usr/local/bin/cswap'],
  // ~/.claude/local/claude: the older "local" install, which a shell alias reaches, not PATH.
  claude: (h) => [join(h, '.local', 'bin', 'claude'), join(h, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  terminalNotifier: () => ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'],
  screencapture: () => ['/usr/sbin/screencapture'],
  tmux: () => ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'],
  sips: () => ['/usr/bin/sips'],
};

const COMMAND_NAME: Record<keyof Omit<Bins, 'node'>, string> = {
  ps: 'ps',
  osascript: 'osascript',
  lsof: 'lsof',
  cswap: 'cswap',
  claude: 'claude',
  terminalNotifier: 'terminal-notifier',
  screencapture: 'screencapture',
  tmux: 'tmux',
  sips: 'sips',
};

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveBinsOptions {
  settings: Settings;
  env?: Env;
  userHome: string;
  /** Search $PATH too (install time / CLI). The daemon itself passes false. Default true. */
  usePath?: boolean;
  /** v0.6: on win32 `<name>.exe` is looked for first, as the CLI's finder does. Default: process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Absolute paths for every external program: settings.bins first, then $PATH
 * (when allowed), then well-known locations. `ps` falls back to /bin/ps.
 */
export async function resolveBins(opts: ResolveBinsOptions): Promise<Bins> {
  const env = opts.env ?? process.env;
  const pathDirs = opts.usePath === false ? [] : (env.PATH ?? '').split(delimiter).filter(Boolean);
  // Windows: claude.exe before npm's extensionless sh shim, which can be found but not started.
  const win = (opts.platform ?? process.platform) === 'win32';
  const find = async (key: keyof Omit<Bins, 'node'>): Promise<string | null> => {
    const configured = opts.settings.bins[key];
    if (configured) return (await isExecutable(configured)) ? configured : null;
    const names = win ? [`${COMMAND_NAME[key]}.exe`, COMMAND_NAME[key]] : [COMMAND_NAME[key]];
    for (const dir of pathDirs) {
      for (const name of names) {
        const p = join(dir, name);
        if (await isExecutable(p)) return p;
      }
    }
    for (const p of WELL_KNOWN[key](opts.userHome)) if (await isExecutable(p)) return p;
    return null;
  };
  return {
    node: opts.settings.bins.node || process.execPath,
    ps: (await find('ps')) ?? '/bin/ps',
    osascript: await find('osascript'),
    lsof: await find('lsof'),
    cswap: await find('cswap'),
    claude: await find('claude'),
    terminalNotifier: await find('terminalNotifier'),
    screencapture: await find('screencapture'),
    tmux: await find('tmux'),
    sips: await find('sips'),
  };
}
