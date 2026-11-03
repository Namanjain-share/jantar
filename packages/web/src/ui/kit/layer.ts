/**
 * Where popups go (0.11, build plan 1.6 and 1.8): sheets, the palette, menus
 * and popovers portal into the shell's layer, not into <body>, so they move
 * with the shell when it follows the visual viewport (lib/viewport.ts: a pan
 * shifts the shell, and a box inside it that is position: fixed is placed
 * against the shell). The layer sits above the panes (kit.css .shell-layer).
 *
 * useLayer() is what to pass as a Base UI Portal's `container`: the layer,
 * or null while the shell is mounting (the portal waits for it), or
 * undefined outside the shell (a screen rendered on its own: <body>).
 */
import { createContext, useContext } from 'react';

export const LayerContext = createContext<HTMLElement | null | undefined>(undefined);

export function useLayer(): HTMLElement | null | undefined {
  return useContext(LayerContext);
}
