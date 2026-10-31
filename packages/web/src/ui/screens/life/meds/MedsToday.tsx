/**
 * Today's MEDICINES section (v0.4 spec 5.2), under the rail Today draws:
 * the day's doses in time order with Taken and Skip once their time has
 * come, and the logged ones folded into one --ink-3 line ("✓ 2 taken
 * today") that a tap opens. A row opens the dose sheet. `onChanged` runs
 * after every write, so Today reloads (the lifeTick would too, a moment
 * later).
 */
import { CheckIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import type { MedsDay, MedsDayItem } from '@jantar/protocol';
import { useDeps, useNow } from '../../../context.js';
import { NotSaved } from '../shared/states.js';
import { useLifeStatus } from '../shared/useLife.js';
import { DoseRow } from './DoseRow.js';
import { DoseSheet } from './DoseSheet.js';
import { NO_MEDS_TODAY, dayItems, isDue, lifeNow, loggedText, useMedWrite, useOffline } from './data.js';

export interface MedsTodayProps {
  data: MedsDay;
  onChanged(): void;
}

export function MedsToday({ data, onChanged }: MedsTodayProps) {
  const { api } = useDeps();
  const { status } = useLifeStatus();
  const tz = status?.timezone ?? null;
  const now = lifeNow(useNow(30_000), tz);
  const offline = useOffline();
  const write = useMedWrite();
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState<MedsDayItem | null>(null);

  const items = dayItems(data);
  if (!items.length) return <p className="px-16 py-10 type-small text-ink-2">{NO_MEDS_TODAY}</p>;
  const logged = items.filter((i) => i.status === 'taken' || i.status === 'skipped');
  const open = items.filter((i) => !logged.includes(i));

  const log = async (item: MedsDayItem, s: 'taken' | 'skipped') => {
    const r = await write.run(`${item.medId}@${data.day}@${item.slot}:${s}`, (key) => api.doseLog(item.medId, { day: data.day, slot: item.slot, status: s }, key));
    if (r.ok) onChanged();
  };
  const row = (item: MedsDayItem) => (
    <DoseRow
      key={`${item.medId}@${item.slot}`}
      item={item}
      due={isDue(item, data.day, now)}
      tz={tz}
      disabled={offline || write.busy}
      onOpen={() => setSheet(item)}
      onLog={(s) => void log(item, s)}
    />
  );

  return (
    <div>
      {open.length ? <ul aria-label="Doses still to log">{open.map(row)}</ul> : null}
      {logged.length ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="flex min-h-40 w-full items-center gap-8 border-b border-line px-16 text-left type-small text-ink-3 transition-colors duration-120 ease-hover hover:bg-hover coarse:min-h-44"
        >
          <CheckIcon size={14} weight="bold" aria-hidden="true" />
          {loggedText(logged)}
        </button>
      ) : null}
      {expanded && logged.length ? <ul aria-label="Logged doses">{logged.map(row)}</ul> : null}
      {write.error ? (
        <div className="px-16">
          <NotSaved error={write.error} />
        </div>
      ) : null}
      {sheet ? (
        <DoseSheet
          medId={sheet.medId}
          slot={sheet.slot}
          day={data.day}
          onClose={() => {
            setSheet(null);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
