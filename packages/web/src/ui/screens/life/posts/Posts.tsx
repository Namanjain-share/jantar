/**
 * Posts (v0.7 spec 5.2): what the user will post on social media by hand,
 * and a reminder at its time. Jantar never posts anything anywhere: it
 * keeps the text, rings, gives Copy and Open, and counts what is marked
 * Posted.
 *
 *   Posts                       This week: Reels 1/3 · Reddit 2/6   (opens the goals;
 *                                                 wraps between goals, never cut)
 *   No device gets post reminders.             PushWarning, while posts are on
 *   [ To post | Done ]
 *   [+ Post] [Log a comment]                   on both, above the list, so a long
 *                                                 list never pushes them down
 *   LATE / TODAY / TOMORROW / LATER / NO DATE  PostRow (Done: DonePostRow)
 *   Posted this week: 2
 *
 * Log a comment (v0.9) opens LogCommentSheet: paste the link to a comment
 * already made; it is saved posted now, with a 5 s Undo that deletes it.
 * The square marks a post Posted with a 5 s Undo (its old status goes
 * back); Skip in the sheet does the same. Delete asks nothing: the post
 * leaves the list at once with a 5 s Undo, and the delete is sent once the
 * Undo goes. `id` (a post's push) opens that post's sheet on arrival. The
 * title is the page's <h1> in every state.
 *
 * 0.11 (build plan 2.6): a SplitPane ("posts", fill). From a pane of 640
 * the groups are cards side by side (Late, Today, Tomorrow, Later, No date;
 * four across at 1440), and Done is rows in two or three columns. From a
 * pane of 800 a tap (or `?id=`) opens the post beside the list (PostDetail:
 * its text to read, Copy, Mark posted, its place's comments and a field to
 * log one); below that it opens the sheet, as 0.10 did.
 */
import { ChatCircleIcon, PlusIcon } from '@phosphor-icons/react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Post, PostPatch, PostsResponse } from '@jantar/protocol';
import { routePath, type PostsFilter } from '../../../../lib/router.js';
import { useDeps, useNavigate } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Columns, useCardWidth } from '../../../kit/Columns.js';
import { Panel } from '../../../kit/Panel.js';
import { SplitPane, useSplit } from '../../../kit/SplitPane.js';
import { Segmented } from '../../accounts/Segmented.js';
import { PushWarning } from '../shared/PushWarning.js';
import { EMPTY, LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus, type LifeLoad } from '../shared/useLife.js';
import { Loaded, Page, useHeldDeletes, useLifeClock, useOffline, useSheet, useUndo, type LifeClock } from '../today/parts.js';
import { GoalsSheet } from './GoalsSheet.js';
import { LogCommentSheet } from './LogCommentSheet.js';
import { byGroup, GROUP_LABEL, GROUP_ORDER, postLabel, weekGoals } from './model.js';
import { PostDetail } from './PostDetail.js';
import { DonePostRow, PostRow } from './PostRow.js';
import { PostSheet } from './PostSheet.js';

export interface PostsProps {
  filter?: PostsFilter | undefined;
  id?: string | undefined;
}

const FILTERS: { key: PostsFilter; label: string }[] = [
  { key: 'open', label: 'To post' },
  { key: 'done', label: 'Done' },
];

export interface PostActions {
  /** Posted or Skipped at once (with what the sheet edited), and a 5 s Undo that puts its old status back. */
  mark(post: Post, status: 'posted' | 'skipped', changes?: PostPatch): void;
  remove(post: Post): void;
  /** A comment just logged (v0.9): a 5 s Undo that deletes it. */
  logged(id: string, label: string): void;
  /** A row with a write in flight. */
  busy: ReadonlySet<string>;
  error: unknown;
  undo: ReturnType<typeof useUndo>;
  /** `posts` without the ones deleted and still under their Undo. */
  visible(posts: readonly Post[]): readonly Post[];
}

function usePostActions(reload: () => void): PostActions {
  const { api } = useDeps();
  const undo = useUndo();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const act = useCallback(
    async (id: string, fn: () => Promise<unknown>): Promise<boolean> => {
      setError(null);
      setBusy((b) => new Set(b).add(id));
      try {
        await fn();
        reload();
        return true;
      } catch (e) {
        setError(e);
        return false;
      } finally {
        setBusy((b) => {
          const n = new Set(b);
          n.delete(id);
          return n;
        });
      }
    },
    [reload],
  );
  const { show } = undo;
  const mark = useCallback(
    (p: Post, status: 'posted' | 'skipped', changes: PostPatch = {}) => {
      void act(p.id, () => api.postUpdate(p.id, { ...changes, status })).then((ok) => {
        if (ok) show(`${status === 'posted' ? 'Posted' : 'Skipped'}: ${postLabel(p)}`, () => void act(p.id, () => api.postUpdate(p.id, { status: p.status })));
      });
    },
    [act, api, show],
  );
  const { remove: hold, visible: unheld } = useHeldDeletes(undo);
  const remove = useCallback((p: Post) => hold(p.id, `Deleted: ${postLabel(p)}`, () => act(p.id, () => api.postDelete(p.id))), [hold, act, api]);
  const visible = useCallback((posts: readonly Post[]) => unheld(posts, (p) => p.id), [unheld]);
  const logged = useCallback((id: string, label: string) => show(`Logged: ${label}`, () => void act(id, () => api.postDelete(id))), [act, api, show]);
  return useMemo(() => ({ mark, remove, logged, busy, error, undo, visible }), [mark, remove, logged, busy, error, undo, visible]);
}

export function Posts({ filter = 'open', id }: PostsProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const { status } = useLifeStatus();
  const load = useLifeLoad(`posts:${filter}`, () => api.postsList(filter));
  const actions = usePostActions(load.reload);
  const now = useLifeClock(status, load.data?.today);
  const sheet = useSheet<Post>();
  const target = id ? load.data?.posts.find((p) => p.id === id) : undefined;
  const listPath = routePath(filter === 'open' ? { name: 'posts' } : { name: 'posts', filter });

  // 0.11: the posts across the pane, and one beside them from a pane of 800 (its sheet below that, as 0.10).
  return (
    <SplitPane
      name="posts"
      list={<PostsList filter={filter} id={id} target={target} load={load} actions={actions} now={now} sheet={sheet} />}
      detail={
        id ? (
          <PostDetail
            key={id}
            id={id}
            post={target}
            loaded={load.data !== null}
            tz={status?.timezone}
            actions={actions}
            onEdit={sheet.show}
            onClose={() => navigate(listPath, { replace: true })}
          />
        ) : null
      }
      selection={id}
      empty="fill"
      alone={false}
      listLabel="All posts"
      detailLabel="Post"
      onClose={() => navigate(listPath, { replace: true })}
    />
  );
}

interface PostsListProps {
  filter: PostsFilter;
  id: string | undefined;
  /** The post `id` names, once the list has it. */
  target: Post | undefined;
  load: LifeLoad<PostsResponse>;
  actions: PostActions;
  now: LifeClock;
  sheet: ReturnType<typeof useSheet<Post>>;
}

/**
 * The list's page: the week, the segments, add and log, then the groups
 * (cards side by side from a pane of 640, rails below) or Done. A tap opens
 * a post beside the list where there is room, else its sheet.
 */
function PostsList({ filter, id, target, load, actions, now, sheet }: PostsListProps) {
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const goals = useSheet();
  const logSheet = useSheet();
  const opened = useRef<string | null>(null);
  const split = useSplit();
  const beside = Boolean(split?.split && split.selected);
  const box = useRef<HTMLDivElement>(null);
  const cards = useCardWidth(box);
  const { show } = sheet;
  const pathOf = (p: Post) => routePath({ name: 'posts', ...(filter === 'done' ? { filter } : {}), id: p.id });
  const open = (p: Post) => (split?.split ? navigate(pathOf(p)) : show(p));

  // A push lands here with ?id=: that post's sheet opens, once, where it isn't beside the list.
  const room = Boolean(split?.split);
  useEffect(() => {
    if (!target || room || opened.current === target.id) return;
    opened.current = target.id;
    show(target);
  }, [target, room, show]);

  const add = () => sheet.show(null);
  const week = load.data?.week;
  const counts = week ? weekGoals(week) : [];
  // It wraps between goals (never inside one), so every goal's count shows at any width.
  const weekButton = week ? (
    <button
      type="button"
      onClick={() => goals.show()}
      className="min-w-0 max-w-[70%] rounded-btn text-right type-mono text-ink-2 underline-offset-2 hover:text-ink hover:underline coarse:min-h-44"
    >
      {counts.length ? (
        <>
          This week:
          {counts.map((c, i) => (
            <Fragment key={i}>
              {' '}
              <span className="whitespace-nowrap">{i < counts.length - 1 ? `${c} ·` : c}</span>
            </Fragment>
          ))}
        </>
      ) : (
        'Set a weekly goal'
      )}
    </button>
  ) : null;
  const addButton = (
    <Button disabled={offline} onClick={add} aria-label="Add post">
      <PlusIcon size={16} aria-hidden="true" />
      Post
    </Button>
  );

  return (
    <Page title="Posts" aside={weekButton} undo={beside ? undefined : actions.undo} wide>
      <PushWarning status={status} part="posts" />
      <div className="px-16 pb-12 pt-4 @md:max-w-560">
        <Segmented<PostsFilter> label="Show" fill value={filter} onChange={(f) => navigate(routePath(f === 'open' ? { name: 'posts' } : { name: 'posts', filter: f }), { replace: true })} segments={FILTERS} />
      </div>
      {week ? (
        <div className="flex flex-wrap items-center gap-x-12 gap-y-8 px-16 pb-12">
          {addButton}
          <Button disabled={offline} onClick={() => logSheet.show()}>
            <ChatCircleIcon size={16} aria-hidden="true" />
            Log a comment
          </Button>
        </div>
      ) : null}
      {actions.error && !beside ? (
        <div className="px-16">
          <NotSaved error={actions.error} />
        </div>
      ) : null}
      <div ref={box}>
        <Loaded load={load}>
          {(d) => {
            const posts = actions.visible(d.posts);
            if (filter === 'done') {
              if (posts.length === 0) return <LifeEmpty>{EMPTY.postsDone}</LifeEmpty>;
              return (
                // 0.11: in two or three columns from a pane of 640.
                <ul aria-label="Done" className={cards ? 'grid gap-x-16 px-8 @md:grid-cols-2 @wide:grid-cols-3' : 'border-t border-line'}>
                  {posts.map((p) => (
                    <DonePostRow key={p.id} post={p} tz={status?.timezone} onOpen={open} />
                  ))}
                </ul>
              );
            }
            const groups = byGroup(posts, now.day);
            if (posts.length === 0) return <LifeEmpty>{EMPTY.posts}</LifeEmpty>;
            const sections: ReactNode[] = GROUP_ORDER.filter((g) => groups[g].length > 0).map((g) => (
              <Panel key={g} label={GROUP_LABEL[g]} count={groups[g].length} card={cards}>
                <ul>
                  {groups[g].map((p) => (
                    <PostRow key={p.id} post={p} group={g} today={now.day} offline={offline} actions={actions} onOpen={open} current={beside && p.id === id} />
                  ))}
                </ul>
              </Panel>
            ));
            return cards ? (
              <Columns min={300} max={4} className="px-16 pt-4">
                {sections}
              </Columns>
            ) : (
              <>{sections}</>
            );
          }}
        </Loaded>
      </div>
      {week ? <p className="px-16 pt-12 type-mono text-ink-3">Posted this week: {week.posted}</p> : null}
      <PostSheet
        open={sheet.open}
        onOpenChange={sheet.onOpenChange}
        sheetKey={sheet.key}
        post={sheet.item}
        now={now}
        tz={status?.timezone}
        onSaved={load.reload}
        onSkip={(p, changes) => actions.mark(p, 'skipped', changes)}
        onDelete={actions.remove}
      />
      {week ? <GoalsSheet open={goals.open} onOpenChange={goals.onOpenChange} sheetKey={goals.key} goals={week.goals} onSaved={load.reload} /> : null}
      <LogCommentSheet
        open={logSheet.open}
        onOpenChange={logSheet.onOpenChange}
        sheetKey={logSheet.key}
        onLogged={(logged, label) => {
          load.reload();
          actions.logged(logged, label);
        }}
      />
    </Page>
  );
}
