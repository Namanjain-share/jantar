/**
 * One alert on the timeline (direction.md 5.4, dir-k.html .al-r / .p-al).
 *
 *   table    0.11, a wide pane with nothing open: time · glyph · subject ·
 *            what happened (two lines) · action; the row opens the alert
 *   pick     0.11, the list beside an open alert: two lines; a row opens it
 *   phone    two lines: glyph, subject and time; then what happened (also a
 *            pane too narrow to put an alert beside the list)
 *
 * Unseen alerts get an ember glyph and a 680 subject; seen ones an outline
 * glyph and quieter text. No pills, no stripes, no "Details". In a narrow
 * pane a row with a longer text expands inline to show it in mono on --term
 * (the action lives in the expanded part too); in a wide one the alert
 * opens beside the list (AlertDetail.tsx).
 */
import type { Alert } from '@jantar/protocol';
import clsx from 'clsx';
import { useNavigate } from '../../context.js';
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
}

/** A row that expands inline (a phone, a narrow pane). */
export interface AlertRowExpandProps extends AlertRowProps {
  open: boolean;
  onToggle: () => void;
}

export const timeOf = (a: Alert) => {
  const t = Date.parse(a.ts);
  return Number.isFinite(t) ? hhmm(t) : '';
};

export function Full({ text, className }: { text: string; className?: string }) {
  return <pre className={clsx('overflow-x-auto whitespace-pre-wrap break-words rounded-btn bg-term px-12 py-8 type-code text-term-ink', className)}>{text}</pre>;
}

export function ActionLink({ action, className }: { action: AlertAction; className?: string }) {
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

/**
 * 0.11, the table across a wide pane (nothing open): time 56 · glyph ·
 * subject (200, 280 in a pane of 1180) · what happened (two lines) ·
 * action 160. 44 tall on a Mac, 52 on touch. The row opens the alert
 * beside the list.
 */
export function AlertRowTable({ alert: a, subject, sentence, action, unseen, href }: AlertRowProps & { href: string }) {
  const navigate = useNavigate();
  return (
    <li className="border-b border-line last:border-b-0" data-alert={a.id} data-unseen={unseen ? 'true' : undefined}>
      <div
        className="flex min-h-44 cursor-pointer items-center pl-16 transition-colors duration-120 ease-hover hover:bg-hover coarse:min-h-52"
        // The whole row opens it with a mouse; the link inside is the one stop for keys and readers.
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.target as Element).closest('a')) return;
          navigate(href);
        }}
      >
        <span className="w-56 flex-none type-mono text-ink-3">{timeOf(a)}</span>
        <span className="w-24 flex-none">
          <StatusGlyph state={unseen ? 'needs' : 'turn'} label={unseen ? 'New' : undefined} />
        </span>
        <Link href={href} className="flex min-w-0 flex-1 items-center self-stretch py-6 focus-visible:-outline-offset-2">
          <span className={clsx('w-200 flex-none truncate pr-16 type-row @xl:w-280', unseen ? 'font-strong text-ink' : 'text-ink-2')}>{subject}</span>
          <span className={clsx('line-clamp-2 min-w-0 flex-1 break-words pr-24 type-row', unseen ? 'text-ink-2' : 'text-ink-3')}>{sentence}</span>
        </Link>
        <span className="flex w-160 flex-none items-center">{action ? <ActionLink action={action} className="h-28 coarse:h-44" /> : null}</span>
      </div>
    </li>
  );
}

/** 0.11, the list beside an open alert: two lines, the open one ticked (the SplitPane keeps it in view); a row opens its alert. */
export function AlertRowPick({ alert: a, subject, sentence, unseen, href, selected }: AlertRowProps & { href: string; selected: boolean }) {
  return (
    <li className="border-b border-line" data-alert={a.id} data-unseen={unseen ? 'true' : undefined}>
      <Link
        href={href}
        aria-current={selected ? 'true' : undefined}
        className={clsx('relative block px-16 py-12 transition-colors duration-120 ease-hover focus-visible:-outline-offset-2', selected ? 'row-tick bg-select' : 'hover:bg-hover')}
      >
        <TwoLines alert={a} subject={subject} sentence={sentence} unseen={unseen} />
      </Link>
    </li>
  );
}

function TwoLines({ alert: a, subject, sentence, unseen }: { alert: Alert; subject: string; sentence: string; unseen: boolean }) {
  return (
    <>
      <span className="flex h-20 items-center gap-8">
        <StatusGlyph state={unseen ? 'needs' : 'turn'} label={unseen ? 'New' : undefined} />
        <span className={clsx('min-w-0 flex-1 truncate type-row', unseen ? 'font-strong text-ink' : 'text-ink-2')}>{subject}</span>
        <span className="flex-none type-mono text-ink-3">{timeOf(a)}</span>
      </span>
      <span className={clsx('mt-4 block pl-24 type-small', unseen ? 'text-ink-2' : 'text-ink-3')}>{sentence}</span>
    </>
  );
}

export function AlertRowPhone({ alert: a, subject, sentence, action, unseen, open, onToggle }: AlertRowExpandProps) {
  const full = a.full?.trim();
  const expandable = Boolean(full || action);
  const head = <TwoLines alert={a} subject={subject} sentence={sentence} unseen={unseen} />;
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
