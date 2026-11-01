/**
 * Posts on the phone (v0.7 spec 5.2): which group a post to make sits
 * under, what its row says, the week line against the goals, and when a
 * done one was posted. Pure functions over day keys on the Life clock (the
 * daemon's own day and zone). Jantar never posts: these only describe the
 * plan the user posts by hand.
 */
import { POST_KIND_LABEL, POST_PLATFORM_LABEL, postGoalLabels, type Post, type PostsResponse } from '@jantar/protocol';
import { dayLabel, shiftDayKey } from '../shared/DayNav.js';
import { clockIn } from '../today/parts.js';

export type PostGroup = 'late' | 'today' | 'tomorrow' | 'later' | 'none';

export const GROUP_ORDER: readonly PostGroup[] = ['late', 'today', 'tomorrow', 'later', 'none'];

export const GROUP_LABEL: Record<PostGroup, string> = {
  late: 'Late',
  today: 'Today',
  tomorrow: 'Tomorrow',
  later: 'Later',
  none: 'No date',
};

/** Late is due before today; a time already past today stays under Today (its check is ember either way). */
export function groupOf(post: Pick<Post, 'due'>, today: string): PostGroup {
  if (!post.due) return 'none';
  if (post.due.day < today) return 'late';
  if (post.due.day === today) return 'today';
  return post.due.day === shiftDayKey(today, 1) ? 'tomorrow' : 'later';
}

/** The posts to make under their groups, each in the daemon's order (due, then created). */
export function byGroup(posts: readonly Post[], today: string): Record<PostGroup, Post[]> {
  const out: Record<PostGroup, Post[]> = { late: [], today: [], tomorrow: [], later: [], none: [] };
  for (const p of posts) out[groupOf(p, today)].push(p);
  return out;
}

/** Due today or before, so its row has Copy and Open, and its check is ember. */
export function dueNow(post: Pick<Post, 'due'>, today: string): boolean {
  return post.due !== undefined && post.due.day <= today;
}

/** "Reddit · r/exampletools"; with no where, the kind: "Instagram · Reel". Platform Other names the kind first. */
export function postLabel(post: Pick<Post, 'platform' | 'kind' | 'where'>): string {
  const kind = POST_KIND_LABEL[post.kind][0];
  if (post.platform === 'other') return post.where ? `${kind} · ${post.where}` : kind;
  return `${POST_PLATFORM_LABEL[post.platform]} · ${post.where ?? kind}`;
}

/** The row's second line: the title, else the text's first line (never the notes). */
export function postLine(post: Pick<Post, 'title' | 'text'>): string {
  if (post.title) return post.title;
  return post.text?.split('\n').find((l) => l.trim())?.trim() ?? '';
}

/** What Copy on a row copies: the text, else the title. */
export function copyOf(post: Pick<Post, 'title' | 'text'>): string | undefined {
  return post.text ?? post.title;
}

/** Each goal against the week: ["Reels 1/3", "Reddit 2/6"]. */
export function weekGoals(week: PostsResponse['week']): string[] {
  const names = postGoalLabels(week.goals);
  return week.goals.map((g, i) => `${names[i]} ${g.done}/${g.perWeek}`);
}

/** "This week: Reels 1/3 · Reddit 2/6", or null with no goal. */
export function weekLine(week: PostsResponse['week']): string | null {
  const goals = weekGoals(week);
  return goals.length ? `This week: ${goals.join(' · ')}` : null;
}

/** "Posted Mon 2 Nov 19:41" on the Life clock, or "Skipped". */
export function doneText(post: Pick<Post, 'status' | 'postedAt'>, tz?: string | null): string {
  if (post.status === 'skipped') return 'Skipped';
  const t = post.postedAt ? Date.parse(post.postedAt) : NaN;
  if (!Number.isFinite(t)) return 'Posted';
  const c = clockIn(t, tz);
  return `Posted ${dayLabel(c.day)} ${c.hhmm}`;
}
