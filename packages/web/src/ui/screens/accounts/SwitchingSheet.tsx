/**
 * 0.14.0 Switching rules: the owner's sheet over the legacy ccw tool's
 * switch.json, opened from the Accounts screen (in its chunk, never the main
 * load). It reads the rules as the file holds them (GET
 * /v1/accounts/switching) and saves what changed with one PATCH:
 *
 *   per account   named as the Accounts screen names it (its number, then
 *                 its alias or masked email). Hold (ccw never moves
 *                 sessions onto it; without a weekly cap never off it
 *                 either, with one its sessions leave once it passes the
 *                 cap) and Weekly cap: off, or a cap for each day of the
 *                 account's week and for its last hour, as 44 px steppers,
 *                 the day in effect now marked ("Day 4 · now"), with a
 *                 preset that fills in the usual week (50, 50, 50, 50, 75,
 *                 85, 95, then 100)
 *   for all       the 5-hour limit, the weekly limit, and how many minutes
 *                 before full a session leaves
 *
 * Save sends only the keys that changed (a ramp turned off as null), then
 * says "Saved. ccw uses it within a minute." and asks for the plan again. A
 * refusal (a switch.json that won't parse: 409) is shown as the Mac said
 * it; offline, Save is off, and so is it while a save runs. 0.14.0: what
 * Save did is said in the actions row itself (role status, or alert), which
 * a form sheet pins at its foot, so it is in view at every size; the row's
 * height is kept clear of the scroller's foot (--sheet-actions-h, kit.css)
 * so Tab never parks a field under it. The sheet asks "Discard what you
 * changed?" before a scrim tap, Esc or a swipe throws away an edit, however
 * it was made (Sheet's `dirty`), at every size: on a phone's bottom sheet
 * too (Sheet's `discardQuestion`). The paths
 * are words, as Work's are (screens/work/client.ts), so no schema comes with
 * them.
 */
import { CheckIcon, MinusIcon, PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { SWITCH_RULES, rampSlot, type Account, type SwitchRules, type SwitchRulesPatch, type WeeklyRamp } from '@jantar/protocol';
import { errorText } from '../../../lib/api.js';
import { accountId, accountName } from '../../../lib/format.js';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { useApp, useDeps, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { InlineError, PropRow, SwitchRow } from '../devices/parts.js';
import { reloadPlan } from './hooks.js';

/** GET and PATCH /v1/accounts/switching (protocol ROUTES.getSwitchRules and patchSwitchRules). */
export const SWITCHING_PATHS = {
  read: { method: 'GET', path: '/v1/accounts/switching' },
  save: { method: 'PATCH', path: '/v1/accounts/switching' },
} as const;

export const SAVED_TEXT = 'Saved. ccw uses it within a minute.';
export const OFFLINE_TEXT = 'Offline: saving needs your Mac.';
/** 0.14.0: what the sheet asks before a scrim tap, Esc or a swipe throws an edit away, at every size. */
export const DISCARD_TEXT = 'Discard what you changed?';
/** What the preset button says; it fills SWITCH_RULES.preset in. */
export const PRESET_TEXT = 'Fill the usual week';

const DAY_LABELS = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];

/** 0.14.0: what Hold means, under a held account's switch: it depends on whether the account has a weekly cap. */
export const HOLD_TEXT = 'Hold: ccw never moves sessions onto it';
export const HOLD_NO_CAP_TEXT = 'Without a weekly cap, ccw never moves its sessions off it either.';
export const HOLD_CAP_TEXT = 'With a weekly cap, its sessions leave once it passes the cap.';
/** 0.14.0: a ramp on an account with no weekly reading (no reset to count its days from). */
export const NO_READING_TEXT = 'No weekly reading yet: until there is one, its cap is the weekly limit.';

/** 0.14.0: the stepper of a ramp in effect now (0 to 6 a day, 7 the last hour), or null with no weekly reading. */
export function nowIndex(account: Pick<Account, 'windows'> | undefined, now: number): number | null {
  const reset = account?.windows.find((w) => w.kind === 'seven_day')?.resetsAt;
  const at = reset ? Date.parse(reset) : Number.NaN;
  const slot = rampSlot(Number.isFinite(at) ? at : null, now);
  return slot === null ? null : slot === 'lastHour' ? SWITCH_RULES.rampDays : slot - 1;
}

const sameRamp = (a: WeeklyRamp | undefined, b: WeeklyRamp | undefined) =>
  a === b || (!!a && !!b && a.lastHour === b.lastHour && a.days.length === b.days.length && a.days.every((d, i) => d === b.days[i]));

/** What changed between the rules as saved and the form: only those keys, a ramp turned off as null. Null when nothing did. */
export function patchOf(from: SwitchRules, to: SwitchRules): SwitchRulesPatch | null {
  const p: SwitchRulesPatch = {};
  const hold = [...to.hold].sort((a, b) => a - b);
  const was = [...from.hold].sort((a, b) => a - b);
  if (hold.length !== was.length || hold.some((n, i) => n !== was[i])) p.hold = hold;
  if (to.ceiling !== from.ceiling) p.ceiling = to.ceiling;
  if (to.weeklyCeiling !== from.weeklyCeiling) p.weeklyCeiling = to.weeklyCeiling;
  if (to.leadMin !== from.leadMin) p.leadMin = to.leadMin;
  const ramp: Record<string, WeeklyRamp | null> = {};
  for (const k of new Set([...Object.keys(from.weeklyRamp), ...Object.keys(to.weeklyRamp)])) {
    const a = from.weeklyRamp[k];
    const b = to.weeklyRamp[k];
    if (!sameRamp(a, b)) ramp[k] = b ? { days: [...b.days], lastHour: b.lastHour } : null;
  }
  if (Object.keys(ramp).length) p.weeklyRamp = ramp;
  return Object.keys(p).length ? p : null;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

/**
 * A number between − and + (44 px each, the field too), typed too: the field
 * takes digits and settles within min..max when it loses focus or on Return.
 */
function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit,
  describedBy,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  unit?: string;
  describedBy?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n)) onChange(clamp(n, min, max));
    setDraft(null);
  };
  const by = (d: number) => {
    setDraft(null);
    // From a value outside the range (a hand edit in the file), the first tap brings it inside.
    onChange(clamp(d > 0 ? Math.floor(value / step) * step + step : Math.ceil(value / step) * step - step, min, max));
  };
  // One joined box, 134 px: two 44 px buttons and a 44 px field, so two fit side by side on a 320 px phone.
  const btn =
    'inline-flex size-44 flex-none items-center justify-center text-ink-2 transition duration-120 ease-hover ' +
    'hover:not-disabled:bg-hover hover:not-disabled:text-ink disabled:cursor-default disabled:opacity-40';
  return (
    <span className="inline-flex flex-none items-center gap-8">
      <span className="inline-flex flex-none overflow-hidden rounded-btn border border-line-strong bg-bg">
        <button type="button" aria-label={`Lower ${label}`} className={btn} disabled={value <= min} onClick={() => by(-1)}>
          <MinusIcon size={16} aria-hidden="true" />
        </button>
        <input
          aria-label={label}
          aria-describedby={describedBy}
          inputMode="numeric"
          autoComplete="off"
          className="h-44 w-44 min-w-0 border-x border-line-strong bg-bg text-center type-input text-ink outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
          value={draft ?? String(value)}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 3))}
          onBlur={commit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" aria-label={`Raise ${label}`} className={btn} disabled={value >= max} onClick={() => by(1)}>
          <PlusIcon size={16} aria-hidden="true" />
        </button>
      </span>
      {unit ? (
        <span aria-hidden="true" className="type-small text-ink-2">
          {unit}
        </span>
      ) : null}
    </span>
  );
}

type Load = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; saved: SwitchRules };

export function SwitchingSheet({ open, onOpenChange, generation }: { open: boolean; onOpenChange: (open: boolean) => void; generation: number }) {
  // 0.14.0: changed and not saved, as the form knows it (a − or + tap fires no input event for the sheet to see).
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!open) setDirty(false);
  }, [open]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Switching rules" dirty={dirty} discardQuestion={DISCARD_TEXT}>
      {open ? <SwitchingForm key={generation} onDone={() => onOpenChange(false)} onDirty={setDirty} /> : null}
    </Sheet>
  );
}

function SwitchingForm({ onDone, onDirty }: { onDone: () => void; onDirty: (dirty: boolean) => void }) {
  const { api, store } = useDeps();
  // The Mac's own accounts (state.accounts: a paired server's are its own, and ccw runs on the Mac).
  const mine = useApp((s) => s.state.accounts);
  const offline = useApp((s) => s.conn.status === 'offline');
  const now = useNow(30_000);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [draft, setDraft] = useState<SwitchRules | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const kept = useRef<{ sig: string; key: string } | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  const id = useId();
  const ready = load.state === 'ready' && draft !== null;
  const dirty = load.state === 'ready' && draft !== null && patchOf(load.saved, draft) !== null;

  // A layout effect: the sheet knows before the next key or tap (Esc right after a + tap), not a task later.
  useLayoutEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useLayoutEffect(() => () => onDirty(false), [onDirty]);

  // 0.14.0: the pinned actions row's height, kept clear at the scroller's foot (kit.css scroll-padding-bottom).
  useEffect(() => {
    const row = actions.current;
    const popup = row?.closest<HTMLElement>('.sheet-popup');
    if (!ready || !row || !popup) return;
    const measure = () => popup.style.setProperty('--sheet-actions-h', `${Math.ceil(row.getBoundingClientRect().height)}px`);
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(row);
    return () => {
      ro?.disconnect();
      popup.style.removeProperty('--sheet-actions-h');
    };
  }, [ready]);

  useEffect(() => {
    let alive = true;
    setLoad({ state: 'loading' });
    api.request<SwitchRules>(SWITCHING_PATHS.read).then(
      (rules) => {
        if (!alive) return;
        setLoad({ state: 'ready', saved: rules });
        setDraft(rules);
      },
      (e: unknown) => alive && setLoad({ state: 'failed', error: errorText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  // The Mac's accounts, and any the rules name that it has no reading for.
  const accounts = useMemo(() => {
    const ids = new Set(Object.values(mine).map((a) => a.id));
    if (draft) {
      for (const n of draft.hold) ids.add(n);
      for (const k of Object.keys(draft.weeklyRamp)) ids.add(Number(k));
    }
    // Named as the Accounts screen names them: "02" then the alias, else the masked email; the accessible name is "02 team".
    return [...ids]
      .sort((a, b) => a - b)
      .map((n) => {
        const account = Object.values(mine).find((a) => a.id === n);
        return { id: n, account, tag: accountId(n), alias: account ? (account.alias ?? account.emailMasked) : '', name: accountName(n, account) };
      });
  }, [mine, draft]);

  if (load.state === 'loading' || (load.state === 'ready' && !draft)) return <Spinner label="Reading the rules" className="my-16" />;
  if (load.state === 'failed') {
    return (
      <div className="pb-8">
        <InlineError>{load.error}</InlineError>
        <div className="sheet-actions mt-16 flex flex-wrap items-center gap-8">
          <Button variant="outline" size="lg" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
          <Button variant="text" size="lg" onClick={onDone}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const rules = draft as SwitchRules;
  const patch = patchOf(load.saved, rules);
  const edit = (next: SwitchRules) => {
    setDraft(next);
    setSaved(false);
    setError(null);
  };
  const setRamp = (n: number, ramp: WeeklyRamp | null) => {
    const weeklyRamp = { ...rules.weeklyRamp };
    if (ramp) weeklyRamp[String(n)] = ramp;
    else delete weeklyRamp[String(n)];
    edit({ ...rules, weeklyRamp });
  };

  const save = async () => {
    if (!patch || busy || offline) return;
    const sig = JSON.stringify(patch);
    if (!kept.current || kept.current.sig !== sig) kept.current = { sig, key: newIdempotencyKey() };
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.request<SwitchRules>(SWITCHING_PATHS.save, { body: patch, idempotencyKey: kept.current.key });
      kept.current = null;
      setLoad({ state: 'ready', saved: next });
      setDraft(next);
      setSaved(true);
      reloadPlan(api, store);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-label="Switching rules"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="max-w-560 type-small text-ink-2">ccw moves sessions between accounts by these rules. Save writes them into its switch.json on the Mac.</p>

      <h3 className="mt-16 type-rail text-ink-3">Limits</h3>
      <PropRow label="5-hour limit">
        <Stepper label="5-hour limit" unit="%" value={rules.ceiling} min={SWITCH_RULES.ceilingMin} max={SWITCH_RULES.ceilingMax} step={1} onChange={(n) => edit({ ...rules, ceiling: n })} />
      </PropRow>
      <PropRow label="Weekly limit">
        <Stepper
          label="Weekly limit"
          unit="%"
          value={rules.weeklyCeiling}
          min={SWITCH_RULES.ceilingMin}
          max={SWITCH_RULES.ceilingMax}
          step={1}
          onChange={(n) => edit({ ...rules, weeklyCeiling: n })}
        />
      </PropRow>
      <PropRow label="Leave early">
        <span className="type-small text-ink-2">Leave</span>
        <Stepper label="Minutes before full" value={rules.leadMin} min={SWITCH_RULES.leadMinMin} max={SWITCH_RULES.leadMinMax} step={1} onChange={(n) => edit({ ...rules, leadMin: n })} />
        <span className="type-small text-ink-2">min before full</span>
      </PropRow>

      <h3 className="mt-16 type-rail text-ink-3">Accounts</h3>
      {accounts.map((a) => {
        const held = rules.hold.includes(a.id);
        const ramp = rules.weeklyRamp[String(a.id)];
        const holdNote = `${id}-h${a.id}`;
        const today = ramp ? nowIndex(a.account, now) : null;
        return (
          <div key={a.id} role="group" aria-label={a.name} className="border-b border-line py-8">
            <p className="flex min-w-0 items-baseline gap-8">
              <span className="type-mono font-key text-ink">{a.tag}</span>
              {a.alias ? <span className="min-w-0 truncate type-row text-ink-2">{a.alias}</span> : null}
            </p>
            <SwitchRow
              checked={held}
              describedBy={held ? holdNote : undefined}
              onChange={(on) => edit({ ...rules, hold: on ? [...rules.hold, a.id] : rules.hold.filter((n) => n !== a.id) })}
            >
              {HOLD_TEXT}
            </SwitchRow>
            {held ? (
              <p id={holdNote} className="-mt-4 mb-4 max-w-560 type-small text-ink-3">
                {ramp ? HOLD_CAP_TEXT : HOLD_NO_CAP_TEXT}
              </p>
            ) : null}
            <SwitchRow checked={!!ramp} onChange={(on) => setRamp(a.id, on ? (load.saved.weeklyRamp[String(a.id)] ?? { days: [...SWITCH_RULES.preset.days], lastHour: SWITCH_RULES.preset.lastHour }) : null)}>
              Weekly cap by day
            </SwitchRow>
            {ramp ? (
              <div className="pb-8">
                <p className="max-w-560 type-small text-ink-3">Day 1 starts at the account's weekly reset. ccw keeps it under the day's cap, and under the last one in the hour before the next reset.</p>
                {today === null ? <p className="mt-4 max-w-560 type-small text-ink-3">{NO_READING_TEXT}</p> : null}
                <div className="mt-8 grid grid-cols-2 gap-x-12 gap-y-8">
                  {[...DAY_LABELS, 'Last hour'].map((label, i) => {
                    const value = i < 7 ? (ramp.days[i] as number) : ramp.lastHour;
                    const isNow = today === i;
                    const nowId = `${id}-n${a.id}`;
                    return (
                      <div key={label}>
                        <p aria-hidden="true" className={clsx('mb-4 type-small', isNow ? 'text-ink' : 'text-ink-3')}>
                          {label}
                          {isNow ? (
                            <span id={nowId} className="font-medium">
                              {' · now'}
                            </span>
                          ) : null}
                        </p>
                        <Stepper
                          {...(isNow ? { describedBy: nowId } : {})}
                          label={`${a.name} ${label.toLowerCase()}`}
                          value={value}
                          min={SWITCH_RULES.rampMin}
                          max={SWITCH_RULES.rampMax}
                          step={5}
                          onChange={(n) =>
                            setRamp(a.id, i < 7 ? { days: ramp.days.map((d, j) => (j === i ? n : d)), lastHour: ramp.lastHour } : { days: [...ramp.days], lastHour: n })
                          }
                        />
                      </div>
                    );
                  })}
                </div>
                <Button
                  variant="outline"
                  className="mt-12"
                  aria-label={`${PRESET_TEXT} for ${a.name}`}
                  onClick={() => setRamp(a.id, { days: [...SWITCH_RULES.preset.days], lastHour: SWITCH_RULES.preset.lastHour })}
                >
                  {PRESET_TEXT}
                </Button>
                <p className="mt-4 type-mono text-ink-3">
                  {SWITCH_RULES.preset.days.join(' ')} · last hour {SWITCH_RULES.preset.lastHour}
                </p>
              </div>
            ) : null}
          </div>
        );
      })}

      {/* 0.14.0: what Save did, in the row with Save (pinned at a form sheet's foot): always in view, and announced. */}
      <div ref={actions} data-switching-actions="" className="sheet-actions mt-16">
        <p role="status" className={clsx('flex items-center gap-6 type-small text-ink-2', saved && 'mb-8')}>
          {saved ? (
            <>
              <CheckIcon size={16} aria-hidden="true" className="flex-none text-ink" />
              {SAVED_TEXT}
            </>
          ) : null}
        </p>
        {error ? <InlineError className="mb-8">{error}</InlineError> : null}
        <div className="flex flex-wrap items-center gap-8">
          <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!patch || busy || offline} aria-busy={busy || undefined}>
            {busy ? <Spinner label="Saving" /> : null}
            Save
          </Button>
          <Button variant="text" size="lg" onClick={onDone}>
            {patch ? 'Cancel' : 'Close'}
          </Button>
        </div>
        {offline ? <p className="mt-8 type-mono text-ink-3">{OFFLINE_TEXT}</p> : null}
      </div>
    </form>
  );
}
