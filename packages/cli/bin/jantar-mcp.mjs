#!/usr/bin/env node
// jantar-mcp: Jantar's MCP server alone, as `jantar mcp install` adds it to Claude Code (run `pnpm -r build` first).
import { mcpMain } from '../dist/mcp-main.js';

mcpMain(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`jantar-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
