/**
 * A post beside the list (0.11, build plan 2.6): what the sheet shows, laid
 * out to read and to act on, from a pane of 800. Below that `?id=` opens
 * the post's sheet over the list, as 0.10 did.
 *
 *   Reddit · r/exampletools                                  Close / Edit
 *   ┌ the post ─────────────────────────────┐  ┌ NOTES ───────────────┐
 *   │ Ready · due Mon 2 Nov 18:00           │  │ flair, the sub's rules│
 *   │ Its title                             │  └──────────────────────┘
 *   │ The text, in the reading type (≤ 680) │  ┌ COMMENTS IN R/… ─────┐
 *   │ [Copy]  [Mark posted]  Open           │  │ logged there, newest │
 *   └───────────────────────────────────────┘  └──────────────────────┘
 *   [Link to your comment  https://…]  [Log comment]   pinned to the bottom
 *
 * The side column (300) sits beside the post from a pane of 900, under it
 * below that.
 *
 * Copy (the text, else the title) is the primary action: Jantar never posts,
 * the user pastes it. Mark posted keeps 0.10's 5 s Undo and goes back to the
 * list. The comment field takes the link to a comment the user already made
 * (as Log a comment does: the platform and where come from the link alone,
 * never fetched) and Return or ⌘Return logs it; what was typed is kept in the
 * drafts store (`post:<id>:comment`) until the Mac has it.
 */
import { POST_LINK_MAX, PostBodySchema, postPlaceOf, type Post, type PostBody } from '@jantar/protocol';
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { clearDraft, useDraft } from '../../../../lib/drafts.js';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { PaneClose, usePaneClose } from '../../../kit/PaneClose.js';
import { Panel } from '../../../kit/Panel.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Tag } from '../../../kit/Tag.js';
import { dayLabel } from '../shared/DayNav.js';
import { linkOk, OpenLink } from '../shared/links.js';
import { LifeEmpty, LifeLoading, NotSaved } from '../shared/states.js';
import { useLifeLoad } from '../shared/useLife.js';
import { INPUT, Page, useOffline, useWrite } from '../today/parts.js';
import { copyOf, doneText, postLabel } from './model.js';
import type { PostActions } from './Posts.js';
import { CopyButton, OPEN } from './PostRow.js';
import { useLookingAt } from '../../../shell/lookingAt.js';
import { dialogOpen, isTyping, useKey } from '../../../shell/keys.js';
import { useLayout } from '../../../shell/layout.js';

/** The comments shown under a post: at most this many, newest first. */
const COMMENTS = 5;

export interface PostDetailProps {
  id: string;
  /** The post from the list's last answer; undefined while it loads, or once it is done or gone. */
  post: Post | undefined;
  /** The list has answered: a post it lacks is done or gone. */
  loaded: boolean;
  tz?: string | null | undefined;
  actions: PostActions;
  onEdit: (post: Post) => void;
  /** Back to the list (after Mark posted). */
  onClose: () => void;
}

/** The comments logged in `post`'s place: same platform, same where (any where when it has none). */
export function commentsFor(post: Pick<Post, 'id' | 'platform' | 'where'>, done: readonly Post[]): Post[] {
  return done
    .filter((c) => c.id !== post.id && c.kind === 'comment' && c.status === 'posted' && c.platform === post.platform && (!post.where || c.where === post.where))
    .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
}

export function PostDetail({ id, post, loaded, tz, actions, onEdit, onClose }: PostDetailProps) {
  const close = usePaneClose();
  const back = close ? (
    <div className="flex">
      <PaneClose onClick={close} className="ml-auto" />
    </div>
  ) : null;
  if (!post)
    return (
      <Page title="Post" back={back} undo={actions.undo} wide>
        {loaded ? <LifeEmpty>This post is done or gone.</LifeEmpty> : <LifeLoading count={2} />}
      </Page>
    );
  return <Body key={id} post={post} back={back} tz={tz} actions={actions} onEdit={onEdit} onClose={onClose} />;
}

function Body({ post, back, tz, actions, onEdit, onClose }: Omit<PostDetailProps, 'id' | 'post' | 'loaded'> & { post: Post; back: ReactNode }) {
  const { api } = useDeps();
  const offline = useOffline();
  const done = useLifeLoad('posts:done', () => api.postsList('done'));
  const label = postLabel(post);
  useLookingAt({ kind: 'post', id: post.id, label });
  const open = post.status === 'idea' || post.status === 'ready';
  // c30: m marks it posted, l goes to the comment field, ⌘C with no text selected copies the post.
  const article = useRef<HTMLElement>(null);
  const keys = useLayout().keyboard;
  useKey(
    ['m', 'l'],
    (e) => {
      if (dialogOpen()) return;
      e.preventDefault();
      if (e.key === 'l') document.querySelector<HTMLInputElement>('form[aria-label="Log a comment"] input')?.focus();
      else if (open && !offline && !actions.busy.has(post.id)) {
        actions.mark(post, 'posted');
        onClose();
      }
    },
    keys,
  );
  useEffect(() => {
    if (!keys) return;
    const on = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || (e.key.toLowerCase() !== 'c' && e.code !== 'KeyC')) return;
      if (isTyping(e.target) || dialogOpen() || (window.getSelection()?.toString() ?? '') !== '') return;
      const copy = article.current?.querySelector('button');
      if (!copy) return;
      e.preventDefault();
      copy.click();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [keys]);
  const due = post.due ? `due ${dayLabel(post.due.day)}${post.due.time ? ` ${post.due.time}` : ''}` : 'no date';
  const comments = commentsFor(post, done.data?.posts ?? []);
  const place = post.where ? `Comments in ${post.where}` : 'Comments';
  return (
    <Page
      title={label}
      wrapTitle
      back={back}
      aside={
        <Button size="sm" className="coarse:min-w-44" disabled={offline} onClick={() => onEdit(post)}>
          Edit
        </Button>
      }
      undo={actions.undo}
      wide
    >
      {/* From 900 the post reads on the left and its notes and comments stay beside it. */}
      <div className="grid gap-16 px-16 pb-16 @wide:grid-cols-[minmax(0,1fr)_300px] @wide:items-start">
        <article ref={article} aria-label="The post" className="min-w-0 rounded-dock border border-line bg-raised px-16 pb-16 pt-12">
          <p className="flex flex-wrap items-center gap-8 type-mono text-ink-2">
            <Tag>{post.status === 'ready' ? 'Ready' : post.status === 'idea' ? 'Idea' : post.status === 'posted' ? 'Posted' : 'Skipped'}</Tag>
            {open ? due : doneText(post, tz)}
          </p>
          <div className="max-w-680">
            {post.title ? <h2 className="mt-16 break-words type-title text-ink">{post.title}</h2> : null}
            {post.text ? <p className="mt-12 whitespace-pre-wrap break-words type-read text-ink">{post.text}</p> : null}
            {!post.title && !post.text ? <p className="mt-12 type-small text-ink-3">No text yet. Edit adds it.</p> : null}
          </div>
          <div className="mt-16 flex flex-wrap items-center gap-8">
            <CopyButton primary value={copyOf(post)} name={`Copy: ${label}`} />
            {open ? (
              <Button
                disabled={offline || actions.busy.has(post.id)}
                onClick={() => {
                  actions.mark(post, 'posted');
                  onClose();
                }}
              >
                Mark posted
              </Button>
            ) : null}
            {post.link && linkOk(post.link, POST_LINK_MAX) ? <OpenLink url={post.link} label="Open" name={`Open: ${label}`} className={OPEN} /> : null}
            {post.postedUrl && linkOk(post.postedUrl, POST_LINK_MAX) ? <OpenLink url={post.postedUrl} label="Open the posted link" name={`Open the posted link: ${label}`} className={OPEN} /> : null}
          </div>
          {actions.error ? <NotSaved error={actions.error} /> : null}
        </article>
        <div className="grid min-w-0 gap-16">
          {post.notes ? (
            <Panel label="Notes" card>
              <p className="whitespace-pre-wrap break-words px-16 py-12 type-small text-ink-2">{post.notes}</p>
            </Panel>
          ) : null}
          <Panel label={place} count={done.data ? comments.length : undefined} card>
            {comments.length === 0 ? (
              <p className="px-16 py-12 type-small text-ink-3">{done.data ? 'No comments logged here yet.' : 'Loading…'}</p>
            ) : (
              <ul aria-label={place}>
                {comments.slice(0, COMMENTS).map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-12 border-b border-line px-16 py-8">
                    <span className="min-w-0 flex-1 truncate type-small text-ink-2">{c.text?.split('\n')[0] || postLabel(c)}</span>
                    <span className="type-mono text-ink-3">{doneText(c, tz)}</span>
                    {c.postedUrl && linkOk(c.postedUrl, POST_LINK_MAX) ? <OpenLink url={c.postedUrl} label="Open" name={`Open the comment: ${postLabel(c)}`} className={OPEN} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      <LogBar
        post={post}
        onLogged={(id, what) => {
          done.reload();
          actions.logged(id, what);
        }}
      />
    </Page>
  );
}

/** The comment field pinned to the pane's bottom: the link to a comment already made, logged as posted now. */
function LogBar({ post, onLogged }: { post: Post; onLogged: (id: string, label: string) => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const field = useId();
  const key = `post:${post.id}:comment`;
  const [link, setLink] = useDraft(key);
  const place = link.trim() ? postPlaceOf(link) : null;
  const where = place?.where ?? (place?.platform === post.platform ? post.where : undefined);
  const body: PostBody | null = place ? { platform: place.platform, kind: 'comment', status: 'posted', postedUrl: link.trim(), ...(where ? { where } : {}) } : null;
  const ok = body !== null && PostBodySchema.safeParse(body).success;
  const what = place ? postLabel({ platform: place.platform, kind: 'comment', ...(where ? { where } : {}) }) : '';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!body || !ok || w.busy || offline) return;
    const r = await w.run(JSON.stringify(body), (k) => api.postCreate(body, k));
    if (!r.ok) return;
    clearDraft(key);
    setLink('');
    onLogged(r.value.id, what);
  };
  return (
    <form onSubmit={(e) => void save(e)} aria-label="Log a comment" className="sticky bottom-0 z-2 mt-16 border-t border-line bg-bg px-16 pb-12 pt-8">
      <label htmlFor={field} className="block pb-4 type-small text-ink-2">
        Log a comment: paste the link to one you made
      </label>
      <div className="flex items-center gap-8">
        <input
          id={field}
          className={INPUT}
          type="url"
          inputMode="url"
          enterKeyHint="done"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://"
          value={link}
          maxLength={POST_LINK_MAX}
          aria-invalid={link.trim() !== '' && !place}
          onChange={(e) => {
            setLink(e.target.value);
            w.clear();
          }}
        />
        <Button type="submit" className="flex-none" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          Log comment
        </Button>
      </div>
      {place ? <p className="pt-4 type-mono text-ink-2">{what}</p> : link.trim() ? <p className="pt-4 type-small text-ink-2">Use a link that starts with https://</p> : null}
      {w.error ? <NotSaved error={w.error} /> : null}
    </form>
  );
}
