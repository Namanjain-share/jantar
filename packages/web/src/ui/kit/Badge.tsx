/**
 * A count badge: ember fill with --on-signal numerals, 16 px tall, the only
 * 999 px radius in the app. For needs-you counts and unseen alerts.
 */
import clsx from 'clsx';

export function Badge({ count, label, className }: { count: number; label?: string; className?: string }) {
  if (!count) return null;
  return (
    <span
      className={clsx(
        'inline-flex h-16 min-w-16 items-center justify-center rounded-badge bg-badge px-4 font-mono text-rail font-wide tabular-nums text-on-signal',
        className,
      )}
      aria-label={label}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
