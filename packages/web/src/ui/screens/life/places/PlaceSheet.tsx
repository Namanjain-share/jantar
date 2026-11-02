/**
 * The café sheet (v0.4 spec 5.6; v0.10 spec 0.10 A7.3), Add café and Edit:
 * Name, Area, Link (https only, with "Open link" beside it), Tried, Stars
 * (with Clear), Price (a level 1 to 4 in the Life currency's symbol, or
 * none), Would go again, "More ratings" (six sub-ratings, collapsed until
 * one is set), Tags and Notes. Add can still list dishes inline (a name and
 * stars, which may wait until it is tried); after that a dish has its own
 * sheet. Edit sends only the keys that changed: a cleared value is null,
 * the sub-ratings go per key, the tags as a whole list.
 *
 * Delete: a café with no visits closes the sheet and the list holds it
 * back under a 5 s Undo; one with visits asks first ("Delete Example Café
 * and its 3 visits?"), as a medicine or a bill does, and is then deleted.
 *
 * A link is an <a target="_blank" rel="noopener noreferrer"> only when it
 * is http(s) (gate LW2, shared/links.tsx); anything else stays text. No map
 * and no request to any maps service.
 */
import { CaretDownIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useId, useRef, useState, type FormEvent } from 'react';
import type { Dish, GoAgain, Place, PlaceBody, PlacePatch, PlaceRatings, PlaceRatingsPatch } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { IconButton } from '../../../kit/IconButton.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Segmented } from '../../accounts/Segmented.js';
import { SwitchRow } from '../../devices/parts.js';
import { linkOk, OpenLink } from '../shared/links.js';
import { NotSaved } from '../shared/states.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite } from '../today/parts.js';
import { RATING_KEYS, RATING_LABELS, priceLabel, tagsOn, visitsOn } from './model.js';
import { ClearRating, StarPicker } from './Stars.js';
import { TagPicker } from './TagPicker.js';

/** A café's link: https, 500 characters at most. */
const LINK_MAX = 500;

export interface PlaceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** null: a new place. */
  place: Place | null;
  /** The Life currency (the price level's symbol), null for none. */
  currency: string | null;
  /** Custom tags used on any café, offered as chips. */
  customTags?: readonly string[];
  onSaved: (id?: string) => void;
  /** Delete of a café with no visits: the list takes it out at once and sends the delete once its Undo goes. */
  onDelete: (place: Place) => void;
  /** A café with visits, deleted after the question. */
  onDeleted: () => void;
}

export function PlaceSheet({ open, onOpenChange, sheetKey, place, ...rest }: PlaceSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={place ? place.name : 'New café'}>
      <PlaceForm key={sheetKey} place={place} {...rest} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

interface DishRow {
  key: number;
  name: string;
  /** 0: not rated (not tried yet). */
  rating: number;
}

type PriceKey = '0' | '1' | '2' | '3' | '4';
type AgainKey = 'none' | GoAgain;

const AGAIN_SEGMENTS: { key: AgainKey; label: string; name?: string }[] = [
  { key: 'none', label: 'None', name: 'Not said' },
  { key: 'yes', label: 'Yes' },
  { key: 'maybe', label: 'Maybe' },
  { key: 'no', label: 'No' },
];

function PlaceForm({
  place,
  currency,
  customTags = [],
  onSaved,
  onDelete,
  onDeleted,
  onDone,
}: Omit<PlaceSheetProps, 'open' | 'onOpenChange' | 'sheetKey'> & { onDone: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const next = useRef(0);
  const [name, setName] = useState(place?.name ?? '');
  const [area, setArea] = useState(place?.area ?? '');
  const [link, setLink] = useState(place?.link ?? '');
  const [tried, setTried] = useState(place?.tried ?? false);
  const [stars, setStars] = useState<number | null>(place?.stars ?? null);
  const [price, setPrice] = useState<PriceKey>(String(place?.price ?? 0) as PriceKey);
  const [again, setAgain] = useState<AgainKey>(place?.again ?? 'none');
  const [ratings, setRatings] = useState<PlaceRatings>(place?.ratings ?? {});
  const [more, setMore] = useState(Object.keys(place?.ratings ?? {}).length > 0);
  const [tags, setTags] = useState<string[]>([...(place ? tagsOn(place) : [])]);
  const [dishes, setDishes] = useState<DishRow[]>([]);
  const [notes, setNotes] = useState(place?.notes ?? '');
  const [asking, setAsking] = useState(false);

  const named = dishes.filter((d) => d.name.trim());
  const badLink = link.trim() !== '' && !linkOk(link.trim(), LINK_MAX);
  const ok = name.trim().length > 0 && !badLink;
  const setDish = (key: number, patch: Partial<DishRow>) => setDishes((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const setRating = (k: keyof PlaceRatings, v: number | null) =>
    setRatings((r) => {
      const out = { ...r };
      if (v === null) delete out[k];
      else out[k] = v;
      return out;
    });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    const level = Number(price);
    if (!place) {
      const list: Dish[] = named.map((d) => ({ name: d.name.trim(), ...(d.rating ? { rating: d.rating } : {}) }));
      const body: PlaceBody = {
        name: name.trim(),
        tried,
        dishes: list,
        ...(area.trim() ? { area: area.trim() } : {}),
        ...(link.trim() ? { link: link.trim() } : {}),
        ...(notes.trim() ? { notes } : {}),
        ...(stars ? { stars } : {}),
        ...(Object.keys(ratings).length ? { ratings } : {}),
        ...(level ? { price: level } : {}),
        ...(again !== 'none' ? { again } : {}),
        ...(tags.length ? { tags } : {}),
      };
      const r = await w.run(JSON.stringify(body), (key) => api.placeCreate(body, key));
      if (!r.ok) return;
      onSaved(r.value.id);
    } else {
      const patch: PlacePatch = {};
      if (name.trim() !== place.name) patch.name = name.trim();
      if (area.trim() !== (place.area ?? '')) patch.area = area.trim() || null;
      if (link.trim() !== (place.link ?? '')) patch.link = link.trim() || null;
      if (notes !== (place.notes ?? '')) patch.notes = notes.trim() ? notes : null;
      if (tried !== place.tried) patch.tried = tried;
      if ((stars ?? undefined) !== place.stars) patch.stars = stars;
      if ((level || undefined) !== place.price) patch.price = level || null;
      if ((again === 'none' ? undefined : again) !== place.again) patch.again = again === 'none' ? null : again;
      const changed: PlaceRatingsPatch = {};
      for (const k of RATING_KEYS) if (ratings[k] !== place.ratings?.[k]) changed[k] = ratings[k] ?? null;
      if (Object.keys(changed).length) patch.ratings = changed;
      if (JSON.stringify(tags) !== JSON.stringify(tagsOn(place))) patch.tags = tags;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => api.placeUpdate(place.id, patch, key));
        if (!r.ok) return;
      }
      onSaved();
    }
    onDone();
  };

  const remove = async () => {
    if (!place) return;
    if (visitsOn(place) === 0) {
      onDelete(place);
      onDone();
      return;
    }
    const r = await w.run(`delete:${place.id}`, (key) => api.placeDelete(place.id, key));
    if (!r.ok) return;
    onDone();
    onDeleted();
  };

  const visits = place ? visitsOn(place) : 0;
  const priceSegments = (['0', '1', '2', '3', '4'] as const).map((k) =>
    k === '0' ? { key: k, label: 'None', name: 'No price' } : { key: k, label: priceLabel(Number(k), currency), name: `Price level ${k} of 4` },
  );

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
      <SwitchRow id={`${id}-tried`} checked={tried} onChange={setTried}>
        Tried it
      </SwitchRow>
      <Field label="Stars" id={`${id}-stars`} aside={<ClearRating value={stars} label="Clear the stars" onClear={() => setStars(null)} />}>
        <StarPicker label="Stars" value={stars} onChange={setStars} />
      </Field>
      <Field label="Price" id={`${id}-price`}>
        <Segmented<PriceKey> label="Price" fill value={price} onChange={setPrice} segments={priceSegments} />
      </Field>
      <Field label="Would go again" id={`${id}-again`}>
        <Segmented<AgainKey> label="Would go again" fill value={again} onChange={setAgain} segments={AGAIN_SEGMENTS} />
      </Field>
      <Button variant="text" className="-ml-8 mt-4" aria-expanded={more} onClick={() => setMore((m) => !m)}>
        <CaretDownIcon size={16} aria-hidden="true" className={clsx('transition-transform duration-120', more && 'rotate-180')} />
        More ratings
      </Button>
      {more ? (
        <div className="border-l border-line pl-12">
          {RATING_KEYS.map((k) => (
            <Field key={k} label={RATING_LABELS[k]} id={`${id}-r-${k}`} aside={<ClearRating value={ratings[k]} label={`Clear ${RATING_LABELS[k]}`} onClear={() => setRating(k, null)} />}>
              <StarPicker label={`${RATING_LABELS[k]} rating`} value={ratings[k] ?? null} onChange={(n) => setRating(k, n)} />
            </Field>
          ))}
        </div>
      ) : null}
      <TagPicker id={`${id}-tags`} value={tags} onChange={setTags} custom={customTags} />
      {!place ? (
        <Field label="Dishes" id={`${id}-dishes`}>
          <ul aria-labelledby={`${id}-dishes`} className="border-t border-line">
            {dishes.map((d) => (
              <li key={d.key} className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-line py-6">
                <input className={`${INPUT} flex-1 basis-160`} aria-label="Dish" value={d.name} maxLength={60} onChange={(e) => setDish(d.key, { name: e.target.value })} />
                <StarPicker label={`Rating for ${d.name || 'this dish'}`} value={d.rating || null} onChange={(n) => setDish(d.key, { rating: n })} />
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
          {named.some((d) => !d.rating) ? <p className="mt-4 type-small text-ink-2">A dish with no stars is one to try.</p> : null}
        </Field>
      ) : null}
      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} className={TEXTAREA} value={notes} maxLength={1000} rows={3} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {w.error ? <NotSaved error={w.error} /> : null}
      {asking && place ? (
        <div role="group" aria-label="Delete" className="mt-12 border-t border-line pt-12">
          <p className="type-small text-ink-2">{`Delete ${place.name} and its ${visits === 1 ? 'visit' : `${visits} visits`}?`}</p>
          <div className="mt-8 flex gap-8">
            <Button variant="primary" disabled={w.busy || offline} onClick={() => void remove()}>
              {w.busy ? <Spinner label="Deleting" /> : null}
              Delete
            </Button>
            <Button variant="text" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <SheetActions>
          <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
            {w.busy ? <Spinner label="Saving" /> : null}
            {place ? 'Save' : 'Add café'}
          </Button>
          {place ? (
            <Button variant="text" size="lg" disabled={w.busy || offline} onClick={() => (visits > 0 ? setAsking(true) : void remove())}>
              Delete
            </Button>
          ) : (
            <Button variant="text" size="lg" onClick={onDone}>
              Cancel
            </Button>
          )}
        </SheetActions>
      )}
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
