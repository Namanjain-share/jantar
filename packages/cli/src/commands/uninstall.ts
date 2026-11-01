/**
 * jantar uninstall: stop and remove the daemon's service (the LaunchAgent;
 * v0.6, on a server: the systemd user unit, or the Windows task's lines).
 * Keeps ~/.jantar (devices, audit log, settings) unless --purge is given.
 */
import { rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { STATE_DIR_NAME } from '@jantar/protocol';
import { parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { guardRealPath } from '../lib/guard.js';
import { settingsMentionHook } from '../lib/hooks-files.js';
import { removeService } from '../lib/service.js';

const FLAGS = {
  purge: { type: 'boolean', help: 'also delete the state dir (~/.jantar: settings, devices, audit log)' },
  yes: { type: 'boolean', short: 'y', help: 'with --purge: do not ask for confirmation' },
  force: { type: 'boolean', help: 'with --purge: purge even though Claude hooks still point at Jantar' },
} as const;

/** Refuse to delete anything that is not clearly Jantar's own state dir. */
export function purgeTargetOk(ctx: Pick<CliContext, 'paths' | 'io'>): { ok: true } | { ok: false; reason: string } {
  const home = resolve(ctx.paths.home);
  const userHome = resolve(ctx.paths.userHome);
  if (home === '/' || home === userHome || userHome.startsWith(`${home}/`)) {
    return { ok: false, reason: `${home} is not a Jantar state dir` };
  }
  const explicit = ctx.io.env.JANTAR_HOME ? resolve(ctx.io.env.JANTAR_HOME) === home : false;
  if (!explicit && basename(home) !== STATE_DIR_NAME) {
    return { ok: false, reason: `${home} is not named ${STATE_DIR_NAME}` };
  }
  return { ok: true };
}

export default defineCommand(
  {
    name: 'uninstall',
    summary: 'Stop the daemon and remove its service (LaunchAgent, systemd unit; keeps ~/.jantar).',
    usage: 'jantar uninstall [--purge [--yes] [--force]]',
    owner: 'G',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const hooked = await settingsMentionHook(ctx.paths.claudeSettings, ctx.paths.hookBin);

    if (flags.purge) {
      const target = purgeTargetOk(ctx);
      if (!target.ok) {
        ctx.io.err(`jantar uninstall: refusing to purge: ${target.reason}\n`);
        return EXIT.failed;
      }
      if (hooked && !flags.force) {
        ctx.io.err(
          `jantar uninstall: Claude's settings still call ${ctx.paths.hookBin}; --purge would delete it.\n` +
            'Remove the hooks first (jantar hooks uninstall --apply), or add --force.\n',
        );
        return EXIT.failed;
      }
    }

    const removed = await removeService(ctx);
    if (!removed.ok) {
      ctx.io.err(`jantar uninstall: ${removed.reason}\n`);
      return EXIT.failed;
    }
    ctx.io.out(removed.text);

    if (flags.purge) {
      if (!flags.yes) {
        const answer = ctx.io.ask ? (await ctx.io.ask(`Delete ${ctx.paths.home} (settings, paired devices, audit log)? [y/N] `)).trim().toLowerCase() : '';
        if (answer !== 'y' && answer !== 'yes') {
          ctx.io.out(`Kept ${ctx.paths.home}${ctx.io.ask ? '' : ' (not a terminal; add --yes to delete it)'}.\n`);
          return ctx.io.ask ? EXIT.ok : EXIT.failed;
        }
      }
      guardRealPath(ctx.paths.home, 'the Jantar state dir');
      await rm(ctx.paths.home, { recursive: true, force: true });
      ctx.io.out(`Deleted ${ctx.paths.home}\n`);
    } else {
      ctx.io.out(`Kept ${ctx.paths.home} (settings, devices, audit log). Delete it with: jantar uninstall --purge\n`);
    }
    if (hooked) {
      ctx.io.out(
        `\nClaude Code hooks still point at ${ctx.paths.hookBin}. They fail open (Claude works as without them),\n` +
          'but you can remove them with: jantar hooks uninstall --apply\n',
      );
    }
    return EXIT.ok;
  },
);
