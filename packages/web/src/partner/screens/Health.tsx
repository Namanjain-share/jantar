/** v0.12 People: her Health (`/p/health`, P1): weight (medicines join with their routes; food only with her module on). */
import type { PersonWeightsResponse } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';

const todayKey = () => new Date().toISOString().slice(0, 10);

export function Health({ api, tick }: { api: PersonApi; tick: number }) {
  const [w, setW] = useState<PersonWeightsResponse | null>(null);
  const [kg, setKg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.weights().then(setW, () => setW({ weights: [], latest: null })), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  return (
    <div>
      <h1 className="text-title font-semibold">Health</h1>
      <h2 className="mt-16 font-semibold">Weight</h2>
      <form
        className="mt-8 flex gap-8"
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
