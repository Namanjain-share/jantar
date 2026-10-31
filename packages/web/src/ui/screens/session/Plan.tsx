/**
 * Plan dock (direction.md 5.2): the plan's Markdown in a scroll area (half
 * the screen at most on a phone) that fades at the bottom edge with a mask
 * while there is more below. Then Claude's own choices, in its words and
 * order (v0.4.2, screenshot 43), one row per mode the card offers
 * (`planModes`):
 *
 *   Yes, and use auto mode        only where the daemon offers it (off until
 *                                 spike SP8); hold 2 s (it switches to a mode
 *                                 where Claude doesn't ask before acting)
 *   Yes, auto-accept edits        otherwise
 *   Yes, manually approve edits
 *   Tell Claude what to change…   opens a note; the note is required
 *
 * The first row is the primary one, as Claude highlights it. A request that
 * carries no plan text says where to read it first: the Mac, which shows the
 * whole plan (with Show on Mac), not the Transcript.
 */
import clsx from 'clsx';
import { m } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { DIALOG_HOLD_COPY, type PendingRequest } from '@jantar/protocol';
import { planOf } from '../../../lib/describe.js';
import { previewText } from '../../../lib/format.js';
import { Button } from '../../kit/Button.js';
import { HoldButton } from '../../kit/HoldButton.js';
import { KeyHints } from '../../kit/Keycap.js';
import { useDecide } from './decide.js';
import { DockFrame } from './DockFrame.js';
import { Actions, InlineError, OfflineLine } from './Fields.js';
import { usePaneKeys } from './keys.js';
import type { CardProps } from './Permission.js';
import { Prose } from './Prose.js';

const SPRING = { type: 'spring', duration: 0.35, bounce: 0.12 } as const;

type PlanMode = NonNullable<PendingRequest['planModes']>[number];
/** A card from before v0.4.2 names no modes: the two it always offered. */
const DEFAULT_MODES: readonly PlanMode[] = ['acceptEdits', 'default'];

const ROW: Record<PlanMode, { label: string; receipt: string }> = {
  auto: { label: 'Yes, and use auto mode', receipt: 'Approved, auto mode' },
  acceptEdits: { label: 'Yes, auto-accept edits', receipt: 'Approved, auto-accept edits' },
  default: { label: 'Yes, manually approve edits', receipt: 'Approved, ask before each edit' },
};

export function PlanCard({ p, phone, offline, age, late, aside, onDecided, onShowOnMac }: CardProps) {
  const { busy, error, decide } = useDecide(p, onDecided);
  const [revise, setRevise] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [more, setMore] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const plan = planOf(p);
  const modes = p.planModes?.length ? p.planModes : DEFAULT_MODES;
  const disabled = busy || p.state !== 'open' || offline;
  const fbId = useId();
  const size = phone ? 'xl' : 'lg';

  const measure = () => {
    const el = scroller.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  };
  useEffect(measure, [plan]);

  // Auto mode needs the hold, which is its confirm (the daemon refuses it without one).
  const approve = (mode: PlanMode) => void decide({ behavior: 'allow', mode, ...(mode === 'auto' ? { confirm: true } : {}) }, ROW[mode].receipt);
  const keepPlanning = () => void decide({ behavior: 'deny', message: feedback.trim() }, 'Sent feedback: keep planning');
  // The a key never switches to auto mode: it takes the first row that needs no hold.
  const keyMode = modes.find((m) => m !== 'auto');

  usePaneKeys({ a: () => !disabled && keyMode !== undefined && approve(keyMode) }, !phone && !disabled && keyMode !== undefined);

  return (
    <DockFrame
      phone={phone}
      title="Plan"
      age={age}
      late={late}
      aside={aside}
      peek={previewText(plan, 120) || 'Claude is ready to leave plan mode.'}
      hints={<KeyHints hints={[{ keys: ['a'], label: 'approve' }]} />}
    >
      {plan ? (
        <div
          ref={scroller}
          onScroll={measure}
          tabIndex={0}
          aria-label="Plan text"
          className={clsx('no-scrollbar mt-8 overflow-y-auto focus-visible:-outline-offset-2', !phone && 'max-h-280', more && 'mask-b-from-80%')}
          style={phone ? { maxHeight: '50vh' } : undefined}
        >
          <Prose text={plan} variant="plan" foldAt={12_000} />
        </div>
      ) : (
        <>
          <p className="mt-8 type-body text-pretty text-ink-2">
            Claude is ready to leave plan mode, but this request doesn't carry the plan. Read it at the Mac before you approve.
          </p>
          {onShowOnMac ? (
            <Button variant="text" size={size} className="-ml-8 mt-4" onClick={onShowOnMac}>
              Show on Mac
            </Button>
          ) : null}
        </>
      )}

      <Actions phone={phone} layout="stack">
        {modes.map((mode, i) =>
          mode === 'auto' ? (
            <HoldButton key={mode} variant={i === 0 ? 'primary' : 'outline'} size={size} disabled={disabled} onCommit={() => approve(mode)}>
              {ROW[mode].label}
            </HoldButton>
          ) : (
            <Button key={mode} variant={i === 0 ? 'primary' : 'outline'} size={size} disabled={disabled} onClick={() => approve(mode)}>
              {ROW[mode].label}
            </Button>
          ),
        )}
        <Button
          variant="text"
          size={size}
          disabled={disabled}
          aria-expanded={revise}
          onClick={() => {
            setRevise(!revise);
            if (!revise) requestAnimationFrame(() => noteRef.current?.focus());
          }}
        >
          Tell Claude what to change…
        </Button>
      </Actions>
      {modes.includes('auto') ? <p className="mt-10 type-small text-pretty text-ink-3">Hold “{ROW.auto.label}” for 2 seconds. {DIALOG_HOLD_COPY.mode}</p> : null}
      {revise ? (
        <m.div className="mt-12 flex items-end gap-8" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
          <label htmlFor={fbId} className="sr-only">
            What should change in the plan?
          </label>
          <textarea
            id={fbId}
            ref={noteRef}
            rows={2}
            value={feedback}
            maxLength={4000}
            placeholder="What should change in the plan?"
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && feedback.trim() && !disabled) keepPlanning();
            }}
            className="min-w-0 flex-1 resize-none rounded-btn border border-line-strong bg-surface px-10 py-8 type-input text-ink focus-visible:outline-offset-0"
          />
          <Button size={size} disabled={disabled || !feedback.trim()} onClick={keepPlanning}>
            Send feedback
          </Button>
        </m.div>
      ) : null}
      <InlineError error={error} />
      <OfflineLine offline={offline} />
    </DockFrame>
  );
}
