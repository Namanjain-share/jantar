/**
 * SplitPane (kit/SplitPane.tsx, 0.11 c08): split or single by the pane's own
 * width, the same two sections at every width (so the open detail is never
 * remounted by a resize), nothing rendered behind an open item in single
 * mode, the list's scroll kept, and Esc in split mode.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paneScroll } from '../src/ui/kit/Pane.js';
import { guessSplit, SplitPane, splitFor, useSplit, type SplitPaneProps } from '../src/ui/kit/SplitPane.js';
import { createLayoutStore, layoutAt, LayoutProvider, type LayoutStore } from '../src/ui/shell/layout.js';

let listRenders = 0;
function List() {
  listRenders++;
  const s = useSplit();
  return (
    <ul aria-label="Items">
      <li>{`split ${s?.split} wide ${s?.wide} selected ${s?.selected}`}</li>
    </ul>
  );
}

/** An open item with something typed into it: state a remount would lose. */
function Item({ id }: { id: string }) {
  const [text, setText] = useState('');
  return (
    <label>
      {`Note on ${id}`}
      <input value={text} onChange={(e) => setText(e.target.value)} />
    </label>
  );
}

function Harness({ layout, ...props }: { layout: LayoutStore } & Partial<SplitPaneProps>) {
  return (
    <LayoutProvider value={layout}>
      <SplitPane name="test" list={<List />} detail={null} listLabel="List" detailLabel="Item" {...props} />
    </LayoutProvider>
  );
}

function show(layout: LayoutStore, props: Partial<SplitPaneProps> = {}) {
  const r = render(<Harness layout={layout} {...props} />);
  return { ...r, again: (next: Partial<SplitPaneProps>) => r.rerender(<Harness layout={layout} {...next} />) };
}

const sections = (c: HTMLElement) => [...c.querySelectorAll('section')];
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

beforeEach(() => {
  listRenders = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('split or single', () => {
  it('measured: 800 splits, 1180 takes the wide list column', () => {
    expect([799, 800, 1179, 1180, 1384].map(splitFor)).toEqual([
      { split: false, wide: false },
      { split: true, wide: false },
      { split: true, wide: false },
      { split: true, wide: true },
      { split: true, wide: true },
    ]);
  });

  it("without a measure (jsdom: width 0) it splits from a 1024 window, as 0.10's ledger did, with the 340 column; the phone is single", () => {
    expect(guessSplit(layoutAt(0))).toEqual({ split: false, wide: false });
    expect(guessSplit(layoutAt(390))).toEqual({ split: false, wide: false });
    expect(guessSplit(layoutAt(900))).toEqual({ split: false, wide: false });
    expect(guessSplit(layoutAt(1100))).toEqual({ split: true, wide: false });
    // c23: no window query says 1280 any more; only a measure gives the 440 column.
    expect(guessSplit(layoutAt(1440))).toEqual({ split: true, wide: false });
    // The default jsdom window: single.
    const { container } = render(<SplitPane name="test" list={<List />} detail={null} listLabel="List" detailLabel="Item" />);
    expect(screen.getByText(/^split false/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'List' })).toBeNull();
    expect(container.querySelector('.split')?.hasAttribute('data-split')).toBe(false);
  });

  it('a measured pane decides by its own width, and re-renders only when the width crosses 800 or 1180', () => {
    let width = 900;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 600, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, toJSON: () => ({}) }));
    let observed: ((entries: Array<{ contentRect: { width: number } }>) => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: typeof observed) {
          observed = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      // A 956 window on a Mac (pane 900): 0.10 showed one column there; the pane is wide enough to split.
      show(createLayoutStore(layoutAt(956)));
      expect(screen.getByText('split true wide false selected false')).toBeTruthy();
      const before = listRenders;
      const resize = (w: number) => act(() => observed?.([{ contentRect: { width: w } }]));
      resize(1000);
      resize(1100);
      expect(listRenders).toBe(before);
      resize(1200);
      expect(screen.getByText('split true wide true selected false')).toBeTruthy();
      resize(700);
      expect(screen.getByText('split false wide false selected false')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the two sections', () => {
  it('split: the list and the detail side by side, labelled; the empty view while nothing is open', () => {
    const layout = createLayoutStore(layoutAt(1440));
    const { again } = show(layout, { empty: <p>Desk</p> });
    expect(within(screen.getByRole('region', { name: 'List' })).getByRole('list', { name: 'Items' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Item' })).getByText('Desk')).toBeTruthy();
    again({ empty: <p>Desk</p>, detail: <Item id="a" />, selection: 'a' });
    expect(within(screen.getByRole('region', { name: 'List' })).getByText('split true wide false selected true')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Item' })).getByLabelText('Note on a')).toBeTruthy();
    expect(screen.queryByText('Desk')).toBeNull();
  });

  it("fill: in split with nothing open, the list takes the width (data-fill), and the detail section is empty", () => {
    const { container } = show(createLayoutStore(layoutAt(1440)));
    expect(container.querySelector('.split')?.hasAttribute('data-fill')).toBe(true);
    const [, detail] = sections(container);
    expect(detail!.hidden).toBe(true);
    expect(detail!.childElementCount).toBe(0);
  });

  it('noList: in split, the detail takes the pane and the list section stays in place, empty (Chat before its first day)', () => {
    const { container } = show(createLayoutStore(layoutAt(1440)), { detail: <Item id="t" />, selection: 't', noList: true });
    const [list, detail] = sections(container);
    expect(container.querySelector('.split')?.hasAttribute('data-nolist')).toBe(true);
    expect(list!.hidden).toBe(true);
    expect(list!.childElementCount).toBe(0);
    expect(within(detail!).getByText('Note on t')).toBeTruthy();
  });

  it('single: the inactive section stays in its place, empty and hidden; nothing behind the open item renders', () => {
    const layout = createLayoutStore(layoutAt(900));
    const { container, again } = show(layout, { empty: <p>Desk</p> });
    let [list, detail] = sections(container);
    expect(list!.hidden).toBe(false);
    expect(within(list!).getByRole('list', { name: 'Items' })).toBeTruthy();
    expect(detail!.hidden).toBe(true);
    expect(screen.queryByText('Desk')).toBeNull();
    const rendersBefore = listRenders;
    again({ empty: <p>Desk</p>, detail: <Item id="a" />, selection: 'a' });
    [list, detail] = sections(container);
    expect(list!.hidden).toBe(true);
    expect(list!.childElementCount).toBe(0);
    expect(listRenders).toBe(rendersBefore);
    expect(within(detail!).getByLabelText('Note on a')).toBeTruthy();
    // Neither is a landmark when only one shows.
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('the open detail keeps its DOM node, and what was typed, across every resize', () => {
    const layout = createLayoutStore(layoutAt(1440));
    show(layout, { detail: <Item id="a" />, selection: 'a' });
    const field = screen.getByLabelText('Note on a') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'half a thought' } });
    for (const width of [900, 390, 1100, 1440]) {
      act(() => layout.setState(layoutAt(width), true));
      expect(screen.getByLabelText('Note on a')).toBe(field);
    }
    expect(field.value).toBe('half a thought');
  });
});

describe('scroll and keys', () => {
  const tops = new WeakMap<Element, number>();
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, v: number) {
        tops.set(this, v);
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
  });

  it("single: the list's scroll comes back from the Map when the list shows again", async () => {
    const layout = createLayoutStore(layoutAt(900));
    const { container, again } = show(layout);
    const [list] = sections(container);
    list!.scrollTop = 320;
    fireEvent.scroll(list!);
    await frame();
    expect(paneScroll('test:list')).toBe(320);
    again({ detail: <Item id="a" />, selection: 'a' });
    // A hidden box loses its scroll in a browser.
    list!.scrollTop = 0;
    again({ detail: null });
    expect(sections(container)[0]).toBe(list);
    expect(list!.scrollTop).toBe(320);
  });

  it("beside an open item the list brings that item's row (aria-current) into view; not in single", () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    const Rows = () => (
      <ul>
        <li>first</li>
        <li aria-current="true">open one</li>
      </ul>
    );
    const r = render(
      <LayoutProvider value={createLayoutStore(layoutAt(1440))}>
        <SplitPane name="rows" list={<Rows />} detail={<Item id="b" />} selection="b" listLabel="List" detailLabel="Item" />
      </LayoutProvider>,
    );
    expect(spy.mock.contexts.at(-1)).toBe(screen.getByText('open one'));
    r.unmount();
    spy.mockClear();
    render(
      <LayoutProvider value={createLayoutStore(layoutAt(900))}>
        <SplitPane name="rows" list={<Rows />} detail={<Item id="b" />} selection="b" listLabel="List" detailLabel="Item" />
      </LayoutProvider>,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('Esc closes the open item in split mode, not in single, and not while escape is off', () => {
    const onClose = vi.fn();
    const layout = createLayoutStore(layoutAt(1440));
    const { again } = show(layout, { detail: <Item id="a" />, selection: 'a', onClose });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    again({ detail: <Item id="a" />, selection: 'a', onClose, escape: false });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    again({ detail: <Item id="a" />, selection: 'a', onClose });
    act(() => layout.setState(layoutAt(900), true));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
