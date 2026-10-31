/**
 * jantar: thin client for jantard. It runs no moves or sends of its own;
 * everything goes through the daemon's control socket.
 */
import { CLI_NAME } from '@jantar/protocol';
import { legacyHomeWarning, legacyStateDirRefusal, resolvePaths } from '@jantar/daemon/config';
import { EXIT, type CliContext, type Command } from './command.js';
import { COMMANDS } from './commands/index.js';
import { createCtlClient } from './ctl.js';
import { defaultDeps } from './deps.js';
import { processIo, type CliIo } from './io.js';

export * from './args.js';
export * from './command.js';
export * from './ctl.js';
export * from './deps.js';
export * from './io.js';
export { COMMANDS } from './commands/index.js';
export { CLI_VERSION } from './version.js';

export function helpText(commands: readonly Command[] = COMMANDS): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return `usage: ${CLI_NAME} <command> [options]\n\nCommands:\n${lines.join('\n')}\n\nRun "${CLI_NAME} <command> --help" for a command's options.\n`;
}

/** Commands that run while the state dir is ccw-v2's (legacyStateDirRefusal): they never write to it. */
const UNTOUCHED_BY_LEGACY_DIR: ReadonlySet<string> = new Set(['import-ccw-v2', 'version']);

export interface MainOptions {
  io?: CliIo;
  commands?: readonly Command[];
  /** Override the context (tests). */
  context?: Partial<CliContext>;
}

export async function main(argv: readonly string[], opts: MainOptions = {}): Promise<number> {
  const io = opts.io ?? processIo;
  const commands = opts.commands ?? COMMANDS;
  const [first, ...rest] = argv;

  if (!first || first === 'help' || first === '--help' || first === '-h') {
    const topic = first === 'help' ? rest[0] : undefined;
    if (topic) {
      const cmd = commands.find((c) => c.name === topic);
      if (!cmd) {
        io.err(`${CLI_NAME}: unknown command "${topic}"\n`);
        return EXIT.usage;
      }
      io.out(`usage: ${cmd.usage}\n\n${cmd.summary}\n\nRun "${CLI_NAME} ${cmd.name} --help" for all options.\n`);
      return EXIT.ok;
    }
    io.out(helpText(commands));
    return first ? EXIT.ok : EXIT.usage;
  }
  if (first === '--version' || first === '-v') return main(['version', ...rest], opts);

  const cmd = commands.find((c) => c.name === first);
  if (!cmd) {
    io.err(`${CLI_NAME}: unknown command "${first}"\n\n${helpText(commands)}`);
    return EXIT.usage;
  }
  const paths = opts.context?.paths ?? resolvePaths({ env: io.env });
  const legacyHome = legacyHomeWarning(io.env);
  if (legacyHome) io.err(`${CLI_NAME}: ${legacyHome}\n`);
  // The old daemon's state dir (legacyStateDirRefusal) is only ever read, by the import: nothing else writes into it.
  const legacyDir = UNTOUCHED_BY_LEGACY_DIR.has(cmd.name) ? null : legacyStateDirRefusal(paths);
  if (legacyDir) {
    io.err(`${CLI_NAME}: ${legacyDir}\n`);
    return EXIT.usage;
  }
  const ctx: CliContext = {
    io,
    paths,
    ctl: opts.context?.ctl ?? createCtlClient(paths.ctlSock),
    deps: opts.context?.deps ?? defaultDeps(io.env),
  };
  return cmd.run(rest, ctx);
}
