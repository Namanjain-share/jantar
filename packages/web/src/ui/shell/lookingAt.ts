/**
 * What the screen shows, for Chat's "Looking at" chip (0.12, build plan c29;
 * ipad-design.md 2.4): the item a detail screen has open (a café, a post, an
 * Intel item, a meeting, a session) or the address names (a todo, a
 * medicine), as a kind, an id and the words the screen already shows for it.
 * Food and Money have no item in their address, so they set none. The screen sets it while it is mounted
 * (useLookingAt); the Chat panel reads it. Nothing is set on Files,
 * Accounts or Devices: Chat can't read those.
 */
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { ChatContextKind } from '@jantar/protocol';

export interface LookingAt {
  kind: ChatContextKind;
  id: string;
  /** What the chip says: "Sample Dosa House". */
  label: string;
}

export const lookingAtStore = createStore<{ at: LookingAt | null }>()(() => ({ at: null }));

/** While mounted, this screen shows `at` (null: nothing yet, its load hasn't come). */
export function useLookingAt(at: LookingAt | null): void {
  const kind = at?.kind;
  const id = at?.id;
  const label = at?.label;
  useEffect(() => {
    if (!kind || !id || !label) return;
    const mine = { kind, id, label };
    lookingAtStore.setState({ at: mine });
    return () => {
      if (lookingAtStore.getState().at === mine) lookingAtStore.setState({ at: null });
    };
  }, [kind, id, label]);
}

export function useLookingAtNow(): LookingAt | null {
  return useStore(lookingAtStore, (s) => s.at);
}
