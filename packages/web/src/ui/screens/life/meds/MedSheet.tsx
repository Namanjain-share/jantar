/**
 * The medicine sheet (v0.4 spec 5.4), to add a medicine or change one:
 * Name; Dose ("500 mg"); Times (chips, + Add time, at least one); Schedule
 * (Every day | On these days [M T W T F S S] | Every N days, starting a
 * day); Pills left (optional) and Per dose (default 1); Notes.
 *
 * For a medicine already taken, the foot has Refill ("How many did you
 * add?": the count goes up by that much), Stop taking and Delete, each
 * asking first. A stopped medicine only shows when it stopped, and Delete.
 * A change sends only the fields that changed. A failed write keeps the
 * sheet open with its values and "Not saved."
 */
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useId, useState, type ReactNode } from 'react';
import type { MedScheduleBody, MedicineBody, MedicinePatch, MedicineView } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Segmented } from '../../accounts/Segmented.js';
import { dayLabel } from '../shared/DayNav.js';
import { NotSaved, OFFLINE_WRITE } from '../shared/states.js';
import { WEEK, WEEKDAY, WEEKDAY_LETTER, medLabel, useMedWrite, useOffline } from './data.js';

export const DELETE_WARNING = 'This deletes its dose history too.';
export const STOP_WARNING = 'Its pings end today. To take it again, add it again.';
export const REFILL_ASK = 'How many did you add?';

/** A field without a width: no class merging here, so each use adds its own (WIDE fills the row). */
const INPUT =
  'h-40 min-w-0 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:text-ink-3 coarse:h-44';
const WIDE = `${INPUT} w-full`;
const TEXTAREA =
  'block min-h-88 w-full rounded-btn border border-line-strong bg-bg px-12 py-8 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

type Freq = MedScheduleBody['freq'];

interface Form {
  name: string;
  dose: string;
  times: string[];
  freq: Freq;
  days: number[];
  interval: string;
  startDay: string;
  left: string;
  perDose: string;
  notes: string;
}

function formOf(med: MedicineView | null, today: string): Form {
  return {
    name: med?.name ?? '',
    dose: med?.dose ?? '',
    times: med ? [...med.times] : ['08:00'],
    freq: med?.schedule.freq ?? 'daily',
    days: med?.schedule.byWeekday ? [...med.schedule.byWeekday] : [],
    interval: String(med?.schedule.interval ?? 2),
    startDay: med?.schedule.startDay ?? today,
    left: med?.pills ? String(med.pills.left) : '',
    perDose: String(med?.pills?.perDose ?? 1),
    notes: med?.notes ?? '',
  };
}

const intIn = (s: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return n >= min && n <= max ? n : null;
};

/** What the form says is wrong, or null when it can be saved. */
export function formProblem(f: Form): string | null {
  if (!f.name.trim()) return 'Give it a name.';
  if (!f.times.length) return 'Add at least one time.';
  if (f.freq === 'weekly' && !f.days.length) return 'Pick at least one day.';
  if (f.freq === 'interval' && intIn(f.interval, 2, 60) === null) return 'Every 2 to 60 days.';
  if (f.left.trim() !== '' && intIn(f.left, 0, 100_000) === null) return 'Pills left is a whole number.';
  if (intIn(f.perDose, 1, 10) === null) return 'Per dose is 1 to 10.';
  return null;
}

function scheduleOf(f: Form): MedScheduleBody {
  if (f.freq === 'weekly') return { freq: 'weekly', byWeekday: [...f.days].sort((a, b) => a - b) };
  if (f.freq === 'interval') return { freq: 'interval', interval: Number(f.interval), startDay: f.startDay };
  return { freq: 'daily' };
}

const pillsOf = (f: Form) => (f.left.trim() === '' ? null : { left: Number(f.left.trim()), perDose: Number(f.perDose) });

export function bodyOf(f: Form): MedicineBody {
  const pills = pillsOf(f);
  return {
    name: f.name.trim(),
    ...(f.dose.trim() ? { dose: f.dose.trim() } : {}),
    times: [...new Set(f.times)].sort(),
    schedule: scheduleOf(f),
    ...(pills ? { pills } : {}),
    ...(f.notes.trim() ? { notes: f.notes } : {}),
  };
}

/** Only what changed from `med`. */
export function patchOf(med: MedicineView, f: Form): MedicinePatch {
  const p: MedicinePatch = {};
  const b = bodyOf(f);
  if (b.name !== med.name) p.name = b.name;
  if ((b.dose ?? '') !== (med.dose ?? '')) p.dose = b.dose ?? null;
  if (b.times.join() !== med.times.join()) p.times = b.times;
  const s = med.schedule;
  const sameDays =
    b.schedule.freq === s.freq &&
    (b.schedule.byWeekday ?? []).join() === (s.byWeekday ?? []).join() &&
    (b.schedule.freq !== 'interval' || (b.schedule.interval === s.interval && b.schedule.startDay === s.startDay));
  if (!sameDays) p.schedule = b.schedule;
  const pills = pillsOf(f);
  if (!pills && med.pills) p.pills = null;
  else if (pills && (pills.left !== med.pills?.left || pills.perDose !== med.pills?.perDose)) p.pills = pills;
  if ((b.notes ?? '') !== (med.notes ?? '')) p.notes = b.notes ?? null;
  return p;
}

function Field({ label, htmlFor, children, className }: { label: string; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('py-8', className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="mb-6 block type-small text-ink-3">
          {label}
        </label>
      ) : (
        <span className="mb-6 block type-small text-ink-3">{label}</span>
      )}
      {children}
    </div>
  );
}

export interface MedSheetProps {
  open: boolean;
  /** The medicine to change, or null to add one. */
  med: MedicineView | null;
  /** Today in the Life zone (the start day of a new every-N-days schedule). */
  today: string;
  onClose(): void;
  /** After a write that worked; the sheet closes too. */
  onSaved(): void;
}

export function MedSheet({ open, med, today, onClose, onSaved }: MedSheetProps) {
  const { api } = useDeps();
  const offline = useOffline();
  const write = useMedWrite();
  const id = useId();
  const [f, setF] = useState<Form>(() => formOf(med, today));
  const [newTime, setNewTime] = useState('');
  const [ask, setAsk] = useState<'refill' | 'stop' | 'delete' | null>(null);
  const [added, setAdded] = useState('');
  const set = (patch: Partial<Form>) => {
    setF((cur) => ({ ...cur, ...patch }));
    write.clear();
  };
  const blocked = offline || write.busy;
  const problem = formProblem(f);

  const done = (r: { ok: boolean }) => {
    if (!r.ok) return;
    onSaved();
    onClose();
  };

  const save = async () => {
    if (problem || blocked) return;
    if (!med) {
      const body = bodyOf(f);
      done(await write.run(`create:${JSON.stringify(body)}`, (key) => api.medCreate(body, key)));
      return;
    }
    const patch = patchOf(med, f);
    if (!Object.keys(patch).length) return onClose();
    done(await write.run(`update:${med.id}:${JSON.stringify(patch)}`, (key) => api.medUpdate(med.id, patch, key)));
  };

  const refill = async () => {
    const n = intIn(added, 1, 100_000);
    if (!med?.pills || n === null || blocked) return;
    const pills = { left: Math.min(100_000, med.pills.left + n) };
    done(await write.run(`refill:${med.id}:${pills.left}`, (key) => api.medUpdate(med.id, { pills }, key)));
  };
  const stop = async () => {
    if (med) done(await write.run(`stop:${med.id}`, (key) => api.medStop(med.id, key)));
  };
  const remove = async () => {
    if (med) done(await write.run(`delete:${med.id}`, (key) => api.medDelete(med.id, key)));
  };

  const addTime = () => {
    if (!/^\d{2}:\d{2}$/.test(newTime) || f.times.includes(newTime) || f.times.length >= 8) return;
    set({ times: [...f.times, newTime].sort() });
    setNewTime('');
  };

  const confirm = (sentence: string, action: string, run: () => void) => (
    <div role="group" aria-label={action} className="mt-12 border-t border-line pt-12">
      <p className="type-small text-ink-2">{sentence}</p>
      <div className="mt-8 flex gap-8">
        <Button variant="primary" disabled={blocked} onClick={run}>
          {action}
        </Button>
        <Button variant="text" onClick={() => setAsk(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );

  const foot = (
    <>
      {write.error ? <NotSaved error={write.error} /> : null}
      {offline ? <p className="mt-8 type-mono text-ink-3">{OFFLINE_WRITE}</p> : null}
    </>
  );

  if (med?.stoppedOn) {
    return (
      <Sheet open={open} onOpenChange={(o) => (o ? undefined : onClose())} title={medLabel(med)}>
        <div className="pb-16">
          <p className="type-small text-ink-2">Stopped {dayLabel(med.stoppedOn)}. Its doses stay in the history.</p>
          {ask === 'delete' ? (
            confirm(DELETE_WARNING, 'Delete', () => void remove())
          ) : (
            <Button className="mt-12" disabled={blocked} onClick={() => setAsk('delete')}>
              Delete
            </Button>
          )}
          {foot}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={med ? 'Change medicine' : 'Add medicine'}
      actions={
        <Button variant="primary" disabled={blocked || problem !== null} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <form
        className="pb-16"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor={`${id}-name`}>
          <input id={`${id}-name`} className={WIDE} value={f.name} maxLength={60} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Dose" htmlFor={`${id}-dose`}>
          <input id={`${id}-dose`} className={WIDE} value={f.dose} maxLength={40} placeholder="500 mg" autoComplete="off" onChange={(e) => set({ dose: e.target.value })} />
        </Field>

        <Field label="Times">
          <ul aria-label="Dose times" className="flex flex-wrap gap-8">
            {f.times.map((t) => (
              <li key={t} className="inline-flex h-32 items-center gap-4 rounded-chip border border-line-strong pl-8 type-mono text-ink coarse:h-44">
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  disabled={f.times.length <= 1}
                  onClick={() => set({ times: f.times.filter((x) => x !== t) })}
                  className="inline-flex size-28 items-center justify-center text-ink-3 hover:text-ink disabled:opacity-40 coarse:size-44"
                >
                  <XIcon size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {f.times.length < 8 ? (
            <div className="mt-8 flex items-center gap-8">
              <input aria-label="New time" type="time" className={clsx(INPUT, 'w-auto')} value={newTime} onChange={(e) => setNewTime(e.target.value)} />
              <Button disabled={!/^\d{2}:\d{2}$/.test(newTime) || f.times.includes(newTime)} onClick={addTime}>
                <PlusIcon size={14} aria-hidden="true" />
                Add time
              </Button>
            </div>
          ) : null}
        </Field>

        <Field label="Schedule">
          <Segmented<Freq>
            label="Schedule"
            fill
            value={f.freq}
            onChange={(freq) => set({ freq })}
            segments={[
              { key: 'daily', label: 'Every day' },
              { key: 'weekly', label: 'On these days' },
              { key: 'interval', label: 'Every N days' },
            ]}
          />
          {f.freq === 'weekly' ? (
            <div role="group" aria-label="Days" className="mt-8 flex gap-4">
              {WEEK.map((d) => {
                const on = f.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    aria-label={WEEKDAY[d]}
                    onClick={() => set({ days: on ? f.days.filter((x) => x !== d) : [...f.days, d] })}
                    className={clsx(
                      'inline-flex size-36 items-center justify-center rounded-btn border type-mono transition-colors duration-120 ease-hover coarse:size-44',
                      on ? 'border-ink bg-select text-ink' : 'border-line-strong text-ink-3 hover:text-ink',
                    )}
                  >
                    {WEEKDAY_LETTER[d]}
                  </button>
                );
              })}
            </div>
          ) : null}
          {f.freq === 'interval' ? (
            <div className="mt-8 flex flex-wrap items-center gap-8">
              <label htmlFor={`${id}-every`} className="type-small text-ink-3">
                Every
              </label>
              <input id={`${id}-every`} className={clsx(INPUT, 'w-64')} inputMode="numeric" value={f.interval} onChange={(e) => set({ interval: e.target.value })} />
              <label htmlFor={`${id}-start`} className="type-small text-ink-3">
                days, starting
              </label>
              <input id={`${id}-start`} type="date" className={clsx(INPUT, 'w-auto')} value={f.startDay} onChange={(e) => set({ startDay: e.target.value || today })} />
            </div>
          ) : null}
        </Field>

        <div className="flex gap-12">
          <Field label="Pills left" htmlFor={`${id}-left`} className="flex-1">
            <input id={`${id}-left`} className={WIDE} inputMode="numeric" placeholder="Optional" value={f.left} onChange={(e) => set({ left: e.target.value })} />
          </Field>
          <Field label="Per dose" htmlFor={`${id}-per`} className="w-112">
            <input id={`${id}-per`} className={WIDE} inputMode="numeric" value={f.perDose} onChange={(e) => set({ perDose: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes" htmlFor={`${id}-notes`}>
          <textarea id={`${id}-notes`} className={TEXTAREA} value={f.notes} maxLength={500} onChange={(e) => set({ notes: e.target.value })} />
        </Field>

        {problem && (f.name !== '' || med) ? <p className="mt-4 type-small text-ink-2">{problem}</p> : null}
        {foot}

        {med ? (
          ask === 'stop' ? (
            confirm(STOP_WARNING, 'Stop taking', () => void stop())
          ) : ask === 'delete' ? (
            confirm(DELETE_WARNING, 'Delete', () => void remove())
          ) : ask === 'refill' ? (
            <div role="group" aria-label="Refill" className="mt-12 border-t border-line pt-12">
              <label htmlFor={`${id}-added`} className="type-small text-ink-2">
                {REFILL_ASK}
              </label>
              <div className="mt-8 flex gap-8">
                <input id={`${id}-added`} className={clsx(INPUT, 'w-112')} inputMode="numeric" value={added} onChange={(e) => setAdded(e.target.value)} />
                <Button variant="primary" disabled={blocked || intIn(added, 1, 100_000) === null} onClick={() => void refill()}>
                  Add
                </Button>
                <Button variant="text" onClick={() => setAsk(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-12 flex flex-wrap gap-8 border-t border-line pt-12">
              {med.pills ? (
                <Button disabled={blocked} onClick={() => setAsk('refill')}>
                  Refill
                </Button>
              ) : null}
              <Button disabled={blocked} onClick={() => setAsk('stop')}>
                Stop taking
              </Button>
              <Button variant="text" disabled={blocked} onClick={() => setAsk('delete')}>
                Delete
              </Button>
            </div>
          )
        ) : null}
      </form>
    </Sheet>
  );
}
