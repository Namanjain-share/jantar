/**
 * One café (`/places?id=<id>`, v0.10 spec 0.10 A7.2; the ProjectScreen
 * pattern): its name, area and link, its stars, price and would go again,
 * Log visit, then only the sections that hold something: Ratings, Tags,
 * Dishes (a tap opens the dish sheet; + Dish adds one), Visits (the
 * newest first, a tap opens the visit sheet; Show all pages through the
 * older ones) and Notes. A café with nothing yet offers + Rating, + Dish
 * and + Tag. Edit opens the café sheet.
 *
 * Deletes go through the list's Undo (Places holds it, so it survives the
 * way back to the list): a visit leaves at once with a 5 s Undo here; a
 * café with no visits goes back to the list under its Undo; one with visits
 * asks first in its sheet.
 *
 * 0.12 (build plan 2.5): beside the list it has Close (and Esc) instead of
 * "< Cafés", and it takes its pane's width: from 640 the summary and Log
 * visit sit side by side and the ratings two across, from 900 three across
 * with Dishes beside Visits. A tap on a rating's stars sets it (OQ9), with
 * "Vibe 3 → 4 · Undo"; the value it has does nothing, and clearing one
 * stays in Edit.
 */
import { CaretLeftIcon, PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import type { Place, PlaceDetail, PlaceRatingKey, PlaceVisit } from '@jantar/protocol';
import { formatAmount } from '../../../../lib/money.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { PaneClose, usePaneClose } from '../../../kit/PaneClose.js';
import { Panel } from '../../../kit/Panel.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Tag } from '../../../kit/Tag.js';
import { Link } from '../../../shell/Link.js';
import { dayLabel } from '../shared/DayNav.js';
import { OpenLink } from '../shared/links.js';
import { LifeEmpty, LifeError, NotSaved } from '../shared/states.js';
import { useLifeLoad } from '../shared/useLife.js';
import { Loaded, Page, useOffline, useSheet, useWrite, type Undo, type useHeldDeletes } from '../today/parts.js';
import { DishSheet } from './DishSheet.js';
import { AGAIN_LABEL, RATING_KEYS, RATING_LABELS, priceLabel, tagLabel, tagsOn } from './model.js';
import { PlaceSheet } from './PlaceSheet.js';
import { RateStars, Stars } from './Stars.js';
import { VisitSheet } from './VisitSheet.js';
import { dialogOpen, useKey } from '../../../shell/keys.js';
import { useLayout } from '../../../shell/layout.js';
import { useLookingAt } from '../../../shell/lookingAt.js';

export interface PlaceScreenProps {
  id: string;
  /** Where "< Cafés" goes: the list as it was. */
  back: string;
  currency: string | null;
  /** Today in the Life zone. */
  today: string;
  undo: Undo;
  held: ReturnType<typeof useHeldDeletes>;
  customTags: readonly string[];
  /** A café with no visits deleted from its sheet: back to the list, which holds it under Undo. */
  onDelete: (place: Place) => void;
  /** A café with visits, deleted after the question. */
  onDeleted: () => void;
  /** 0.12: a rating was set or put back (the list's order may follow it). */
  onRated?: () => void;
}

const SECTION = 'px-16 py-10';

/** A section: a rail and rows over the list (0.10), a card beside it (0.12, as Today's). */
function Section({ title, aside, card, className, children }: { title: string; aside?: ReactNode; card: boolean; className?: string; children: ReactNode }) {
  return (
    <Panel label={title} aside={aside} card={card} {...(card && className ? { className } : {})}>
      {children}
    </Panel>
  );
}

/** Older visits fetched past the first page, for the page they follow (a reload starts again). */
interface Older {
  base: PlaceDetail;
  visits: PlaceVisit[];
  more: boolean;
}

/** Ratings set here and not in an answer yet, for the answer they were set on (null: put back to none). */
interface Rated {
  base: PlaceDetail;
  values: Partial<Record<PlaceRatingKey, number | null>>;
}

export function PlaceScreen({ id, back, currency, today, undo, held, customTags, onDelete, onDeleted, onRated }: PlaceScreenProps) {
  const { api } = useDeps();
  const offline = useOffline();
  const load = useLifeLoad(`place:${id}`, () => api.placeGet(id));
  const edit = useSheet<Place>();
  const dishSheet = useSheet<number>();
  const visitSheet = useSheet<PlaceVisit>();
  const remove = useWrite();
  const rate = useWrite();
  const [rated, setRated] = useState<Rated | null>(null);
  const close = usePaneClose();
  const [older, setOlder] = useState<Older | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const data = load.data;
  const place = data?.place ?? null;
  useLookingAt(place ? { kind: 'place', id: place.id, label: place.name } : null);
  const extra = older && older.base === data ? older : null;
  const visits = held.visible([...(data?.visits ?? []), ...(extra?.visits ?? [])], (v) => `visit:${v.id}`);
  const more = extra ? extra.more : (data?.more ?? false);

  const showOlder = async () => {
    const last = visits.at(-1);
    if (!data || !last || olderBusy) return;
    const base = data;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await api.placeGet(id, last.id);
      setOlder((cur) => ({ base, visits: [...(cur && cur.base === base ? cur.visits : []), ...page.visits], more: page.more }));
    } catch (e) {
      setOlderError(e);
    } finally {
      setOlderBusy(false);
    }
  };

  /** A rating as shown: one just set here, else the answer's. */
  const ratingOf = (k: PlaceRatingKey): number | undefined => {
    const set = rated && rated.base === data ? rated.values[k] : undefined;
    return set === undefined ? place?.ratings?.[k] : (set ?? undefined);
  };
  const keep = (base: PlaceDetail, k: PlaceRatingKey, v: number | null) =>
    setRated((cur) => ({ base, values: { ...(cur && cur.base === base ? cur.values : {}), [k]: v } }));
  /** A tap on a rating's stars (OQ9): sent at once, with an Undo that puts the old value back. */
  const setRating = async (k: PlaceRatingKey, n: number) => {
    const before = ratingOf(k);
    if (!data || before === n) return;
    const base = data;
    keep(base, k, n);
    const r = await rate.run(`rate:${k}:${n}`, (key) => api.placeUpdate(id, { ratings: { [k]: n } }, key));
    if (!r.ok) {
      keep(base, k, before ?? null);
      return;
    }
    const done = () => {
      load.reload();
      onRated?.();
    };
    undo.show(`${RATING_LABELS[k]} ${before ?? '–'} → ${n}`, () => {
      keep(base, k, before ?? null);
      void api.placeUpdate(id, { ratings: { [k]: before ?? null } }).then(done, done);
    });
    done();
  };

  /** 1-5 on the keyboard (c30): the café's own stars, at once, with an Undo that puts the old ones back. */
  const setStars = async (n: number) => {
    const before = place?.stars;
    if (!data || !place || before === n) return;
    const r = await rate.run(`stars:${n}`, (key) => api.placeUpdate(id, { stars: n }, key));
    if (!r.ok) return;
    load.reload();
    onRated?.();
    undo.show(`Stars ${before ?? '–'} → ${n}`, () => {
      void api.placeUpdate(id, { stars: before ?? null }).then(load.reload, load.reload);
    });
  };
  useKey(
    ['1', '2', '3', '4', '5', 'v'],
    (e) => {
      if (dialogOpen()) return;
      e.preventDefault();
      if (e.key === 'v') visitSheet.show(null);
      else void setStars(Number(e.key));
    },
    useLayout().keyboard && Boolean(place) && !offline,
  );

  const deleteVisit = (v: PlaceVisit) =>
    held.remove(`visit:${v.id}`, `Deleted: the visit of ${dayLabel(v.day)}`, async () => {
      const r = await remove.run(`delete:${v.id}`, (key) => api.placeVisitDelete(id, v.id, key));
      if (r.ok) load.reload();
      return r.ok;
    });

  const backLink = close ? (
    <div className="flex">
      <PaneClose onClick={close} className="ml-auto" />
    </div>
  ) : (
    <Link href={back} className="inline-flex h-32 items-center gap-4 rounded-btn px-8 type-small text-ink-2 hover:bg-hover hover:text-ink coarse:h-44">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Cafés
    </Link>
  );
  const aside = place ? (
    <Button size="sm" className="coarse:min-w-44" disabled={offline} onClick={() => edit.show(place)}>
      Edit
    </Button>
  ) : null;

  return (
    <Page title={place?.name ?? 'Café'} wrapTitle back={backLink} aside={aside} undo={undo} wide>
      <Loaded load={load}>
        {() => (!place ? <LifeEmpty>This café is gone.</LifeEmpty> : body())}
      </Loaded>
      {place ? (
        <>
          <PlaceSheet
            open={edit.open}
            onOpenChange={edit.onOpenChange}
            sheetKey={edit.key}
            place={edit.item}
            currency={currency}
            customTags={customTags}
            onSaved={load.reload}
            onDelete={onDelete}
            onDeleted={onDeleted}
          />
          <DishSheet open={dishSheet.open} onOpenChange={dishSheet.onOpenChange} sheetKey={dishSheet.key} place={place} index={dishSheet.item} currency={currency} undo={undo} onSaved={load.reload} />
          <VisitSheet
            open={visitSheet.open}
            onOpenChange={visitSheet.onOpenChange}
            sheetKey={visitSheet.key}
            place={place}
            visit={visitSheet.item}
            today={today}
            currency={currency}
            onSaved={load.reload}
            onDelete={deleteVisit}
          />
        </>
      ) : null}
    </Page>
  );

  function body(): ReactNode {
    if (!place) return null;
    const p = place;
    const rated = RATING_KEYS.filter((k) => ratingOf(k) !== undefined);
    // Beside the list (a pane of 800 or more) the sections are cards: Ratings, Tags and Notes across
    // the pane, Dishes beside Visits from 900.
    const card = close !== undefined;
    const tags = tagsOn(p);
    const count = p.visits?.count ?? visits.length;
    const both = p.dishes.length > 0 && (count > 0 || visits.length > 0);
    const avg = p.visits?.avgSpend ?? null;
    const head = [p.price ? priceLabel(p.price, currency) : null, p.again ? AGAIN_LABEL[p.again] : null].filter((s): s is string => s !== null);
    const prompts = [
      rated.length === 0 ? { label: 'Rating', run: () => edit.show(p) } : null,
      p.dishes.length === 0 ? { label: 'Dish', run: () => dishSheet.show(null) } : null,
      tags.length === 0 ? { label: 'Tag', run: () => edit.show(p) } : null,
    ].filter((x): x is { label: string; run: () => void } => x !== null);
    return (
      <>
        <div className="px-16 pb-12 @md:grid @md:grid-cols-2 @md:items-start @md:gap-x-24">
          <div>
            {p.area || p.link ? (
              <p className="flex flex-wrap items-baseline gap-x-8 type-small text-ink-2">
                {p.area ? <span className="type-mono">{p.area}</span> : null}
                <OpenLink url={p.link} />
              </p>
            ) : null}
            {p.stars || head.length || !p.tried ? (
              <p className="mt-6 flex flex-wrap items-center gap-8 type-small text-ink-2">
                {p.stars ? <Stars rating={p.stars} /> : null}
                {head.length ? <span className="type-mono">{head.join(' · ')}</span> : null}
                {!p.tried ? <Tag>want</Tag> : null}
              </p>
            ) : null}
          </div>
          <div>
            <Button variant="primary" size="lg" className="mt-12 w-full @md:mt-0" disabled={offline} onClick={() => visitSheet.show(null)}>
              Log visit
            </Button>
            {prompts.length ? (
              <div className="mt-8 flex flex-wrap gap-8">
                {prompts.map((x) => (
                  <Button key={x.label} variant="text" className="-ml-8" disabled={offline} onClick={x.run}>
                    <PlusIcon size={16} aria-hidden="true" />
                    {x.label}
                  </Button>
                ))}
              </div>
            ) : null}
            {remove.error ? <NotSaved error={remove.error} /> : null}
            {rate.error ? <NotSaved error={rate.error} /> : null}
          </div>
        </div>
        <div className={card ? 'grid gap-16 px-16 @wide:grid-cols-2 @wide:items-start' : undefined}>
          {rated.length ? (
            <Section title="Ratings" card={card} className="@wide:col-span-2">
              <dl className={clsx(SECTION, 'grid gap-x-24 @md:grid-cols-2 @wide:grid-cols-3')}>
                {rated.map((k) => (
                  // The stars go under their label where both don't fit (five 44 cells on a narrow phone).
                  <div key={k} className="flex min-h-28 flex-wrap items-center gap-x-12">
                    <dt className="w-120 flex-none type-small text-ink-2">{RATING_LABELS[k]}</dt>
                    <dd>
                      <RateStars label={RATING_LABELS[k]} value={ratingOf(k) ?? 0} disabled={offline} onRate={(n) => void setRating(k, n)} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>
          ) : null}
          {tags.length ? (
            <Section title="Tags" card={card} className="@wide:col-span-2">
              <ul aria-label="Tags" className={`${SECTION} flex flex-wrap gap-6`}>
                {tags.map((t) => (
                  <li key={t}>
                    <Tag>{tagLabel(t)}</Tag>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
            {p.dishes.length ? (
              <Section
                title="Dishes"
                card={card}
                {...(both ? {} : { className: '@wide:col-span-2' })}
                aside={
                  p.dishes.length < 30 ? (
                    <Button variant="text" size="sm" disabled={offline} onClick={() => dishSheet.show(null)}>
                      <PlusIcon size={12} aria-hidden="true" />
                      Dish
                    </Button>
                  ) : null
                }
              >
                <ul aria-label="Dishes">
                  {p.dishes.map((d, i) => {
                    const second = [d.price !== undefined ? formatAmount(d.price, currency) : null, d.again ? 'order again' : null, d.notes ?? null].filter((s): s is string => s !== null);
                    return (
                      <li key={`${i}:${d.name}`} className="border-b border-line">
                        <button type="button" onClick={() => dishSheet.show(i)} className="block w-full px-16 py-8 text-left transition-colors duration-120 ease-hover hover:bg-hover coarse:min-h-44">
                          <span className="flex items-center gap-8">
                            <span className="min-w-0 flex-1 truncate type-row text-ink">{d.name}</span>
                            {d.rating ? <Stars rating={d.rating} /> : <span className="type-mono text-ink-3">not tried</span>}
                          </span>
                          {second.length ? <span className="mt-2 block truncate type-mono text-ink-3">{second.join(' · ')}</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            ) : null}
            {count > 0 || visits.length ? (
              <Section title={`Visits · ${count}${avg !== null ? ` · about ${formatAmount(avg, currency)}` : ''}`} card={card} {...(both ? {} : { className: '@wide:col-span-2' })}>
                <ul aria-label="Visits">
                  {visits.map((v) => (
                    <li key={v.id} className="border-b border-line">
                      <button type="button" onClick={() => visitSheet.show(v)} className="block w-full px-16 py-8 text-left transition-colors duration-120 ease-hover hover:bg-hover coarse:min-h-44">
                        <span className="flex items-center gap-12">
                          <span className="type-mono text-ink">{dayLabel(v.day)}</span>
                          {v.spend !== undefined ? <span className="type-mono text-ink-2">{formatAmount(v.spend, currency)}</span> : null}
                          {v.stars ? <Stars rating={v.stars} className="ml-auto" /> : null}
                        </span>
                        {v.had?.length ? <span className="mt-2 block truncate type-small text-ink-2">{v.had.join(', ')}</span> : null}
                        {v.notes ? <span className="mt-2 line-clamp-2 type-small text-ink-2">{v.notes}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
                {more ? (
                  <div className="px-16 pt-8">
                    <Button variant="text" className="-ml-8" disabled={olderBusy || offline} onClick={() => void showOlder()}>
                      {olderBusy ? <Spinner label="Loading" /> : null}
                      Show all
                    </Button>
                  </div>
                ) : null}
                {olderError ? <LifeError error={olderError} offline={offline} onRetry={() => void showOlder()} /> : null}
              </Section>
            ) : null}
          {p.notes ? (
            <Section title="Notes" card={card} className="@wide:col-span-2">
              <p className={`whitespace-pre-wrap ${SECTION} type-small text-ink-2`}>{p.notes}</p>
            </Section>
          ) : null}
        </div>
      </>
    );
  }
}
