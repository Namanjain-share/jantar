/**
 * One alert on the timeline (direction.md 5.4, dir-k.html .al-r / .p-al).
 *
 *   desktop  44 px: time · glyph · subject · what happened · action
 *   phone    two lines: glyph, subject and time; then what happened
 *
 * Unseen alerts get an ember glyph and a 680 subject; seen ones an outline
 * glyph and quieter text. No pills, no stripes, no "Details": a row with a
 * longer text expands inline to show it in mono on --term (on a phone the
 * action lives in the expanded part too).
 */
import type { Alert } from '@jantar/protocol';
import clsx from 'clsx';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import { Link } from '../../shell/Link.js';
import { hhmm } from '../accounts/time.js';
import type { AlertAction } from './model.js';

export interface AlertRowProps {
  alert: Alert;
  subject: string;
  sentence: string;
  action: AlertAction | null;
  unseen: boolean;
  open: boolean;
  onToggle: () => void;
}

const timeOf = (a: Alert) => {
  const t = Date.parse(a.ts);
  return Number.isFinite(t) ? hhmm(t) : '';
};

function Full({ text, className }: { text: string; className?: string }) {
  return <pre className={clsx('overflow-x-auto whitespace-pre-wrap break-words rounded-btn bg-term px-12 py-8 type-code text-term-ink', className)}>{text}</pre>;
}

function ActionLink({ action, className }: { action: AlertAction; className?: string }) {
  return (
    <Link
      href={action.href}
      onClick={(e) => e.stopPropagation()}
      className={clsx(
        'inline-flex items-center rounded-chip type-small font-medium text-ink-2 underline-offset-3 transition-colors duration-120 ease-hover hover:text-ink hover:underline',
        className,
      )}
    >
      {action.label}
    </Link>
  );
}

export function AlertRowDesk({ alert: a, subject, sentence, action, unseen, open, onToggle }: AlertRowProps) {
  const full = a.full?.trim();
  const body = (
    <>
      <span className={clsx('w-280 flex-none truncate pr-16 type-row', unseen ? 'font-strong text-ink' : 'text-ink-2')}>{subject}</span>
      <span className={clsx('min-w-0 flex-1 truncate pr-24 type-row', unseen ? 'text-ink-2' : 'text-ink-3')}>{sentence}</span>
    </>
  );
  return (
    <li className="border-b border-line" data-alert={a.id} data-unseen={unseen ? 'true' : undefined}>
      <div
        className={clsx('flex h-44 items-center', full && 'cursor-pointer transition-colors duration-120 ease-hover hover:bg-hover')}
        onClick={full ? onToggle : undefined}
      >
        <span className="w-64 flex-none type-mono text-ink-3">{timeOf(a)}</span>
        <span className="w-24 flex-none">
          <StatusGlyph state={unseen ? 'needs' : 'turn'} label={unseen ? 'New' : undefined} />
        </span>
        {full ? (
          <button
            type="button"
            aria-expanded={open}
            className="flex h-full min-w-0 flex-1 items-center text-left"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {body}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center">{body}</span>
        )}
        <span className="flex w-140 flex-none items-center">{action ? <ActionLink action={action} className="h-28" /> : null}</span>
      </div>
      {open && full ? <Full text={full} className="mb-12 ml-88 mr-140 animate-pop" /> : null}
    </li>
  );
}

export function AlertRowPhone({ alert: a, subject, sentence, action, unseen, open, onToggle }: AlertRowProps) {
  const full = a.full?.trim();
  const expandable = Boolean(full || action);
  const head = (
    <>
      <span className="flex h-20 items-center gap-8">
        <StatusGlyph state={unseen ? 'needs' : 'turn'} label={unseen ? 'New' : undefined} />
        <span className={clsx('min-w-0 flex-1 truncate type-row', unseen ? 'font-strong text-ink' : 'text-ink-2')}>{subject}</span>
        <span className="flex-none type-mono text-ink-3">{timeOf(a)}</span>
      </span>
      <span className={clsx('mt-4 block pl-24 type-small', unseen ? 'text-ink-2' : 'text-ink-3')}>{sentence}</span>
    </>
  );
  return (
    <li className="border-b border-line" data-alert={a.id} data-unseen={unseen ? 'true' : undefined}>
      {expandable ? (
        <button type="button" aria-expanded={open} className="block w-full px-16 pb-12 pt-12 text-left transition-colors duration-120 ease-hover active:bg-hover" onClick={onToggle}>
          {head}
        </button>
      ) : (
        <div className="px-16 pb-12 pt-12">{head}</div>
      )}
      {open && expandable ? (
        <div className="pb-8 pl-40 pr-16 animate-pop">
          {full ? <Full text={full} /> : null}
          {action ? <ActionLink action={action} className="h-44" /> : null}
        </div>
      ) : null}
    </li>
  );
}
