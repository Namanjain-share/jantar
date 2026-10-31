import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '@jantar/protocol';
import { STATE_CACHE_KEY, hydrateStateCache, readStateCache, saveStateCache, wireStateCache } from '../src/ui/screens/board/cache.js';
import { replyLine, runwaySpan, span } from '../src/ui/screens/board/model.js';
import { createAppStore } from '../src/store.js';
import { NOW, T0, account, alert, emit, iso, pending, renderApp, session, stateWith } from './helpers.js';

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('a[data-sid]'));
const order = () => rows().map((r) => r.dataset.sid);
const row = (sid: string) => rows().find((r) => r.dataset.sid === sid)!;
const line2 = (sid: string) => row(sid).querySelector('[data-line2] > span:first-child')?.textContent ?? null;
const acct = (sid: string) => row(sid).querySelector('[data-acct]')?.textContent ?? null;
const rails = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

const question = (sid: string, over = {}) =>
  pending(sid, {
    kind: 'question',
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
    ...over,
  });

describe('board', () => {
  it('groups sessions under NEEDS YOU, YOUR TURN, WORKING and ENDED rails', () => {
    renderApp({
      state: stateWith({
        sessions: [
          session('work1', { status: 'working', statusSince: iso(10_000) }),
          session('done1', { status: 'idle', statusSince: iso(20_000) }),
          session('quest', { status: 'working' }),
          session('gone', { status: 'ended' }),
          session('wait', { status: 'waiting', waitingFor: 'permission' }),
          session('comp', { status: 'compacting' }),
        ],
        pending: [question('quest')],
      }),
    });
    // Needs you is a queue, oldest wait first: wait has waited since T0, quest's card opened a minute later.
    expect(order()).toEqual(['wait', 'quest', 'done1', 'work1', 'comp', 'gone']);
    // "Your turn" no longer holds the sessions that need you: they have their own rail.
    expect(rails()).toEqual(['Needs you2', 'Your turn1', 'Working2', 'Ended1']);
    const display = screen.getByRole('heading', { level: 1 });
    expect(display.textContent).toBe('2 need you');
    expect(display.hasAttribute('data-display')).toBe(true);
    expect(document.querySelectorAll('[data-display]').length).toBe(1);
    expect(row('quest').getAttribute('data-glyph')).toBe('needs');
    expect(row('comp').getAttribute('data-glyph')).toBe('compacting');
  });

  it('says what each row is doing on line 2', () => {
    renderApp({
      state: stateWith({
        sessions: [
          session('quest'),
          session('cli'),
          session('infra'),
          session('api', { now: { kind: 'tool', tool: 'Bash', text: 'npm run build\nnpm test' } }),
          session('comp', { status: 'compacting' }),
          session('web', {
            status: 'idle',
            lastReply: { text: '## Done\nI **fixed** the `login` handler and added [tests](https://example.test).\n- one\n- two', at: iso(1000) },
          }),
          session('gone', { status: 'ended' }),
          session('term', { status: 'waiting' }),
        ],
        pending: [
          question('quest'),
          pending('cli', { tool: 'Bash', input: { command: 'rm -rf build\necho done' } }),
          pending('infra', { kind: 'plan', tool: 'ExitPlanMode', input: { plan: '## 3 to add, 1 to change\n1. Add a bucket' } }),
        ],
      }),
    });
    expect(line2('quest')).toBe('Question: Which database?');
    expect(line2('cli')).toBe('Permission · Bash: rm -rf build');
    expect(row('cli').querySelector('code')?.textContent).toBe('rm -rf build');
    expect(line2('infra')).toBe('Plan: 3 to add, 1 to change');
    expect(line2('api')).toBe('Bash\u00a0 npm run build');
    expect(line2('comp')).toBe('Compacting\u00a0 the conversation');
    expect(line2('web')).toBe('Done · I fixed the login handler and added tests. · one · two');
    expect(line2('term')).toBe('Waiting in the terminal');
    // An ended session is one line.
    expect(line2('gone')).toBeNull();
  });

  it('shows the account and its 5-hour %, ember at the ceiling, dashes without a reading', () => {
    renderApp({
      state: stateWith({
        sessions: [
          session('web-app', { status: 'idle', account: 3 }),
          session('hot', { status: 'idle', account: 4 }),
          session('expired', { status: 'idle', account: 5 }),
          session('nobody', { status: 'idle', account: null }),
          session('fresh', { status: 'idle', account: 6 }),
        ],
        accounts: [
          account(3, { alias: 'work', windows: [{ kind: 'five_hour', pct: 72 }] }),
          account(4, { windows: [{ kind: 'five_hour', pct: 97.2 }] }),
          account(5, { usageStatus: 'token_expired' }),
          account(6, { windows: [{ kind: 'seven_day', pct: 4 }] }),
        ],
      }),
    });
    expect(acct('web-app')).toBe('03 · 5h 72%');
    const pct = (sid: string) => row(sid).querySelector('[data-line2] b')!;
    expect(pct('web-app').className).toContain('text-ink-2');
    expect(pct('hot').textContent).toBe('97');
    expect(pct('hot').className).toContain('text-signal-text');
    expect(pct('expired').textContent).toBe('–');
    // No 5-hour window open on 06: 0, the same number Accounts and the status bar show.
    expect(pct('fresh').textContent).toBe('0');
    expect(row('nobody').querySelector('[data-line2] b')).toBeNull();
  });

  it('counts the wait from the oldest open card and turns it ember at the first reminder', () => {
    renderApp({
      state: stateWith({
        sessions: [session('fresh'), session('old')],
        // NOW is T0 + 5 min.
        pending: [question('fresh', { createdAt: iso(60_000) }), question('old', { createdAt: iso(-6 * 60_000) })],
      }),
    });
    const age = (sid: string) => within(row(sid)).getByText(/^waiting /);
    expect(age('fresh').textContent).toBe('waiting 4m');
    expect(age('fresh').className).toContain('text-ink-3');
    expect(age('old').textContent).toBe('waiting 11m');
    expect(age('old').className).toContain('text-signal-text');
  });

  it('tags moves, subagents and extra cards', () => {
    renderApp({
      state: stateWith({
        sessions: [
          session('api', {
            status: 'working',
            now: { kind: 'tool', tool: 'Bash', text: 'npm run build' },
            move: { sid: 'api', from: 3, to: 4, step: 'saving', why: 'five-hour window nearly full', since: iso(0) },
            subagentsRunning: 2,
          }),
          session('parked', { move: { sid: 'parked', from: 3, step: 'parked', why: 'no account left', since: iso(0) } }),
          session('two'),
        ],
        pending: [pending('two'), pending('two', { tool: 'Edit', input: { file_path: 'src/a.ts' } })],
      }),
    });
    expect(screen.getByText('03 → 04 · saving')).toBeTruthy();
    expect(screen.getByText('03 · parked')).toBeTruthy();
    expect(screen.getByText('+2 agents')).toBeTruthy();
    expect(screen.getByText('2 cards')).toBeTruthy();
  });

  it('opens a session from its row, and Start opens the first one waiting on you', () => {
    const { history } = renderApp({
      state: stateWith({ sessions: [session('docs-site', { status: 'idle' }), session('infra', { status: 'waiting' })] }),
    });
    fireEvent.click(screen.getByRole('link', { name: /docs-site/ }));
    expect(history.entries.at(-1)).toBe('/s/docs-site');
    expect(screen.getByRole('heading', { level: 1, name: 'docs-site' })).toBeTruthy();
    act(() => history.back());
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(history.entries.at(-1)).toBe('/s/infra');
  });

  it('reads "All clear" with the working count and no Start when nothing waits', () => {
    renderApp({ state: stateWith({ sessions: [session('a'), session('b'), session('c', { status: 'idle' })] }) });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('All clear2 working');
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('updates live as events arrive', () => {
    const { store } = renderApp({ state: stateWith({ sessions: [session('a')], seq: 10 }) });
    expect(rails()).toEqual(['Working1']);
    act(() =>
      emit(store, [
        { seq: 11, ts: iso(5000), type: 'session.updated', sid: 'a', data: { patch: { status: 'idle', statusSince: iso(5000), lastReply: { text: 'All green.', at: iso(5000) } } } },
      ]),
    );
    expect(rails()).toEqual(['Your turn1']);
    expect(line2('a')).toBe('All green.');
  });

  it('sets a your-turn row in bold until it is opened', () => {
    localStorage.setItem('jantar:board-seen', JSON.stringify({ done: Date.parse(T0) - 60_000, seen: NOW }));
    renderApp({ state: stateWith({ sessions: [session('done', { status: 'idle' }), session('seen', { status: 'idle' })] }) });
    const folder = (sid: string) => within(row(sid)).getByText(sid);
    expect(folder('done').className).toContain('font-strong');
    expect(folder('seen').className).toContain('font-medium');
    fireEvent.click(row('done'));
    expect(JSON.parse(localStorage.getItem('jantar:board-seen')!).done).toBe(NOW);
  });

  it('teaches with the legend and an example row when no session runs', () => {
    renderApp({ state: stateWith({ seq: 3 }) });
    expect(screen.getByText('No Claude sessions running')).toBeTruthy();
    expect(screen.getByText('Example data')).toBeTruthy();
    expect(screen.getByText('Claude finished and is waiting for your next prompt.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /web-app/ })).toBeNull();
  });

  it('shows static skeleton rows before the first sync', async () => {
    renderApp({ state: stateWith({ seq: 0 }), status: 'connecting' });
    expect(screen.getByRole('region', { name: 'Sessions' }).getAttribute('aria-busy')).toBe('true');
    expect(await screen.findByText('Connecting to the Mac…')).toBeTruthy();
  });
});

describe('board on the desktop', () => {
  beforeEach(() => viewport(1440));
  afterEach(() => vi.unstubAllGlobals());

  it('queues up to three sessions on the Desk, never selecting one by itself', () => {
    const perm = pending('cli', {
      tool: 'Bash',
      input: { command: 'npm test', description: 'Run the tests' },
      suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }],
    });
    const { history } = renderApp({
      state: stateWith({
        // Oldest wait first: quest's card, then infra's, then cli's, then term (waiting since 40s).
        sessions: [session('quest', { statusSince: iso(4000) }), session('infra', { statusSince: iso(3000) }), session('cli', { statusSince: iso(2000) }), session('term', { status: 'waiting', statusSince: iso(40_000) })],
        pending: [
          question('quest', { createdAt: iso(10_000) }),
          pending('infra', { kind: 'plan', tool: 'ExitPlanMode', input: { plan: '3 to add, 1 to change.\n1. Add a bucket\n2. Add a role' }, createdAt: iso(20_000) }),
          { ...perm, createdAt: iso(30_000) },
        ],
      }),
    });
    const desk = screen.getByRole('region', { name: 'Desk' });
    expect(within(desk).getByRole('heading', { name: 'Waiting on you' })).toBeTruthy();
    const cards = within(desk).getAllByRole('article');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Question: quest', 'Plan: infra', 'Permission · Bash: cli']);
    expect(within(cards[0]!).getByText('Which database?')).toBeTruthy();
    expect(within(cards[0]!).getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe('/s/quest');
    expect(within(cards[1]!).getByText('Add a bucket')).toBeTruthy();
    expect(within(cards[1]!).getByRole('link', { name: 'Review plan' })).toBeTruthy();
    expect(within(cards[2]!).getByText('Run this in cli?')).toBeTruthy();
    expect(within(cards[2]!).getByText('Bash(npm test:*)')).toBeTruthy();
    expect(within(desk).getByText('1 more waiting in the ledger.')).toBeTruthy();
    expect(history.entries).toEqual(['/']);
  });

  it('says nothing needs you, with the last finished sessions and the next resets', () => {
    renderApp({
      state: stateWith({
        sessions: [
          session('infra', { status: 'idle', lastReply: { text: 'Plan is ready: 3 to add.', at: iso(2000) } }),
          session('api'),
        ],
        accounts: [
          account(3, { alias: 'team', windows: [{ kind: 'five_hour', pct: 81, resetsAt: iso(2 * 3600_000), projectedExhaustionAt: iso(3600_000) }] }),
          account(4, { windows: [{ kind: 'five_hour', pct: 10, resetsAt: iso(3600_000) }] }),
        ],
      }),
    });
    const desk = screen.getByRole('region', { name: 'Desk' });
    expect(within(desk).getByRole('heading', { name: 'Nothing needs you' })).toBeTruthy();
    expect(within(desk).getByText(/1 session is working\./)).toBeTruthy();
    expect(within(within(desk).getByRole('list', { name: 'Last finished' })).getByRole('link').textContent).toMatch(/^infra finished · Plan is ready: 3 to add\./);
    const resets = within(desk).getByRole('region', { name: 'Next resets' });
    // Soonest first: 04 (in 55m), then 03 (in 1h55, full an hour before).
    expect(within(resets).getAllByText(/^0[34]$/).map((n) => n.textContent)).toEqual(['04', '03']);
    expect(within(resets).getByText(/1h00 before it resets/)).toBeTruthy();
    expect(within(resets).getByRole('link', { name: 'All 2 accounts' })).toBeTruthy();
  });

  it('marks the open session in the ledger', () => {
    renderApp({ path: '/s/infra', state: stateWith({ sessions: [session('infra', { status: 'idle' }), session('api')] }) });
    expect(row('infra').getAttribute('aria-current')).toBe('page');
    expect(row('api').getAttribute('aria-current')).toBeNull();
  });

  it('lists the newest alerts beside the queue, new ones first in weight', () => {
    renderApp({
      state: stateWith({
        sessions: [session('api', { folder: 'api-server', name: 'rate limiter' })],
        alerts: [alert('a1', { sid: 'api', what: 'Hit an API error.', why: 'Retried twice, then stopped.' })],
      }),
    });
    const side = screen.getByRole('complementary', { name: 'Alerts and legend' });
    expect(within(side).getByRole('heading', { name: 'Alerts1 new' })).toBeTruthy();
    expect(within(side).getByRole('link', { name: /api-server · rate limiter/ }).getAttribute('href')).toBe('/s/api');
    expect(within(side).getByText('Hit an API error. Retried twice, then stopped.')).toBeTruthy();
  });
});

describe('board helpers', () => {
  it('joins list items and headings of a reply with middots', () => {
    expect(replyLine('Done. Changes:\n- a\n- b')).toBe('Done. Changes: a · b');
    expect(replyLine('```\ncode\n```\nShipped it.')).toBe('Shipped it.');
    expect(replyLine('')).toBe('');
  });

  it('writes durations the way the board reads them', () => {
    expect(span(4000)).toBe('4s');
    expect(span(12 * 60_000)).toBe('12m');
    expect(runwaySpan(114)).toBe('1h54');
    expect(runwaySpan(125)).toBe('2h05');
    expect(runwaySpan(12)).toBe('12m');
  });
});

describe('board cache', () => {
  const saved = () => {
    const store = createAppStore(stateWith({ sessions: [session('web-app')], seq: 12 }));
    store.setState({ epoch: 'e1' });
    store.getState().setConn({ status: 'live', lastOkAt: 1000 });
    return store;
  };

  it('saves an in-sync state and paints it on the next cold start', () => {
    expect(saveStateCache(saved(), 5000)).toBe(true);
    expect(readStateCache()?.seq).toBe(12);

    const cold = createAppStore();
    expect(hydrateStateCache(cold)).toBe(true);
    expect(cold.getState().state.sessions['web-app']).toBeTruthy();
    expect(cold.getState().epoch).toBe('e1');
    // The status bar reads "catching up · last <when it was saved>".
    expect(cold.getState().conn).toMatchObject({ status: 'connecting', lastOkAt: 5000 });
  });

  it('never paints over a real sync, and never saves an unsynced state', () => {
    saveStateCache(saved(), 5000);
    const synced = createAppStore(stateWith({ seq: 3 }));
    expect(hydrateStateCache(synced)).toBe(false);
    const offline = createAppStore(emptyState());
    offline.getState().setConn({ status: 'offline' });
    expect(saveStateCache(offline)).toBe(false);
  });

  it('forgets the state when this browser is no longer paired', () => {
    saveStateCache(saved(), 5000);
    const store = saved();
    wireStateCache(store);
    store.getState().setConn({ status: 'unauthorized' });
    expect(localStorage.getItem(`jantar:${STATE_CACHE_KEY}`)).toBeNull();
  });
});
