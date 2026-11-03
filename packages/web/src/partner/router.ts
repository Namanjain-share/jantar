/**
 * v0.12 People: her app's paths (spec 1.3.1): /p (Today; `?review=1&day=`
 * opens the evening review), /p/todos, /p/health (`?tab=sleep&week=`),
 * /p/journal (`?id=`, `?checkin=1`), /p/alerts (`?id=`), /p/chat (P3), /p/join, /p/link,
 * /p/me (?tab=sharing|activity|devices|notifications|leave; Sharing's
 * `&see=<area>` is "See what {owner} sees"), /p/left.
 * Anything else is her NotFound; the owner's screens don't exist in this
 * bundle.
 */
export type PersonRoute =
  | { name: 'today' }
  | { name: 'review'; day: string | null }
  | { name: 'todos' }
  | { name: 'health'; tab: HealthTab; week: string | null }
  | { name: 'journal'; id: string | null; checkin: boolean }
  | { name: 'alerts'; id: string | null }
  | { name: 'chat' }
  | { name: 'lists'; tab: 'cafes' | 'lists'; id: string | null; list: string | null }
  | { name: 'join' }
  | { name: 'link' }
  | { name: 'me'; tab: MeTab; see?: MirrorArea }
  | { name: 'left' }
  | { name: 'notFound' };

export const ME_TABS = ['sharing', 'activity', 'devices', 'notifications', 'leave'] as const;
export type MeTab = (typeof ME_TABS)[number];
/** The areas "See what {owner} sees" opens (`/p/me?tab=sharing&see=`). */
export const MIRROR_AREAS = ['today', 'todos', 'meds', 'weight', 'plan', 'review', 'sleep', 'journal', 'chat'] as const;
export type MirrorArea = (typeof MIRROR_AREAS)[number];
export const HEALTH_TABS = ['meds', 'weight', 'sleep'] as const;
export type HealthTab = (typeof HEALTH_TABS)[number];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function parsePersonRoute(pathname: string, search: string): PersonRoute {
  const path = pathname.replace(/\/+$/, '') || '/';
  const q = new URLSearchParams(search);
  const day = (k: string) => {
    const v = q.get(k);
    return v && DAY_RE.test(v) ? v : null;
  };
  const id = () => {
    const v = q.get('id');
    return v && ID_RE.test(v) ? v : null;
  };
  if (path === '/p' || path === '/') return q.get('review') === '1' ? { name: 'review', day: day('day') } : { name: 'today' };
  if (path === '/p/todos') return { name: 'todos' };
  if (path === '/p/health') {
    const tab = q.get('tab');
    return { name: 'health', tab: (HEALTH_TABS as readonly string[]).includes(tab ?? '') ? (tab as HealthTab) : 'meds', week: day('week') };
  }
  if (path === '/p/journal') return { name: 'journal', id: id(), checkin: q.get('checkin') === '1' };
  if (path === '/p/alerts') return { name: 'alerts', id: id() };
  if (path === '/p/chat') return { name: 'chat' };
  if (path === '/p/lists') {
    const list = q.get('list');
    return { name: 'lists', tab: q.get('tab') === 'lists' || (list && ID_RE.test(list)) ? 'lists' : 'cafes', id: id(), list: list && ID_RE.test(list) ? list : null };
  }
  if (path === '/p/join') return { name: 'join' };
  if (path === '/p/link') return { name: 'link' };
  if (path === '/p/left') return { name: 'left' };
  if (path === '/p/me') {
    const tab = q.get('tab');
    const see = q.get('see');
    const t = (ME_TABS as readonly string[]).includes(tab ?? '') ? (tab as MeTab) : 'sharing';
    return t === 'sharing' && (MIRROR_AREAS as readonly string[]).includes(see ?? '') ? { name: 'me', tab: t, see: see as MirrorArea } : { name: 'me', tab: t };
  }
  return { name: 'notFound' };
}
