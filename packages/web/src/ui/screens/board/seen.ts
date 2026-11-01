/**
 * "Unseen" your-turn rows (direction.md 5.1): a session that finished since
 * you last opened it shows its folder at weight 680. No dot, no colour.
 *
 * Per device, in localStorage: sid -> when you last looked at it (ms). A
 * session seen for the first time gets "now" as its baseline, so a fresh
 * load does not mark everything unseen; it is marked seen whenever it is
 * the open session (desktop split) or its row is tapped (phone).
 */
import { useCallback, useEffect, useState } from 'react';
import { shownStatus, type Session, type State } from '@jantar/protocol';
import { readLocal, writeLocal } from '../../../lib/storage.js';

export const SEEN_KEY = 'board-seen';

type SeenMap = Record<string, number>;

function since(s: Session): number {
  const t = Date.parse(s.statusSince);
  return Number.isFinite(t) ? t : 0;
}

/** True for a your-turn session that finished after you last looked at it (v0.6.1: not while a workflow it started runs). */
export function isUnseen(map: SeenMap, s: Session): boolean {
  if (shownStatus(s) !== 'idle') return false;
  const at = map[s.sid];
  return at !== undefined && since(s) > at;
}

export function useSeen(state: State, openSid: string | null, clock: () => number) {
  const [map, setMap] = useState<SeenMap>(() => readLocal<SeenMap>(SEEN_KEY, {}));

  useEffect(() => {
    // Nothing synced yet: an empty session list must not wipe the map.
    if (state.seq === 0) return;
    const t = clock();
    const next: SeenMap = {};
    let changed = false;
    for (const sid of Object.keys(state.sessions)) {
      const v = map[sid];
      next[sid] = v ?? t;
      if (v === undefined) changed = true;
    }
    if (Object.keys(map).length !== Object.keys(next).length) changed = true;
    const open = openSid && Object.hasOwn(state.sessions, openSid) ? state.sessions[openSid] : undefined;
    if (open && !(next[open.sid]! >= since(open))) {
      next[open.sid] = Math.max(t, since(open));
      changed = true;
    }
    if (!changed) return;
    setMap(next);
    writeLocal(SEEN_KEY, next);
  }, [state, openSid, map, clock]);

  const unseen = useCallback((s: Session) => isUnseen(map, s), [map]);

  /** Mark one session seen now (a tapped row: the board unmounts right after on a phone). */
  const markSeen = useCallback(
    (s: Session) => {
      const next = { ...readLocal<SeenMap>(SEEN_KEY, map), [s.sid]: Math.max(clock(), since(s)) };
      writeLocal(SEEN_KEY, next);
      setMap(next);
    },
    [map, clock],
  );

  return { unseen, markSeen };
}
