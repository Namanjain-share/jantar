/**
 * 0.15 Messages' settings (`/messages?view=settings`):
 *
 *   ‹ Messages
 *   Messages settings
 *   The morning run sends other people's     the data note, on the first
 *   messages to Claude …  [Got it]           open on this device
 *   TIMES       Morning run [07:30] Save Off   off: it waits for Run now
 *               Call-back reminders [11:00]    off: a call-back gets a day
 *   SKIP LIST   SkipList.tsx (add here; remove at the Mac only)
 *   LAST RUN    when and how it ran, how fresh WhatsApp was, what it read
 *               and made, what it couldn't read, and what was left out
 *               for size: missed calls per person, then per chat, and how
 *               many more past the report's list
 *   READ LOG    ReadLog.tsx
 *
 * Cards in columns from a pane of 640, rails below. A time is saved with
 * its Save (a picker's every turn isn't a write); Off saves at once.
 */
import { CaretLeftIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { MessagesPrefs, MessagesPrefsPatch, MorningRun } from '@jantar/protocol/messages';
import { readLocal, writeLocal } from '../../../lib/storage.js';
import { routePath } from '../../../lib/router.js';
import { Button } from '../../kit/Button.js';
import { Columns, useCardWidth } from '../../kit/Columns.js';
import { Panel } from '../../kit/Panel.js';
import { Link } from '../../shell/Link.js';
import { LifeLoading, NotSaved } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { INPUT, Page, useOffline, useWrite } from '../life/today/parts.js';
import { DATA_NOTE, NO_RUN, RUNNING, freshness, plural, runCounts, runNotes, runWhen } from './model.js';
import { MessagesError, useMessages } from './parts.js';
import { ReadLog } from './ReadLog.js';
import { SkipList } from './SkipList.js';

/** This device has seen the data note (a convenience: it shows again on another device). */
const NOTE_KEY = 'messages:data-note';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The time field: INPUT's look, as wide as a time needs. */
const TIME_INPUT = INPUT.replace('w-full', 'w-160');

function Back() {
  return (
    <Link href={routePath({ name: 'messages' })} className="inline-flex h-44 items-center gap-4 px-8 type-small text-ink-2 transition-colors duration-120 ease-hover hover:text-ink">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Messages
    </Link>
  );
}

export function MessagesSettings() {
  const m = useMessages();
  const offline = useOffline();
  const { status: lifeStatus } = useLifeStatus();
  const tz = lifeStatus?.timezone;
  const prefs = useLifeLoad('messages:prefs', () => m.prefs());
  const today = useLifeLoad('messages:today', () => m.today());
  const skip = useLifeLoad('messages:skip', () => m.skipList());
  const [noted, setNoted] = useState(() => readLocal<boolean>(NOTE_KEY, false));
  const box = useRef<HTMLDivElement>(null);
  const card = useCardWidth(box);

  const sections: ReactNode[] = [
    <Times key="times" prefs={prefs.data} error={prefs.error} card={card} offline={offline} onRetry={prefs.reload} onSaved={prefs.reload} />,
    <SkipList key="skip" skip={skip.data?.skip ?? null} error={skip.error} card={card} offline={offline} tz={tz} onSkipped={skip.reload} />,
    <LastRun key="run" run={today.data?.run ?? null} error={today.error} loaded={today.data !== null} card={card} offline={offline} tz={tz} onRetry={today.reload} />,
    <ReadLog key="reads" skip={skip.data?.skip ?? null} card={card} offline={offline} tz={tz} />,
  ];
  return (
    <Page title="Messages settings" back={<Back />} wide>
      {noted ? null : (
        <div role="note" className="mx-16 mb-12 rounded-btn border border-line-strong px-12 py-8">
          <p className="type-small text-ink">{DATA_NOTE}</p>
          <p className="mt-4 type-small text-ink-2">Skipped chats are never sent, and nothing is ever sent to WhatsApp.</p>
          <Button
            size="sm"
            className="mt-8 coarse:min-w-44"
            onClick={() => {
              writeLocal(NOTE_KEY, true);
              setNoted(true);
            }}
          >
            Got it
          </Button>
        </div>
      )}
      <div ref={box}>
        {card ? (
          <Columns min={340} className="px-16 pt-4">
            {sections}
          </Columns>
        ) : (
          sections
        )}
      </div>
    </Page>
  );
}

function Times({
  prefs,
  error,
  card,
  offline,
  onRetry,
  onSaved,
}: {
  prefs: MessagesPrefs | null;
  error: unknown;
  card: boolean;
  offline: boolean;
  onRetry: () => void;
  onSaved: () => void;
}) {
  const m = useMessages();
  const write = useWrite();
  const save = async (patch: MessagesPrefsPatch) => {
    const r = await write.run(JSON.stringify(patch), (k) => m.setPrefs(patch, k));
    if (r.ok) onSaved();
  };
  return (
    <Panel label="Times" card={card}>
      {prefs ? (
        <>
          <TimeField
            label="Morning run"
            value={prefs.morningAt}
            help="Each day at this time it reads what came in since the last run (waiting up to 6 hours for WhatsApp to open and sync), then sends one push, counts only."
            off="Off: the morning run waits for Run now."
            saveLabel="Save the morning time"
            offLabel="Turn the morning run off"
            disabled={offline || write.busy}
            onSave={(v) => void save({ morningAt: v })}
          />
          <TimeField
            label="Call-back reminders"
            value={prefs.callbackAt}
            help="A call-back rings at this time, unless the message said when to call."
            off="Off: call-backs get a day, no ring."
            saveLabel="Save the call-back time"
            offLabel="Turn call-back reminders off"
            disabled={offline || write.busy}
            onSave={(v) => void save({ callbackAt: v })}
          />
          {write.error ? (
            <div className="px-16 pb-8">
              <NotSaved error={write.error} />
            </div>
          ) : null}
        </>
      ) : error ? (
        <MessagesError error={error} offline={offline} onRetry={onRetry} />
      ) : (
        <LifeLoading count={2} />
      )}
    </Panel>
  );
}

function TimeField({
  label,
  value,
  help,
  off,
  saveLabel,
  offLabel,
  disabled,
  onSave,
}: {
  label: string;
  value: string | null;
  help: string;
  off: string;
  saveLabel: string;
  offLabel: string;
  disabled: boolean;
  onSave: (v: string | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const changed = HHMM.test(text) && text !== value;
  return (
    <div className="px-16 py-8">
      <label htmlFor={id} className="type-small text-ink-3">
        {label}
      </label>
      <div data-actions className="mt-6 flex flex-wrap items-center gap-8">
        <input id={id} type="time" step={60} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} className={TIME_INPUT} />
        {changed ? (
          <Button variant="primary" aria-label={saveLabel} disabled={disabled} onClick={() => onSave(text)} className="coarse:min-w-44">
            Save
          </Button>
        ) : null}
        {value !== null ? (
          <Button variant="text" aria-label={offLabel} disabled={disabled} onClick={() => onSave(null)} className="coarse:min-w-44">
            Off
          </Button>
        ) : null}
      </div>
      <p className={clsx('mt-4 type-small', value === null ? 'text-ink-2' : 'text-ink-3')}>{value === null ? off : help}</p>
    </div>
  );
}

function LastRun({
  run,
  error,
  loaded,
  card,
  offline,
  tz,
  onRetry,
}: {
  run: MorningRun | null;
  error: unknown;
  loaded: boolean;
  card: boolean;
  offline: boolean;
  tz: string | null | undefined;
  onRetry: () => void;
}) {
  let body: ReactNode;
  if (!loaded) body = error ? <MessagesError error={error} offline={offline} onRetry={onRetry} /> : <LifeLoading count={2} />;
  else if (!run) body = <p className="px-16 py-12 type-small text-ink-2">{NO_RUN}</p>;
  else {
    const fresh = freshness(run, tz);
    body = (
      <>
        <div className="flex flex-col gap-4 px-16 py-12">
          <p className="type-row text-ink">{runWhen(run, tz)}</p>
          {run.state === 'failed' && run.why ? <p className="break-words type-small text-ink-2">{run.why}</p> : null}
          {run.state === 'running' ? <p className="type-small text-ink-2">{RUNNING}</p> : null}
          <p className={clsx('break-words', fresh.stale ? 'type-small text-ink' : 'type-mono text-ink-3')}>{fresh.text}</p>
          {run.state === 'ok' ? <p className="type-small text-ink-2">{runCounts(run)}</p> : null}
          {runNotes(run).map((n) => (
            <p key={n} className="type-small text-ink-2">
              {n}
            </p>
          ))}
        </div>
        {run.dropped.length ? (
          <>
            <p className="px-16 pb-4 type-small text-ink-3">Left out for size: {plural(run.counts.dropped, 'message')}</p>
            <ul aria-label="Left out for size" className="border-t border-line">
              {run.dropped.map((d, i) => (
                <li key={i} className="flex items-baseline gap-8 border-b border-line px-16 py-8">
                  <span className="min-w-0 flex-1 break-words type-row text-ink">{d.chatName}</span>
                  <span className="flex-none type-mono text-ink-3">
                    {d.kept.toLocaleString()} kept · {d.call ? plural(d.left, 'missed call') : d.left.toLocaleString()} left out
                  </span>
                </li>
              ))}
              {run.droppedMore ? <li className="border-b border-line px-16 py-8 type-small text-ink-3">and {run.droppedMore.toLocaleString()} more</li> : null}
            </ul>
          </>
        ) : null}
      </>
    );
  }
  return (
    <Panel label="Last run" card={card}>
      {body}
    </Panel>
  );
}
