/**
 * After answering (direction.md 5.2): the dock gives way to a receipt line,
 * `Answered "middleware/cookies.ts" · 14:02 · waiting for Claude`, then
 * `Claude picked it up`. No toast. If anything else needs you, the next one
 * is one press away ("Next: infra · Plan", key n); otherwise "Nothing else
 * needs you" and the way back to the board.
 */
import { ArrowRightIcon, CheckIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import type { Session } from '@jantar/protocol';
import { clock } from '../../../lib/format.js';
import { Button } from '../../kit/Button.js';
import { Keycap } from '../../kit/Keycap.js';
import { Spinner } from '../../kit/Spinner.js';
import type { Receipt } from './decide.js';
import { usePaneKeys } from './keys.js';

export type ReceiptPhase = 'waiting' | 'picked';

export function AnswerReceipt({
  receipt,
  phase,
  phone,
  now,
  next,
  nextWord,
  left,
  working,
  onNext,
  onBoard,
  composerBelow = false,
}: {
  receipt: Receipt;
  phase: ReceiptPhase;
  phone: boolean;
  now: number;
  next: Session | null;
  nextWord: string;
  left: number;
  working: number;
  onNext: () => void;
  onBoard: () => void;
  /** Phone: the composer follows, so it owns the bottom safe area. */
  composerBelow?: boolean;
}) {
  usePaneKeys({ n: onNext }, !phone && Boolean(next));
  const meta = [clock(new Date(receipt.at).toISOString(), now), phase === 'waiting' ? 'waiting for Claude' : receipt.stop ? 'Claude stopped' : 'Claude picked it up'];
  return (
    <section
      role="status"
      aria-label="Answer sent"
      className={clsx(
        'animate-fade bg-raised',
        phone ? clsx('relative z-3 flex-none rounded-t-dock border-t border-line px-16', composerBelow ? 'pb-16' : 'pb-safe-16') : 'rounded-dock border border-line px-20 py-16',
      )}
    >
      {phone ? (
        <div className="flex h-20 items-center justify-center" aria-hidden="true">
          <span className="h-4 w-36 rounded-chip bg-ink-4" />
        </div>
      ) : null}
      <div className={clsx('flex min-h-24 items-center gap-8', phone && 'pt-4')}>
        <span className="flex size-16 flex-none items-center justify-center text-ink-2">
          {phase === 'waiting' ? <Spinner label="Waiting for Claude" delayMs={0} /> : <CheckIcon size={16} weight="bold" aria-hidden="true" />}
        </span>
        <p className="min-w-0 type-row font-medium text-ink">{receipt.text}</p>
      </div>
      <p className="ml-24 mt-2 type-mono text-ink-3">{meta.join(' · ')}</p>

      {next ? (
        <div className={clsx('mt-16 border-t border-line pt-16', phone ? 'flex flex-col gap-8' : 'flex items-center gap-12')}>
          <Button variant="primary" size={phone ? 'xl' : 'lg'} onClick={onNext}>
            Next: {next.folder} · {nextWord}
            <ArrowRightIcon size={16} weight="bold" aria-hidden="true" />
          </Button>
          <span className={clsx('inline-flex items-center gap-6 type-mono text-ink-3', phone ? 'justify-center' : 'ml-auto')}>
            {left} left
            {!phone ? (
              <>
                <span aria-hidden="true">·</span>
                <Keycap size="sm">n</Keycap>
              </>
            ) : null}
          </span>
        </div>
      ) : phone ? (
        <div className="mt-16 border-t border-line pt-20">
          <h2 data-display className="type-display text-ink">
            All clear
          </h2>
          <p className="mt-6 type-body text-ink-2">
            Nothing else needs you.{working ? ` ${working} ${working === 1 ? 'session is' : 'sessions are'} working.` : ''}
          </p>
          <Button variant="primary" size="xl" className="mt-16 w-full" onClick={onBoard}>
            Back to the board
          </Button>
        </div>
      ) : (
        <div className="mt-16 flex items-center gap-16 border-t border-line pt-16">
          <p className="type-body text-ink-2">Nothing else needs you.</p>
          <Button size="lg" className="ml-auto" onClick={onBoard}>
            Back to the board
          </Button>
        </div>
      )}
    </section>
  );
}
