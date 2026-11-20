/**
 * Name search in Browse (0.14.1): a field at the top of a folder, "Search
 * names in <folder>", that finds file and folder names below it through
 * GET /v1/files/find. Names only, never what is inside a file.
 *
 * A search starts 250 ms after the last keystroke and needs 2 characters;
 * the clear button and Escape empty it. Dot entries and dot folders are
 * searched only while Browse shows hidden files (a text that starts with a
 * dot is just a text: ".pdf" finds PDFs). While a search is on, its
 * results take the listing's place: icon, name, the folder it is in
 * (relative to this one) and size and age, as Browse rows have them. A
 * file opens the viewer as Browse does; a folder is browsed into, and the
 * search ends. A reply cut short says why: more names than it holds
 * ("Type more to narrow it") or a walk that hit its depth, entries or time
 * cap ("Search a folder further down").
 *
 * What was typed is kept in memory per folder (never in storage), so the
 * phone's back from a result's viewer finds the results still there.
 */
import { FolderIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { FILES_FIND_QUERY_MAX, FILES_FIND_QUERY_MIN, type FileFindEntry } from '@jantar/protocol';
import clsx from 'clsx';
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { agoLong } from '../../../lib/format.js';
import { useDeps } from '../../context.js';
import { IconButton } from '../../kit/IconButton.js';
import { SkeletonRow } from '../../kit/Skeleton.js';
import { ROW_ICON } from './ChangedList.js';
import { TextRun } from './CodeView.js';
import { useLoad, useOffline } from './data.js';
import { iconFor, sizeText } from './model.js';
import { Footnote, LoadError, OFFLINE, StateLine, fileErrorText } from './states.js';
import { VirtualList } from './VirtualList.js';

/** Typing settles this long before a search goes out. */
export const FIND_DEBOUNCE_MS = 250;

const KEPT_MAX = 20;
/** What was typed per folder (`root\0path`), this page's memory only. */
const kept = new Map<string, string>();

function recall(key: string): string {
  return kept.get(key) ?? '';
}

function keep(key: string, text: string): void {
  kept.delete(key);
  if (!text) return;
  kept.set(key, text);
  while (kept.size > KEPT_MAX) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
}

/** Forget every kept search (tests). */
export function clearKeptSearches(): void {
  kept.clear();
}

/** Characters, not UTF-16 units: "é" or an emoji is one. */
function chars(s: string): number {
  return [...s].length;
}

/** A search text that is long enough to send (trimmed), or null. */
export function searchable(text: string): string | null {
  const t = text.trim();
  return chars(t) >= FILES_FIND_QUERY_MIN ? t : null;
}

export interface NameSearch {
  /** What is in the field. */
  text: string;
  /** The settled text to search for, or null: the listing shows. */
  query: string | null;
  setText(text: string): void;
  clear(): void;
}

/** The field's text for one folder (`key`), and the settled search it asks for. */
export function useNameSearch(key: string): NameSearch {
  const [s, setS] = useState(() => {
    const t = recall(key);
    return { key, text: t, settled: t };
  });
  let cur = s;
  // Another folder: its own text, settled at once (no wait to show what was found there before).
  if (s.key !== key) {
    const t = recall(key);
    cur = { key, text: t, settled: t };
    setS(cur);
  }
  const { text, settled } = cur;
  useEffect(() => {
    if (text === settled) return;
    const t = setTimeout(() => setS((x) => (x.key === key ? { ...x, settled: x.text } : x)), FIND_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, text, settled]);
  const setText = useCallback(
    (next: string) => {
      keep(key, next);
      setS((x) => (x.key === key ? { ...x, text: next } : { key, text: next, settled: '' }));
    },
    [key],
  );
  const clear = useCallback(() => {
    keep(key, '');
    setS({ key, text: '', settled: '' });
  }, [key]);
  // Too short now: the listing comes back at once, without waiting for the text to settle.
  const query = searchable(text) === null ? null : searchable(settled);
  return { text, query, setText, clear };
}

/** The field: "Search names in <folder>", with a clear button; Escape empties it. */
export function SearchField({ search, folder }: { search: NameSearch; folder: string }) {
  const label = `Search names in ${folder}`;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape' || !search.text) return;
    // Only the search: a sheet around this browser stays open.
    e.preventDefault();
    e.stopPropagation();
    search.clear();
  };
  return (
    <div role="search" aria-label="Names in this folder" className="flex-none border-b border-line px-16 py-8">
      <div className="relative min-w-0">
        <MagnifyingGlassIcon size={16} aria-hidden="true" className="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={FILES_FIND_QUERY_MAX}
          aria-label={label}
          placeholder={label}
          value={search.text}
          onChange={(e) => search.setText(e.target.value)}
          onKeyDown={onKeyDown}
          className={clsx(
            'h-36 w-full min-w-0 truncate rounded-btn border border-line-strong bg-bg pl-36 type-input text-ink outline-none placeholder:text-ink-3',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44',
            search.text ? 'pr-40 coarse:pr-48' : 'pr-12',
          )}
        />
        {search.text ? (
          <IconButton aria-label="Clear the search" className="absolute right-4 top-1/2 -translate-y-1/2 coarse:right-0" onClick={search.clear}>
            <XIcon size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

const ROW = 'flex w-full items-center gap-12 px-16 text-left transition-colors duration-120 ease-hover hover:bg-hover active:bg-hover';

/** "src/auth" for a match two folders down from `from`; "" for one right in it. */
export function folderOf(path: string, from: string): string {
  const rel = from && path.startsWith(`${from}/`) ? path.slice(from.length + 1) : path;
  const at = rel.lastIndexOf('/');
  return at < 0 ? '' : rel.slice(0, at);
}

function FoundRow({ e, from, now, onOpen }: { e: FileFindEntry; from: string; now: number; onOpen: (e: FileFindEntry) => void }) {
  const Icon = e.kind === 'dir' ? FolderIcon : ROW_ICON[iconFor(e.name)];
  const where = folderOf(e.path, from);
  const facts = [e.size !== undefined ? sizeText(e.size) : null, agoLong(e.mtime, now) || null].filter(Boolean).join(' · ');
  return (
    <button type="button" data-row={e.path} className={clsx(ROW, 'min-h-52 border-b border-line py-8')} onClick={() => onOpen(e)}>
      <Icon size={20} aria-hidden="true" className="flex-none text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate type-row text-ink">
          <TextRun text={e.name} />
        </span>
        {where || facts ? (
          <span className="mt-2 flex min-w-0 gap-8 type-mono text-ink-3">
            {where ? (
              <span className="min-w-0 truncate">
                <TextRun text={`${where}/`} />
              </span>
            ) : null}
            {facts ? <span className="flex-none">{facts}</span> : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** The footnote when a cap on the walk (depth, entries, time) ended it before the whole folder was seen. */
export const STOPPED_EARLY = 'Stopped early: this folder is big. Search a folder further down.';

/** What the search found, in the listing's place. One live region, mounted throughout, says each state. */
export function FindResults({
  root,
  path,
  query,
  hidden,
  now,
  onOpen,
}: {
  root: string;
  /** The folder searched ('' = the root). */
  path: string;
  query: string;
  /** Browse's "Show hidden files": dot entries and dot folders are searched too. */
  hidden: boolean;
  now: number;
  onOpen: (e: FileFindEntry) => void;
}) {
  const { api } = useDeps();
  const offline = useOffline();
  const load = useCallback((signal: AbortSignal) => api.filesFind({ root, path, q: query, hidden }, { signal }), [api, root, path, query, hidden]);
  // Kept out of the files cache: a run of searches would push the folders' listings out of it.
  const found = useLoad(`find:${root}\u0000${path}\u0000${hidden ? 1 : 0}\u0000${query}`, load, { cache: false });
  let said: string;
  let body: ReactNode;
  if (!found.data) {
    if (found.error) {
      said = offline ? OFFLINE : fileErrorText(found.error, 'folder');
      body = <LoadError error={found.error} offline={offline} what="folder" onRetry={found.reload} />;
    } else {
      said = 'Searching…';
      body = (
        <div aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <SkeletonRow key={i} />
          ))}
          <p className="px-16 py-12 type-mono text-ink-3">Searching…</p>
        </div>
      );
    }
  } else {
    const { entries, stopped } = found.data;
    const n = entries.length;
    said =
      n === 0
        ? `No names match${stopped === 'scan' ? ', but the search stopped early' : ''}.`
        : `${n === 1 ? '1 name' : `${n} names`} found${stopped === 'scan' ? '; the search stopped early' : stopped === 'limit' ? ', there may be more' : ''}.`;
    const note =
      stopped === 'scan' ? <Footnote>{STOPPED_EARLY}</Footnote> : stopped === 'limit' ? <Footnote>Showing the first {n}. Type more to narrow it.</Footnote> : null;
    body =
      n === 0 ? (
        <>
          <StateLine>No names match “{query}”.</StateLine>
          {note}
        </>
      ) : (
        <VirtualList
          items={entries}
          label={`Names with “${query}”, ${n} found`}
          getKey={(e) => e.path}
          estimate={() => 52}
          render={(e) => <FoundRow e={e} from={path} now={now} onOpen={onOpen} />}
          footer={note}
        />
      );
  }
  return (
    <>
      <p role="status" className="sr-only">
        {said}
      </p>
      {body}
    </>
  );
}
