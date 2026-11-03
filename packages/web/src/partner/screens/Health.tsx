/**
 * v0.12 People: her Health (`/p/health`), a lazy screen: Sleep (P2: the
 * week, Going to sleep, Add a night, edit and delete any night; spec 3.12)
 * and Weight (P1). Food joins only with her module on. Nothing here colours
 * a short night or turns it into an alert.
 */
import type { PersonWeightsResponse, SleepNight, SleepWeek as Week } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Faces } from '../../people-shared/Faces.js';
import { SleepWeek } from '../../people-shared/SleepWeek.js';
import { shiftDay } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';
import type { HealthTab } from '../router.js';
import { Field, Sheet } from '../ui.js';

export default function Health({ api, tab, week, tick }: { api: PersonApi; tab: HealthTab; week: string | null; tick: number }) {
  return (
    <div>
      <h1 className="text-title font-semibold">Health</h1>
      <div role="tablist" className="mt-8 flex gap-8">
        {(['sleep', 'weight'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => navigate(`/p/health?tab=${t}`)} className={`min-h-44 px-12 ${tab === t ? 'font-medium text-ink underline' : 'text-ink-2'}`}>
            {t === 'sleep' ? 'Sleep' : 'Weight'}
          </button>
        ))}
      </div>
      {tab === 'sleep' ? <Sleep api={api} week={week} tick={tick} /> : <Weight api={api} tick={tick} />}
    </div>
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
          <Button variant="primary" size="lg" onClick={() => void api.sleepStart().then(load, (e: Error) => setError(e.message))}>
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
          <input type="datetime-local" className="min-h-44 rounded-btn border border-line bg-bg px-8" value={bed} onChange={(e) => setBed(e.target.value)} />
        </label>
        <label className="flex flex-col gap-4">
          <span className="text-small text-ink-2">Wake time (optional)</span>
          <input type="datetime-local" className="min-h-44 rounded-btn border border-line bg-bg px-8" value={wake} onChange={(e) => setWake(e.target.value)} />
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

function Weight({ api, tick }: { api: PersonApi; tick: number }) {
  const [w, setW] = useState<PersonWeightsResponse | null>(null);
  const [kg, setKg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.weights().then(setW, () => setW({ weights: [], latest: null })), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  return (
    <div className="mt-12">
      <form
        className="flex gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(kg);
          if (!Number.isFinite(v)) return;
          api.setWeight(todayKey(), v).then(
            () => {
              setKg('');
              setError(null);
              void load();
            },
            (err: Error) => setError(err.message),
          );
        }}
      >
        <input aria-label="Weight in kg" inputMode="decimal" className="min-h-44 w-112 rounded-btn border border-line bg-bg px-8" value={kg} onChange={(e) => setKg(e.target.value)} />
        <Button type="submit" variant="primary">
          Log today
        </Button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      <ul className="mt-12">
        {(w?.weights ?? []).slice(0, 30).map((x) => (
          <li key={x.day} className="flex justify-between py-4">
            <span>{x.day}</span>
            <span>{x.kg} kg</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
