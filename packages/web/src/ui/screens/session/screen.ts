/**
 * The session screen's one read of the terminal (v0.4.2, spec 2.1). The
 * dock at the bottom (TermDialogDock: the dialog's buttons, or the screen and
 * the keypad) and the Screen tab's text read the same result: one poll per
 * session screen, so the buttons and the keys always act on the read the
 * user sees. Each read may carry `dialog`, `dialogNote` and `screenKey`.
 *
 * The poll: KEYPAD_LINES lines, or 80 while the Screen tab's text shows;
 * every 3 s while Claude waits or a subagent card is open, every 5 s while
 * it works or the Screen tab's text shows, otherwise not at all (and the
 * last read is dropped). Paused while the page is hidden, and read again the
 * moment it shows. At most one read in flight: asking during one reads once
 * more when it lands. A poll that starts for a working session reads first
 * after 5 s (it only looks for a dialog the session file has not reported);
 * waiting, a subagent card, the Screen tab or a status change read at once.
 *
 * An answer (session/answer.ts) reports the screen it left: `put` shows that
 * dialog, or none with "Answered · <row>", until the next read lands. A read
 * that was already on its way when the report came is dropped: it may show
 * the dialog from before the answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KEYPAD_LINES, type ScreenResponse, type SessionStatus, type TerminalDialog } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { useDeps } from '../../context.js';
import type { View } from './Header.js';

export const UNREADABLE =
  'The terminal could not be read right now (is the tab still open, and does the daemon have Automation permission?).';

/** A session that turned "waiting" shows the screen path only after this long, so a hook card can arrive first. */
export const SCREEN_PATH_SETTLE_MS = 1_500;
/** How often the screen is read while Claude asks something (waiting, or a subagent card open). */
export const SCREEN_ASK_EVERY_MS = 3_000;
/** How often it is read while Claude works, or while the Screen tab's text shows. */
export const SCREEN_EVERY_MS = 5_000;
/** The Screen tab's text shows this many lines (the dock and its keypad show KEYPAD_LINES). */
export const SCREEN_TAB_LINES = 80;

export interface SessionScreenRead {
  /** The latest read, or null before the first (or while nothing reads). */
  screen: ScreenResponse | null;
  /** How many lines the read in `screen` asked for: the keypad sends it back with its screenKey. */
  lines: number;
  busy: boolean;
  error: string | null;
  /** Read again now (after an answer or a keypad send); resolves with that read, or null when it failed. */
  load: () => Promise<ScreenResponse | null>;
  /** Counts the reads that landed. */
  seq: number;
  /** The row an answer chose when its dialog closed, until the next read lands. */
  answered: string | null;
  /** Show what an answer reported (the next dialog, or none with the row it chose) until the next read lands. */
  put: (dialog: TerminalDialog | null, answered?: string) => void;
}

interface Landed {
  res: ScreenResponse;
  lines: number;
}

interface Patch {
  seq: number;
  dialog: TerminalDialog | null;
  answered: string | null;
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** The read with an answer's report in place of its dialog (no note: the report is newer than the read). */
function patched(res: ScreenResponse, dialog: TerminalDialog | null): ScreenResponse {
  const { dialog: _was, dialogNote: _note, ...rest } = res;
  return dialog ? { ...rest, dialog } : rest;
}

/**
 * `tab` is 'screen' only while the Screen tab's text shows (the picture reads no text).
 * `subagent`: a subagent-info card is open, so the read runs as often as while waiting.
 */
export function useSessionScreen(sid: string, tab: View, status: SessionStatus | null, subagent = false): SessionScreenRead {
  const { api } = useDeps();
  const text = tab === 'screen';
  const lines = text ? SCREEN_TAB_LINES : KEYPAD_LINES;
  const asking = status !== null && status !== 'ended' && (status === 'waiting' || subagent);
  const everyMs = status === null ? null : asking ? SCREEN_ASK_EVERY_MS : status === 'working' || text ? SCREEN_EVERY_MS : null;
  const on = everyMs !== null;

  const [landed, setLanded] = useState<Landed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const [patch, setPatch] = useState<Patch | null>(null);

  const cfg = useRef({ sid, lines, on });
  cfg.current = { sid, lines, on };
  const alive = useRef(true);
  const flight = useRef<Promise<ScreenResponse | null> | null>(null);
  const again = useRef(false);
  const seqNow = useRef(0);
  /** Counts the answers' reports (`put`): a read started before the latest one is stale. */
  const puts = useRef(0);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const load = useCallback((): Promise<ScreenResponse | null> => {
    if (!cfg.current.on) return Promise.resolve(null);
    if (flight.current) {
      again.current = true;
      return flight.current;
    }
    const run = async (): Promise<ScreenResponse | null> => {
      let got: ScreenResponse | null = null;
      setBusy(true);
      try {
        do {
          again.current = false;
          const asked = cfg.current;
          const putsBefore = puts.current;
          try {
            const res = await api.getScreen(asked.sid, asked.lines);
            if (!alive.current) return null;
            const now = cfg.current;
            // Asked for another session or line count than the poll wants now: read again.
            if (!now.on || now.sid !== asked.sid || now.lines !== asked.lines) {
              again.current = now.on;
              continue;
            }
            // An answer reported a newer screen while this read was out: keep the report until the next poll.
            if (puts.current !== putsBefore) continue;
            got = res;
            seqNow.current += 1;
            setLanded({ res, lines: asked.lines });
            setSeq(seqNow.current);
            setError(null);
          } catch (e) {
            if (!alive.current) return null;
            got = null;
            if (!cfg.current.on || cfg.current.sid !== asked.sid) {
              again.current = cfg.current.on;
              continue;
            }
            setError(isApiError(e, 'unavailable') ? UNREADABLE : errorText(e));
          }
        } while (again.current && alive.current);
        return got;
      } finally {
        flight.current = null;
        if (alive.current) setBusy(false);
      }
    };
    flight.current = run();
    return flight.current;
  }, [api]);

  // Start, stop and re-aim the poll. A status change reads at once: the dialog may have gone.
  const started = useRef<{ sid: string; status: SessionStatus | null } | null>(null);
  useEffect(() => {
    const before = started.current;
    started.current = on ? { sid, status } : null;
    if (!on || (before && before.sid !== sid)) {
      setLanded(null);
      setError(null);
      setPatch(null);
      if (!on) return;
    }
    const firstForWork = before === null && !asking && !text;
    if (!firstForWork) void load();
  }, [on, sid, status, asking, text, lines, load]);

  useEffect(() => {
    if (everyMs === null) return;
    const id = setInterval(() => {
      if (!hidden()) void load();
    }, everyMs);
    const onVisible = () => {
      if (!hidden()) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [everyMs, load]);

  const put = useCallback((dialog: TerminalDialog | null, answered?: string) => {
    puts.current += 1;
    setPatch({ seq: seqNow.current, dialog, answered: dialog ? null : (answered ?? null) });
  }, []);

  const live = patch !== null && patch.seq === seq && landed !== null ? patch : null;
  const screen = useMemo(() => (landed ? (live ? patched(landed.res, live.dialog) : landed.res) : null), [landed, live]);
  return { screen, lines: landed?.lines ?? lines, busy, error, load, seq, answered: live?.answered ?? null, put };
}

/**
 * True once a session has been "waiting" for SCREEN_PATH_SETTLE_MS (counted from its
 * statusSince, and never longer than that from now, whatever the Mac's clock says).
 */
export function useWaitingSettled(status: SessionStatus | null, since: string | null, now: () => number): boolean {
  const waiting = status === 'waiting';
  const left = () => {
    const at = since ? Date.parse(since) : Number.NaN;
    const age = Number.isFinite(at) ? now() - at : 0;
    return Math.max(0, Math.min(SCREEN_PATH_SETTLE_MS, SCREEN_PATH_SETTLE_MS - age));
  };
  const [settled, setSettled] = useState(() => waiting && left() === 0);
  useEffect(() => {
    if (!waiting) {
      setSettled(false);
      return;
    }
    const ms = left();
    if (ms === 0) {
      setSettled(true);
      return;
    }
    setSettled(false);
    const t = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(t);
    // `now` is the app's clock: the timer is set again only when the waiting starts anew.
  }, [waiting, since]);
  return waiting && settled;
}
