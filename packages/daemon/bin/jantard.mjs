#!/usr/bin/env node
// jantard: thin launcher for the compiled daemon (run `pnpm -r build` first).
import { main } from '../dist/main.js';

const log = (level, msg, fields = {}) =>
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);

// A stray rejection is logged, not fatal; a synchronous crash exits so
// launchd restarts a clean daemon.
process.on('unhandledRejection', (reason) => log('error', 'unhandled rejection', { error: String(reason) }));
process.on('uncaughtException', (e) => {
  log('error', 'uncaught exception', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // Everything has been stopped; do not let a stray handle keep the process alive.
    setTimeout(() => process.exit(code), 3000).unref();
  },
  (err) => {
    process.stderr.write(`jantard: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
