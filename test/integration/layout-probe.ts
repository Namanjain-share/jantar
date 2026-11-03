/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * What the wide-window suite (web-v011-layout.integration.test.ts) reads in
 * the page: a port of the iPad study's measuring script (build plan 6.2; it
 * lives outside the repo, so it can't be imported). `probeLayout` runs in
 * the page through page.evaluate, so it is one self-contained function; the
 * numbers are worked out in Node by packages/web/test/layout-metric.ts.
 *
 * - region: the content region, main#main and (c33) the Chat panel when it
 *   is open beside it (6.2 #3), inside the viewport.
 * - boxes: the content boxes in it, each cut to the viewport and to every
 *   box that clips it: visible text runs (one per line), pictures (img, svg,
 *   canvas, video), form fields, and painted boxes (a background other than
 *   the one behind it: a card, a chip, a button, a meter, a selected row).
 *   A border alone is not content. A pane's own ground (90 % of its pane's
 *   width and height or more) is not either.
 * - sideways: the page scrolling sideways, and every box that scrolls or
 *   cuts its content sideways, unless it (or a box around it) says it is
 *   meant to with data-scroll-x (the terminal mirror, the code view, the
 *   Accounts runway, the phone's chip strips).
 * - targets: every control on screen, for the 44 pt check (c33).
 * - whole: the controls wholly on screen (not cut by the viewport or a box
 *   that clips them), at their own size: the 44 pt check (6.2 #2, A1)
 *   reads these, so a row half scrolled out of view isn't a small target.
 * - fixed: the controls among them that don't scroll (no box around them
 *   scrolls up and down): the chrome, a pane's header, a pinned composer.
 *   On an iPad they must stay out of the safe areas (6.2 #4, A2); content
 *   in a scroll box may pass under them.
 * - exempt: why this state isn't measured for width, when it isn't (an
 *   empty state, a place that is off).
 * - selected: with an item open beside its list, whether the list's row for
 *   it (aria-current) is in view in the list column; null with none.
 * - scrollers (c32, 6.2 #6, A6): the boxes that scroll up and down inside
 *   the page and are shorter than 120 px, where a finger can't scroll them.
 * - type (c33, 6.2 #5, A5): the characters on screen (in the open modal
 *   when there is one), how many are under 12 px and under 11 px, and the
 *   smallest size seen.
 * - keycaps (c33, 6.2 #8, A4): the keycaps on screen.
 */
import type { Named, Rect } from '../../packages/web/test/layout-metric.js';

export interface Probe {
  vw: number;
  vh: number;
  /** The shell's chrome (phone, touch, desk), or null on a bare screen. */
  chrome: string | null;
  region: Rect | null;
  boxes: Rect[];
  sideways: string[];
  targets: Named[];
  whole: Named[];
  fixed: Named[];
  exempt: string | null;
  selected: { inView: boolean; name: string } | null;
  scrollers: string[];
  type: { chars: number; under12: number; under11: number; smallest: string; small: string[] };
  keycaps: number;
}

export function probeLayout(): Probe {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  type Box = { l: number; t: number; r: number; b: number };
  const VIEW: Box = { l: 0, t: 0, r: vw, b: vh };
  const cut = (a: Box, b: Box): Box => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const boxOf = (r: DOMRect): Box => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const rectOf = (b: Box): Rect | null => (b.r - b.l > 0 && b.b - b.t > 0 ? { x: Math.round(b.l), y: Math.round(b.t), w: Math.round(b.r - b.l), h: Math.round(b.b - b.t) } : null);
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element) => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  const describe = (el: Element) => {
    const label = el.getAttribute('aria-label');
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 4).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${label ? `[${label.slice(0, 30)}]` : ''}${cls ? `.${cls}` : ''}`.slice(0, 100);
  };
  // What clips an element: the viewport and every ancestor that doesn't show its overflow.
  const clips = new Map<Element, Box>();
  const clipOf = (el: Element): Box => {
    const known = clips.get(el);
    if (known) return known;
    const p = el.parentElement;
    let c = VIEW;
    if (p) {
      c = clipOf(p);
      const s = style(p);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') c = cut(c, boxOf(p.getBoundingClientRect()));
    }
    clips.set(el, c);
    return c;
  };
  const visible = (el: Element) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  const main = document.querySelector('main#main');
  const out: Probe = { vw, vh, chrome: document.querySelector('[data-chrome]')?.getAttribute('data-chrome') ?? null, region: null, boxes: [], sideways: [], targets: [], whole: [], fixed: [], exempt: null, selected: null, scrollers: [], type: { chars: 0, under12: 0, under11: 0, smallest: '', small: [] }, keycaps: 0 };
  const dock = document.querySelector('aside[data-chat-dock]');
  if (main) {
    const m = boxOf(main.getBoundingClientRect());
    const d = dock ? boxOf(dock.getBoundingClientRect()) : null;
    out.region = rectOf(cut(VIEW, d ? { l: Math.min(m.l, d.l), t: Math.min(m.t, d.t), r: Math.max(m.r, d.r), b: Math.max(m.b, d.b) } : m));
    const push = (el: Element, r: DOMRect) => {
      const b = rectOf(cut(clipOf(el), boxOf(r)));
      if (b) out.boxes.push(b);
    };
    const roots = dock ? [main, dock] : [main];
    // Text runs, one box per line.
    const range = document.createRange();
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode as Text;
        const el = t.parentElement;
        if (!el || !(t.textContent ?? '').trim() || !visible(el)) continue;
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) push(el, r);
      }
    }
    // Pictures and fields.
    for (const el of roots.flatMap((r) => [...r.querySelectorAll('img, svg, canvas, video, input:not([type=hidden]), textarea, select')])) {
      if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) continue;
      if (visible(el)) push(el, el.getBoundingClientRect());
    }
    // Painted boxes: a background of their own, other than a pane's ground.
    const paint = (el: Element | null): string => {
      for (let e = el; e; e = e.parentElement) {
        const bg = style(e).backgroundColor;
        if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
      }
      return 'none';
    };
    for (const el of roots.flatMap((r) => [...r.querySelectorAll('*')])) {
      const bg = style(el).backgroundColor;
      if (!bg || bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg)) continue;
      if (bg === paint(el.parentElement) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      const pane = el.parentElement?.closest('[data-pane], .split-list, .split-detail, main, aside[data-chat-dock]') ?? main;
      const pr = pane.getBoundingClientRect();
      if (r.width >= 0.9 * pr.width && r.height >= 0.9 * pr.height) continue;
      push(el, r);
    }
    if (main.querySelector('[data-empty-state]')) out.exempt = 'an empty state';
    // The open item's row in the list beside it.
    const list = main.querySelector('.split[data-split] > .split-list');
    const row = list?.querySelector('[aria-current="true"]');
    if (list && row) {
      const l = list.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      out.selected = { inView: r.bottom > l.top && r.top < l.bottom && r.bottom > 0 && r.top < vh, name: describe(row) };
    }
  }

  // Sideways: the page, then every box that scrolls or cuts sideways.
  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollWidth > vw + 1) out.sideways.push(`the page scrolls sideways: ${root.scrollWidth} px in ${vw}`);
  for (const el of document.querySelectorAll('body *')) {
    const s = style(el);
    if (s.overflowX !== 'auto' && s.overflowX !== 'scroll') continue;
    if (el.scrollWidth <= el.clientWidth + 1 || el.closest('[data-scroll-x]') || !visible(el)) continue;
    out.sideways.push(`${describe(el)}: ${el.scrollWidth} px in ${el.clientWidth}`);
  }

  // Type (A5): every character on screen, by the size it is drawn at; with a modal open, the modal's (the page
  // under it is measured in its own shot, as for the width).
  {
    const modal = [...document.querySelectorAll('[role="dialog"]')].filter((d) => visible(d)).pop();
    const walker = document.createTreeWalker(modal ?? document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let least = Infinity;
    let leastAt = '';
    const by = new Map<string, number>();
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      const el = t.parentElement;
      const n = (t.textContent ?? '').replace(/\s/g, '').length;
      if (!el || !n || !visible(el)) continue;
      range.selectNodeContents(t);
      const shown = [...range.getClientRects()].some((r) => {
        const c = cut(clipOf(el), boxOf(r));
        return c.r - c.l > 0 && c.b - c.t > 0;
      });
      if (!shown) continue;
      const px = parseFloat(style(el).fontSize);
      out.type.chars += n;
      if (px < 12) {
        out.type.under12 += n;
        // Tallied by the element's type class (or tag), so a failure says what is small.
        const cls = typeof el.className === 'string' ? (el.className.match(/\b(?:type|text)-[a-z]+\b/)?.[0] ?? '') : '';
        const key = `${cls || el.tagName.toLowerCase()} in ${el.closest('nav, header, [role="dialog"], main, aside')?.tagName.toLowerCase() ?? 'body'}`;
        by.set(key, (by.get(key) ?? 0) + n);
      }
      if (px < 11) out.type.under11 += n;
      if (px < least) {
        least = px;
        leastAt = `${px}px in ${describe(el)}: ${(t.textContent ?? '').trim().slice(0, 30)}`;
      }
    }
    out.type.smallest = leastAt;
    out.type.small = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}: ${v}`);
  }
  // Keycap hints, not the ? list's keys (shell/Shortcuts.tsx, [data-keys-list]), which are the list itself.
  out.keycaps = [...document.querySelectorAll('kbd')].filter((k) => !k.closest('[data-keys-list]') && visible(k) && k.getBoundingClientRect().width > 0).length;

  // Nested scrollers too short to scroll with a finger (A6): a box on screen that scrolls up and down, under 120 px tall.
  for (const el of document.querySelectorAll('body *')) {
    const y = style(el).overflowY;
    if (y !== 'auto' && y !== 'scroll') continue;
    if (el.scrollHeight <= el.clientHeight + 1 || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || r.width < 1) continue;
    if (el.clientHeight < 120) out.scrollers.push(`${describe(el)}: ${el.clientHeight} px tall`);
  }

  // Whether a box around `el` scrolls up and down (so it may pass under the safe areas).
  const scrolls = (el: Element): boolean => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const y = style(p).overflowY;
      if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight + 1) return true;
    }
    return false;
  };
  // Controls on screen (the 44 pt check reads them on touch).
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=menuitem], [role=option], [role=slider], [role=link]';
  for (const el of document.querySelectorAll(SEL)) {
    // Not a control anyone reaches: hidden from assistive tech and taps alike (a kept-mounted file input).
    if (el.parentElement?.closest(SEL) || !visible(el) || el.closest('[aria-hidden="true"], [inert]')) continue;
    let r = el.getBoundingClientRect();
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox' || el.type === 'file') && (r.width <= 2 || r.height <= 2)) {
      const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      if (!label) continue;
      r = label.getBoundingClientRect();
    }
    const b = rectOf(cut(clipOf(el), boxOf(r)));
    if (!b) continue;
    const name = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const named = { ...b, name: name || describe(el) };
    out.targets.push(named);
    if (!scrolls(el)) out.fixed.push(named);
    const own = rectOf(boxOf(r));
    if (own && own.w === b.w && own.h === b.h) out.whole.push({ ...named, name: `${named.name} <${describe(el)}>` });
  }
  return out;
}
