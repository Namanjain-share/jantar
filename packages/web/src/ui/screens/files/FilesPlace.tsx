/**
 * The Files place, /files (v0.3 spec 5.2, U9): which files the live
 * sessions created or changed, a folder browser, and the read-only viewer.
 *
 *   display    "14 files changed today" / "No files changed today"
 *   segmented  Changed | Browse
 *   Changed    one rail per session ("WEB-APP · FIX LOGIN 5"), rows newest first
 *   Browse     roots, then folders (?root=&path=src/)
 *
 * Phone and tablet: the viewer is a pushed screen (?root=&path=src/x.ts),
 * so the back gesture closes it. Desktop: the list fills the ledger column
 * and the viewer the detail pane. "Ask about this" (a session's own folder
 * only) queues the mention with askAbout() and opens that session, whose
 * composer takes it once; nothing is ever sent from here. A file a session
 * changed in its own folder asks that session, even when the folder is
 * listed under another root (sessions sharing a folder share one).
 */
import { FILES_CHANGES_LIMIT, type FileChange } from '@jantar/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionViewPath, type FilesLocation } from '../../../lib/router.js';
import { readLocal, writeLocal } from '../../../lib/storage.js';
import { useApp, useDeps, useNavigate, useNow } from '../../context.js';
import { useFeatures } from '../../shell/data.js';
import { isSplit, useFrame } from '../../shell/layout.js';
import { Segmented } from '../accounts/Segmented.js';
import { askAbout } from '../session/ask.js';
import { Browse } from './Browse.js';
import { ChangedList } from './ChangedList.js';
import { useFileTick, useLoad, useOffline, useReloadOn } from './data.js';
import { changeAt, changedBy, changedToday, dirLocation, dirOf, groupBySession, placeOf, todayCut, todayLine } from './model.js';
import { FilesOff, LoadError, Loading, StateLine } from './states.js';
import { Viewer } from './Viewer.js';

export interface FilesPlaceProps {
  /** Where the viewer stands (from /files?root=&path=&tab=). */
  location: FilesLocation;
  /** Move the viewer; `replace` keeps the history entry (switching a tab). */
  onLocation: (next: FilesLocation, opts?: { replace?: boolean }) => void;
}

type Segment = 'changed' | 'browse';
const SEGMENT_KEY = 'files-segment';

/** Every session's changed-file count, summed: when it moves, the list is stale. */
function useChangedSum(): number {
  return useApp((s) => {
    let n = 0;
    for (const x of Object.values(s.state.sessions)) n += x.filesChanged ?? 0;
    return n;
  });
}

export function FilesPlace({ location, onLocation }: FilesPlaceProps) {
  const { api, router } = useDeps();
  const navigate = useNavigate();
  const features = useFeatures();
  const frame = useFrame();
  const phone = frame === 'phone';
  const split = isSplit(frame);
  const now = useNow(30_000);
  const offline = useOffline();
  const sessions = useApp((s) => s.state.sessions);
  const place = placeOf(location);
  const [chosen, setChosen] = useState<Segment>(() => (readLocal<string>(SEGMENT_KEY, 'changed') === 'browse' ? 'browse' : 'changed'));
  // A folder in the URL is Browse, whatever was chosen before, and stays chosen on the way out of it.
  const segment: Segment = place.kind === 'dir' ? 'browse' : chosen;
  useEffect(() => {
    if (place.kind === 'dir') setChosen('browse');
  }, [place.kind]);

  const loadChanges = useCallback(() => api.filesChanges({ limit: FILES_CHANGES_LIMIT }), [api]);
  const changes = useLoad(features.files ? 'changes' : null, loadChanges);
  const loadRoots = useCallback(() => api.filesRoots(), [api]);
  const roots = useLoad(features.files ? 'roots' : null, loadRoots);

  // A session wrote a file (files.changed) or changed another one (session.updated filesChanged): ask for the list again.
  const sum = useChangedSum();
  const ticks = useFileTick();
  useReloadOn(`${sum}:${ticks}`, changes.reload);

  // Places this screen pushed, so its back button can pop them; a deep link replaces instead.
  const pushed = useRef(0);
  const open = useCallback(
    (next: FilesLocation) => {
      pushed.current += 1;
      onLocation(next);
    },
    [onLocation],
  );
  const move = useCallback(
    (next: FilesLocation, opts?: { replace?: boolean }) => {
      if (opts?.replace) onLocation(next, { replace: true });
      else open(next);
    },
    [onLocation, open],
  );
  const back = () => {
    if (pushed.current > 0) {
      pushed.current -= 1;
      router.getState().back();
      return;
    }
    onLocation(place.kind === 'file' && segment === 'browse' ? dirLocation(place.root, dirOf(place.path)) : {}, { replace: true });
  };
  const pick = (k: Segment) => {
    // Browse again while inside a folder: back to the list of roots.
    if (k === 'browse' && segment === 'browse' && place.kind === 'dir') {
      open({});
      return;
    }
    setChosen(k);
    writeLocal(SEGMENT_KEY, k);
    if (k === 'changed' && place.kind === 'dir') onLocation({}, { replace: true });
  };
  const openChange = (c: FileChange & { rootId: string; rel: string }) => {
    setChosen('changed');
    open({ root: c.rootId, path: c.rel });
  };

  if (!features.files) {
    return (
      <div className="px-16 py-24 md:px-32">
        <FilesOff />
      </div>
    );
  }

  const list = changes.data?.changes ?? null;
  // The list is the newest FILES_CHANGES_LIMIT rows: when today fills it, the count is a floor ("187+").
  const display = list ? todayLine(changedToday(list, now), todayCut(list, FILES_CHANGES_LIMIT, now)) : null;
  const header = (
    <header className={phone ? 'flex-none px-16 pb-12 pt-4' : 'flex-none px-16 pb-12 pt-16'}>
      <h1 className="sr-only">Files</h1>
      {display ? (
        <p data-display className="type-display text-ink">
          {display}
        </p>
      ) : null}
      <Segmented
        label="Files list"
        className={display ? 'mt-12' : undefined}
        value={segment}
        onChange={pick}
        segments={[
          { key: 'changed', label: 'Changed' },
          { key: 'browse', label: 'Browse' },
        ]}
      />
    </header>
  );

  let body;
  if (segment === 'browse') {
    const root = place.kind === 'lists' ? undefined : place.root;
    const path = place.kind === 'dir' ? place.path : place.kind === 'file' ? dirOf(place.path) : '';
    body = <Browse roots={roots} root={root} path={path} phone={phone} sessions={sessions} onLocation={open} onRoots={() => open({})} />;
  } else if (!list) {
    body = changes.error ? <LoadError error={changes.error} offline={offline} what="list" onRetry={changes.reload} /> : <Loading />;
  } else if (!list.length) {
    body = <StateLine>Files that Claude creates or changes in the live sessions show here.</StateLine>;
  } else {
    body = (
      <ChangedList
        groups={groupBySession(list, sessions)}
        phone={phone}
        now={now}
        label="Changed files"
        ground={split ? 'surface' : 'bg'}
        onOpen={openChange}
      />
    );
  }

  let viewer = null;
  if (place.kind === 'file') {
    const change = changeAt(list, place.root, place.path);
    // The session that changed it, in its own folder; else the session whose folder the root is.
    const asks = changedBy(change, sessions, place.path) ?? roots.data?.roots.find((r) => r.id === place.root)?.sid;
    viewer = (
      <Viewer
        key={`${place.root}\u0000${place.path}`}
        root={place.root}
        path={place.path}
        tab={place.tab}
        phone={phone}
        change={change}
        onBack={split ? undefined : back}
        onLocation={move}
        onAsk={askFor(asks, navigate)}
      />
    );
  }

  if (split) {
    return (
      <div className="grid-ledger grid h-full min-h-0">
        <section aria-label="Files list" className="flex min-h-0 flex-col border-r border-line bg-surface">
          {header}
          {body}
        </section>
        <section aria-label="File" className="flex min-h-0 min-w-0 flex-col">
          {viewer ?? <StateLine>Pick a file to read it here.</StateLine>}
        </section>
      </div>
    );
  }
  if (viewer) return <div className="flex h-full min-h-0 flex-col">{viewer}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {body}
    </div>
  );
}

/** "Ask about this" for a session's own folder: queue the mention, then open the session. */
function askFor(sid: string | undefined, navigate: (to: string) => void): ((text: string) => void) | undefined {
  if (!sid) return undefined;
  return (text) => {
    askAbout(sid, text);
    navigate(sessionViewPath(sid, 'transcript'));
  };
}
