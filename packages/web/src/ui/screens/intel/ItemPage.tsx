/**
 * One item of the shelf (v0.4 spec 5.8, `/intel?item=<id>`): its title,
 * Open link when it has one, what it is, why it matters, its tags, then
 * every other field as a property list, and last its type, source and
 * time. Everything is a text node; a link is only ever an http(s) address
 * (checked again here), opened in a new tab with no opener and no referrer
 * (LW2), so a `javascript:` value from some bot's file stays plain text.
 */
import { CaretLeftIcon } from '@phosphor-icons/react';
import type { IntelItem } from '@jantar/protocol';
import { isApiError } from '../../../lib/api.js';
import { useDeps } from '../../context.js';
import { buttonClass } from '../../kit/Button.js';
import { Link } from '../../shell/Link.js';
import { LifeError, LifeLoading } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { httpHref, shelfPath, shelfTime, type ShelfFilters } from './model.js';

/** A value that is one whole http(s) address, as a safe outside link; anything else as text. */
export function FieldValue({ value }: { value: string }) {
  const href = httpHref(value);
  if (!href) return <>{value}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="break-all text-ink underline underline-offset-2">
      {value}
    </a>
  );
}

function Back({ filters }: { filters: ShelfFilters }) {
  return (
    <Link href={shelfPath(filters)} className="inline-flex h-44 items-center gap-4 px-8 type-small text-ink-2 transition-colors duration-120 ease-hover hover:text-ink">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Intel
    </Link>
  );
}

function Body({ item }: { item: IntelItem }) {
  const href = httpHref(item.url);
  const meta = [item.type, item.source, shelfTime(item.at)].filter(Boolean).join(' · ');
  return (
    <article className="px-16">
      <h1 className="break-words type-title text-ink">{item.title}</h1>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={buttonClass('outline', 'lg', 'mt-12')}>
          Open link
        </a>
      ) : null}
      {item.summary ? <p className="mt-16 whitespace-pre-wrap break-words type-body text-ink">{item.summary}</p> : null}
      {item.why ? (
        <section className="mt-16">
          <h2 className="type-small text-ink-3">Why it matters</h2>
          <p className="mt-4 whitespace-pre-wrap break-words type-body text-ink">{item.why}</p>
        </section>
      ) : null}
      {item.tags.length ? (
        <ul aria-label="Tags" className="mt-16 flex flex-wrap gap-6">
          {item.tags.map((t) => (
            <li key={t}>
              <Link
                href={shelfPath({ tag: t })}
                className="inline-flex h-28 items-center rounded-chip border border-line-strong px-8 font-mono text-rail font-data text-ink-2 transition-colors duration-120 ease-hover hover:bg-hover hover:text-ink coarse:h-44"
              >
                {t}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {item.fields.length ? (
        <dl className="mt-16 border-t border-line">
          {item.fields.map((f, i) => (
            <div key={`${f.key}-${i}`} className="border-b border-line py-8 md:flex md:gap-12">
              <dt className="break-words type-small text-ink-3 md:w-160 md:flex-none">{f.key}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words type-small text-ink">
                <FieldValue value={f.value} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {meta ? <p className="mt-16 type-mono text-ink-3">{meta}</p> : null}
    </article>
  );
}

export function ItemPage({ id, filters, offline }: { id: string; filters: ShelfFilters; offline: boolean }) {
  const { api } = useDeps();
  const load = useLifeLoad(`item:${id}`, () => api.intelGet(id));
  const gone = isApiError(load.error, 'not_found');
  return (
    <div className="pb-48 animate-enter md:max-w-720">
      <div className="px-8 pt-8">
        <Back filters={filters} />
      </div>
      {load.data && !gone ? (
        <>
          {load.error ? <LifeError error={load.error} offline={offline} onRetry={load.reload} /> : null}
          <Body item={load.data.item} />
        </>
      ) : (
        <>
          <h1 className="px-16 type-title text-ink">Intel</h1>
          {gone ? <Gone /> : load.error ? <LifeError error={load.error} offline={offline} onRetry={load.reload} /> : <LifeLoading count={3} />}
        </>
      )}
    </div>
  );
}

function Gone() {
  return <p className="px-16 py-16 type-small text-ink-2">That item is no longer on the shelf.</p>;
}
