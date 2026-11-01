/**
 * The daemon's launchd LaunchAgent (label com.jantar.daemon).
 *
 * - The plist runs the daemon with the absolute node path (launchd's PATH is
 *   minimal), KeepAlive and RunAtLoad, in the GUI (Aqua) session so the
 *   daemon may script Terminal.app once the user allows it.
 * - Only `jantar install` / `jantar uninstall`, run by the user, load or
 *   unload it. Every launchctl call goes through the injected exec, so tests
 *   never touch the real launchd.
 * - It never reads, writes or unloads any other agent (ccw's own bot keeps
 *   running side by side).
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDirFromEnv, writeFileAtomic, type ExecFile, type ExecResult, type Paths } from '@jantar/daemon';
import { HOME_ENV, LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL } from '@jantar/protocol';
import { guardRealPath } from './guard.js';

export const LAUNCHCTL = '/bin/launchctl';

export interface PlistOptions {
  label?: string;
  nodePath: string;
  daemonBin: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  /** Extra environment for the daemon (JANTAR_HOME when it is not the default, ...). */
  env?: Record<string, string>;
  /** v0.6: run the daemon with --read-only (a watch-only server, `jantar install --read-only`). */
  readOnly?: boolean;
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function assertAbsolute(name: string, p: string): void {
  if (!p.startsWith('/')) throw new Error(`${name} must be an absolute path, got "${p}"`);
}

/** Render the LaunchAgent plist (XML). Pure. */
export function renderPlist(o: PlistOptions): string {
  const label = o.label ?? LAUNCHD_LABEL;
  if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new Error(`bad launchd label "${label}"`);
  assertAbsolute('node path', o.nodePath);
  assertAbsolute('daemon path', o.daemonBin);
  assertAbsolute('working directory', o.workingDirectory);
  const str = (v: string) => `<string>${xmlEscape(v)}</string>`;
  const env = Object.entries(o.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${str(label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${str(o.nodePath)}`,
    `    ${str(o.daemonBin)}`,
    ...(o.readOnly ? [`    ${str('--read-only')}`] : []),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${str(o.workingDirectory)}`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>LimitLoadToSessionType</key>',
    '  <string>Aqua</string>',
    '  <key>StandardOutPath</key>',
    `  ${str(o.stdoutPath)}`,
    '  <key>StandardErrorPath</key>',
    `  ${str(o.stderrPath)}`,
  ];
  if (env.length) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [k, v] of env) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad environment variable name "${k}"`);
      lines.push(`    <key>${k}</key>`, `    ${str(v)}`);
    }
    lines.push('  </dict>');
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

/** ~/Library/LaunchAgents/com.jantar.daemon.plist (under the possibly synthetic user home). */
export function plistPath(paths: Pick<Paths, 'userHome'>, label = LAUNCHD_LABEL): string {
  return join(paths.userHome, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function daemonLogPaths(paths: Pick<Paths, 'logsDir'>): { stdout: string; stderr: string } {
  return { stdout: join(paths.logsDir, 'daemon.out.log'), stderr: join(paths.logsDir, 'daemon.err.log') };
}

export const guiDomain = (uid: number) => `gui/${uid}`;
export const serviceTarget = (uid: number, label = LAUNCHD_LABEL) => `gui/${uid}/${label}`;

/** The plist for this install: node + daemon by absolute path, logs under ~/.jantar/logs. */
export function plistFor(input: {
  paths: Paths;
  nodePath: string;
  daemonBin: string;
  env: Readonly<Record<string, string | undefined>>;
  /** v0.6: --read-only in the program arguments. */
  readOnly?: boolean;
}): string {
  const logs = daemonLogPaths(input.paths);
  const env: Record<string, string> = {
    PATH: [dirname(input.nodePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  };
  // Only non-default locations are pinned; the defaults follow $HOME. A state
  // dir named by the old CCW_V2_HOME is pinned under the new name.
  const home = stateDirFromEnv(input.env);
  if (home) env[HOME_ENV] = home;
  for (const key of ['JANTAR_WEB_DIST', 'JANTAR_LOG_LEVEL']) {
    const v = input.env[key];
    if (v) env[key] = v;
  }
  return renderPlist({
    nodePath: input.nodePath,
    daemonBin: input.daemonBin,
    workingDirectory: input.paths.home,
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
    env,
    ...(input.readOnly ? { readOnly: true } : {}),
  });
}

export async function writePlist(path: string, xml: string): Promise<void> {
  guardRealPath(path, 'the LaunchAgent plist');
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, xml, { mode: 0o644 });
}

export async function readPlist(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function plistExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * ccw-v2's LaunchAgent (Jantar's name up to v0.3), when it is still
 * installed: launchd starts the old daemon at login on the same port, so
 * jantard cannot bind it. The sentence says so; null when it is gone.
 */
export async function legacyAgentProblem(paths: Pick<Paths, 'userHome'>): Promise<{ plist: string; detail: string } | null> {
  const plist = plistPath(paths, LEGACY_LAUNCHD_LABEL);
  if (!(await plistExists(plist))) return null;
  return { plist, detail: `ccw-v2's daemon is still installed (${plist}) and holds the port` };
}

function describe(r: ExecResult): string {
  if (r.spawnError) return r.spawnError;
  if (r.timedOut) return 'timed out';
  return (r.stderr || r.stdout).trim() || `exit ${r.code}`;
}

/** "Not loaded" answers from `launchctl bootout` (nothing to unload). */
export function isNotLoaded(r: ExecResult): boolean {
  const text = `${r.stderr}\n${r.stdout}`;
  return r.code === 3 || r.code === 113 || /could not find|no such process|not find specified service/i.test(text);
}

export type LaunchdResult = { ok: true; detail?: string } | { ok: false; reason: string };

/** `launchctl bootstrap gui/<uid> <plist>` (loads and, with RunAtLoad, starts it). */
export async function bootstrapAgent(exec: ExecFile, uid: number, plist: string): Promise<LaunchdResult> {
  guardRealPath(plist, 'the LaunchAgent');
  const r = await exec(LAUNCHCTL, ['bootstrap', guiDomain(uid), plist], { timeoutMs: 20_000 });
  if (r.code === 0) return { ok: true };
  return { ok: false, reason: describe(r) };
}

/** `launchctl bootout gui/<uid>/<label>`; "not loaded" counts as success. */
export async function bootoutAgent(exec: ExecFile, uid: number, label = LAUNCHD_LABEL): Promise<LaunchdResult> {
  const r = await exec(LAUNCHCTL, ['bootout', serviceTarget(uid, label)], { timeoutMs: 20_000 });
  if (r.code === 0) return { ok: true, detail: 'unloaded' };
  if (isNotLoaded(r)) return { ok: true, detail: 'was not loaded' };
  return { ok: false, reason: describe(r) };
}

export async function removePlist(path: string): Promise<boolean> {
  guardRealPath(path, 'the LaunchAgent plist');
  const existed = await plistExists(path);
  await rm(path, { force: true });
  return existed;
}
