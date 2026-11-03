/**
 * The one display line on the board (56 px): "3 need you" with the numeral
 * in --signal-text and Start (triage: open the first session waiting on
 * you), or "All clear" with "6 working" beside it and no button.
 *
 * Desktop: an outline Start (32 px). Phone: the primary button (44 px on
 * touch), because it is the one thing to do.
 */
import { ArrowRightIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { Button } from '../../kit/Button.js';
import { useLayout } from '../../shell/layout.js';

export function DisplayLine({
  needs,
  working,
  ground,
  phone,
  onStart,
}: {
  needs: number;
  working: number;
  ground: 'surface' | 'bg';
  phone: boolean;
  onStart: () => void;
}) {
  // 0.12: on an iPad's 340 ledger "Start" alone, so "3 need you" keeps its words at the touch type size.
  const touch = useLayout().chrome === 'touch';
  return (
    <div
      className={clsx(
        'flex h-pane flex-none items-center justify-between gap-12 border-b border-line px-16',
        ground === 'surface' ? 'bg-surface' : 'bg-bg',
      )}
    >
      <h1 data-display className="min-w-0 truncate type-display text-ink">
        {needs ? (
          <>
            <span className="text-signal-text">{needs}</span> {needs === 1 ? 'needs' : 'need'} you
          </>
        ) : (
          <>
            All clear
            {working ? <span className="ml-12 type-row font-stretch-normal text-ink-2">{working} working</span> : null}
          </>
        )}
      </h1>
      {needs ? (
        <Button variant={phone ? 'primary' : 'outline'} size={phone ? 'lg' : 'md'} className="flex-none" onClick={onStart}>
          <span className="inline-flex items-center gap-4">
            Start
            {touch ? null : <ArrowRightIcon size={phone ? 16 : 14} weight="bold" aria-hidden="true" />}
          </span>
        </Button>
      ) : null}
    </div>
  );
}
