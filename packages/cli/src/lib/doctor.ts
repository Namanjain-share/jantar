/**
 * `jantar doctor`: read-only checks of everything Jantar depends on.
 *
 * Doctor never changes anything: it runs only `--version` / status commands
 * (`cswap --version`, `tailscale status --json`, `tailscale serve status
 * --json`, `pgrep -f`), reads file metadata, and asks the daemon for
 * /healthz. It never scripts Terminal.app (the Automation check is a hint
 * plus a look at the daemon's own log), never runs launchctl, and never
 * prints file contents from ~/.claude or cswap.
 */
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CSWAP_SCRUB_ENV, scrubEnv, socketPathOk, type ExecFile, type Paths } from '@jantar/daemon';
import { ROUTES, type HealthResponse, type Settings } from '@jantar/protocol';
import { CtlUnavailableError, callDaemon, type CtlClient } from '../ctl.js';
import { daemonLogPaths, legacyAgentProblem, plistExists, plistPath } from './launchd.js';
import { probeTailscale } from './remote.js';
import type { SettingsRead } from './settings.js';
import { localBaseUrl } from './settings.js';
import { settingsMentionHook } from './hooks-files.js';
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
  return i.platform === 'darwin'
    ? { id: 'platform', title: 'macOS', status: 'ok', detail: 'macOS (launchd, Terminal.app)' }
    : {
        id: 'platform',
        title: 'macOS',
        status: 'warn',
        detail: `${i.platform}: Jantar supports macOS only (launchd agent, Terminal.app)`,
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
}

async function checkDaemon(i: DoctorInput, probe: DaemonProbe, error?: string): Promise<DoctorCheck> {
  const plist = plistPath(i.paths);
  const agent = (await plistExists(plist)) ? `LaunchAgent at ${plist}` : 'LaunchAgent not installed';
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
  } catch (e) {
    if (!(e instanceof CtlUnavailableError)) daemonError = (e as Error).message;
  }

  const checks: DoctorCheck[] = [
    checkPlatform(i),
    checkNode(i),
    checkConfig(i),
    await checkStateDir(i),
    checkSocketPaths(i),
    await checkBuild(i),
    await checkDaemon(i, probe, daemonError),
    ...[await checkLegacyAgent(i)].filter((c): c is DoctorCheck => c !== null),
    await checkPort(i, probe),
    await checkCswap(i),
    await checkClaude(i),
    await checkAutomation(i),
    ...[await checkCcwBot(i)].filter((c): c is DoctorCheck => c !== null),
    await checkHooks(i),
    await checkTailscale(i),
    await checkCloudflared(i),
  ];
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status] += 1;
  return { ok: counts.fail === 0, counts, checks };
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

