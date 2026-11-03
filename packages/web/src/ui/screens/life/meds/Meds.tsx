/**
 * Medicines (`/meds`, v0.4 spec 5.4): one GET per day (`medsGet`).
 *
 *   Medicines
 *   No device gets medicine pings. <why>          PushWarning
 *   ‹  Fri 30 Oct  ›  Today                       DayNav: › stops at today
 *   MORNING                                       the day's doses (DoseRow)
 *   NIGHT
 *   YOUR MEDICINES                                each medicine (MedRow)
 *   + Add medicine
 *   Times are in <zone>. Pings need your Mac awake; ...
 *
 * `?day=` steps back through past days (a missed dose is still tappable to
 * log); `?med=<id>` (a refill push) opens that medicine's sheet. The title
 * is the <h1> in every state; reloads follow the lifeTick and visibility.
 *
 * 0.11 (build plan 2.4): from a pane of 640 the day's doses and Your
 * medicines are two cards side by side, under the day switcher. Below 640,
 * 0.10's list.
 */
import { PlusIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { MedicineView, MedsDayItem } from '@jantar/protocol';
import { useDeps, useNavigate, useNow } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Columns, useCardWidth } from '../../../kit/Columns.js';
import { Panel } from '../../../kit/Panel.js';
import { RailLabel } from '../../../kit/RailLabel.js';
import { DayNav } from '../shared/DayNav.js';
import { PushWarning } from '../shared/PushWarning.js';
import { EMPTY, LifeEmpty, LifeError, LifeLoading, NotSaved, OFFLINE_WRITE } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { DoseRow } from './DoseRow.js';
import { DoseSheet } from './DoseSheet.js';
import { MedRow } from './MedRow.js';
import { MedSheet } from './MedSheet.js';
import { NOTHING_DUE, NO_MEDS_TODAY, PERIOD_LABEL, isDue, lifeNow, useMedWrite, useOffline, zoneNote } from './data.js';

export interface MedsProps {
  day?: string | undefined;
  med?: string | undefined;
}

export function Meds({ day, med }: MedsProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const { status } = useLifeStatus();
  const tz = status?.timezone ?? null;
  const now = lifeNow(useNow(30_000), tz);
  const offline = useOffline();
  const write = useMedWrite();
  const load = useLifeLoad(`meds:${day ?? ''}`, () => api.medsGet(day));
  const [dose, setDose] = useState<MedsDayItem | null>(null);
  // 0.11 (c26): the row the dose popover opens beside.
  const doseAt = useRef<HTMLElement | null>(null);
  const [sheet, setSheet] = useState<{ open: boolean; med: MedicineView | null; n: number }>({ open: false, med: null, n: 0 });
  const openSheet = (m: MedicineView | null) => setSheet((s) => ({ open: true, med: m, n: s.n + 1 }));

  // A refill push opens its medicine once the list has it (once per ?med=).
  const shownFor = useRef<string | null>(null);
  // Cards from a pane of 640 (0.11), the 0.10 list below it: decided by the page's measured width.
  const box = useRef<HTMLDivElement>(null);
  const cards = useCardWidth(box);
  const meds = load.data?.medicines;
  useEffect(() => {
    if (!med || !meds || shownFor.current === med) return;
    const m = meds.find((x) => x.id === med);
    if (!m) return;
    shownFor.current = med;
    openSheet(m);
  }, [med, meds]);

  const data = load.data;
  const today = data?.day.today ?? status?.today ?? now.day;
  const shown = data?.day.day ?? day ?? today;
  const onDay = (d: string) => navigate(d >= today ? '/meds' : `/meds?day=${d}`, { replace: true });

  const log = async (item: MedsDayItem, s: 'taken' | 'skipped') => {
    const r = await write.run(`${item.medId}@${shown}@${item.slot}:${s}`, (key) => api.doseLog(item.medId, { day: shown, slot: item.slot, status: s }, key));
    if (r.ok) load.reload();
  };

  let body;
  if (!data) {
    body = load.error ? <LifeError error={load.error} offline={offline} onRetry={load.reload} /> : <LifeLoading />;
  } else if (!data.medicines.length) {
    body = (
      <>
        {load.error ? <LifeError error={load.error} offline={offline} onRetry={load.reload} /> : null}
        <LifeEmpty
          action={
            <Button disabled={offline} onClick={() => openSheet(null)}>
              <PlusIcon size={14} aria-hidden="true" />
              Add medicine
            </Button>
          }
        >
          {EMPTY.medicines}
        </LifeEmpty>
      </>
    );
  } else {
    const groups = data.day.groups;
    const doses = groups.length ? (
      groups.map((g) => (
        <section key={g.period} aria-label={PERIOD_LABEL[g.period]}>
          <RailLabel ground={cards ? 'raised' : 'bg'} sticky={!cards}>
            {PERIOD_LABEL[g.period]}
          </RailLabel>
          <ul>
            {g.items.map((item) => (
              <DoseRow
                key={`${item.medId}@${item.slot}`}
                item={item}
                due={shown === today && isDue(item, shown, now)}
                tz={tz}
                disabled={offline || write.busy}
                onOpen={(el) => {
                  doseAt.current = el;
                  setDose(item);
                }}
                onLog={(s) => void log(item, s)}
              />
            ))}
          </ul>
        </section>
      ))
    ) : (
      <p className="border-b border-line px-16 py-12 type-small text-ink-2">{shown === today ? NO_MEDS_TODAY : NOTHING_DUE}</p>
    );
    const notes = (
      <>
        {write.error ? (
          <div className="px-16">
            <NotSaved error={write.error} />
          </div>
        ) : null}
        {offline ? <p className="px-16 py-8 type-mono text-ink-3">{OFFLINE_WRITE}</p> : null}
      </>
    );
    const yours = (
      <Panel label="Your medicines" count={data.medicines.length} card={cards} {...(cards ? {} : { className: 'mt-16' })}>
        <ul>
          {data.medicines.map((m) => (
            <MedRow key={m.id} med={m} onOpen={() => openSheet(m)} />
          ))}
        </ul>
        <button
          type="button"
          disabled={offline}
          onClick={() => openSheet(null)}
          className="flex min-h-44 w-full items-center gap-12 border-b border-line px-16 text-left type-row text-ink-2 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink disabled:text-ink-3"
        >
          <PlusIcon size={16} aria-hidden="true" />
          Add medicine
        </button>
      </Panel>
    );
    body = (
      <>
        {load.error ? <LifeError error={load.error} offline={offline} onRetry={load.reload} /> : null}
        <div className="px-12">
          <DayNav day={shown} today={today} onDay={onDay} />
        </div>
        {cards ? (
          // 0.11: the day's doses beside your medicines.
          <>
            {notes}
            <Columns min={340} className="px-16 pt-4">
              <Panel label="Doses" card>
                {doses}
              </Panel>
              {yours}
            </Columns>
          </>
        ) : (
          <>
            {doses}
            {notes}
            {yours}
          </>
        )}
      </>
    );
  }

  return (
    <div className="pb-48 animate-enter">
      <header className="flex min-h-44 items-center gap-12 px-16 pb-8 pt-16 desk:pt-24">
        <h1 data-display className="min-w-0 flex-1 truncate type-display text-ink">
          Medicines
        </h1>
      </header>
      <PushWarning status={status} />
      <div ref={box}>{body}</div>
      {tz && data ? <p className="px-16 pt-16 type-small text-ink-3">{zoneNote(tz)}</p> : null}

      {dose ? (
        <DoseSheet
          medId={dose.medId}
          slot={dose.slot}
          day={shown}
          anchor={doseAt}
          onClose={() => {
            setDose(null);
            load.reload();
          }}
        />
      ) : null}
      <MedSheet
        key={sheet.n}
        open={sheet.open}
        med={sheet.med}
        today={today}
        onClose={() => setSheet((s) => ({ ...s, open: false }))}
        onSaved={load.reload}
      />
    </div>
  );
}
