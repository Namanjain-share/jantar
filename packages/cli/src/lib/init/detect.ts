/**
 * What `jantar init` and `jantar accounts` find on this Mac. Probes only:
 * file metadata, the executable finder (`which`-style, nothing is run) and
 * the daemon's /healthz. No command is started, nothing is written.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNTS_ENV, loadSettings, resolveAccountsMode } from '@jantar/daemon';
import { CLI_NAME, PRODUCT_NAME, PROTOCOL_VERSION, ROUTES, type AccountsMode, type HealthResponse, type Settings } from '@jantar/protocol';
import { binFinder, type CliContext } from '../../command.js';
import { CtlUnavailableError, callDaemon } from '../../ctl.js';
import { MIN_NODE, countProfiles, parseVersion } from '../doctor.js';
import { readSettings } from '../settings.js';
import { isExecutable } from '../which.js';

/** Where macOS keeps Terminal.app (the only terminal Jantar drives so far). */
export const TERMINAL_APPS = ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'];

/** Folders `init` offers as roots when they exist (relative to $HOME). */
export const SUGGESTED_ROOTS = ['Desktop', 'Projects'];

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a Jantar daemon answers on ctl.sock, and whether it speaks this protocol. */
export type DaemonFound = { kind: 'none' } | { kind: 'this'; version: string } | { kind: 'other'; protocol: number; version: string };

export async function findDaemon(ctx: Pick<CliContext, 'ctl'>): Promise<DaemonFound> {
  try {
    const h = await callDaemon<HealthResponse>(ctx.ctl, 'GET', ROUTES.health.path, undefined, { timeoutMs: 3000 });
    return h.protocol === PROTOCOL_VERSION ? { kind: 'this', version: h.daemonVersion } : { kind: 'other', protocol: h.protocol, version: h.daemonVersion };
  } catch (e) {
    if (e instanceof CtlUnavailableError) return { kind: 'none' };
    throw e;
  }
}

/**
 * Why `init` and `accounts` stop when a daemon of another version answers:
 * its settings are not this version's shape (a v0.3 daemon has no accounts).
 */
export function otherDaemonText(command: string, d: Extract<DaemonFound, { kind: 'other' }>, home: string): string {
  return (
    `${CLI_NAME} ${command}: a ${PRODUCT_NAME} daemon of another version (${d.version}, protocol ${d.protocol}) is running for ${home}. ` +
    'Stop it first, or point JANTAR_HOME at a new folder.\n'
  );
}

export interface CswapFound {
  /** Its absolute path, or null when it is not installed. */
  bin: string | null;
  profiles: number;
  /** What the daemon decides at start (config.ts resolveAccountsMode), JANTAR_ACCOUNTS included. */
  mode: AccountsMode;
  /** JANTAR_ACCOUNTS=single forces single-account mode. */
  forcedSingle: boolean;
}

/**
 * cswap as the daemon would see it (config.ts resolveBins): settings.bins.cswap
 * when set (and only if it can run), else $PATH and the usual places.
 */
export async function findCswap(ctx: CliContext, settings: Settings): Promise<CswapFound> {
  const configured = settings.bins.cswap;
  const bin = configured ? ((await isExecutable(configured)) ? configured : null) : await binFinder(ctx)('cswap');
  const profiles = await countProfiles(ctx.paths.cswapProfiles);
  return {
    bin,
    profiles,
    mode: resolveAccountsMode({ cswap: bin }, ctx.paths, ctx.io.env),
    forcedSingle: ctx.io.env[ACCOUNTS_ENV] === 'single',
  };
}

export interface Detected {
  node: { version: string; ok: boolean };
  claude: string | null;
  cswap: CswapFound;
  mac: boolean;
  /** Terminal.app's path, when found. */
  terminal: string | null;
  config: { path: string; exists: boolean; error?: string };
  /** The running daemon's settings, else config.json's (or the defaults). */
  settings: Settings;
  daemon: DaemonFound;
  /** ~/Desktop, ~/Projects: the ones that exist. */
  suggestions: string[];
}

export interface DetectOptions {
  terminalApps?: readonly string[];
}

export async function detect(ctx: CliContext, opts: DetectOptions = {}): Promise<Detected> {
  const daemon = await findDaemon(ctx);
  const loaded = await loadSettings(ctx.paths);
  const settings = daemon.kind === 'this' ? (await readSettings(ctx)).settings : loaded.settings;
  const v = parseVersion(ctx.deps.nodeVersion);
  const nodeOk = v !== null && (v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]));
  let terminal: string | null = null;
  if (ctx.deps.platform === 'darwin') {
    for (const p of opts.terminalApps ?? TERMINAL_APPS) {
      if (await exists(p)) {
        terminal = p;
        break;
      }
    }
  }
  const suggestions: string[] = [];
  for (const name of SUGGESTED_ROOTS) {
    const p = join(ctx.paths.userHome, name);
    if (await isDir(p)) suggestions.push(p);
  }
  return {
    node: { version: ctx.deps.nodeVersion, ok: nodeOk },
    claude: settings.bins.claude ?? (await binFinder(ctx)('claude')),
    cswap: await findCswap(ctx, settings),
    mac: ctx.deps.platform === 'darwin',
    terminal,
    config: { path: ctx.paths.configFile, exists: loaded.exists, ...(loaded.error ? { error: loaded.error } : {}) },
    settings,
    daemon,
    suggestions,
  };
}
