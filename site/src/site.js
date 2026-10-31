// The theme switch and the Copy buttons. The page works without this file.
(() => {
  const KEY = 'jantar-site-theme';
  const root = document.documentElement;
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
  for (const m of metas) m.dataset.sys = m.content;
  const read = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const save = (v) => {
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch {
      /* private window or blocked storage: the choice lasts for this page */
    }
  };
  const apply = (v) => {
    if (v === 'light' || v === 'dark') root.setAttribute('data-theme', v);
    else root.removeAttribute('data-theme');
    const media = v === 'dark' ? 'all' : v === 'light' ? 'not all' : '(prefers-color-scheme: dark)';
    for (const s of document.querySelectorAll('source[data-dark]')) s.media = media;
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    for (const m of metas) m.content = v ? bg : m.dataset.sys;
    for (const b of document.querySelectorAll('[data-theme-set]')) {
      b.setAttribute('aria-pressed', String(b.dataset.themeSet === (v || 'system')));
    }
  };
  const live = document.getElementById('live');
  const copy = async (btn) => {
    const code = document.getElementById(btn.dataset.copy);
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
    } catch {
      const r = document.createRange();
      r.selectNodeContents(code);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    const label = btn.querySelector('span');
    label.textContent = 'Copied';
    if (live) live.textContent = 'Copied to the clipboard';
    setTimeout(() => {
      label.textContent = 'Copy';
      if (live) live.textContent = '';
    }, 2000);
  };
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const set = t && t.closest('[data-theme-set]');
    if (set) {
      const v = set.dataset.themeSet === 'system' ? null : set.dataset.themeSet;
      save(v);
      apply(v);
      return;
    }
    const c = t && t.closest('[data-copy]');
    if (c) copy(c);
  });
  for (const el of document.querySelectorAll('.seg, [data-copy]')) el.hidden = false;
  apply(read());
  // The Life strip is a tab stop only while it scrolls sideways.
  const strip = document.querySelector('.life-strip');
  if (strip && 'ResizeObserver' in window) {
    const fit = () => {
      if (strip.scrollWidth > strip.clientWidth + 1) strip.setAttribute('tabindex', '0');
      else strip.removeAttribute('tabindex');
    };
    new ResizeObserver(fit).observe(strip);
  }
})();
