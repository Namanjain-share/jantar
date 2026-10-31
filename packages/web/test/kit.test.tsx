import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoswitchSettingsSchema } from '@jantar/protocol';
import { documentTitle, screenTitle, setFavicon } from '../src/lib/favicon.js';
import { applyTheme } from '../src/lib/theme.js';
import { PRODUCT_NAME } from '../src/brand.js';
import { Badge } from '../src/ui/kit/Badge.js';
import { BUTTON_VARIANT, Button } from '../src/ui/kit/Button.js';
import { useDelayedFlag } from '../src/ui/kit/delay.js';
import { STALE_MS, glyphStateOf, groupOf } from '../src/ui/kit/glyph.js';
import { HoldButton } from '../src/ui/kit/HoldButton.js';
import { LEGEND, Legend } from '../src/ui/kit/Legend.js';
import { Mark } from '../src/ui/kit/Mark.js';
import { Meter } from '../src/ui/kit/Meter.js';
import { meterGeometry, pastCeiling } from '../src/ui/kit/meterMath.js';
import { RailLabel } from '../src/ui/kit/RailLabel.js';
import { Spinner } from '../src/ui/kit/Spinner.js';
import { StatusGlyph } from '../src/ui/kit/StatusGlyph.js';
import { Strip, type StripItem } from '../src/ui/kit/Strip.js';
import { Tag } from '../src/ui/kit/Tag.js';
import { DEFAULT_CEILING, needsWord, stripItems, usagePairs } from '../src/ui/shell/data.js';
import { isTyping } from '../src/ui/shell/keys.js';
import { account, iso, NOW, pending, session, stateWith } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('glyph states', () => {
  it('maps sessions onto the six glyphs, needs-you first', () => {
    const q = pending('ask', { kind: 'question', tool: 'AskUserQuestion' });
    const info = pending('sub', { kind: 'subagent-info', tool: 'Bash' });
    const st = stateWith({
      sessions: [
        session('ask'),
        session('wait', { status: 'waiting' }),
        session('sub', { status: 'working', statusAt: iso(290_000) }),
        session('idle', { status: 'idle' }),
        session('gone', { status: 'ended' }),
        session('pack', { status: 'compacting' }),
        session('quiet', { status: 'working', statusSince: iso(0) }),
        session('moving', { status: 'working', statusSince: iso(0), move: { sid: 'moving', from: 1, to: 2, step: 'saving', why: 'x', since: iso(0) } }),
      ],
      pending: [q, info],
    });
    const at = (sid: string) => glyphStateOf(st, st.sessions[sid]!, NOW);
    expect(at('ask')).toBe('needs');
    expect(at('wait')).toBe('needs');
    // A subagent-info card is informational, not "needs you".
    expect(at('sub')).toBe('working');
    expect(at('idle')).toBe('turn');
    expect(at('gone')).toBe('ended');
    expect(at('pack')).toBe('compacting');
    // NOW is T0 + 5m: past the threshold with no newer observation.
    expect(glyphStateOf(st, st.sessions.quiet!, Date.parse(iso(0)) + STALE_MS + 1)).toBe('stale');
    expect(glyphStateOf(st, st.sessions.quiet!, Date.parse(iso(0)) + STALE_MS - 1)).toBe('working');
    // Moving between accounts keeps the working glyph.
    expect(glyphStateOf(st, st.sessions.moving!, Date.parse(iso(0)) + STALE_MS * 3)).toBe('working');
    expect(['needs', 'turn', 'working', 'compacting', 'stale', 'ended'].map((g) => groupOf(g as never))).toEqual([
      'needs',
      'turn',
      'working',
      'working',
      'working',
      'ended',
    ]);
  });

  it('draws each state with a distinct pixel-snapped shape', () => {
    const { container } = render(
      <>
        {(['needs', 'working', 'compacting', 'turn', 'ended', 'stale'] as const).map((g) => (
          <StatusGlyph key={g} state={g} />
        ))}
        <StatusGlyph state="needs" size="cell" dashed label="web-app needs you" />
      </>,
    );
    const svgs = Array.from(container.querySelectorAll('svg'));
    const rects = (i: number) => svgs[i]!.querySelectorAll('rect');
    expect(svgs[0]!.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(rects(0).length).toBe(1);
    expect(rects(0)[0]!.getAttribute('class')).toBe('fill-signal');
    expect(rects(1)[0]!.getAttribute('class')).toBe('fill-ink');
    expect(rects(2).length).toBe(5); // outline + bottom half
    expect(rects(3).length).toBe(4); // outline
    expect(rects(4)[0]!.getAttribute('class')).toBe('fill-ink-4');
    expect(rects(5).length).toBe(12); // dashed
    // Shapes differ even with colour removed (rule 16).
    const shapes = svgs.slice(0, 6).map((s) => Array.from(s.querySelectorAll('rect')).map((r) => `${r.getAttribute('x')},${r.getAttribute('y')},${r.getAttribute('width')},${r.getAttribute('height')}`).join('|'));
    // Four shapes: filled (needs, working), half-filled (compacting), outline
    // (your turn, ended), dashed (no update). The rail word separates each pair.
    expect(new Set(shapes).size).toBe(4);
    expect(svgs[6]!.getAttribute('viewBox')).toBe('4 4 8 8');
    expect(screen.getByRole('img', { name: 'web-app needs you' })).toBeTruthy();
  });

  it('lights the mark only while something needs you', () => {
    const { container, rerender } = render(<Mark />);
    expect(container.querySelector('rect')!.getAttribute('class')).toBe('fill-ink-4');
    expect(screen.getByRole('img', { name: PRODUCT_NAME })).toBeTruthy();
    rerender(<Mark needs />);
    expect(container.querySelector('rect')!.getAttribute('class')).toBe('fill-signal');
  });
});

describe('meter', () => {
  it('puts the tick at the ceiling and only the part past it in ember', () => {
    expect(meterGeometry(81, 96, 97)).toMatchObject({ fill: 78, tick: 93, base: 78, overW: 0 });
    expect(meterGeometry(100, 96, 90)).toMatchObject({ fill: 96, tick: 86, base: 86, overX: 87, overW: 9 });
    expect(meterGeometry(50, 64)).toMatchObject({ tick: null, base: 32, overW: 0 });
    expect(meterGeometry(-5, 100, 97).fill).toBe(0);
    expect(meterGeometry(Number.NaN, 100, 97).fill).toBe(0);
    expect(pastCeiling(97, 97)).toBe(true);
    expect(pastCeiling(96, 97)).toBe(false);
    expect(pastCeiling(null, 97)).toBe(false);
  });

  it('is a named meter, dashed with no reading', () => {
    const { container, rerender } = render(<Meter value={92} ceiling={90} label="04 5-hour usage" />);
    const m = screen.getByRole('meter', { name: '04 5-hour usage' });
    expect(m.getAttribute('aria-valuenow')).toBe('92');
    expect(container.querySelector('.fill-signal')).toBeTruthy();
    rerender(<Meter value={null} label="11 5-hour usage" />);
    const u = screen.getByRole('meter', { name: '11 5-hour usage' });
    expect(u.getAttribute('aria-valuenow')).toBeNull();
    expect(u.getAttribute('aria-valuetext')).toBe('no reading');
    expect(container.querySelector('.fill-signal')).toBeNull();
  });

  it('draws a stale reading as its last value over a dashed track', () => {
    const { container } = render(<Meter value={5} stale ceiling={97} label="11 5-hour usage" />);
    const m = screen.getByRole('meter', { name: '11 5-hour usage' });
    expect(m.getAttribute('aria-valuenow')).toBe('5');
    expect(m.getAttribute('aria-valuetext')).toBe('5%, last reading');
    // The last value is drawn, quieter than a live one, and the rest of the track is dashed.
    expect(container.querySelector('.fill-ink-3')).toBeTruthy();
    expect(container.querySelector('.fill-ink-2')).toBeNull();
    expect(container.querySelectorAll('.fill-ink-4').length).toBeGreaterThan(0);
  });
});

describe('controls', () => {
  it('never fills a button with ember', () => {
    for (const cls of Object.values(BUTTON_VARIANT)) expect(cls).not.toMatch(/signal|badge/);
    render(<Button variant="primary">Allow once</Button>);
    const b = screen.getByRole('button', { name: 'Allow once' });
    expect(b.getAttribute('type')).toBe('button');
    expect(b.className).toContain('bg-ink');
  });

  it('commits a hold only after the full duration', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<HoldButton onCommit={onCommit}>Always allow</HoldButton>);
    const b = screen.getByRole('button', { name: 'Always allow. Hold for 2 seconds' });
    fireEvent.click(b);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerDown(b, { button: 0 });
    expect(b.getAttribute('data-holding')).toBe('true');
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.pointerUp(b);
    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).not.toHaveBeenCalled();
    expect(b.getAttribute('data-holding')).toBe('false');
    fireEvent.pointerDown(b, { button: 0 });
    act(() => vi.advanceTimersByTime(1999));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Keyboard: hold Space.
    fireEvent.keyDown(b, { key: ' ' });
    fireEvent.keyDown(b, { key: ' ', repeat: true });
    act(() => vi.advanceTimersByTime(2000));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('shows the spinner after 150 ms and keeps it at least 300 ms', () => {
    vi.useFakeTimers();
    function Probe({ on }: { on: boolean }) {
      return <span data-testid="flag">{useDelayedFlag(on) ? 'shown' : 'hidden'}</span>;
    }
    const { rerender } = render(<Probe on />);
    const flag = () => screen.getByTestId('flag').textContent;
    act(() => vi.advanceTimersByTime(149));
    expect(flag()).toBe('hidden');
    act(() => vi.advanceTimersByTime(1));
    expect(flag()).toBe('shown');
    rerender(<Probe on={false} />);
    act(() => vi.advanceTimersByTime(299));
    expect(flag()).toBe('shown');
    act(() => vi.advanceTimersByTime(1));
    expect(flag()).toBe('hidden');
    // A quick request never shows it at all.
    rerender(<Probe on />);
    act(() => vi.advanceTimersByTime(100));
    rerender(<Probe on={false} />);
    act(() => vi.advanceTimersByTime(500));
    expect(flag()).toBe('hidden');
    render(<Spinner label="Sending" />);
    expect(screen.queryByRole('status', { name: 'Sending' })).toBeNull();
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('status', { name: 'Sending' })).toBeTruthy();
  });

  it('badges counts, and hides a zero', () => {
    const { container, rerender } = render(<Badge count={0} />);
    expect(container.textContent).toBe('');
    rerender(<Badge count={3} label="3 new" />);
    expect(screen.getByLabelText('3 new').textContent).toBe('3');
    rerender(<Badge count={120} />);
    expect(container.textContent).toBe('99+');
  });

  it('marks the next account with the luck colour and expired tokens with ember text', () => {
    render(
      <>
        <Tag tone="next">next →</Tag>
        <Tag tone="warn">token expired</Tag>
      </>,
    );
    expect(screen.getByText('next →').className).toContain('bg-jup-fill');
    expect(screen.getByText('token expired').className).toContain('text-signal-text');
  });

  it('keeps rail words in sentence case in the DOM, with the count inside the heading', () => {
    render(
      <RailLabel count={2} tone="needs">
        Needs you
      </RailLabel>,
    );
    const h = screen.getByRole('heading', { name: /Needs you/ });
    expect(h.textContent).toBe('Needs you2');
    expect(h.className).toContain('type-rail');
    expect(h.querySelector('.text-signal-text')?.textContent).toBe('2');
  });

  it('defines all six glyphs in the legend', () => {
    render(<Legend />);
    expect(LEGEND.map((l) => l.state)).toEqual(['needs', 'working', 'compacting', 'turn', 'stale', 'ended']);
    expect(screen.getByText('Claude finished and is waiting for your next prompt.')).toBeTruthy();
  });
});

describe('strip', () => {
  const items: StripItem[] = [
    { id: 'a', state: 'needs', label: 'web-app · Question · 4m' },
    { id: 'b', state: 'needs', label: 'infra · Plan · 2m' },
    { id: 'c', state: 'turn', label: 'docs · Your turn · 9m' },
    { id: 'd', state: 'compacting', label: 'notes · Compacting · 1m' },
    { id: 'e', state: 'stale', label: 'crm · No update · 8m' },
  ];

  it('is one tab stop with arrow keys and Enter on desktop', () => {
    const onOpen = vi.fn();
    render(<Strip items={items} onOpen={onOpen} />);
    const box = screen.getByRole('listbox');
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.getAttribute('aria-label'))).toEqual(items.map((i) => i.label));
    // 3 px inside a group, 8 px between groups.
    expect(opts.map((o) => (o.className.includes('ml-8') ? 8 : o.className.includes('ml-3') ? 3 : 0))).toEqual([0, 3, 8, 8, 3]);
    fireEvent.focus(box);
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    expect(screen.getByRole('tooltip').textContent).toBe('web-app · Question · 4m');
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith('e');
    fireEvent.click(opts[1]!);
    expect(onOpen).toHaveBeenLastCalledWith('b');
  });

  it('is a single legend button on phones, dashed while offline', () => {
    const onLegend = vi.fn();
    render(<Strip items={items} onLegend={onLegend} dashed />);
    const b = screen.getByRole('button', { name: /Tap for the legend/ });
    expect(screen.queryByRole('option')).toBeNull();
    expect(b.getAttribute('data-dashed')).toBe('true');
    // Every cell is drawn as a dashed outline (12 rects).
    expect(Array.from(b.querySelectorAll('svg')).every((s) => s.querySelectorAll('rect').length === 12)).toBe(true);
    fireEvent.click(b);
    expect(onLegend).toHaveBeenCalledTimes(1);
  });
});

describe('shell data', () => {
  it('labels strip cells with folder, state word and age, in board order', () => {
    const q = pending('web-app', { kind: 'question', tool: 'AskUserQuestion', createdAt: iso(60_000) });
    const perm = pending('api', { kind: 'permission', tool: 'Bash' });
    const st = stateWith({
      sessions: [session('docs', { status: 'idle', statusSince: iso(0) }), session('web-app', { statusSince: iso(60_000) }), session('api', { statusSince: iso(120_000) }), session('term', { status: 'waiting', statusSince: iso(0) })],
      pending: [q, perm],
    });
    expect(needsWord(st, 'api')).toBe('Permission · Bash');
    expect(needsWord(st, 'term')).toBe('Waiting in the terminal');
    const cells = stripItems(st, NOW);
    expect(cells.map((c) => c.state)).toEqual(['needs', 'needs', 'needs', 'turn']);
    expect(cells.find((c) => c.id === 'web-app')!.label).toBe('web-app · Question · 4m');
    expect(cells.at(-1)!.label).toBe('docs · Your turn · 5m');
  });

  it('lists every account 5h % in id order, with no number for a stale token', () => {
    const st = stateWith({
      accounts: [
        account(3, { windows: [{ kind: 'five_hour', pct: 81.4 }] }),
        account(1),
        account(11, { usageStatus: 'token_expired' }),
        account(6, { windows: [{ kind: 'seven_day', pct: 4 }] }),
      ],
    });
    // Account 06 has no 5-hour window open: 0, as the Accounts screen shows it.
    expect(usagePairs(st, NOW)).toEqual([
      { id: '01', pct: 42 },
      { id: '03', pct: 81 },
      { id: '06', pct: 0 },
      { id: '11', pct: null },
    ]);
  });

  it('uses the daemon default ceiling until the API carries it', () => {
    expect(DEFAULT_CEILING).toBe(AutoswitchSettingsSchema.parse({}).ceiling);
  });
});

describe('document chrome', () => {
  it('counts needs-you in the title and swaps the favicon', () => {
    expect(documentTitle(0)).toBe(PRODUCT_NAME);
    expect(documentTitle(2)).toBe(`(2) ${PRODUCT_NAME}`);
    expect(screenTitle('web-app')).toBe(`web-app · ${PRODUCT_NAME}`);
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = '/favicon.svg';
    document.head.append(link);
    setFavicon(true);
    expect(link.getAttribute('href')).toBe('/favicon-needs.svg');
    setFavicon(false);
    expect(link.getAttribute('href')).toBe('/favicon.svg');
    link.remove();
  });

  it('points theme-color at the chosen theme without colour literals in code', () => {
    const day = document.createElement('meta');
    day.name = 'theme-color';
    day.content = '#f7f5ef';
    day.setAttribute('media', '(prefers-color-scheme: light)');
    const night = document.createElement('meta');
    night.name = 'theme-color';
    night.content = '#0f1527';
    night.setAttribute('media', '(prefers-color-scheme: dark)');
    document.head.append(day, night);
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect([day.content, night.content]).toEqual(['#0f1527', '#0f1527']);
    expect(day.hasAttribute('media')).toBe(false);
    applyTheme('light');
    expect([day.content, night.content]).toEqual(['#f7f5ef', '#f7f5ef']);
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect([day.content, night.content]).toEqual(['#f7f5ef', '#0f1527']);
    expect(night.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
    day.remove();
    night.remove();
  });

  it('treats keys typed into fields as typing', () => {
    const input = document.createElement('input');
    const div = document.createElement('div');
    expect(isTyping(input)).toBe(true);
    expect(isTyping(div)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
