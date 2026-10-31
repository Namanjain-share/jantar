/**
 * Response headers sent with everything the TCP listener serves.
 *
 * - CSP: scripts only from the daemon itself, no framing (stops tap-jacking
 *   of Approve buttons), no plugins, no base-uri tricks. Styles only from
 *   the app's own stylesheet, the same as the policy the web build puts in
 *   index.html (packages/web/build/pwa-plugin.ts): the app sets element
 *   styles through the CSSOM only, which style-src does not govern, and
 *   never injects a <style> (test/integration/web.integration.test.ts).
 * - `connect-src` names the WebSocket origin explicitly: some browsers do not
 *   let 'self' cover ws: / wss:.
 * - `img-src` allows blob:, which the meta policy allows too (v0.3): terminal
 *   screenshots, SVG previews and notebook images are fetched as bytes and
 *   shown through object URLs, never data: URIs. Both policies apply at
 *   once, so packages/web/test/csp-agree.test.ts checks they agree.
 * - No referrer, no MIME sniffing, no powerful features. The microphone stays
 *   off and there is no `media-src` (v0.3 has no in-app audio: the user
 *   dictates with the phone's keyboard, decision U6).
 */

export function contentSecurityPolicy(host: string | undefined): string {
  const ws = host && /^[A-Za-z0-9.\-[\]:]+$/.test(host) ? ` ws://${host} wss://${host}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${ws}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export function securityHeaders(host: string | undefined): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(host),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}
