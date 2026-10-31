/**
 * jantar install: set up ~/.jantar, record absolute binary paths, copy the
 * hook client, write the LaunchAgent plist (com.jantar.daemon) and load it.
 *
 * It only runs when the user runs it. `--print` shows the plist and changes
 * nothing. It never touches Claude's settings (hooks are a separate, opt-in
 * `jantar hooks install`), ccw's files or ccw's own LaunchAgent. It refuses
 * while ccw-v2's LaunchAgent is installed: the old daemon would hold the
 * port and jantard would restart in a loop under KeepAlive.
 */
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureStateDirs, resolveBins } from '@jantar/daemon';
import { LAUNCHD_LABEL, ROUTES, type HealthResponse } from '@jantar/protocol';
import { parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, callDaemon } from '../ctl.js';
import { formatReport } from '../lib/doctor.js';
import { guardRealPath } from '../lib/guard.js';
import { installHookClient } from '../lib/hook-client.js';
import { bootoutAgent, bootstrapAgent, legacyAgentProblem, plistFor, plistPath, writePlist, readPlist } from '../lib/launchd.js';
import { readSettingsFile, updateSettings } from '../lib/settings.js';
import { doctorReport } from './doctor.js';

const FLAGS = {
  print: { type: 'boolean', help: 'print the LaunchAgent plist and change nothing' },
  start: { type: 'boolean', help: 'load and start the agent (default; --no-start only writes files)' },
  doctor: { type: 'boolean', help: 'run doctor at the end (default; --no-doctor skips it)' },
} as const;

const HEALTH_WAIT_MS = 15_000;

async function waitForDaemon(ctx: CliContext): Promise<HealthResponse | null> {
  const deadline = ctx.deps.now() + HEALTH_WAIT_MS;
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
async function binsPatch(ctx: CliContext): Promise<Record<string, string>> {
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

export default defineCommand(
  {
    name: 'install',
    summary: 'Install and start the daemon (launchd LaunchAgent) and run doctor.',
    usage: 'jantar install [--print] [--no-start] [--no-doctor]',
    owner: 'G',
    help:
      `Writes ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist (KeepAlive, absolute node path) and loads it with\n` +
      'launchctl. It does not install Claude Code hooks (see: jantar hooks install) and leaves ccw alone.',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const { daemonBin, hookClient } = ctx.deps.locations;
    const plist = plistPath(ctx.paths);
    const xml = plistFor({ paths: ctx.paths, nodePath: ctx.deps.nodePath, daemonBin, env: ctx.io.env });

    if (flags.print) {
      ctx.io.out(xml);
      ctx.io.err(`(not written; "jantar install" writes it to ${plist})\n`);
      return EXIT.ok;
    }
    if (ctx.deps.platform !== 'darwin') {
      ctx.io.err('jantar install sets up a macOS LaunchAgent. On this system, run jantard yourself (e.g. from a service manager).\n');
      return EXIT.failed;
    }
    try {
      await access(join(dirname(daemonBin), '..', 'dist', 'main.js'));
    } catch {
      ctx.io.err(`jantar install: the daemon is not built (${daemonBin}); run "pnpm install && pnpm -r build" first.\n`);
      return EXIT.failed;
    }
    const legacy = await legacyAgentProblem(ctx.paths);
    if (legacy) {
      ctx.io.err(`jantar install: ${legacy.detail}. Run ccw-v2 uninstall first (it keeps ~/.ccw-v2), then jantar import-ccw-v2.\n`);
      return EXIT.failed;
    }

    ctx.io.out(`State dir: ${ctx.paths.home}\n`);
    guardRealPath(ctx.paths.home, 'the Jantar state dir');
    guardRealPath(plist, 'the LaunchAgent plist');
    await ensureStateDirs(ctx.paths);

    const patch = await binsPatch(ctx);
    if (Object.keys(patch).length) {
      const r = await updateSettings(ctx, { bins: patch });
      ctx.io.out(`Recorded binaries (${r.via === 'daemon' ? 'through the daemon' : 'config.json'}): ${Object.keys(patch).join(', ')}\n`);
    }

    const hook = await installHookClient(ctx.paths, hookClient);
    ctx.io.out(`Hook client: ${hook.path}${hook.changed ? '' : ' (unchanged)'}\n`);

    const before = await readPlist(plist);
    await writePlist(plist, xml);
    ctx.io.out(`LaunchAgent: ${plist}${before === xml ? ' (unchanged)' : ''}\n`);

    if (flags.start !== false) {
      const out = await bootoutAgent(ctx.deps.exec, ctx.deps.uid);
      if (!out.ok) {
        ctx.io.err(`jantar install: could not unload the old agent: ${out.reason}\n`);
        return EXIT.failed;
      }
      const boot = await bootstrapAgent(ctx.deps.exec, ctx.deps.uid, plist);
      if (!boot.ok) {
        ctx.io.err(`jantar install: launchctl bootstrap failed: ${boot.reason}\n`);
        return EXIT.failed;
      }
      const health = await waitForDaemon(ctx);
      if (health) ctx.io.out(`Daemon: jantard ${health.daemonVersion} is running.\n`);
      else ctx.io.err(`Daemon: loaded, but it did not answer within ${HEALTH_WAIT_MS / 1000}s; see ${ctx.paths.logsDir}/daemon.err.log\n`);
    } else {
      ctx.io.out(`Not started (--no-start). Start it with: launchctl bootstrap gui/$(id -u) "${plist}"\n`);
    }

    let ok = true;
    if (flags.doctor !== false) {
      ctx.io.out('\n');
      const report = await doctorReport(ctx);
      ctx.io.out(formatReport(report));
      ok = report.ok;
    }
    ctx.io.out(
      '\nNext:\n' +
        '  jantar open            open the dashboard on this Mac\n' +
        '  jantar remote setup    reach it from your phone (Tailscale)\n' +
        '  jantar pair            pair the phone\n' +
        '  jantar hooks install   optional: approvals and questions from the phone\n',
    );
    return ok ? EXIT.ok : EXIT.failed;
  },
);
