/**
 * 0.13.0 The Log sheet (design 6.2, W13): what happened with a client and
 * what happens next, in one save (`POST /v1/work/clients/:id/log`): if the
 * next step can't be saved, neither is the call.
 *
 *   Log with Riya Kapoor
 *   [Call][Meeting][Email][Message][Note]
 *   [ Out | In ]            Minutes [ 25 ]       call, meeting (minutes), e-mail, message (direction)
 *   [Went well][OK][Badly][No answer]            call and meeting; a second tap clears it
 *   Note [Wants a quote by Friday.     ]
 *   Deal [Site rebuild ▾]                        only with open deals
 *   NEXT STEP
 *   [Tomorrow][In 3 days][Next week][Pick]       then Time and Title: a follow-up with this client
 *
 * The note and the next step's title are drafts (lib/drafts.ts, per
 * client): a reload, a remount or a Mac that can't be reached keeps them
 * (W35: "Not saved. Kept on this phone until you close Jantar."), and a
 * save clears them. Editing an entry (`row`) changes its words and facts
 * only (PATCH /v1/work/log/:id; null clears); it has no next step.
 * A bottom sheet on a phone, a form sheet from 640 (kit/Sheet.tsx).
 */
import clsx from 'clsx';
import { useId, useState, type FormEvent } from 'react';
import type { WorkDealCard, WorkLogAddBody, WorkLogKind, WorkLogPatch, WorkLogRow } from '@jantar/protocol/work';
import { clearDraft, useDraft } from '../../../lib/drafts.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { Segmented } from '../accounts/Segmented.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite, type LifeClock } from '../life/today/parts.js';
import { workClient } from './client.js';
import { nextStepDays } from './clientModel.js';
import { Chips, SaveError } from './parts.js';

export interface LogStart {
  kind?: WorkLogKind;
  /** Edit this entry instead of logging a new one. */
  row?: WorkLogRow;
  /** Logged from a project's hub: the entry (and its next step) is that project's. */
  projectId?: string;
  dealId?: string;
}

export interface LogSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  client: { id: string; name: string };
  /** The open deals to log against one: its own, and its company's or its people's (named with their client). */
  deals: readonly WorkDealCard[];
  start: LogStart;
  now: LifeClock;
  onSaved: () => void;
}

export function LogSheet({ open, onOpenChange, sheetKey, client, deals, start, now, onSaved }: LogSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={start.row ? 'Edit log entry' : `Log with ${client.name}`}>
      {open ? <LogForm key={sheetKey} client={client} deals={deals} start={start} now={now} onDone={() => onOpenChange(false)} onSaved={onSaved} /> : null}
    </Sheet>
  );
}

const KINDS: { key: WorkLogKind; label: string }[] = [
  { key: 'call', label: 'Call' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'email', label: 'Email' },
  { key: 'message', label: 'Message' },
  { key: 'note', label: 'Note' },
];
type Outcome = NonNullable<WorkLogAddBody['outcome']>;
const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: 'good', label: 'Went well' },
  { key: 'neutral', label: 'OK' },
  { key: 'bad', label: 'Badly' },
  { key: 'no_answer', label: 'No answer' },
];

/** The drafts a client's Log sheet keeps. */
export const logDraftKeys = (clientId: string) => ({ body: `work:log:${clientId}`, next: `work:log:${clientId}:next` });

const CHIP = 'inline-flex h-32 items-center rounded-chip border px-12 type-small transition-colors duration-120 ease-hover coarse:h-44';

function LogForm({ client, deals, start, now, onDone, onSaved }: { client: { id: string; name: string }; deals: readonly WorkDealCard[]; start: LogStart; now: LifeClock; onDone: () => void; onSaved: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const row = start.row;
  const drafts = logDraftKeys(client.id);
  const [kind, setKind] = useState<WorkLogKind>((row?.kind as WorkLogKind | undefined) ?? start.kind ?? 'call');
  const [direction, setDirection] = useState<'out' | 'in'>(row?.direction ?? 'out');
  const [minutes, setMinutes] = useState(row?.minutes !== undefined ? String(row.minutes) : '');
  const [outcome, setOutcome] = useState<Outcome | null>(row?.outcome ?? null);
  // A new entry's words are a draft; an edit starts from the entry.
  const [draftBody, setDraftBody] = useDraft(drafts.body);
  const [editBody, setEditBody] = useState(row?.body ?? '');
  const body = row ? editBody : draftBody;
  const setBody = row ? setEditBody : setDraftBody;
  const [dealId, setDealId] = useState(row?.dealId ?? start.dealId ?? '');
  const days = nextStepDays(now.day);
  const [day, setDay] = useState('');
  const [picking, setPicking] = useState(false);
  const [time, setTime] = useState('');
  const [title, setTitle] = useDraft(drafts.next);

  const hasDirection = kind === 'call' || kind === 'email' || kind === 'message';
  const hasMinutes = kind === 'call' || kind === 'meeting';
  const hasOutcome = kind === 'call' || kind === 'meeting';
  const mins = minutes.trim() === '' ? undefined : Number(minutes);
  const minsOk = mins === undefined || (Number.isInteger(mins) && mins >= 0 && mins <= 600);
  const wantsNext = !row && (day !== '' || title.trim() !== '');
  const nextOk = !wantsNext || (day !== '' && title.trim() !== '');
  const ok = minsOk && nextOk && body.length <= 2000;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    if (row) {
      const patch: WorkLogPatch = {};
      if (kind !== row.kind) patch.kind = kind;
      const dir = hasDirection ? direction : undefined;
      if (dir !== row.direction) patch.direction = dir ?? null;
      const m = hasMinutes ? mins : undefined;
      if (m !== row.minutes) patch.minutes = m ?? null;
      const o = hasOutcome ? (outcome ?? undefined) : undefined;
      if (o !== row.outcome) patch.outcome = o ?? null;
      if (body.trim() !== (row.body ?? '')) patch.body = body.trim() ? body.trim() : null;
      if ((dealId || undefined) !== row.dealId) patch.dealId = dealId || null;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => workClient(api).logUpdate(row.id, patch, key));
        if (!r.ok) return;
      }
    } else {
      const next = wantsNext
        ? { title: title.trim(), due: { day, ...(time ? { time } : {}) }, ...(dealId ? { dealId } : {}), ...(start.projectId ? { projectId: start.projectId } : {}) }
        : undefined;
      const add: WorkLogAddBody = {
        kind,
        ...(hasDirection ? { direction } : {}),
        ...(hasMinutes && mins !== undefined ? { minutes: mins } : {}),
        ...(hasOutcome && outcome ? { outcome } : {}),
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(dealId ? { dealId } : {}),
        ...(start.projectId ? { projectId: start.projectId } : {}),
        ...(next ? { next } : {}),
      };
      const r = await w.run(JSON.stringify(add), (key) => workClient(api).logAdd(client.id, add, key));
      if (!r.ok) return;
      clearDraft(drafts.body);
      clearDraft(drafts.next);
    }
    onSaved();
    onDone();
  };

  const pickDay = (d: string) => {
    setPicking(false);
    setDay((cur) => (cur === d ? '' : d));
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={row ? 'Edit log entry' : `Log with ${client.name}`}>
      <Chips<WorkLogKind> label="What" chips={KINDS} value={kind} onChange={(k) => k && setKind(k)} />
      {hasDirection || hasMinutes ? (
        <div className="mt-8 flex flex-wrap items-end gap-12">
          {hasDirection ? (
            <Field label="Direction" className="min-w-0 flex-1">
              <Segmented<'out' | 'in'>
                label="Direction"
                fill
                value={direction}
                onChange={setDirection}
                segments={[
                  { key: 'out', label: 'Out' },
                  { key: 'in', label: 'In' },
                ]}
              />
            </Field>
          ) : null}
          {hasMinutes ? (
            <Field label="Minutes" htmlFor={`${id}-min`} className="w-96 flex-none">
              <input id={`${id}-min`} type="number" inputMode="numeric" min={0} max={600} className={INPUT} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </Field>
          ) : null}
        </div>
      ) : null}
      {hasOutcome ? (
        <Field label="How it went">
          <Chips<Outcome> label="How it went" chips={OUTCOMES.filter((o) => o.key !== 'no_answer' || kind === 'call')} value={outcome} onChange={setOutcome} clearable />
        </Field>
      ) : null}
      <Field label="Note" htmlFor={`${id}-body`}>
        <textarea id={`${id}-body`} className={TEXTAREA} value={body} maxLength={2000} rows={3} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {deals.length ? (
        <Field label="Deal" htmlFor={`${id}-deal`}>
          <select id={`${id}-deal`} className={INPUT} value={dealId} onChange={(e) => setDealId(e.target.value)}>
            <option value="">None</option>
            {deals.map((d) => (
              <option key={d.id} value={d.id}>
                {d.client.id === client.id ? d.title : `${d.title} · ${d.client.name}`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {row ? null : (
        <fieldset className="mt-8 min-w-0 border-t border-line pt-8">
          <legend className="type-rail text-ink-3">Next step</legend>
          <div role="group" aria-label="Next step day" className="mt-6 flex flex-wrap gap-8">
            {days.map((d) => (
              <button
                key={d.key}
                type="button"
                aria-pressed={day === d.day && !picking}
                onClick={() => pickDay(d.day)}
                className={clsx(CHIP, day === d.day && !picking ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:text-ink')}
              >
                {d.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={picking}
              onClick={() => setPicking((p) => !p)}
              className={clsx(CHIP, picking ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:text-ink')}
            >
              Pick
            </button>
          </div>
          {picking ? (
            <Field label="Day" htmlFor={`${id}-day`}>
              <input id={`${id}-day`} type="date" className={INPUT} min={now.day} value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-12">
            <Field label="Time" htmlFor={`${id}-time`} className="w-128 flex-none">
              <input id={`${id}-time`} type="time" className={INPUT} value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field label="Title" htmlFor={`${id}-title`} className="min-w-0 flex-1">
              <input id={`${id}-title`} className={INPUT} value={title} maxLength={200} autoComplete="off" placeholder="Send the quote" onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          {wantsNext && !nextOk ? <p className="type-small text-ink-2">{day ? 'Give the next step a title.' : 'Pick a day for the next step.'}</p> : null}
        </fieldset>
      )}
      {w.error ? <SaveError error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {row ? 'Save' : wantsNext ? 'Log and set next step' : 'Log it'}
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
