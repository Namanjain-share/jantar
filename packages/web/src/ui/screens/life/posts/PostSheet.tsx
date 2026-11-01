/**
 * The post sheet (v0.7 spec 5.3), to add or edit one: Platform and Kind,
 * Where (one line), Title with Copy, Text with Copy (a count once past
 * 18,000), Notes (flair, media, rules: never copied, never on a row), Link
 * with Open (https only), Day and Time (a time makes it ring; No date
 * clears both) and Status [ Idea | Ready ].
 *
 * Save sends only what changed (null clears). Mark posted sends that with
 * the status and keeps the sheet open in its posted state: "Posted at
 * 19:41", a Posted link with Open, and Not posted (back to Ready: the Mac
 * clears the time and the link). Skip and Delete close the sheet and leave
 * their Undo on the list. Every write is off while offline.
 *
 * Copy writes to the clipboard on the user's tap (the text stays selectable
 * for a manual copy); Open is a new tab with no opener and no referrer.
 * Jantar never posts anything anywhere.
 */
import { useId, useState, type FormEvent } from 'react';
import {
  POST_KIND_LABEL,
  POST_KINDS,
  POST_LINK_MAX,
  POST_PLATFORM_LABEL,
  POST_PLATFORMS,
  POST_TEXT_MAX,
  PostTitleSchema,
  PostWhereSchema,
  type Post,
  type PostBody,
  type PostKind,
  type PostPatch,
  type PostPlatform,
} from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { Sheet } from '../../../kit/Sheet.js';
import { Spinner } from '../../../kit/Spinner.js';
import { Segmented } from '../../accounts/Segmented.js';
import { dayLabel } from '../shared/DayNav.js';
import { linkOk, OpenLink } from '../shared/links.js';
import { NotSaved } from '../shared/states.js';
import { clockIn, Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite, type LifeClock } from '../today/parts.js';
import { CopyButton } from './PostRow.js';

/** The text's count shows past this. */
const COUNT_FROM = 18_000;
const ONE_LINE = 'Use one line, with no special characters.';
const HTTPS = 'Use a link that starts with https://';

export interface PostSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A fresh number per opening (the form starts over). */
  sheetKey: number;
  /** null: a new post. */
  post: Post | null;
  now: LifeClock;
  /** The Life zone, for when it was posted. */
  tz?: string | null | undefined;
  onSaved: () => void;
  /** Skip: the list sends it with `changes` (what was edited) and offers Undo. */
  onSkip: (post: Post, changes: PostPatch) => void;
  /** Delete: the list takes it out at once and sends the delete once its Undo goes. */
  onDelete: (post: Post) => void;
}

export function PostSheet({ open, onOpenChange, sheetKey, post, now, tz, onSaved, onSkip, onDelete }: PostSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={post ? 'Edit post' : 'New post'}>
      <PostForm key={sheetKey} post={post} now={now} tz={tz} onSaved={onSaved} onSkip={onSkip} onDelete={onDelete} onDone={() => onOpenChange(false)} />
    </Sheet>
  );
}

const lineOk = (schema: typeof PostWhereSchema, v: string) => v.trim() === '' || schema.safeParse(v).success;
const linkFine = (v: string) => v.trim() === '' || linkOk(v.trim(), POST_LINK_MAX);

function PostForm({
  post,
  now,
  tz,
  onSaved,
  onSkip,
  onDelete,
  onDone,
}: Omit<PostSheetProps, 'open' | 'onOpenChange' | 'sheetKey'> & { onDone: () => void }) {
  const { api, now: clock = Date.now } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  // The post as last saved from here: what an edit is measured against.
  const [base, setBase] = useState<Post | null>(post);
  const [platform, setPlatform] = useState<PostPlatform>(post?.platform ?? 'reddit');
  const [kind, setKind] = useState<PostKind>(post?.kind ?? 'post');
  const [where, setWhere] = useState(post?.where ?? '');
  const [title, setTitle] = useState(post?.title ?? '');
  const [text, setText] = useState(post?.text ?? '');
  const [notes, setNotes] = useState(post?.notes ?? '');
  const [link, setLink] = useState(post?.link ?? '');
  const [day, setDay] = useState(post?.due?.day ?? '');
  const [time, setTime] = useState(post?.due?.time ?? '');
  // A new post starts as an idea; a posted or skipped one goes back to Ready.
  const [status, setStatus] = useState<'idea' | 'ready'>(post?.status === 'ready' ? 'ready' : 'idea');
  const [postedUrl, setPostedUrl] = useState(post?.postedUrl ?? '');

  const badWhere = !lineOk(PostWhereSchema, where);
  const badTitle = !lineOk(PostTitleSchema, title);
  const badLink = !linkFine(link);
  const badPosted = !linkFine(postedUrl);
  const ok = !badWhere && !badTitle && !badLink && !badPosted;
  const due = day ? { day, ...(time ? { time } : {}) } : null;
  const done = base && (base.status === 'posted' || base.status === 'skipped') ? base.status : null;
  const busy = w.busy || offline;

  /** What was edited, against `base` (null clears a field). */
  const changes = (b: Post): PostPatch => {
    const p: PostPatch = {};
    // The text and the notes keep their own lines and spaces (the Mac trims their ends); the one-liners go trimmed.
    const field = (k: 'where' | 'title' | 'text' | 'notes' | 'link', v: string, trim = true) => {
      const next = v.trim() ? (trim ? v.trim() : v) : undefined;
      if (next !== b[k]) p[k] = next ?? null;
    };
    if (platform !== b.platform) p.platform = platform;
    if (kind !== b.kind) p.kind = kind;
    field('where', where);
    field('title', title);
    field('text', text, false);
    field('notes', notes, false);
    field('link', link);
    if (JSON.stringify(due) !== JSON.stringify(b.due ?? null)) p.due = due;
    return p;
  };

  /** Send `patch` for the post shown; on success the sheet measures from what was sent (`stamp` sets the status and its time). */
  const send = async (patch: PostPatch, stamp: (p: Post) => Post = (p) => p): Promise<boolean> => {
    if (!base) return false;
    if (Object.keys(patch).length === 0) return true;
    const r = await w.run(JSON.stringify(patch), (key) => api.postUpdate(base.id, patch, key));
    if (!r.ok) return false;
    const next: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    setBase(stamp(next as Post));
    onSaved();
    return true;
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    if (!base) {
      const body: PostBody = {
        platform,
        kind,
        status,
        ...(where.trim() ? { where: where.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(text.trim() ? { text } : {}),
        ...(notes.trim() ? { notes } : {}),
        ...(link.trim() ? { link: link.trim() } : {}),
        ...(due ? { due } : {}),
      };
      const r = await w.run(JSON.stringify(body), (key) => api.postCreate(body, key));
      if (!r.ok) return;
      onSaved();
      onDone();
      return;
    }
    const patch = changes(base);
    if (!done && status !== base.status) patch.status = status;
    if (base.status === 'posted' && postedUrl.trim() !== (base.postedUrl ?? '')) patch.postedUrl = postedUrl.trim() || null;
    if (await send(patch)) onDone();
  };

  const markPosted = () => {
    if (!base || !ok || busy) return;
    void send({ ...changes(base), status: 'posted' }, (p) => ({ ...p, postedAt: new Date(clock()).toISOString() }));
  };
  const back = () => {
    if (!base || !ok || busy) return;
    // Out of posted the Mac clears the time and the posted link.
    void send({ ...changes(base), status: 'ready' }, ({ postedAt: _at, postedUrl: _url, ...p }) => p).then((sent) => {
      if (!sent) return;
      setStatus('ready');
      setPostedUrl('');
    });
  };
  const skip = () => {
    if (!base || !ok || busy) return;
    onSkip(base, changes(base));
    onDone();
  };
  const remove = () => {
    if (!base) return;
    onDelete(base);
    onDone();
  };

  const posted = () => {
    const t = base?.postedAt ? Date.parse(base.postedAt) : NaN;
    if (!Number.isFinite(t)) return 'Posted';
    const c = clockIn(t, tz);
    return c.day === now.day ? `Posted at ${c.hhmm}` : `Posted ${dayLabel(c.day)} ${c.hhmm}`;
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={base ? 'Edit post' : 'New post'}>
      {done === 'posted' ? (
        <div className="border-b border-line pb-8">
          <div className="flex min-h-44 items-center gap-8">
            <p className="type-row text-ink">{posted()}</p>
            <Button variant="text" size="sm" className="ml-auto" disabled={busy} onClick={back}>
              Not posted
            </Button>
          </div>
          <Field label="Posted link" htmlFor={`${id}-posted`} aside={badPosted ? null : <OpenLink url={postedUrl.trim()} />}>
            <input
              id={`${id}-posted`}
              className={INPUT}
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://"
              value={postedUrl}
              maxLength={POST_LINK_MAX}
              aria-invalid={badPosted}
              onChange={(e) => setPostedUrl(e.target.value)}
            />
          </Field>
          {badPosted ? <p className="type-small text-ink-2">{HTTPS}</p> : null}
        </div>
      ) : done === 'skipped' ? (
        <div className="flex min-h-44 items-center gap-8 border-b border-line pb-8">
          <p className="type-row text-ink">Skipped</p>
          <Button variant="text" size="sm" className="ml-auto" disabled={busy} onClick={back}>
            Not skipped
          </Button>
        </div>
      ) : null}
      <div className="flex gap-8">
        <Field label="Platform" htmlFor={`${id}-platform`} className="min-w-0 flex-1">
          <select id={`${id}-platform`} className={INPUT} value={platform} onChange={(e) => setPlatform(e.target.value as PostPlatform)}>
            {POST_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {POST_PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind" htmlFor={`${id}-kind`} className="min-w-0 flex-1">
          <select id={`${id}-kind`} className={INPUT} value={kind} onChange={(e) => setKind(e.target.value as PostKind)}>
            {POST_KINDS.map((k) => (
              <option key={k} value={k}>
                {POST_KIND_LABEL[k][0]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Where" htmlFor={`${id}-where`}>
        <input
          id={`${id}-where`}
          className={INPUT}
          value={where}
          maxLength={80}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="r/subreddit, @account or a page"
          aria-invalid={badWhere}
          onChange={(e) => setWhere(e.target.value)}
        />
      </Field>
      {badWhere ? <p className="type-small text-ink-2">{ONE_LINE}</p> : null}
      <Field label="Title" htmlFor={`${id}-title`} aside={<CopyButton value={title.trim() || undefined} name="Copy the title" />}>
        <input id={`${id}-title`} className={INPUT} value={title} maxLength={300} autoComplete="off" aria-invalid={badTitle} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {badTitle ? <p className="type-small text-ink-2">{ONE_LINE}</p> : null}
      <Field
        label="Text"
        htmlFor={`${id}-text`}
        aside={
          <span className="flex items-center gap-8">
            {text.length > COUNT_FROM ? (
              <span className="type-mono text-ink-3">
                {text.length.toLocaleString('en-US')} / {POST_TEXT_MAX.toLocaleString('en-US')}
              </span>
            ) : null}
            <CopyButton value={text.trim() || undefined} name="Copy the text" />
          </span>
        }
      >
        <textarea id={`${id}-text`} className={TEXTAREA} value={text} maxLength={POST_TEXT_MAX} rows={6} placeholder="Text or caption" onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} className={TEXTAREA} value={notes} maxLength={2000} rows={2} placeholder="Flair, media, rules: never copied" onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field label="Link" htmlFor={`${id}-link`} aside={badLink ? null : <OpenLink url={link.trim()} label="Open" />}>
        <input
          id={`${id}-link`}
          className={INPUT}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https:// where it gets posted"
          value={link}
          maxLength={POST_LINK_MAX}
          aria-invalid={badLink}
          onChange={(e) => setLink(e.target.value)}
        />
      </Field>
      {badLink ? <p className="type-small text-ink-2">{HTTPS}</p> : null}
      <Field label="When" id={`${id}-due`}>
        <div role="group" aria-labelledby={`${id}-due`} className="flex items-center gap-8">
          <input
            type="date"
            aria-label="Day"
            className={INPUT}
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
              if (!e.target.value) setTime('');
            }}
          />
          <input type="time" aria-label="Time" className={INPUT} value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} />
          {day ? (
            <Button
              variant="text"
              size="sm"
              onClick={() => {
                setDay('');
                setTime('');
              }}
            >
              No date
            </Button>
          ) : null}
        </div>
      </Field>
      {done ? null : (
        <Field label="Status">
          <Segmented<'idea' | 'ready'>
            label="Status"
            fill
            value={status}
            onChange={setStatus}
            segments={[
              { key: 'idea', label: 'Idea' },
              { key: 'ready', label: 'Ready' },
            ]}
          />
        </Field>
      )}
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || busy}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {base ? 'Save' : 'Add post'}
        </Button>
        {base && !done ? (
          <Button size="lg" disabled={!ok || busy} onClick={markPosted}>
            Mark posted
          </Button>
        ) : null}
        {base && !done ? (
          <Button variant="text" size="lg" disabled={!ok || busy} onClick={skip}>
            Skip
          </Button>
        ) : null}
        {base ? (
          <Button variant="text" size="lg" disabled={busy} onClick={remove}>
            Delete
          </Button>
        ) : (
          <Button variant="text" size="lg" onClick={onDone}>
            Cancel
          </Button>
        )}
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
