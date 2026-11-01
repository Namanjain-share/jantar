/**
 * jantar install: set up ~/.jantar, record absolute binary paths, copy the
 * hook client, write the daemon's service and start it.
 *
 * - macOS: the LaunchAgent plist (com.jantar.daemon), loaded with launchctl.
 * - v0.6, a Linux server (or WSL2) joined to a Mac: a systemd user unit
 *   (KillMode=process) and lingering (lib/systemd.ts).
 * - v0.6, a native Windows server (preview): the Scheduled Task's lines,
 *   printed for the user to run; nothing is run here.
 * On Linux and Windows it runs only on a server (`jantar node join` made
 * this machine one): the hub is always a Mac.
 *
 * It only runs when the user runs it. `--print` shows the service file and
 * changes nothing. `--read-only` makes the daemon watch-only (the flag goes
 * into the service's argv); run again without it, install keeps what the
 * installed service has (`--no-read-only` drops it). Where no service file
 * says (Windows, a server joined with --no-service), the running daemon's
 * mode decides; on a server with neither, install refuses to guess. It never touches
 * Claude's settings (hooks are a separate, opt-in `jantar hooks install`),
 * ccw's files or ccw's own LaunchAgent. It refuses while ccw-v2's
 * LaunchAgent is installed: the old daemon would hold the port and jantard
 * would restart in a loop under KeepAlive.
 */
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureStateDirs, resolveBins } from '@jantar/daemon';
import { roleOf } from '@jantar/daemon/config';
import { LAUNCHD_LABEL, ROUTES, type HealthResponse } from '@jantar/protocol';
import { parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, callDaemon } from '../ctl.js';
import { formatReport, readCtlStatus } from '../lib/doctor.js';
import { guardRealPath } from '../lib/guard.js';
import { installHookClient } from '../lib/hook-client.js';
import { legacyAgentProblem, plistPath } from '../lib/launchd.js';
import { installService, installedReadOnly, serviceKindOf, servicePath, serviceText } from '../lib/service.js';
import { readSettingsFile, updateSettings } from '../lib/settings.js';
import { doctorReport } from './doctor.js';

const FLAGS = {
  print: { type: 'boolean', help: 'print the service file and change nothing' },
  start: { type: 'boolean', help: 'load and start the service (default; --no-start only writes files)' },
  doctor: { type: 'boolean', help: 'run doctor at the end (default; --no-doctor skips it)' },
  'read-only': { type: 'boolean', help: 'v0.6: run the daemon watch-only (--no-read-only: allow writes again)' },
} as const;

const HEALTH_WAIT_MS = 15_000;

export async function waitForDaemon(ctx: CliContext, waitMs = HEALTH_WAIT_MS): Promise<HealthResponse | null> {
  const deadline = ctx.deps.now() + waitMs;
  while (ctx.deps.now() < deadline) {
    try {
      return await callDaemon<HealthResponse>(ctx.ctl, 'GET', ROUTES.health.path, undefined, { timeoutMs: 2000 });
    } catch (e) {
      if (!(e instanceof CtlUnavailableError)) return null;
    }
    await ctx.deps.sleep(300);
  }
  return null;
}

/** Absolute paths found from the user's shell, for settings.bins entries still unset. */
export async function binsPatch(ctx: CliContext): Promise<Record<string, string>> {
  const { settings } = await readSettingsFile(ctx);
  const found = await resolveBins({ settings, env: ctx.io.env, userHome: ctx.paths.userHome, usePath: true });
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(found)) {
    const current = (settings.bins as Record<string, string | null>)[key];
    if (key === 'node') {
      if (current !== ctx.deps.nodePath) patch.node = ctx.deps.nodePath;
      continue;
    }
    if (!current && typeof value === 'string') patch[key] = value;
  }
  return patch;
}

/** The daemon's build is there (dist/main.js beside bin/jantard.mjs); else the sentence to print. */
export async function buildProblem(ctx: CliContext): Promise<string | null> {
  const { daemonBin } = ctx.deps.locations;
  try {
    await access(join(dirname(daemonBin), '..', 'dist', 'main.js'));
    return null;
  } catch {
    return `the daemon is not built (${daemonBin}); run "pnpm install && pnpm -r build" first.`;
  }
}

/**
 * Everything install does before the service itself: the state dir, the
 * recorded binaries and the hook client. `node join` runs it too.
 */
export async function prepareStateDir(ctx: CliContext, out: (text: string) => void = (t) => ctx.io.out(t)): Promise<void> {
  out(`State dir: ${ctx.paths.home}\n`);
  guardRealPath(ctx.paths.home, 'the Jantar state dir');
  await ensureStateDirs(ctx.paths, ctx.deps.platform);

  const patch = await binsPatch(ctx);
  if (Object.keys(patch).length) {
    const r = await updateSettings(ctx, { bins: patch });
    out(`Recorded binaries (${r.via === 'daemon' ? 'through the daemon' : 'config.json'}): ${Object.keys(patch).join(', ')}\n`);
  }

  const hook = await installHookClient(ctx.paths, ctx.deps.locations.hookClient);
  out(`Hook client: ${hook.path}${hook.changed ? '' : ' (unchanged)'}\n`);
}

export interface ReadOnlyChoice {
  readOnly: boolean;
  /** Where a kept --read-only came from (null: the flag, or not read-only). */
  keptFrom: 'the installed service' | 'the running daemon' | null;
}

/**
 * --read-only, --no-read-only, or (neither) what the installed service has;
 * with no service file to read, what the running daemon runs with. Null on
 * a server where nothing can tell (Windows or --no-service, daemon down): a
 * guess could widen a watch-only server. A Mac's first install is not
 * read-only, as before v0.6.
 */
export async function readOnlyChoice(ctx: CliContext, flag: boolean | undefined): Promise<ReadOnlyChoice | null> {
  if (flag !== undefined) return { readOnly: flag, keptFrom: null };
  const kind = serviceKindOf(ctx.deps.platform);
  const installed = kind ? await installedReadOnly(kind, ctx) : null;
  if (installed !== null) return { readOnly: installed, keptFrom: installed ? 'the installed service' : null };
  if (roleOf(ctx.paths) !== 'node') return { readOnly: false, keptFrom: null };
  const running = (await readCtlStatus(ctx.ctl))?.mode?.readOnly;
  if (typeof running !== 'boolean') return null;
  return { readOnly: running, keptFrom: running ? 'the running daemon' : null };
}

export const READ_ONLY_UNKNOWN =
  "can't tell whether this server is watch-only: no service file says, and its daemon is not running. Run jantar install --read-only (watch only) or jantar install --no-read-only.";

const NOT_A_SERVER =
  'jantar install sets up a macOS LaunchAgent here only on a Mac. On a Linux or Windows server, run jantar node join <line from the Mac> first (it installs the service), or run jantard yourself.';

const NOT_JOINED_WINDOWS =
  'This machine has not joined a Mac yet: jantar node join <line from the Mac> pairs it and prints these lines too.';

export default defineCommand(
  {
    name: 'install',
    summary: 'Install and start the daemon (macOS LaunchAgent; on a server a systemd unit or a Windows task) and run doctor.',
    usage: 'jantar install [--print] [--no-start] [--no-doctor] [--read-only | --no-read-only]',
    owner: 'G',
    help:
      `On a Mac: writes ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist (KeepAlive, absolute node path) and loads it with\n` +
      'launchctl. On a Linux server (after jantar node join): ~/.config/systemd/user/jantar.service, started with\n' +
      'systemctl --user, and lingering. On a Windows server: prints the Scheduled Task lines to run.\n' +
      '--read-only makes the daemon watch-only; running install again keeps the installed choice (on a server\n' +
      'with no service file to read, the running daemon\'s; with that down too, say --read-only or --no-read-only).\n' +
      'It does not install Claude Code hooks (see: jantar hooks install) and leaves ccw alone.',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const kind = serviceKindOf(ctx.deps.platform);
    const role = roleOf(ctx.paths);
    // The hub is a Mac: on Linux the service is a server's, made by `jantar node join`.
    // On Windows install only prints lines (nothing runs), so it says so and goes on.
    if (!kind || (kind === 'systemd' && role !== 'node')) {
      ctx.io.err(`${NOT_A_SERVER}\n`);
      return EXIT.failed;
    }
    if (kind === 'schtasks' && role !== 'node') ctx.io.err(`${NOT_JOINED_WINDOWS}\n`);
    const choice = await readOnlyChoice(ctx, flags['read-only']);
    if (!choice) {
      ctx.io.err(`jantar install: ${READ_ONLY_UNKNOWN}\n`);
      return EXIT.failed;
    }
    const { readOnly, keptFrom } = choice;

    if (flags.print) {
      ctx.io.out(serviceText(kind, ctx, readOnly));
      const path = servicePath(kind, ctx);
      ctx.io.err(path ? `(not written; "jantar install" writes it to ${path})\n` : '(nothing was run)\n');
      return EXIT.ok;
    }
    const unbuilt = await buildProblem(ctx);
    if (unbuilt) {
      ctx.io.err(`jantar install: ${unbuilt}\n`);
      return EXIT.failed;
    }
    if (kind === 'launchd') {
      const legacy = await legacyAgentProblem(ctx.paths);
      if (legacy) {
        ctx.io.err(`jantar install: ${legacy.detail}. Run ccw-v2 uninstall first (it keeps ~/.ccw-v2), then jantar import-ccw-v2.\n`);
        return EXIT.failed;
      }
      guardRealPath(plistPath(ctx.paths), 'the LaunchAgent plist');
    }

    await prepareStateDir(ctx);
    if (keptFrom) ctx.io.out(`Read-only: kept from ${keptFrom} (jantar install --no-read-only allows writes again).\n`);

    const svc = await installService(ctx, { readOnly, start: flags.start !== false });
    if (!svc.ok) {
      ctx.io.err(`jantar install: ${svc.reason}\n${svc.next ? `${svc.next}\n` : ''}`);
      return EXIT.failed;
    }
    ctx.io.out(svc.text);
    if (svc.started) {
      const health = await waitForDaemon(ctx);
      if (health) ctx.io.out(`Daemon: jantard ${health.daemonVersion} is running.\n`);
      else ctx.io.err(`Daemon: loaded, but it did not answer within ${HEALTH_WAIT_MS / 1000}s; see ${ctx.paths.logsDir}/daemon.err.log\n`);
    } else if (flags.start === false && kind === 'launchd') {
      ctx.io.out(`Not started (--no-start). Start it with: launchctl bootstrap gui/$(id -u) "${plistPath(ctx.paths)}"\n`);
    }

    let ok = true;
    if (kind === 'schtasks') {
      // Nothing runs until the user runs the task's lines, so doctor would only say the daemon is down.
      if (flags.doctor !== false) ctx.io.out('\nThen: jantar doctor, to see what this machine still needs.\n');
    } else if (flags.doctor !== false) {
      ctx.io.out('\n');
      const report = await doctorReport(ctx);
      ctx.io.out(formatReport(report));
      ok = report.ok;
    }
    if (role === 'node') {
      ctx.io.out(
        '\nNext:\n' +
          '  jantar node status     the link to the Mac, the terminal, accounts and hooks here\n' +
          '  jantar doctor          what this server still needs\n',
      );
    } else if (kind === 'schtasks') {
      ctx.io.out('\nNext: jantar node join <line from jantar node pair at the Mac>\n');
    } else {
      ctx.io.out(
        '\nNext:\n' +
          '  jantar open            open the dashboard on this Mac\n' +
          '  jantar remote setup    reach it from your phone (Tailscale)\n' +
          '  jantar pair            pair the phone\n' +
          '  jantar hooks install   optional: approvals and questions from the phone\n',
      );
    }
    return ok ? EXIT.ok : EXIT.failed;
  },
);
