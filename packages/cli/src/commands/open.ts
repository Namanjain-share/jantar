/**
 * jantar open: open the dashboard in this Mac's browser, one tap from paired.
 *
 * It asks the daemon (control socket) for a one-time pairing code and opens
 * http://127.0.0.1:<port>/pair#c=<code>: the browser trades the code for a
 * device cookie and lands on the board. <port> is the one the daemon is
 * listening on (its /ctl/status), so a daemon started with --port, or on a
 * busy 7420, gets a link that reaches it; the settings' remote.port is only
 * the fallback for a daemon that does not say. The code is in the fragment (never
 * sent to the server in a request line or logged), single use, and expires
 * after 10 minutes. This Mac's browser gets admin, since only someone at this
 * Mac (with access to the 0600 socket) can run this.
 */
import { ROUTES, type PairStartResponse } from '@jantar/protocol';
import { parseArgs } from '../args.js';
import { EXIT, binFinder, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { localBaseUrl, readSettings } from '../lib/settings.js';

const FLAGS = {
  print: { type: 'boolean', help: 'print the one-time link instead of opening a browser' },
  admin: { type: 'boolean', help: 'grant admin to this browser (default; --no-admin for read + control)' },
} as const;

/** The local (loopback) pairing link for `code`. */
export function localPairUrl(base: string, daemonUrl: string): string {
  const fragment = new URL(daemonUrl).hash;
  return `${base}/pair${fragment}`;
}

/** http://<host>:<port> of an address the daemon listens on; a wildcard host becomes 127.0.0.1. */
export function boundBaseUrl(api: { host: string; port: number }): string {
  const bound = api.host === '0.0.0.0' || api.host === '::' ? '127.0.0.1' : api.host;
  return `http://${bound.includes(':') ? `[${bound}]` : bound}:${api.port}`;
}

/**
 * Where this daemon listens, from its status: undefined when the status does
 * not say (an older daemon, or no answer), null when it is not on TCP at all.
 */
async function listening(ctx: CliContext): Promise<{ host: string; port: number } | null | undefined> {
  try {
    const st = await ctx.ctl.request<{ api?: { host?: unknown; port?: unknown } | null }>('GET', '/ctl/status');
    if (st.status !== 200 || !st.body || typeof st.body !== 'object' || !('api' in st.body)) return undefined;
    const api = st.body.api;
    if (api === null) return null;
    if (api && typeof api.host === 'string' && typeof api.port === 'number' && Number.isInteger(api.port)) return { host: api.host, port: api.port };
    return undefined;
  } catch {
    return undefined;
  }
}

export default defineCommand(
  {
    name: 'open',
    summary: "Open the dashboard in this Mac's browser with a one-time pairing link.",
    usage: 'jantar open [--print] [--no-admin]',
    owner: 'G',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const api = await listening(ctx);
    if (api === null) throw new Error('the daemon is not listening on TCP, so there is no dashboard to open');
    const base = api ? boundBaseUrl(api) : localBaseUrl((await readSettings(ctx)).settings);
    const scopes = flags.admin === false ? ['read', 'control'] : ['read', 'control', 'admin'];
    const res = await callDaemon<PairStartResponse>(
      ctx.ctl,
      'POST',
      ROUTES.pairStart.path,
      { name: 'This Mac', scopes },
      { idempotencyKey: ctx.deps.randomId() },
    );
    const url = localPairUrl(base, res.url);
    if (!new URL(url).hash) throw new Error('the daemon returned a pairing link without a code');
    if (flags.print) {
      ctx.io.out(`${url}\n`);
      return EXIT.ok;
    }
    const opener = ctx.deps.platform === 'darwin' ? await binFinder(ctx)('open') : await binFinder(ctx)('xdg-open');
    if (!opener) {
      ctx.io.err('No way to open a browser here; open this one-time link yourself:\n');
      ctx.io.out(`${url}\n`);
      return EXIT.failed;
    }
    const r = await ctx.deps.exec(opener, [url], { timeoutMs: 15_000 });
    if (r.code !== 0) {
      ctx.io.err(`Could not open the browser (${(r.spawnError ?? r.stderr.trim()) || `exit ${r.code}`}). Open this one-time link yourself:\n`);
      ctx.io.out(`${url}\n`);
      return EXIT.failed;
    }
    ctx.io.out(`Opened ${base} in your browser (one-time link, valid 10 minutes; tap Pair this browser there).\n`);
    return EXIT.ok;
  },
);
