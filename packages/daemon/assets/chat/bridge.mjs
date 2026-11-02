// Jantar Chat's MCP bridge (spec 0.10 B6.3). Claude Code starts this as the
// run's one MCP server (stdio). It connects to the daemon's per-run socket
// (JANTAR_CHAT_SOCK), sends the run's token (JANTAR_CHAT_TOKEN) as its first
// line, then pipes stdin to the socket and the socket to stdout, and exits
// when either side closes. It parses nothing and holds no logic: every tool
// and every rule is the daemon's. Zero dependencies (node:net, node:process).
import net from 'node:net';
import process from 'node:process';

const sock = process.env.JANTAR_CHAT_SOCK;
const token = process.env.JANTAR_CHAT_TOKEN;
if (!sock || !token) process.exit(2);

const conn = net.connect(sock);
conn.on('connect', () => {
  conn.write(`${JSON.stringify({ token })}\n`);
  process.stdin.pipe(conn);
});
conn.pipe(process.stdout);
conn.on('close', () => process.exit(0));
conn.on('error', () => process.exit(1));
process.stdin.on('end', () => conn.end());
process.stdout.on('error', () => process.exit(0));
