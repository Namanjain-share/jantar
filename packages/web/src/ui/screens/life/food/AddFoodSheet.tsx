/**
 * The add sheet (v0.4 spec 5.5): `[ Type | Saved | Ask Claude ]`, adding
 * to the day Food shows (Today: today).
 *
 * - Type: Name, kcal and "Save for one tap" (also keeps it under Saved).
 * - Saved: one tap adds it and shows "Added · Undo" for 5 s; ··· Forget
 *   drops it at once with its own 5 s Undo (no confirm).
 * - Ask Claude (only while LifeStatus.estimate.available; otherwise it says
 *   why): "2 rotis and dal" goes to one headless Claude run on the Mac. While
 *   it runs, "Asking Claude…" with Cancel (aborts the request). The answer
 *   comes back as editable rows to tick, nothing saved until "Add 2 items",
 *   which adds them as ordinary entries. A refusal (409, 502, 503) shows the
 *   daemon's sentence and "Type it instead", which opens Type with the text
 *   as the name. The call carries no Idempotency-Key (lib/api.ts), so the
 *   daemon caches nothing of the reply.
 *
 * The three panels stay mounted while the sheet is open, so switching tabs
 * keeps a typed name or Claude's rows.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FOOD_ESTIMATE_TEXT_MAX, type LifeStatus, type SavedFood } from '@jantar/protocol';
import { errorText } from '../../../../lib/api.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Segmented } from '../../accounts/Segmented.js';
import { Switch } from '../../devices/parts.js';
import { LifeError, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { Field, INPUT, OfflineLine, RowMenu, SheetActions, TEXTAREA, UndoLine, useHeldDeletes, useOffline, useUndo, useWrite } from '../today/parts.js';
import { kcalText, parseKcal } from './format.js';

export const NO_ESTIMATE = 'Ask Claude needs Claude Code on this Mac.';
export const ESTIMATE_CHECK = 'Estimates from Claude. Check them before adding.';

type AddTab = 'type' | 'saved' | 'ask';

export interface AddFoodSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  day: string;
  /** The day's saved foods; null: the sheet loads them itself (Today has none at hand). */
  saved: readonly SavedFood[] | null;
  status: LifeStatus | null;
  onAdded: () => void;
}

export function AddFoodSheet({ open, onOpenChange, sheetKey, day, saved, status, onAdded }: AddFoodSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add food">
      <AddFood key={sheetKey} day={day} saved={saved} status={status} onAdded={onAdded} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

function AddFood({ day, saved, status, onAdded, onDone }: { day: string; saved: readonly SavedFood[] | null; status: LifeStatus | null; onAdded: () => void; onDone: () => void }) {
  const [tab, setTab] = useState<AddTab>('type');
  const [name, setName] = useState('');
  return (
    <>
      <Segmented<AddTab>
        label="Add by"
        fill
        value={tab}
        onChange={setTab}
        segments={[
          { key: 'type', label: 'Type' },
          { key: 'saved', label: 'Saved' },
          { key: 'ask', label: 'Ask Claude' },
        ]}
      />
      <div className="mt-8" hidden={tab !== 'type'}>
        <TypeForm day={day} name={name} setName={setName} onAdded={onAdded} onDone={onDone} />
      </div>
      <div className="mt-8" hidden={tab !== 'saved'}>
        <SavedList day={day} saved={saved} onAdded={onAdded} />
      </div>
      <div className="mt-8" hidden={tab !== 'ask'}>
        <AskClaude
          day={day}
          status={status}
          onAdded={onAdded}
          onDone={onDone}
          onTypeInstead={(text) => {
            setName(text.trim().slice(0, 80));
            setTab('type');
          }}
        />
      </div>
    </>
  );
}

function TypeForm({ day, name, setName, onAdded, onDone }: { day: string; name: string; setName: (n: string) => void; onAdded: () => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const [kcal, setKcal] = useState('');
  const [keep, setKeep] = useState(false);
  const k = parseKcal(kcal);
  const ok = name.trim().length > 0 && k !== null;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || k === null || w.busy || offline) return;
    const body = { day, name: name.trim(), kcal: k, ...(keep ? { save: true } : {}) };
    const r = await w.run(JSON.stringify(body), (key) => api.foodAdd(body, key));
    if (!r.ok) return;
    onAdded();
    onDone();
  };

  return (
    <form onSubmit={(e) => void add(e)} aria-label="Type a food">
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="kcal" htmlFor={`${id}-kcal`}>
        <input id={`${id}-kcal`} className={INPUT} inputMode="numeric" autoComplete="off" value={kcal} aria-invalid={kcal !== '' && k === null} onChange={(e) => setKcal(e.target.value)} />
      </Field>
      <div className="flex min-h-44 items-center gap-12 py-4">
        <Switch id={`${id}-keep`} checked={keep} onChange={setKeep} />
        <label htmlFor={`${id}-keep`} className="type-small text-ink">
          Save for one tap
        </label>
      </div>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Adding" /> : null}
          Add
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}

function SavedList({ day, saved, onAdded }: { day: string; saved: readonly SavedFood[] | null; onAdded: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const fetched = useLifeLoad(saved ? null : `food:saved:${day}`, () => api.foodDay(day));
  const undo = useUndo();
  const held = useHeldDeletes(undo);
  const all = saved ?? fetched.data?.saved ?? null;
  const list = all && held.visible(all, (f) => f.id);
  const w = useWrite();
  const changed = () => {
    onAdded();
    if (!saved) fetched.reload();
  };

  const add = async (f: SavedFood) => {
    const r = await w.run(`saved:${f.id}`, (key) => api.foodAdd({ day, savedId: f.id }, key));
    if (!r.ok) return;
    changed();
    undo.show(`Added: ${f.name}`, () => void w.run(`undo:${r.value.id}`, (key) => api.foodDelete(r.value.id, key)).then((x) => x.ok && changed()));
  };
  const forget = (f: SavedFood) =>
    held.remove(f.id, `Forgotten: ${f.name}`, async () => {
      const r = await w.run(`forget:${f.id}`, (key) => api.foodSavedDelete(f.id, key));
      if (r.ok) changed();
      return r.ok;
    });

  if (list === null) {
    return fetched.error ? <NotSaved error={fetched.error} /> : <p className="py-8 type-small text-ink-2">Asking the Mac…</p>;
  }
  return (
    <div className="-mx-16">
      {list.length === 0 ? (
        <p className="px-16 py-8 type-small text-ink-2">No saved foods yet. Turn on "Save for one tap" when you type one.</p>
      ) : (
        <ul aria-label="Saved foods" className="border-t border-line">
          {list.map((f) => (
            <li key={f.id} className="flex items-center gap-4 border-b border-line pr-8">
              <button
                type="button"
                disabled={offline || w.busy}
                onClick={() => void add(f)}
                aria-label={`Add ${f.name}, ${kcalText(f.kcal)} kcal`}
                className="flex min-h-44 min-w-0 flex-1 items-center gap-8 px-16 text-left transition-colors duration-120 ease-hover hover:bg-hover disabled:text-ink-3"
              >
                <span className="min-w-0 truncate type-row text-ink">{f.name}</span>
                <span className="flex-none type-mono text-ink-3">· {kcalText(f.kcal)} kcal</span>
              </button>
              <RowMenu label={`Saved food ${f.name}`} disabled={offline || w.busy} groups={[{ items: [{ label: 'Forget', onSelect: () => forget(f) }] }]} />
            </li>
          ))}
        </ul>
      )}
      {w.error ? (
        <div className="px-16">
          <NotSaved error={w.error} />
        </div>
      ) : null}
      {offline ? <OfflineLine className="mt-8 px-16" /> : null}
      <UndoLine offer={undo.offer} onUndo={undo.take} ground="raised" />
    </div>
  );
}

interface EstimateRow {
  key: number;
  on: boolean;
  name: string;
  kcal: string;
}

type Ask = { phase: 'input' } | { phase: 'asking' } | { phase: 'result'; rows: EstimateRow[]; note?: string } | { phase: 'failed'; error: unknown };

function AskClaude({
  day,
  status,
  onAdded,
  onDone,
  onTypeInstead,
}: {
  day: string;
  status: LifeStatus | null;
  onAdded: () => void;
  onDone: () => void;
  onTypeInstead: (text: string) => void;
}) {
  const { api } = useDeps();
  const offline = useOffline();
  const id = useId();
  const w = useWrite();
  const [text, setText] = useState('');
  const [ask, setAsk] = useState<Ask>({ phase: 'input' });
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  // `status` is the screen's copy of the shared LifeStatus; when that fetch failed, say why rather than wait.
  const statusLoad = useLifeStatus();

  if (!status) {
    if (statusLoad.error) {
      return (
        <div className="-mx-16">
          <LifeError error={statusLoad.error} offline={offline} onRetry={statusLoad.reload} />
        </div>
      );
    }
    return <p className="py-8 type-small text-ink-2">Asking the Mac…</p>;
  }
  if (!status.estimate.available) return <p className="py-8 type-small text-ink-2">{status.estimate.reason ?? NO_ESTIMATE}</p>;

  const estimate = async (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || offline || ctrl.current) return;
    const c = new AbortController();
    ctrl.current = c;
    setAsk({ phase: 'asking' });
    try {
      // No Idempotency-Key: Ask Claude is a computation, not a write (spec 1.5, LP3).
      const r = await api.foodEstimate(t, { signal: c.signal });
      if (c.signal.aborted) return;
      setAsk({ phase: 'result', rows: r.items.map((it, i) => ({ key: i, on: true, name: it.name, kcal: String(it.kcal) })), ...(r.note ? { note: r.note } : {}) });
    } catch (err) {
      if (!c.signal.aborted) setAsk({ phase: 'failed', error: err });
    } finally {
      if (ctrl.current === c) ctrl.current = null;
    }
  };
  const cancel = () => {
    ctrl.current?.abort();
    ctrl.current = null;
    setAsk({ phase: 'input' });
  };

  if (ask.phase === 'asking') {
    return (
      <div role="status" className="flex min-h-44 items-center gap-12 py-8">
        <Spinner label="Asking Claude" />
        <span className="flex-1 type-small text-ink-2">Asking Claude…</span>
        <Button variant="text" onClick={cancel}>
          Cancel
        </Button>
      </div>
    );
  }

  if (ask.phase === 'failed') {
    return (
      <div className="py-8">
        <p role="alert" className="type-small text-ink-2">
          {errorText(ask.error)}
        </p>
        <SheetActions>
          <Button variant="primary" size="lg" className="flex-1" onClick={() => onTypeInstead(text)}>
            Type it instead
          </Button>
          <Button variant="text" size="lg" onClick={() => setAsk({ phase: 'input' })}>
            Back
          </Button>
        </SheetActions>
      </div>
    );
  }

  if (ask.phase === 'result') {
    const rows = ask.rows;
    const set = (key: number, patch: Partial<EstimateRow>) => setAsk({ ...ask, rows: rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
    const chosen = rows.filter((r) => r.on);
    const valid = chosen.every((r) => r.name.trim() && parseKcal(r.kcal) !== null);
    const addAll = async () => {
      if (!chosen.length || !valid || w.busy || offline) return;
      const added = new Set<number>();
      for (const r of chosen) {
        const body = { day, name: r.name.trim(), kcal: parseKcal(r.kcal) ?? 0 };
        const out = await w.run(JSON.stringify(body), (key) => api.foodAdd(body, key));
        if (!out.ok) {
          // The ones already added leave the list, so trying again adds only the rest.
          if (added.size) {
            setAsk({ ...ask, rows: rows.filter((x) => !added.has(x.key)) });
            onAdded();
          }
          return;
        }
        added.add(r.key);
      }
      onAdded();
      onDone();
    };
    return (
      <div className="py-4">
        {rows.length === 0 ? (
          <p className="type-small text-ink-2">Claude found no food or drink in that.</p>
        ) : (
          <ul aria-label="Claude's estimate" className="border-t border-line">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center gap-8 border-b border-line py-6">
                <label className="flex size-28 flex-none items-center justify-center coarse:size-44">
                  <input type="checkbox" className="size-16 accent-ink" aria-label={`Add ${r.name || 'this row'}`} checked={r.on} onChange={(e) => set(r.key, { on: e.target.checked })} />
                </label>
                <input className={INPUT} aria-label="Name" value={r.name} maxLength={80} onChange={(e) => set(r.key, { name: e.target.value })} />
                <div className="w-88 flex-none">
                  <input className={INPUT} aria-label="kcal" inputMode="numeric" value={r.kcal} aria-invalid={parseKcal(r.kcal) === null} onChange={(e) => set(r.key, { kcal: e.target.value })} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {ask.note ? <p className="mt-8 type-small text-ink-2">{ask.note}</p> : null}
        <p className="mt-8 type-small text-ink-3">{ESTIMATE_CHECK}</p>
        {w.error ? <NotSaved error={w.error} /> : null}
        <SheetActions>
          {rows.length ? (
            <Button variant="primary" size="lg" className="flex-1" disabled={!chosen.length || !valid || w.busy || offline} onClick={() => void addAll()}>
              {w.busy ? <Spinner label="Adding" /> : null}
              {chosen.length === 1 ? 'Add 1 item' : `Add ${chosen.length} items`}
            </Button>
          ) : (
            <Button variant="primary" size="lg" className="flex-1" onClick={() => onTypeInstead(text)}>
              Type it instead
            </Button>
          )}
          <Button variant="text" size="lg" onClick={() => setAsk({ phase: 'input' })}>
            Ask again
          </Button>
        </SheetActions>
        {offline ? <OfflineLine className="mt-8" /> : null}
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void estimate(e)} aria-label="Ask Claude">
      <Field label="What did you eat?" htmlFor={`${id}-meal`}>
        <textarea id={`${id}-meal`} className={TEXTAREA} rows={3} maxLength={FOOD_ESTIMATE_TEXT_MAX} placeholder="2 rotis and dal" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!text.trim() || offline}>
          Estimate
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
