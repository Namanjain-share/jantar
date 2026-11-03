/**
 * Export text (v0.5 spec 5.5): the meeting as Markdown, written by the same
 * `meetingMarkdown` the CLI uses, in the phone's own zone and with each
 * screenshot as its time only (the images stay on the Mac, where the CLI's
 * export writes them too). The file goes to the phone's share sheet
 * when it can take a file, else it downloads (lib/share-file.ts, which
 * 0.13.0 Work's CSV export shares). Nothing is kept.
 */
import { meetingMarkdown, type MeetingDetail } from '@jantar/protocol';
import { browserExportEnv, shareFile, type ExportEnv } from '../../../lib/share-file.js';
import { localDay } from './model.js';

export { browserExportEnv, type ExportEnv };

/** The phone's own zone (UTC where the browser will not say). */
export function phoneZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A meeting's name as a file name part: "weekly-sync"; "meeting" when nothing is left. */
export function slug(name: string): string {
  const s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'meeting';
}

/** "2026-10-30-weekly-sync.md": the day it started on, then its name. */
export function exportFileName(d: MeetingDetail): string {
  return `${localDay(d.meeting.startedAt)}-${slug(d.meeting.name)}.md`;
}

/** The Markdown the phone exports: no image links, the phone's zone. */
export function exportMarkdown(d: MeetingDetail, timeZone = phoneZone()): string {
  return meetingMarkdown(d, { timeZone, shotRef: () => null });
}

/**
 * Hands the meeting's Markdown to the share sheet, or downloads it.
 * 'cancelled' when the person closed the share sheet; a share the browser
 * refuses for any other reason falls back to the download.
 */
export function exportText(d: MeetingDetail, env: ExportEnv = browserExportEnv()): Promise<'shared' | 'downloaded' | 'cancelled'> {
  return shareFile(new File([exportMarkdown(d)], exportFileName(d), { type: 'text/markdown' }), env);
}
