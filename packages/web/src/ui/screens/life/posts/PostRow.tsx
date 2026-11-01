/**
 * One post (v0.7 spec 5.2). To post: a square that marks it Posted (a 5 s
 * Undo puts its status back), `Reddit · r/exampletools` with the time (the
 * day under Late and Later) and an `Idea` or `Ready` tag, then the title or
 * the text's first line. A post due today or before has Copy (the text,
 * else the title) and Open (only with an https link) on its row, and its
 * square is ember (design rule 3: what needs you now). A tap elsewhere opens
 * the sheet. Notes never show on a row.
 *
 * Done: "Posted Mon 2 Nov 19:41" or "Skipped", and Open for the posted link.
 *
 * Copy writes to the clipboard on the user's tap; Open is a new tab with no
 * opener and no referrer. Jantar never posts anything anywhere.
 */
import { CheckIcon, MinusIcon, SquareIcon } from '@phosphor-icons/react';
import { POST_LINK_MAX, type Post } from '@jantar/protocol';
import { Button, buttonClass } from '../../../kit/Button.js';
import { IconButton } from '../../../kit/IconButton.js';
import { Tag } from '../../../kit/Tag.js';
import { copyText, useFlash } from '../../devices/parts.js';
import { dayLabel } from '../shared/DayNav.js';
import { linkOk, OpenLink } from '../shared/links.js';
import { copyOf, doneText, dueNow, postLabel, postLine, type PostGroup } from './model.js';
import type { PostActions } from './Posts.js';

const COPY = 'Copy';

/** Copy `value` on a tap: "Copied" or "Could not copy" for 2 s. `name` says what it copies ("Copy the text"). */
export function CopyButton({ value, name, className }: { value: string | undefined; name: string; className?: string }) {
  const [said, say] = useFlash(COPY);
  return (
    <Button
      variant="text"
      size="sm"
      className={className}
      disabled={!value}
      aria-label={said === COPY ? name : said}
      onClick={() => {
        if (value) void copyText(value).then((ok) => say(ok ? 'Copied' : 'Could not copy'));
      }}
    >
      {said}
    </Button>
  );
}

const OPEN = buttonClass('text', 'sm');

export interface PostRowProps {
  post: Post;
  /** Its group: Late and Later say the day, Today and Tomorrow the time. */
  group: PostGroup;
  /** The Life clock's day. */
  today: string;
  offline: boolean;
  actions: PostActions;
  onOpen: (post: Post) => void;
}

export function PostRow({ post, group, today, offline, actions, onOpen }: PostRowProps) {
  const label = postLabel(post);
  const now = dueNow(post, today);
  const when = post.due ? (group === 'late' || group === 'later' ? dayLabel(post.due.day) : post.due.time) : undefined;
  const line = postLine(post);
  return (
    <li data-post={post.id} className="flex items-start gap-4 border-b border-line px-8 py-6">
      <IconButton
        aria-label={`Mark posted: ${label}`}
        className={now ? 'text-signal-text' : undefined}
        disabled={offline || actions.busy.has(post.id)}
        onClick={() => actions.mark(post, 'posted')}
      >
        <SquareIcon size={18} aria-hidden="true" />
      </IconButton>
      <div className="min-w-0 flex-1">
        <button type="button" className="block w-full py-4 pr-8 text-left coarse:min-h-44 coarse:py-10" onClick={() => onOpen(post)}>
          <span className="flex items-baseline gap-8">
            <span className="min-w-0 truncate type-row text-ink">{label}</span>
            {when ? <span className="flex-none type-mono text-ink-2">{when}</span> : null}
            <Tag className="ml-auto">{post.status === 'ready' ? 'Ready' : 'Idea'}</Tag>
          </span>
          {line ? <span className="mt-2 block truncate type-small text-ink-2">{line}</span> : null}
        </button>
        {/* Due now: Copy and Open on a line of their own, so the row keeps its words. */}
        {now ? (
          <span className="-ml-8 flex items-center gap-4 pb-2">
            <CopyButton value={copyOf(post)} name={`Copy: ${label}`} />
            {post.link && linkOk(post.link, POST_LINK_MAX) ? <OpenLink url={post.link} label="Open" name={`Open: ${label}`} className={OPEN} /> : null}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** A posted or skipped post: when, and Open for the posted link. A tap opens the sheet (Not posted is there). */
export function DonePostRow({ post, tz, onOpen }: { post: Post; tz?: string | null | undefined; onOpen: (post: Post) => void }) {
  const label = postLabel(post);
  const line = postLine(post);
  const Glyph = post.status === 'posted' ? CheckIcon : MinusIcon;
  return (
    <li data-post={post.id} className="flex items-start gap-4 border-b border-line px-8 py-6">
      <span className="inline-flex size-28 flex-none items-center justify-center text-ink-3 coarse:size-44">
        <Glyph size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <button type="button" className="block w-full py-4 pr-8 text-left coarse:min-h-44 coarse:py-10" onClick={() => onOpen(post)}>
          <span className="flex items-baseline gap-8">
            <span className="min-w-0 truncate type-row text-ink-3">{label}</span>
            <span className="ml-auto flex-none type-mono text-ink-3">{doneText(post, tz)}</span>
          </span>
          {line ? <span className="mt-2 block truncate type-small text-ink-3">{line}</span> : null}
        </button>
        {post.postedUrl && linkOk(post.postedUrl, POST_LINK_MAX) ? (
          <span className="-ml-8 flex items-center pb-2">
            <OpenLink url={post.postedUrl} label="Open" name={`Open the posted link: ${label}`} className={OPEN} />
          </span>
        ) : null}
      </div>
    </li>
  );
}
