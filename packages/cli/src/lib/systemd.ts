/**
 * v0.6: the daemon's systemd user unit on a Linux server (and inside WSL2),
 * `~/.config/systemd/user/jantar.service`.
 *
 * - The unit runs the daemon with the absolute node path, restarts it on any
 *   exit, and appends its output to `<state dir>/logs/daemon.{out,err}.log`
 *   (the files launchd fills on a Mac; `append:` needs systemd 240).
 * - `KillMode=process`: a restart (an update, `jantar node access`) stops
 *   only jantard, never the tmux server it started for a session, so the
 *   sessions the phone started keep running.
 * - Lingering (`loginctl enable-linger <user>`) keeps the user's manager, and
 *   so the unit, running after the user logs out, and starts it at boot.
 * - Only `jantar install` / `uninstall` (also run by `node join` / `leave`)
 *   load or unload it. systemctl and loginctl run by absolute path, argv
 *   only, through the injected exec, so tests never touch the real systemd;
 *   under a test runner the guard refuses the real unit's folder.
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { stateDirFromEnv, writeFileAtomic, type ExecFile, type ExecResult, type Paths } from '@jantar/daemon';
import { HOME_ENV } from '@jantar/protocol';
import { guardRealPath } from './guard.js';
import { daemonLogPaths } from './launchd.js';

export const UNIT_NAME = 'jantar.service';
export const SYSTEMCTL = '/usr/bin/systemctl';
export const LOGINCTL = '/usr/bin/loginctl';
/** `StandardOutput=append:` arrived in systemd 240. */
export const MIN_SYSTEMD = 240;

export interface UnitOptions {
  nodePath: string;
  daemonBin: string;
  stdoutPath: string;
  stderrPath: string;
  /** Extra environment (JANTAR_HOME when it is not the default, ...). */
  env?: Record<string, string>;
  readOnly?: boolean;
}

/** Characters a path in the unit may never hold (a newline would start a new key). */
const UNSAFE = /[\u0000-\u001f\u007f]/;

function checkPath(name: string, p: string): void {
  if (!isAbsolute(p) || !p.startsWith('/')) throw new Error(`${name} must be an absolute path, got "${p}"`);
  if (UNSAFE.test(p)) throw new Error(`${name} holds a control character`);
}

/** systemd expands %specifiers in every value: a literal % is doubled. */
function escapeSpecifiers(s: string): string {
  return s.replace(/%/g, '%%');
}

/** A value word: plain when it can be, else double-quoted with C-style escapes. */
function quoted(e: string): string {
  if (/^[A-Za-z0-9_./:@+=,%$-]+$/.test(e)) return e;
  return `"${e.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One ExecStart word (ExecStart also expands $VARIABLES, so a literal $ is doubled there). */
export function unitWord(s: string): string {
  return quoted(escapeSpecifiers(s).replace(/\$/g, '$$$$'));
}

/** One Environment= assignment (no $ expansion there). */
function envWord(s: string): string {
  return quoted(escapeSpecifiers(s));
}

/** Render the unit. Pure. */
export function renderUnit(o: UnitOptions): string {
  checkPath('node path', o.nodePath);
  checkPath('daemon path', o.daemonBin);
  checkPath('log path', o.stdoutPath);
  checkPath('log path', o.stderrPath);
  const argv = [o.nodePath, o.daemonBin, ...(o.readOnly ? ['--read-only'] : [])];
  const env = Object.entries(o.env ?? {}).sort(([a], [b]) => (a === 'PATH' ? -1 : b === 'PATH' ? 1 : a.localeCompare(b)));
  const lines = [
    '[Unit]',
    'Description=Jantar (jantard)',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${argv.map(unitWord).join(' ')}`,
    'Restart=always',
    'RestartSec=5',
    'KillMode=process',
  ];
  for (const [k, v] of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad environment variable name "${k}"`);
    if (UNSAFE.test(v)) throw new Error(`the value of ${k} holds a control character`);
    lines.push(`Environment=${envWord(`${k}=${v}`)}`);
  }
  lines.push(
    `StandardOutput=append:${escapeSpecifiers(o.stdoutPath)}`,
    `StandardError=append:${escapeSpecifiers(o.stderrPath)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

/**
 * `~/.config/systemd/user/jantar.service` (under the possibly synthetic user
 * home). Never the shell's XDG_CONFIG_HOME: the user manager (started by
 * PAM) reads ~/.config/systemd/user unless its own environment sets it.
 */
export function unitPath(paths: Pick<Paths, 'userHome'>): string {
  return join(paths.userHome, '.config', 'systemd', 'user', UNIT_NAME);
}

/** The unit for this install: node + daemon by absolute path, logs under the state dir. */
export function unitFor(input: {
  paths: Paths;
  nodePath: string;
  daemonBin: string;
  env: Readonly<Record<string, string | undefined>>;
  readOnly?: boolean;
}): string {
  const logs = daemonLogPaths(input.paths);
  const env: Record<string, string> = {
    // A tmux server jantard starts first (after a reboot) hands this PATH to every pane, and so to Claude's Bash tool.
    PATH: [dirname(input.nodePath), '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin'].join(':'),
  };
  // As the LaunchAgent: only a non-default state dir is pinned.
  const home = stateDirFromEnv(input.env);
  if (home) env[HOME_ENV] = home;
  const level = input.env.JANTAR_LOG_LEVEL;
  if (level) env.JANTAR_LOG_LEVEL = level;
  return renderUnit({
    nodePath: input.nodePath,
    daemonBin: input.daemonBin,
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
    env,
    ...(input.readOnly ? { readOnly: true } : {}),
  });
}

export async function writeUnit(path: string, text: string): Promise<void> {
  guardRealPath(path, 'the systemd unit');
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, text, { mode: 0o644 });
}

export async function readUnit(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Delete the unit and its enable link (what `disable` removes), so nothing starts it at boot even when systemctl could not run. */
export async function removeUnit(path: string): Promise<boolean> {
  guardRealPath(path, 'the systemd unit');
  const existed = await stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
  await rm(path, { force: true });
  await rm(join(dirname(path), 'default.target.wants', UNIT_NAME), { force: true });
  return existed;
}

/** Whether an installed unit (or plist) runs the daemon with --read-only. */
export function serviceIsReadOnly(text: string | null): boolean {
  if (!text) return false;
  return /^ExecStart=.*\s--read-only(\s|$)/m.test(text) || text.includes('<string>--read-only</string>');
}

function describe(r: ExecResult): string {
  if (r.spawnError) return r.spawnError;
  if (r.timedOut) return 'timed out';
  return (r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`;
}

/** `absent`: systemd is not running here at all (no systemctl, or not the init system), so no unit of ours can be running under it. */
export type SystemdResult = { ok: true; detail?: string } | { ok: false; reason: string; absent?: boolean };

/** systemctl can't run, or systemd is not this machine's init (a container, OpenRC, WSL without systemd=true). */
export function noSystemd(r: ExecResult): boolean {
  return r.spawnError !== undefined || /not been booted with systemd/i.test(`${r.stderr}\n${r.stdout}`);
}

/** The systemd version `systemctl --version` names, or null. */
export function parseSystemdVersion(text: string): number | null {
  const m = /\bsystemd (\d+)\b/.exec(text);
  return m ? Number(m[1]) : null;
}

export async function systemdVersion(exec: ExecFile, systemctl = SYSTEMCTL): Promise<number | null> {
  const r = await exec(systemctl, ['--version'], { timeoutMs: 10_000 });
  return r.code === 0 ? parseSystemdVersion(r.stdout) : null;
}

/** `systemctl --user <args...>`. */
async function user(exec: ExecFile, args: readonly string[], systemctl: string): Promise<ExecResult> {
  return exec(systemctl, ['--user', ...args], { timeoutMs: 30_000 });
}

/** daemon-reload, enable, then restart: a fresh install starts, an update restarts on the new build. */
export async function startUnit(exec: ExecFile, systemctl = SYSTEMCTL): Promise<SystemdResult> {
  for (const args of [['daemon-reload'], ['enable', UNIT_NAME], ['restart', UNIT_NAME]]) {
    const r = await user(exec, args, systemctl);
    if (r.code !== 0) return { ok: false, reason: `systemctl --user ${args.join(' ')}: ${describe(r)}` };
  }
  return { ok: true };
}

export async function restartUnit(exec: ExecFile, systemctl = SYSTEMCTL): Promise<SystemdResult> {
  const r = await user(exec, ['restart', UNIT_NAME], systemctl);
  return r.code === 0 ? { ok: true } : { ok: false, reason: `systemctl --user restart ${UNIT_NAME}: ${describe(r)}` };
}

/**
 * "Not loaded" / "does not exist" answers from `systemctl --user disable
 * --now` (nothing to stop). Never "Failed to connect to bus: No such file or
 * directory": that is a user manager this shell can't reach, which may well
 * be running the unit.
 */
export function isNotInstalled(r: ExecResult): boolean {
  const text = `${r.stderr}\n${r.stdout}`;
  return !/connect to bus/i.test(text) && /not loaded|does not exist|no such file|not found/i.test(text);
}

/** `systemctl --user disable --now jantar.service`; a unit that is not there counts as success. */
export async function stopUnit(exec: ExecFile, systemctl = SYSTEMCTL): Promise<SystemdResult> {
  const r = await user(exec, ['disable', '--now', UNIT_NAME], systemctl);
  if (r.code === 0) return { ok: true, detail: 'stopped' };
  if (isNotInstalled(r)) return { ok: true, detail: 'was not installed' };
  return { ok: false, reason: describe(r), ...(noSystemd(r) ? { absent: true } : {}) };
}

export async function reloadUnits(exec: ExecFile, systemctl = SYSTEMCTL): Promise<void> {
  await user(exec, ['daemon-reload'], systemctl);
}

/** `loginctl enable-linger <user>`: the unit keeps running after logout and starts at boot. */
export async function enableLinger(exec: ExecFile, userName: string, loginctl = LOGINCTL): Promise<SystemdResult> {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$/.test(userName)) return { ok: false, reason: `"${userName}" is not a user name` };
  const r = await exec(loginctl, ['enable-linger', userName], { timeoutMs: 15_000 });
  return r.code === 0 ? { ok: true } : { ok: false, reason: describe(r) };
}

/** `loginctl show-user <user> --property=Linger --value`: true, false, or null when it can't tell (read-only). */
export async function lingerOn(exec: ExecFile, userName: string, loginctl = LOGINCTL): Promise<boolean | null> {
  const r = await exec(loginctl, ['show-user', userName, '--property=Linger', '--value'], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v === 'yes' ? true : v === 'no' ? false : null;
}
