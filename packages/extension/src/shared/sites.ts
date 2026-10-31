/**
 * The meeting sites the extension runs on: Google Meet and Microsoft Teams
 * on the web (the work and school host, its older one, and the personal
 * one). The content script runs on these hosts only (manifest.json, pinned
 * by test/manifest.test.ts); the worker accepts page messages only from
 * them.
 */

export type MeetingSite = 'meet' | 'teams';

/** Every host a meeting page can be on. */
export const MEETING_HOSTS = ['meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'] as const;
export type MeetingHost = (typeof MEETING_HOSTS)[number];

/**
 * The content script's match patterns, one per host. Written out rather than
 * mapped from MEETING_HOSTS: a template run at load stays in every bundle
 * that imports this module and leaves a bare "https://" there, which the
 * bundle check (MP8) refuses. test/manifest.test.ts pins the two equal.
 */
export const CONTENT_MATCHES: readonly string[] = ['https://meet.google.com/*', 'https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://teams.cloud.microsoft/*'];

/** Which site a page's hostname is, or null for any other host. */
export function siteOf(hostname: string): MeetingSite | null {
  const h = hostname.toLowerCase();
  if (h === 'meet.google.com') return 'meet';
  if (h === 'teams.microsoft.com' || h === 'teams.live.com' || h === 'teams.cloud.microsoft') return 'teams';
  return null;
}
