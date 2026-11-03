/**
 * The touch shell's own state (0.12, ipad-design.md 2.1-2.2): whether the
 * sidebar is folded to the rail (regular width, the user's choice, ⌘\), the
 * sidebar shown over the rail (medium width, or the rail's sidebar button),
 * and whether Today's group lists its six places. The fold and the group are
 * remembered per device (localStorage, a convenience); the overlay is not.
 *
 * useLifeInNav() says whether the nav lists the Life places right now: only
 * the expanded sidebar with Today's group open does. Today shows its Life
 * strip whenever it doesn't (the Mac, the rail, the phone, a closed group).
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { readLocal, writeLocal } from '../../lib/storage.js';
import { useLayout } from './layout.js';

export interface NavState {
  folded: boolean;
  lifeOpen: boolean;
  overlay: boolean;
}

export const navStore = createStore<NavState>()(() => ({
  folded: readLocal<boolean>('sidebar-folded', false) === true,
  lifeOpen: readLocal<boolean>('sidebar-life', true) !== false,
  overlay: false,
}));

export function setFolded(folded: boolean): void {
  writeLocal('sidebar-folded', folded);
  navStore.setState({ folded, overlay: false });
}

export function setLifeOpen(lifeOpen: boolean): void {
  writeLocal('sidebar-life', lifeOpen);
  navStore.setState({ lifeOpen });
}

export function setOverlay(overlay: boolean): void {
  navStore.setState({ overlay });
}

export function useNav(): NavState {
  return useStore(navStore);
}

/** The touch chrome shows the full sidebar in place (regular width, not folded); else the rail. */
export function useSidebar(): boolean {
  const { chrome, size } = useLayout();
  const folded = useStore(navStore, (s) => s.folded);
  return chrome === 'touch' && size === 'regular' && !folded;
}

/** The nav lists Today's places right now: the sidebar in place with Today's group open. */
export function useLifeInNav(): boolean {
  const sidebar = useSidebar();
  const lifeOpen = useStore(navStore, (s) => s.lifeOpen);
  return sidebar && lifeOpen;
}

/** ⌘\: fold or unfold the sidebar (regular width), or show or hide it over the rail (medium). */
export function toggleSidebar(size: 'compact' | 'medium' | 'regular'): void {
  const s = navStore.getState();
  if (size === 'regular') setFolded(!s.folded);
  else setOverlay(!s.overlay);
}

/** The ? overlay (shell/Shortcuts.tsx, c30): opened by ?, the iPad sidebar's ⋯ and Devices (c31). */
export const shortcutsStore = createStore<{ open: boolean }>()(() => ({ open: false }));

export function setShortcuts(open: boolean): void {
  shortcutsStore.setState({ open });
}

export function useShortcutsOpen(): boolean {
  return useStore(shortcutsStore, (s) => s.open);
}
