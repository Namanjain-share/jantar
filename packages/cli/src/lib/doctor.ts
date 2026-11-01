/**
 * `jantar doctor`: read-only checks of everything Jantar depends on.
 *
 * Doctor never changes anything: it runs only `--version` / status commands
 * (`cswap --version`, `tailscale status --json`, `tailscale serve status
 * --json`, `pgrep -f`), reads file metadata, and asks the daemon for
 * /healthz. It never scripts Terminal.app (the Automation check is a hint
 * plus a look at the daemon's own log), never runs launchctl, and never
 * prints file contents from ~/.claude or cswap.
 *
 * v0.6 Fleet adds, read-only too: on the Mac with Fleet on, the front door
 * (one GET of `<publicUrl>/v1/node/pair` with no credentials: Cloudflare
 * Access should answer it, not Jantar) and whether the Mac sleeps on power
 * (`/usr/bin/pmset -g custom`); on a server, its link to the Mac, tmux,
 * procps, systemd lingering (`loginctl show-user`), WSL1 or WSL2 and its
 * keep-alive, virtualization on Windows (`systeminfo`), Claude's version on
 * Windows, and the hooks in each Claude config dir.
 */
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CSWAP_SCRUB_ENV, isPipePath, scrubEnv, socketPathOk, type DaemonRole, type ExecFile, type NodeFile, type Paths } from '@jantar/daemon';
import { MIN_CLAUDE_WINDOWS } from '@jantar/daemon/hooks/installer';
import { NODE_CLOSE, NODE_LINK_PATH } from '@jantar/protocol/node-link';
import { NODE_PREFIX, ROUTES, type HealthResponse, type Settings } from '@jantar/protocol';
import { CtlUnavailableError, callDaemon, isErrorBody, type CtlClient } from '../ctl.js';
import { daemonLogPaths, legacyAgentProblem, plistExists, plistPath } from './launchd.js';
import { LOGINCTL, lingerOn, unitPath } from './systemd.js';
import { probeTailscale } from './remote.js';
import type { SettingsRead } from './settings.js';
import { localBaseUrl } from './settings.js';
import { settingsMentionHook } from './hooks-files.js';
import { ago } from './text.js';
import type { BinFinder } from './which.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  counts: Record<CheckStatus, number>;
  checks: DoctorCheck[];
}

export interface DoctorInput {
  paths: Paths;
  env: Readonly<Record<string, string | undefined>>;
  exec: ExecFile;
  findBin: BinFinder;
  nodePath: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  settings: SettingsRead;
  ctl: CtlClient;
  portFree(host: string, port: number): Promise<boolean>;
  /** GET <url> and parse JSON; null when nothing answers. */
  httpJson(url: string): Promise<unknown | null>;
  daemonBin: string;
  now(): number;
  /** v0.6: hub (default) or node (config.ts roleOf: node.json exists). */
  role?: DaemonRole;
  /** v0.6, on a node: its node.json (never printed but its name and the hub's host). */
  nodeFile?: NodeFile | null;
  /** v0.6: a small text file's contents (/proc/sys/kernel/osrelease), or null. Default: read it. */
  readText?(path: string): Promise<string | null>;
  /** v0.6: whether a path exists (the default tmux server's socket). Default: stat it. */
  exists?(path: string): Promise<boolean>;
  /** v0.6: one GET with no credentials (the door probe). Default: fetch, no redirects followed. */
  probe?(url: string): Promise<ProbeResult | null>;
  /** v0.6: the user lingering is checked for (default $USER). */
  userName?: string;
  uid?: number;
}

/** v0.6: what one credential-less GET got back. */
export interface ProbeResult {
  status: number;
  /** A redirect's Location (an Access login page), else null. */
  location: string | null;
  /** The body is Jantar's JSON error shape: the request reached the daemon. */
  jantar: boolean;
}

export const MIN_NODE = [22, 13] as const;
export const CSWAP_SERIES = [0, 26] as const;
export const CCW_BOT_PATTERN = 'ccw --telegram';
/** Daemon log bytes scanned for the Automation error. */
const LOG_TAIL_BYTES = 256 * 1024;

export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const vstr = (v: readonly number[]) => v.join('.');

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function modeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mode & 0o777;
  } catch {
    return null;
  }
}

async function tail(path: string, bytes: number): Promise<string> {
  try {
    const fh = await open(path, 'r');
    try {
      const size = (await fh.stat()).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Individual checks

function checkPlatform(i: DoctorInput): DoctorCheck {
  if (i.platform === 'darwin') return { id: 'platform', title: 'macOS', status: 'ok', detail: 'macOS (launchd, Terminal.app)' };
  // v0.6: a Linux or Windows machine is a server joined to a Mac, never the hub.
  if (i.role === 'node' && i.platform === 'linux') return { id: 'platform', title: 'Platform', status: 'ok', detail: 'Linux server (systemd, tmux)' };
  if (i.role === 'node' && i.platform === 'win32') {
    return { id: 'platform', title: 'Platform', status: 'ok', detail: 'Windows server, preview (a task at logon; watch and cards)' };
  }
  return {
    id: 'platform',
    title: 'macOS',
    status: 'warn',
    detail: `${i.platform}: Jantar supports macOS only (launchd agent, Terminal.app)`,
    fix: 'on a server, join it to your Mac instead: jantar node join <line from jantar node pair>',
  };
}

function checkNode(i: DoctorInput): DoctorCheck {
  const v = parseVersion(i.nodeVersion);
  const ok = v !== null && (v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]));
  return ok
    ? {
        id: 'node',
        title: 'Node.js',
        status: 'ok',
        detail: `${i.nodeVersion} at ${i.nodePath} (launchd and the hooks run this exact binary; re-run "jantar install" after switching Node versions)`,
      }
    : {
        id: 'node',
        title: 'Node.js',
        status: 'fail',
        detail: `${i.nodeVersion} is too old; Jantar needs Node ${vstr(MIN_NODE)} or newer`,
        fix: 'install Node 22 LTS (for example: nvm install 22), then run jantar install again',
      };
}

function checkConfig(i: DoctorInput): DoctorCheck {
  const s = i.settings;
  if (s.error) {
    return {
      id: 'config',
      title: 'Settings',
      status: 'fail',
      detail: s.error,
      fix: `fix ${i.paths.configFile} or move it aside (the daemon runs on safe defaults until then)`,
    };
  }
  const where = s.source === 'daemon' ? 'from the running daemon' : s.source === 'file' ? i.paths.configFile : 'defaults (no config.json yet)';
  return { id: 'config', title: 'Settings', status: 'ok', detail: where };
}

async function checkStateDir(i: DoctorInput): Promise<DoctorCheck> {
  const home = i.paths.home;
  const mode = await modeOf(home);
  if (mode === null) {
    return { id: 'state-dir', title: 'State dir', status: 'info', detail: `${home} does not exist yet ("jantar install" creates it, mode 0700)` };
  }
  // v0.6: file modes do nothing on Windows; the profile's ACL protects the folder.
  if (i.platform === 'win32') return { id: 'state-dir', title: 'State dir', status: 'ok', detail: `${home} (inside your user profile)` };
  const problems: string[] = [];
  const fixes: string[] = [];
  if (mode & 0o077) {
    problems.push(`${home} is mode ${mode.toString(8).padStart(4, '0')} (should be 0700)`);
    fixes.push(`chmod 700 "${home}"`);
  }
  for (const dir of [i.paths.runDir, i.paths.binDir, i.paths.pushDir]) {
    const m = await modeOf(dir);
    if (m !== null && m & 0o077) {
      problems.push(`${dir} is mode ${m.toString(8).padStart(4, '0')} (should be 0700)`);
      fixes.push(`chmod 700 "${dir}"`);
    }
  }
  for (const file of [i.paths.configFile, i.paths.vapidFile, i.paths.dbFile]) {
    const m = await modeOf(file);
    if (m !== null && m & 0o077) {
      problems.push(`${file} is mode ${m.toString(8).padStart(4, '0')} (should be 0600)`);
      fixes.push(`chmod 600 "${file}"`);
    }
  }
  if (problems.length) {
    return { id: 'state-dir', title: 'State dir', status: 'fail', detail: problems.join('; '), fix: fixes.join(' && ') };
  }
  return { id: 'state-dir', title: 'State dir', status: 'ok', detail: `${home} (0700, private)` };
}

function checkSocketPaths(i: DoctorInput): DoctorCheck {
  if (isPipePath(i.paths.ctlSock)) return { id: 'sockets', title: 'Socket paths', status: 'ok', detail: 'named pipes (Windows)' };
  const long = [i.paths.hooksSock, i.paths.ctlSock].filter((p) => !socketPathOk(p));
  return long.length
    ? {
        id: 'sockets',
        title: 'Socket paths',
        status: 'fail',
        detail: `${long.join(', ')} ${long.length === 1 ? 'is' : 'are'} longer than macOS allows for a Unix socket path (103 bytes)`,
        fix: 'point JANTAR_HOME at a shorter directory',
      }
    : { id: 'sockets', title: 'Socket paths', status: 'ok', detail: `${i.paths.runDir}/{hooks,ctl}.sock` };
}

async function checkBuild(i: DoctorInput): Promise<DoctorCheck> {
  const main = join(dirname(i.daemonBin), '..', 'dist', 'main.js');
  if (!(await exists(i.daemonBin)) || !(await exists(main))) {
    return {
      id: 'build',
      title: 'Daemon build',
      status: 'fail',
      detail: `${main} is missing`,
      fix: 'run "pnpm install && pnpm -r build" in the repo',
    };
  }
  const web = join(i.paths.webDist, 'index.html');
  if (!(await exists(web))) {
    return {
      id: 'build',
      title: 'Daemon build',
      status: 'warn',
      detail: `daemon built, but the web app is not (${web} missing)`,
      fix: 'run "pnpm -r build"',
    };
  }
  return { id: 'build', title: 'Daemon build', status: 'ok', detail: `${i.daemonBin} + web app` };
}

interface DaemonProbe {
  running: boolean;
  version?: string;
  /** v0.6: GET /ctl/status, when the daemon answered it. */
  status?: CtlStatusView;
}

/** The parts of the daemon's /ctl/status doctor and the Fleet commands read (absent from older daemons). */
export interface CtlStatusView {
  daemonVersion?: string;
  startedAt?: string;
  publicUrl?: string | null;
  role?: DaemonRole;
  pairedDevices?: number;
  pushSubscriptions?: number;
  counts?: { devices?: number; pushSubscriptions?: number; sessions?: number };
  mode?: { readOnly?: boolean; terminal?: string };
  nodes?: { paired: number; online: number };
  node?: { name: string | null; hubHost: string | null; link: 'off' | 'connecting' | 'linked' | 'waiting'; lastClose: { code: number; at: string } | null; accessRefused: number };
}

/** GET /ctl/status, or null when the daemon is down or does not answer it. */
export async function readCtlStatus(ctl: CtlClient): Promise<CtlStatusView | null> {
  try {
    const r = await ctl.request<CtlStatusView>('GET', '/ctl/status', undefined, { timeoutMs: 3000 });
    if (r.status === 200 && r.body && typeof r.body === 'object' && !isErrorBody(r.body)) return r.body as CtlStatusView;
  } catch {
    // down
  }
  return null;
}

/** Where the daemon's service is, in words (v0.6: a systemd unit on Linux, a task on Windows). */
async function serviceWhere(i: DoctorInput): Promise<string> {
  if (i.platform === 'linux') {
    const unit = unitPath(i.paths, i.env);
    return (await exists(unit)) ? `systemd unit at ${unit}` : 'systemd unit not installed';
  }
  if (i.platform === 'win32') return 'a Scheduled Task (jantar install prints its lines)';
  const plist = plistPath(i.paths);
  return (await plistExists(plist)) ? `LaunchAgent at ${plist}` : 'LaunchAgent not installed';
}

async function checkDaemon(i: DoctorInput, probe: DaemonProbe, error?: string): Promise<DoctorCheck> {
  const agent = await serviceWhere(i);
  if (probe.running) {
    return { id: 'daemon', title: 'Daemon', status: 'ok', detail: `jantard ${probe.version ?? '?'} answers on ${i.paths.ctlSock}; ${agent}` };
  }
  return {
    id: 'daemon',
    title: 'Daemon',
    status: 'warn',
    detail: `not running${error ? ` (${error})` : ''}; ${agent}`,
    fix: 'jantar install',
  };
}

/** ccw-v2's LaunchAgent: while installed, its daemon takes the port at login (and answers /healthz like jantard). */
async function checkLegacyAgent(i: DoctorInput): Promise<DoctorCheck | null> {
  const legacy = await legacyAgentProblem(i.paths);
  if (!legacy) return null;
  return { id: 'legacy-agent', title: 'ccw-v2', status: 'warn', detail: legacy.detail, fix: 'ccw-v2 uninstall (it keeps ~/.ccw-v2), then jantar import-ccw-v2' };
}

async function checkPort(i: DoctorInput, probe: DaemonProbe): Promise<DoctorCheck> {
  const { host, port } = i.settings.settings.remote;
  const free = await i.portFree(host === '0.0.0.0' ? '127.0.0.1' : host, port);
  const where = `${host}:${port}`;
  if (free) {
    return probe.running
      ? {
          id: 'port',
          title: 'Port',
          status: 'warn',
          detail: `the daemon runs but nothing listens on ${where}`,
          fix: 'check ~/.jantar/logs/daemon.err.log',
        }
      : { id: 'port', title: 'Port', status: 'ok', detail: `${where} is free` };
  }
  const health = await i.httpJson(`${localBaseUrl(i.settings.settings)}${ROUTES.health.path}`);
  const ours = typeof health === 'object' && health !== null && (health as HealthResponse).ok === true && typeof (health as HealthResponse).daemonVersion === 'string';
  if (ours && probe.running) return { id: 'port', title: 'Port', status: 'ok', detail: `${where} (jantard)` };
  if (ours) {
    // A jantard answers there, but not this home's (its control socket is silent): another JANTAR_HOME's daemon.
    return {
      id: 'port',
      title: 'Port',
      status: 'warn',
      detail: `${where} belongs to another Jantar daemon (a different JANTAR_HOME), not the one for ${i.paths.home}`,
      fix: `stop that one, or give this one another port: jantard --port <n>, or remote.port in ${i.paths.configFile}`,
    };
  }
  return {
    id: 'port',
    title: 'Port',
    status: 'fail',
    detail: `${where} is used by another program`,
    fix: `see who: lsof -nP -iTCP:${port} -sTCP:LISTEN; or pick another port in ${i.paths.configFile} (remote.port)`,
  };
}

async function uvCswapVersion(userHome: string): Promise<string | null> {
  const lib = join(userHome, '.local', 'share', 'uv', 'tools', 'claude-swap', 'lib');
  let pys: string[];
  try {
    pys = (await readdir(lib)).filter((n) => n.startsWith('python'));
  } catch {
    return null;
  }
  for (const py of pys) {
    try {
      const site = join(lib, py, 'site-packages');
      const info = (await readdir(site)).find((n) => /^claude_swap-\d+\.\d+\.\d+.*\.dist-info$/.test(n));
      if (info) return info.replace(/^claude_swap-/, '').replace(/\.dist-info$/, '');
    } catch {
      // keep looking
    }
  }
  return null;
}

async function checkCswap(i: DoctorInput): Promise<DoctorCheck> {
  const settings = i.settings.settings;
  const bin = settings.bins.cswap ?? (await i.findBin('cswap'));
  let version: string | null = null;
  let how = '';
  if (bin) {
    // Never let cswap think a profile is the active login: strip the profile env.
    const env = { ...scrubEnv(i.env, CSWAP_SCRUB_ENV), NO_COLOR: '1' };
    const r = await i.exec(bin, ['--version'], { env, timeoutMs: 10_000 });
    const v = r.code === 0 ? parseVersion(`${r.stdout} ${r.stderr}`) : null;
    if (v) {
      version = vstr(v);
      how = `${bin} --version`;
    }
  }
  if (!version) {
    const uv = await uvCswapVersion(i.paths.userHome);
    if (uv) {
      version = uv;
      how = 'uv tool install (claude-swap)';
    }
  }
  const profiles = await countProfiles(i.paths.cswapProfiles);
  const cache = await stat(i.paths.cswapUsageCache).catch(() => null);
  const extra = `${profiles} profile dir${profiles === 1 ? '' : 's'}${cache ? `, usage cache ${Math.max(0, Math.round((i.now() - cache.mtimeMs) / 60_000))}m old` : ', no usage cache yet'}`;
  if (!version) {
    // cswap is optional (v0.4): without it and its profiles the daemon runs on one Claude login.
    return profiles > 0
      ? {
          id: 'cswap',
          title: 'cswap',
          status: 'warn',
          detail: `not found (${extra}); sessions still show, but usage and account moves need cswap`,
          fix: 'install claude-swap 0.26.x: uv tool install "claude-swap>=0.26,<0.27"',
        }
      : {
          id: 'cswap',
          title: 'cswap',
          status: 'info',
          detail: 'not installed: one Claude login (single-account mode). cswap is optional; it adds usage bars and more than one account',
          fix: 'optional: uv tool install "claude-swap>=0.26,<0.27"',
        };
  }
  const v = parseVersion(version);
  const inSeries = v !== null && v[0] === CSWAP_SERIES[0] && v[1] === CSWAP_SERIES[1];
  return inSeries
    ? { id: 'cswap', title: 'cswap', status: 'ok', detail: `${version} (${how}); ${extra}` }
    : {
        id: 'cswap',
        title: 'cswap',
        status: 'warn',
        detail: `${version} found (${how}); Jantar reads cswap's files and is tested with ${vstr(CSWAP_SERIES)}.x only`,
        fix: 'uv tool install "claude-swap>=0.26,<0.27" --force',
      };
}

/** cswap's profiles (`<n>-<name>` folders under ~/.claude-swap-backup/sessions), one per account. */
export async function countProfiles(dir: string): Promise<number> {
  try {
    const names = await readdir(dir, { withFileTypes: true });
    return names.filter((d) => d.isDirectory() && /^\d+-/.test(d.name)).length;
  } catch {
    return 0;
  }
}

async function checkClaude(i: DoctorInput): Promise<DoctorCheck> {
  const bin = i.settings.settings.bins.claude ?? (await i.findBin('claude'));
  if (!bin) {
    return {
      id: 'claude',
      title: 'Claude Code',
      status: 'warn',
      detail: 'claude not found on PATH or in ~/.local/bin; running sessions are still discovered from their files',
      fix: 'install Claude Code, or set bins.claude in ~/.jantar/config.json',
    };
  }
  // The native installer links ~/.local/bin/claude to .../versions/<x.y.z>: read the version from
  // the link target instead of running claude.
  let version: string | null = null;
  try {
    const target = await realpath(bin);
    const base = basename(target);
    if (/^\d+\.\d+\.\d+/.test(base)) version = base;
  } catch {
    // dangling link
  }
  return { id: 'claude', title: 'Claude Code', status: 'ok', detail: `${bin}${version ? ` (${version})` : ''}` };
}

async function checkAutomation(i: DoctorInput): Promise<DoctorCheck> {
  const osa = i.settings.settings.bins.osascript ?? (await i.findBin('osascript'));
  const howTo =
    'System Settings > Privacy & Security > Automation: allow node (jantard) to control Terminal. ' +
    'macOS asks once, the first time Jantar reads or types into a tab.';
  if (!osa) {
    return { id: 'automation', title: 'Terminal access', status: 'fail', detail: 'osascript not found (/usr/bin/osascript)', fix: 'this Mac is missing osascript' };
  }
  const log = await tail(daemonLogPaths(i.paths).stderr, LOG_TAIL_BYTES);
  if (/-1743\b/.test(log) || /not authori[sz]ed to send Apple events/i.test(log)) {
    return {
      id: 'automation',
      title: 'Terminal access',
      status: 'warn',
      detail: 'the daemon was refused Automation access to Terminal (error -1743): it cannot read, focus or type into tabs',
      fix: `${howTo} Then restart: launchctl kickstart -k gui/$(id -u)/com.jantar.daemon`,
    };
  }
  return { id: 'automation', title: 'Terminal access', status: 'info', detail: howTo };
}

async function checkTailscale(i: DoctorInput): Promise<DoctorCheck> {
  const bin = await i.findBin('tailscale');
  const port = i.settings.settings.remote.port;
  const ts = await probeTailscale(i.exec, bin, port);
  if (!ts.installed) {
    return {
      id: 'tailscale',
      title: 'Tailscale',
      status: 'info',
      detail: 'not installed (recommended for using Jantar from your phone)',
      fix: 'install Tailscale on this Mac and your phone, then: jantar remote setup',
    };
  }
  if (!ts.running) {
    return {
      id: 'tailscale',
      title: 'Tailscale',
      status: 'warn',
      detail: `installed (${ts.bin}) but not connected${ts.backendState ? ` (${ts.backendState})` : ts.error ? ` (${ts.error})` : ''}`,
      fix: 'open Tailscale and log in, then: jantar remote setup',
    };
  }
  const serve = ts.serve;
  const name = ts.dnsName ?? 'this Mac';
  if (serve?.funnel && serve.matchesDaemon) {
    return {
      id: 'tailscale',
      title: 'Tailscale',
      status: 'fail',
      detail: 'Tailscale Funnel is on for the Jantar daemon: anyone on the internet can reach it',
      fix: 'tailscale funnel reset, then: jantar remote setup',
    };
  }
  if (serve?.matchesDaemon) {
    const url = ts.dnsName ? `https://${ts.dnsName}` : serve.urls[0];
    const publicUrl = i.settings.settings.remote.publicUrl;
    if (url && publicUrl !== url) {
      return {
        id: 'tailscale',
        title: 'Tailscale',
        status: 'warn',
        detail: `Serve proxies ${url} to the daemon, but pairing links use ${publicUrl ?? 'the loopback address'}`,
        fix: `jantar remote url ${url}`,
      };
    }
    return { id: 'tailscale', title: 'Tailscale', status: 'ok', detail: `Serve: ${url ?? name} -> 127.0.0.1:${port} (tailnet only)` };
  }
  return {
    id: 'tailscale',
    title: 'Tailscale',
    status: 'info',
    detail: `connected as ${name}; Serve is not set up for Jantar${serve?.proxiesTo.length ? ` (it proxies ${serve.proxiesTo.join(', ')})` : ''}`,
    fix: 'jantar remote setup',
  };
}

async function checkCloudflared(i: DoctorInput): Promise<DoctorCheck> {
  const bin = await i.findBin('cloudflared');
  return bin
    ? { id: 'cloudflared', title: 'cloudflared', status: 'info', detail: `${bin} (fallback: jantar remote setup --cloudflare)` }
    : { id: 'cloudflared', title: 'cloudflared', status: 'info', detail: 'not installed (only needed as a fallback when Tailscale cannot be used)' };
}

/** Settings that would make Jantar a second copy of what ccw's bot already does. */
export function coexistenceProblems(s: Settings): string[] {
  const out: string[] = [];
  if (s.autoswitch.on && !s.autoswitch.dry_run) out.push('autoswitch is on (two autoswitchers would fight over moves)');
  if (s.notify.telegram) out.push('Telegram is on (two pollers on one bot token conflict)');
  if (s.notify.mac) out.push('Mac banners are on (ccw already sends them)');
  if (s.usage.poller === 'on') out.push('usage.poller is "on" (ccw already keeps cswap\'s cache fresh; use "auto")');
  return out;
}

/**
 * The legacy ccw tool (unpublished, optional). On a Mac without its files
 * and with no bot running there is no row at all: most people never had it.
 */
async function checkCcwBot(i: DoctorInput): Promise<DoctorCheck | null> {
  const installed = await exists(i.paths.ccwDir);
  const pgrep = await i.findBin('pgrep');
  if (!pgrep) {
    return installed ? { id: 'ccw-bot', title: 'ccw bot', status: 'warn', detail: 'cannot check: pgrep not found' } : null;
  }
  const r = await i.exec(pgrep, ['-f', CCW_BOT_PATTERN], { timeoutMs: 5000 });
  const settings = i.settings.settings;
  if (r.code === 1) {
    // ccw is optional: its files are read only when they exist.
    if (!installed) return null;
    return { id: 'ccw-bot', title: 'ccw bot', status: 'ok', detail: 'not running (ccw is optional; Jantar only reads its files)' };
  }
  if (r.code !== 0) {
    if (!installed) return null;
    return { id: 'ccw-bot', title: 'ccw bot', status: 'warn', detail: `cannot check (pgrep: ${(r.spawnError ?? r.stderr.trim()) || `exit ${r.code}`})` };
  }
  const pids = r.stdout.split(/\s+/).filter((x) => /^\d+$/.test(x));
  const problems = coexistenceProblems(settings);
  const who = `ccw's bot is running (pid ${pids.join(', ') || '?'})`;
  if (problems.length) {
    return {
      id: 'ccw-bot',
      title: 'ccw bot',
      status: 'fail',
      detail: `${who} and Jantar is not in coexistence mode: ${problems.join('; ')}`,
      fix: 'Jantar keeps autoswitch, Telegram and Mac banners off while ccw runs; reset them in ~/.jantar/config.json',
    };
  }
  return {
    id: 'ccw-bot',
    title: 'ccw bot',
    status: 'ok',
    detail: `${who}; Jantar is in coexistence mode (autoswitch off, no Telegram or Mac banners, cswap poller "${settings.usage.poller}")`,
  };
}

async function checkHooks(i: DoctorInput): Promise<DoctorCheck> {
  const mentioned = await settingsMentionHook(i.paths.claudeSettings, i.paths.hookBin);
  if (mentioned === null) {
    return { id: 'hooks', title: 'Claude hooks', status: 'info', detail: `${i.paths.claudeSettings} not found; hooks are optional` };
  }
  if (!mentioned) {
    return {
      id: 'hooks',
      title: 'Claude hooks',
      status: 'info',
      detail: 'not installed (optional: approvals and questions from the phone need them)',
      fix: 'jantar hooks install (shows the change first)',
    };
  }
  if (!(await exists(i.paths.hookBin))) {
    return {
      id: 'hooks',
      title: 'Claude hooks',
      status: 'fail',
      detail: `Claude's settings call ${i.paths.hookBin}, which is missing (each hook event then logs an error in Claude)`,
      fix: 'jantar install (puts the hook client back), or jantar hooks uninstall --apply',
    };
  }
  return { id: 'hooks', title: 'Claude hooks', status: 'ok', detail: `installed (${i.paths.hookBin})` };
}

// ---------------------------------------------------------------------------

export async function runDoctor(i: DoctorInput): Promise<DoctorReport> {
  const probe: DaemonProbe = { running: false };
  let daemonError: string | undefined;
  try {
    const h = await callDaemon<HealthResponse>(i.ctl, 'GET', ROUTES.health.path, undefined, { timeoutMs: 3000 });
    probe.running = true;
    probe.version = h.daemonVersion;
    // v0.6: the Fleet lines read the daemon's own view (paired servers; on a server, its link).
    const st = await readCtlStatus(i.ctl);
    if (st) probe.status = st;
  } catch (e) {
    if (!(e instanceof CtlUnavailableError)) daemonError = (e as Error).message;
  }

  // v0.6: a server has no TCP port, and the Mac-only checks stay on Macs.
  const mac = i.platform === 'darwin';
  const node = i.role === 'node';
  const one = (c: DoctorCheck | null): DoctorCheck[] => (c ? [c] : []);
  const checks: DoctorCheck[] = [
    checkPlatform(i),
    checkNode(i),
    checkConfig(i),
    await checkStateDir(i),
    checkSocketPaths(i),
    await checkBuild(i),
    await checkDaemon(i, probe, daemonError),
    ...(mac ? one(await checkLegacyAgent(i)) : []),
    ...(node ? [] : [await checkPort(i, probe)]),
    ...(i.platform === 'win32' ? [] : [await checkCswap(i)]),
    await checkClaude(i),
    ...(mac ? [await checkAutomation(i)] : []),
    ...(mac ? one(await checkCcwBot(i)) : []),
    ...(node ? [] : [await checkHooks(i)]),
    ...(node || !mac ? [] : [await checkTailscale(i), await checkCloudflared(i)]),
    ...(node ? await fleetNodeChecks(i, probe) : await fleetHubChecks(i, probe)),
  ];
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status] += 1;
  return { ok: counts.fail === 0, counts, checks };
}

// ---------------------------------------------------------------------------
// v0.6 Fleet: the Mac with servers, and a server

/** The sentence `jantar fleet on` refuses a door with. */
export const FIXED_DOOR = 'Servers need a fixed front door. Set one up with jantar remote setup.';

export type DoorKind = 'tailscale' | 'cloudflare';

/** The Mac's front door as servers would dial it, or why it can't be one (loopback, LAN, http, a quick tunnel). */
export function fleetDoor(s: Settings): { ok: true; url: string; host: string; kind: DoorKind } | { ok: false; why: string } {
  const r = s.remote;
  if (r.mode === 'loopback') return { ok: false, why: 'it is loopback only' };
  if (r.mode === 'lan') return { ok: false, why: 'it is a LAN address over plain http' };
  if (!r.publicUrl) return { ok: false, why: 'no public address is set' };
  let u: URL;
  try {
    u = new URL(r.publicUrl);
  } catch {
    return { ok: false, why: 'its address is not a URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, why: 'its address is not https' };
  if (u.hostname === 'trycloudflare.com' || u.hostname.endsWith('.trycloudflare.com')) {
    return { ok: false, why: 'it is a quick tunnel, whose address changes on every restart' };
  }
  const kind: DoorKind = r.mode === 'tailscale' || u.hostname.endsWith('.ts.net') ? 'tailscale' : 'cloudflare';
  return { ok: true, url: u.origin, host: u.host, kind };
}

/** What a server needs on a Tailscale door: its tag, and a grant to this Mac's port 443 only. */
export const TAILSCALE_GRANT =
  'Tag each server tag:jantar-node (tailscale up --advertise-tags=tag:jantar-node) and grant that tag tcp:443 on this Mac only (docs/fleet.md#tailscale).';

/** Close codes, and the HTTP answers a node's upgrade got, in words. Never a reason a node sent. */
export function closeWords(code: number): string {
  switch (code) {
    case 1000:
      return 'closed (1000)';
    case NODE_CLOSE.goingAway:
      return 'the other side restarted (1001)';
    case 1006:
      return 'the connection dropped (1006)';
    case NODE_CLOSE.tooBig:
      return 'a frame was too big (1009)';
    case NODE_CLOSE.slow:
      return 'too many events at once (1013)';
    case NODE_CLOSE.protocol:
      return 'a protocol error (4400)';
    case NODE_CLOSE.unknown:
      return 'removed from the hub (4401)';
    case NODE_CLOSE.fleetOff:
      return 'Fleet was turned off at the Mac (4403)';
    case NODE_CLOSE.handshakeTimeout:
      return 'the handshake timed out (4408)';
    case NODE_CLOSE.replaced:
      return 'another machine linked with the same key (4409)';
    case NODE_CLOSE.version:
    case 426:
      return `the link versions differ (${code})`;
    case NODE_CLOSE.rateLimited:
    case 429:
      return `too many attempts (${code})`;
    case 403:
      return 'Cloudflare Access refused the connection (403): the service token may have expired or been revoked';
    case 404:
      return 'Fleet is off at the Mac (404)';
  }
  if (code >= 500 && code < 600) return `the front door answered ${code} (is the Mac awake and its tunnel up?)`;
  return `closed (${code})`;
}

/** What to do about a close, on the server, or undefined when retrying is all there is. */
export function closeFix(code: number): string | undefined {
  if (code === 403) return 'renew the Access token here: jantar node access (docs/fleet.md#rotate-the-access-token)';
  if (code === NODE_CLOSE.unknown) return 'Removed from the hub: run jantar node leave, then jantar node join with a new line';
  if (code === NODE_CLOSE.version || code === 426) return 'update Jantar here (docs/fleet.md#update-a-server)';
  if (code === 404 || code === NODE_CLOSE.fleetOff) return 'turn Fleet on at the Mac: jantar fleet on';
  if (code === NODE_CLOSE.replaced) return 'two machines share this key (a cloned VM?): jantar node leave on one of them and join it again';
  return undefined;
}

const LINK_STATE_WORDS: Record<'off' | 'connecting' | 'linked' | 'waiting', string> = {
  off: 'not linking',
  connecting: 'connecting',
  linked: 'linked',
  waiting: 'waiting to retry',
};

/** "waiting to retry: Cloudflare Access refused ... 12m ago; 3 Access refusals since the last link". */
export function linkWords(node: NonNullable<CtlStatusView['node']>, now: number): string {
  const parts = [LINK_STATE_WORDS[node.link] ?? node.link];
  if (node.link !== 'linked' && node.lastClose) parts[0] += `: last ${closeWords(node.lastClose.code)}, ${ago(node.lastClose.at, now)}`;
  if (node.accessRefused > 0) parts.push(`${node.accessRefused} Cloudflare Access refusal${node.accessRefused === 1 ? '' : 's'} since the last link`);
  return parts.join('; ');
}

export const PMSET = '/usr/bin/pmset';

/** Minutes the Mac sleeps after on AC power (`pmset -g custom`); 0 never; null when it can't tell. */
export function parseAcSleep(text: string): number | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^AC Power:/i.test(l.trim()));
  const section = at >= 0 ? lines.slice(at + 1) : lines;
  for (const line of section) {
    if (at >= 0 && /^\S.*:\s*$/.test(line)) break;
    const m = /^\s*sleep\s+(\d+)\b/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The sleep line `jantar fleet on` and doctor print; null when the Mac does not sleep on power (or can't tell). */
export async function macSleepMinutes(exec: ExecFile): Promise<number | null> {
  const r = await exec(PMSET, ['-g', 'custom'], { timeoutMs: 5000 });
  return r.code === 0 ? parseAcSleep(r.stdout) : null;
}

export const SLEEP_FIX = "turn on 'Prevent automatic sleeping on power adapter when the display is off' (System Settings > Battery > Options, or Energy), or: sudo pmset -c sleep 0";

/** `/proc/sys/kernel/osrelease`: wsl2, wsl1 (Claude can't run there), or null (not WSL). */
export function wslKind(osrelease: string | null): 'wsl1' | 'wsl2' | null {
  if (!osrelease || !/microsoft/i.test(osrelease)) return null;
  return /wsl2/i.test(osrelease) ? 'wsl2' : 'wsl1';
}

/** The OS a server reports at join: macos, linux, wsl (WSL2) or windows. */
export function nodeOsOf(platform: NodeJS.Platform, osrelease: string | null): 'macos' | 'linux' | 'wsl' | 'windows' {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return wslKind(osrelease) ? 'wsl' : 'linux';
}

export const OSRELEASE = '/proc/sys/kernel/osrelease';
export const MIN_TMUX = [3, 2] as const;

/** "tmux 3.3a" -> [3, 3]; "tmux next-3.4" -> [3, 4]; null when it names no version. */
export function parseTmuxVersion(text: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** What `ps --version` says about the ps here: procps (what sends need), BusyBox's, or something else. */
export function psKind(text: string): 'procps' | 'busybox' | 'other' {
  if (/procps/i.test(text)) return 'procps';
  if (/busybox/i.test(text)) return 'busybox';
  return 'other';
}

/** Windows' `systeminfo`: a hypervisor runs, virtualization is on or off in the firmware, or null (can't tell). */
export function systeminfoVirtualization(text: string): 'hypervisor' | 'on' | 'off' | null {
  if (/a hypervisor has been detected/i.test(text)) return 'hypervisor';
  const m = /Virtualization Enabled In Firmware:\s*(Yes|No)/i.exec(text);
  if (m) return m[1]?.toLowerCase() === 'yes' ? 'on' : 'off';
  return null;
}

export interface ConfigDir {
  /** "claude" for ~/.claude, else the dir's <name>. */
  alias: string;
  dir: string;
}

/**
 * The Claude config dirs here, as a server's accounts are counted: ~/.claude
 * and every ~/.claude-<name> holding a .claude.json (never cswap's backup
 * dir). Only names and the file's presence are read.
 */
export async function claudeConfigDirs(paths: Pick<Paths, 'userHome' | 'claudeHome'>): Promise<ConfigDir[]> {
  const out: ConfigDir[] = [];
  if (await exists(paths.claudeHome)) out.push({ alias: 'claude', dir: paths.claudeHome });
  let names: string[] = [];
  try {
    names = (await readdir(paths.userHome, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const m = /^\.claude-([A-Za-z0-9._-]{1,64})$/.exec(name);
    if (!m || name === '.claude-swap-backup') continue;
    const dir = join(paths.userHome, name);
    if (await exists(join(dir, '.claude.json'))) out.push({ alias: m[1] as string, dir });
  }
  return out;
}

/** Whether a config dir's settings.json calls the hook client (shell form, or exec form's JSON-escaped path). */
export async function dirHasHooks(dir: string, hookBin: string): Promise<boolean | null> {
  const file = join(dir, 'settings.json');
  const plain = await settingsMentionHook(file, hookBin);
  if (plain !== false) return plain;
  return settingsMentionHook(file, JSON.stringify(hookBin).slice(1, -1));
}

/** "~/.claude-work" */
export function tilde(abs: string, userHome: string): string {
  const home = userHome.replace(/\/+$/, '');
  if (abs === home) return '~';
  return abs.startsWith(`${home}/`) ? `~/${abs.slice(home.length + 1)}` : abs;
}

async function readTextDefault(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Default door probe: one GET, no credentials, no redirect followed. */
export async function probeUrl(url: string): Promise<ProbeResult | null> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    const text = await res.text().catch(() => '');
    let jantar = false;
    try {
      jantar = isErrorBody(JSON.parse(text));
    } catch {
      jantar = false;
    }
    return { status: res.status, location: res.headers.get('location'), jantar };
  } catch {
    return null;
  }
}

async function fleetHubChecks(i: DoctorInput, probe: DaemonProbe): Promise<DoctorCheck[]> {
  const s = i.settings.settings;
  if (!s.fleet.enabled) return [];
  const out: DoctorCheck[] = [];
  const door = fleetDoor(s);
  const nodes = probe.status?.nodes;
  if (!door.ok) {
    out.push({ id: 'fleet', title: 'Fleet', status: 'fail', detail: `on, but servers can't use this Mac's front door: ${door.why}`, fix: 'jantar remote setup' });
  } else {
    const count = nodes ? `${nodes.online} of ${nodes.paired} server${nodes.paired === 1 ? '' : 's'} online` : 'the daemon is not running';
    out.push({ id: 'fleet', title: 'Fleet', status: 'ok', detail: `on: servers dial ${door.url}${NODE_LINK_PATH}; ${count}` });
    if (door.kind === 'tailscale') {
      if ((nodes?.paired ?? 0) > 0) out.push({ id: 'fleet-door', title: 'Fleet door', status: 'info', detail: `Tailscale Serve. ${TAILSCALE_GRANT}` });
    } else {
      out.push(await accessCheck(i, door.url, door.host));
    }
  }
  if (i.platform === 'darwin') out.push(await sleepCheck(i));
  return out;
}

/** The node path without Access headers: Cloudflare Access should refuse it (403) before the Mac sees it. */
async function accessCheck(i: DoctorInput, origin: string, host: string): Promise<DoctorCheck> {
  const url = `${origin}${NODE_PREFIX}pair`;
  const r = await (i.probe ?? probeUrl)(url);
  const fix = `add an Access application for ${host}/v1/node/* with one Service Auth policy (docs/fleet.md#cloudflare-access)`;
  const base = { id: 'fleet-door', title: 'Fleet door' } as const;
  if (!r) return { ...base, status: 'warn', detail: `${url} did not answer from this Mac`, fix: 'check that the tunnel runs (cloudflared tunnel run)' };
  if (r.jantar) {
    return { ...base, status: 'warn', detail: `${host}/v1/node/* reaches Jantar with no Access in front: it is open to the internet, and only the handshake guards it`, fix };
  }
  if (r.status >= 300 && r.status < 400) {
    return { ...base, status: 'warn', detail: `Cloudflare Access sends ${host}/v1/node/* to a login page, which servers can't pass`, fix };
  }
  if (r.status === 403) return { ...base, status: 'ok', detail: `Cloudflare Access refuses ${host}/v1/node/* without a service token (403), as it should` };
  return { ...base, status: 'warn', detail: `${url} answered ${r.status} without a service token`, fix };
}

async function sleepCheck(i: DoctorInput): Promise<DoctorCheck> {
  const min = await macSleepMinutes(i.exec);
  const base = { id: 'sleep', title: 'Sleep' } as const;
  if (min === null) return { ...base, status: 'info', detail: "could not read pmset's settings; while the Mac sleeps, the phone can't reach any server" };
  if (min === 0) return { ...base, status: 'ok', detail: 'this Mac does not sleep on power, so the phone keeps reaching the servers' };
  return {
    ...base,
    status: 'warn',
    detail: `This Mac sleeps after ${min} minute${min === 1 ? '' : 's'} on power, and the phone can't reach any server while it sleeps`,
    fix: SLEEP_FIX,
  };
}

async function fleetNodeChecks(i: DoctorInput, probe: DaemonProbe): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [linkCheck(i, probe)];
  if (i.platform === 'linux') {
    const wsl = await wslCheck(i);
    if (wsl) out.push(wsl);
    out.push(await tmuxCheck(i), await procpsCheck(i), await lingerCheck(i));
  }
  if (i.platform === 'win32') out.push(await windowsCheck(i), await claudeWindowsCheck(i));
  out.push(await hooksDirsCheck(i));
  return out;
}

function linkCheck(i: DoctorInput, probe: DaemonProbe): DoctorCheck {
  const base = { id: 'node-link', title: 'Link to the Mac' } as const;
  const f = i.nodeFile;
  if (!f) return { ...base, status: 'fail', detail: "this server's node.json can't be read", fix: 'jantar node leave, then jantar node join with a new line from the Mac' };
  const who = `${f.name} of ${hostOf(f.url)}`;
  if (!probe.running) return { ...base, status: 'warn', detail: `${who}: the daemon is not running, so the phone shows this server offline`, fix: 'jantar install' };
  const node = probe.status?.node;
  if (!node) return { ...base, status: 'warn', detail: `${who}: the daemon does not say (an older Jantar? update it here)` };
  if (node.link === 'linked') {
    return { ...base, status: 'ok', detail: `${who}: linked${node.accessRefused ? ` (${node.accessRefused} Access refusals before it)` : ''}` };
  }
  const fix = node.lastClose ? closeFix(node.lastClose.code) : undefined;
  return { ...base, status: 'warn', detail: `${who}: ${linkWords(node, i.now())}`, ...(fix ? { fix } : {}) };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function wslCheck(i: DoctorInput): Promise<DoctorCheck | null> {
  const kind = wslKind(await (i.readText ?? readTextDefault)(OSRELEASE));
  if (!kind) return null;
  const base = { id: 'wsl', title: 'WSL' } as const;
  if (kind === 'wsl1') {
    return { ...base, status: 'fail', detail: 'WSL1: Claude Code needs WSL2', fix: 'in Windows: wsl --set-version <distro> 2' };
  }
  return {
    ...base,
    status: 'info',
    detail:
      'WSL2. It stops about 15 s after its last terminal closes: set [general] instanceIdleTimeout=-1 and [wsl2] vmIdleTimeout=-1 ' +
      'in %USERPROFILE%\\.wslconfig and start the distro with a logon task (docs/fleet.md#wsl2). WSL2 needs virtualization: on a cloud VM, ' +
      'an instance type with nested virtualization',
  };
}

async function tmuxCheck(i: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'tmux', title: 'tmux' } as const;
  const bin = i.settings.settings.bins.tmux ?? (await i.findBin('tmux'));
  if (!bin) {
    return {
      ...base,
      status: 'warn',
      detail: "not found: sessions here show on the phone with their cards, but the phone can't type into them",
      fix: `install tmux ${vstr(MIN_TMUX)} or newer (sudo apt-get install tmux) and run Claude inside it`,
    };
  }
  const r = await i.exec(bin, ['-V'], { timeoutMs: 5000 });
  const v = r.code === 0 ? parseTmuxVersion(`${r.stdout} ${r.stderr}`) : null;
  if (!v) return { ...base, status: 'warn', detail: `${bin} -V did not name a version` };
  if (v[0] < MIN_TMUX[0] || (v[0] === MIN_TMUX[0] && v[1] < MIN_TMUX[1])) {
    return {
      ...base,
      status: 'fail',
      detail: `tmux ${vstr(v)} is older than ${vstr(MIN_TMUX)}: the phone can't type into its panes`,
      fix: `install tmux ${vstr(MIN_TMUX)} or newer (Ubuntu 22.04, Debian 12 and later have it)`,
    };
  }
  const uid = i.uid ?? 0;
  const socket = join(i.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, 'default');
  const running = await (i.exists ?? exists)(socket);
  return {
    ...base,
    status: 'ok',
    detail: `tmux ${vstr(v)} (${bin}); ${running ? 'its default server is running' : 'no tmux server runs yet: start Claude inside tmux'} (Jantar uses the default server only)`,
  };
}

async function procpsCheck(i: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'procps', title: 'ps' } as const;
  const bin = i.settings.settings.bins.ps ?? (await i.findBin('ps'));
  if (!bin) return { ...base, status: 'fail', detail: "ps not found: sends can't check Claude's process", fix: 'sudo apt-get install procps (Alpine: apk add procps)' };
  const r = await i.exec(bin, ['--version'], { timeoutMs: 5000 });
  const kind = psKind(`${r.stdout} ${r.stderr}`);
  if (kind === 'procps') return { ...base, status: 'ok', detail: `procps (${bin})` };
  if (kind === 'busybox') {
    return { ...base, status: 'fail', detail: `${bin} is BusyBox's, which can't tell Claude's start time: every send is refused`, fix: 'apk add procps' };
  }
  return { ...base, status: 'warn', detail: `${bin} is not procps's ps; sends may be refused if it can't tell Claude's start time`, fix: 'sudo apt-get install procps' };
}

async function lingerCheck(i: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'linger', title: 'Lingering' } as const;
  const user = i.userName ?? (i.env.USER || i.env.LOGNAME || '$USER');
  const loginctl = (await i.findBin('loginctl')) ?? LOGINCTL;
  const on = await lingerOn(i.exec, user, loginctl);
  if (on === true) return { ...base, status: 'ok', detail: 'on: Jantar keeps running after you log out, and starts at boot' };
  if (on === false) return { ...base, status: 'warn', detail: 'off: Jantar stops when you log out', fix: `sudo loginctl enable-linger ${user}` };
  return {
    ...base,
    status: 'warn',
    detail: "loginctl could not tell whether lingering is on (is systemd running? In WSL: [boot] systemd=true in /etc/wsl.conf)",
  };
}

/** C:\Windows\System32\systeminfo.exe */
function systeminfoPath(env: Readonly<Record<string, string | undefined>>): string {
  return `${env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'}\\System32\\systeminfo.exe`;
}

async function windowsCheck(i: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'windows', title: 'Windows' } as const;
  const preview = 'native Windows (preview): the phone shows these sessions and answers their cards; prompts, the screen and starting sessions need WSL2';
  const r = await i.exec(systeminfoPath(i.env), [], { timeoutMs: 60_000 });
  const v = r.code === 0 ? systeminfoVirtualization(r.stdout) : null;
  if (v === 'off') {
    return {
      ...base,
      status: 'warn',
      detail: `${preview}. Virtualization is off here, so WSL2 can't run: watch and cards is what this machine gets`,
      fix: 'turn virtualization on in the firmware; on a cloud VM, pick an instance type with nested virtualization',
    };
  }
  if (v === 'hypervisor' || v === 'on') return { ...base, status: 'info', detail: `${preview}. Virtualization is available, so WSL2 can run here (docs/fleet.md#windows)` };
  return { ...base, status: 'info', detail: `${preview}. WSL2 needs virtualization, which many cloud VMs lack (docs/fleet.md#windows)` };
}

async function claudeWindowsCheck(i: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'claude-windows', title: 'Claude on Windows' } as const;
  const bin = i.settings.settings.bins.claude ?? (await i.findBin('claude'));
  if (!bin) return { ...base, status: 'warn', detail: `claude not found; cards need Claude Code ${MIN_CLAUDE_WINDOWS} or newer here` };
  const r = await i.exec(bin, ['--version'], { timeoutMs: 15_000 });
  const v = r.code === 0 ? parseVersion(r.stdout) : null;
  if (!v) return { ...base, status: 'warn', detail: `${bin} --version did not answer; cards need Claude Code ${MIN_CLAUDE_WINDOWS} or newer here` };
  const min = parseVersion(MIN_CLAUDE_WINDOWS) as [number, number, number];
  const older = v[0] !== min[0] ? v[0] < min[0] : v[1] !== min[1] ? v[1] < min[1] : v[2] < min[2];
  if (older) {
    return {
      ...base,
      status: 'fail',
      detail: `Claude Code ${vstr(v)} is older than ${MIN_CLAUDE_WINDOWS}: Jantar's hooks can't carry cards on Windows before it`,
      fix: 'claude update',
    };
  }
  return { ...base, status: 'ok', detail: `Claude Code ${vstr(v)} (cards need ${MIN_CLAUDE_WINDOWS} or newer)` };
}

async function hooksDirsCheck(i: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'hooks', title: 'Claude hooks' } as const;
  const dirs = await claudeConfigDirs(i.paths);
  if (!dirs.length) return { ...base, status: 'info', detail: 'no Claude config dir here yet (~/.claude)' };
  const with_: string[] = [];
  const without: string[] = [];
  for (const d of dirs) ((await dirHasHooks(d.dir, i.paths.hookBin)) ? with_ : without).push(tilde(d.dir, i.paths.userHome));
  if (!without.length) return { ...base, status: 'ok', detail: `installed in every config dir: ${with_.join(', ')}` };
  const first = without[0] as string;
  return {
    ...base,
    status: 'info',
    detail: `${with_.length ? `installed in ${with_.join(', ')}; ` : ''}none in ${without.join(', ')} (no cards from sessions there)`,
    fix: `jantar hooks install --settings ${first}/settings.json --apply (once per dir)`,
  };
}

const LABEL: Record<CheckStatus, string> = { ok: 'ok', warn: 'warn', fail: 'FAIL', info: 'info' };

export function formatReport(r: DoctorReport): string {
  const width = Math.max(...r.checks.map((c) => c.title.length));
  const lines = ['jantar doctor', ''];
  for (const c of r.checks) {
    lines.push(`  ${LABEL[c.status].padEnd(4)}  ${c.title.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`  ${''.padEnd(4)}  ${''.padEnd(width)}  -> ${c.fix}`);
  }
  const { ok, warn, fail, info } = r.counts;
  lines.push('', `${ok} ok, ${warn} warning${warn === 1 ? '' : 's'}, ${fail} failure${fail === 1 ? '' : 's'}, ${info} note${info === 1 ? '' : 's'}`);
  return `${lines.join('\n')}\n`;
}

/** Default `httpJson`: GET with a 2 s timeout, JSON or null. */
export async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), headers: { accept: 'application/json' } });
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** For tests and `--json`: the report without functions. */
export function reportJson(r: DoctorReport): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

