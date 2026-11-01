/**
 * Post pings (v0.7): a post with a day and a time rings like a todo. One
 * `post` row per open (idea or ready) timed post, sub '', set and cleared by
 * the todo ring's own rules (todos/pings.ts `armRing`): a post rings once per
 * due time; a time this write gave it rings when ahead or a few seconds
 * gone; posted, skipped and deleted posts clear their row; an Undo after the
 * time never rings again.
 *
 * - check: gone, or no longer ringing (posted, skipped, no time): cancel;
 *   its due time moved since the row was set: skip; else send.
 * - Every post due in the same minute goes out as one push (`group`), as
 *   medicines due at one time do: "Post due" or "Posts due · n".
 * - The lock screen follows life.lockScreenDetails, as medicines and bills
 *   do. Off (the default): "Tap to open · 19:30". On: "Post on Reddit ·
 *   r/exampletools · 19:30", or for several the platforms and where, each
 *   once. The title, the text and the notes never reach a push.
 *   "Missed at HH:MM · " comes first on a catch-up. Tap: /posts?id=<id>, or
 *   /posts for several.
 */
import { hhmmOf } from '@jantar/life-core';
import { POST_KIND_LABEL, POST_PLATFORM_LABEL, type Post, type PostStatus } from '@jantar/protocol';
import type { LifeCore, LifePush, PingHandler, PingRow } from '../../contracts.js';
import { clip, oneLine } from '../../notify/format.js';
import { armRing, ringAt, ringsAt, type ArmOptions, type Ringable } from '../todos/pings.js';
import type { PostsRepo } from './repo.js';

/** How much of `where` a lock screen shows. */
export const WHERE_MAX = 40;

/** Idea and ready posts are still to make: they ring and count against the cap. */
export const isOpen = (s: PostStatus): boolean => s === 'idea' || s === 'ready';

/** A post as the todo ring sees it: posted or skipped is done. */
export function ringable(p: Post): Ringable {
  return { id: p.id, due: p.due, doneAt: isOpen(p.status) ? undefined : p.updatedAt };
}

/** Sets or clears a post's row (armRing for kind `post`). The caller pokes. */
export function armPost(core: Pick<LifeCore, 'scheduler' | 'tz' | 'now'>, p: Post, armed: string | null, opts: ArmOptions = {}): void {
  armRing(core, 'post', ringable(p), armed, opts);
}

const whereOf = (p: Post): string => (p.where ? ` · ${clip(oneLine(p.where), WHERE_MAX)}` : '');

/** "Reel on Instagram · @example.studio"; for platform other, "Reel · @example.studio". */
function oneLabel(p: Post): string {
  const kind = POST_KIND_LABEL[p.kind][0];
  return p.platform === 'other' ? `${kind}${whereOf(p)}` : `${kind} on ${POST_PLATFORM_LABEL[p.platform]}${whereOf(p)}`;
}

/**
 * The push for the posts due at `dueAt` (`posts[i]` is `ids[i]`'s post, null
 * when it could not be read). `details`: life.lockScreenDetails.
 */
export function postPush(posts: readonly (Post | null)[], ids: readonly string[], dueAt: Date, late: boolean, tz: string, details: boolean): LifePush {
  const time = hhmmOf(dueAt, tz);
  const n = ids.length;
  const one = n === 1 ? ids[0] : undefined;
  let body = `Tap to open · ${time}`;
  if (details) {
    const known = posts.filter((p): p is Post => p !== null);
    if (one !== undefined && known[0]) body = `${oneLabel(known[0])} · ${time}`;
    else if (one === undefined && known.length > 0) {
      const labels = [...new Set(known.map((p) => `${POST_PLATFORM_LABEL[p.platform]}${whereOf(p)}`))].sort((a, b) => a.localeCompare(b));
      body = `${labels.join(', ')} · ${time}`;
    }
  }
  if (late) body = `Missed at ${time} · ${body}`;
  return {
    kind: 'life',
    title: n === 1 ? 'Post due' : `Posts due · ${n}`,
    body,
    url: one !== undefined ? `/posts?id=${one}` : '/posts',
    tag: one !== undefined ? `life:post:${one}` : `posts:${time}`,
  };
}

export function postPingHandler(core: LifeCore, repo: PostsRepo): PingHandler {
  const read = (id: string): Post | null => {
    try {
      return repo.get(id);
    } catch {
      return null;
    }
  };
  return {
    kind: 'post',
    group: () => '',
    check(row, dueAt) {
      const p = repo.get(row.ref);
      if (!p || !ringAt(ringable(p), core.tz())) return 'cancel';
      return ringsAt(ringable(p), dueAt, core.tz()) ? 'send' : 'skip';
    },
    push(rows: readonly PingRow[], dueAt, late) {
      const ids = rows.map((r) => r.ref);
      const details = core.settings().lockScreenDetails;
      // The generic body needs no read: a post that cannot be read still rings with the time.
      return postPush(details ? ids.map(read) : [], ids, dueAt, late, core.tz(), details);
    },
    next(row, after) {
      const p = repo.get(row.ref);
      const at = p ? ringAt(ringable(p), core.tz()) : null;
      return at && at.getTime() > after.getTime() ? at : null;
    },
    resync() {
      const armed = repo.pingTimes();
      const ringing = new Set<string>();
      for (const p of repo.openTimed()) {
        armPost(core, p, armed.get(p.id) ?? null);
        ringing.add(p.id);
      }
      for (const ref of armed.keys()) if (!ringing.has(ref)) core.scheduler.clear('post', ref);
    },
  };
}
