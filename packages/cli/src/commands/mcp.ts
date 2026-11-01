/**
 * jantar mcp (v0.5.3): an MCP server for Claude Code on stdin and stdout
 * (the Intel shelf, and the todos of the Life project linked to the
 * session's folder), a ctl.sock client like every command. On a terminal
 * it prints how to add it to Claude Code. WP0's stub until the Intel + MCP
 * package lands.
 */
import { EXIT, defineCommand } from '../command.js';

export default defineCommand(
  {
    name: 'mcp',
    summary: "Run Jantar's MCP server for Claude Code (the Intel shelf and this folder's todos).",
    usage: 'jantar mcp',
    owner: 'WP-MCP',
    stub: true,
  },
  async (_argv, ctx) => {
    ctx.io.err('Not built yet.\n');
    return EXIT.usage;
  },
);
