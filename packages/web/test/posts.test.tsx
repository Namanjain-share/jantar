/**
 * Posts (v0.7 spec 5.1 to 5.4) against the fake API: the groups (Late,
 * Today, Tomorrow, Later, No date), the row (label, time or day, Idea or
 * Ready, the title or the text's first line, never the notes), Copy and
 * Open only on rows due today or before (Open only for https), the square
 * that marks a post Posted with a 5 s Undo, the sheet (add, one-line where
 * and title, Copy of the title and the text, no Copy on the notes, Mark
 * posted, the posted link, Not posted, Skip, Delete with its Undo), the
 * Done list, the week line and the goals, the push warning for posts, and
 * every state with the <h1>. Jantar never posts: nothing here calls more
 * than the fake API and the clipboard. Every account and post is made up.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeStatus, Post, PostsResponse } from '@jantar/protocol';
import { ApiError } from '../src/lib/api.js';
import { byGroup, doneText, groupOf, postLabel, postLine, weekLine } from '../src/ui/screens/life/posts/model.js';
import { OPEN } from '../src/ui/screens/life/posts/PostRow.js';
import { fakeApi, iso, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('posts');

const DAY = '2026-01-15';
const id = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`;

function post(n: number, over: Partial<Post> = {}): Post {
  return { id: id(n), platform: 'reddit', kind: 'post', status: 'idea', createdAt: iso(0), updatedAt: iso(0), ...over };
}

const SUBMIT = 'https://www.example.com/r/exampletools/submit';
const POSTS: Post[] = [
  post(1, {
    where: 'r/exampletools',
    title: 'Typing into Terminal from a phone',
    text: 'First line of the body\nand a second line',
    notes: 'Flair: Show and tell. Re-read the sidebar first.',
    link: SUBMIT,
    due: { day: '2026-01-14', time: '19:30' },
    status: 'ready',
  }),
  post(2, { platform: 'instagram', kind: 'reel', text: '\n30s: approve a prompt from the phone\nshot list in notes', due: { day: DAY, time: '19:00' } }),
  post(3, { where: 'r/examplecode', title: 'Approving a prompt from the lock screen', link: 'https://www.example.com/r/examplecode/submit', due: { day: '2026-01-16', time: '19:30' }, status: 'ready' }),
  post(4, { platform: 'x', kind: 'thread', due: { day: '2026-01-22' } }),
  post(5, { platform: 'linkedin', title: 'A short launch note' }),
  // Never from the Mac (the schema takes https only): the row still opens nothing.
  post(6, { platform: 'hn', where: 'Show HN', due: { day: DAY }, title: 'Show HN: Example', link: 'http://news.example.com/submit' as string }),
];
const DONE: Post[] = [
  post(11, { where: 'r/exampletools', title: 'An earlier post', status: 'posted', postedAt: '2026-01-14T19:41:00.000Z', postedUrl: 'https://www.example.com/r/exampletools/comments/1' }),
  post(12, { platform: 'instagram', kind: 'story', status: 'skipped' }),
];
const WEEK: PostsResponse['week'] = {
  from: '2026-01-12',
  to: '2026-01-18',
  posted: 2,
  goals: [
    { platform: 'instagram', kind: 'reel', perWeek: 3, done: 1 },
    { platform: 'reddit', perWeek: 6, done: 2 },
  ],
};

function status(over: Partial<LifeStatus> = {}): LifeStatus {
  return {
    open: true,
    timezone: 'UTC',
    today: DAY,
    currency: null,
    lockScreenDetails: false,
    modules: { todos: true, medicines: false, food: false, places: false, finance: false, posts: true },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
    ...over,
  };
}

function render(
  opts: {
    posts?: Post[];
    week?: PostsResponse['week'];
    list?: (filter?: 'open' | 'done') => Promise<PostsResponse>;
    path?: string;
    status?: Partial<LifeStatus>;
    api?: Parameters<typeof fakeApi>[0];
    conn?: 'live' | 'offline';
  } = {},
) {
  const reply = (filter?: 'open' | 'done'): PostsResponse => ({ today: DAY, week: opts.week ?? WEEK, posts: filter === 'done' ? DONE : (opts.posts ?? POSTS) });
  const api = fakeApi({
    lifeStatus: vi.fn(async () => status(opts.status)),
    postsList: vi.fn(opts.list ?? (async (f?: 'open' | 'done') => reply(f))),
    ...opts.api,
  });
  return renderApp({ path: opts.path ?? '/posts', api, state: stateWith({ features: { life: true } }), ...(opts.conn ? { status: opts.conn } : {}) });
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'Posts' });
const row = (label: string) => screen.getByRole('button', { name: `Mark posted: ${label}` }).closest('li') as HTMLElement;

let clipboard: { writeText: ReturnType<typeof vi.fn> };
beforeEach(() => {
  clipboard = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe('Posts: the model', () => {
  it('groups by the Life day: late, today, tomorrow, later, no date', () => {
    expect(POSTS.map((p) => groupOf(p, DAY))).toEqual(['late', 'today', 'tomorrow', 'later', 'none', 'today']);
    const g = byGroup(POSTS, DAY);
    expect(g.today.map((p) => p.id)).toEqual([id(2), id(6)]);
  });

  it('names a post by platform and where, else its kind; Other names the kind first', () => {
    expect(postLabel(POSTS[0]!)).toBe('Reddit · r/exampletools');
    expect(postLabel(POSTS[1]!)).toBe('Instagram · Reel');
    expect(postLabel(post(9, { platform: 'other' }))).toBe('Post');
    expect(postLabel(post(9, { platform: 'other', kind: 'video', where: 'example.blog' }))).toBe('Video · example.blog');
    expect(postLabel(post(9, { platform: 'hn' }))).toBe('Hacker News · Post');
  });

  it("shows the title, else the text's first line, never the notes", () => {
    expect(postLine(POSTS[0]!)).toBe('Typing into Terminal from a phone');
    expect(postLine(POSTS[1]!)).toBe('30s: approve a prompt from the phone');
    expect(postLine(post(9, { notes: 'never' }))).toBe('');
  });

  it('says the week against the goals, and when a done post went', () => {
    expect(weekLine(WEEK)).toBe('This week: Reels 1/3 · Reddit 2/6');
    expect(weekLine({ ...WEEK, goals: [] })).toBeNull();
    expect(weekLine({ ...WEEK, goals: [{ platform: 'instagram', kind: 'reel', perWeek: 3, done: 1 }, { platform: 'facebook', kind: 'reel', perWeek: 2, done: 0 }] })).toBe(
      'This week: Instagram reels 1/3 · Facebook reels 0/2',
    );
    expect(doneText(DONE[0]!, 'Asia/Kolkata')).toBe('Posted Thu 15 Jan 01:11');
    expect(doneText(DONE[0]!, 'UTC')).toBe('Posted Wed 14 Jan 19:41');
    expect(doneText(DONE[1]!)).toBe('Skipped');
  });
});

describe('Posts: the list', () => {
  it('shows its title while loading and with an error, the switch sentence with its command in mono', async () => {
    let fail!: (e: unknown) => void;
    render({ list: () => new Promise((_, rej) => (fail = rej)) });
    await heading();
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    await act(async () => fail(new ApiError('forbidden', 'Posts are off. Turn them on at your Mac: jantar life on posts', 403)));
    expect((await screen.findByText('jantar life on posts')).tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Posts' })).toBeTruthy();
  });

  it('groups Late, Today, Tomorrow, Later and No date, each row with its time or day and its status', async () => {
    render();
    await screen.findByRole('region', { name: 'Late' });
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Late', 'Today', 'Tomorrow', 'Later', 'No date']);
    expect(within(screen.getByRole('region', { name: 'Today' })).getAllByRole('listitem')).toHaveLength(2);
    const late = row('Reddit · r/exampletools');
    expect(late.textContent).toContain('Wed 14 Jan');
    expect(late.textContent).toContain('Ready');
    expect(late.textContent).toContain('Typing into Terminal from a phone');
    const reel = row('Instagram · Reel');
    expect(within(reel).getByText('19:00').className).toContain('type-mono');
    expect(reel.textContent).toContain('Idea');
    expect(reel.textContent).toContain('30s: approve a prompt from the phone');
    expect(row('Reddit · r/examplecode').textContent).toContain('19:30');
    expect(row('X · Thread').textContent).toContain('Thu 22 Jan');
    expect(row('LinkedIn · Post').textContent).toContain('A short launch note');
    // Notes never show on a row, and neither does the text past its first line.
    expect(screen.queryByText(/Flair: Show and tell/)).toBeNull();
    expect(screen.queryByText(/shot list in notes/)).toBeNull();
  });

  it('has Copy and Open only on rows due today or before, Open only for an https link, and an ember square there', async () => {
    render();
    await screen.findByRole('region', { name: 'Late' });
    const late = row('Reddit · r/exampletools');
    const open = within(late).getByRole('link', { name: 'Open: Reddit · r/exampletools' }) as HTMLAnchorElement;
    expect(open.getAttribute('href')).toBe(SUBMIT);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(late).getByRole('button', { name: 'Copy: Reddit · r/exampletools' })).toBeTruthy();
    // Today with no link: Copy only.
    const reel = row('Instagram · Reel');
    expect(within(reel).getByRole('button', { name: 'Copy: Instagram · Reel' })).toBeTruthy();
    expect(within(reel).queryByRole('link')).toBeNull();
    // An http link is never a link.
    expect(within(row('Hacker News · Show HN')).queryByRole('link')).toBeNull();
    // Tomorrow, Later and No date: neither, even with a link.
    for (const label of ['Reddit · r/examplecode', 'X · Thread', 'LinkedIn · Post']) {
      expect(within(row(label)).queryByRole('link'), label).toBeNull();
      expect(within(row(label)).queryByRole('button', { name: /^Copy/ }), label).toBeNull();
    }
    const square = (label: string) => screen.getByRole('button', { name: `Mark posted: ${label}` });
    expect(square('Reddit · r/exampletools').className).toContain('text-signal-text');
    expect(square('Instagram · Reel').className).toContain('text-signal-text');
    expect(square('Reddit · r/examplecode').className).not.toContain('text-signal-text');
    expect(square('LinkedIn · Post').className).not.toContain('text-signal-text');
  });

  it("Copy on a row copies the text (else the title), says Copied, and says so when it can't", async () => {
    render();
    await screen.findByRole('region', { name: 'Late' });
    fireEvent.click(within(row('Reddit · r/exampletools')).getByRole('button', { name: 'Copy: Reddit · r/exampletools' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('First line of the body\nand a second line'));
    expect(await within(row('Reddit · r/exampletools')).findByRole('button', { name: 'Copied' })).toBeTruthy();
    fireEvent.click(within(row('Hacker News · Show HN')).getByRole('button', { name: 'Copy: Hacker News · Show HN' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('Show HN: Example'));
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(within(row('Instagram · Reel')).getByRole('button', { name: 'Copy: Instagram · Reel' }));
    expect(await within(row('Instagram · Reel')).findByRole('button', { name: 'Could not copy' })).toBeTruthy();
  });

  it('the square marks a post Posted at once, and Undo puts its old status back', async () => {
    const postUpdate = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { postUpdate } });
    await screen.findByRole('region', { name: 'Late' });
    fireEvent.click(screen.getByRole('button', { name: 'Mark posted: Instagram · Reel' }));
    await waitFor(() => expect(postUpdate).toHaveBeenCalledWith(id(2), { status: 'posted' }));
    expect(await screen.findByText('Posted: Instagram · Reel')).toBeTruthy();
    await waitFor(() => expect(api.postsList).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(postUpdate).toHaveBeenLastCalledWith(id(2), { status: 'idea' }));
  });

  it('says the week against the goals in the header and the count in the footer; the line opens the goals', async () => {
    render();
    const week = await screen.findByRole('button', { name: 'This week: Reels 1/3 · Reddit 2/6' });
    expect(week.className).toContain('type-mono');
    expect(screen.getByText('Posted this week: 2')).toBeTruthy();
    fireEvent.click(week);
    expect(await screen.findByRole('dialog', { name: 'Weekly goals' })).toBeTruthy();
  });

  it('shows every goal in the header, wrapping between goals and never cutting one', async () => {
    const goals: PostsResponse['week']['goals'] = [
      { platform: 'instagram', kind: 'reel', perWeek: 3, done: 1 },
      { platform: 'reddit', perWeek: 6, done: 2 },
      { platform: 'x', kind: 'thread', perWeek: 2, done: 0 },
      { platform: 'threads', perWeek: 3, done: 1 },
      { platform: 'hn', perWeek: 1, done: 0 },
    ];
    render({ week: { ...WEEK, goals } });
    const line = 'This week: Reels 1/3 · Reddit 2/6 · X threads 0/2 · Threads 1/3 · Hacker News 0/1';
    const week = await screen.findByRole('button', { name: line });
    expect(week.textContent).toBe(line);
    expect(week.className).not.toContain('truncate');
    // Each goal stays whole on its line; the line may break only between them.
    expect([...week.querySelectorAll('span.whitespace-nowrap')].map((x) => x.textContent)).toEqual(['Reels 1/3 ·', 'Reddit 2/6 ·', 'X threads 0/2 ·', 'Threads 1/3 ·', 'Hacker News 0/1']);
  });

  it('asks for a goal when there is none', async () => {
    render({ week: { ...WEEK, goals: [], posted: 0 } });
    expect(await screen.findByRole('button', { name: 'Set a weekly goal' })).toBeTruthy();
    expect(screen.getByText('Posted this week: 0')).toBeTruthy();
  });

  it('says so when there is nothing to post, with the add button', async () => {
    render({ posts: [] });
    expect(await screen.findByText('Nothing to post yet. Add a post and Jantar reminds you at its time.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add post' })).toBeTruthy();
  });

  it('offline: the list stays and adding is off', async () => {
    render({ conn: 'offline' });
    await screen.findByRole('region', { name: 'Late' });
    expect((screen.getByRole('button', { name: 'Add post' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Mark posted: Instagram · Reel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });

  it('warns that no device gets post reminders while posts are on, and not while they are off', async () => {
    const a = render({ status: { push: { devices: 0, webpush: true } } });
    expect(await screen.findByText('No device gets post reminders.')).toBeTruthy();
    expect(screen.getByText('Turn on notifications in Devices on the phone that should ring.')).toBeTruthy();
    // Never the medicines' sentence on Posts.
    expect(screen.queryByText('No device gets medicine pings.')).toBeNull();
    a.unmount();
    render({ status: { push: { devices: 0, webpush: true }, modules: { todos: true, medicines: true, food: false, places: false, finance: false, posts: false } } });
    await screen.findByRole('region', { name: 'Late' });
    expect(screen.queryByText('No device gets post reminders.')).toBeNull();
  });

  it('switches to Done through the route: posted with when and the posted link, or skipped', async () => {
    const { api, router } = render();
    await screen.findByRole('region', { name: 'Late' });
    expect(api.postsList).toHaveBeenCalledWith('open');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(router.getState().route).toEqual({ name: 'posts', filter: 'done' });
    const list = await screen.findByRole('list', { name: 'Done' });
    expect(api.postsList).toHaveBeenCalledWith('done');
    const [posted, skipped] = within(list).getAllByRole('listitem');
    expect(posted!.textContent).toContain('Posted Wed 14 Jan 19:41');
    expect(within(posted!).getByRole('link', { name: 'Open the posted link: Reddit · r/exampletools' }).getAttribute('href')).toBe('https://www.example.com/r/exampletools/comments/1');
    expect(skipped!.textContent).toContain('Skipped');
    expect(within(skipped!).queryByRole('link')).toBeNull();
  });

  it('says so when nothing is posted yet', async () => {
    render({ path: '/posts?filter=done', list: async () => ({ today: DAY, week: WEEK, posts: [] }) });
    expect(await screen.findByText('Nothing posted yet.')).toBeTruthy();
  });

  it('?id= opens that post on arrival (a push lands here)', async () => {
    render({ path: `/posts?id=${id(3)}` });
    const sheet = await screen.findByRole('dialog', { name: 'Edit post' });
    expect((within(sheet).getByLabelText('Where') as HTMLInputElement).value).toBe('r/examplecode');
  });
});

describe('Posts: the sheet', () => {
  const open = async (label: string) => {
    await screen.findByRole('region', { name: 'Late' });
    fireEvent.click(within(row(label)).getAllByRole('button')[1]!);
    return screen.findByRole('dialog', { name: 'Edit post' });
  };

  it('copies the title and the text; the notes have no Copy', async () => {
    render();
    const sheet = await open('Reddit · r/exampletools');
    expect((within(sheet).getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('Flair: Show and tell. Re-read the sidebar first.');
    expect(within(sheet).getAllByRole('button', { name: /^Copy/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Copy the title', 'Copy the text']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy the title' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('Typing into Terminal from a phone'));
    expect(await within(sheet).findByRole('button', { name: 'Copied' })).toBeTruthy();
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy the text' }));
    expect(await within(sheet).findByRole('button', { name: 'Could not copy' })).toBeTruthy();
    expect(clipboard.writeText).toHaveBeenLastCalledWith('First line of the body\nand a second line');
    // Open is a text button like Copy: 44 px under a coarse pointer, not an inline link.
    const openLink = within(sheet).getByRole('link', { name: 'Open the link' });
    expect(openLink.getAttribute('href')).toBe(SUBMIT);
    expect(openLink.textContent).toBe('Open');
    expect(openLink.className).toBe(OPEN);
    expect(OPEN).toContain('coarse:min-h-44');
  });

  it('adds a post: platform, kind, where, title, text, notes, link, day and time, as an idea or ready', async () => {
    const postCreate = vi.fn(async () => ({ id: id(20) }));
    render({ api: { postCreate } });
    await screen.findByRole('region', { name: 'Late' });
    fireEvent.click(screen.getByRole('button', { name: 'Add post' }));
    const sheet = await screen.findByRole('dialog', { name: 'New post' });
    expect(within(sheet).getByRole('button', { name: 'Idea' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(within(sheet).getByLabelText('Platform'), { target: { value: 'instagram' } });
    fireEvent.change(within(sheet).getByLabelText('Kind'), { target: { value: 'reel' } });
    fireEvent.change(within(sheet).getByLabelText('Where'), { target: { value: '  @example.studio ' } });
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'Launch reel' } });
    fireEvent.change(within(sheet).getByLabelText('Text'), { target: { value: 'Caption line one\n\n#example' } });
    fireEvent.change(within(sheet).getByLabelText('Notes'), { target: { value: 'Shot list: lock screen, tap Allow' } });
    fireEvent.change(within(sheet).getByLabelText('Link'), { target: { value: 'https://www.example.com/create' } });
    expect((within(sheet).getByLabelText('Time') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Day'), { target: { value: '2026-01-16' } });
    fireEvent.change(within(sheet).getByLabelText('Time'), { target: { value: '19:00' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ready' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add post' }));
    await waitFor(() =>
      expect(postCreate).toHaveBeenCalledWith(
        {
          platform: 'instagram',
          kind: 'reel',
          status: 'ready',
          where: '@example.studio',
          title: 'Launch reel',
          text: 'Caption line one\n\n#example',
          notes: 'Shot list: lock screen, tap Allow',
          link: 'https://www.example.com/create',
          due: { day: '2026-01-16', time: '19:00' },
        },
        expect.any(String),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses a where or a title of more than one line, and a link that is not https', async () => {
    render();
    await screen.findByRole('region', { name: 'Late' });
    fireEvent.click(screen.getByRole('button', { name: 'Add post' }));
    const sheet = await screen.findByRole('dialog', { name: 'New post' });
    const add = () => within(sheet).getByRole('button', { name: 'Add post' }) as HTMLButtonElement;
    fireEvent.change(within(sheet).getByLabelText('Where'), { target: { value: 'r/example‮tools' } });
    expect(within(sheet).getByText('Use one line, with no special characters.')).toBeTruthy();
    expect(add().disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Where'), { target: { value: 'r/exampletools' } });
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'One\u0007two' } });
    expect(add().disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: 'One line' } });
    expect(add().disabled).toBe(false);
    fireEvent.change(within(sheet).getByLabelText('Link'), { target: { value: 'http://www.example.com/submit' } });
    expect(within(sheet).getByText('Use a link that starts with https://')).toBeTruthy();
    expect(within(sheet).queryByRole('link')).toBeNull();
    expect(add().disabled).toBe(true);
  });

  it('shows the count past 18,000 characters', async () => {
    render();
    const sheet = await open('Instagram · Reel');
    expect(within(sheet).queryByText(/\/ 20,000/)).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Text'), { target: { value: 'x'.repeat(18_234) } });
    expect(within(sheet).getByText('18,234 / 20,000')).toBeTruthy();
  });

  it('edits: only what changed, null for a cleared field, and No date clears the day and time', async () => {
    const postUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ api: { postUpdate } });
    const sheet = await open('Reddit · r/examplecode');
    fireEvent.change(within(sheet).getByLabelText('Title'), { target: { value: '' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'No date' }));
    expect((within(sheet).getByLabelText('Day') as HTMLInputElement).value).toBe('');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Idea' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(postUpdate).toHaveBeenCalledWith(id(3), { title: null, due: null, status: 'idea' }, expect.any(String)));
  });

  it('Mark posted keeps the sheet open as posted: the posted link with Open, then Not posted', async () => {
    const postUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ api: { postUpdate } });
    const sheet = await open('Reddit · r/examplecode');
    fireEvent.change(within(sheet).getByLabelText('Text'), { target: { value: 'The body, filled in' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Mark posted' }));
    // What was edited goes with it.
    await waitFor(() => expect(postUpdate).toHaveBeenCalledWith(id(3), { text: 'The body, filled in', status: 'posted' }, expect.any(String)));
    expect(await within(sheet).findByText('Posted at 10:05')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Mark posted' })).toBeNull();
    expect(within(sheet).queryByRole('group', { name: 'Status' })).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Posted link'), { target: { value: 'https://www.example.com/r/examplecode/comments/9' } });
    const posted = within(sheet).getByRole('link', { name: 'Open the posted link' });
    expect(posted.getAttribute('href')).toBe('https://www.example.com/r/examplecode/comments/9');
    expect(posted.textContent).toBe('Open');
    expect(posted.className).toBe(OPEN);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Not posted' }));
    await waitFor(() => expect(postUpdate).toHaveBeenLastCalledWith(id(3), { status: 'ready' }, expect.any(String)));
    expect(await within(sheet).findByRole('button', { name: 'Mark posted' })).toBeTruthy();
    expect(within(sheet).queryByLabelText('Posted link')).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Ready' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('saves the posted link of a posted post, and refuses one that is not https', async () => {
    const postUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: '/posts?filter=done', api: { postUpdate } });
    fireEvent.click(within(await screen.findByRole('list', { name: 'Done' })).getByText('An earlier post'));
    const sheet = await screen.findByRole('dialog', { name: 'Edit post' });
    expect(within(sheet).getByText('Posted Wed 14 Jan 19:41')).toBeTruthy();
    const link = within(sheet).getByLabelText('Posted link');
    fireEvent.change(link, { target: { value: 'javascript:alert(1)' } });
    expect((within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(link, { target: { value: 'https://www.example.com/r/exampletools/comments/2' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(postUpdate).toHaveBeenCalledWith(id(11), { postedUrl: 'https://www.example.com/r/exampletools/comments/2' }, expect.any(String)));
  });

  it('a skipped post goes back to Ready with Not skipped', async () => {
    const postUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ path: '/posts?filter=done', api: { postUpdate } });
    fireEvent.click(within(await screen.findByRole('list', { name: 'Done' })).getByText('Instagram · Story'));
    const sheet = await screen.findByRole('dialog', { name: 'Edit post' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Not skipped' }));
    await waitFor(() => expect(postUpdate).toHaveBeenCalledWith(id(12), { status: 'ready' }, expect.any(String)));
  });

  it('Skip closes the sheet and offers Undo on the list', async () => {
    const postUpdate = vi.fn(async () => ({ ok: true as const }));
    render({ api: { postUpdate } });
    const sheet = await open('X · Thread');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(postUpdate).toHaveBeenCalledWith(id(4), { status: 'skipped' }));
    expect(await screen.findByText('Skipped: X · Thread')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(postUpdate).toHaveBeenLastCalledWith(id(4), { status: 'idea' }));
  });

  it('Delete asks nothing: the post leaves the list with a 5 s Undo, and the delete is sent when it goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const postDelete = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { postDelete } });
    let sheet = await open('LinkedIn · Post');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('A short launch note')).toBeNull();
    expect(screen.getByText('Deleted: LinkedIn · Post')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('A short launch note')).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(6_000));
    expect(postDelete).not.toHaveBeenCalled();

    sheet = await open('LinkedIn · Post');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(postDelete).toHaveBeenCalledWith(id(5));
    await waitFor(() => expect(api.postsList).toHaveBeenCalledTimes(2));
  });

  it('a failed save keeps the sheet open with Not saved', async () => {
    const postUpdate = vi.fn(async (): Promise<never> => {
      throw new ApiError('invalid_request', 'Mark it posted before adding the posted link.', 400);
    });
    render({ api: { postUpdate } });
    const sheet = await open('X · Thread');
    fireEvent.change(within(sheet).getByLabelText('Where'), { target: { value: '@example' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Not saved. Mark it posted before adding the posted link.');
    expect((within(sheet).getByLabelText('Where') as HTMLInputElement).value).toBe('@example');
  });
});

describe('Posts: the weekly goals', () => {
  const openGoals = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /^This week|^Set a weekly goal/ }));
    return screen.findByRole('dialog', { name: 'Weekly goals' });
  };

  it('edits the goals and sends the whole list', async () => {
    const postGoalsSet = vi.fn(async () => ({ ok: true as const }));
    const { api } = render({ api: { postGoalsSet } });
    const sheet = await openGoals();
    const goals = within(sheet).getByRole('list', { name: 'Goals' });
    expect(within(goals).getAllByRole('listitem')).toHaveLength(2);
    expect(within(goals).getByLabelText('Reels a week').textContent).toBe('3');
    fireEvent.click(within(goals).getByRole('button', { name: 'More Reddit a week' }));
    fireEvent.click(within(goals).getByRole('button', { name: 'Remove Reels' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add goal' }));
    // The first platform with no any-kind goal yet: Instagram, 3 a week.
    const rows = within(goals).getAllByRole('listitem');
    expect((within(rows[1]!).getByLabelText('Platform') as HTMLSelectElement).value).toBe('instagram');
    fireEvent.change(within(rows[1]!).getByLabelText('Kind'), { target: { value: 'reel' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(postGoalsSet).toHaveBeenCalledWith(
        {
          goals: [
            { platform: 'reddit', perWeek: 7 },
            { platform: 'instagram', kind: 'reel', perWeek: 3 },
          ],
        },
        expect.any(String),
      ),
    );
    await waitFor(() => expect(api.postsList).toHaveBeenCalledTimes(2));
  });

  it('refuses two goals for one platform and kind before sending', async () => {
    const postGoalsSet = vi.fn(async () => ({ ok: true as const }));
    render({ api: { postGoalsSet } });
    const sheet = await openGoals();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add goal' }));
    const rows = within(within(sheet).getByRole('list', { name: 'Goals' })).getAllByRole('listitem');
    fireEvent.change(within(rows[2]!).getByLabelText('Platform'), { target: { value: 'reddit' } });
    expect(within(sheet).getByText('One goal per platform and kind.')).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(postGoalsSet).not.toHaveBeenCalled();
  });

  it('names the platform too when two goals would read the same', async () => {
    render({ week: { ...WEEK, goals: [{ platform: 'x', kind: 'thread', perWeek: 2, done: 0 }, { platform: 'threads', perWeek: 3, done: 1 }] } });
    const sheet = await openGoals();
    expect(within(sheet).getByLabelText('X threads a week').textContent).toBe('2');
    expect(within(sheet).getByLabelText('Threads a week').textContent).toBe('3');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Threads' }));
    // Alone, the X goal is Threads again.
    expect(within(sheet).getByLabelText('Threads a week').textContent).toBe('2');
  });

  it('keeps a goal between 1 and 50 a week, and at most 10 goals', async () => {
    render({ week: { ...WEEK, goals: [{ platform: 'reddit', perWeek: 1, done: 0 }] } });
    const sheet = await openGoals();
    expect((within(sheet).getByRole('button', { name: 'Fewer Reddit a week' }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 9; i++) fireEvent.click(within(sheet).getByRole('button', { name: 'Add goal' }));
    expect(within(within(sheet).getByRole('list', { name: 'Goals' })).getAllByRole('listitem')).toHaveLength(10);
    expect(within(sheet).queryByRole('button', { name: 'Add goal' })).toBeNull();
  });

  it('an empty list removes every goal', async () => {
    const postGoalsSet = vi.fn(async () => ({ ok: true as const }));
    render({ api: { postGoalsSet } });
    const sheet = await openGoals();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Reels' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove Reddit' }));
    expect(within(sheet).getByText('No weekly goal.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(postGoalsSet).toHaveBeenCalledWith({ goals: [] }, expect.any(String)));
  });
});
