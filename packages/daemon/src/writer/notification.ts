/**
 * The alert for a prompt that was not sent ("Not delivered to <folder>",
 * notify/format.ts owns the words). The writer emits `send.progress` with
 * stage `failed` (or `refused`, for a job refused after it was accepted) the
 * moment it gives up; the notification router turns that into this push.
 * When notifiers are handed to the writer directly (createWriterWith), it
 * sends this itself, with the full body.
 */
import type { SendJob, Session } from '@jantar/protocol';
import type { Notification } from '../contracts.js';
import { sendFailedNotification as sendFailedText } from '../notify/format.js';

export function sendFailedNotification(job: SendJob, session: Session | null | undefined, ts: string): Notification {
  const { baseKind: _baseKind, folder: _folder, ...n } = sendFailedText(job, session, 'full', ts);
  return n;
}
