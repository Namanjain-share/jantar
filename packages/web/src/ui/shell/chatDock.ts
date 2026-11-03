/**
 * Chat beside any screen (0.12, build plan c28, D10; ipad-design.md 2.4):
 * whether the Chat panel is open, remembered on this device (closed by
 * default, open question 4), and a count the panel watches to focus its
 * composer (⌘J). Main holds only this and the button; the panel is Chat's
 * own lazy chunk (screens/chat/Chat.tsx re-exports ChatDock).
 *
 * dockFits: the panel is a column beside the panes when they keep 560 after
 * giving it 360 (main − 360 ≥ 560); otherwise it lies over their right edge.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { readLocal, writeLocal } from '../../lib/storage.js';

export const CHAT_DOCK_KEY = 'chat-dock';
/** The panel's width, and what the panes must keep beside it to have it as a column, px. */
export const CHAT_DOCK_W = 360;
export const CHAT_DOCK_MIN_MAIN = 560;

export const chatDockStore = createStore<{ open: boolean; focus: number }>()(() => ({
  open: readLocal<boolean>(CHAT_DOCK_KEY, false) === true,
  focus: 0,
}));

export function setChatDock(open: boolean, focus = false): void {
  writeLocal(CHAT_DOCK_KEY, open);
  chatDockStore.setState((s) => ({ open, focus: focus ? s.focus + 1 : s.focus }));
}

/** ⌘J and the Chat button: open it (and focus its composer), or close it. */
export function toggleChatDock(focus = true): void {
  setChatDock(!chatDockStore.getState().open, focus);
}

export function useChatDock(): { open: boolean; focus: number } {
  return useStore(chatDockStore);
}

/** A column beside the panes, or over them: `main` is the panes' width without the panel. */
export function dockFits(main: number): boolean {
  return main - CHAT_DOCK_W >= CHAT_DOCK_MIN_MAIN;
}
