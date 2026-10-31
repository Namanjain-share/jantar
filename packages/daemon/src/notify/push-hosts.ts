/**
 * Which Web Push endpoints the daemon will POST to (SEC-3).
 *
 * A subscription endpoint is a URL a paired device hands us, and the daemon
 * POSTs to it from the Mac's network position on every notification. So only
 * the push services browsers actually use are accepted:
 *
 * - Safari / iOS: web.push.apple.com and *.push.apple.com
 * - Chrome, Android, Opera, Samsung: fcm.googleapis.com
 * - Firefox: updates.push.services.mozilla.com
 * - Edge on Windows: *.notify.windows.com
 *
 * on https, the default port, no credentials in the URL. Everything else is
 * refused, with a clear reason for the cases that matter most: IP literals,
 * loopback, private and link-local addresses, `.local` and tailnet
 * (`.ts.net`) names.
 *
 * MAX_PUSH_SUBS_PER_DEVICE caps how many subscriptions one device keeps (a
 * browser normally has one; rotations and a few browsers on one device fit).
 */

export const MAX_PUSH_SUBS_PER_DEVICE = 5;

const EXACT_HOSTS: ReadonlySet<string> = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
const HOST_SUFFIXES: readonly string[] = ['.push.apple.com', '.notify.windows.com'];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function isAllowedHost(host: string): boolean {
  if (EXACT_HOSTS.has(host)) return true;
  return HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/** Why `endpoint` must not be used as a push endpoint, or null when it may. */
export function pushEndpointProblem(endpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return 'the push endpoint is not a URL';
  }
  if (u.protocol !== 'https:') return 'the push endpoint must use https';
  if (u.username || u.password) return 'the push endpoint must not carry credentials';
  if (u.port) return 'the push endpoint must use the default https port';
  // URL lowercases the host and turns decimal / hex IPv4 forms into dotted quads.
  const host = u.hostname;
  if (host.startsWith('[') || IPV4.test(host)) return 'the push endpoint must be a push service name, not an IP address';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'the push endpoint must not be a loopback name';
  if (host.endsWith('.local') || host.endsWith('.local.')) return 'the push endpoint must not be a .local name';
  if (host.endsWith('.ts.net') || host.endsWith('.ts.net.')) return 'the push endpoint must not be a tailnet name';
  if (!isAllowedHost(host)) {
    return 'the push endpoint is not a known push service (Apple, Google, Mozilla or Microsoft)';
  }
  return null;
}
