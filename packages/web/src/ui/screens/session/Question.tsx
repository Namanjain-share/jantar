/**
 * Question dock (direction.md 5.2): the question in --ink, then its options
 * as full-width rows in Claude's own order and wording (44 px desktop, 56 px
 * phone). A tap selects (--select plus the 2 px --ink tick); "Type
 * something…" takes a typed answer inline. Several questions page one at a
 * time ("1 of 3 questions"); picking a single-choice answer moves on, as the
 * terminal does. "Send answer" is enabled once every question has an answer.
 * "Chat about this" is Claude's own way out: it declines with Claude's
 * sentence (CLARIFY_MESSAGE) and Claude asks what to clarify.
 *
 * v0.6: a paired machine's card is headed with the Mac's name for it, says
 * where to answer questions it doesn't carry (that machine; the Mac cuts
 * ones too large to send here), and is off while the machine is offline or
 * watch-only.
 */
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useId, useState, type KeyboardEvent } from 'react';
import { CLARIFY_MESSAGE, type Question } from '@jantar/protocol';
import { questionsOf } from '../../../lib/describe.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { Keycap } from '../../kit/Keycap.js';
import { useDecide } from './decide.js';
import { DockFrame } from './DockFrame.js';
import { Actions, InlineError, OfflineLine } from './Fields.js';
import { CardMachineLines, cardTitle } from './Info.js';
import { usePaneKeys } from './keys.js';
import type { CardProps } from './Permission.js';

interface Answer {
  picked: string[];
  other: string;
  otherOn: boolean;
}

function answerValue(q: Question, a: Answer | undefined): string | string[] | null {
  if (!a) return null;
  const other = a.otherOn ? a.other.trim() : '';
  if (q.multiSelect) {
    const all = [...a.picked, ...(other ? [other] : [])];
    return all.length ? all : null;
  }
  if (a.otherOn) return other || null;
  return a.picked[0] ?? null;
}

/** The square from the glyph language: 8 px for one choice, a boxed square for "pick any". */
function Box({ on, multi }: { on: boolean; multi: boolean }) {
  if (multi) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" className="glyph flex-none">
        <rect className="fill-line-strong" x="2" y="2" width="12" height="1" />
        <rect className="fill-line-strong" x="2" y="13" width="12" height="1" />
        <rect className="fill-line-strong" x="2" y="3" width="1" height="10" />
        <rect className="fill-line-strong" x="13" y="3" width="1" height="10" />
        {on ? <rect className="fill-ink" x="5" y="5" width="6" height="6" /> : null}
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" className="glyph flex-none">
      {on ? (
        <rect className="fill-ink" x="4" y="4" width="8" height="8" />
      ) : (
        <>
          <rect className="fill-line-strong" x="4" y="4" width="8" height="1" />
          <rect className="fill-line-strong" x="4" y="11" width="8" height="1" />
          <rect className="fill-line-strong" x="4" y="5" width="1" height="6" />
          <rect className="fill-line-strong" x="11" y="5" width="1" height="6" />
        </>
      )}
    </svg>
  );
}

export function QuestionCard({ p, phone, offline, age, late, aside, onDecided, machine }: CardProps) {
  const { busy, error, decide } = useDecide(p, onDecided);
  const questions = questionsOf(p);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [page, setPage] = useState(0);
  const disabled = busy || p.state !== 'open' || offline || Boolean(machine?.blocked);
  const baseId = useId();
  const size = phone ? 'xl' : 'lg';

  const update = (qi: number, fn: (a: Answer) => Answer) =>
    setAnswers((prev) => ({ ...prev, [qi]: fn(prev[qi] ?? { picked: [], other: '', otherOn: false }) }));

  const values = questions.map((q, i) => answerValue(q, answers[i]));
  const complete = questions.length > 0 && values.every((v) => v !== null);

  const submit = () => {
    if (!complete || disabled) return;
    const out: Record<string, string | string[]> = {};
    questions.forEach((q, i) => {
      const v = values[i];
      if (v !== null && v !== undefined) out[q.question] = v;
    });
    const only = values[0];
    const receipt =
      questions.length > 1 ? `Answered ${questions.length} questions` : `Answered “${Array.isArray(only) ? only.join(', ') : (only ?? '')}”`;
    void decide({ behavior: 'allow', answers: out }, receipt);
  };
  const decline = () => void decide({ behavior: 'deny' }, 'Declined the question');
  const chat = () => void decide({ behavior: 'deny', message: CLARIFY_MESSAGE }, 'Asked to chat about this');

  usePaneKeys({ a: submit }, !phone && !disabled && complete);

  const q = questions[Math.min(page, questions.length - 1)];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  // While this card is open the screen path is shut, so Decline is the one
  // answer the phone can still give.
  if (!questions.length || !q) {
    return (
      <DockFrame phone={phone} title={cardTitle('Question', machine)} age={age} late={late} aside={aside} peek={`Answer it at ${machine?.name ?? 'the Mac'}.`}>
        <p className="mt-8 type-body text-ink-2">
          This question has no options the app can show. Answer it at {machine?.name ?? 'the Mac'}, or decline it here.
        </p>
        <CardMachineLines p={p} m={machine} />
        <Actions phone={phone}>
          <Button size={size} disabled={disabled} onClick={decline}>
            Decline
          </Button>
        </Actions>
        <InlineError error={error} />
        <OfflineLine offline={offline} />
      </DockFrame>
    );
  }

  const qi = Math.min(page, questions.length - 1);
  const a = answers[qi];
  const type = q.multiSelect ? 'checkbox' : 'radio';
  const name = `${baseId}-q${qi}`;
  const rowPad = phone ? '-mx-16' : '-mx-20';
  const row = (on: boolean) =>
    clsx(
      'relative flex cursor-pointer items-center gap-12 border-b border-line transition-colors duration-120 ease-hover',
      'has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-ink',
      phone ? 'min-h-56 px-16 py-8' : 'min-h-44 px-20 py-4',
      on ? 'row-tick bg-select' : 'hover:bg-hover',
    );

  return (
    <DockFrame phone={phone} title={cardTitle('Question', machine)} age={age} late={late} aside={aside} peek={q.question}>
      <div onKeyDown={onKey}>
        {questions.length > 1 ? (
          <div className="mt-8 flex h-28 items-center gap-4 type-mono text-ink-3">
            <span>
              {q.header ? `${q.header} · ` : ''}
              {qi + 1} of {questions.length} questions
            </span>
            <IconButton aria-label="Previous question" disabled={qi === 0} onClick={() => setPage(qi - 1)} className="ml-4">
              <CaretLeftIcon size={16} />
            </IconButton>
            <IconButton aria-label="Next question" disabled={qi >= questions.length - 1} onClick={() => setPage(qi + 1)}>
              <CaretRightIcon size={16} />
            </IconButton>
          </div>
        ) : null}
        <fieldset key={qi} className="min-w-0 animate-fade" disabled={disabled}>
          <legend className={clsx('type-title text-ink', questions.length > 1 ? 'mt-4' : 'mt-8')}>
            {q.question}
            {q.multiSelect ? <span className="type-small font-regular text-ink-3"> pick any</span> : null}
          </legend>
          <div className={clsx('mt-12 border-t border-line', rowPad)}>
            {q.options.map((o, oi) => {
              const checked = Boolean(a?.picked.includes(o.label)) && !(type === 'radio' && a?.otherOn);
              return (
                <label key={oi} className={row(checked)}>
                  <input
                    type={type}
                    name={name}
                    className="sr-only"
                    checked={checked}
                    onChange={(e) => {
                      update(qi, (cur) =>
                        q.multiSelect
                          ? { ...cur, picked: e.target.checked ? [...cur.picked, o.label] : cur.picked.filter((x) => x !== o.label) }
                          : { ...cur, picked: [o.label], otherOn: false },
                      );
                      if (!q.multiSelect && qi < questions.length - 1) setPage(qi + 1);
                    }}
                  />
                  <Box on={checked} multi={Boolean(q.multiSelect)} />
                  <span className={clsx('min-w-0 flex-1', phone ? 'flex flex-col' : 'flex items-baseline gap-16')}>
                    <span className={clsx('type-row font-medium text-ink', !phone && 'w-184 flex-none truncate')}>{o.label}</span>
                    {o.description ? (
                      <span className={clsx('min-w-0 type-small text-ink-2', !phone && 'truncate')}>{o.description}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            <div className={row(Boolean(a?.otherOn))}>
              <label className="flex flex-none cursor-pointer items-center gap-12">
                <input
                  type={type}
                  name={name}
                  className="sr-only"
                  checked={Boolean(a?.otherOn)}
                  aria-label="Type something"
                  onChange={(e) =>
                    update(qi, (cur) => (q.multiSelect ? { ...cur, otherOn: e.target.checked } : { ...cur, otherOn: true, picked: [] }))
                  }
                />
                <Box on={Boolean(a?.otherOn)} multi={Boolean(q.multiSelect)} />
                <span className="type-row font-medium text-ink">Type something…</span>
              </label>
              <input
                type="text"
                placeholder="Your own answer"
                aria-label={`Other answer to: ${q.question}`}
                value={a?.other ?? ''}
                maxLength={2000}
                onChange={(e) => {
                  const v = e.target.value;
                  update(qi, (cur) =>
                    q.multiSelect ? { ...cur, other: v, otherOn: v.trim() !== '' || cur.otherOn } : { ...cur, other: v, otherOn: true, picked: [] },
                  );
                }}
                className={clsx(
                  'min-w-0 flex-1 rounded-btn border border-line-strong bg-surface px-10 type-input text-ink focus-visible:outline-offset-0',
                  phone ? 'h-44' : 'h-32',
                )}
              />
            </div>
          </div>
        </fieldset>
        {/* Claude lists it under its own rule, after the options: a way out, not an answer. */}
        <Button variant="text" size={size} className="-ml-8 mt-8" disabled={disabled} onClick={chat}>
          Chat about this
        </Button>

        <Actions phone={phone}>
          <Button variant="primary" size={size} className={clsx(phone && 'flex-1')} disabled={disabled || !complete} onClick={submit}>
            {questions.length > 1 ? 'Send answers' : 'Send answer'}
          </Button>
          <Button variant="text" size={size} disabled={disabled} onClick={decline}>
            Decline
          </Button>
          {!phone ? (
            <span className="ml-auto inline-flex items-center gap-6 type-mono text-ink-3">
              <Keycap size="sm">⌘↵</Keycap>
            </span>
          ) : null}
        </Actions>
        {!complete && questions.length > 1 ? <p className="mt-8 type-small text-ink-3">Answer every question to send.</p> : null}
        <CardMachineLines p={p} m={machine} />
        <InlineError error={error} />
        <OfflineLine offline={offline} />
      </div>
    </DockFrame>
  );
}
