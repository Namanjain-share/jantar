/**
 * The dose sheet (v0.4 spec 5.4): one dose time of one medicine on one day,
 * opened from a row or from a medicine push (Today's `?dose=`, whose day is
 * `parseDoseKey`'s: after midnight, last night's dose). It loads that day's
 * list itself, so a push can open it cold.
 *
 *   Testamol 500 mg
 *   08:00 · Fri 30 Oct · Not logged yet
 *   [            Taken            ]
 *   [ Skip ]
 *   Took it at [ 08:10 ] [ Save ]
 *   Undo                                  (once logged)
 *
 * Every button writes doseLog or doseUndo and closes; a failed write keeps
 * the sheet open with "Not saved." "Took it at…" is a time on that day in
 * the Life zone, never after now. Taken on a past day ("forgot to log last
 * night") records the dose's own time, as "Took it at…" offers, so it is
 * not marked late.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { DoseBody } from '@jantar/protocol';
import { useDeps, useNow } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { dayLabel } from '../shared/DayNav.js';
import { LifeError, LifeLoading, NotSaved, OFFLINE_WRITE } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { dayItems, hhmmIn, instantIn, lifeNow, medLabel, useMedWrite, useOffline } from './data.js';

export interface DoseSheetProps {
  medId: string;
  /** HH:MM */
  slot: string;
  day: string;
  onClose(): void;
}

/** How long the sheet takes to close (Sheet: 260 ms) before `onClose` unmounts it. */
export const DOSE_SHEET_CLOSE_MS = 260;
export const NOT_ON_LIST = "This dose is no longer on that day's list.";
export const TIME_NOT_YET = "That time hasn't come yet.";

const INPUT =
  'h-40 min-w-0 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:text-ink-3 coarse:h-44';

export function DoseSheet({ medId, slot, day, onClose }: DoseSheetProps) {
  const { api } = useDeps();
  const { status } = useLifeStatus();
  const tz = status?.timezone ?? null;
  const nowMs = useNow(30_000);
  const offline = useOffline();
  const write = useMedWrite();
  const load = useLifeLoad(`dose:${day}`, () => api.medsGet(day));
  const timeId = useId();
  const [open, setOpen] = useState(true);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closing.current) clearTimeout(closing.current);
    },
    [],
  );
  const close = () => {
    if (closing.current) return;
    setOpen(false);
    closing.current = setTimeout(onClose, DOSE_SHEET_CLOSE_MS);
  };

  const item = load.data ? dayItems(load.data.day).find((i) => i.medId === medId && i.slot === slot) : undefined;
  const now = lifeNow(nowMs, tz);
  const today = load.data?.day.today ?? now.day;
  const [took, setTook] = useState<string | null>(null);
  const tookAt = took ?? (day < today || slot <= now.hhmm ? slot : now.hhmm);
  const tookInstant = /^\d{2}:\d{2}$/.test(tookAt) ? instantIn(day, tookAt, tz) : null;
  const tookFuture = tookInstant !== null && tookInstant.getTime() > nowMs;
  const takenAt = day < today ? instantIn(day, slot, tz).toISOString() : undefined;
  const blocked = offline || write.busy;

  const log = async (s: DoseBody['status'], at?: string) => {
    const body: DoseBody = { day, slot, status: s, ...(at ? { at } : {}) };
    const r = await write.run(`log:${medId}@${day}@${slot}:${s}:${at ?? ''}`, (key) => api.doseLog(medId, body, key));
    if (r.ok) close();
  };
  const undo = async (doseId: string) => {
    const r = await write.run(`undo:${doseId}`, (key) => api.doseUndo(medId, doseId, key));
    if (r.ok) close();
  };

  let state = '';
  if (item?.status === 'taken') state = `Taken at ${item.at ? hhmmIn(item.at, tz) : slot}${item.late ? ', late' : ''}`;
  else if (item?.status === 'skipped') state = 'Skipped';
  else if (item?.status === 'missed') state = 'Not logged';
  else if (item) state = item.overdue ? 'Overdue' : 'Not logged yet';

  let body;
  if (!load.data && load.error) body = <LifeError error={load.error} offline={offline} onRetry={load.reload} />;
  else if (!load.data) body = <LifeLoading count={2} />;
  else if (!item) {
    body = (
      <div className="pb-16">
        <p className="type-small text-ink-2">{NOT_ON_LIST}</p>
        <Button className="mt-12" onClick={close}>
          Close
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="pb-16">
        {item.status !== 'taken' ? (
          <Button variant="primary" size="xl" className="w-full" disabled={blocked} onClick={() => void log('taken', takenAt)}>
            Taken
          </Button>
        ) : null}
        {item.status !== 'skipped' ? (
          <Button size="lg" className="mt-8 w-full" disabled={blocked} onClick={() => void log('skipped')}>
            Skip
          </Button>
        ) : null}
        <form
          className="mt-16 flex items-center gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (tookInstant && !tookFuture && !blocked) void log('taken', tookInstant.toISOString());
          }}
        >
          <label htmlFor={timeId} className="flex-none type-small text-ink-3">
            Took it at…
          </label>
          <input
            id={timeId}
            type="time"
            value={tookAt}
            {...(day >= today ? { max: now.hhmm } : {})}
            onChange={(e) => setTook(e.target.value)}
            aria-invalid={tookFuture || undefined}
            className={INPUT}
          />
          <Button type="submit" disabled={blocked || !tookInstant || tookFuture}>
            Save
          </Button>
        </form>
        {tookFuture ? <p className="mt-6 type-small text-ink-2">{TIME_NOT_YET}</p> : null}
        {item.doseId ? (
          <Button variant="text" className="mt-12" disabled={blocked} onClick={() => void undo(item.doseId as string)}>
            Undo
          </Button>
        ) : null}
        {write.error ? <NotSaved error={write.error} /> : null}
        {offline ? <p className="mt-8 type-mono text-ink-3">{OFFLINE_WRITE}</p> : null}
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(o) => (o ? undefined : close())} title={item ? medLabel(item) : 'Dose'}>
      <p className="mb-12 type-mono text-ink-3">
        {slot} · {dayLabel(day)}
        {state ? <span className="font-sans"> · {state}</span> : null}
      </p>
      {body}
    </Sheet>
  );
}
