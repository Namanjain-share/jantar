/**
 * The states every Life and Intel screen shares (v0.4 spec 5.10): loading,
 * empty, a module off, life.db broken, no control scope, offline, an error,
 * and a write that failed. The sentences come from the daemon where it has
 * one; a command in one is shown in mono. Ember only for "Not saved".
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { errorText, isApiError } from '../../../../lib/api.js';
import { Button } from '../../../kit/Button.js';
import { SkeletonRows } from '../../../kit/Skeleton.js';

export const OFFLINE = "Can't reach the Mac. The last list stays here until it's back.";
export const OFFLINE_WRITE = 'Offline: changes need your Mac';
export const NO_CONTROL = 'This device can read sessions only. Life needs control access: pair it again from your Mac.';
export const LOAD_FAILED = "Couldn't load. Try again.";

/** The one-sentence empty states, by list. */
export const EMPTY = {
  todos: 'No todos yet.',
  reminders: 'No reminders yet. A todo with a time is a reminder.',
  projects: 'No projects yet.',
  medicines: 'No medicines yet.',
  food: 'Nothing logged today.',
  places: 'No cafés yet.',
  money: 'No entries this month.',
  intel: 'Nothing on the shelf yet.',
} as const;

/** "Medicines are off. Turn them on at your Mac: jantar life on medicines", with the command in mono. */
export function CommandSentence({ sentence, className }: { sentence: string; className?: string }) {
  const at = sentence.lastIndexOf(': jantar ');
  if (at < 0) return <p className={clsx('type-small text-ink-2', className)}>{sentence}</p>;
  return (
    <p className={clsx('type-small text-ink-2', className)}>
      {sentence.slice(0, at + 1)} <code className="type-mono text-ink">{sentence.slice(at + 2)}</code>
    </p>
  );
}

/** First load with nothing cached: the skeleton, with a caption after 150 ms. */
export function LifeLoading({ caption = 'Asking the Mac…', count = 4 }: { caption?: string; count?: number }) {
  return <SkeletonRows count={count} caption={caption} />;
}

/** An empty list: one --ink-2 sentence and the add button. */
export function LifeEmpty({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('px-16 py-16 md:px-24', className)}>
      <p className="type-small text-ink-2">{children}</p>
      {action ? <div className="mt-12">{action}</div> : null}
    </div>
  );
}

/** What a failed load shows, by the error: offline, no control scope, a switch off or Life broken (the daemon's sentence), else a retry. */
export function LifeError({ error, offline = false, onRetry }: { error: unknown; offline?: boolean; onRetry?: () => void }) {
  let body: ReactNode;
  let retry = onRetry;
  if (offline || isApiError(error, 'network')) {
    body = <p className="type-small text-ink-2">{OFFLINE}</p>;
  } else if (isApiError(error, 'forbidden') && /\bscope\b/.test(error.message)) {
    body = <p className="type-small text-ink-2">{NO_CONTROL}</p>;
    retry = undefined;
  } else if (isApiError(error, 'forbidden') || isApiError(error, 'life_unavailable')) {
    // A module or the shelf switched off, or life.db broken: the sentence names the Mac command.
    body = <CommandSentence sentence={error.message} />;
    retry = undefined;
  } else {
    body = <p className="type-small text-ink-2">{isApiError(error) && error.message ? errorText(error) : LOAD_FAILED}</p>;
  }
  return (
    <div role="status" className="px-16 py-16 md:px-24">
      {body}
      {retry ? (
        <Button size="sm" className="mt-12" onClick={retry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Under a sheet whose save failed: the sheet stays open with its values. */
export function NotSaved({ error }: { error: unknown }) {
  return (
    <p role="alert" className="mt-8 type-small text-signal-text">
      Not saved. {errorText(error)}
    </p>
  );
}
