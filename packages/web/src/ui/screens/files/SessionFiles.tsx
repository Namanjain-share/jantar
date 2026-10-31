/**
 * The inside of a session's Files tab (v0.3 spec 5.2, U9), loaded with the
 * Files chunk the first time the tab opens; session/FilesTab.tsx is the tab
 * panel around it and says when Files is off.
 *
 *   Changed   "Changed by Claude 12"; while the transcript is still being
 *             read: "reading the transcript · 34 MB of 120 MB" (mono)
 *   Browse    the session's folder, then its subfolders
 *   viewer    ?root=&path=&tab= in the URL (replaced, never pushed: the
 *             screen keeps the place in its own state)
 *
 * "Ask about this" (the session's own folder only) hands "@src/x.ts:12-20 "
 * to onAsk, which fills the draft and shows the transcript. Nothing is sent
 * from here. A session whose folder is already listed under another root (a
 * root set on the Mac, or another session in the same folder) still browses
 * as s.<sid>, and its changed files, listed under that other root, can still
 * be asked about.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FilesLocation } from '../../../lib/router.js';
import { useDeps, useNow } from '../../context.js';
import { Segmented } from '../accounts/Segmented.js';
import type { FilesTabProps } from '../session/FilesTab.js';
import { Browse } from './Browse.js';
import { ChangedList } from './ChangedList.js';
import { useFileTick, useLoad, useOffline, useReloadOn } from './data.js';
import { changeAt, changedIn, dirLocation, dirOf, newestFirst, placeOf, sizeText } from './model.js';
import { Footnote, LoadError, Loading, StateLine } from './states.js';
import { Viewer } from './Viewer.js';

export type SessionFilesProps = Omit<FilesTabProps, 'id' | 'labelledBy'>;

/** While the daemon is still reading the transcript, ask again this long after each reply. */
const SCAN_POLL_MS = 2_000;

export function SessionFiles({ sid, session, phone, location, onLocation, onAsk }: SessionFilesProps) {
  const { api } = useDeps();
  const now = useNow(30_000);
  const offline = useOffline();
  const place = placeOf(location);
  const [chosen, setChosen] = useState<'changed' | 'browse'>(place.kind === 'dir' ? 'browse' : 'changed');
  const segment = place.kind === 'dir' ? 'browse' : chosen;

  const loadChanges = useCallback(() => api.sessionChanges(sid), [api, sid]);
  const changes = useLoad(`session-changes:${sid}`, loadChanges);
  const loadRoots = useCallback(() => api.filesRoots(), [api]);
  const roots = useLoad('roots', loadRoots);
  // The session's folder: its own root, else s.<sid>, which still resolves (the roots are still
  // on the way, or the list shows this folder once, under a root set on the Mac or another session).
  const sessionRoot = roots.data?.roots.find((r) => r.sid === sid)?.id ?? `s.${sid}`;

  // Claude wrote a file (files.changed) or changed another one (session.updated filesChanged): ask again.
  const tick = useFileTick(sid);
  const { reload } = changes;
  useReloadOn(`${session.filesChanged ?? 0}:${tick}`, reload);
  // The first read of a long transcript takes a while: follow it. The next ask waits for the
  // last reply, so a slow tunnel never has each reply overtaken (and dropped) by the next ask.
  const scanning = changes.data ? !changes.data.scan.done : false;
  // A screen reader hears the read start and end, not every 2-second byte count.
  const scanned = useRef(false);
  if (scanning) scanned.current = true;
  const due = scanning && !changes.loading;
  useEffect(() => {
    if (!due) return;
    const t = setTimeout(reload, SCAN_POLL_MS);
    return () => clearTimeout(t);
  }, [due, reload]);

  // Where the viewer's back goes: the list it was opened from.
  const from = useRef<FilesLocation | null>(null);
  const open = (next: FilesLocation, fromHere: FilesLocation) => {
    from.current = fromHere;
    onLocation(next);
  };
  const pick = (k: 'changed' | 'browse') => {
    setChosen(k);
    if (k === 'changed' && place.kind === 'dir') onLocation({});
    if (k === 'browse' && place.kind === 'lists') onLocation({ root: sessionRoot });
  };

  let content;
  if (place.kind === 'file') {
    const change = changeAt(changes.data?.changes, place.root, place.path);
    const back = from.current ?? (change ? {} : dirLocation(place.root, dirOf(place.path)));
    // This session's folder: its own root, or a file it changed that sits in its folder under another root.
    const own = place.root === sessionRoot || (change?.sid === sid && changedIn(change, session.cwd, place.path));
    content = (
      <Viewer
        key={`${place.root}\u0000${place.path}`}
        root={place.root}
        path={place.path}
        tab={place.tab}
        phone={phone}
        change={change}
        onBack={() => {
          from.current = null;
          onLocation(back);
        }}
        onLocation={(next) => onLocation(next)}
        onAsk={own ? onAsk : undefined}
      />
    );
  } else {
    let body;
    if (segment === 'browse') {
      const browsed = place.kind === 'dir' ? place.root : sessionRoot;
      body = (
        <Browse
          roots={roots}
          root={browsed}
          path={place.kind === 'dir' ? place.path : ''}
          // s.<sid> is missing from the list when another root already shows this folder.
          rootLabel={browsed === sessionRoot ? session.folder : undefined}
          phone={phone}
          onLocation={(next) => open(next, location)}
        />
      );
    } else if (!changes.data) {
      body = changes.error ? <LoadError error={changes.error} offline={offline} what="list" onRetry={reload} /> : <Loading caption="Reading the transcript…" />;
    } else {
      const { changes: list, scan, truncated } = changes.data;
      const progress = scan.done ? null : (
        <p className="flex-none px-16 py-8 type-mono text-ink-3">
          reading the transcript · {sizeText(scan.bytes)} of {sizeText(scan.total)}
        </p>
      );
      const announce = (
        <span role="status" className="sr-only">
          {scan.done ? (scanned.current ? 'Transcript read in full' : '') : 'Reading the transcript'}
        </span>
      );
      body = list.length ? (
        <>
          {announce}
          {progress}
          <ChangedList
            groups={[{ key: sid, label: 'Changed by Claude', changes: newestFirst(list) }]}
            phone={phone}
            now={now}
            label="Files this session changed"
            onOpen={(c) => open({ root: c.rootId, path: c.rel }, {})}
            footer={truncated ? <Footnote>Only the first 2,000 files are listed.</Footnote> : null}
          />
        </>
      ) : (
        <>
          {announce}
          {progress}
          {scan.done ? <StateLine>Claude hasn't changed any files in this session yet.</StateLine> : null}
        </>
      );
    }
    content = (
      <>
        <div className={phone ? 'flex-none px-16 py-8' : 'flex-none py-12'}>
          <Segmented
            label="Files list"
            value={segment}
            onChange={pick}
            segments={[
              { key: 'changed', label: 'Changed' },
              { key: 'browse', label: 'Browse' },
            ]}
          />
        </div>
        {body}
      </>
    );
  }

  return content;
}
