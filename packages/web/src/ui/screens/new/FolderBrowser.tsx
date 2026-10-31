/**
 * The folder browser of New session (spec 5.3.2):
 *
 *   ‹ Board                                    (phone)
 *   New session                                display, the one per screen
 *   [ Desktop | work | Sessions ]              roots set on the Mac, plus live session folders
 *   ~/Desktop/work/api            Start here   mono breadcrumb, each part a way up
 *   PINNED / RECENT / FOLDERS                  rails
 *   [Folder] jantar                  Start →   tap: open it; Start →: the start form;
 *            git · 2 live · 3h ago · 07         long press (or P): pin
 *   New folder                                 inline field, live validation
 *
 * Dirs only, as the daemon lists them (hidden dirs and protected ones stay
 * out; the count of protected ones shows at the foot). RECENT sits at the
 * top of a root. A long listing gets a filter field; "Show more folders"
 * reads the next page, and "Showing 500 of 812" says how much is still out.
 *
 * States: skeleton rows while loading; "No folders here"; no roots (teach the
 * Mac command); the daemon's sentence for anything it refused (the TCC
 * sentence, launching off); a filter with no match.
 */
import { ArrowRightIcon, CaretLeftIcon, FolderIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CLI_NAME, type FileRoot, type FilesRootsResponse, type FolderEntry, type FolderRecent, type FoldersListResponse } from '@jantar/protocol';
import { errorText } from '../../../lib/api.js';
import { accountId, agoLong } from '../../../lib/format.js';
import { routePath } from '../../../lib/router.js';
import { useNavigate, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { EmptyState } from '../../kit/EmptyState.js';
import { justLongPressed, useLongPress, type PressGuard } from '../../kit/longPress.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { SkeletonRows } from '../../kit/Skeleton.js';
import { Spinner } from '../../kit/Spinner.js';
import { useAccountsMode } from '../../shell/data.js';
import { Link } from '../../shell/Link.js';
import { Segmented } from '../accounts/Segmented.js';
import { folderName } from '../launch/stages.js';
import { SESSIONS_VIEW, dirname, joinPath, type Request } from './data.js';
import { NewFolder } from './NewFolder.js';

/** Show the filter field past this many folders (or whenever the listing was cut short). */
const FILTER_FROM = 12;

/** Session roots once each: several sessions often share a folder. */
export function sessionRootsOf(roots: readonly FileRoot[]): FileRoot[] {
  const byDisplay = new Map<string, FileRoot>();
  for (const r of roots) if (r.kind === 'session' && !byDisplay.has(r.display)) byDisplay.set(r.display, r);
  return [...byDisplay.values()];
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * "Showing 500 of 812. Type to filter." under a listing with more folders
 * than it shows (more pages, or a folder too big to read whole: then the
 * total is a floor, "10,000+"). Null when everything is shown. A daemon
 * without `total` gets the count shown only.
 */
export function showingLine(l: Pick<FoldersListResponse, 'entries' | 'total' | 'truncated'>): string | null {
  const shown = l.entries.length;
  if (l.total === undefined) return l.truncated ? `Showing ${fmt(shown)}. Type to filter.` : null;
  if (shown >= l.total && !l.truncated) return null;
  return `Showing ${fmt(shown)} of ${fmt(Math.max(shown, l.total))}${l.truncated ? '+' : ''}. Type to filter.`;
}

/** Line 2 of a folder row: "git · CLAUDE.md · 2 live · 3h ago · 07" (no account with one Claude login). */
export function entryLine(e: FolderEntry, now: number, single = false): string {
  return [
    e.link ? 'link' : null,
    e.git ? 'git' : null,
    e.claudeMd ? 'CLAUDE.md' : null,
    e.live ? `${e.live} live` : null,
    e.lastUsed ? agoLong(e.lastUsed, now) : null,
    e.lastAccount !== undefined && !single ? accountId(e.lastAccount) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function FolderRow({
  name,
  line2,
  href,
  phone,
  selected,
  hintId,
  guard,
  onStart,
  onPin,
}: {
  name: string;
  line2: string;
  href: string;
  phone: boolean;
  selected: boolean;
  hintId: string;
  guard: PressGuard;
  onStart: () => void;
  onPin?: () => void;
}) {
  // Long press to pin (kit/longPress.ts). The pin moves its row at once, so every row and
  // every Start button ignores the click that follows (the guard is the browser's).
  const press = useLongPress<HTMLAnchorElement>(onPin, guard);
  const onKey = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (!onPin || (e.key !== 'p' && e.key !== 'P') || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    onPin();
  };
  return (
    <li data-folder={name} className={clsx('relative flex items-center border-b border-line', selected && 'row-tick bg-select')}>
      <Link
        href={href}
        aria-describedby={onPin ? hintId : undefined}
        onClick={(e) => {
          if (justLongPressed(guard)) e.preventDefault();
        }}
        onKeyDown={onKey}
        {...press}
        className={clsx(
          'flex min-w-0 flex-1 select-none items-center gap-12 py-8 pl-16 pr-8 transition-colors duration-120 ease-hover [-webkit-touch-callout:none] focus-visible:-outline-offset-2',
          phone ? 'min-h-64' : 'min-h-52',
          !selected && 'hover:bg-hover',
        )}
      >
        <FolderIcon size={16} aria-hidden="true" className="flex-none text-ink-2" />
        <span className="min-w-0 flex-1">
          <span className="block truncate type-row font-medium text-ink">{name}</span>
          {line2 ? <span className="block truncate type-mono text-ink-3">{line2}</span> : null}
        </span>
      </Link>
      <Button
        variant="text"
        size="sm"
        className="mr-8 flex-none"
        aria-label={`Start a session in ${name}`}
        onClick={() => {
          if (!justLongPressed(guard)) onStart();
        }}
      >
        Start
        <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
      </Button>
    </li>
  );
}

function Problem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="px-16 py-16">
      <p role="alert" className="max-w-560 type-small text-ink-2">
        {errorText(error)}
      </p>
      <Button className="mt-12" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Crumbs({ root, path, onBrowse, onStart }: { root: FileRoot; path: string; onBrowse: (path: string) => void; onStart: () => void }) {
  const segs = path ? path.split('/') : [];
  const part = (label: string, to: string, current: boolean) =>
    current ? (
      <span aria-current="page" className="text-ink">
        {label}
      </span>
    ) : (
      <button type="button" onClick={() => onBrowse(to)} className="transition-colors duration-120 ease-hover hover:text-ink coarse:min-h-44">
        {label}
      </button>
    );
  return (
    <div className="flex items-center gap-8 px-16 py-8">
      <nav aria-label="Folder path" className="min-w-0 flex-1">
        <ol className="flex flex-wrap items-center type-mono text-ink-3">
          <li>{part(root.display, '', segs.length === 0)}</li>
          {segs.map((s, i) => (
            <li key={`${i}:${s}`} className="flex items-center">
              <span aria-hidden="true" className="px-4">
                /
              </span>
              {part(s, segs.slice(0, i + 1).join('/'), i === segs.length - 1)}
            </li>
          ))}
        </ol>
      </nav>
      <Button size="sm" className="flex-none" onClick={onStart}>
        Start here
      </Button>
    </div>
  );
}

export interface FolderBrowserProps {
  phone: boolean;
  roots: Request<FilesRootsResponse>;
  /** The root being browsed (SESSIONS_VIEW: the live session folders); undefined while there is none. */
  root: string | undefined;
  path: string;
  listing: Request<FoldersListResponse>;
  recent: FolderRecent[];
  /** The folder the start form or receipt is open for (highlighted on desktop). */
  selected: { root: string; path: string } | null;
  offline: boolean;
  moreLoading: boolean;
  onBrowse: (root: string, path: string) => void;
  onStart: (root: string, path: string) => void;
  onPin: (root: string, path: string, pinned: boolean) => void;
  onMore: () => void;
  onCreated: (root: string, path: string) => void;
}

export function FolderBrowser(props: FolderBrowserProps) {
  const { phone, roots, root, path, listing, recent, selected, offline, moreLoading, onBrowse, onStart, onPin, onMore, onCreated } = props;
  const navigate = useNavigate();
  const now = useNow(60_000);
  const single = useAccountsMode() === 'single';
  const hintId = useId();
  const guard = useRef<PressGuard>({ at: -Infinity }).current;
  const [q, setQ] = useState('');
  useEffect(() => setQ(''), [root, path]);
  const ground = phone ? 'bg' : 'surface';

  const all = roots.data?.roots ?? [];
  const configured = all.filter((r) => r.kind === 'configured');
  const sessionRoots = sessionRootsOf(all);
  const current = root && root !== SESSIONS_VIEW ? all.find((r) => r.id === root) : undefined;
  const segments = [
    ...configured.map((r) => ({ key: r.id, label: r.label })),
    ...(sessionRoots.length ? [{ key: SESSIONS_VIEW, label: 'Sessions' }] : []),
  ];
  const segment = current?.kind === 'session' ? SESSIONS_VIEW : (root ?? '');
  const isSelected = (r: string, p: string) => selected !== null && selected.root === r && selected.path === p;
  const match = (name: string) => !q || name.toLowerCase().includes(q.trim().toLowerCase());

  const header = (
    <>
      {phone ? (
        <div className="px-8 pt-4">
          <Button variant="text" size="lg" onClick={() => navigate('/')}>
            <CaretLeftIcon size={16} aria-hidden="true" />
            Board
          </Button>
        </div>
      ) : null}
      <h1 id="new-session-title" data-display className={clsx('type-display text-ink', phone ? 'px-16 pb-12 pt-4' : 'px-16 pb-12 pt-20')}>
        New session
      </h1>
    </>
  );

  if (!roots.data) {
    return (
      <div>
        {header}
        {roots.error ? <Problem error={roots.error} onRetry={roots.reload} /> : <SkeletonRows count={5} caption="Reading folders…" />}
      </div>
    );
  }

  if (!configured.length && !sessionRoots.length) {
    return (
      <div>
        {header}
        <EmptyState title="No folders to start in">
          <p>
            Add folders on your Mac: <code className="type-mono text-ink">{CLI_NAME} folders add-root ~/Desktop</code>
          </p>
        </EmptyState>
      </div>
    );
  }

  let body: ReactNode;
  if (root === SESSIONS_VIEW) {
    const rows = sessionRoots.filter((r) => match(r.label));
    body = (
      <>
        <RailLabel ground={ground} count={rows.length}>
          Live session folders
        </RailLabel>
        <ul>
          {rows.map((r) => (
            <FolderRow
              key={r.id}
              name={r.label}
              line2={r.display}
              href={routePath({ name: 'new', root: r.id })}
              phone={phone}
              selected={isSelected(r.id, '')}
              hintId={hintId}
              guard={guard}
              onStart={() => onStart(r.id, '')}
            />
          ))}
        </ul>
      </>
    );
  } else if (!current) {
    body = (
      <p role="alert" className="px-16 py-16 type-small text-ink-2">
        That folder list is not on this Mac any more. Pick one above.
      </p>
    );
  } else if (!listing.data) {
    body = listing.error ? <Problem error={listing.error} onRetry={listing.reload} /> : <SkeletonRows count={5} caption="Reading folders…" />;
  } else {
    const l = listing.data;
    const entries = l.entries.filter((e) => match(e.name));
    const pinned = entries.filter((e) => e.pinned);
    const rest = entries.filter((e) => !e.pinned);
    const pinnedHere = new Set(l.entries.filter((e) => e.pinned).map((e) => joinPath(path, e.name)));
    const recents = path === '' ? recent.filter((r) => !(r.rootId === current.id && pinnedHere.has(r.path)) && match(folderName(r.display))) : [];
    const filtering = l.truncated || l.entries.length > FILTER_FROM;
    const showing = showingLine(l);
    const row = (e: FolderEntry) => {
      const p = joinPath(path, e.name);
      return (
        <FolderRow
          key={e.name}
          name={e.name}
          line2={entryLine(e, now, single)}
          href={routePath({ name: 'new', root: current.id, path: p })}
          phone={phone}
          selected={isSelected(current.id, p)}
          hintId={hintId}
          guard={guard}
          onStart={() => onStart(current.id, p)}
          onPin={() => onPin(current.id, p, !e.pinned)}
        />
      );
    };
    body = (
      <>
        {filtering ? (
          <div className="px-16 pb-8">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Type to filter"
              aria-label="Filter folders"
              className="h-40 w-full rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink coarse:h-44"
            />
          </div>
        ) : null}
        {pinned.length ? (
          <>
            <RailLabel ground={ground} count={pinned.length}>
              Pinned
            </RailLabel>
            <ul>{pinned.map(row)}</ul>
          </>
        ) : null}
        {recents.length ? (
          <>
            <RailLabel ground={ground} count={recents.length}>
              Recent
            </RailLabel>
            <ul>
              {recents.map((r) => (
                <FolderRow
                  key={`${r.rootId}:${r.path}`}
                  name={folderName(r.display)}
                  line2={[dirname(r.display), agoLong(r.lastUsed, now), r.lastAccount !== undefined && !single ? accountId(r.lastAccount) : null].filter(Boolean).join(' · ')}
                  href={routePath({ name: 'new', root: r.rootId, ...(r.path ? { path: r.path } : {}) })}
                  phone={phone}
                  selected={isSelected(r.rootId, r.path)}
                  hintId={hintId}
              guard={guard}
                  onStart={() => onStart(r.rootId, r.path)}
                  onPin={() => onPin(r.rootId, r.path, true)}
                />
              ))}
            </ul>
          </>
        ) : null}
        <RailLabel ground={ground} count={rest.length}>
          Folders
        </RailLabel>
        {rest.length ? <ul>{rest.map(row)}</ul> : null}
        {!entries.length && !recents.length ? (
          <p className="border-b border-line px-16 py-12 type-small text-ink-2">{q ? `No folder here matches ${q.trim()}.` : 'No folders here.'}</p>
        ) : null}
        <NewFolder
          key={`${current.id}\n${path}`}
          root={current.id}
          parent={path}
          offline={offline}
          phone={phone}
          onCreated={(p) => onCreated(current.id, p)}
        />
        {l.next ? (
          <div className="flex items-center gap-12 px-16 pt-12">
            <Button size="sm" disabled={moreLoading} onClick={onMore}>
              Show more folders
            </Button>
            {moreLoading ? <Spinner label="Reading more folders" /> : null}
          </div>
        ) : null}
        {showing ? <p className="px-16 pt-12 type-mono text-ink-3">{showing}</p> : null}
        {l.hiddenProtected ? (
          <p className="px-16 pt-8 type-mono text-ink-3">
            {l.hiddenProtected} protected {l.hiddenProtected === 1 ? 'folder' : 'folders'} hidden
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div>
      {header}
      {segments.length > 1 ? (
        <div className="no-scrollbar overflow-x-auto px-16 pb-8">
          <Segmented label="Where to look" segments={segments} value={segment} onChange={(k) => onBrowse(k, '')} />
        </div>
      ) : null}
      {current ? (
        <Crumbs root={current} path={path} onBrowse={(p) => onBrowse(current.id, p)} onStart={() => onStart(current.id, path)} />
      ) : null}
      {body}
      <p id={hintId} className="sr-only">
        Long press a folder, or press P on it, to pin it.
      </p>
    </div>
  );
}
