/**
 * The folder browser (v0.3 spec 5.2.2, Browse): the roots first (folders
 * set on the Mac, then live sessions' folders), then inside a root a mono
 * breadcrumb with every segment tappable, folders first, 500 entries a
 * page. Folder rows are 44 px, file rows two lines ("12.4 KB · 2h ago").
 * Protected entries are left out by the daemon and only counted
 * ("hidden: 3 protected"); dotfiles show only with "Show hidden files".
 *
 * v0.4 (spec 5.9): while launching is on, the folder's header has an
 * outline "New Claude session here" button, the one way in from Files (the
 * ··· item it replaces is gone): the start sheet for this folder, where the
 * flags and Resume are picked (Files and the launcher share root ids). On a
 * phone it gets its own row under the breadcrumb; on a wider screen it sits
 * beside the ···. Launching off: no button.
 *
 * 0.10.1 (`create`, the Files place only): New folder, once the listing has
 * loaded and while Files and launching are both on. On a phone a text
 * button at the end of that second row (icon only below 360 px); wider, an
 * icon button before the ···. Its sheet (NewFolderSheet, lazy) makes one
 * empty folder through POST /v1/folders, the start sheet's own route, and
 * this folder then opens it with a "just made" panel whose primary, Start a
 * session here, is the start sheet for it. The panel shows on the way in
 * only, never on a deep link or a later visit. "Open it" on a folder that
 * was there already shows the same primary under the folder's name, never
 * "is ready" or the new-folder trust line. The breadcrumb scrolls to its
 * end, so the folder shown stays in sight when the buttons narrow the bar.
 */
import { Menu } from '@base-ui/react/menu';
import { DotsThreeIcon, FolderIcon, FolderPlusIcon, PlayIcon, PlusIcon } from '@phosphor-icons/react';
import { FILES_LIST_LIMIT, type FileEntry, type FileListing, type FileRoot, type Session } from '@jantar/protocol';
import clsx from 'clsx';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { accountId, agoLong } from '../../../lib/format.js';
import { routePath, type FilesLocation } from '../../../lib/router.js';
import { readLocal, writeLocal } from '../../../lib/storage.js';
import { useDeps, useNavigate, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { Tag } from '../../kit/Tag.js';
import { useFeatures } from '../../shell/data.js';
import { ROW_ICON } from './ChangedList.js';
import { TextRun } from './CodeView.js';
import { useLoad, useOffline, type Loaded } from './data.js';
import { apiPath, crumbs, dirLocation, iconFor, sizeText } from './model.js';
import { Footnote, LoadError, Loading, StateLine, fileErrorText } from './states.js';
import { VirtualList } from './VirtualList.js';

const HIDDEN_KEY = 'files-show-hidden';

// Only the Files place offers New folder: the session's Files tab and the attach picker never load it.
const NewFolderSheet = lazy(() => import('./NewFolderSheet.js').then((m) => ({ default: m.NewFolderSheet })));

/** "~/Desktop/work" + "auth/new-project" -> "~/Desktop/work/auth/new-project". */
function displayAt(label: string, rel: string): string {
  return rel ? `${label.replace(/\/+$/u, '')}/${rel}` : label;
}

/**
 * The "just made" panel (0.10.1): a folder New folder just made, or one
 * Open it picked (`made` false: its name only, no "is ready" and no
 * new-folder trust line), with the one primary on screen, which takes focus.
 */
function JustMade({ name, display, made, phone, onStart }: { name: string; display: string; made: boolean; phone: boolean; onStart: () => void }) {
  const start = useRef<HTMLButtonElement>(null);
  useEffect(() => start.current?.focus(), []);
  return (
    <section aria-label={made ? 'Folder ready' : 'This folder'} className="flex-none border-b border-line px-16 py-16">
      <p aria-live="polite" className="type-row font-medium text-ink">
        <TextRun text={made ? `${name} is ready` : name} />
      </p>
      <p className="mt-2 truncate type-mono text-ink-3">
        <TextRun text={display} />
      </p>
      {made ? (
        <p className="mt-8 type-small text-ink-2">
          Claude asks whether to trust a new folder; you answer here, not at the Mac.
        </p>
      ) : null}
      <Button ref={start} variant="primary" size={phone ? 'xl' : 'md'} className={clsx('mt-12', phone && 'w-full')} onClick={onStart}>
        <PlayIcon size={16} weight="fill" aria-hidden="true" />
        Start a session here
      </Button>
    </section>
  );
}

const ITEM =
  'flex h-32 cursor-pointer select-none items-center px-12 type-small text-ink outline-none transition-colors duration-120 ease-hover ' +
  'data-highlighted:bg-select coarse:h-44';

const ROW = 'flex w-full items-center gap-12 px-16 text-left transition-colors duration-120 ease-hover hover:bg-hover active:bg-hover';

/** What a root is called in the list: "~ home" for $HOME. */
export function rootName(r: FileRoot): string {
  return r.home ? '~ home' : r.label;
}

/** Roots set on the Mac first, then live sessions' folders (the daemon's order within each). */
export function orderRoots(roots: readonly FileRoot[]): FileRoot[] {
  return [...roots.filter((r) => r.kind === 'configured'), ...roots.filter((r) => r.kind !== 'configured')];
}

function RootList({
  roots,
  sessions,
  onLocation,
}: {
  roots: Loaded<{ roots: FileRoot[] }>;
  sessions: Readonly<Record<string, Session>>;
  onLocation: (next: FilesLocation) => void;
}) {
  const offline = useOffline();
  if (!roots.data) {
    if (roots.error) return <LoadError error={roots.error} offline={offline} what="list" onRetry={roots.reload} />;
    return <Loading count={3} />;
  }
  const list = orderRoots(roots.data.roots);
  if (!list.length) return <StateLine>No folders to browse yet. Live sessions' folders and the roots set on your Mac show here.</StateLine>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ul aria-label="Folders">
        {list.map((r) => {
          const s = r.sid ? sessions[r.sid] : undefined;
          const meta = [r.display, s && s.account !== null ? accountId(s.account) : null].filter(Boolean).join(' · ');
          return (
            <li key={r.id} className="border-b border-line">
              <button type="button" className={clsx(ROW, 'min-h-52 py-8')} onClick={() => onLocation({ root: r.id })}>
                <FolderIcon size={20} aria-hidden="true" className="flex-none text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate type-row font-medium text-ink">
                    <TextRun text={rootName(r)} />
                  </span>
                  <span className="mt-2 block truncate type-mono text-ink-3">{meta}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EntryRow({ e, now, onOpen }: { e: FileEntry; now: number; onOpen: (e: FileEntry) => void }) {
  if (e.type === 'dir') {
    return (
      <button type="button" className={clsx(ROW, 'h-44 border-b border-line')} onClick={() => onOpen(e)}>
        <FolderIcon size={20} aria-hidden="true" className="flex-none text-ink-3" />
        <span className="min-w-0 truncate type-row text-ink">
          <TextRun text={e.name} />
        </span>
      </button>
    );
  }
  const Icon = ROW_ICON[iconFor(e.name)];
  const meta = [e.size !== undefined ? sizeText(e.size) : null, agoLong(e.mtime, now) || null].filter(Boolean).join(' · ');
  const tag =
    e.type === 'other' ? 'special file' : e.link === 'outside' ? 'link outside' : e.link === 'broken' ? 'broken link' : e.type === 'link' ? 'link' : null;
  const opens = e.type === 'file' || (e.type === 'link' && e.link === 'inside');
  const inner = (
    <>
      <Icon size={20} aria-hidden="true" className="flex-none text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate type-row text-ink">
          <TextRun text={e.name} />
        </span>
        {meta ? <span className="mt-2 block truncate type-mono text-ink-3">{meta}</span> : null}
      </span>
      {tag ? <Tag>{tag}</Tag> : null}
    </>
  );
  return opens ? (
    <button type="button" className={clsx(ROW, 'min-h-52 border-b border-line py-8')} onClick={() => onOpen(e)}>
      {inner}
    </button>
  ) : (
    <div className="flex min-h-52 w-full items-center gap-12 border-b border-line px-16 py-8 opacity-60" aria-disabled="true">
      {inner}
    </div>
  );
}

function Folder({
  root,
  path,
  label,
  phone,
  create,
  onLocation,
  onRoots,
}: {
  root: string;
  path: string;
  label: string;
  phone: boolean;
  create: boolean;
  onLocation: (next: FilesLocation) => void;
  onRoots?: () => void;
}) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const { launch, files } = useFeatures();
  const now = useNow(60_000);
  const offline = useOffline();
  const [hidden, setHidden] = useState(() => readLocal<boolean>(HIDDEN_KEY, false));
  const rel = apiPath(path);
  const key = `list:${root}\u0000${rel}\u0000${hidden ? 1 : 0}`;
  const load = useCallback(() => api.filesList({ root, path: rel, hidden }), [api, root, rel, hidden]);
  const first = useLoad(key, load);
  const [more, setMore] = useState<{ key: string; pages: FileListing[] }>({ key, pages: [] });
  const [moreError, setMoreError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // The pages after the first follow its cursor: start them over only when the first page's
  // entries or cursor change, not on a refresh that brings the same page (back from offline).
  const firstPage = first.data;
  const version = useMemo(
    () => (firstPage ? `${firstPage.next ?? ''}\u0000${firstPage.entries.map((e) => `${e.type}/${e.name}`).join('\u0000')}` : null),
    [firstPage],
  );
  useEffect(() => {
    setMore({ key, pages: [] });
    setMoreError(null);
  }, [key, version]);

  const pages = first.data ? [first.data, ...(more.key === key ? more.pages : [])] : [];
  const last = pages[pages.length - 1];
  const entries = pages.flatMap((p) => p.entries);
  const protectedCount = pages.reduce((n, p) => n + p.hiddenProtected, 0);

  const showMore = () => {
    if (!last?.next || busy) return;
    setBusy(true);
    setMoreError(null);
    api
      .filesList({ root, path: rel, hidden, after: last.next })
      .then(
        (page) => setMore((m) => (m.key === key ? { key, pages: [...m.pages, page] } : m)),
        (e: unknown) => setMoreError(e),
      )
      .finally(() => setBusy(false));
  };
  const toggleHidden = () => {
    setHidden((h) => {
      writeLocal(HIDDEN_KEY, !h);
      return !h;
    });
  };
  const open = (e: FileEntry) => {
    const at = rel ? `${rel}/${e.name}` : e.name;
    onLocation(e.type === 'dir' ? dirLocation(root, at) : { root, path: at });
  };

  // New folder (0.10.1): the sheet mounts at its first opening and stays for its close animation.
  const [sheet, setSheet] = useState({ open: false, n: 0 });
  const newButton = useRef<HTMLButtonElement>(null);
  // One Idempotency-Key per folder, kept across openings: a retry after a lost 201 is replayed.
  const kept = useRef<{ sig: string; key: string } | null>(null);
  // The folder New folder just made (or Open it picked, `made` false): its panel shows while it is the one shown.
  const [created, setCreated] = useState<{ at: string; made: boolean } | null>(null);
  const arrived = useRef(false);
  useEffect(() => setCreated((c) => (c !== null && c.at !== rel ? null : c)), [rel]);
  const canCreate = create && launch && files && first.data !== null;
  const openSheet = () => {
    arrived.current = false;
    setSheet((s) => ({ open: true, n: s.n + 1 }));
  };
  const arrive = (at: string, made: boolean) => {
    arrived.current = true;
    // Set before the move: the effect above keeps it once `rel` is this path.
    setCreated({ at, made });
    setSheet((s) => ({ ...s, open: false }));
    onLocation(dirLocation(root, at));
  };
  const startIn = (at: string) => navigate(routePath({ name: 'new', root, ...(at ? { path: at } : {}), start: true }));

  const trail = crumbs(label, rel);
  // The end of the path is where you are: keep it in sight when the bar is too narrow for all of it.
  const crumbBar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = crumbBar.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [root, rel, label, canCreate, launch]);
  const startHere = launch ? (
    <Button size="sm" className="flex-none" onClick={() => startIn(rel)}>
      <PlusIcon size={14} weight="bold" aria-hidden="true" />
      New Claude session here
    </Button>
  ) : null;
  const newFolder = !canCreate ? null : phone ? (
    <Button ref={newButton} variant="text" size="sm" aria-label="New folder" className="ml-auto flex-none coarse:min-w-44" onClick={openSheet}>
      <FolderPlusIcon size={16} aria-hidden="true" className="flex-none" />
      <span className="max-[360px]:sr-only">New folder</span>
    </Button>
  ) : (
    <IconButton ref={newButton} aria-label="New folder" title="New folder" onClick={openSheet}>
      <FolderPlusIcon size={18} aria-hidden="true" />
    </IconButton>
  );
  const bar = (
    <div className={clsx('flex flex-none items-center gap-4 border-b border-line', phone ? 'pl-16 pr-8' : 'pl-16 pr-12')}>
      {onRoots ? (
        <button type="button" className="mr-8 flex-none rounded-chip type-small font-medium text-ink-2 hover:text-ink coarse:min-h-44" onClick={onRoots}>
          All folders
        </button>
      ) : null}
      <nav ref={crumbBar} aria-label="Folder path" className="no-scrollbar flex h-44 min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap type-mono text-ink-3">
        {trail.map((c, i) => {
          const here = i === trail.length - 1;
          return (
            <span key={c.path} className="flex items-center">
              <button
                type="button"
                aria-current={here ? 'location' : undefined}
                className={clsx('rounded-chip coarse:min-h-44', here ? 'text-ink' : 'text-ink-2 hover:text-ink')}
                onClick={() => onLocation(dirLocation(root, c.path))}
              >
                <TextRun text={c.label} />
              </button>
              <span aria-hidden="true">/</span>
            </span>
          );
        })}
      </nav>
      {!phone ? startHere : null}
      {!phone ? newFolder : null}
      <Menu.Root>
        <Menu.Trigger render={<IconButton aria-label="Folder options" />}>
          <DotsThreeIcon size={20} weight="bold" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={12} className="z-30">
            <Menu.Popup className="min-w-176 rounded-btn bg-raised py-4 text-ink shadow-float outline-none animate-pop">
              <Menu.Item className={ITEM} onClick={toggleHidden}>
                {hidden ? 'Hide hidden files' : 'Show hidden files'}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
  // A phone has no room beside the breadcrumb: the buttons take the header's second row.
  const header =
    phone && startHere ? (
      <>
        {bar}
        <div className="flex flex-none items-center gap-8 border-b border-line px-16 py-8">
          {startHere}
          {newFolder}
        </div>
      </>
    ) : (
      bar
    );
  const ready =
    created !== null && created.at === rel ? (
      <JustMade name={rel.slice(rel.lastIndexOf('/') + 1)} display={displayAt(label, rel)} made={created.made} phone={phone} onStart={() => startIn(rel)} />
    ) : null;
  const sheetEl =
    sheet.n > 0 ? (
      <Suspense fallback={null}>
        <NewFolderSheet
          open={sheet.open}
          onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))}
          formKey={sheet.n}
          root={root}
          parent={rel}
          display={displayAt(label, rel)}
          entries={entries}
          phone={phone}
          offline={offline}
          kept={kept}
          onArrive={arrive}
          onStale={first.reload}
          // Back to New folder, unless it opened a folder: then its panel's primary has the focus.
          finalFocus={() => (arrived.current ? false : (newButton.current ?? true))}
        />
      </Suspense>
    ) : null;

  if (!first.data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        {ready}
        {first.error ? <LoadError error={first.error} offline={offline} what="folder" onRetry={first.reload} /> : <Loading count={5} caption="Reading the folder…" />}
        {sheetEl}
      </div>
    );
  }
  const footer = (
    <>
      {!entries.length ? <StateLine>This folder is empty.</StateLine> : null}
      {protectedCount ? <Footnote>hidden: {protectedCount} protected</Footnote> : null}
      {pages.some((p) => p.truncated) ? <Footnote>Only the first 10,000 entries were read.</Footnote> : null}
      {last?.next ? (
        <div className="px-16 py-12">
          <Button size="sm" onClick={showMore} disabled={busy || offline}>
            Show {FILES_LIST_LIMIT} more
          </Button>
          {moreError ? (
            <p role="alert" className="mt-8 type-small text-ink-2">
              {fileErrorText(moreError, 'folder')}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {ready}
      <VirtualList
        items={entries}
        label={`${trail[trail.length - 1]?.label ?? label}, ${entries.length} entries`}
        getKey={(e) => `${e.type}:${e.name}`}
        estimate={(e) => (e.type === 'dir' ? 44 : 52)}
        render={(e) => <EntryRow e={e} now={now} onOpen={open} />}
        footer={footer}
      />
      {sheetEl}
    </div>
  );
}

export interface BrowseProps {
  /** The roots, loaded by the parent (the viewer needs them too). */
  roots: Loaded<{ roots: FileRoot[] }>;
  /** The folder to show; none: the list of roots. */
  root?: string;
  /** "" or "src/auth/". */
  path: string;
  phone: boolean;
  /** Live sessions, to name a session root's account (the list of roots only). */
  sessions?: Readonly<Record<string, Session>>;
  onLocation: (next: FilesLocation) => void;
  /** Offer "All folders" beside the breadcrumb, back to the list of roots. */
  onRoots?: () => void;
  /**
   * What to call `root` when the list of roots does not name it: a session
   * whose folder is already listed under another root (or the roots still loading).
   */
  rootLabel?: string;
  /**
   * Offer New folder in a folder (0.10.1): the Files place only, never the
   * session's Files tab or the attach picker. It also needs Files and
   * launching on; the device's scope is not checked here (a 403 teaches it).
   */
  create?: boolean;
}

const NO_SESSIONS: Readonly<Record<string, Session>> = {};

export function Browse({ roots, root, path, phone, sessions = NO_SESSIONS, onLocation, onRoots, rootLabel, create = false }: BrowseProps) {
  if (!root) return <RootList roots={roots} sessions={sessions} onLocation={onLocation} />;
  const info = roots.data?.roots.find((r) => r.id === root);
  return (
    <Folder
      key={root}
      root={root}
      path={path}
      label={info ? (info.home ? '~' : info.display) : (rootLabel ?? root)}
      phone={phone}
      create={create}
      onLocation={onLocation}
      onRoots={onRoots}
    />
  );
}
