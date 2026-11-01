/**
 * v0.8: the six post sites Read saved links asks Chrome for (spec 13.3):
 * the manifest's own optional origins on CHROME_POST_HOSTS, read from the
 * manifest at run time, so no platform URL is spelled out in any bundle
 * (the bundle test, MP8). The test build has them granted at install, in
 * host_permissions.
 */
import { CHROME_POST_HOSTS } from '@jantar/protocol/post-url';

export function postOrigins(): string[] {
  const m = chrome.runtime.getManifest() as { optional_host_permissions?: string[]; host_permissions?: string[] };
  const hosts = new Set<string>(Object.values(CHROME_POST_HOSTS));
  return [...(m.optional_host_permissions ?? []), ...(m.host_permissions ?? [])].filter((o) => {
    try {
      const u = new URL(o.replace(/\*$/, ''));
      return u.protocol === 'https:' && u.pathname === '/' && hosts.has(u.hostname);
    } catch {
      return false;
    }
  });
}
