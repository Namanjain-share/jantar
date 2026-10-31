/**
 * Remote access helpers: Tailscale Serve (recommended) and a Cloudflare quick
 * tunnel (fallback). The daemon itself always stays on 127.0.0.1; these tools
 * put an HTTPS front door in front of it. Pairing is still required on top.
 *
 * Only read-only commands run unless the user asks for `--apply`
 * (`tailscale status --json`, `tailscale serve status --json`). Tailscale
 * Funnel (public internet) is never turned on, and is flagged if found.
 */
import type { ExecFile } from '@jantar/daemon';
import type { Settings } from '@jantar/protocol';

export interface ServeInfo {
  /** Some `tailscale serve` config exists. */
  configured: boolean;
  /** Proxy targets of every Serve handler. */
  proxiesTo: string[];
  /** One handler proxies to this daemon's loopback URL. */
  matchesDaemon: boolean;
  /** Funnel (public internet) is enabled somewhere: Jantar must not be exposed that way. */
  funnel: boolean;
  /** https://<host> URLs Serve answers on. */
  urls: string[];
}

export interface TailscaleInfo {
  bin: string | null;
  installed: boolean;
  running: boolean;
  backendState?: string;
  /** MagicDNS name without the trailing dot, e.g. mac.tailnet-1234.ts.net */
  dnsName?: string;
  serve?: ServeInfo;
  error?: string;
}

const TIMEOUT = 8000;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The daemon's loopback URL as Serve shows it, normalised for comparison. */
function normTarget(t: string): string {
  let s = t.trim().replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(s)) s = /^\d+$/.test(s) ? `http://127.0.0.1:${s}` : `http://${s}`;
  return s.replace('://localhost:', '://127.0.0.1:');
}

export function parseServeStatus(json: unknown, daemonPort: number): ServeInfo {
  const info: ServeInfo = { configured: false, proxiesTo: [], matchesDaemon: false, funnel: false, urls: [] };
  if (!isRecord(json)) return info;
  const want = `http://127.0.0.1:${daemonPort}`;
  const web = isRecord(json.Web) ? json.Web : {};
  for (const [hostPort, cfg] of Object.entries(web)) {
    info.configured = true;
    const [host, port] = hostPort.split(':');
    if (host) info.urls.push(port && port !== '443' ? `https://${host}:${port}` : `https://${host}`);
    const handlers = isRecord(cfg) && isRecord(cfg.Handlers) ? cfg.Handlers : {};
    for (const h of Object.values(handlers)) {
      if (isRecord(h) && typeof h.Proxy === 'string') {
        info.proxiesTo.push(h.Proxy);
        if (normTarget(h.Proxy) === want) info.matchesDaemon = true;
      }
    }
  }
  if (isRecord(json.TCP) && Object.keys(json.TCP).length) info.configured = true;
  if (isRecord(json.AllowFunnel)) info.funnel = Object.values(json.AllowFunnel).some((v) => v === true);
  return info;
}

export async function probeTailscale(exec: ExecFile, bin: string | null, daemonPort: number): Promise<TailscaleInfo> {
  if (!bin) return { bin: null, installed: false, running: false };
  const info: TailscaleInfo = { bin, installed: true, running: false };
  const st = await exec(bin, ['status', '--json'], { timeoutMs: TIMEOUT });
  const status = parseJson(st.stdout);
  if (isRecord(status)) {
    if (typeof status.BackendState === 'string') info.backendState = status.BackendState;
    info.running = status.BackendState === 'Running';
    const self = isRecord(status.Self) ? status.Self : {};
    if (typeof self.DNSName === 'string' && self.DNSName) info.dnsName = self.DNSName.replace(/\.$/, '');
  } else {
    info.error = (st.spawnError ?? st.stderr.trim()) || `tailscale status exited ${st.code}`;
    return info;
  }
  if (info.running) {
    const sv = await exec(bin, ['serve', 'status', '--json'], { timeoutMs: TIMEOUT });
    info.serve = parseServeStatus(parseJson(sv.stdout) ?? {}, daemonPort);
  }
  return info;
}

export function daemonTarget(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Argv that makes Tailscale Serve proxy https://<this mac>/ to the daemon (tailnet only, never Funnel). */
export function tailscaleServeArgs(port: number): string[] {
  return ['serve', '--bg', '--https=443', daemonTarget(port)];
}

/** Same thing in the pre-1.52 syntax (`tailscale serve https / <target>`). */
export function tailscaleServeLegacyArgs(port: number): string[] {
  return ['serve', 'https', '/', daemonTarget(port)];
}

export function tailscaleServeOffArgs(): string[] {
  return ['serve', '--https=443', 'off'];
}

export function cloudflaredQuickArgs(port: number): string[] {
  return ['tunnel', '--no-autoupdate', '--url', daemonTarget(port)];
}

/** Quote an argv for display only (never executed through a shell). */
export function shellQuote(argv: readonly string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export type RemoteMode = Settings['remote']['mode'];

export function validatePublicUrl(raw: string): { ok: true; url: string; origin: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a URL` };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'the public URL must be https:// (phones need a secure context for the app and push)' };
  if (u.username || u.password) return { ok: false, reason: 'the public URL must not contain a user name or password' };
  if (u.search || u.hash) return { ok: false, reason: 'the public URL must not have a query or fragment' };
  const path = u.pathname.replace(/\/+$/, '');
  if (path) return { ok: false, reason: 'serve the app at the root of the host (no path)' };
  return { ok: true, url: u.origin, origin: u.origin };
}

export function modeForUrl(url: string): RemoteMode {
  const host = new URL(url).hostname;
  if (host.endsWith('.ts.net')) return 'tailscale';
  return 'cloudflare';
}

/** The settings patch that points pairing links (and the Origin check) at `publicUrl`. */
export function remotePatch(current: Settings, publicUrl: string | null, mode?: RemoteMode): Record<string, unknown> {
  if (publicUrl === null) {
    const old = current.remote.publicUrl ? new URL(current.remote.publicUrl).origin : null;
    return {
      remote: {
        mode: 'loopback',
        publicUrl: null,
        allowedOrigins: current.remote.allowedOrigins.filter((o) => o !== old),
      },
    };
  }
  const origin = new URL(publicUrl).origin;
  const origins = [...new Set([...current.remote.allowedOrigins, origin])];
  return { remote: { mode: mode ?? modeForUrl(publicUrl), publicUrl: origin, allowedOrigins: origins } };
}
