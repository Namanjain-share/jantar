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
 */
import { CaretLeftIcon, PlusIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import type { Place, PlaceDetail, PlaceVisit } from '@jantar/protocol';
import { formatAmount } from '../../../../lib/money.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { RailLabel } from '../../../kit/RailLabel.js';
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
import { Stars } from './Stars.js';
import { VisitSheet } from './VisitSheet.js';

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
}

const SECTION = 'px-16 py-10';

function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={typeof title === 'string' ? title : undefined}>
      <RailLabel ground="bg" aside={aside}>
        {title}
      </RailLabel>
      {children}
    </section>
  );
}

/** Older visits fetched past the first page, for the page they follow (a reload starts again). */
interface Older {
  base: PlaceDetail;
  visits: PlaceVisit[];
  more: boolean;
}

export function PlaceScreen({ id, back, currency, today, undo, held, customTags, onDelete, onDeleted }: PlaceScreenProps) {
  const { api } = useDeps();
  const offline = useOffline();
  const load = useLifeLoad(`place:${id}`, () => api.placeGet(id));
  const edit = useSheet<Place>();
  const dishSheet = useSheet<number>();
  const visitSheet = useSheet<PlaceVisit>();
  const remove = useWrite();
  const [older, setOlder] = useState<Older | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const data = load.data;
  const place = data?.place ?? null;
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

  const deleteVisit = (v: PlaceVisit) =>
    held.remove(`visit:${v.id}`, `Deleted: the visit of ${dayLabel(v.day)}`, async () => {
      const r = await remove.run(`delete:${v.id}`, (key) => api.placeVisitDelete(id, v.id, key));
      if (r.ok) load.reload();
      return r.ok;
    });

  const backLink = (
    <Link href={back} className="inline-flex h-32 items-center gap-4 rounded-btn px-8 type-small text-ink-2 hover:bg-hover hover:text-ink coarse:h-44">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Cafés
    </Link>
  );
  const aside = place ? (
    <Button size="sm" disabled={offline} onClick={() => edit.show(place)}>
      Edit
    </Button>
  ) : null;

  return (
    <Page title={place?.name ?? 'Café'} wrapTitle back={backLink} aside={aside} undo={undo}>
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
    const rated = RATING_KEYS.filter((k) => p.ratings?.[k] !== undefined);
    const tags = tagsOn(p);
    const count = p.visits?.count ?? visits.length;
    const avg = p.visits?.avgSpend ?? null;
    const head = [p.price ? priceLabel(p.price, currency) : null, p.again ? AGAIN_LABEL[p.again] : null].filter((s): s is string => s !== null);
    const prompts = [
      rated.length === 0 ? { label: 'Rating', run: () => edit.show(p) } : null,
      p.dishes.length === 0 ? { label: 'Dish', run: () => dishSheet.show(null) } : null,
      tags.length === 0 ? { label: 'Tag', run: () => edit.show(p) } : null,
    ].filter((x): x is { label: string; run: () => void } => x !== null);
    return (
      <>
        <div className="px-16 pb-12">
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
          <Button variant="primary" size="lg" className="mt-12 w-full" disabled={offline} onClick={() => visitSheet.show(null)}>
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
        </div>
        {rated.length ? (
          <Section title="Ratings">
            <dl className={SECTION}>
              {rated.map((k) => (
                <div key={k} className="flex min-h-28 items-center gap-12">
                  <dt className="w-120 flex-none type-small text-ink-2">{RATING_LABELS[k]}</dt>
                  <dd>
                    <Stars rating={p.ratings?.[k] ?? 0} />
                  </dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}
        {tags.length ? (
          <Section title="Tags">
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
          <Section title={`Visits · ${count}${avg !== null ? ` · about ${formatAmount(avg, currency)}` : ''}`}>
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
          <Section title="Notes">
            <p className={`whitespace-pre-wrap ${SECTION} type-small text-ink-2`}>{p.notes}</p>
          </Section>
        ) : null}
      </>
    );
  }
}
