/**
 * First load with no cache: static rows that mirror the ledger anatomy (an
 * --ink-4 outline glyph and two --line bars at 40% and 70%). No shimmer.
 * After 150 ms a mono line says what is happening.
 */
import { useDelayedFlag } from './delay.js';
import { StatusGlyph } from './StatusGlyph.js';

export function SkeletonRow() {
  return (
    <div className="border-b border-line px-16 py-10 md:py-8" aria-hidden="true">
      <div className="flex h-20 items-center gap-8 md:h-18">
        <StatusGlyph state="ended" />
        <span className="h-8 w-2/5 bg-line" />
      </div>
      <div className="mt-4 flex h-20 items-center pl-24 md:mt-0 md:h-18">
        <span className="h-8 w-7/10 bg-line" />
      </div>
    </div>
  );
}

export function SkeletonRows({ count = 6, caption = 'Connecting to the Mac…' }: { count?: number; caption?: string }) {
  const showCaption = useDelayedFlag(true, 150, 0);
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
      {showCaption ? (
        <p role="status" className="px-16 py-12 type-mono text-ink-3">
          {caption}
        </p>
      ) : null}
    </div>
  );
}
