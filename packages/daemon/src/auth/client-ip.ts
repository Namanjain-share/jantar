/**
 * The caller's address, used only to key rate limits (never to grant trust).
 *
 * By default the key is the socket peer. A forwarded header is a value the
 * client chooses unless a proxy we were told about (remote.mode) wrote it,
 * so only that proxy's header is read, and only when the peer is loopback
 * (where that proxy connects from):
 *
 * | remote.mode | header read                         |
 * |-------------|-------------------------------------|
 * | loopback    | none: the socket peer               |
 * | lan         | none: the socket peer               |
 * | tailscale   | X-Forwarded-For, last hop (Serve)   |
 * | cloudflare  | CF-Connecting-IP (cloudflared)      |
 *
 * Every other forwarded header is ignored: Tailscale Serve passes a client's
 * own CF-Connecting-IP through untouched, so trusting it there would let a
 * caller pick its bucket (dodge the limit, or lock someone else out).
 */
import type { Settings } from '@jantar/protocol';

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

export function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && LOOPBACK.test(addr);
}

export interface IpSource {
  remoteAddress?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/** The one forwarded header the configured proxy writes, or null to use the socket peer. */
export type ProxyHeader = 'x-forwarded-for' | 'cf-connecting-ip' | null;

export function proxyHeaderFor(mode: Settings['remote']['mode']): ProxyHeader {
  switch (mode) {
    case 'tailscale':
      return 'x-forwarded-for';
    case 'cloudflare':
      return 'cf-connecting-ip';
    default:
      return null;
  }
}

function single(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  return s?.trim() || undefined;
}

/** X-Forwarded-For's last entry: the one the nearest proxy appended (earlier ones are client-supplied). */
function lastHop(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v.join(',') : v;
  const parts = s?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];
  return parts[parts.length - 1];
}

export function rateLimitKey(src: IpSource, proxy: ProxyHeader = null): string {
  const peer = src.remoteAddress ?? 'unknown';
  if (proxy && isLoopbackAddress(peer)) {
    const fwd = proxy === 'x-forwarded-for' ? lastHop(src.headers[proxy]) : single(src.headers[proxy]);
    if (fwd) return `fwd:${fwd.slice(0, 64)}`;
  }
  return `ip:${peer}`;
}
