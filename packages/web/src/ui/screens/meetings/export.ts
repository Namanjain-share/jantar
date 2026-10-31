/**
 * Export text (v0.5 spec 5.5): the meeting as Markdown, written by the same
 * `meetingMarkdown` the CLI uses, in the phone's own zone and with each
 * screenshot as its time only (the images stay on the Mac, where the CLI's
 * export writes them too). The file goes to the phone's share sheet
 * when it can take a file, else it downloads from an object URL revoked
 * a moment after the click. Nothing is kept.
 */
import { meetingMarkdown, type MeetingDetail } from '@jantar/protocol';
import { localDay } from './model.js';

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

/** What the browser offers: the share sheet, and a way to save a file. Tests pass their own. */
export interface ExportEnv {
  canShare?: ((data: ShareData) => boolean) | undefined;
  share?: ((data: ShareData) => Promise<void>) | undefined;
  /** Saves `file` through a link to it. */
  download: (file: File) => void;
}

const REVOKE_AFTER_MS = 1_000;

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    // A moment after the click: Safari can drop a download whose URL went away at once.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}

export function browserExportEnv(): ExportEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    canShare: typeof nav?.canShare === 'function' ? (data) => nav.canShare(data) : undefined,
    share: typeof nav?.share === 'function' ? (data) => nav.share(data) : undefined,
    download: downloadFile,
  };
}

/**
 * Hands the meeting's Markdown to the share sheet, or downloads it.
 * 'cancelled' when the person closed the share sheet; a share the browser
 * refuses for any other reason falls back to the download.
 */
export async function exportText(d: MeetingDetail, env: ExportEnv = browserExportEnv()): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([exportMarkdown(d)], exportFileName(d), { type: 'text/markdown' });
  const data: ShareData = { files: [file] };
  if (env.share && env.canShare?.(data)) {
    try {
      await env.share(data);
      return 'shared';
    } catch (e) {
      if ((e as { name?: unknown } | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  env.download(file);
  return 'downloaded';
}
