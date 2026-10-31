/**
 * A startup dialog the launch waits on (decision U8: trust is always a card
 * on the phone, never answered for you), spec 5.3.4:
 *
 *   ■ Needs you · Trust this folder?        ember glyph + --signal-text word
 *   ┌ the last screen lines, masked ┐       --term box, mono
 *   [ Yes, I trust this folder ]            48 px, Claude's own wording
 *   [ No, exit ]                            and order
 *
 * Answering sends the option index with the title the card showed; the
 * daemon refuses it when the dialog on the Mac changed since, and the card
 * reads the launch again. Nothing is ever answered without a tap.
 */
import clsx from 'clsx';
import { useId, useState } from 'react';
import type { LaunchJob } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import { isNoScope } from '../new/data.js';
import { NoScopeNote } from '../new/parts.js';

/** The masked screen tail (failures and dialogs): text nodes in a --term box, never markup. */
export function ScreenTail({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      aria-label="The window on the Mac"
      className={clsx('max-h-160 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-btn bg-term px-12 py-8 type-code text-term-ink', className)}
    >
      {text}
    </pre>
  );
}

export interface DialogCardProps {
  job: LaunchJob;
  screenTail?: string;
  phone: boolean;
  offline: boolean;
  /** The dialog changed on the Mac: read the launch again. */
  onStale: () => void;
}

export function DialogCard({ job, screenTail, phone, offline, onStale }: DialogCardProps) {
  const { api } = useDeps();
  const id = useId();
  const dialog = job.dialog;
  const shown = dialog ? `${dialog.since}|${dialog.title}` : '';
  const [busy, setBusy] = useState<number | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const [error, setError] = useState<{ for: string; e: unknown } | null>(null);
  if (!dialog) return null;
  const done = answered === shown;
  const problem = error?.for === shown ? error.e : null;

  const answer = async (option: number) => {
    setBusy(option);
    setError(null);
    try {
      await api.launchAnswer(job.id, { option, title: dialog.title });
      setAnswered(shown);
    } catch (e) {
      setError({ for: shown, e });
      if (isApiError(e, 'conflict') || isApiError(e, 'refused') || isApiError(e, 'not_found')) onStale();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-labelledby={id}
      data-dialog
      className={clsx('mt-16 rounded-dock border border-line px-16 pb-16 pt-12', phone ? 'bg-bg' : 'bg-raised')}
    >
      <h3 id={id} className="flex min-w-0 items-center gap-4 type-small">
        <StatusGlyph state="needs" className="-ml-4" />
        <span className="flex-none font-medium text-signal-text">Needs you</span>
        <span aria-hidden="true" className="text-ink-3">
          ·
        </span>
        <span className="min-w-0 font-medium text-ink">{dialog.title}</span>
      </h3>
      {screenTail ? <ScreenTail text={screenTail} className="mt-12" /> : null}
      <div className={clsx('mt-12 gap-8', phone ? 'flex flex-col' : 'flex flex-wrap')}>
        {dialog.options.map((o, i) => (
          <Button key={`${i}:${o}`} size="xl" className={phone ? 'w-full' : undefined} disabled={offline || busy !== null || done} onClick={() => void answer(i)}>
            {busy === i ? <Spinner label="Answering" /> : null}
            {o}
          </Button>
        ))}
      </div>
      {done ? (
        <p role="status" className="mt-12 type-mono text-ink-3">
          answered · waiting for Claude
        </p>
      ) : null}
      {offline ? <p className="mt-12 type-mono text-ink-3">Offline: can't answer right now</p> : null}
      {problem ? (
        isNoScope(problem) ? (
          <NoScopeNote className="mt-12" />
        ) : (
          <p role="alert" className="mt-12 type-small text-signal-text">
            {isApiError(problem, 'conflict') || isApiError(problem, 'refused')
              ? 'The question on the Mac changed. Check it again.'
              : errorText(problem)}
          </p>
        )
      ) : null}
    </section>
  );
}
