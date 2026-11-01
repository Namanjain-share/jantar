/**
 * One Ask turn (v0.5.3 spec 1, 1.1): your words on the right; then "Asking
 * Claude…" with Cancel while it waits, or Claude's reply as plain text
 * (never Markdown, never a link) and a card per suggestion. A card changes
 * nothing until Add. Edit changes it first (web only), Skip sets it aside,
 * and an added card keeps "✓ Added · Undo" while its turn is at most a day
 * old. "Add all N" adds the proposed todo, food and post cards one at a
 * time (one askAdd each, never money), stopping at the first refusal; it
 * waits while a card of the turn is open in Edit, so it never adds the
 * suggestion the user is changing. Every tap has its own Idempotency-Key:
 * a refusal the Mac kept for one tap never answers the next.
 *
 * Ink only, with ember (design rule 3) for a failure alone: a turn that
 * failed, and a refused Send, Cancel, Add, Skip, Undo or Clear.
 */
import { CheckIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useState, type ReactNode } from 'react';
import type { AskCard, AskTurn, AskWriteAction, ProjectView } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { formatAmount } from '../../../lib/money.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { kcalText } from '../life/food/format.js';
import { projectLabel } from '../life/todos/model.js';
import { CardEdit } from './Edit.js';
import { ASK_COPY, FLAG_TEXT, REPEAT_TEXT, addAllCards, dayWords, droppedText, dueWords, fresh, kindLabel } from './model.js';
import { ShowBody } from './Show.js';

/** A failure, in ember: the Mac's sentence for a refused tap, or a failed turn's reason. */
export function Refused({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={clsx('type-small text-signal-text', className)}>
      {children}
    </p>
  );
}

/**
 * A refusal in words: the Mac's own sentence for Ask's limits ("This device
 * has asked 100 times today. Try again tomorrow." is not a minute's wait),
 * else what every screen says for it.
 */
export function refusalText(e: unknown): string {
  return isApiError(e, 'rate_limited') && e.message ? e.message : errorText(e);
}

/** One write at a time with a new Idempotency-Key for every tap, and its failure kept to show until the next run or reset. */
export function useTap() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (fn: (key: string) => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn(newIdempotencyKey());
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const reset = useCallback(() => setError(null), []);
  return { busy, error, run, reset };
}

type Op = 'add' | 'skip' | 'undo';

/** The card taps of one turn: which card is busy (or all of them, for Add all) and each card's last refusal. */
function useCardWrites(onChanged: () => void) {
  const [busy, setBusy] = useState<{ n: number | 'all'; op: Op } | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<number, unknown>>(() => new Map());
  const one = async (n: number, fn: (key: string) => Promise<unknown>): Promise<boolean> => {
    setErrors((m) => {
      if (!m.has(n)) return m;
      const next = new Map(m);
      next.delete(n);
      return next;
    });
    try {
      await fn(newIdempotencyKey());
      return true;
    } catch (e) {
      setErrors((m) => new Map(m).set(n, e));
      return false;
    }
  };
  const tap = async (n: number, op: Op, fn: (key: string) => Promise<unknown>): Promise<boolean> => {
    setBusy({ n, op });
    const ok = await one(n, fn);
    setBusy(null);
    onChanged();
    return ok;
  };
  const all = async (ns: readonly number[], fn: (n: number, key: string) => Promise<unknown>) => {
    setBusy({ n: 'all', op: 'add' });
    for (const n of ns) if (!(await one(n, (key) => fn(n, key)))) break;
    setBusy(null);
    onChanged();
  };
  return { busy, errors, tap, all };
}

export interface TurnProps {
  turn: AskTurn;
  nowMs: number;
  /** Today on the Life clock. */
  today: string;
  currency: string | null;
  projects: readonly ProjectView[];
  offline: boolean;
  /** Try again may send now (Ask is ready, nothing else is waiting, no send in flight). */
  canSend: boolean;
  onRetry: (text: string) => void;
  onChanged: () => void;
}

export function Turn({ turn, nowMs, today, currency, projects, offline, canSend, onRetry, onChanged }: TurnProps) {
  const { api } = useDeps();
  const cancel = useTap();
  const cards = useCardWrites(onChanged);
  // The cards open in Edit, by index. A card shows its form only while proposed.
  const [editing, setEditing] = useState<ReadonlySet<number>>(() => new Set());
  const edit = (n: number, on: boolean) =>
    setEditing((s) => {
      if (s.has(n) === on) return s;
      const next = new Set(s);
      if (on) next.add(n);
      else next.delete(n);
      return next;
    });
  const editOpen = turn.cards.some((c, n) => c.state === 'proposed' && editing.has(n));
  const ok = fresh(turn, nowMs);
  const all = addAllCards(turn, nowMs);

  let body: ReactNode;
  switch (turn.state) {
    case 'queued':
    case 'running':
      body = (
        <div className="px-16">
          <div role="status" className="flex min-h-44 items-center gap-12">
            <Spinner label="Asking Claude" />
            <span className="flex-1 type-small text-ink-2">{ASK_COPY.asking}</span>
            <Button
              variant="text"
              disabled={offline || cancel.busy}
              onClick={() =>
                void cancel.run((key) => api.askCancel(turn.id, key)).then(() => {
                  onChanged();
                })
              }
            >
              Cancel
            </Button>
          </div>
          {cancel.error ? <Refused>{refusalText(cancel.error)}</Refused> : null}
        </div>
      );
      break;
    case 'failed':
      body = (
        <div className="px-16">
          <Refused>{turn.reason ?? ASK_COPY.failed}</Refused>
          <Button size="sm" className="mt-8" disabled={!canSend} onClick={() => onRetry(turn.text)}>
            Try again
          </Button>
        </div>
      );
      break;
    case 'cancelled':
      body = <p className="px-16 type-small text-ink-3">{ASK_COPY.cancelled}</p>;
      break;
    case 'done':
      body = (
        <>
          {turn.reply ? <p className="whitespace-pre-wrap break-words px-16 type-body text-ink">{turn.reply}</p> : null}
          {turn.cards.length ? (
            <ul aria-label="Suggestions" className="mt-8 border-t border-line">
              {turn.cards.map((card, n) => (
                <Card
                  key={n}
                  card={card}
                  today={today}
                  currency={currency}
                  projects={projects}
                  fresh={ok}
                  editing={editing.has(n)}
                  onEditing={(on) => edit(n, on)}
                  disabled={offline || cards.busy !== null}
                  busy={cards.busy && cards.busy.n === n ? cards.busy.op : null}
                  error={cards.errors.get(n)}
                  onAdd={(edit) => cards.tap(n, 'add', (key) => api.askAdd(turn.id, n, edit, key))}
                  onSkip={() => void cards.tap(n, 'skip', (key) => api.askSkip(turn.id, n, key))}
                  onUndo={() => void cards.tap(n, 'undo', (key) => api.askUndo(turn.id, n, key))}
                />
              ))}
            </ul>
          ) : null}
          {all.length ? (
            <div className="px-8 pt-4">
              <Button
                variant="text"
                size="sm"
                disabled={offline || cards.busy !== null || editOpen}
                onClick={() => void cards.all(all, (n, key) => api.askAdd(turn.id, n, undefined, key))}
              >
                {cards.busy?.n === 'all' ? <Spinner label="Adding" /> : null}
                Add all {all.length}
              </Button>
            </div>
          ) : null}
          {turn.dropped > 0 ? <p className="mt-4 px-16 type-small text-ink-3">{droppedText(turn.dropped)}</p> : null}
        </>
      );
      break;
  }

  return (
    <li data-turn={turn.id} className="py-12">
      <div className="flex justify-end px-16">
        <p className="max-w-560 whitespace-pre-wrap break-words text-right type-body text-ink-2">{turn.text}</p>
      </div>
      <div className="mt-8">{body}</div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Cards

interface CardProps {
  card: AskCard;
  today: string;
  currency: string | null;
  projects: readonly ProjectView[];
  /** The turn is at most a day old: Add, Edit and Undo work. */
  fresh: boolean;
  /** Open in Edit (kept by the turn, so Add all waits for it). */
  editing: boolean;
  onEditing: (on: boolean) => void;
  /** Offline, or a tap on this turn is in flight. */
  disabled: boolean;
  /** This card's tap in flight. */
  busy: Op | null;
  error: unknown;
  onAdd: (edit?: AskWriteAction) => Promise<boolean>;
  onSkip: () => void;
  onUndo: () => void;
}

/** What a card is about, for its first line and its buttons' names. */
function cardTitle(card: AskCard, currency: string | null): string {
  const a = card.action;
  switch (a.type) {
    case 'todo':
      return a.title;
    case 'food':
      return a.name;
    case 'money':
      return formatAmount(a.amount, currency);
    case 'post':
      return a.title ?? '';
    case 'show':
      return '';
  }
}

/** The mono line under the first: when, how often, how much, which project or category. */
function metaOf(card: AskCard, today: string, projects: readonly ProjectView[]): string[] {
  const a = card.action;
  switch (a.type) {
    case 'todo': {
      const p = a.projectId ? projects.find((x) => x.id === a.projectId) : undefined;
      return [a.due ? dueWords(a.due, today) : null, a.repeat ? REPEAT_TEXT[a.repeat] : null, a.priority === 'high' ? 'High' : null, p ? projectLabel(p) : null].filter(
        (x): x is string => x !== null,
      );
    }
    case 'food':
      return [`${kcalText(a.kcal)} kcal`, ...(a.day === today ? [] : [dayWords(a.day, today)])];
    case 'money':
      return [a.category, ...(a.note ? [a.note] : []), ...(a.day === today ? [] : [dayWords(a.day, today)])];
    case 'post':
      return [...(a.where ? [a.where] : []), ...(a.due ? [dueWords(a.due, today)] : [])];
    case 'show':
      return [];
  }
}

function Card({ card, today, currency, projects, fresh: canApply, editing, onEditing, disabled, busy, error, onAdd, onSkip, onUndo }: CardProps) {
  const a = card.action;
  const title = cardTitle(card, currency);
  const named = title || kindLabel(a);
  const skipped = card.state === 'skipped';

  const head = (
    <p className="flex items-baseline gap-8">
      <span className="flex-none type-small text-ink-3">{kindLabel(a)}</span>
      {title ? <span className={clsx('min-w-0 flex-1 break-words type-row', skipped ? 'text-ink-3' : 'text-ink')}>{title}</span> : null}
      {skipped ? <span className="ml-auto flex-none type-small text-ink-3">Skipped</span> : null}
    </p>
  );

  if (a.type === 'show') {
    return (
      <li data-card="show" className="border-b border-line py-8">
        <div className="px-16">{head}</div>
        <div className="mt-4">
          <ShowBody what={a.what} />
        </div>
      </li>
    );
  }
  if (skipped) {
    return (
      <li data-card={a.type} data-state="skipped" className="border-b border-line px-16 py-8">
        {head}
      </li>
    );
  }

  const meta = metaOf(card, today, projects);
  let actions: ReactNode;
  if (card.state === 'added') {
    actions = (
      <div className="mt-4 flex flex-wrap items-center justify-end gap-x-8">
        <span className="inline-flex items-center gap-4 type-small text-ink-2">
          <CheckIcon size={14} aria-hidden="true" />
          Added
        </span>
        {canApply ? (
          <>
            <span aria-hidden="true" className="type-small text-ink-3">
              ·
            </span>
            <Button variant="text" size="sm" className="-mr-8" aria-label={`Undo: ${named}`} disabled={disabled} onClick={onUndo}>
              {busy === 'undo' ? <Spinner label="Undoing" /> : null}
              Undo
            </Button>
          </>
        ) : null}
      </div>
    );
  } else if (editing) {
    actions = (
      <CardEdit
        action={a}
        today={today}
        currency={currency}
        project={a.type === 'todo' && a.projectId ? projects.find((p) => p.id === a.projectId) : undefined}
        busy={busy === 'add'}
        disabled={disabled}
        onSave={(edit) =>
          void onAdd(edit).then((ok) => {
            if (ok) onEditing(false);
          })
        }
        onCancel={() => onEditing(false)}
      />
    );
  } else {
    actions = (
      <>
        <div className="mt-6 flex flex-wrap items-center gap-8">
          <Button variant="primary" size="sm" aria-label={`Add: ${named}`} disabled={disabled || !canApply} onClick={() => void onAdd()}>
            {busy === 'add' ? <Spinner label="Adding" /> : null}
            Add
          </Button>
          <Button size="sm" aria-label={`Edit: ${named}`} disabled={disabled || !canApply} onClick={() => onEditing(true)}>
            Edit
          </Button>
          <Button variant="text" size="sm" aria-label={`Skip: ${named}`} disabled={disabled} onClick={onSkip}>
            {busy === 'skip' ? <Spinner label="Skipping" /> : null}
            Skip
          </Button>
        </div>
        {canApply ? null : <p className="mt-4 type-small text-ink-3">{ASK_COPY.stale}</p>}
      </>
    );
  }

  return (
    <li data-card={a.type} data-state={card.state} className="border-b border-line px-16 py-8">
      {head}
      {meta.length ? <p className="mt-2 break-words type-mono text-ink-3">{meta.join(' · ')}</p> : null}
      {a.type === 'todo' && a.notes ? <p className="mt-2 line-clamp-2 whitespace-pre-wrap break-words type-small text-ink-2">{a.notes}</p> : null}
      {card.flag ? <p className="mt-2 type-small text-ink-3">{FLAG_TEXT[card.flag]}</p> : null}
      {actions}
      {error ? <Refused className="mt-4">{refusalText(error)}</Refused> : null}
    </li>
  );
}
