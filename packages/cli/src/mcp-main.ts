/**
 * jantar-mcp (0.15): Jantar's MCP server on its own, the entry `jantar mcp
 * install` registers with Claude Code (bin/jantar-mcp.mjs). Every session
 * starts one, so it loads commands/mcp.ts and what that needs, never the
 * command index the whole CLI loads. A bare start with piped stdin is the
 * server, as `jantar mcp` is (an old daemon's state dir refused the same
 * way); anything else (an argument, or a person at a terminal) is `jantar
 * mcp …`, loaded only then.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { legacyHomeWarning, legacyStateDirRefusal, resolvePaths } from '@jantar/daemon/config';
import { CLI_NAME } from '@jantar/protocol';
import { EXIT } from './command.js';
import { mcpFolder, serveMcp } from './commands/mcp.js';
import { createCtlClient } from './ctl.js';

/** What the entry reads from its process (tests give their own). */
export interface McpMainHost {
  env: Readonly<Record<string, string | undefined>>;
  stdinIsTTY: boolean;
  lines(): AsyncIterable<string>;
  cwd(): string;
  out(text: string): void;
  err(text: string): void;
  /** `jantar mcp <argv>` through the whole CLI. */
  cli(argv: readonly string[]): Promise<number>;
}

function processHost(): McpMainHost {
  return {
    env: process.env,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    lines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
    cwd: () => process.cwd(),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    cli: async (argv) => (await import('./index.js')).main(['mcp', ...argv]),
  };
}

export async function mcpMain(argv: readonly string[], host: McpMainHost = processHost()): Promise<number> {
  if (argv.length > 0 || host.stdinIsTTY) return host.cli(argv);
  const paths = resolvePaths({ env: host.env });
  const legacyHome = legacyHomeWarning(host.env);
  if (legacyHome) host.err(`${CLI_NAME}: ${legacyHome}\n`);
  const legacyDir = legacyStateDirRefusal(paths);
  if (legacyDir) {
    host.err(`${CLI_NAME}: ${legacyDir}\n`);
    return EXIT.usage;
  }
  await serveMcp({
    ctl: createCtlClient(paths.ctlSock),
    folder: mcpFolder(host.env, host.cwd),
    randomId: randomUUID,
    lines: host.lines(),
    out: (t) => host.out(t),
    err: (t) => host.err(t),
  });
  return EXIT.ok;
}
