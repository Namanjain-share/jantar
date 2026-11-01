#!/usr/bin/env node
/**
 * The real-tmux suite's program in a pane (lane L2): it shows a banner (the
 * screen a test wants, e.g. a dialog), puts its terminal in raw mode and
 * logs every chunk of bytes it gets, one JSON line each: {"at": ms, "hex":
 * "1b5b42"}. With --bracketed it asks for bracketed paste first, as Claude
 * does. When ready it writes `<log>.ready` holding its pid. Zero
 * dependencies; runs only inside the suite's throwaway container.
 *
 *   node keylog.mjs <log file> [--banner <file>] [--bracketed]
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [log, ...rest] = process.argv.slice(2);
if (!log) {
  process.stderr.write('usage: keylog.mjs <log file> [--banner <file>] [--bracketed]\n');
  process.exit(2);
}
const bannerAt = rest.indexOf('--banner');
const banner = bannerAt >= 0 ? readFileSync(rest[bannerAt + 1], 'utf8') : '';
const bracketed = rest.includes('--bracketed');

// The banner as the screen shows it: every line from the left edge.
if (banner) process.stdout.write(banner.replace(/\r?\n/g, '\r\n'));
if (bracketed) process.stdout.write('\u001b[?2004h');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  appendFileSync(log, `${JSON.stringify({ at: Date.now(), hex: chunk.toString('hex') })}\n`);
});
writeFileSync(`${log}.ready`, String(process.pid));
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
