/**
 * Day / night / follow-the-system theme, remembered per device.
 *
 * Day (cream and navy) is the default look: tokens.css puts it on :root.
 * `data-theme="dark"` forces night, `data-theme="light"` forces day, and no
 * attribute ("system") follows prefers-color-scheme.
 *
 * The browser chrome colour (<meta name="theme-color">) must match --bg in
 * each theme. index.html carries one meta per colour scheme, written from
 * tokens.css at build time; this file only re-points them, so no colour
 * literal lives in src/ outside tokens.css.
 */
import { createStore } from 'zustand/vanilla';
import { readLocal, writeLocal } from './storage.js';

export type ThemePref = 'system' | 'light' | 'dark';

function remember(meta: HTMLMetaElement): { media: string; content: string } {
  if (!meta.hasAttribute('data-media')) meta.setAttribute('data-media', meta.getAttribute('media') ?? '');
  if (!meta.hasAttribute('data-content')) meta.setAttribute('data-content', meta.content);
  return { media: meta.getAttribute('data-media') ?? '', content: meta.getAttribute('data-content') ?? '' };
}

export function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;

  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  const saved = metas.map(remember);
  const forScheme = (scheme: 'light' | 'dark') => saved.find((m) => m.media.includes(scheme))?.content;
  metas.forEach((meta, i) => {
    const own = saved[i];
    if (!own) return;
    if (pref === 'system') {
      if (own.media) meta.setAttribute('media', own.media);
      meta.content = own.content;
    } else {
      meta.removeAttribute('media');
      meta.content = forScheme(pref) ?? own.content;
    }
  });
}

export const themeStore = createStore<{ pref: ThemePref; set(p: ThemePref): void }>()((set) => ({
  pref: readLocal<ThemePref>('theme', 'system'),
  set(p) {
    writeLocal('theme', p);
    applyTheme(p);
    set({ pref: p });
  },
}));
