/**
 * The tab shows whether anything needs you: "(2) Jantar" plus the favicon with
 * the ember cell. Both favicons are static files in public/ (img-src 'self').
 */
import { PRODUCT_NAME } from '../brand.js';

export const FAVICON = '/favicon.svg';
export const FAVICON_NEEDS = '/favicon-needs.svg';

/** "(2) Jantar" while sessions need you, else "Jantar". */
export function documentTitle(needs: number): string {
  return needs > 0 ? `(${needs}) ${PRODUCT_NAME}` : PRODUCT_NAME;
}

/** A page title for one screen: "web-app · Jantar". */
export function screenTitle(subject: string): string {
  return `${subject} · ${PRODUCT_NAME}`;
}

/** Point the SVG favicon at the plain or the needs-you drawing. */
export function setFavicon(needs: boolean, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  const link = doc?.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (!link) return;
  const href = needs ? FAVICON_NEEDS : FAVICON;
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}
