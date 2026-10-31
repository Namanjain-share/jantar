/**
 * Cafés (v0.4 spec 5.6): your own list of places and their dishes,
 * `[ All | Tried | Want to try ]`, always best first (the daemon sorts by
 * the highest dish rating). A row: the name, the area in mono, the best
 * dish with its stars, and a mono `want` tag when not tried yet. A tap
 * opens the place sheet; `id` (a link to one place) opens it on arrival.
 * The sheet's Delete takes the place off at once with a 5 s Undo here; the
 * delete is sent once the Undo goes. The title is the page's <h1> in every
 * state.
 */
import { PlusIcon } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { Place } from '@jantar/protocol';
import { routePath, type PlacesFilter } from '../../../../lib/router.js';
import { useDeps, useNavigate } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Tag } from '../../../kit/Tag.js';
import { Segmented } from '../../accounts/Segmented.js';
import { EMPTY, LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad } from '../shared/useLife.js';
import { AddButton, Loaded, Page, useHeldDeletes, useOffline, useSheet, useUndo, useWrite } from '../today/parts.js';
import { PlaceSheet } from './PlaceSheet.js';
import { Stars } from './Stars.js';

export interface PlacesProps {
  filter?: PlacesFilter | undefined;
  id?: string | undefined;
}

const FILTERS: { key: PlacesFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'tried', label: 'Tried' },
  { key: 'want', label: 'Want to try' },
];

const EMPTY_FOR: Record<PlacesFilter, string> = {
  all: EMPTY.places,
  tried: 'No cafés tried yet.',
  want: 'Nothing on the want to try list.',
};

/** The place's best dish: the highest rating, the first of those. */
export function bestDish(p: Place) {
  return p.dishes.reduce<Place['dishes'][number] | null>((best, d) => (!best || d.rating > best.rating ? d : best), null);
}

export function Places({ filter = 'all', id }: PlacesProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const load = useLifeLoad(`places:${filter}`, () => api.placesList(filter));
  const sheet = useSheet<Place>();
  const undo = useUndo();
  const held = useHeldDeletes(undo);
  const remove = useWrite();
  const opened = useRef<string | null>(null);
  const target = id ? load.data?.places.find((p) => p.id === id) : undefined;
  const places = held.visible(load.data?.places ?? [], (p) => p.id);
  const { show } = sheet;

  useEffect(() => {
    if (!target || opened.current === target.id) return;
    opened.current = target.id;
    show(target);
  }, [target, show]);

  const deletePlace = (p: Place) =>
    held.remove(p.id, `Deleted: ${p.name}`, async () => {
      const r = await remove.run(`delete:${p.id}`, (key) => api.placeDelete(p.id, key));
      if (r.ok) load.reload();
      return r.ok;
    });

  const addButton = (
    <Button disabled={offline} onClick={() => sheet.show(null)}>
      <PlusIcon size={16} aria-hidden="true" />
      Add café
    </Button>
  );

  return (
    <Page title="Cafés" aside={<AddButton label="Add café" disabled={offline} onClick={() => sheet.show(null)} />} undo={undo}>
      <div className="px-16 pb-12">
        <Segmented<PlacesFilter> label="Show" fill value={filter} onChange={(f) => navigate(routePath(f === 'all' ? { name: 'places' } : { name: 'places', filter: f }), { replace: true })} segments={FILTERS} />
      </div>
      {remove.error ? (
        <div className="px-16">
          <NotSaved error={remove.error} />
        </div>
      ) : null}
      <Loaded load={load}>
        {() =>
          places.length === 0 ? (
            <LifeEmpty action={addButton}>{EMPTY_FOR[filter]}</LifeEmpty>
          ) : (
            <ul aria-label="Cafés" className="border-t border-line">
              {places.map((p) => {
                const dish = bestDish(p);
                return (
                  <li key={p.id} className="border-b border-line">
                    <button type="button" onClick={() => sheet.show(p)} className="block w-full px-16 py-10 text-left transition-colors duration-120 ease-hover hover:bg-hover coarse:min-h-44">
                      <span className="flex items-baseline gap-8">
                        <span className="min-w-0 truncate type-row font-medium text-ink">{p.name}</span>
                        {p.area ? <span className="min-w-0 truncate type-mono text-ink-3">{p.area}</span> : null}
                        {!p.tried ? <Tag className="ml-auto">want</Tag> : null}
                      </span>
                      {dish ? (
                        <span className="mt-2 flex items-center gap-8 type-small text-ink-2">
                          <span className="min-w-0 truncate">{dish.name}</span>
                          <Stars rating={dish.rating} />
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loaded>
      <PlaceSheet open={sheet.open} onOpenChange={sheet.onOpenChange} sheetKey={sheet.key} place={sheet.item} onSaved={load.reload} onDelete={deletePlace} />
    </Page>
  );
}
