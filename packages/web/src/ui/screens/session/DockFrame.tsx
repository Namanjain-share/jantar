/**
 * The decision dock's frame (direction.md 5.2): --raised, 1 px --line, pinned
 * to the bottom of the pane. Header: ember glyph, the kind word and its age
 * ("waiting 12m", ember from 10 minutes, the first reminder point).
 *
 * Desktop: a 10 px-radius card at the bottom of the transcript column.
 * Phone: a bottom sheet with a grabber. Tapping or dragging the grabber down
 * folds it to a 56 px peek ("■ Question · waiting 4m · Which module…") so the
 * transcript stays readable; it cannot be dismissed while the card is open.
 * A title too long for the row (a workflow agent's "Claude asks · Bash
 * command · from the "…" workflow") is cut with an ellipsis, so the age and
 * the peek stay in view.
 */
import clsx from 'clsx';
import { useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { GlyphState } from '../../kit/glyph.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';

export interface DockFrameProps {
  phone: boolean;
  /** Kind word: "Question", "Permission · Bash", "Plan". */
  title: string;
  glyph?: GlyphState;
  /** "waiting 12m" */
  age?: string;
  /** Ember age (at or past the first reminder). */
  late?: boolean;
  /** Right of the age: "2 cards". */
  aside?: ReactNode;
  /** Right edge of the header (desktop key hints). */
  hints?: ReactNode;
  /** One line for the phone peek. */
  peek?: string;
  /** The phone sheet can fold to a peek. */
  foldable?: boolean;
  /** Phone: something follows the sheet (the composer), which then owns the bottom safe area. */
  followed?: boolean;
  children: ReactNode;
  className?: string;
}

const LATE_MS = 10 * 60_000;
export const isLate = (sinceIso: string, now: number) => now - Date.parse(sinceIso) >= LATE_MS;

/** The 20 px header row shared by the dock and its phone peek. */
function Head({ id, title, glyph, age, late, aside, hints }: Pick<DockFrameProps, 'title' | 'glyph' | 'age' | 'late' | 'aside' | 'hints'> & { id: string }) {
  return (
    <div className="flex h-20 min-w-0 items-center">
      <StatusGlyph state={glyph ?? 'needs'} className="-ml-4 mr-4" />
      <h2 id={id} className="min-w-0 truncate type-small font-medium text-ink">
        {title}
      </h2>
      {age ? <span className={clsx('ml-8 flex-none type-mono', late ? 'text-signal-text' : 'text-ink-3')}>{age}</span> : null}
      {aside ? <span className="ml-8 flex-none">{aside}</span> : null}
      {hints ? <span className="ml-auto hidden flex-none md:inline-flex">{hints}</span> : null}
    </div>
  );
}

export function DockFrame({ phone, title, glyph, age, late, aside, hints, peek, foldable = true, followed = false, children, className }: DockFrameProps) {
  const id = useId();
  const [folded, setFolded] = useState(false);
  const [dy, setDy] = useState(0);
  const start = useRef<number | null>(null);
  const moved = useRef(false);

  if (!phone) {
    return (
      <article aria-labelledby={id} className={clsx('animate-rise rounded-dock border border-line bg-raised px-20 pb-16 pt-16', className)}>
        <Head id={id} title={title} glyph={glyph} age={age} late={late} aside={aside} hints={hints} />
        {children}
      </article>
    );
  }

  const grab = {
    onPointerDown(e: PointerEvent<HTMLButtonElement>) {
      start.current = e.clientY;
      moved.current = false;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove(e: PointerEvent<HTMLButtonElement>) {
      if (start.current === null) return;
      const d = e.clientY - start.current;
      if (Math.abs(d) > 6) moved.current = true;
      setDy(folded ? Math.min(0, Math.max(-48, d / 3)) : Math.max(0, d));
    },
    onPointerUp(e: PointerEvent<HTMLButtonElement>) {
      if (start.current === null) return;
      const d = e.clientY - start.current;
      start.current = null;
      setDy(0);
      if (!moved.current) return;
      if (!folded && d > 48) setFolded(true);
      else if (folded && d < -16) setFolded(false);
    },
    onPointerCancel() {
      start.current = null;
      setDy(0);
    },
  };
  const style: CSSProperties | undefined = dy ? { transform: `translateY(${dy}px)` } : undefined;

  return (
    <article
      aria-labelledby={id}
      className={clsx(
        'relative z-3 flex-none animate-rise rounded-t-dock border-t border-line bg-raised px-16',
        followed ? 'pb-16' : 'pb-safe-16',
        start.current === null && 'transition-transform duration-300 ease-sheet motion-reduce:transition-none',
        className,
      )}
      style={style}
    >
      {foldable ? (
        <button
          type="button"
          className="relative flex h-20 w-full touch-none items-center justify-center coarse:h-28 coarse:before:absolute coarse:before:inset-x-0 coarse:before:-inset-y-8"
          aria-label={folded ? 'Open the panel' : 'Fold the panel'}
          aria-expanded={!folded}
          onClick={() => {
            if (moved.current) {
              moved.current = false;
              return;
            }
            setFolded(!folded);
          }}
          {...grab}
        >
          <span className="h-4 w-36 rounded-chip bg-ink-4" />
        </button>
      ) : (
        <div className="flex h-20 items-center justify-center" aria-hidden="true">
          <span className="h-4 w-36 rounded-chip bg-ink-4" />
        </div>
      )}
      {folded ? (
        <button
          type="button"
          className="relative flex h-24 w-full min-w-0 items-center text-left coarse:before:absolute coarse:before:inset-x-0 coarse:before:-inset-y-10"
          onClick={() => setFolded(false)}
        >
          <StatusGlyph state={glyph ?? 'needs'} className="-ml-4 mr-4" />
          <span id={id} className="min-w-0 truncate type-small font-medium text-ink">
            {title}
          </span>
          {age ? <span className={clsx('ml-8 flex-none type-mono', late ? 'text-signal-text' : 'text-ink-3')}>{age}</span> : null}
          {peek ? <span className="ml-8 min-w-0 truncate type-small text-ink-2">{peek}</span> : null}
        </button>
      ) : (
        <>
          <div className="pt-4">
            <Head id={id} title={title} glyph={glyph} age={age} late={late} aside={aside} />
          </div>
          {children}
        </>
      )}
    </article>
  );
}
