/**
 * Which browser origins may write and open the event stream, and which Host
 * headers the TCP listener answers (a DNS-rebinding guard).
 *
 * Allowed: the loopback origins on the bound port (127.0.0.1, localhost,
 * [::1]), `remote.publicUrl` (e.g. the Tailscale Serve URL) and every entry
 * of `remote.allowedOrigins`. Writes and WebSocket upgrades must carry an
 * allowed `Origin`; a missing Origin is refused too, since every browser
 * sends one on those requests.
 *
 * v0.11 People (C1, D15): two Origin sets, one per principal. Her host
 * (`remote.peopleUrl`) and his are the same site, so SameSite cookies don't
 * keep them apart, and a WebSocket has no CORS: a page on her origin running
 * in his browser must never drive his routes or open his event stream.
 * - `originAllowedFor('owner')` is the set above, never holding the people
 *   origin. Owner routes, `/v1/events` and every owner socket use it.
 * - `originAllowedFor('person')` is the people origin alone. Her routes and
 *   `/v1/p/events` use it.
 * - `hostAllowed` answers both hosts. The people host exists only while its
 *   settings have no problem (protocol peopleSettingsProblem) and
 *   `remote.mode` is tailscale or cloudflare; otherwise there is none, and
 *   nothing of hers can be reached at all.
 */
import { peopleSettingsProblem, type Settings } from '@jantar/protocol';

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
  settings: () => Pick<Settings, 'remote'> & Partial<Pick<Settings, 'people'>>;
  /** The port the TCP listener is bound to (it can differ from settings when tests use port 0). */
  port: () => number;
}

export type Principal = 'owner' | 'person';

export class OriginPolicy {
  constructor(private readonly opts: OriginPolicyOptions) {}

  /** The owner's origins. Never the people origin. */
  allowedOrigins(): Set<string> {
    const port = this.opts.port();
    const remote = this.opts.settings().remote;
    const out = new Set<string>([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
    const extra = [...remote.allowedOrigins, ...(remote.publicUrl ? [remote.publicUrl] : [])];
    for (const o of extra) {
      const n = normalizeOrigin(o);
      if (n) out.add(n);
    }
    const people = this.peopleOrigin();
    if (people) out.delete(people);
    return out;
  }

  /** v0.11: her origin (`https://us.example.com`), or null while there is no people host. */
  peopleOrigin(): string | null {
    const s = this.opts.settings();
    const url = s.remote.peopleUrl ?? null;
    if (url === null) return null;
    if (s.remote.mode !== 'cloudflare' && s.remote.mode !== 'tailscale') return null;
    const people = s.people ?? { enabled: false, ownerName: null };
    if (peopleSettingsProblem({ remote: s.remote, people }) !== null) return null;
    return normalizeOrigin(url);
  }

  /** v0.11: her host (`us.example.com`), or null. */
  peopleHost(): string | null {
    const o = this.peopleOrigin();
    return o ? new URL(o).host : null;
  }

  /** v0.11: the request came in on her host. */
  isPeopleHost(host: string | undefined): boolean {
    const h = host?.trim().toLowerCase();
    const p = this.peopleHost();
    return !!h && !!p && h === p;
  }

  /** The owner's check, as before 0.11. */
  originAllowed(origin: string | undefined): boolean {
    return this.originAllowedFor('owner', origin);
  }

  /** v0.11 (C1): the Origin a principal's writes and sockets must carry. */
  originAllowedFor(principal: Principal, origin: string | undefined): boolean {
    if (!origin || origin === 'null') return false;
    const n = normalizeOrigin(origin);
    if (n === null) return false;
    if (principal === 'person') return n === this.peopleOrigin();
    return this.allowedOrigins().has(n);
  }

  /** Host header check: his hosts and, v0.11, her host. Skipped in "lan" mode (development only; no people host there). */
  hostAllowed(host: string | undefined): boolean {
    if (this.opts.settings().remote.mode === 'lan') return true;
    if (!host) return false;
    const h = host.trim().toLowerCase();
    for (const o of this.allowedOrigins()) {
      if (new URL(o).host === h) return true;
    }
    return this.isPeopleHost(h);
  }
}
