/**
 * Resume's Pick… (v0.4 spec 5.9): the folder's past conversations, newest
 * first, one row each in the account picker's anatomy:
 *
 *   Thu 30 Oct 14:02   03   fix the push example in the service wo…
 *   14:02                   write tests for the folder browser
 *   Wed 29 Oct 09:15   03   refactor the parser          running    (not a button)
 *
 * The time is mono, the account mono (cswap mode only: one login has none),
 * the first line --ink-2. A conversation that runs now carries a `running`
 * tag and cannot be picked: it is open on the Board. Like the account list
 * it takes the start sheet's place (one raised surface at a time), with
 * Back to return; picking a row returns too.
 *
 * Every string here is a text node: a first line is the user's own words,
 * already masked by the daemon.
 *
 * Focus moves into the list as it opens (the picked row, else the first one
 * that can be picked, else Back); the start sheet puts it back on its Resume
 * row when the list closes. ResumeChoice is that row's segmented control.
 */
import { CaretLeftIcon, ClockCounterClockwiseIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useRef, type KeyboardEvent, type Ref } from 'react';
import type { PastSession } from '@jantar/protocol';
import { accountId } from '../../../lib/format.js';
import { useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Tag } from '../../kit/Tag.js';
import { pastWhen, type ResumeMode } from './data.js';

export interface ResumePickerProps {
  sessions: readonly PastSession[];
  /** The conversation picked now (null: none). */
  value: string | null;
  /** One Claude login: no account column. */
  single: boolean;
  onPick: (id: string) => void;
  onBack: () => void;
}

export function ResumePicker({ sessions, value, single, onPick, onBack }: ResumePickerProps) {
  const now = useNow(60_000);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = root.current;
    (el?.querySelector<HTMLElement>('button[aria-pressed="true"]') ?? el?.querySelector<HTMLElement>('li button') ?? el?.querySelector<HTMLElement>('button'))?.focus();
  }, []);
  const rowCls = (on: boolean, live: boolean) =>
    clsx(
      'relative flex min-h-48 w-full items-center gap-12 px-16 py-8 text-left transition-colors duration-120 ease-hover coarse:min-h-52',
      on ? 'row-tick bg-select' : !live && 'hover:not-disabled:bg-hover',
    );
  return (
    <section ref={root} aria-label="Pick a past session">
      <div className="mb-8 flex items-center gap-8">
        <Button variant="text" size="sm" className="-ml-8" onClick={onBack}>
          <CaretLeftIcon size={16} aria-hidden="true" />
          Back
        </Button>
        <ClockCounterClockwiseIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
        <h2 className="type-title text-ink">Pick a past session</h2>
      </div>
      {sessions.length === 0 ? (
        <p className="py-12 type-small text-ink-2">No past sessions in this folder</p>
      ) : (
        <ul aria-label="Past sessions" className="-mx-16 border-t border-line">
          {sessions.map((s) => {
            const on = value === s.id;
            const when = pastWhen(s.lastAt, now);
            const body = (
              <>
                <span className="w-128 flex-none truncate type-mono text-ink">{when}</span>
                {!single ? <span className="w-24 flex-none type-mono text-ink-3">{s.account === null ? '' : accountId(s.account)}</span> : null}
                <span className={clsx('min-w-0 flex-1 truncate type-small', s.live ? 'text-ink-3' : 'text-ink-2')}>{s.first ?? ''}</span>
                {s.live ? <Tag>running</Tag> : null}
              </>
            );
            return (
              <li key={s.id} className="border-b border-line" data-past={s.id}>
                {s.live ? (
                  <div aria-disabled="true" className={rowCls(false, true)}>
                    {body}
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-label={`${when}${!single && s.account !== null ? ` on ${accountId(s.account)}` : ''}${s.first ? `: ${s.first}` : ''}`}
                    onClick={() => onPick(s.id)}
                    className={rowCls(on, false)}
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface ResumeChoiceProps {
  labelledBy: string;
  value: ResumeMode;
  /** Last has a conversation to open (lastPast). */
  lastOk: boolean;
  /** The folder has past sessions to list. */
  pickOk: boolean;
  onChange: (mode: Exclude<ResumeMode, 'pick'>) => void;
  /** Open the list (Pick…). */
  onPick: () => void;
  groupRef?: Ref<HTMLDivElement>;
}

const RESUME_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'last', label: 'Last' },
  { value: 'pick', label: 'Pick…' },
] as const;

/**
 * Resume's segmented control, drawn as the flag pickers (Choice) are, with
 * two differences. Last and Pick… are disabled one by one; Off never is, so
 * the row stays reachable while the list loads or when it is empty. And
 * Pick… opens the list only on a click, Enter or Space: the arrows select
 * Off and Last as a radio group does, but only move focus onto Pick…, so
 * arrowing past it never replaces the sheet. The arrows skip a disabled
 * choice and wrap.
 */
export function ResumeChoice({ labelledBy, value, lastOk, pickOk, onChange, onPick, groupRef }: ResumeChoiceProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const ok = (v: ResumeMode) => (v === 'last' ? lastOk : v === 'pick' ? pickOk : true);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = RESUME_CHOICES.length;
    const from = refs.current.indexOf(e.target as HTMLButtonElement);
    let at = from >= 0 ? from : Math.max(0, RESUME_CHOICES.findIndex((c) => c.value === value));
    // The next choice that can be taken (Off always can, so one round at most).
    for (let i = 0; i < n; i++) {
      at = (at + step + n) % n;
      const next = RESUME_CHOICES[at];
      if (next && ok(next.value)) break;
    }
    const c = RESUME_CHOICES[at];
    if (!c) return;
    refs.current[at]?.focus();
    if (c.value !== 'pick' && c.value !== value) onChange(c.value);
  };
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-labelledby={labelledBy}
      onKeyDown={onKey}
      className="inline-flex max-w-full flex-wrap gap-2 rounded-btn border border-line p-2"
    >
      {RESUME_CHOICES.map((c, i) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={!ok(c.value)}
            onClick={() => (c.value === 'pick' ? onPick() : onChange(c.value))}
            className={clsx(
              'h-28 whitespace-nowrap rounded-chip px-12 type-small font-medium transition-colors duration-120 ease-hover coarse:h-44',
              on ? 'bg-select text-ink' : 'text-ink-3 hover:not-disabled:text-ink',
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
