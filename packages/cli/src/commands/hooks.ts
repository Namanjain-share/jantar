/**
 * jantar hooks install | uninstall | status
 *
 * A thin wrapper around the hooks installer's command body
 * (`runHooksCommand` in @jantar/daemon/hooks/cli, work package C), which
 * shows the diff, asks, backs up and merges. This wrapper adds one rule:
 * install and uninstall are a dry run unless the user passes --apply (asks
 * y/N on a terminal) or --yes (writes without asking).
 */
import type { Paths } from '@jantar/daemon';
import type { Command } from '../command.js';
import { EXIT, defineCommand } from '../command.js';
import { UsageError } from '../args.js';
import type { CliIo } from '../io.js';

/** What the wrapper needs from @jantar/daemon/hooks/cli (structurally HooksCliDeps there). */
export interface HooksCliDeps {
  io: Pick<CliIo, 'out' | 'err' | 'env' | 'isTTY'>;
  paths: Paths;
  node?: string;
  ask?: (question: string) => Promise<boolean>;
  now?: () => Date;
}
export type RunHooksCommand = (args: readonly string[], deps: HooksCliDeps) => Promise<number>;
export type HooksCliLoad = { ok: true; run: RunHooksCommand } | { ok: false; reason: string };

export const HOOKS_CLI_MODULE = '@jantar/daemon/hooks/cli';

export async function loadHooksCli(specifier: string = HOOKS_CLI_MODULE): Promise<HooksCliLoad> {
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as { runHooksCommand?: unknown };
    if (typeof mod.runHooksCommand === 'function') return { ok: true, run: mod.runHooksCommand as RunHooksCommand };
    return { ok: false, reason: `${specifier} does not export runHooksCommand` };
  } catch (e) {
    return { ok: false, reason: `the hooks installer is not available in this build (${(e as Error).message})` };
  }
}

const WRITE_FLAGS = new Set(['--yes', '-y']);

/**
 * The subcommand the installer will run, read the way its own parser reads
 * argv: the first argument that is not an option (or the value of
 * --settings), and after `--` the first argument of any kind.
 */
function hooksSubcommand(argv: readonly string[]): string | undefined {
  const dashDash = argv.indexOf('--');
  const opts = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
  const before = opts.find((a, i) => !a.startsWith('-') && opts[i - 1] !== '--settings');
  return before ?? (dashDash >= 0 ? argv[dashDash + 1] : undefined);
}

/**
 * Translate our flags to the installer's: drop --apply, and add --dry-run to
 * install / uninstall unless --apply or --yes was given. Only arguments
 * before `--` are flags; the subcommand may sit on either side of it (H5:
 * `hooks -- install` must still be a dry run), so --dry-run always goes
 * before the `--`.
 */
export function translateHooksArgs(argv: readonly string[]): string[] {
  const dashDash = argv.indexOf('--');
  const opts = dashDash >= 0 ? argv.slice(0, dashDash) : [...argv];
  const apply = opts.includes('--apply');
  const dry = opts.includes('--dry-run') || opts.includes('-n');
  if (apply && dry) throw new UsageError('--apply and --dry-run exclude each other');
  const yes = opts.some((a) => WRITE_FLAGS.has(a));
  if (yes && dry) throw new UsageError('--yes and --dry-run exclude each other');
  const out = argv.filter((a, i) => !(a === '--apply' && (dashDash < 0 || i < dashDash)));
  const sub = hooksSubcommand(argv);
  if ((sub === 'install' || sub === 'uninstall') && !apply && !yes && !dry) {
    const at = out.indexOf('--');
    if (at >= 0) out.splice(at, 0, '--dry-run');
    else out.push('--dry-run');
  }
  return out;
}

export function createHooksCommand(load: () => Promise<HooksCliLoad> = () => loadHooksCli()): Command {
  return defineCommand(
    {
      name: 'hooks',
      summary: 'Install, remove or inspect the opt-in Claude Code hooks.',
      usage: 'jantar hooks <install|uninstall|status> [--apply | --yes] [--settings FILE] [--json]',
      owner: 'G',
      help:
        '  install     add Jantar\'s hooks to Claude\'s settings (replacing ccw-v2\'s, the old name)\n' +
        '  uninstall   remove exactly Jantar\'s hook entries (and ccw-v2\'s)\n' +
        '  status      show which hooks are installed\n\n' +
        'install and uninstall only show the diff unless you add --apply (asks y/N first) or --yes\n' +
        '(writes without asking). A backup of the settings file is kept. The default file is\n' +
        '~/.claude/settings.json, which every cswap profile links to; --settings FILE edits another\n' +
        'one (for example a copy, to try it). Both end with the cswap profile line: a slot with a\n' +
        'settings file of its own gets no hooks until it is linked or edited with --settings.\n' +
        'Hooks fail open: with the daemon down, Claude behaves as without them, and\n' +
        'JANTAR_SKIP_HOOKS=1 turns them off for one session. Sessions pick hooks up on their next\n' +
        'start or resume; one that was already running keeps going without cards, and its dialogs\n' +
        'are answered from the phone through the screen.',
    },
    async (argv, ctx) => {
      const args = translateHooksArgs(argv);
      const loaded = await load();
      if (!loaded.ok) {
        ctx.io.err(`jantar hooks: ${loaded.reason}\n`);
        return EXIT.failed;
      }
      const ask = ctx.io.ask;
      return loaded.run(args, {
        io: ctx.io,
        paths: ctx.paths,
        now: () => new Date(ctx.deps.now()),
        ...(ask ? { ask: async (q: string) => /^y(es)?$/i.test((await ask(q)).trim()) } : {}),
      });
    },
  );
}

export default createHooksCommand();
