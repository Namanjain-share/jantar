/**
 * Small pieces New session shares between the browser, the start form and
 * the receipt: the start form's property row, the "can't start sessions"
 * note and the offline line. Ink only: refusals that teach are not ember
 * (spec 5.0 keeps ember for the dialog card and launch failures).
 */
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { grantCommand, noScopeLead } from './data.js';

/**
 * One row of the start form's property list (spec 5.3.3): the label in
 * type-small --ink-3 at 88 px, the value on the right. With `htmlFor` the
 * label is a real <label>.
 */
export function Prop({
  label,
  labelId,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  labelId?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const cls = 'w-88 flex-none pt-6 type-small text-ink-3 coarse:pt-12';
  return (
    <div className={clsx('flex gap-12 border-b border-line py-12', className)}>
      {htmlFor ? (
        <label id={labelId} htmlFor={htmlFor} className={cls}>
          {label}
        </label>
      ) : (
        <div id={labelId} className={cls}>
          {label}
        </div>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A 403 for the missing `launch` scope. There is no grant button: scopes are
 * granted on the Mac only (the daemon refuses deviceScopes over the network),
 * so the sentence names the command to run there.
 */
export function NoScopeNote({ className }: { className?: string }) {
  return (
    <p role="alert" data-no-scope className={clsx('type-small text-ink-2', className)}>
      {noScopeLead()} On your Mac run <code className="type-mono text-ink">{grantCommand()}</code>.
    </p>
  );
}

/** "Offline: can't start right now", the composer's wording for every write here. */
export function OfflineNote({ what, className }: { what: string; className?: string }) {
  return <p className={clsx('type-mono text-ink-3', className)}>Offline: can't {what} right now</p>;
}
