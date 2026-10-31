/**
 * Which browser origins may write and open the event stream, and which Host
 * headers the TCP listener answers (a DNS-rebinding guard).
 *
 * Allowed: the loopback origins on the bound port (127.0.0.1, localhost,
 * [::1]), `remote.publicUrl` (e.g. the Tailscale Serve URL) and every entry
 * of `remote.allowedOrigins`. Writes and WebSocket upgrades must carry an
 * allowed `Origin`; a missing Origin is refused too, since every browser
 * sends one on those requests.
 */
import type { Settings } from '@jantar/protocol';

export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export interface OriginPolicyOptions {
  settings: () => Pick<Settings, 'remote'>;
  /** The port the TCP listener is bound to (it can differ from settings when tests use port 0). */
  port: () => number;
}

export class OriginPolicy {
  constructor(private readonly opts: OriginPolicyOptions) {}

  allowedOrigins(): Set<string> {
    const port = this.opts.port();
    const remote = this.opts.settings().remote;
    const out = new Set<string>([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
    const extra = [...remote.allowedOrigins, ...(remote.publicUrl ? [remote.publicUrl] : [])];
    for (const o of extra) {
      const n = normalizeOrigin(o);
      if (n) out.add(n);
    }
    return out;
  }

  originAllowed(origin: string | undefined): boolean {
    if (!origin || origin === 'null') return false;
    const n = normalizeOrigin(origin);
    return n !== null && this.allowedOrigins().has(n);
  }

  /** Host header check. Skipped in "lan" mode (development only). */
  hostAllowed(host: string | undefined): boolean {
    if (this.opts.settings().remote.mode === 'lan') return true;
    if (!host) return false;
    const h = host.trim().toLowerCase();
    for (const o of this.allowedOrigins()) {
      if (new URL(o).host === h) return true;
    }
    return false;
  }
}
