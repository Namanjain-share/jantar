/**
 * v0.11 People: one to-do's sheet on her side (spec 3.3, owner Q3), opened
 * from a row's title on To-do and Today:
 *
 * - Snooze: Later 1 h, Tonight, Tomorrow or Next week, unless he marked the
 *   item "no snooze" (then the sheet says so instead).
 * - Skip, with one-tap reasons and an optional note (never scored); Undo
 *   brings it back (a repeating item's date too). While {owner} sees her
 *   to-dos, the sheet says the reason is shown to {owner}.
 * - On his items, Ask to change: reasons and a note go to him (his To-do
 *   and Alerts show it on the item). Editing or deleting his is his to do.
 * - On hers, Edit (title, day and time) and Delete (a second tap confirms:
 *   it is gone for both of them).
 */
import { ASK_REASONS, SKIP_REASONS } from '@jantar/protocol/people-core';
import type { PersonTodo } from '@jantar/protocol/people';
import type { SnoozePreset } from '@jantar/protocol';
import { useEffect, useState } from 'react';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { Field, ReasonChips, Sheet } from '../ui.js';

export const HER_SNOOZES: readonly { preset: SnoozePreset; label: string }[] = [
  { preset: '1h', label: 'Later 1 h' },
  { preset: 'tonight', label: 'Tonight' },
  { preset: 'tomorrow', label: 'Tomorrow' },
  { preset: 'nextWeek', label: 'Next week' },
];

export interface TodoSheetProps {
  t: PersonTodo | null;
  owner: string;
  /** {owner} reads her to-dos now (see.todos): the reason she types is shown to {owner}. */
  shared: boolean;
  api: PersonApi;
  close: () => void;
  /** Runs a write, then reloads the list (errors land in the screen's alert line). */
  run: (p: Promise<unknown>) => void;
  /** The screen's 5-second Undo. */
  undo: (text: string, back: () => void) => void;
}

const field = 'min-h-44 rounded-btn border border-line bg-bg px-8';

export function TodoSheet({ t, owner, shared, api, close, run, undo }: TodoSheetProps) {
  const [mode, setMode] = useState<'menu' | 'skip' | 'ask' | 'edit'>('menu');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [sure, setSure] = useState(false);
  useEffect(() => {
    setMode('menu');
    setReason('');
    setNote('');
    setTitle(t?.title ?? '');
    setDay(t?.due?.day ?? '');
    setTime(t?.due?.time ?? '');
    setSure(false);
  }, [t]);
  if (!t) return null;
  const his = t.by === '';
  const open = t.doneAt === undefined;
  const text = () => [reason, note.trim()].filter(Boolean).join('. ').slice(0, 200);
  const snooze = (preset: SnoozePreset) => {
    run(api.snooze(t.id, preset));
    // Hers go back to the day and time they had; his can't be moved back by her (only he edits them), so no Undo there.
    if (!his) undo(`Snoozed: ${t.title}`, () => run(api.updateTodo(t.id, { due: t.due ?? null })));
    close();
  };
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title={t.title}>
      <div className="flex flex-col gap-8 pb-24">
        {t.notes ? <p className="whitespace-pre-wrap break-words text-ink-2">{t.notes}</p> : null}
        {mode === 'menu' ? (
          <>
            {open ? (
              t.snoozable === false ? (
                <p className="text-small text-ink-2">{owner} marked this "no snooze".</p>
              ) : (
                <div role="group" aria-label="Snooze" className="grid grid-cols-2 gap-8">
                  {HER_SNOOZES.map((s) => (
                    <Button key={s.preset} variant="outline" size="lg" onClick={() => snooze(s.preset)}>
                      {s.label}
                    </Button>
                  ))}
                </div>
              )
            ) : null}
            {open ? (
              <Button variant="outline" size="xl" onClick={() => setMode('skip')}>
                Skip
              </Button>
            ) : null}
            {his && open ? (
              <Button variant="outline" size="xl" onClick={() => setMode('ask')}>
                Ask to change
              </Button>
            ) : null}
            {!his ? (
              <Button variant="outline" size="xl" onClick={() => setMode('edit')}>
                Edit
              </Button>
            ) : null}
            {!his ? (
              <Button variant="text" onClick={() => (sure ? (run(api.deleteTodo(t.id)), close()) : setSure(true))}>
                {sure ? 'Tap again to delete it for good' : 'Delete'}
              </Button>
            ) : null}
            {his ? <p className="text-small text-ink-2">From {owner}: only {owner} edits or deletes it. Ask to change sends {owner} your note.</p> : null}
          </>
        ) : mode === 'edit' ? (
          <>
            <label className="flex flex-col gap-4">
              <span className="text-small text-ink-2">To-do</span>
              <input className={field} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-8">
              <label className="flex flex-col gap-4">
                <span className="text-small text-ink-2">Day (optional)</span>
                <input type="date" className={field} value={day} onChange={(e) => setDay(e.target.value)} />
              </label>
              <label className="flex flex-col gap-4">
                <span className="text-small text-ink-2">Time (optional)</span>
                <input type="time" className={field} value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} />
              </label>
            </div>
            <Button
              variant="primary"
              size="xl"
              disabled={!title.trim()}
              onClick={() => {
                run(api.updateTodo(t.id, { title: title.trim(), due: day ? { day, ...(time ? { time } : {}) } : null }));
                close();
              }}
            >
              Save
            </Button>
          </>
        ) : (
          <>
            <ReasonChips reasons={mode === 'skip' ? SKIP_REASONS : ASK_REASONS} value={reason} onPick={setReason} />
            <Field label={mode === 'skip' ? 'Reason (optional)' : `A note for ${owner} (optional)`} value={note} onChange={setNote} max={200} />
            {mode === 'skip' && shared ? <p className="text-small text-ink-2">{owner} sees the reason you pick or write.</p> : null}
            <Button
              variant="primary"
              size="xl"
              onClick={() => {
                const words = text();
                if (mode === 'skip') {
                  run(api.skip(t.id, words || undefined));
                  undo(`Skipped: ${t.title}`, () => run(api.done(t.id, false)));
                } else {
                  run(api.ask(t.id, words || 'Can we change this?'));
                }
                close();
              }}
            >
              {mode === 'skip' ? 'Skip it' : `Send to ${owner}`}
            </Button>
            {mode === 'skip' ? <p className="text-small text-ink-2">Skipping is never counted against you.</p> : null}
          </>
        )}
      </div>
    </Sheet>
  );
}
