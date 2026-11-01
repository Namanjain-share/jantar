/**
 * Posts (v0.7 spec 5.2): what the user will post on social media by hand,
 * and a reminder at its time. Jantar never posts anything anywhere: it
 * keeps the text, rings, gives Copy and Open, and counts what is marked
 * Posted.
 *
 *   Posts                       This week: Reels 1/3 · Reddit 2/6   (opens the goals)
 *   No device gets post reminders.             PushWarning, while posts are on
 *   [ To post | Done ]
 *   LATE / TODAY / TOMORROW / LATER / NO DATE  PostRow
 *   [+ Post]                       Posted this week: 2
 *
 * The square marks a post Posted with a 5 s Undo (its old status goes
 * back); Skip in the sheet does the same. Delete asks nothing: the post
 * leaves the list at once with a 5 s Undo, and the delete is sent once the
 * Undo goes. `id` (a post's push) opens that post's sheet on arrival. The
 * title is the page's <h1> in every state.
 */
import { PlusIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Post, PostPatch } from '@jantar/protocol';
import { routePath, type PostsFilter } from '../../../../lib/router.js';
import { useDeps, useNavigate } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { RailLabel } from '../../../kit/RailLabel.js';
import { Segmented } from '../../accounts/Segmented.js';
import { PushWarning } from '../shared/PushWarning.js';
import { EMPTY, LifeEmpty, NotSaved } from '../shared/states.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';
import { Loaded, Page, useHeldDeletes, useLifeClock, useOffline, useSheet, useUndo } from '../today/parts.js';
import { GoalsSheet } from './GoalsSheet.js';
import { byGroup, GROUP_LABEL, GROUP_ORDER, postLabel, weekLine } from './model.js';
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
  return useMemo(() => ({ mark, remove, busy, error, undo, visible }), [mark, remove, busy, error, undo, visible]);
}

export function Posts({ filter = 'open', id }: PostsProps) {
  const { api } = useDeps();
  const navigate = useNavigate();
  const offline = useOffline();
  const { status } = useLifeStatus();
  const load = useLifeLoad(`posts:${filter}`, () => api.postsList(filter));
  const actions = usePostActions(load.reload);
  const now = useLifeClock(status, load.data?.today);
  const sheet = useSheet<Post>();
  const goals = useSheet();
  const opened = useRef<string | null>(null);
  const target = id ? load.data?.posts.find((p) => p.id === id) : undefined;
  const { show } = sheet;

  // A push lands here with ?id=: that post's sheet opens, once.
  useEffect(() => {
    if (!target || opened.current === target.id) return;
    opened.current = target.id;
    show(target);
  }, [target, show]);

  const add = () => sheet.show(null);
  const week = load.data?.week;
  const line = week ? weekLine(week) : null;
  const weekButton = week ? (
    <button
      type="button"
      onClick={() => goals.show()}
      className="min-w-0 max-w-[70%] truncate rounded-btn type-mono text-ink-2 underline-offset-2 hover:text-ink hover:underline coarse:min-h-44"
    >
      {line ?? 'Set a weekly goal'}
    </button>
  ) : null;
  const addButton = (
    <Button disabled={offline} onClick={add} aria-label="Add post">
      <PlusIcon size={16} aria-hidden="true" />
      Post
    </Button>
  );

  return (
    <Page title="Posts" aside={weekButton} undo={actions.undo}>
      <PushWarning status={status} part="posts" />
      <div className="px-16 pb-12 pt-4">
        <Segmented<PostsFilter> label="Show" fill value={filter} onChange={(f) => navigate(routePath(f === 'open' ? { name: 'posts' } : { name: 'posts', filter: f }), { replace: true })} segments={FILTERS} />
      </div>
      {actions.error ? (
        <div className="px-16">
          <NotSaved error={actions.error} />
        </div>
      ) : null}
      <Loaded load={load}>
        {(d) => {
          const posts = actions.visible(d.posts);
          if (filter === 'done') {
            if (posts.length === 0) return <LifeEmpty>{EMPTY.postsDone}</LifeEmpty>;
            return (
              <ul aria-label="Done" className="border-t border-line">
                {posts.map((p) => (
                  <DonePostRow key={p.id} post={p} tz={status?.timezone} onOpen={sheet.show} />
                ))}
              </ul>
            );
          }
          const groups = byGroup(posts, now.day);
          if (posts.length === 0) return <LifeEmpty>{EMPTY.posts}</LifeEmpty>;
          return (
            <>
              {GROUP_ORDER.map((g) =>
                groups[g].length ? (
                  <section key={g} aria-label={GROUP_LABEL[g]}>
                    <RailLabel ground="bg" count={groups[g].length}>
                      {GROUP_LABEL[g]}
                    </RailLabel>
                    <ul>
                      {groups[g].map((p) => (
                        <PostRow key={p.id} post={p} group={g} today={now.day} offline={offline} actions={actions} onOpen={sheet.show} />
                      ))}
                    </ul>
                  </section>
                ) : null,
              )}
            </>
          );
        }}
      </Loaded>
      {week ? (
        <div className="flex items-center gap-12 px-16 pt-12">
          {addButton}
          <span className="ml-auto type-mono text-ink-3">Posted this week: {week.posted}</span>
        </div>
      ) : null}
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
    </Page>
  );
}
