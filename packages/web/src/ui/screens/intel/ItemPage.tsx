/**
 * One item of the shelf (v0.4 spec 5.8, `/intel?item=<id>`): its title,
 * Open link when it has one, what it is, why it matters, its tags, then
 * every other field as a property list, and last its type, source and
 * time. Everything is a text node; a link is only ever an http(s) address
 * (checked again here), opened in a new tab with no opener and no referrer
 * (LW2), so a `javascript:` value from some bot's file stays plain text.
 *
 * v0.8 (spec 8), an item read from a link:
 *
 *   [▢ ▢ ▢ ▢]                              its thumbnails; a tap shows one larger
 *   Three ways to cook dal at home
 *   @example_cook · Instagram · 30 Oct     as the page gave them
 *   [ Open original ]                      https only, a new tab, no opener, no referrer
 *   Read at Standard                       or the step it is in, or Couldn't read + why
 *   Frames: only the cover image           what was left out
 *   [Read again as …]                      Retry and Change depth after a failure
 *   What it is · Key points · Caption · On screen · Why it matters · tags
 *   Transcript ›                           folded
 *   From Claude, not from the post         Full's background, labelled
 *   Your note · fields · type · source · saved · depth
 *   [Delete]                               captures only, a second tap to confirm
 *
 * A captures item with a link and no read (a plain capture, or one the
 * Shortcut saved while reading was off) offers Read it while the Mac reads
 * links. What Claude and the page wrote is text only: never Markdown, never
 * a link.
 */
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useId, useState, type ReactNode } from 'react';
import { INTEL_DEPTH_DEFAULT, type IntelDepth, type IntelItem, type IntelJob } from '@jantar/protocol';
import { isApiError } from '../../../lib/api.js';
import { useDeps, useNavigate, useNow, useToast } from '../../context.js';
import { Button, buttonClass } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { Link } from '../../shell/Link.js';
import { useFeatures } from '../../shell/data.js';
import { TwoTap } from '../session/TwoTap.js';
import { LifeError, LifeLoading, NotSaved } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { useWrite } from '../life/today/parts.js';
import { ReadAt } from './Depth.js';
import { FrameStrip } from './Frames.js';
import {
  DEPTH_LABEL,
  READ_COPY,
  bylineOf,
  httpHref,
  httpsHref,
  isRead,
  shelfPath,
  shelfTime,
  stateWord,
  unfinished,
  type ShelfFilters,
} from './model.js';

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

/** A labelled part of a read item: its words as text, line breaks kept. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-16">
      <h2 className="type-small text-ink-3">{title}</h2>
      <div className="mt-4 whitespace-pre-wrap break-words type-body text-ink">{children}</div>
    </section>
  );
}

/** The transcript, folded until asked for (it can be long). */
function Folded({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-16">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="-ml-8 inline-flex h-32 items-center gap-4 rounded-btn px-8 type-small text-ink-2 transition-colors duration-120 ease-hover hover:text-ink coarse:h-44"
        >
          {open ? <CaretDownIcon size={14} aria-hidden="true" /> : <CaretRightIcon size={14} aria-hidden="true" />}
          {title}
        </button>
      </h2>
      {open ? (
        <div id={id} className="mt-4 whitespace-pre-wrap break-words type-small text-ink">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** Where a read is, and what to do next: Retry, Read again as …, or Read it on a plain capture. */
function ReadLine({ item, job, canRead, offline, onChanged }: { item: IntelItem; job: IntelJob | null; canRead: boolean; offline: boolean; onChanged: () => void }) {
  const { api } = useDeps();
  const w = useWrite();
  const [picking, setPicking] = useState(false);
  const read = item.read;
  // A read on its way: the step the Mac's jobs say it is in, else waiting (on disk it is `queued` until it ends).
  const live = job && unfinished(job.state) ? job : null;
  const waiting = live !== null || read?.state === 'queued';
  const depth: IntelDepth = job?.depth ?? read?.depth ?? item.depth ?? INTEL_DEPTH_DEFAULT;
  const start = async (d: IntelDepth) => {
    const r = await w.run(`read:${item.id}:${d}`, (key) => api.intelReread(item.id, d, key));
    if (!r.ok) return;
    setPicking(false);
    onChanged();
  };

  let state: ReactNode = null;
  let action: 'retry' | 'again' | 'first' | null = null;
  if (waiting) {
    state = (
      <p className="flex items-center gap-8 type-mono text-ink-3">
        {live && live.state !== 'queued' ? <Spinner label={READ_COPY.reading} /> : null}
        <span>
          {live ? stateWord(live.state, live.tier) : stateWord('queued')} · {DEPTH_LABEL[depth]}
        </span>
      </p>
    );
  } else if (read?.state === 'failed') {
    state = (
      <>
        <p className="type-mono text-ink-3">
          {READ_COPY.failed} · {DEPTH_LABEL[read.depth]}
        </p>
        {read.reason ? <p className="mt-2 break-words type-small text-ink-2">{read.reason}</p> : null}
      </>
    );
    action = 'retry';
  } else if (read) {
    const done = read.done ?? read.depth;
    state = (
      <p className="type-mono text-ink-3">
        Read at {DEPTH_LABEL[done]}
        {done !== read.depth ? ` (${DEPTH_LABEL[read.depth]} asked)` : ''}
      </p>
    );
    action = 'again';
  } else if (item.source === 'captures' && httpsHref(item.url)) {
    action = 'first';
  }
  const notes = read?.notes ?? [];
  if (!state && !(action && canRead)) return null;

  let buttons: ReactNode = null;
  if (action && canRead) {
    if (picking) {
      buttons = <ReadAt initial={depth} busy={w.busy} disabled={offline} onRead={(d) => void start(d)} onCancel={() => setPicking(false)} />;
    } else if (action === 'retry') {
      buttons = (
        <div className="mt-6 flex flex-wrap items-center gap-8">
          <Button size="sm" disabled={offline || w.busy} onClick={() => void start(depth)}>
            {w.busy ? <Spinner label="Starting" /> : null}
            Retry
          </Button>
          <Button variant="text" size="sm" disabled={offline} onClick={() => setPicking(true)}>
            Change depth
          </Button>
        </div>
      );
    } else {
      buttons = (
        <Button size="sm" className="mt-6" disabled={offline} onClick={() => setPicking(true)}>
          {action === 'first' ? 'Read it' : 'Read again as …'}
        </Button>
      );
    }
  }
  return (
    <div data-read={live ? live.state : (read?.state ?? 'none')} className="mt-12">
      {state}
      {notes.length ? (
        <ul aria-label="Left out" className="mt-2">
          {notes.map((n) => (
            <li key={n} className="type-small text-ink-3">
              {n}
            </li>
          ))}
        </ul>
      ) : null}
      {buttons}
      {w.error ? <NotSaved error={w.error} /> : null}
    </div>
  );
}

function Body({
  item,
  job,
  canRead,
  offline,
  filters,
  onChanged,
}: {
  item: IntelItem;
  job: IntelJob | null;
  canRead: boolean;
  offline: boolean;
  filters: ShelfFilters;
  onChanged: () => void;
}) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const toast = useToast();
  const now = useNow(60_000);
  const del = useWrite();
  const fromLink = isRead(item);
  const original = fromLink ? httpsHref(item.url) : null;
  const href = fromLink ? null : httpHref(item.url);
  const byline = fromLink ? bylineOf(item, now) : '';
  const depth = item.read?.depth ?? item.depth;
  const meta = [item.type, item.source, shelfTime(item.at), depth ? DEPTH_LABEL[depth] : null].filter(Boolean).join(' · ');
  const remove = async () => {
    const r = await del.run(`delete:${item.id}`, (key) => api.intelDelete(item.id, key));
    if (!r.ok) return;
    toast(READ_COPY.deleted, 'ok');
    navigate(shelfPath(filters), { replace: true });
  };
  return (
    <article>
      {item.frames ? (
        <div className="pb-8">
          <FrameStrip id={item.id} count={item.frames} />
        </div>
      ) : null}
      <div className="px-16">
        <h1 className="break-words type-title text-ink">{item.title}</h1>
        {byline ? <p className="mt-4 break-words type-mono text-ink-3">{byline}</p> : null}
        {original ? (
          <a href={original} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={buttonClass('primary', 'lg', 'mt-12')}>
            Open original
          </a>
        ) : null}
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={buttonClass('outline', 'lg', 'mt-12')}>
            Open link
          </a>
        ) : null}
        <ReadLine item={item} job={job} canRead={canRead} offline={offline} onChanged={onChanged} />
        {item.summary ? (
          fromLink ? (
            <Part title="What it is">{item.summary}</Part>
          ) : (
            <p className="mt-16 whitespace-pre-wrap break-words type-body text-ink">{item.summary}</p>
          )
        ) : null}
        {item.points?.length ? (
          <section className="mt-16">
            <h2 className="type-small text-ink-3">Key points</h2>
            <ul className="mt-4 list-disc pl-20 type-body text-ink">
              {item.points.map((p, i) => (
                <li key={i} className="break-words">
                  {p}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {item.caption ? <Part title={item.platform === 'web' || item.platform === 'pdf' ? 'From the page' : 'Caption'}>{item.caption}</Part> : null}
        {item.onScreen ? <Part title="On screen">{item.onScreen}</Part> : null}
        {item.why ? <Part title="Why it matters">{item.why}</Part> : null}
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
        {item.transcript ? <Folded title="Transcript">{item.transcript}</Folded> : null}
        {item.background ? <Part title={READ_COPY.background}>{item.background}</Part> : null}
        {item.note ? <Part title="Your note">{item.note}</Part> : null}
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
        {item.source === 'captures' ? (
          <div className="mt-16">
            <TwoTap size="md" variant="text" className="-ml-8" confirmLabel="Delete for good" disabled={del.busy || offline} onConfirm={() => void remove()}>
              Delete
            </TwoTap>
            {del.error ? <NotSaved error={del.error} /> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function ItemPage({ id, filters, offline }: { id: string; filters: ShelfFilters; offline: boolean }) {
  const { api } = useDeps();
  const { intelRead } = useFeatures();
  const load = useLifeLoad(`item:${id}`, () => api.intelGet(id));
  // While the Mac reads links: the step a read of this item is in (memory only on the Mac).
  const jobs = useLifeLoad(intelRead ? 'jobs' : null, () => api.intelJobs());
  const job = jobs.data?.jobs.find((j) => j.id === id) ?? null;
  const gone = isApiError(load.error, 'not_found');
  const reload = () => {
    load.reload();
    jobs.reload();
  };
  return (
    <div className="pb-48 animate-enter md:max-w-720">
      <div className="px-8 pt-8">
        <Back filters={filters} />
      </div>
      {load.data && !gone ? (
        <>
          {load.error ? <LifeError error={load.error} offline={offline} onRetry={load.reload} /> : null}
          <Body item={load.data.item} job={job} canRead={intelRead} offline={offline} filters={filters} onChanged={reload} />
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
