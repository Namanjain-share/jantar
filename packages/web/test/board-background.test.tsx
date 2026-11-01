/**
 * v0.6.1: a session idle between turns while a workflow or background agent
 * it started runs shows as working: its row under the Working rail with
 * what runs and how long, never "no update", out of the Desk's "Last
 * finished", and a line under the session's header. Shells and monitors
 * are only a quiet count. Every name is made up.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardOrder, type SessionBackground } from '@jantar/protocol';
import { glyphStateOf } from '../src/ui/kit/glyph.js';
import { backgroundLine, lastFinished, rowOf } from '../src/ui/screens/board/model.js';
import { isUnseen } from '../src/ui/screens/board/seen.js';
import { NOW, pending, renderApp, session, stateWith } from './helpers.js';

const MIN = 60_000;
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();
const WORKFLOW: SessionBackground = { workflows: 1, since: ago(52), names: ['demo-sweep'] };

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

afterEach(() => vi.unstubAllGlobals());

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('a[data-sid]'));
const row = (sid: string) => rows().find((r) => r.dataset.sid === sid)!;
const rails = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

describe('the row', () => {
  it('idle with a workflow running: working, what runs and for how long, no "+1 agent" beside it', () => {
    const s = session('web-app', { status: 'idle', statusSince: ago(3), name: 'fix-login', subagentsRunning: 1, background: WORKFLOW });
    const r = rowOf(stateWith({ sessions: [s] }), s, NOW);
    expect(r.glyph).toBe('working');
    expect(r.group).toBe('working');
    expect(r.line2).toEqual({ kind: 'tool', verb: '1 workflow running', arg: 'demo-sweep' });
    expect(r.age).toBe('52m');
    expect(r.ageEmber).toBe(false);
    expect(r.tag).toBeNull();
  });

  it('shells only: still your turn, with the quiet tag', () => {
    const s = session('web-app', { status: 'idle', background: { shells: 6 } });
    const r = rowOf(stateWith({ sessions: [s] }), s, NOW);
    expect(r.glyph).toBe('turn');
    expect(r.tag).toBe('6 shells');
  });

  it('a running turn with background work is never "no update", and keeps its agents tag', () => {
    const quiet = { status: 'working' as const, statusAt: ago(6), statusSince: ago(6), subagentsRunning: 1 };
    const plain = session('a', quiet);
    const bg = session('b', { ...quiet, background: { agents: 1, monitors: 1, since: ago(7) } });
    const state = stateWith({ sessions: [plain, bg] });
    expect(glyphStateOf(state, plain, NOW)).toBe('stale');
    expect(glyphStateOf(state, bg, NOW)).toBe('working');
    expect(rowOf(state, bg, NOW).tag).toBe('+1 agent · 1 monitor');
    expect(rowOf(state, bg, NOW).age).toBe('6m');
  });

  it('needs you beats it: an open card, or Claude waiting, on a session with a workflow running', () => {
    const card = session('a', { status: 'idle', statusSince: ago(3), background: WORKFLOW });
    const waits = session('b', { status: 'waiting', statusSince: ago(2), waitingFor: 'a synthetic dialog', background: WORKFLOW });
    const done = session('c', { status: 'idle', statusSince: ago(1) });
    const state = stateWith({ sessions: [done, card, waits], pending: [pending('a')] });
    for (const s of [card, waits]) {
      const r = rowOf(state, s, NOW);
      expect(r.glyph, s.sid).toBe('needs');
      expect(r.group, s.sid).toBe('needs');
      expect(r.line2.kind, s.sid).toBe('needs');
    }
    expect(rowOf(state, card, NOW).line2).toMatchObject({ text: 'npm test' });
    expect(rowOf(state, waits, NOW).line2).toMatchObject({ text: 'a synthetic dialog' });
    expect(boardOrder(state).at(-1)?.sid).toBe('c'); // both rank before a Done session
  });

  it('an ended session ignores a stale field', () => {
    const s = session('a', { status: 'ended', background: { ...WORKFLOW, shells: 2 } });
    const r = rowOf(stateWith({ sessions: [s] }), s, NOW);
    expect(r.glyph).toBe('ended');
    expect(r.tag).toBeNull();
    expect(backgroundLine(s, NOW)).toEqual({ running: null, quiet: null });
  });

  it('is not "last finished", and its folder is never bold as unseen', () => {
    const running = session('a', { status: 'idle', statusSince: ago(1), background: WORKFLOW });
    const done = session('b', { status: 'idle', statusSince: ago(2), background: { shells: 1 } });
    expect(lastFinished(stateWith({ sessions: [running, done] })).map((s) => s.sid)).toEqual(['b']);
    const seenAt = { a: NOW - 10 * MIN, b: NOW - 10 * MIN };
    expect(isUnseen(seenAt, running)).toBe(false);
    expect(isUnseen(seenAt, done)).toBe(true);
  });

  it('words the header line: what runs, its name and how long, then the quiet count', () => {
    expect(backgroundLine(session('a', { status: 'idle', background: { ...WORKFLOW, shells: 6 } }), NOW)).toEqual({
      running: '1 workflow running · 52m · demo-sweep',
      quiet: '6 shells',
    });
    expect(backgroundLine(session('a', { status: 'idle', background: { workflows: 2, agents: 1, since: ago(130) } }), NOW)).toEqual({
      running: '2 workflows and 1 agent running · 2h',
      quiet: null,
    });
    expect(backgroundLine(session('a', { status: 'idle', background: {} }), NOW)).toEqual({ running: null, quiet: null });
  });
});

describe('the board', () => {
  it('shows it under the Working rail, and the Desk counts it working', () => {
    viewport(1440);
    renderApp({
      state: stateWith({
        sessions: [
          session('web-app', { status: 'idle', name: 'fix-login', background: { ...WORKFLOW, shells: 6 } }),
          session('docs', { status: 'idle', name: 'typo', lastReply: { text: 'Fixed the typo.', at: ago(4) } }),
        ],
      }),
    });
    expect(rails().slice(0, 2)).toEqual(['Your turn1', 'Working1']);
    expect(rows().map((r) => r.dataset.sid)).toEqual(['docs', 'web-app']);
    const r = row('web-app');
    expect(r.getAttribute('data-glyph')).toBe('working');
    expect(r.querySelector('[data-line2]')!.textContent).toContain('1 workflow running  demo-sweep');
    expect(r.textContent).toContain('52m');
    expect(r.textContent).toContain('6 shells');
    const desk = screen.getByRole('region', { name: 'Desk' });
    expect(within(desk).getByText(/1 session is working\./)).toBeTruthy();
    const finished = within(desk).getByRole('list', { name: 'Last finished' });
    expect(within(finished).getAllByRole('link').map((a) => a.textContent)).toEqual([expect.stringMatching(/^docs finished/)]);
  });
});

describe('the session header', () => {
  const line = () => document.querySelector<HTMLElement>('[data-background-line]');
  const open = (background: SessionBackground) =>
    renderApp({ path: '/s/web-app', state: stateWith({ sessions: [session('web-app', { status: 'idle', name: 'fix-login', background })] }) });

  it('says what runs on a phone, with the glyph working', () => {
    open({ ...WORKFLOW, shells: 6 });
    expect(line()!.textContent).toBe('1 workflow running · 52m · demo-sweep · 6 shells');
    expect(line()!.querySelector('.text-ink-2')!.textContent).toBe('1 workflow running · 52m · demo-sweep');
    expect(line()!.querySelector('.text-ink-3')!.textContent).toBe(' · 6 shells');
    expect(line()!.getAttribute('role')).toBeNull();
    expect(screen.getByRole('img', { name: 'Working' })).toBeTruthy();
  });

  it('says the same on a desktop', () => {
    viewport(1440);
    open({ ...WORKFLOW, shells: 6 });
    expect(line()!.textContent).toBe('1 workflow running · 52m · demo-sweep · 6 shells');
    expect(line()!.className).toContain('px-32');
  });

  it('the quiet count alone', () => {
    open({ shells: 6 });
    expect(line()!.textContent).toBe('6 shells');
    expect(screen.getByRole('img', { name: 'Your turn' })).toBeTruthy();
  });

  it('no line with {}', () => {
    open({});
    expect(line()).toBeNull();
  });
});
