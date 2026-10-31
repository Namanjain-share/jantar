/**
 * The place sheet (v0.4 spec 5.6): Name, Area, Link (https only, with
 * "Open link" beside it), Tried, Dishes (a name and 1 to 5 stars each;
 * they replace the stored ones wholesale) and Notes. Delete asks nothing:
 * it closes the sheet and the list holds it back under a 5 s Undo.
 *
 * A link is an <a target="_blank" rel="noopener noreferrer"> only when it
 * is http(s) (gate LW2); anything else stays text. No map and no request
 * to any maps service.
 */
import { ArrowSquareOutIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useId, useRef, useState, type FormEvent } from 'react';
import type { Dish, Place, PlaceBody, PlacePatch } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { IconButton } from '../../../kit/IconButton.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Switch } from '../../devices/parts.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite } from '../today/parts.js';
import { StarPicker } from './Stars.js';

/** `url` when it is an http(s) URL a link may open, else null (javascript:, data:, relative...). */
export function safeHref(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** What the daemon takes for a place's link: https, 500 characters at most. */
export function linkOk(url: string): boolean {
  if (url.length > 500) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** "Open link": a new tab with no opener and no referrer, or nothing for a link that is not http(s). */
export function OpenLink({ url, className }: { url: string | undefined; className?: string }) {
  const href = safeHref(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className ?? 'inline-flex items-center gap-4 type-small text-ink-2 underline underline-offset-2 hover:text-ink'}>
      Open link
      <ArrowSquareOutIcon size={12} aria-hidden="true" />
    </a>
  );
}

export interface PlaceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** null: a new place. */
  place: Place | null;
  onSaved: () => void;
  /** Delete: the list takes it out at once and sends the delete once its Undo goes. */
  onDelete: (place: Place) => void;
}

export function PlaceSheet({ open, onOpenChange, sheetKey, place, onSaved, onDelete }: PlaceSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={place ? place.name : 'New café'}>
      <PlaceForm key={sheetKey} place={place} onSaved={onSaved} onDelete={onDelete} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

interface DishRow {
  key: number;
  name: string;
  /** 0 until picked. */
  rating: number;
}

function PlaceForm({ place, onSaved, onDelete, onDone }: { place: Place | null; onSaved: () => void; onDelete: (place: Place) => void; onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const next = useRef(place?.dishes.length ?? 0);
  const [name, setName] = useState(place?.name ?? '');
  const [area, setArea] = useState(place?.area ?? '');
  const [link, setLink] = useState(place?.link ?? '');
  const [tried, setTried] = useState(place?.tried ?? false);
  const [dishes, setDishes] = useState<DishRow[]>(() => (place?.dishes ?? []).map((d, i) => ({ key: i, name: d.name, rating: d.rating })));
  const [notes, setNotes] = useState(place?.notes ?? '');

  const named = dishes.filter((d) => d.name.trim());
  const unrated = named.some((d) => d.rating < 1);
  const badLink = link.trim() !== '' && !linkOk(link.trim());
  const ok = name.trim().length > 0 && !unrated && !badLink;
  const setDish = (key: number, patch: Partial<DishRow>) => setDishes((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    const list: Dish[] = named.map((d) => ({ name: d.name.trim(), rating: d.rating }));
    if (!place) {
      const body: PlaceBody = {
        name: name.trim(),
        tried,
        dishes: list,
        ...(area.trim() ? { area: area.trim() } : {}),
        ...(link.trim() ? { link: link.trim() } : {}),
        ...(notes.trim() ? { notes } : {}),
      };
      const r = await w.run(JSON.stringify(body), (key) => api.placeCreate(body, key));
      if (!r.ok) return;
    } else {
      const patch: PlacePatch = {};
      if (name.trim() !== place.name) patch.name = name.trim();
      if (area.trim() !== (place.area ?? '')) patch.area = area.trim() || null;
      if (link.trim() !== (place.link ?? '')) patch.link = link.trim() || null;
      if (notes !== (place.notes ?? '')) patch.notes = notes.trim() ? notes : null;
      if (tried !== place.tried) patch.tried = tried;
      if (JSON.stringify(list) !== JSON.stringify(place.dishes)) patch.dishes = list;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => api.placeUpdate(place.id, patch, key));
        if (!r.ok) return;
      }
    }
    onSaved();
    onDone();
  };

  const remove = () => {
    if (!place) return;
    onDelete(place);
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={place ? 'Edit café' : 'New café'}>
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Area" htmlFor={`${id}-area`}>
        <input id={`${id}-area`} className={INPUT} value={area} maxLength={60} autoComplete="off" onChange={(e) => setArea(e.target.value)} />
      </Field>
      <Field label="Link" htmlFor={`${id}-link`} aside={badLink ? null : <OpenLink url={link.trim()} />}>
        <input
          id={`${id}-link`}
          className={INPUT}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://"
          value={link}
          maxLength={500}
          aria-invalid={badLink}
          onChange={(e) => setLink(e.target.value)}
        />
      </Field>
      {badLink ? <p className="type-small text-ink-2">Use a link that starts with https://</p> : null}
      <div className="flex min-h-44 items-center gap-12 py-8">
        <Switch id={`${id}-tried`} checked={tried} onChange={setTried} />
        <label htmlFor={`${id}-tried`} className="type-small text-ink">
          Tried it
        </label>
      </div>
      <Field label="Dishes" id={`${id}-dishes`}>
        <ul aria-labelledby={`${id}-dishes`} className="border-t border-line">
          {dishes.map((d) => (
            <li key={d.key} className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-line py-6">
              <input className={`${INPUT} flex-1 basis-160`} aria-label="Dish" value={d.name} maxLength={60} onChange={(e) => setDish(d.key, { name: e.target.value })} />
              <StarPicker label={`Rating for ${d.name || 'this dish'}`} value={d.rating} onChange={(n) => setDish(d.key, { rating: n })} />
              <IconButton aria-label={`Remove ${d.name || 'this dish'}`} onClick={() => setDishes((ds) => ds.filter((x) => x.key !== d.key))}>
                <XIcon size={16} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
        {dishes.length < 30 ? (
          <Button
            variant="text"
            className="mt-4"
            onClick={() => {
              next.current += 1;
              setDishes((ds) => [...ds, { key: next.current, name: '', rating: 0 }]);
            }}
          >
            <PlusIcon size={16} aria-hidden="true" />
            Add dish
          </Button>
        ) : null}
        {unrated ? <p className="mt-4 type-small text-ink-2">Give each dish 1 to 5 stars.</p> : null}
      </Field>
      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} className={TEXTAREA} value={notes} maxLength={1000} rows={3} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {place ? 'Save' : 'Add café'}
        </Button>
        {place ? (
          <Button variant="text" size="lg" disabled={w.busy || offline} onClick={remove}>
            Delete
          </Button>
        ) : (
          <Button variant="text" size="lg" onClick={onDone}>
            Cancel
          </Button>
        )}
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
