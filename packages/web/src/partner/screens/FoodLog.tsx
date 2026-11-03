/**
 * v0.11 People: her food log (`/p/health?tab=food&day=`, spec 3.5), while
 * her food module is on: a day at a time (the arrows step back and
 * forward, never past today), the day's total against her own target,
 * what {owner} sees of it in one line, the quick add (calories optional,
 * "Keep for one tap"), her saved foods as one-tap chips, and each item
 * with Edit and Delete (a 5-second Undo puts it back). Her target is hers
 * to set. A photo of a meal goes through her Chat, which logs it the same
 * way. Nothing here scores a day or colours it.
 */
import type { FoodDay, FoodEntry } from '@jantar/protocol';
import type { FoodLevel } from '@jantar/protocol/people-core';
import { useCallback, useEffect, useState } from 'react';
import { kcalWord, mealsWord } from '../../people-shared/FoodRead.js';
import { chipClass } from '../../people-shared/chip.js';
import { dayLabel, shiftDay } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';
import { Field, Sheet, UndoToast, useUndo } from '../ui.js';
import { FoodAddForm, foodSeesLine, kcalOf } from './FoodAdd.js';

export function FoodLog({ api, owner, level, day: dayIn, chat, tick }: { api: PersonApi; owner: string; level: FoodLevel; day: string | null; chat: boolean; tick: number }) {
  const [data, setData] = useState<FoodDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FoodEntry | null>(null);
  const [target, setTarget] = useState(false);
  const undo = useUndo();
  const load = useCallback(() => api.food(dayIn ?? undefined).then(setData, (e: Error) => setError(e.message)), [api, dayIn]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const run = (p: Promise<unknown>) =>
    void p.then(
      () => {
        setError(null);
        void load();
      },
      (e: Error) => setError(e.message),
    );
  if (!data) return <div className="mt-12">{error ? <p role="alert">{error}</p> : <p className="text-ink-2">Loading…</p>}</div>;
  const day = data.day;
  const isToday = day === data.today;
  const go = (d: string) => navigate(d === data.today ? '/p/health?tab=food' : `/p/health?tab=food&day=${d}`);
  return (
    <div className="mt-12">
      <div className="flex items-center gap-8">
        <button type="button" aria-label="The day before" className="size-44 shrink-0 text-ink-2" onClick={() => go(shiftDay(day, -1))}>
          ‹
        </button>
        <h2 className="flex-1 text-center font-semibold">{isToday ? 'Today' : dayLabel(day)}</h2>
        <button type="button" aria-label="The next day" className="size-44 shrink-0 text-ink-2 disabled:opacity-40" disabled={isToday} onClick={() => go(shiftDay(day, 1))}>
          ›
        </button>
      </div>
      <p className="mt-4">
        {data.kcal} of {data.target} kcal · {mealsWord(data.entries.length)}
      </p>
      <p className="text-small text-ink-2">{foodSeesLine(owner, level)}</p>
      <FoodAddForm
        api={api}
        day={day}
        keep
        onAdded={() => {
          setError(null);
          void load();
        }}
        onError={setError}
      />
      {data.saved.length ? (
        <div className="mt-8 flex flex-wrap gap-8" aria-label="Saved foods">
          {data.saved.map((s) => (
            <button key={s.id} type="button" className={chipClass()} onClick={() => run(api.foodAdd({ day, savedId: s.id }))}>
              {s.name}
              {s.kcal > 0 ? ` · ${s.kcal}` : ''}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-8">
          {error}
        </p>
      ) : null}
      {data.entries.length ? (
        <ul className="mt-12 divide-y divide-line">
          {data.entries.map((e) => (
            <li key={e.id} className="flex items-center gap-8 py-4">
              <span className="min-w-0 flex-1 break-words">{e.name}</span>
              <span className="shrink-0 text-ink-2">{kcalWord(e.kcal)}</span>
              <button type="button" aria-label={`Edit ${e.name}`} className="size-44 shrink-0 text-ink-2" onClick={() => setEditing(e)}>
                ✎
              </button>
              <button
                type="button"
                aria-label={`Delete ${e.name}`}
                className="size-44 shrink-0 text-ink-2"
                onClick={() => {
                  run(api.foodDelete(e.id));
                  undo.show(`Deleted: ${e.name}`, () => run(api.foodAdd({ day, name: e.name, ...(e.kcal > 0 ? { kcal: e.kcal } : {}) })));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-12 text-ink-2">Nothing logged {isToday ? 'yet today' : 'that day'}.</p>
      )}
      <div className="mt-16 flex flex-wrap items-center gap-8">
        <span className="text-small text-ink-2">Your daily target: {data.target} kcal</span>
        <Button variant="text" className="min-h-44" onClick={() => setTarget(true)}>
          Change
        </Button>
      </div>
      {chat ? (
        <p className="mt-8 text-small text-ink-2">
          A photo of a meal?{' '}
          <a
            href="/p/chat"
            className="inline-flex min-h-44 items-center underline"
            onClick={(ev) => {
              ev.preventDefault();
              navigate('/p/chat');
            }}
          >
            Send it in Chat
          </a>{' '}
          and your assistant logs it here.
        </p>
      ) : null}
      <EntrySheet
        entry={editing}
        close={() => setEditing(null)}
        save={(patch) => api.foodUpdate(editing?.id ?? '', patch).then(() => (setEditing(null), void load()))}
      />
      <TargetSheet open={target} current={data.target} close={() => setTarget(false)} save={(kcalTarget) => api.foodTargets({ kcalTarget }).then(() => (setTarget(false), void load()))} />
      <UndoToast toast={undo.toast} close={undo.close} />
    </div>
  );
}

/** Edit one item: what it was and its calories (empty is none). */
function EntrySheet({ entry, close, save }: { entry: FoodEntry | null; close: () => void; save: (patch: { name?: string; kcal?: number }) => Promise<void> }) {
  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(entry?.name ?? '');
    setKcal(entry && entry.kcal > 0 ? String(entry.kcal) : '');
    setError(null);
  }, [entry]);
  if (!entry) return null;
  const k = kcalOf(kcal);
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title={`Edit ${entry.name}`}>
      <div className="flex flex-col gap-12 pb-24">
        <Field label="What you ate" value={name} onChange={setName} max={80} />
        <Field label="Calories (optional)" value={kcal} onChange={setKcal} max={5} />
        {k === null ? <p className="text-small text-ink-2">Calories are a whole number up to 10,000, or leave them empty.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <Button variant="primary" size="xl" disabled={!name.trim() || k === null} onClick={() => void save({ name: name.trim(), kcal: k ?? 0 }).catch((e: Error) => setError(e.message))}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

/** Her daily calorie target (800 to 6,000): hers alone to set. */
function TargetSheet({ open, current, close, save }: { open: boolean; current: number; close: () => void; save: (kcal: number) => Promise<void> }) {
  const [v, setV] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setV(String(current));
      setError(null);
    }
  }, [open, current]);
  if (!open) return null;
  const n = Number(v);
  const ok = Number.isInteger(n) && n >= 800 && n <= 6000;
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title="Daily target">
      <div className="flex flex-col gap-12 pb-24">
        <Field label="Calories a day (800 to 6,000)" value={v} onChange={setV} max={4} />
        {error ? <p role="alert">{error}</p> : null}
        <Button variant="primary" size="xl" disabled={!ok} onClick={() => void save(n).catch((e: Error) => setError(e.message))}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}
