/**
 * v0.11 People: her Health (`/p/health`), a lazy screen: Medicines (spec
 * 3.4: today's doses with Taken and Skip and a 5-second Undo, her medicines
 * with "added by {owner}" and "edited by {owner}", Add, Edit and Stop for
 * any of hers), Sleep (P2: the week, Going to sleep, Add a night, edit and
 * delete any night; spec 3.12) and Weight (P1: log today or an earlier
 * day, delete one with Undo, and "Corrected by {owner} (was … kg)" on a
 * weight he corrected with editHers.weight), and Food (spec 3.5: her food
 * log, FoodLog.tsx) only while her food module is on; `?tab=food` with it
 * off shows Medicines. Nothing here colours a short night, a dose not
 * logged or a day's calories, or turns any of them into an alert.
 */
import type { MedicineBody, MedicinePatch, MedsDayItem } from '@jantar/protocol';
import type { FoodLevel } from '@jantar/protocol/people-core';
import type { PersonMedicineView, PersonMedicinesResponse, PersonWeight, PersonWeightsResponse, SleepNight, SleepWeek as Week } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Faces } from '../../people-shared/Faces.js';
import { scheduleWords } from '../../people-shared/MedsRead.js';
import { SleepWeek } from '../../people-shared/SleepWeek.js';
import { dayLabel, shiftDay } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';
import type { HealthTab } from '../router.js';
import { Field, Sheet, UndoToast, useUndo } from '../ui.js';
import { DoseRow } from './DoseRow.js';
import { FoodLog } from './FoodLog.js';

const TAB_LABEL: Record<HealthTab, string> = { meds: 'Medicines', sleep: 'Sleep', weight: 'Weight', food: 'Food' };

export default function Health({
  api,
  owner,
  tab: tabIn,
  week,
  day = null,
  food = { on: false, level: 'off' },
  chat = false,
  tick,
}: {
  api: PersonApi;
  owner: string;
  tab: HealthTab;
  week: string | null;
  /** `?day=` for her food log. */
  day?: string | null;
  /** Her food module, and what {owner} sees of it (see.food). */
  food?: { on: boolean; level: FoodLevel };
  /** Her Chat is built (a photo of a meal goes there). */
  chat?: boolean;
  tick: number;
}) {
  const tab = tabIn === 'food' && !food.on ? 'meds' : tabIn;
  const tabs: HealthTab[] = food.on ? ['meds', 'food', 'sleep', 'weight'] : ['meds', 'sleep', 'weight'];
  return (
    <div>
      <h1 className="text-title font-semibold">Health</h1>
      <div role="tablist" className="mt-8 flex flex-wrap gap-8">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => navigate(`/p/health?tab=${t}`)} className={`min-h-44 px-12 ${tab === t ? 'font-medium text-ink underline' : 'text-ink-2'}`}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {tab === 'meds' ? (
        <Meds api={api} owner={owner} tick={tick} />
      ) : tab === 'food' ? (
        <FoodLog api={api} owner={owner} level={food.level} day={day} chat={chat} tick={tick} />
      ) : tab === 'sleep' ? (
        <Sleep api={api} week={week} tick={tick} />
      ) : (
        <Weight api={api} owner={owner} tick={tick} />
      )}
    </div>
  );
}

/** Today's doses (Taken, Skip, Undo) and her medicines: Add, Edit and Stop any of hers, his additions included. */
function Meds({ api, owner, tick }: { api: PersonApi; owner: string; tick: number }) {
  const [data, setData] = useState<PersonMedicinesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonMedicineView | 'new' | null>(null);
  const [stopping, setStopping] = useState<PersonMedicineView | null>(null);
  const undo = useUndo();
  const load = useCallback(() => api.meds().then(setData, (e: Error) => setError(e.message)), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const run = (p: Promise<unknown>) => p.then(() => (setError(null), void load()), (e: Error) => setError(e.message));
  const byId = new Map((data?.medicines ?? []).map((m) => [m.id, m]));
  const log = (i: MedsDayItem, status: 'taken' | 'skipped') =>
    void api.doseLog(i.medId, { day: data?.day.day ?? '', slot: i.slot, status }).then(
      (r) => {
        setError(null);
        void load();
        undo.show(`${status === 'taken' ? 'Taken' : 'Skipped'}: ${i.name} ${i.slot}`, () => void run(api.doseDelete(i.medId, r.id)));
      },
      (e: Error) => setError(e.message),
    );
  const items = data?.day.groups.flatMap((g) => g.items) ?? [];
  const taking = (data?.medicines ?? []).filter((m) => !m.stoppedOn);
  return (
    <div className="mt-12">
      {error ? <p role="alert">{error}</p> : null}
      <h2 className="font-semibold">Doses today</h2>
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <DoseRow
              key={`${i.medId}@${i.slot}`}
              item={i}
              {...(byId.get(i.medId)?.by === '' ? { addedBy: owner } : {})}
              onLog={(st) => log(i, st)}
              onUndo={() => i.doseId && void run(api.doseDelete(i.medId, i.doseId))}
            />
          ))}
        </ul>
      ) : (
        <p className="text-ink-2">{data ? 'No doses due today.' : 'Loading…'}</p>
      )}
      <h2 className="mt-16 font-semibold">Your medicines</h2>
      <ul className="divide-y divide-line">
        {taking.map((m) => (
          <li key={m.id} className="flex flex-wrap items-start gap-8 py-8">
            <div className="min-w-0 flex-1 basis-[12rem]">
              <p className="break-words">
                {m.name}
                {m.dose ? <span className="text-ink-2"> · {m.dose}</span> : null}
              </p>
              <p className="text-small text-ink-2">
                {[m.times.join(', '), scheduleWords(m), m.supply?.low ? 'running low' : null, m.by === '' ? `added by ${owner}` : null, m.editedBy === '' && m.by !== '' ? `edited by ${owner}` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <div className="flex gap-4">
              <Button variant="outline" className="min-h-44" onClick={() => setEditing(m)}>
                Edit
              </Button>
              <Button variant="text" className="min-h-44" onClick={() => setStopping(m)}>
                Stop
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-12">
        <Button variant="outline" size="lg" onClick={() => setEditing('new')}>
          Add a medicine
        </Button>
      </div>
      <MedSheet
        med={editing}
        close={() => setEditing(null)}
        save={async (body, id) => {
          if (id) await api.medUpdate(id, body);
          else await api.medCreate(body as MedicineBody);
          setEditing(null);
          void load();
        }}
      />
      <Sheet open={stopping !== null} onOpenChange={(o) => !o && setStopping(null)} title={stopping ? `Stop ${stopping.name}?` : 'Stop'}>
        <div className="flex flex-col gap-12 pb-24">
          <p>Its reminders end today. Your doses so far stay in your history{stopping?.by === '' ? `, and ${owner} is told` : ''}.</p>
          <div className="flex gap-8">
            <Button variant="primary" size="lg" onClick={() => stopping && void run(api.medStop(stopping.id)).then(() => setStopping(null))}>
              Stop it
            </Button>
            <Button variant="text" size="lg" onClick={() => setStopping(null)}>
              Keep it
            </Button>
          </div>
        </div>
      </Sheet>
      <UndoToast toast={undo.toast} close={undo.close} />
    </div>
  );
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Add or edit one medicine: name, dose, times (HH:MM, comma-separated) and notes. A new one is every day. */
function MedSheet({ med, close, save }: { med: PersonMedicineView | 'new' | null; close: () => void; save: (body: MedicinePatch | MedicineBody, id?: string) => Promise<void> }) {
  const ex = med && med !== 'new' ? med : null;
  const [name, setName] = useState('');
  const [dose, setDose] = useState('');
  const [times, setTimes] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(ex?.name ?? '');
    setDose(ex?.dose ?? '');
    setTimes(ex ? ex.times.join(', ') : '');
    setNotes(ex?.notes ?? '');
    setError(null);
  }, [ex, med]);
  if (!med) return null;
  const list = times
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t));
  const valid = name.trim().length > 0 && list.length > 0 && list.length <= 8 && list.every((t) => TIME_RE.test(t));
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title={ex ? `Edit ${ex.name}` : 'Add a medicine'}>
      <div className="flex flex-col gap-12 pb-24">
        <Field label="Name" value={name} onChange={setName} max={60} />
        <Field label="Dose (optional), like 1 tablet or 500 mg" value={dose} onChange={setDose} max={40} />
        <Field label="Times, like 08:00, 20:00" value={times} onChange={setTimes} max={60} />
        <Field label="Notes (optional)" value={notes} onChange={setNotes} max={500} />
        {error ? <p role="alert">{error}</p> : null}
        <Button
          variant="primary"
          size="xl"
          disabled={!valid}
          onClick={() =>
            void save(
              ex
                ? { name: name.trim(), dose: dose.trim() || null, times: list, notes: notes.trim() || null }
                : { name: name.trim(), ...(dose.trim() ? { dose: dose.trim() } : {}), times: list, schedule: { freq: 'daily' }, ...(notes.trim() ? { notes: notes.trim() } : {}) },
              ex?.id,
            ).catch((e: Error) => setError(e.message))
          }
        >
          Save
        </Button>
      </div>
    </Sheet>
  );
}

/** A local `datetime-local` value for an ISO instant, and back. */
const toLocal = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string) => new Date(v).toISOString();
/** The night a bedtime belongs to: from 12:00 that day, before 12:00 the day before (the daemon checks it too). */
/** 20:00 to 04:00 on this device: when "Going to sleep" is the main button (Today shows it then too). */
const eveningNow = () => {
  const h = new Date().getHours();
  return h >= 20 || h < 4;
};
const nightOf = (v: string) => (Number(v.slice(11, 13)) >= 12 ? v.slice(0, 10) : shiftDay(v.slice(0, 10), -1));

function Sleep({ api, week, tick }: { api: PersonApi; week: string | null; tick: number }) {
  const [w, setW] = useState<Week | null>(null);
  const [editing, setEditing] = useState<SleepNight | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.sleep(week ?? undefined).then(setW, (e: Error) => setError(e.message)), [api, week]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  return (
    <div className="mt-12">
      {w ? (
        <SleepWeek
          week={w}
          onWeek={(m) => navigate(`/p/health?tab=sleep&week=${m}`)}
          actions={(n) => (
            <button type="button" aria-label={`Edit the night of ${n.night}`} className="size-44 shrink-0 text-ink-2" onClick={() => setEditing(n)}>
              ✎
            </button>
          )}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="mt-12 flex flex-wrap gap-8">
        {w && !w.open ? (
          // The main button only in the evening and night (as on Today); by day, Add a night is the way in.
          <Button variant={eveningNow() ? 'primary' : 'outline'} size="lg" onClick={() => void api.sleepStart().then(load, (e: Error) => setError(e.message))}>
            Going to sleep
          </Button>
        ) : null}
        {w?.open ? (
          <Button variant="primary" size="lg" onClick={() => void api.sleepWake({}).then(load, (e: Error) => setError(e.message))}>
            Woke up
          </Button>
        ) : null}
        <Button variant="outline" size="lg" onClick={() => setEditing('new')}>
          Add a night
        </Button>
      </div>
      <NightSheet
        night={editing}
        close={() => setEditing(null)}
        save={(night, body) => api.sleepPut(night, body).then(() => (setEditing(null), void load()))}
        remove={(night) => api.sleepDelete(night).then(() => (setEditing(null), void load()))}
      />
    </div>
  );
}

function NightSheet({
  night,
  close,
  save,
  remove,
}: {
  night: SleepNight | 'new' | null;
  close: () => void;
  save: (night: string, body: { bedAt: string; wakeAt?: string | null; quality?: number | null; notes?: string | null }) => Promise<void>;
  remove: (night: string) => Promise<void>;
}) {
  const ex = night && night !== 'new' ? night : null;
  const [bed, setBed] = useState('');
  const [wake, setWake] = useState('');
  const [quality, setQuality] = useState<number | undefined>();
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBed(ex ? toLocal(ex.bedAt) : '');
    setWake(ex?.wakeAt ? toLocal(ex.wakeAt) : '');
    setQuality(ex?.quality);
    setNotes(ex?.notes ?? '');
    setError(null);
  }, [ex, night]);
  if (!night) return null;
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title={ex ? 'Edit night' : 'Add a night'}>
      <div className="flex flex-col gap-12 pb-24">
        <label className="flex flex-col gap-4">
          <span className="text-small text-ink-2">Bedtime</span>
          <input type="datetime-local" className="min-h-44 rounded-btn border border-line bg-bg px-8 type-input" value={bed} onChange={(e) => setBed(e.target.value)} />
        </label>
        <label className="flex flex-col gap-4">
          <span className="text-small text-ink-2">Wake time (optional)</span>
          <input type="datetime-local" className="min-h-44 rounded-btn border border-line bg-bg px-8 type-input" value={wake} onChange={(e) => setWake(e.target.value)} />
        </label>
        <p className="text-small text-ink-2">Quality (optional)</p>
        <Faces label="Sleep quality" value={quality} onChange={setQuality} />
        <Field label="Notes (optional)" value={notes} onChange={setNotes} max={500} />
        {error ? <p role="alert">{error}</p> : null}
        <Button
          variant="primary"
          size="xl"
          disabled={!bed}
          onClick={() =>
            void save(ex?.night ?? nightOf(bed), {
              bedAt: fromLocal(bed),
              wakeAt: wake ? fromLocal(wake) : ex ? null : undefined,
              quality: quality ?? (ex ? null : undefined),
              notes: notes.trim() || (ex ? null : undefined),
            }).catch((e: Error) => setError(e.message))
          }
        >
          Save
        </Button>
        {ex ? (
          <Button variant="text" onClick={() => void remove(ex.night).catch((e: Error) => setError(e.message))}>
            Delete this night
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The line under a weight he corrected: "Corrected by Sam (was 72.4 kg)". */
export function correctedLine(x: PersonWeight, owner: string): string | null {
  return x.correctedBy === '' ? `Corrected by ${owner}${x.was !== undefined ? ` (was ${x.was} kg)` : ''}` : null;
}

function Weight({ api, owner, tick }: { api: PersonApi; owner: string; tick: number }) {
  const [w, setW] = useState<PersonWeightsResponse | null>(null);
  const [kg, setKg] = useState('');
  const [day, setDay] = useState(todayKey);
  const [error, setError] = useState<string | null>(null);
  const undo = useUndo();
  const load = useCallback(() => api.weights().then(setW, () => setW({ weights: [], latest: null })), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const run = (p: Promise<unknown>) =>
    void p.then(
      () => {
        setError(null);
        void load();
      },
      (err: Error) => setError(err.message),
    );
  const today = todayKey();
  return (
    <div className="mt-12">
      <form
        className="flex flex-wrap items-end gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(kg.replace(',', '.'));
          if (!kg.trim() || !Number.isFinite(v)) return;
          run(api.setWeight(day, v).then(() => (setKg(''), setDay(todayKey()))));
        }}
      >
        <label className="flex flex-col gap-4">
          <span className="text-small text-ink-2">Weight in kg</span>
          <input inputMode="decimal" className="min-h-44 w-112 rounded-btn border border-line bg-bg px-8 type-input" value={kg} onChange={(e) => setKg(e.target.value)} />
        </label>
        <label className="flex flex-col gap-4">
          <span className="text-small text-ink-2">Day</span>
          <input type="date" max={today} className="min-h-44 rounded-btn border border-line bg-bg px-8 type-input" value={day} onChange={(e) => setDay(e.target.value || today)} />
        </label>
        <Button type="submit" variant="primary" className="min-h-44">
          {day === today ? 'Log today' : `Log for ${dayLabel(day)}`}
        </Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      <ul className="mt-12 divide-y divide-line">
        {(w?.weights ?? []).slice(0, 30).map((x) => {
          const fixed = correctedLine(x, owner);
          return (
            <li key={x.day} className="flex items-center gap-8 py-4">
              <span className="min-w-0 flex-1">
                <span className="block">
                  {dayLabel(x.day)} · {x.kg} kg
                </span>
                {fixed ? <span className="block text-small text-ink-2">{fixed}</span> : null}
              </span>
              <button
                type="button"
                aria-label={`Delete the weight for ${dayLabel(x.day)}`}
                className="flex size-44 shrink-0 items-center justify-center text-ink-2"
                onClick={() => {
                  run(api.deleteWeight(x.day));
                  undo.show(`Deleted: ${x.kg} kg, ${dayLabel(x.day)}`, () => run(api.setWeight(x.day, x.kg)));
                }}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <UndoToast toast={undo.toast} close={undo.close} />
    </div>
  );
}
