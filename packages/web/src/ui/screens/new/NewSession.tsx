/**
 * New session, /new (v0.3, work package W3 owns this file and the rest of
 * ui/screens/new/ and ui/screens/launch/): the folder browser, the start
 * form with the flags pickers (decision U7) and the launch receipt, whose
 * startup dialogs are cards you answer (decision U8). Spec 5.3.
 *
 *   /new?root=&path=            the browser at that folder
 *   /new?root=&path=&start=1    the start form for that folder
 *     &account=N                  starting on that account (a Board row's "New session here")
 *     &from=ID                    starting from that failed launch: its account, Name and first prompt ("Try again")
 *   /new?root=&path=&launch=ID  that launch's receipt
 *
 * Phone and tablet: the browser fills the screen and the form is a bottom
 * sheet that turns into the receipt once the hold commits. Desktop (spec
 * 5.3.5): the browser in a 440 px column, the form and then the receipt in
 * the detail pane. While the form is open the browser stays where you were
 * when you chose Start (a deep link opens it at the folder's parent).
 *
 * The shell mounts this only while launching is switched on (features.launch).
 *
 * v0.6 (Fleet): a Where row above the folder browser picks the machine,
 * the Mac or a paired one that is online with starting on there:
 *
 *   Where     [ Mac ] [ build-1 ] [ build-2 ]
 *
 * Every folder and start call below then goes to that machine (`node` on
 * each call, through `onMachine`), and the browser, the Resume list, the
 * start form and the receipt are that machine's own. A launch's receipt and
 * a session's folder (a Board row's "New session here") stay on the machine
 * they belong to. The row shows only while some machine can start sessions;
 * until then this screen is as before.
 */
import { XIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HUB_MACHINE_NAME, type LaunchJob, type NodeView, type State } from '@jantar/protocol';
import { errorText } from '../../../lib/api.js';
import { routePath } from '../../../lib/router.js';
import { AppProvider, useApp, useDeps, useNavigate, useToast } from '../../context.js';
import { IconButton } from '../../kit/IconButton.js';
import { Sheet } from '../../kit/Sheet.js';
import { isSplit, useFrame } from '../../shell/layout.js';
import { Segmented } from '../accounts/Segmented.js';
import { Receipt } from '../launch/Receipt.js';
import { SESSIONS_VIEW, WhereContext, basename, dirname, onMachine, peekPrompt, relUnder, useRequest, useWhere, type Where } from './data.js';
import { FolderBrowser, sessionRootsOf } from './FolderBrowser.js';
import { StartForm } from './StartForm.js';

export interface NewSessionProps {
  root?: string;
  path?: string;
  /** Open the start sheet for root/path. */
  start?: boolean;
  /** The account the start form starts on (Auto when absent). */
  account?: number;
  /** Show this launch's receipt. */
  launch?: string;
  /** The launch "Try again" came from: the form starts with its account, Name and kept first prompt. */
  from?: string;
}

interface Place {
  root: string | undefined;
  path: string;
}

/** The machine last picked in the Where row, while the app runs (never stored). */
let lastPicked: string | undefined;

/** The paired machines a session can start on now: online, with starting on there; by name. */
export function startMachines(nodes: State['nodes']): NodeView[] {
  return Object.values(nodes ?? {})
    .filter((n) => n.online && n.features.launch)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const MAC = 'mac';

/**
 * The machine a launch (its receipt, or "Try again") or a session's folder
 * (root `s.<sid>`) belongs to: its node id, MAC for the Mac, or null when
 * the URL names neither.
 */
function pinnedTo(state: State, root: string | undefined, launch: string | undefined, from: string | undefined): string | null {
  const id = launch ?? from;
  if (id && Object.hasOwn(state.launches, id)) return state.launches[id]?.node ?? MAC;
  const sid = root?.startsWith('s.') ? root.slice(2) : null;
  if (sid && Object.hasOwn(state.sessions, sid)) return state.sessions[sid]?.node ?? MAC;
  return null;
}

export function NewSession(props: NewSessionProps) {
  const deps = useDeps();
  const navigate = useNavigate();
  const nodes = useApp((s) => s.state.nodes);
  const pinNode = useApp((s) => pinnedTo(s.state, props.root, props.launch, props.from));
  const choices = useMemo(() => startMachines(nodes), [nodes]);
  const [picked, setPicked] = useState<string | undefined>(lastPicked);
  const chosen = picked !== undefined && choices.some((n) => n.id === picked) ? picked : undefined;
  const node = pinNode === null ? chosen : pinNode === MAC ? undefined : pinNode;
  const view = node !== undefined && nodes && Object.hasOwn(nodes, node) ? nodes[node] : undefined;
  const where = useMemo<Where | null>(
    () => (node === undefined ? null : { node, name: view?.name ?? 'a server', accountsMode: view?.accountsMode ?? 'dirs' }),
    [node, view?.name, view?.accountsMode],
  );
  const api = useMemo(() => onMachine(deps.api, node), [deps.api, node]);
  const scoped = useMemo(() => ({ ...deps, api }), [deps, api]);

  const pick = (k: string) => {
    const next = k === MAC ? undefined : k;
    lastPicked = next;
    setPicked(next);
    // Folders and launches are each machine's own: the browser starts again at the new one's first folder list.
    if (next !== node) navigate(routePath({ name: 'new' }));
  };
  const shown = node !== undefined && !choices.some((n) => n.id === node) && view ? [...choices, view] : choices;
  const whereRow =
    shown.length > 0 ? (
      <div className="flex min-w-0 items-center gap-12 px-16 pb-12">
        <span aria-hidden="true" className="w-72 flex-none type-small text-ink-3">
          Where
        </span>
        <div className="no-scrollbar min-w-0 overflow-x-auto">
          <Segmented
            label="Where"
            segments={[{ key: MAC, label: HUB_MACHINE_NAME }, ...shown.map((n) => ({ key: n.id, label: n.name }))]}
            value={node ?? MAC}
            onChange={pick}
          />
        </div>
      </div>
    ) : null;

  return (
    <AppProvider deps={scoped}>
      <WhereContext.Provider value={where}>
        <NewSessionPlace key={node ?? MAC} {...props} whereRow={whereRow} />
      </WhereContext.Provider>
    </AppProvider>
  );
}

function NewSessionPlace({ root, path = '', start = false, account, launch, from, whereRow }: NewSessionProps & { whereRow: ReactNode }) {
  const { api } = useDeps();
  const where = useWhere();
  const navigate = useNavigate();
  const toast = useToast();
  const split = isSplit(useFrame());
  const offline = useApp((s) => s.conn.status === 'offline');
  // Own keys only: an id from the URL such as "constructor" is no launch.
  const launchRoot = useApp((s) => (launch && Object.hasOwn(s.state.launches, launch) ? s.state.launches[launch]?.rootId : undefined));
  const retried = useApp((s) => (from && Object.hasOwn(s.state.launches, from) ? s.state.launches[from] : undefined));

  const target = start && root ? { root, path } : null;
  const panel = launch ? 'receipt' : target ? 'form' : null;

  // Where the browser stands. With the form or the receipt open it stays
  // where you browsed last, if that is the folder or its parent.
  const last = useRef<Place>(panel ? { root: undefined, path: '' } : { root, path });
  useEffect(() => {
    if (!panel) last.current = { root, path };
  }, [panel, root, path]);
  let browse: Place = { root, path };
  if (panel) {
    const want = root ?? launchRoot;
    const l = last.current;
    if (want === undefined) browse = l;
    else if (l.root === want && (root === undefined || path === l.path || dirname(path) === l.path)) browse = l;
    else browse = { root: want, path: root === undefined ? '' : dirname(path) };
  }

  const roots = useRequest('roots', () => api.foldersRoots());
  const recent = useRequest('recent', () => api.foldersRecent());
  const all = roots.data?.roots ?? [];
  // A root the list does not show (a session's folder listed once under another root, or a session
  // that ended): behind the form or the receipt the browser shows where it starts, not a dead end.
  if (panel && roots.data && browse.root !== undefined && browse.root !== SESSIONS_VIEW && !all.some((r) => r.id === browse.root)) {
    browse = { root: undefined, path: '' };
  }
  const firstRoot = all.find((r) => r.kind === 'configured')?.id ?? (sessionRootsOf(all).length ? SESSIONS_VIEW : undefined);
  const shownRoot = browse.root ?? firstRoot;
  const shownPath = browse.root === undefined ? '' : browse.path;

  const listKey = shownRoot && shownRoot !== SESSIONS_VIEW ? `${shownRoot}\n${shownPath}` : null;
  const listing = useRequest(listKey, () => api.foldersList({ root: shownRoot as string, ...(shownPath ? { path: shownPath } : {}) }));
  const [moreLoading, setMoreLoading] = useState(false);

  const to = (r: string | undefined, p: string, extra: { start?: boolean; launch?: string; from?: string } = {}) =>
    routePath({ name: 'new', ...(r ? { root: r } : {}), ...(p ? { path: p } : {}), ...extra });
  const close = () => navigate(to(shownRoot, shownPath), { replace: true });

  const more = async () => {
    const after = listing.data?.next;
    if (!after || !shownRoot) return;
    setMoreLoading(true);
    try {
      const page = await api.foldersList({ root: shownRoot, ...(shownPath ? { path: shownPath } : {}), after });
      listing.set((cur) => (cur ? { ...page, entries: [...cur.entries, ...page.entries] } : page));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setMoreLoading(false);
    }
  };

  const pin = async (r: string, p: string, pinned: boolean) => {
    const name = basename(p);
    if (offline) {
      toast("Offline: can't pin right now", 'info');
      return;
    }
    // The row moves at once; the daemon's order follows.
    const here = r === shownRoot && dirname(p) === shownPath;
    const flip = (on: boolean) => listing.set((cur) => cur && { ...cur, entries: cur.entries.map((e) => (e.name === name ? { ...e, pinned: on } : e)) });
    if (here) flip(pinned);
    try {
      await api.foldersPin({ root: r, path: p, pinned });
      toast(pinned ? `Pinned ${name}` : `Unpinned ${name}`, 'ok');
      listing.reload();
      if (!here) recent.reload();
    } catch (e) {
      if (here) flip(!pinned);
      toast(errorText(e), 'error');
    }
  };

  /**
   * "Try again" after a failed launch: the start form for its folder, found
   * from its root's display path, starting from what that launch had.
   */
  const retryTo = (job: LaunchJob): string | null => {
    if (root === job.rootId && path) return to(root, path, { start: true, from: job.id });
    const r = all.find((x) => x.id === job.rootId);
    if (!r) return null;
    const rel = relUnder(r.display, job.display);
    return rel === null ? to(job.rootId, '') : to(job.rootId, rel, { start: true, from: job.id });
  };
  // The failed launch's account, Name and first prompt (kept in memory on this device only).
  const again = from && retried && target && retried.rootId === target.root ? retried : undefined;
  const startAccount = again ? again.requested : account;
  const keptPrompt = again ? (peekPrompt(again.id) ?? undefined) : undefined;

  const entry =
    target && target.root === shownRoot && dirname(target.path) === shownPath && target.path
      ? listing.data?.entries.find((e) => e.name === basename(target.path))
      : undefined;
  const closeButton = split ? (
    <IconButton aria-label="Close" onClick={close}>
      <XIcon size={16} aria-hidden="true" />
    </IconButton>
  ) : undefined;

  let body: ReactNode = null;
  if (launch) {
    const receipt = <Receipt key={launch} id={launch} phone={!split} retryTo={retryTo} aside={closeButton} />;
    // v0.6: a machine's launch says where it runs.
    body = where ? (
      <>
        <p data-machine-line className="pb-8 type-mono text-ink-3">
          On {where.name}
        </p>
        {receipt}
      </>
    ) : (
      receipt
    );
  } else if (target) {
    body = (
      <StartForm
        key={`${target.root}\n${target.path}\n${startAccount ?? 'auto'}\n${again?.id ?? ''}`}
        root={target.root}
        path={target.path}
        entry={entry}
        {...(startAccount !== undefined ? { initialAccount: startAccount } : {})}
        {...(again ? { initialName: again.name, retryOf: again.id } : {})}
        {...(keptPrompt ? { initialPrompt: keptPrompt } : {})}
        phone={!split}
        aside={closeButton}
        onStarted={(job) => navigate(to(target.root, target.path, { launch: job.id }), { replace: true })}
      />
    );
  }
  // The sheet keeps its last body while it slides away.
  const lastBody = useRef<ReactNode>(null);
  if (body) lastBody.current = body;

  const browser = (
    <FolderBrowser
      phone={!split}
      whereRow={whereRow}
      roots={roots}
      root={shownRoot}
      path={shownPath}
      listing={listing}
      recent={recent.data?.recent ?? []}
      selected={split ? (target ?? (launch && root ? { root, path } : null)) : null}
      offline={offline}
      moreLoading={moreLoading}
      onBrowse={(r, p) => navigate(to(r, p))}
      onStart={(r, p) => navigate(to(r, p, { start: true }))}
      onPin={(r, p, on) => void pin(r, p, on)}
      onMore={() => void more()}
      onCreated={(r, p) => {
        listing.reload();
        navigate(to(r, p, { start: true }));
      }}
    />
  );

  if (split) {
    return (
      <div className="flex h-full min-h-0 animate-enter">
        <section aria-labelledby="new-session-title" className="no-scrollbar w-440 flex-none overflow-y-auto border-r border-line bg-surface pb-24">
          {browser}
        </section>
        <section aria-label="Detail" className="min-w-0 flex-1 overflow-y-auto px-32 pb-32 pt-24">
          <div className="max-w-640">
            {body ?? (
              <>
                <h2 className="type-title text-ink">Pick a folder</h2>
                <p className="mt-6 max-w-560 type-small text-ink-2">
                  Choose Start beside a folder, or Start here for the one you are in. The account, the flags and a first prompt come next.
                </p>
              </>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <section aria-labelledby="new-session-title" className="pb-24 animate-enter">
      {browser}
      <Sheet open={body !== null} onOpenChange={(o) => !o && close()} title={launch ? 'Launch' : 'Start a session'} hideTitle>
        {body ?? lastBody.current}
      </Sheet>
    </section>
  );
}
