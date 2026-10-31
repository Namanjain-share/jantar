/**
 * The states every Files view shares (v0.3 spec 5.2.5): loading, off,
 * offline, refused, gone, and the errors in between. Ink only: a file the
 * Mac will not show is a fact, not an alarm, so nothing here is ember.
 */
import { LockIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { errorText, isApiError } from '../../../lib/api.js';
import { Button } from '../../kit/Button.js';
import { SkeletonRows } from '../../kit/Skeleton.js';

export const FILES_OFF = 'Files are off. Turn them on at your Mac:';
export const FILES_OFF_COMMAND = 'jantar files on';
export const GONE = 'That file is no longer there.';
export const GONE_DIR = 'That folder is no longer there.';
export const PROTECTED = 'This file is protected. Keys and secrets never leave the Mac.';
export const OFFLINE = "Can't reach the Mac. Files show again when it's back.";
export const NOT_BUILT = "This Mac's Jantar can't show files yet. Update Jantar on the Mac.";

/** What went wrong, as one sentence ("what" picks the gone sentence). */
export function fileErrorText(e: unknown, what: 'file' | 'folder' | 'list' = 'file'): string {
  // The daemon's file refusals are sentences written for the phone ("That file is no
  // longer there.", "That folder is not shared with this device ..."); they win.
  if (isApiError(e, 'not_found')) return e.message || (what === 'file' ? GONE : GONE_DIR);
  if (isApiError(e, 'not_implemented')) return NOT_BUILT;
  if (isApiError(e, 'payload_too_large')) return e.message || 'This file is too large to show here.';
  if (isApiError(e, 'unsupported_media_type')) return e.message || 'Jantar shows this file as text, or not at all.';
  // Refusals (protected, outside, the switch, macOS privacy) carry the daemon's own sentence:
  // FileRefusal.message is written for the phone and never quotes file content.
  if (isApiError(e, 'forbidden')) return e.message || PROTECTED;
  return errorText(e);
}

/** Whether the daemon refused the path (protected or outside a root). */
export function isRefusal(e: unknown): boolean {
  return isApiError(e, 'forbidden');
}

/** Files switched off on the Mac. */
export function FilesOff({ className }: { className?: string }) {
  return (
    <p className={clsx('type-small text-ink-2', className)}>
      {FILES_OFF} <code className="type-mono text-ink">{FILES_OFF_COMMAND}</code>
    </p>
  );
}

/** One sentence where content would be, with an optional way to try again. */
export function StateLine({
  children,
  title,
  locked = false,
  onRetry,
  alert = false,
  className,
}: {
  children: ReactNode;
  title?: string;
  /** A protected or refused path: a lock before the sentence. */
  locked?: boolean;
  onRetry?: () => void;
  alert?: boolean;
  className?: string;
}) {
  return (
    <div role={alert ? 'alert' : undefined} className={clsx('px-16 py-16 md:px-24', className)}>
      {title ? <p className="type-title text-ink">{title}</p> : null}
      <p className={clsx('flex items-start gap-8 type-small text-ink-2', title && 'mt-4')}>
        {locked ? <LockIcon size={16} aria-label="Protected" className="mt-2 flex-none text-ink-3" /> : null}
        <span>{children}</span>
      </p>
      {onRetry ? (
        <Button size="sm" className="mt-12" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** A load that failed with nothing to show: offline, refused, gone or another error. */
export function LoadError({ error, offline, what = 'file', onRetry }: { error: unknown; offline: boolean; what?: 'file' | 'folder' | 'list'; onRetry?: () => void }) {
  if (offline || isApiError(error, 'network')) return <StateLine onRetry={onRetry}>{OFFLINE}</StateLine>;
  const refused = isRefusal(error);
  // Gone, too large, or a kind Jantar does not show: a fact about the file, which trying again cannot change.
  const final = isApiError(error, 'not_found') || isApiError(error, 'payload_too_large') || isApiError(error, 'unsupported_media_type');
  return (
    <StateLine alert={!refused && !final} locked={refused} onRetry={refused || final ? undefined : onRetry}>
      {fileErrorText(error, what)}
    </StateLine>
  );
}

/** First load with nothing cached. */
export function Loading({ caption = 'Asking the Mac…', count = 4 }: { caption?: string; count?: number }) {
  return <SkeletonRows count={count} caption={caption} />;
}

/** A quiet line under a list ("hidden: 3 protected"); `mono` for data such as sizes. */
export function Footnote({ children, mono = false, className }: { children: ReactNode; mono?: boolean; className?: string }) {
  return <p className={clsx('px-16 py-12 text-ink-3', mono ? 'type-mono' : 'type-small', className)}>{children}</p>;
}

/** One-line banner above a file (bidi, secret-like, truncated): --surface, --ink-2. */
export function Banner({ children }: { children: ReactNode }) {
  return <p className="flex-none border-b border-line bg-surface px-16 py-8 type-small text-ink-2">{children}</p>;
}
