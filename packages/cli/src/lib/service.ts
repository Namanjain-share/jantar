/**
 * v0.6: the daemon's service, per OS. `jantar install` / `uninstall` use
 * it, and so do `jantar node join` (install), `node access` (restart) and
 * `node leave` (remove).
 *
 * - macOS: the LaunchAgent (lib/launchd.ts), as before v0.6.
 * - Linux (and WSL2): a systemd user unit plus lingering (lib/systemd.ts).
 * - Windows (preview): no service code. The lines to run are printed: a
 *   Scheduled Task at logon running `jantard --log-files` (the daemon then
 *   writes its own log files), and how to run, stop and remove it.
 *
 * `--read-only` goes into the service's argv. When `jantar install` is run
 * again without --read-only or --no-read-only (an update), the installed
 * service's choice is kept, so updating a watch-only server never widens
 * what it allows. Where no service file can be read (Windows, a server
 * joined with --no-service), install.ts asks the running daemon, and on a
 * server refuses to guess when that is down too.
 */
import { userInfo } from 'node:os';
import { stateDirFromEnv } from '@jantar/daemon';
import { binFinder, type CliContext } from '../command.js';
import { bootoutAgent, bootstrapAgent, plistExists, plistFor, plistPath, readPlist, removePlist, writePlist } from './launchd.js';
import {
  MIN_SYSTEMD,
  SYSTEMCTL,
  enableLinger,
  readUnit,
  reloadUnits,
  removeUnit,
  restartUnit,
  serviceIsReadOnly,
  startUnit,
  stopUnit,
  systemdVersion,
  unitFor,
  unitPath,
  UNIT_NAME,
  writeUnit,
} from './systemd.js';

export type ServiceKind = 'launchd' | 'systemd' | 'schtasks';

/** The service this OS gets, or null where Jantar has none. */
export function serviceKindOf(platform: NodeJS.Platform): ServiceKind | null {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  if (platform === 'win32') return 'schtasks';
  return null;
}

/** The Scheduled Task's name. */
export const TASK_NAME = 'Jantar';
/** schtasks refuses a /TR value longer than this. */
export const SCHTASKS_TR_MAX = 261;

export interface SchtasksLines {
  create: string;
  run: string;
  end: string;
  remove: string;
  /** The /TR value (the program the task runs). */
  tr: string;
}

/** What a path in the task's line may not hold. */
const CMD_UNSAFE = /["&|^<>%\u0000-\u001f]/;

/**
 * The lines for cmd.exe (Command Prompt), not PowerShell: `\"` inside the
 * /TR value is how schtasks takes a quoted path. Pure.
 */
export function schtasksLines(input: {
  nodePath: string;
  daemonBin: string;
  env: Readonly<Record<string, string | undefined>>;
  readOnly?: boolean;
  task?: string;
}): SchtasksLines {
  const task = input.task ?? TASK_NAME;
  if (!/^[A-Za-z0-9_-]+$/.test(task)) throw new Error(`bad task name "${task}"`);
  const home = stateDirFromEnv(input.env);
  // `\"` keeps each path outside cmd.exe's own quotes, so & | ^ < > and %VAR% there would split or change the pasted line.
  for (const p of [input.nodePath, input.daemonBin, ...(home ? [home] : [])]) {
    if (CMD_UNSAFE.test(p)) throw new Error(`a path in the task holds a character cmd.exe can't take there (" & | ^ < > % or a control character): ${p}`);
  }
  const q = (p: string) => `\\"${p}\\"`;
  const words = [q(input.nodePath), q(input.daemonBin), '--log-files'];
  // As the LaunchAgent pins a non-default JANTAR_HOME: the task has no environment of its own, so --home.
  if (home) words.push('--home', q(home));
  if (input.readOnly) words.push('--read-only');
  const tr = words.join(' ');
  return {
    tr,
    create: `schtasks /Create /TN ${task} /SC ONLOGON /RL LIMITED /F /TR "${tr}"`,
    run: `schtasks /Run /TN ${task}`,
    end: `schtasks /End /TN ${task}`,
    remove: `schtasks /Delete /TN ${task} /F`,
  };
}

/** The value of /TR as schtasks stores it (`\"` read as `"`), for its length limit. */
function storedTr(tr: string): string {
  return tr.replace(/\\"/g, '"');
}

export interface ServiceInput {
  readOnly: boolean;
}

function specOf(ctx: CliContext, readOnly: boolean) {
  return {
    paths: ctx.paths,
    nodePath: ctx.deps.nodePath,
    daemonBin: ctx.deps.locations.daemonBin,
    env: ctx.io.env,
    readOnly,
  };
}

/** Where the service file lives (null on Windows: the task lives in Task Scheduler). */
export function servicePath(kind: ServiceKind, ctx: Pick<CliContext, 'paths' | 'io'>): string | null {
  if (kind === 'launchd') return plistPath(ctx.paths);
  if (kind === 'systemd') return unitPath(ctx.paths);
  return null;
}

/** What `jantar install --print` shows: the plist, the unit, or the task's lines. */
export function serviceText(kind: ServiceKind, ctx: CliContext, readOnly: boolean): string {
  const spec = specOf(ctx, readOnly);
  if (kind === 'launchd') return plistFor(spec);
  if (kind === 'systemd') return unitFor(spec);
  const l = schtasksLines(spec);
  return `${l.create}\n${l.run}\n`;
}

/** Whether the installed service runs the daemon with --read-only; null when there is no service file to read (Windows, --no-service). */
export async function installedReadOnly(kind: ServiceKind, ctx: Pick<CliContext, 'paths' | 'io'>): Promise<boolean | null> {
  const path = servicePath(kind, ctx);
  if (!path) return null;
  const text = kind === 'launchd' ? await readPlist(path) : await readUnit(path);
  return text === null ? null : serviceIsReadOnly(text);
}

/** The line that runs the daemon by hand, as --no-service prints it. */
export function daemonLine(ctx: Pick<CliContext, 'deps'>, readOnly: boolean): string {
  return `${ctx.deps.nodePath} ${ctx.deps.locations.daemonBin}${readOnly ? ' --read-only' : ''}`;
}

/** The user lingering is turned on for. */
export function userNameOf(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env.USER || env.LOGNAME;
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return '$USER';
  }
}

export type ServiceOutcome =
  | {
      ok: true;
      kind: ServiceKind;
      /** Lines to print, each ending in \n. */
      text: string;
      /** The daemon was (re)started and should answer soon. */
      started: boolean;
    }
  /** `next`: what to do instead, when the caller's usual "then jantar install" would not help. */
  | { ok: false; reason: string; next?: string };

async function systemctlOf(ctx: CliContext): Promise<string> {
  return (await binFinder(ctx)('systemctl')) ?? SYSTEMCTL;
}

async function loginctlOf(ctx: CliContext): Promise<string | undefined> {
  return (await binFinder(ctx)('loginctl')) ?? undefined;
}

/** After a failed `systemctl --user` start: this machine is already paired, so never "join again", but the daemon's own line. */
function noSystemdNext(line: string): string {
  return `Inside WSL, turn systemd on ([boot] systemd=true in /etc/wsl.conf, then wsl --shutdown) and run jantar install again. Elsewhere, run the daemon yourself: ${line}`;
}

/**
 * The Windows lines, as `install` and `node join` print them: each command
 * on its own line, so it can be pasted as printed (the windows-latest job
 * runs them exactly so).
 */
export function schtasksText(ctx: CliContext, readOnly: boolean): string {
  const l = schtasksLines(specOf(ctx, readOnly));
  let text =
    'Service: on Windows, Jantar runs as a task at logon. In Command Prompt (cmd.exe, Run as administrator), run:\n' +
    `  ${l.create}\n` +
    `  ${l.run}\n` +
    'It runs while you are logged on (an unattended server needs auto-logon or a kept session).\n' +
    'At logon a console window opens for it: keep it open (minimise it), as closing it stops Jantar.\n' +
    'To stop it, then remove it:\n' +
    `  ${l.end}\n` +
    `  ${l.remove}\n`;
  if (storedTr(l.tr).length > SCHTASKS_TR_MAX) {
    text += `Note: the task's command is ${storedTr(l.tr).length} characters and schtasks takes ${SCHTASKS_TR_MAX} at most: move the repository to a shorter path.\n`;
  }
  return text;
}

/**
 * Write the service file and (unless `start` is false) load and start it.
 * On Windows nothing is written or run: the outcome's text is the lines to
 * run. The state dir, the recorded binaries and the hook client are the
 * caller's (install.ts).
 */
export async function installService(ctx: CliContext, input: ServiceInput & { start: boolean }): Promise<ServiceOutcome> {
  const kind = serviceKindOf(ctx.deps.platform);
  if (!kind) return { ok: false, reason: `Jantar has no service for ${ctx.deps.platform}` };
  const spec = specOf(ctx, input.readOnly);

  if (kind === 'launchd') {
    const plist = plistPath(ctx.paths);
    const xml = plistFor(spec);
    const before = await readPlist(plist);
    await writePlist(plist, xml);
    let text = `LaunchAgent: ${plist}${before === xml ? ' (unchanged)' : ''}\n`;
    if (!input.start) return { ok: true, kind, text, started: false };
    const out = await bootoutAgent(ctx.deps.exec, ctx.deps.uid);
    if (!out.ok) return { ok: false, reason: `could not unload the old agent: ${out.reason}` };
    const boot = await bootstrapAgent(ctx.deps.exec, ctx.deps.uid, plist);
    if (!boot.ok) return { ok: false, reason: `launchctl bootstrap failed: ${boot.reason}` };
    if (input.readOnly) text += 'Read-only: the daemon runs with --read-only (watch only).\n';
    return { ok: true, kind, text, started: true };
  }

  if (kind === 'systemd') {
    const systemctl = await systemctlOf(ctx);
    const version = await systemdVersion(ctx.deps.exec, systemctl);
    if (version !== null && version < MIN_SYSTEMD) {
      return {
        ok: false,
        reason: `systemd ${version} is older than ${MIN_SYSTEMD}, which the unit's log files need`,
        next: `Run the daemon yourself instead: ${daemonLine(ctx, input.readOnly)}`,
      };
    }
    const path = unitPath(ctx.paths);
    const unit = unitFor(spec);
    const before = await readUnit(path);
    await writeUnit(path, unit);
    const ro = input.readOnly ? ' Read-only: the daemon runs with --read-only (watch only).' : '';
    if (!input.start) {
      return {
        ok: true,
        kind,
        text: `Service: systemd user unit ${UNIT_NAME} written (${path}${before === unit ? ', unchanged' : ''}). Start it: systemctl --user enable --now ${UNIT_NAME}${ro ? `\n${ro.trim()}` : ''}\n`,
        started: false,
      };
    }
    const started = await startUnit(ctx.deps.exec, systemctl);
    if (!started.ok) return { ok: false, reason: started.reason, next: noSystemdNext(daemonLine(ctx, input.readOnly)) };
    const user = userNameOf(ctx.io.env);
    const loginctl = await loginctlOf(ctx);
    const linger = await enableLinger(ctx.deps.exec, user, loginctl);
    const lingerText = linger.ok
      ? 'Lingering is on, so it keeps running after you log out.'
      : `Lingering is off, so it stops when you log out. Turn it on: sudo loginctl enable-linger ${user}`;
    return { ok: true, kind, text: `Service: systemd user unit ${UNIT_NAME}, started. ${lingerText}${ro}\n`, started: true };
  }

  return { ok: true, kind, text: schtasksText(ctx, input.readOnly), started: false };
}

/** Restart the installed service (node access: the new Access token is read at the next link). */
export async function restartService(ctx: CliContext): Promise<ServiceOutcome> {
  const kind = serviceKindOf(ctx.deps.platform);
  if (!kind) return { ok: false, reason: `Jantar has no service for ${ctx.deps.platform}` };
  if (kind === 'launchd') {
    const plist = plistPath(ctx.paths);
    if (!(await plistExists(plist))) return { ok: false, reason: 'the LaunchAgent is not installed (jantar install)' };
    const out = await bootoutAgent(ctx.deps.exec, ctx.deps.uid);
    if (!out.ok) return { ok: false, reason: `could not unload the agent: ${out.reason}` };
    const boot = await bootstrapAgent(ctx.deps.exec, ctx.deps.uid, plist);
    if (!boot.ok) return { ok: false, reason: `launchctl bootstrap failed: ${boot.reason}` };
    return { ok: true, kind, text: 'Restarted the LaunchAgent.\n', started: true };
  }
  if (kind === 'systemd') {
    if ((await readUnit(unitPath(ctx.paths))) === null) return { ok: false, reason: `the systemd unit is not installed (jantar install)` };
    const r = await restartUnit(ctx.deps.exec, await systemctlOf(ctx));
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, kind, text: `Restarted ${UNIT_NAME}.\n`, started: true };
  }
  const l = schtasksLines(specOf(ctx, false));
  return { ok: true, kind, text: `Restart the task in Command Prompt: ${l.end}, then ${l.run}\n`, started: false };
}

/**
 * Stop and remove the service. Removing one that is not there is fine; where
 * systemctl can't run, the unit still goes and the text says how to stop a
 * jantard still running.
 */
export async function removeService(ctx: CliContext): Promise<ServiceOutcome> {
  const kind = serviceKindOf(ctx.deps.platform);
  if (!kind) return { ok: false, reason: `Jantar has no service for ${ctx.deps.platform}` };
  if (kind === 'launchd') {
    let text = '';
    if (ctx.deps.platform === 'darwin') {
      const out = await bootoutAgent(ctx.deps.exec, ctx.deps.uid);
      if (!out.ok) return { ok: false, reason: `launchctl bootout failed: ${out.reason}` };
      text += `Daemon: ${out.detail ?? 'stopped'}\n`;
    }
    const plist = plistPath(ctx.paths);
    text += `LaunchAgent: ${(await removePlist(plist)) ? `removed ${plist}` : 'not installed'}\n`;
    return { ok: true, kind, text, started: false };
  }
  if (kind === 'systemd') {
    const path = unitPath(ctx.paths);
    // No unit, nothing systemd could be running: systemctl is not asked (it may not even run here).
    if ((await readUnit(path)) === null) return { ok: true, kind, text: 'Service: not installed\n', started: false };
    const systemctl = await systemctlOf(ctx);
    const stop = await stopUnit(ctx.deps.exec, systemctl);
    // The unit goes either way: a systemctl that can't run here must not stop a leave or an uninstall.
    await removeUnit(path);
    if (stop.ok) {
      await reloadUnits(ctx.deps.exec, systemctl);
      return { ok: true, kind, text: `Daemon: ${stop.detail ?? 'stopped'}\nService: removed ${path}\n`, started: false };
    }
    const daemon = stop.absent
      ? `Daemon: systemd does not run here (${stop.reason}), so the unit never ran; stop a jantard you started yourself.`
      : `Daemon: not stopped (systemctl --user: ${stop.reason}). If it still runs, stop it as ${userNameOf(ctx.io.env)} in a login shell: systemctl --user stop ${UNIT_NAME}`;
    return { ok: true, kind, text: `${daemon}\nService: removed ${path}\n`, started: false };
  }
  const l = schtasksLines(specOf(ctx, false));
  return { ok: true, kind, text: `Stop and remove the task in Command Prompt: ${l.end}, then ${l.remove}\n`, started: false };
}

