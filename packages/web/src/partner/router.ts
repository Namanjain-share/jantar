/**
 * v0.12 People: her app's paths (spec 1.3.1, P1): /p (Today), /p/join,
 * /p/link, /p/me (?tab=sharing|activity|devices|notifications|leave),
 * /p/left. Anything else is her NotFound; the owner's screens don't exist
 * in this bundle.
 */
export type PersonRoute =
  | { name: 'today' }
  | { name: 'join' }
  | { name: 'link' }
  | { name: 'me'; tab: MeTab }
  | { name: 'left' }
  | { name: 'notFound' };

export const ME_TABS = ['sharing', 'activity', 'devices', 'notifications', 'leave'] as const;
export type MeTab = (typeof ME_TABS)[number];

export function parsePersonRoute(pathname: string, search: string): PersonRoute {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/p' || path === '/') return { name: 'today' };
  if (path === '/p/join') return { name: 'join' };
  if (path === '/p/link') return { name: 'link' };
  if (path === '/p/left') return { name: 'left' };
  if (path === '/p/me') {
    const tab = new URLSearchParams(search).get('tab');
    return { name: 'me', tab: (ME_TABS as readonly string[]).includes(tab ?? '') ? (tab as MeTab) : 'sharing' };
  }
  return { name: 'notFound' };
}
