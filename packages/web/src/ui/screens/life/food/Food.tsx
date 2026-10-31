/**
 * Food, calories and weight (v0.4 spec 5.5): one call, `GET /v1/food?day=`.
 *
 *   Food                                    +
 *   ‹  Thu 30 Oct  ›                          DayNav, › stops at today
 *   1,240 / 2,000 kcal         ▬▬▬▬▬▬───      "/ 2,000" opens the target sheet
 *   72.4 kg · -0.6 in 7 days · goal 70.0      opens the weight sheet ("Log weight" with none)
 *   08:40  Poha                     280       tap edits; ··· Delete (5 s Undo)
 *   [+ Add food]                              Type | Saved | Ask Claude
 *
 * Over the target the bar is full and "+240 over" is --ink-2, not ember.
 * The title is the page's <h1> in every state.
 */
import { ForkKnifeIcon, PlusIcon, ScalesIcon } from '@phosphor-icons/react';
import type { FoodDay, FoodEntry } from '@jantar/protocol';
import { routePath } from '../../../../lib/router.js';
import { useDeps, useNavigate } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { DayNav, dayLabel } from '../shared/DayNav.js';
import { EMPTY, LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { LineBar, Loaded, Page, RowMenu, timeOf, useHeldDeletes, useOffline, useSheet, useUndo, useWrite } from '../today/parts.js';
import { AddFoodSheet } from './AddFoodSheet.js';
import { EntrySheet } from './EntrySheet.js';
import { kcalText, weightLine } from './format.js';
import { TargetSheet } from './TargetSheet.js';
import { WeightSheet } from './WeightSheet.js';

export interface FoodProps {
  day?: string | undefined;
}

export function Food({ day }: FoodProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const load = useLifeLoad(`food:${day ?? 'today'}`, () => api.foodDay(day));
  const add = useSheet();
  const target = useSheet();
  const weight = useSheet();
  const edit = useSheet<FoodEntry>();
  const remove = useWrite();
  const undo = useUndo();
  const held = useHeldDeletes(undo);
  const d = load.data;
  const today = d?.today ?? status?.today;
  const shown = d?.day ?? day ?? today;

  // No confirm: the row goes at once, and the delete is sent once its Undo goes.
  const deleteEntry = (e: FoodEntry) =>
    held.remove(e.id, `Deleted: ${e.name}`, async () => {
      const r = await remove.run(`delete:${e.id}`, (key) => api.foodDelete(e.id, key));
      if (r.ok) load.reload();
      return r.ok;
    });

  return (
    // One add control, under the list: a header "+" too would say it twice, and would open nothing before the day loads.
    <Page title="Food" undo={undo}>
      {shown && today ? (
        <div className="px-8 pb-4">
          <DayNav day={shown} today={today} onDay={(x) => navigate(routePath(x === today ? { name: 'food' } : { name: 'food', day: x }), { replace: true })} />
        </div>
      ) : null}
      <Loaded load={load}>
        {(f) => {
          const entries = held.visible(f.entries, (e) => e.id);
          return (
            <>
              <Totals day={f} onTarget={() => target.show()} />
              <button
                type="button"
                onClick={() => weight.show()}
                className="flex min-h-44 w-full items-center gap-8 border-b border-line px-16 py-8 text-left transition-colors duration-120 ease-hover hover:bg-hover"
              >
                <ScalesIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
                {weightLine(f.weight) ? <span className="type-mono text-ink-2">{unbroken(weightLine(f.weight) as string)}</span> : <span className="type-small text-ink-2">Log weight</span>}
              </button>
              {remove.error ? (
                <div className="px-16">
                  <NotSaved error={remove.error} />
                </div>
              ) : null}
              {entries.length === 0 ? (
                <LifeEmpty>{f.day === f.today ? EMPTY.food : `Nothing logged on ${dayLabel(f.day)}.`}</LifeEmpty>
              ) : (
                <ul aria-label="Eaten">
                  {entries.map((e) => (
                    <li key={e.id} className="flex items-center gap-4 border-b border-line pr-8">
                      <button
                        type="button"
                        onClick={() => edit.show(e)}
                        className="flex min-h-44 min-w-0 flex-1 items-center gap-12 py-6 pl-16 text-left transition-colors duration-120 ease-hover hover:bg-hover"
                      >
                        <span className="w-40 flex-none type-mono text-ink-3">{timeOf(e.at, status?.timezone)}</span>
                        <span className="min-w-0 flex-1 truncate type-row text-ink">{e.name}</span>
                        <span className="flex-none type-mono text-ink">{kcalText(e.kcal)}</span>
                      </button>
                      <RowMenu label={`Actions for ${e.name}`} disabled={offline || remove.busy} groups={[{ items: [{ label: 'Delete', onSelect: () => deleteEntry(e) }] }]} />
                    </li>
                  ))}
                </ul>
              )}
              <div className="px-16 pt-12">
                <Button disabled={offline} onClick={() => add.show()}>
                  <PlusIcon size={16} aria-hidden="true" />
                  Add food
                </Button>
              </div>
              <AddFoodSheet open={add.open} onOpenChange={add.onOpenChange} sheetKey={add.key} day={f.day} saved={f.saved} status={status} onAdded={load.reload} />
              <TargetSheet open={target.open} onOpenChange={target.onOpenChange} sheetKey={target.key} target={f.target} onSaved={load.reload} />
              <WeightSheet open={weight.open} onOpenChange={weight.onOpenChange} sheetKey={weight.key} day={f.day} today={f.today} weight={f.weight} onSaved={load.reload} />
              <EntrySheet open={edit.open} onOpenChange={edit.onOpenChange} sheetKey={edit.key} entry={edit.item} onSaved={load.reload} />
            </>
          );
        }}
      </Loaded>
    </Page>
  );
}

/** The line breaks only between its parts ("goal 70.0" never splits): the spaces inside a part do not break. */
function unbroken(line: string): string {
  return line
    .split(' · ')
    .map((part) => part.replace(/ /g, '\u00a0'))
    .join(' · ');
}

/** "1,240 / 2,000 kcal" over a 2 px bar; the target opens its sheet; past it, "+240 over" in --ink-2. */
function Totals({ day, onTarget }: { day: FoodDay; onTarget: () => void }) {
  const over = day.kcal - day.target;
  return (
    <div className="border-b border-line px-16 pb-12 pt-4">
      <div className="flex min-h-32 items-center gap-6 type-mono">
        <ForkKnifeIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
        <span className="text-ink">{kcalText(day.kcal)}</span>
        <button
          type="button"
          onClick={onTarget}
          aria-label={`Daily target ${kcalText(day.target)} kcal. Change it`}
          className="h-32 rounded-btn px-4 text-ink-2 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink coarse:h-44"
        >
          / {kcalText(day.target)}
        </button>
        <span className="text-ink-2">kcal</span>
        {over > 0 ? <span className="ml-auto text-ink-2">+{kcalText(over)} over</span> : null}
      </div>
      <LineBar value={day.kcal} max={day.target} className="mt-6" />
    </div>
  );
}
