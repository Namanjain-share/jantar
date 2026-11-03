/**
 * v0.11 People: what her host answers (spec 9.3.2 and M13). It is the
 * whole surface a page or a script on her origin can reach:
 *
 * - `/healthz` (no data) and her routes under PERSON_PREFIX;
 * - her app: `/p` and `/p/<route>` (the app shell, p.html), `/p.html`,
 *   `/p.webmanifest`, `/p-sw.js`, `/icons/*`, and under `/assets/` only the
 *   chunks of the `p` entry, read once from Vite's build manifest (C15);
 * - `GET /` is a 302 to `/p` (C2).
 *
 * Everything else is `refuse` (404, empty body): the owner's routes, his
 * event stream, the public doors, the node link (api/node-upgrade.ts asks
 * here too), his app shell, his service worker and his chunks. Paths are
 * matched as sent, with no decoding: an encoded path is refused, never
 * normalized into something allowed.
 */
import { PERSON_PREFIX } from '@jantar/protocol/people';

export type FenceVerdict = 'ok' | 'redirect' | 'refuse';

/** Her app's client routes: plain segments, no dots, no percent signs. */
const APP_ROUTE = /^\/p(?:\/[A-Za-z0-9_-]+)*\/?$/;
const ICON = /^\/icons\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/;
const OWN_FILES: ReadonlySet<string> = new Set(['/p.html', '/p.webmanifest', '/p-sw.js']);

export function peopleHostAllows(method: string, rawPath: string, matchedRoute: string | undefined, assets: ReadonlySet<string>): FenceVerdict {
  const read = method === 'GET' || method === 'HEAD';
  if (rawPath === '/healthz') return matchedRoute === undefined || matchedRoute === '/healthz' ? 'ok' : 'refuse';
  if (rawPath.startsWith(PERSON_PREFIX)) {
    // Only a route of hers (or no route at all: the unknown-path 404 of her prefix).
    return matchedRoute === undefined || matchedRoute.startsWith(PERSON_PREFIX) ? 'ok' : 'refuse';
  }
  if (!read) return 'refuse';
  if (rawPath === '/') return 'redirect';
  if (OWN_FILES.has(rawPath)) return 'ok';
  if (APP_ROUTE.test(rawPath)) return 'ok';
  if (ICON.test(rawPath)) return 'ok';
  if (rawPath.startsWith('/assets/') && assets.has(rawPath.slice('/assets/'.length))) return 'ok';
  return 'refuse';
}
