import type { Paths } from '@jantar/daemon';
import { UsageError } from './args.js';
import type { CtlClient } from './ctl.js';
import { CtlUnavailableError } from './ctl.js';
import type { CliDeps } from './deps.js';
import type { CliIo } from './io.js';
import { createBinFinder, type BinFinder } from './lib/which.js';

/** The context's executable finder (injected in tests). */
export function binFinder(ctx: CliContext): BinFinder {
  return ctx.deps.findBin ?? createBinFinder({ env: ctx.io.env, userHome: ctx.paths.userHome, platform: ctx.deps.platform });
}

export interface CliContext {
  io: CliIo;
  paths: Paths;
  ctl: CtlClient;
  deps: CliDeps;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  /** Work package that implements it (see docs/LAYOUT.md). */
  owner: string;
  /**
   * v0.4: a WP0 placeholder that prints "Not built yet." (exit 2). The
   * sentences test skips the daemon's and the web's `jantar <command> ...`
   * sentences for it; the package that builds the command drops the flag.
   */
  stub?: true;
  run(args: readonly string[], ctx: CliContext): Promise<number>;
}

/** Exit codes shared by every command. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  /** The daemon is not running or not reachable. */
  daemonDown: 3,
  notImplemented: 4,
} as const;

/** Placeholder used by the scaffold until a work package lands its command. */
export function notImplemented(name: string, summary: string, usage: string, owner: string): Command {
  return {
    name,
    summary,
    usage,
    owner,
    async run(_args, ctx) {
      ctx.io.err(`jantar ${name}: not implemented yet (work package ${owner}).\n`);
      return EXIT.notImplemented;
    },
  };
}

/**
 * Wrap a command body: usage errors exit 2 with the usage text, an unreachable
 * daemon exits 3 with a hint, anything else exits 1 with its message.
 */
export function defineCommand(
  def: Omit<Command, 'run'> & { help?: string },
  body: (args: readonly string[], ctx: CliContext) => Promise<number>,
): Command {
  const usageText = () => `usage: ${def.usage}\n\n${def.summary}\n${def.help ? `\n${def.help.replace(/\n*$/, '\n')}` : ''}`;
  return {
    name: def.name,
    summary: def.summary,
    usage: def.usage,
    owner: def.owner,
    ...(def.stub ? { stub: true as const } : {}),
    async run(args, ctx) {
      if (args.includes('--help') || args.includes('-h')) {
        const dashDash = args.indexOf('--');
        const helpAt = Math.max(args.indexOf('--help'), args.indexOf('-h'));
        if (dashDash < 0 || helpAt < dashDash) {
          ctx.io.out(usageText());
          return EXIT.ok;
        }
      }
      try {
        return await body(args, ctx);
      } catch (e) {
        if (e instanceof UsageError) {
          ctx.io.err(`jantar ${def.name}: ${e.message}\n\n${usageText()}`);
          return EXIT.usage;
        }
        if (e instanceof CtlUnavailableError) {
          ctx.io.err(`jantar ${def.name}: ${e.message}\n`);
          return EXIT.daemonDown;
        }
        ctx.io.err(`jantar ${def.name}: ${e instanceof Error ? e.message : String(e)}\n`);
        return EXIT.failed;
      }
    },
  };
}
