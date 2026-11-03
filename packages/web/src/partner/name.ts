/**
 * v0.11 People: her app under the space's name (his label, "Accountability
 * partner" while he set none). The tab's title is the label; the Home
 * Screen title iOS offers (apple-mobile-web-app-title) is its short form, at
 * most 12 characters. Once she is in (`manifest: true`) and he named the
 * space, the manifest link points at her own manifest (/v1/p/manifest, the
 * built one under the label), so a Home Screen install after he named it
 * takes that name; an app already on her Home Screen keeps the name it was
 * added with. The label is only ever text here (a title, an attribute).
 */
import { PEOPLE_LABEL, shortLabel, spaceLabel } from '@jantar/protocol/people-core';

export const PERSON_MANIFEST_URL = '/v1/p/manifest';

export function nameApp(label: string | undefined, opts: { manifest?: boolean } = {}): void {
  if (typeof document === 'undefined') return;
  document.title = spaceLabel(label);
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', shortLabel(label));
  if (opts.manifest && spaceLabel(label) !== PEOPLE_LABEL) {
    const link = document.querySelector('link[rel="manifest"]');
    if (link && link.getAttribute('href') !== PERSON_MANIFEST_URL) link.setAttribute('href', PERSON_MANIFEST_URL);
  }
}
