/*
 * The launch film's stage (scripts/launch-video.mjs serves it with data.js).
 *
 * Builds every element of the film or of the GIF (window.STAGE.layout) up
 * front, absolutely placed, and gives each a timeline: keys of opacity,
 * translate, scale, a right-edge clip and display. window.seek(t) sets them
 * all for time t (seconds) and returns a signature of what it set, so the
 * script can reuse the previous screenshot when nothing moved. Nothing runs
 * on a clock: the same t always draws the same frame.
 *
 * Product screens are <img>s of the captures (the real app on the synthetic
 * fixture). Drawn here: the Terminal window (text from FILM_TERMINAL), the
 * push (words from the daemon's notify/format.ts), the tap ring, the
 * captions and the end card. Motion vocabulary: crossfade, slide, push, cut.
 * No zoom, no blur, no 3D, no bounce.
 */
(() => {
  'use strict';
  const D = window.STAGE;
  const GIF = D.layout === 'gif';
  const W = D.size.width;
  const H = D.size.height;
  const stage = document.getElementById('stage');
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;

  // -------------------------------------------------------------- easing
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sx = (u) => ((ax * u + bx) * u + cx) * u;
    const sy = (u) => ((ay * u + by) * u + cy) * u;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0;
      let hi = 1;
      let u = x;
      for (let i = 0; i < 48; i++) {
        const v = sx(u);
        if (Math.abs(v - x) < 1e-7) break;
        if (v < x) lo = u;
        else hi = u;
        u = (lo + hi) / 2;
      }
      return sy(u);
    };
  }
  /** The app's easings (tokens.css): --ease-out for arrivals, --ease-sheet for pushes. */
  const EASE = {
    linear: (p) => p,
    out: bezier(0.16, 1, 0.3, 1),
    sheet: bezier(0.32, 0.72, 0, 1),
    in: bezier(0.4, 0, 1, 1),
  };

  // -------------------------------------------------------------- tracks
  /** Defaults: opacity, x, y, scale, clip from the right (%), display (0: none). */
  const DEF = { o: 1, x: 0, y: 0, s: 1, cr: 0, d: 1 };
  const tracks = new Map();
  let order = 0;
  function key(el, prop, t, v, e) {
    let m = tracks.get(el);
    if (!m) {
      m = {};
      tracks.set(el, m);
    }
    (m[prop] ??= []).push({ t, v, e: e ?? 'step', n: order++ });
  }
  /** Jump to `v` at `t`. */
  const set = (el, prop, t, v) => key(el, prop, t, v, 'step');
  /** From `v0` at `t0` to `v1` at `t1`. */
  function tw(el, prop, t0, t1, v0, v1, e = 'out') {
    key(el, prop, t0, v0, 'step');
    key(el, prop, t1, v1, e);
  }
  function valueAt(keys, t) {
    if (t < keys[0].t) return keys[0].v;
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
    const k = keys[i];
    const n = keys[i + 1];
    if (!n || n.e === 'step') return k.v;
    return k.v + (n.v - k.v) * EASE[n.e]((t - k.t) / (n.t - k.t));
  }
  /**
   * Set every element for time t. Returns a signature of what shows: an
   * element that is hidden, or under a hidden one, signs as hidden, so two
   * times that look the same sign the same.
   */
  function seek(t) {
    const shown = new Map();
    const values = [];
    for (const [el, m] of tracks) {
      const v = {};
      for (const p of Object.keys(DEF)) v[p] = m[p] ? valueAt(m[p], t) : DEF[p];
      const o = Math.max(0, Math.min(1, v.o));
      const tr = `translate(${v.x.toFixed(2)}px, ${v.y.toFixed(2)}px)${v.s === 1 ? '' : ` scale(${v.s.toFixed(4)})`}`;
      el.style.transform = tr;
      el.style.opacity = o.toFixed(3);
      el.style.visibility = o < 0.002 ? 'hidden' : '';
      if (m.d) el.style.display = v.d >= 0.5 ? '' : 'none';
      if (m.cr) el.style.clipPath = `inset(0 ${v.cr.toFixed(2)}% 0 0)`;
      shown.set(el, o >= 0.002 && v.d >= 0.5);
      values.push([el, `${tr}${o.toFixed(3)}${m.cr ? v.cr.toFixed(2) : ''}`]);
    }
    const visible = (el) => {
      for (let e = el; e && e !== stage; e = e.parentElement) if (shown.get(e) === false) return false;
      return true;
    };
    return values.map(([el, sig]) => (visible(el) ? sig : '-')).join('|');
  }

  // -------------------------------------------------------------- elements
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function el(tag, cls, parent = stage, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    parent.appendChild(e);
    return e;
  }
  function place(e, x, y, w, h) {
    e.style.left = `${x}px`;
    e.style.top = `${y}px`;
    if (w != null) e.style.width = `${w}px`;
    if (h != null) e.style.height = `${h}px`;
    return e;
  }
  const scene = (id) => D.scenes.find((s) => s.id === id);
  const part = (id) => D.cut.find((g) => g.id === id);

  // -------------------------------------------------------------- layout
  const L = GIF
    ? {
        vars: {
          '--rail-size': '10px',
          '--kicker-size': '11px',
          '--kicker-gap': '6px',
          '--cap-size': '26px',
          '--cap-lh': '32px',
          '--cap-big-size': '26px',
          '--cap-big-lh': '32px',
          '--win-radius': '8px',
          '--tab-h': '26px',
          '--tab-pad': '4px',
          '--tab-size': '9px',
          '--term-pad-x': '14px',
          '--term-pad-y': '10px',
          '--term-size': '10.5px',
          '--term-lh': '15px',
          '--bezel': '8px',
          '--screen-radius': '26px',
          '--clock-size': '72px',
          '--push-radius': '14px',
          '--push-pad': '12px 14px',
          '--push-gap': '7px',
          '--push-from': '11px',
          '--push-title': '17px',
          '--push-body': '14px',
          '--tap-border': '2.5px',
          '--row-border': '2px',
          '--end-name': '78px',
          '--end-tag': '25px',
          '--end-url': '20px',
          '--end-meta': '11.5px',
          '--end-foot': '10px',
        },
        rail: { x: 20, y: 14, right: false },
        term: { x: 20, y: 34, w: 564, h: 398 },
        phone: { x: 604, y: 16, sw: 320, bezel: 8 },
        cardY: -182,
        cap: { x: 22, y: 456 },
        tap: 36,
        clockTop: 64,
        pushTop: 170,
        mark: 52,
        markGap: 18,
        endGap: [18, 22, 14],
        footBottom: 26,
        dial: { r1: 170, r2: 184 },
      }
    : {
        vars: {
          '--rail-size': '16px',
          '--kicker-size': '22px',
          '--kicker-gap': '16px',
          '--cap-size': '46px',
          '--cap-lh': '56px',
          '--cap-big-size': '58px',
          '--cap-big-lh': '68px',
          '--win-radius': '12px',
          '--tab-h': '48px',
          '--tab-pad': '14px',
          '--tab-size': '16px',
          '--term-pad-x': '28px',
          '--term-pad-y': '22px',
          '--term-size': '19px',
          '--term-lh': '28px',
          '--bezel': '12px',
          '--screen-radius': '36px',
          '--clock-size': '108px',
          '--push-radius': '18px',
          '--push-pad': '18px 20px',
          '--push-gap': '10px',
          '--push-from': '15px',
          '--push-title': '23px',
          '--push-body': '19px',
          '--tap-border': '3px',
          '--row-border': '3px',
          '--end-name': '136px',
          '--end-tag': '44px',
          '--end-url': '36px',
          '--end-meta': '21px',
          '--end-foot': '17px',
        },
        rail: { x: W - 96, y: 32, right: true },
        term: { x: 96, y: 72, w: 1180, h: 764 },
        termCenter: (W - 1180) / 2 - 96,
        phone: { x: 1376, y: 72, sw: 420, bezel: 12 },
        cap: { x: 96, y: 872 },
        capBig: { x: 96, cy: 520 },
        mac: { x: 96, y: 72, w: 1216 },
        tap: 56,
        clockTop: 120,
        pushTop: 300,
        mark: 92,
        markGap: 30,
        endGap: [34, 40, 24],
        footBottom: 56,
        dial: { r1: 330, r2: 352 },
      };
  for (const [k, v] of Object.entries(L.vars)) stage.style.setProperty(k, v);
  const px = (name) => parseFloat(L.vars[name]);

  // -------------------------------------------------------------- the Terminal window
  const term = place(el('div', 'abs term'), L.term.x, L.term.y, L.term.w, L.term.h);
  const tabbar = el('div', 'tabbar', term);
  const tabs = {};
  for (const name of D.terminal.tabs) {
    const t = el('div', 'tab', tabbar);
    const on = el('i', 'abs on', t);
    on.style.left = '0';
    on.style.top = '0';
    on.style.right = '0';
    on.style.bottom = '-1px';
    const lb = el('span', '', t, esc(name));
    const lit = el('b', 'abs lit', lb, esc(name));
    lit.style.fontWeight = 'inherit';
    set(on, 'o', 0, 0);
    set(lit, 'o', 0, 0);
    tabs[name] = { on, lit };
  }
  const tbody = el('div', 'tbody', term);

  /** Claude Code's glyphs, one cell wide whatever font draws them (JetBrains Mono has no ⎿). */
  const GLYPH = /[●⎿❯✻]/g;
  /** One line of Terminal text, coloured as Claude Code draws it (dim hints, the pointer's row, rules). */
  function lineHtml(text) {
    const t = text.replace(/\s+$/, '');
    let cls = '';
    if (/^\s*[─╌]{8,}\s*$/.test(t)) cls = 'rl';
    else if (/^>\s/.test(t)) cls = 'you';
    else if (/❯/.test(t)) cls = 'sel';
    else if (/^\s*(Esc to|Enter to|✻ )/.test(t)) cls = 'dim';
    const html = t ? esc(t).replace(GLYPH, (g) => `<i class="g">${g}</i>`) : ' ';
    return `<div class="ln${cls ? ` ${cls}` : ''}">${html}</div>`;
  }
  /** Lines that fit under the tab bar: a terminal shows the newest, whole lines only. */
  const ROWS = Math.floor((L.term.h - px('--tab-h') - 1 - 2 * px('--term-pad-y')) / px('--term-lh'));
  function page(lines) {
    const p = el('div', 'abs page', tbody, lines.slice(-ROWS).map(lineHtml).join(''));
    p.style.left = 'var(--term-pad-x)';
    p.style.right = 'var(--term-pad-x)';
    p.style.top = 'var(--term-pad-y)';
    set(p, 'o', 0, 0);
    return p;
  }
  const S = D.terminal.screens;
  const pages = {
    landing: page(S.landing.lines),
    payments: page(S.payments.lines),
    search: page(S.search.lines),
    api: page([...D.terminal.context, ...S['api-server'].lines]),
  };
  // api-server after the answer: the context and Claude's line, then the run as it prints, scrolling.
  const kept = [...D.terminal.context, S['api-server'].lines[0], ''];
  const after = page([]);
  const scroll = [...kept, ...D.terminal.after, D.terminal.reply].map((l) => {
    const d = document.createElement('div');
    d.innerHTML = lineHtml(l);
    const ln = d.firstChild;
    after.appendChild(ln);
    return ln;
  });
  const printed = scroll.map((_, i) => (i < kept.length ? -1 : null));
  const afterLines = scroll.slice(kept.length);
  /** The run's line `ln` prints at `t`. */
  const print = (ln, t) => {
    printed[scroll.indexOf(ln)] = t;
  };
  /** Each line shows from when it prints until ROWS newer lines have printed under it. */
  function scrollback() {
    scroll.forEach((ln, j) => {
      const t = printed[j];
      if (t === null) return set(ln, 'd', 0, 0);
      if (t >= 0) {
        set(ln, 'd', 0, 0);
        set(ln, 'd', t, 1);
      }
      const gone = printed[j + ROWS];
      if (gone !== undefined && gone !== null) set(ln, 'd', Math.max(0, gone), 0);
    });
  }
  pages.after = after;

  /** Which tab is in front from `t` (the highlight crossfades in 120 ms; the body cuts). */
  let front = null;
  function frontTab(name, t, pageName, fade = GIF ? 0 : 0.12) {
    if (front) {
      tw(tabs[front].on, 'o', t, t + fade, 1, 0, 'linear');
      tw(tabs[front].lit, 'o', t, t + fade, 1, 0, 'linear');
    }
    tw(tabs[name].on, 'o', t, t + fade, 0, 1, 'linear');
    tw(tabs[name].lit, 'o', t, t + fade, 0, 1, 'linear');
    front = name;
    showPage(pageName, t);
  }
  let shownPage = null;
  function showPage(name, t) {
    if (shownPage) set(pages[shownPage], 'o', t, 0);
    set(pages[name], 'o', t, 1);
    shownPage = name;
  }

  // -------------------------------------------------------------- the phone
  const P = L.phone;
  const SW = P.sw;
  const SH = Math.round((SW * 844) / 390);
  const ph = place(el('div', 'abs'), P.x, P.y, SW + 2 * P.bezel, SH + 2 * P.bezel);
  const buzz = place(el('div', 'abs'), 0, 0, SW + 2 * P.bezel, SH + 2 * P.bezel);
  ph.appendChild(buzz);
  const body = el('div', 'phone', buzz);
  const screen = el('div', 'screen', body);
  screen.style.width = `${SW}px`;
  screen.style.height = `${SH}px`;
  const k = SW / 390;
  /** A point of a capture (CSS px of the 390-wide screen) on the stage, with the phone at rest at (P.x, py). */
  const onPhone = (bx, by, py = P.y) => [P.x + P.bezel + bx * k, py + P.bezel + by * k];

  // The phone at rest: the time, then the push.
  const lock = el('div', 'abs lock', screen);
  const clock = el('div', 'clock', lock, esc(D.push.clock));
  clock.style.top = `${L.clockTop}px`;
  const push = place(el('div', 'abs push', lock), 14 * (SW / 420), L.pushTop, SW - 28 * (SW / 420));
  const pmark = Math.round(px('--push-from') * 1.15);
  const markSvg = (size) =>
    `<svg viewBox="0 0 14 14" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true">${D.mark
      .map(([x, y, w, h, role]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--t-${role === 'needs' ? 'signal' : 'ink'})"/>`)
      .join('')}</svg>`;
  push.innerHTML = `<div class="from">${markSvg(pmark)}<span>Jantar · now</span></div><p class="title">${esc(D.push.title)}</p><p class="body">${esc(D.push.body)}</p>`;
  set(push, 'o', 0, 0);

  const layer = {};
  for (const [name, shot] of Object.entries(D.shots)) {
    if (name.endsWith('-desktop')) continue;
    const d = el('div', 'abs', screen);
    const img = el('img', '', d);
    img.src = shot.src;
    img.alt = '';
    set(d, 'o', 0, 0);
    layer[name] = d;
  }
  layer.lock = lock;
  set(lock, 'o', 0, 0);
  let onScreen = null;
  /** Show `name` on the phone from `t`: a crossfade of `dur` s, or a cut (0). */
  function phoneShows(name, t, dur = GIF ? 0 : 0.24) {
    if (onScreen === name) return;
    if (dur > 0) {
      tw(layer[name], 'o', t, t + dur, 0, 1, 'linear');
      if (onScreen) set(layer[onScreen], 'o', t + dur, 0);
    } else {
      set(layer[name], 'o', t, 1);
      if (onScreen) set(layer[onScreen], 'o', t, 0);
    }
    // the incoming layer sits on top
    layer[name].style.zIndex = String(++zTop);
    onScreen = name;
  }
  let zTop = 1;

  /** A tap: the ring shows at (x, y), presses at `t`, lets go and fades. */
  function tap(x, y, t, { appear = 0.4 } = {}) {
    const r = L.tap;
    const ring = place(el('div', 'abs tap'), x - r / 2, y - r / 2, r, r);
    ring.style.transformOrigin = '50% 50%';
    ring.style.zIndex = '20';
    const fill = el('i', '', ring);
    fill.style.position = 'absolute';
    set(fill, 'o', 0, 0);
    tw(ring, 'o', t - appear, t - appear + 0.2, 0, 0.9, 'out');
    tw(ring, 's', t - appear, t - appear + 0.2, 1.25, 1, 'out');
    tw(ring, 's', t, t + 0.12, 1, 0.86, 'out');
    tw(fill, 'o', t, t + 0.12, 0, 0.4, 'out');
    tw(ring, 's', t + 0.12, t + 0.34, 0.86, 1.15, 'out');
    tw(ring, 'o', t + 0.12, t + 0.34, 0.9, 0, 'out');
    tw(fill, 'o', t + 0.12, t + 0.34, 0.4, 0, 'out');
  }
  const center = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const pushCenter = (py = P.y) => onPhone(195, (L.pushTop + push.offsetHeight / 2) / k, py);

  // -------------------------------------------------------------- the Mac window (film)
  let mac = null;
  if (!GIF) {
    const shot = D.shots['board-done-desktop'];
    mac = place(el('div', 'abs mac'), L.mac.x, L.mac.y, L.mac.w);
    const img = el('img', '', mac);
    img.src = shot.src;
    img.alt = '';
    set(mac, 'o', 0, 0);
  }

  // -------------------------------------------------------------- words
  const rail = el('div', 'abs rail', stage, 'Example data');
  rail.style.zIndex = '30';
  if (L.rail.right) {
    rail.style.left = 'auto';
    rail.style.right = `${W - L.rail.x}px`;
    rail.style.top = `${L.rail.y}px`;
  } else place(rail, L.rail.x, L.rail.y);

  /** In over 280 ms (rising 8 px), out over 200 ms; a cut in the GIF. */
  function inOut(box, from, to) {
    if (GIF) {
      tw(box, 'o', from, from + 0.2, 0, 1, 'out');
      set(box, 'o', to, 0);
    } else {
      tw(box, 'o', from, from + 0.28, 0, 1, 'out');
      tw(box, 'y', from, from + 0.28, 8, 0, 'out');
      tw(box, 'o', to - 0.2, to, 1, 0, 'in');
    }
  }
  const kickerH = () => (GIF ? 0 : px('--kicker-size') * 1.2 + px('--kicker-gap'));
  /**
   * A scene's captions. Under the windows: the kicker (the command) stays
   * for all of the scene's captions, the lines below it change. Beside the
   * phone alone (`big`): kicker and lines as one block, centred on the phone.
   */
  function captions(s) {
    if (!s.captions.length) return;
    if (s.captions[0].big) {
      for (const c of s.captions) {
        const box = el('div', 'abs cap cap--big');
        box.style.zIndex = '25';
        if (s.kicker) el('p', 'kicker', box, esc(s.kicker));
        for (const l of c.lines) el('p', 'line', box, esc(l));
        const h = (s.kicker ? kickerH() : 0) + c.lines.length * px('--cap-big-lh');
        place(box, L.capBig.x, Math.round(L.capBig.cy - h / 2));
        inOut(box, c.from, c.to);
      }
      return;
    }
    if (s.kicker && !GIF) {
      const kb = place(el('div', 'abs cap'), L.cap.x, L.cap.y);
      kb.style.zIndex = '25';
      el('p', 'kicker', kb, esc(s.kicker));
      inOut(kb, s.captions[0].from, s.captions.at(-1).to);
    }
    for (const c of s.captions) {
      const box = place(el('div', 'abs cap'), L.cap.x, L.cap.y + kickerH());
      box.style.zIndex = '25';
      for (const l of c.lines) el('p', 'line', box, esc(l));
      inOut(box, c.from, c.to);
    }
  }

  // -------------------------------------------------------------- the end card
  const end = place(el('div', 'abs end'), 0, 0, W, H);
  end.style.zIndex = '40';
  function dialSvg() {
    const { r1, r2 } = L.dial;
    const cx = 0;
    const cy = H;
    const pt = (r, deg) => {
      const a = (deg * Math.PI) / 180;
      return [(cx + r * Math.cos(a)).toFixed(2), (cy - r * Math.sin(a)).toFixed(2)];
    };
    const arc = (r) => {
      const [x0, y0] = pt(r, 0);
      const [x1, y1] = pt(r, 90);
      return `<path d="M${x0} ${y0} A${r} ${r} 0 0 0 ${x1} ${y1}" stroke="var(--t-line)" stroke-width="1"/>`;
    };
    const parts = [arc(r1), arc(r2)];
    for (let deg = 0; deg <= 90; deg += 6) {
      const long = deg % 30 === 0;
      const [x0, y0] = pt(r2, deg);
      const [x1, y1] = pt(r2 + (long ? 16 : 8) * (GIF ? 0.6 : 1), deg);
      const now = deg === 54;
      parts.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="var(--t-${now ? 'jup' : 'line'})" stroke-width="${now ? 2 : 1}"/>`);
    }
    return `<svg class="dial" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${parts.join('')}</svg>`;
  }
  const dial = place(el('div', 'abs', end, dialSvg()), 0, 0, W, H);
  const col = place(el('div', 'abs', end), 0, 0, W, H);
  col.style.display = 'flex';
  col.style.flexDirection = 'column';
  col.style.alignItems = 'center';
  col.style.justifyContent = 'center';
  const row = el('div', '', col);
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = `${L.markGap}px`;
  const markBox = el('div', '', row);
  const M = L.mark;
  const cells = D.mark.map(([x, y, w, h, role]) => ({ x, y, w, h, role }));
  markBox.innerHTML = `<svg viewBox="0 0 14 14" width="${M}" height="${M}" shape-rendering="crispEdges" aria-hidden="true">${cells
    .map((c) => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="var(--t-${c.role === 'needs' ? 'signal' : 'ink'})"/>`)
    .join('')}</svg>`;
  const rects = [...markBox.querySelectorAll('rect')];
  const name = el('div', 'name', row, esc(D.end.name));
  const tagline = el('div', 'tag', col, esc(D.end.tagline));
  tagline.style.marginTop = `${L.endGap[0]}px`;
  const url = el('div', 'url', col, esc(D.end.url));
  url.style.marginTop = `${L.endGap[1]}px`;
  const meta = el('div', 'meta', col, esc(D.end.meta));
  meta.style.marginTop = `${L.endGap[2]}px`;
  const foot = el('div', 'abs foot', end, esc(D.end.foot));
  foot.style.left = '0';
  foot.style.width = `${W}px`;
  foot.style.textAlign = 'center';
  foot.style.top = `${H - L.footBottom}px`;
  // tracked elements are placed by flex, not by left/top
  for (const e of [row, tagline, url, meta]) e.style.position = 'relative';

  /** The end card builds from `t`: the dial, the mark's cells (the needs-you cell last), then the words. */
  function buildEnd(t, step) {
    set(end, 'o', t, 1);
    tw(dial, 'o', t, t + 6 * step, 0, 1, 'linear');
    const orderd = [...rects.keys()].sort((a, b) => (cells[a].role === 'needs') - (cells[b].role === 'needs') || a - b);
    orderd.forEach((i, n) => tw(rects[i], 'o', t + step + n * (step / 2.5), t + step + n * (step / 2.5) + step * 1.5, 0, 1, 'linear'));
    const w0 = t + step + orderd.length * (step / 2.5) + step;
    tw(name, 'o', w0, w0 + 4 * step, 0, 1, 'out');
    tw(name, 'x', w0, w0 + 4 * step, -8, 0, 'out');
    // the mark stays in place; the name slides 8 px into its spot
    tw(tagline, 'o', w0 + 2 * step, w0 + 6 * step, 0, 1, 'out');
    tw(tagline, 'y', w0 + 2 * step, w0 + 6 * step, 8, 0, 'out');
    tw(url, 'o', w0 + 4 * step, w0 + 8 * step, 0, 1, 'out');
    tw(url, 'y', w0 + 4 * step, w0 + 8 * step, 8, 0, 'out');
    tw(meta, 'o', w0 + 6 * step, w0 + 10 * step, 0, 1, 'out');
    tw(foot, 'o', w0 + 7 * step, w0 + 11 * step, 0, 1, 'out');
    return w0 + 11 * step;
  }
  function hideEnd(t) {
    set(end, 'o', t, 0);
    for (const e of [dial, name, tagline, url, meta, foot, ...rects]) set(e, 'o', t, 0);
  }

  // ==============================================================  the film
  function film() {
    const s1 = scene('S1');
    const s2 = scene('S2');
    const s3 = scene('S3');
    const s4 = scene('S4');
    const s5 = scene('S5');
    const s6 = scene('S6');
    const s7 = scene('S7');
    const s8 = scene('S8');
    const s9 = scene('S9');
    hideEnd(0);
    set(rail, 'o', 0, 1);
    set(ph, 'o', 0, 0);

    // S1: twelve tabs; the front tab moves right until it lands on api-server's prompt.
    set(term, 'x', 0, L.termCenter);
    frontTab('landing', s1.start, 'landing', 0);
    frontTab('payments', 1.2, 'payments');
    frontTab('search', 2.4, 'search');
    frontTab('api-server', 3.6, 'api');

    // S2: the Terminal moves left and dims; the phone slides in; the push arrives and buzzes.
    tw(term, 'x', s2.start, s2.start + 0.56, L.termCenter, 0, 'sheet');
    tw(term, 'o', s2.start, s2.start + 0.56, 1, 0.6, 'sheet');
    tw(ph, 'o', s2.start + 0.2, s2.start + 0.68, 0, 1, 'out');
    tw(ph, 'x', s2.start + 0.2, s2.start + 0.68, 48, 0, 'out');
    phoneShows('lock', 0, 0);
    const tp = s2.start + 0.9;
    tw(push, 'o', tp, tp + 0.36, 0, 1, 'out');
    tw(push, 'y', tp, tp + 0.36, -24, 0, 'out');
    [0, -3, 3, -3, 3, -3, 0].forEach((v, i) => key(buzz, 'x', tp + i * 0.06, v, i ? 'linear' : 'step'));
    const tapPush = s2.start + 4.0;
    tap(...pushCenter(), tapPush);
    phoneShows('card', tapPush + 0.3);

    // S3: the card beside the same prompt; Yes; the prompt goes and the command runs.
    tw(term, 'o', s3.start, s3.start + 0.32, 0.6, 1, 'out');
    const yes = D.shots.card.boxes.yes;
    const tYes = s3.start + 3.4;
    tap(...onPhone(...center(yes)), tYes);
    const tAns = tYes + 0.4;
    phoneShows('session-answered', tAns);
    showPage('after', tAns);
    print(afterLines[0], tAns);

    // S4: Terminal prints the run; back to the board, which moves api-server on its own.
    const back = D.shots['session-answered'].boxes.back;
    const tBack = s4.start + 0.1;
    tap(...onPhone(...center(back)), tBack);
    phoneShows('board-answered', tBack + 0.2);
    // A command's output comes 0.7 s after its line, the next command 0.3 s after that.
    let tl = s4.start + 0.4;
    let prev = '●';
    for (const ln of afterLines.slice(1, -1)) {
      const text = ln.textContent;
      if (text.startsWith('●')) tl += 0.3;
      else if (prev.startsWith('●')) tl += tl === s4.start + 0.4 ? 0 : 0.7;
      print(ln, tl);
      tl += text.trim() ? 0.12 : 0.05;
      prev = text;
    }
    // the reply is the last line; the board catches up with it
    const tReply = s4.start + 3.8;
    if (tl > tReply) throw new Error(`the run prints until ${tl.toFixed(2)} s, after the reply`);
    print(afterLines.at(-1), tReply);
    phoneShows('board-done', tReply + 0.2);

    // S5: the Terminal goes; Accounts, with rigel's reset marked.
    tw(term, 'x', s5.start, s5.start + 0.56, 0, -96, 'sheet');
    tw(term, 'o', s5.start, s5.start + 0.56, 1, 0, 'sheet');
    phoneShows('accounts', s5.start + 0.2, 0.32);
    const rr = D.shots.accounts.boxes.rigelRow;
    const [rx, ry] = onPhone(rr.x + 6, rr.y + 4);
    const ring = place(el('div', 'abs mark-row'), rx, ry, (rr.width - 12) * k, (rr.height - 8) * k);
    ring.style.zIndex = '15';
    tw(ring, 'o', s5.start + 2.0, s5.start + 2.24, 0, 1, 'out');
    tw(ring, 'o', s5.end - 0.4, s5.end - 0.2, 1, 0, 'in');

    // S6: the board on the Mac rises in beside the phone's.
    tw(mac, 'o', s6.start, s6.start + 0.48, 0, 1, 'out');
    tw(mac, 'y', s6.start, s6.start + 0.48, 24, 0, 'out');
    phoneShows('board-done', s6.start + 0.36, 0.32);

    // S7, S8: the phone alone.
    tw(mac, 'x', s7.start, s7.start + 0.56, 0, -96, 'sheet');
    tw(mac, 'o', s7.start, s7.start + 0.56, 1, 0, 'sheet');
    phoneShows('meeting', s7.start + 0.2, 0.32);
    phoneShows('today', s8.start, 0.32);

    // S9: everything goes; the end card builds and holds.
    tw(ph, 'o', s9.start, s9.start + 0.36, 1, 0, 'in');
    tw(ph, 'x', s9.start, s9.start + 0.36, 0, 40, 'in');
    tw(rail, 'o', s9.start, s9.start + 0.3, 1, 0, 'in');
    buildEnd(s9.start + 0.3, 0.1);

    for (const s of D.scenes) captions(s);
  }

  // ==============================================================  the GIF
  function gif() {
    const g = Object.fromEntries(D.cut.map((p) => [p.id, p]));
    // G0: the end card, complete (the first frame, and what a paused GIF shows).
    set(end, 'o', 0, 1);
    for (const e of [dial, name, tagline, url, meta, foot, ...rects]) set(e, 'o', 0, 1);
    // at rest: a track holds its first key's value before it, and the build's first keys are its start offsets
    set(name, 'x', 0, 0);
    for (const e of [tagline, url]) set(e, 'y', 0, 0);
    set(rail, 'o', 0, 0);
    set(term, 'o', 0, 0);
    set(ph, 'o', 0, 0);

    // G1: cut to the Terminal; one flick, then api-server's prompt.
    const t1 = g.G1.start;
    hideEnd(t1);
    set(rail, 'o', t1, 1);
    set(term, 'o', t1, 1);
    frontTab('payments', t1, 'payments');
    frontTab('api-server', t1 + 0.9, 'api');

    // G2: the phone slides in; the push arrives; a tap.
    const t2 = g.G2.start;
    set(term, 'o', t2, 0.55);
    set(ph, 'o', t2, 1);
    tw(ph, 'x', t2, t2 + 0.4, W - P.x, 0, 'sheet');
    phoneShows('lock', 0);
    const tp = t2 + 0.55;
    tw(push, 'o', tp, tp + 0.3, 0, 1, 'out');
    tw(push, 'y', tp, tp + 0.3, -16, 0, 'out');
    [0, -3, 3, -3, 3, 0].forEach((v, i) => key(buzz, 'x', tp + i * 0.067, v, 'step'));
    const tapPush = t2 + 1.75;
    tap(...pushCenter(), tapPush, { appear: 0.35 });

    // G3: the card (the phone pans up to it); Yes; the command runs.
    const t3 = g.G3.start - 0.1;
    phoneShows('card', t3);
    set(term, 'o', t3, 1);
    tw(ph, 'y', t3, t3 + 0.45, 0, L.cardY - P.y, 'sheet');
    const yes = D.shots.card.boxes.yes;
    const tYes = t3 + 1.9;
    tap(...onPhone(...center(yes), L.cardY), tYes, { appear: 0.45 });
    const tAns = tYes + 0.45;
    phoneShows('session-answered', tAns);
    showPage('after', tAns);
    print(afterLines[0], tAns);

    // G4: the board, done; Terminal prints the run.
    const t4 = g.G4.start;
    phoneShows('board-done', t4);
    tw(ph, 'y', t4, t4 + 0.45, L.cardY - P.y, 0, 'sheet');
    let tl = t4 + 0.1;
    afterLines.slice(1).forEach((ln) => {
      print(ln, tl);
      tl += 0.12;
    });

    // G5: cut to the ground; the end card builds and ends as G0 began.
    const t5 = g.G5.start;
    for (const e of [term, ph, rail]) set(e, 'o', t5, 0);
    const done = buildEnd(t5 + 0.05, 0.05);
    if (done > D.size.seconds - 1 / D.size.fps) throw new Error(`the GIF's end card is still building at ${done.toFixed(2)} s`);

    for (const p of D.cut) captions(p);
  }

  window.seek = seek;
  // The timelines measure laid-out text (the push's height), so they are built once the fonts are in.
  window.stageReady = (async () => {
    await Promise.all(["600 20px 'Archivo Variable'", "500 20px 'JetBrains Mono Variable'"].map((f) => document.fonts.load(f)));
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode()));
    if (GIF) gif();
    else film();
    scrollback();
    for (const m of tracks.values()) for (const keys of Object.values(m)) keys.sort((a, b) => a.t - b.t || a.n - b.n);
    seek(0);
    return true;
  })();
})();
