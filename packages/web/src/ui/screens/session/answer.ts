/**
 * Answering a terminal dialog from the phone (v0.4.2, spec 2.4-2.7): one
 * POST /v1/sessions/:sid/dialog per tap, with the fingerprint of the dialog
 * the dock showed. The Mac types only if it still shows exactly that dialog.
 *
 * - One Idempotency-Key per tap. It is kept only after a network error, for
 *   a tap on the same row of the same dialog (the daemon then replays the
 *   first answer if it did arrive).
 * - `done`: the next dialog shows at once, or, when the dialog closed,
 *   "Answered · <row>" until the next screen read (screen.ts `put`).
 * - `unchanged`: the live dialog again with "Jantar saw no change". There is
 *   no Try again: the user taps a row of the dialog in front of them. When
 *   the dialog that came back has another fingerprint, it is shown like a
 *   `renewed` one, with "The dialog on the Mac changed" instead. With no
 *   dialog back (the Mac shows one whose top is off screen, which could be
 *   the next queued prompt drawn alike), the line sends the user to the Mac
 *   rather than inviting another try.
 * - `done` with a next dialog that looks just like the one answered (the
 *   next queued prompt, drawn the same): `renewed` names it, and the dock
 *   shows it as new, body open, with "The dialog on the Mac changed", so it
 *   never reads as a tap that didn't take. A multi-select toggle that took
 *   is the same dialog with its ticks changed, not a new one.
 * - 409: the screen is read again and the fresh dialog shows with "The
 *   dialog on the Mac changed", or, when the daemon said Claude's countdown
 *   had too little left (v0.5.2), with that.
 * - "No, and tell Claude …" (2.7): the No row is answered with no text; on
 *   `done` the note goes into the composer's draft for one tap on Send.
 *
 * A line set here belongs to the dialog it was said about and goes when
 * another dialog shows or the next tap starts.
 *
 * `useTapGuard`: the dock's content can change under a finger already on
 * its way (a poll brings the next queued prompt, the dock takes the
 * composer's place), so a tap that lands within TAP_GUARD_MS of what it
 * hits appearing is dropped: the user never saw that row. Each dropped tap
 * starts the window again, so the second half of a double tap that
 * straddles its end is dropped too.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CLI_NAME, type SessionDialogBody, type TerminalDialog } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { useDeps, useToast } from '../../context.js';
import { useFeatures } from '../../shell/data.js';
import { readLocalDevice } from '../devices/local.js';
import type { SessionScreenRead } from './screen.js';
import type { Sends } from './sends.js';

export const NO_CHANGE = 'Jantar saw no change on the Mac; check it before trying again.';
/** `unchanged` with no dialog back: what the Mac shows next can't be offered (its top is off screen), so it may be another prompt. */
export const CANT_TELL = "Jantar can't tell from here whether that took: the Mac may show the next prompt, drawn alike. Look at the Mac before you answer again.";
export const CHANGED = 'The dialog on the Mac changed. Check it again.';
export const NOTE_IN_BOX = 'Your note is in the box. Send it when Claude is ready.';
export const CONTROLS_OFF = `Controls are off. Turn them on at your Mac: ${CLI_NAME} controls on`;
export const NO_CONTROL_SCOPE = 'This device can read sessions only. Answering needs control access: pair it again from your Mac.';

// v0.5.2, Claude's auto-block countdown: the protocol's DIALOG_COUNTDOWN_MIN_S, DIALOG_COUNTDOWN_LATE and
// countdownSeconds, copied into the dock's lazy chunk so the app's first load doesn't carry them
// (scripts/perf-chunks.mjs); term-dialog.test.tsx holds them equal.

/** Under this many seconds left on Claude's countdown the rows are off (twice that for a text row). */
export const COUNTDOWN_MIN_S = 5;
/** The daemon's 409 reason under that margin, and the dock's line there. */
export const COUNTDOWN_LATE = 'Claude blocks this at the Mac in a moment. Answer it there.';
/** A `blocksIn` time in seconds ("1:33" is 93, "about 2 minutes" 120), or null for any other text. */
export function countdownSecondsOf(time: string): number | null {
  const clock = /^(\d{1,2}):(\d{2})$/u.exec(time);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const about = /^about (\d{1,3}) (minute|second)s?$/u.exec(time);
  return about ? Number(about[1]) * (about[2] === 'minute' ? 60 : 1) : null;
}

/** A tap this soon after the content under it appeared was aimed at what was there before. */
export const TAP_GUARD_MS = 500;
/** The dock's line for a dropped tap (said politely, so a screen reader hears why nothing happened). */
export const TAP_DROPPED = 'Nothing was sent: the dialog had only just shown. Look at it, then tap.';

/** Why a tap can't go yet: 'new' while what this part first showed is fresh, 'changed' after it changed. */
export type TapTooSoon = 'new' | 'changed';

export interface TapGuard {
  /** Null when a tap may go now. Otherwise why not; the window starts again from this tap. */
  check: () => TapTooSoon | null;
  /** Start the window again: the content changed in a way its key doesn't show yet (a 409). */
  restart: () => void;
}

/**
 * Drops a tap while the content `key` names has been on screen for less than TAP_GUARD_MS (or
 * not at all). The time is the page's own monotonic clock, counted from the commit that showed
 * the content, from the last dropped tap, or from `restart`.
 */
export function useTapGuard(key: string | null): TapGuard {
  const shown = useRef<{ key: string | null; at: number; first: boolean } | null>(null);
  useLayoutEffect(() => {
    const was = shown.current;
    // `first`: no other content has shown since this part mounted.
    if (was?.key !== key) shown.current = { key, at: performance.now(), first: was === null || (was.first && was.key === null) };
  }, [key]);
  const check = useCallback((): TapTooSoon | null => {
    const s = shown.current;
    const now = performance.now();
    if (s && s.key !== null && now - s.at >= TAP_GUARD_MS) return null;
    if (s) s.at = now;
    return s && !s.first ? 'changed' : 'new';
  }, []);
  const restart = useCallback(() => {
    const s = shown.current;
    if (s) shown.current = { ...s, at: performance.now(), first: false };
  }, []);
  return useMemo(() => ({ check, restart }), [check, restart]);
}

/** A dialog's question and rows: typed text in a row survives a moved pointer, and starts empty for a new question. */
export function identity(d: TerminalDialog): string {
  return [d.kind, d.question, ...d.options.map((o) => o.label)].join('\n');
}

/**
 * What the dock shows of a dialog but its ticks and pointer: the same rows under another title,
 * body, tab bar or description (a queued twin, a dialog scrolled into view, the next question
 * drawn alike) look new. Never Claude's countdown (`blocksIn`): it changes every second.
 */
export function whole(d: TerminalDialog): string {
  const tabs = (d.tabs ?? []).map((t) => `${t.answered ? '☒' : '☐'} ${t.label}`).join('\t');
  return [identity(d), d.title, ...d.body, tabs, ...d.options.map((o) => o.detail ?? '')].join('\n');
}

/** The multi-select boxes, ticked or not. */
function ticks(d: TerminalDialog): string {
  return d.options.map((o) => (o.checked === undefined ? '-' : o.checked ? 'x' : 'o')).join('');
}

/**
 * Everything the dock draws of a dialog, the pointer included, but Claude's countdown (`blocksIn`,
 * which ticks; the daemon's fingerprint leaves it out too). A new fingerprint under the same
 * drawing means something the phone doesn't show changed (the middle of a body over 40 lines, a
 * clipped title or label): the dock treats it as another dialog.
 */
export function drawn(d: TerminalDialog): string {
  return [whole(d), String(d.current), ticks(d), ...d.options.map((o) => `${o.role} ${o.hold ?? ''} ${o.note ?? ''}`)].join('\n');
}

/** What the phone shows for a row: Claude's label without its keyboard hints. */
export function shownLabel(label: string): string {
  return label.replace(/ \((?:shift\+tab|esc)\)/giu, '').trim();
}

/** "Answered · …" for a typed answer: what was typed, cut to one line's worth. */
function typedLine(text: string): string {
  const t = text.trim();
  return t.length > 120 ? `${t.slice(0, 119).trimEnd()}…` : t;
}

/** One tap on a dialog row. */
export interface DialogTap {
  option: number;
  /** A `text` row's answer. */
  text?: string;
  /** A `hold` row, held for 2 seconds. */
  confirm?: boolean;
  /** "No, and tell Claude …": the note for the composer once the No is done. */
  note?: string;
}

/** A line under the dialog, for the dialog it was said about (`for`: its fingerprint, null for none). */
export interface AnswerLine {
  text: string;
  error: boolean;
  for: string | null;
}

/**
 * Why this device can't answer from here, or null when it can: the Controls switch is off,
 * or it was paired without the control scope (a browser with no pairing record may have it).
 */
export function useAnswerBlock(): string | null {
  const { controls } = useFeatures();
  const [scoped] = useState(() => readLocalDevice()?.scopes.includes('control') !== false);
  if (!scoped) return NO_CONTROL_SCOPE;
  if (!controls) return CONTROLS_OFF;
  return null;
}

export function useDialogAnswer(sid: string, read: SessionScreenRead, sends: Pick<Sends, 'setDraft'>) {
  const { api } = useDeps();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [line, setLine] = useState<AnswerLine | null>(null);
  /** The fingerprint of a next dialog that looks like the one just answered: the dock shows it as new. */
  const [renewed, setRenewed] = useState<string | null>(null);
  const flying = useRef(false);
  const kept = useRef<{ sig: string; key: string } | null>(null);
  const { put, load } = read;
  const { setDraft } = sends;

  const answer = useCallback(
    async (dialog: TerminalDialog, tap: DialogTap): Promise<void> => {
      const row = dialog.options[tap.option];
      if (!row || flying.current) return;
      const body: SessionDialogBody = {
        fingerprint: dialog.fingerprint,
        option: tap.option,
        ...(tap.text !== undefined ? { text: tap.text } : {}),
        ...(tap.confirm ? { confirm: true } : {}),
      };
      const sig = JSON.stringify(body);
      const key = kept.current?.sig === sig ? kept.current.key : newIdempotencyKey();
      kept.current = null;
      flying.current = true;
      setBusy(tap.option);
      setLine(null);
      setRenewed(null);
      try {
        const r = await api.sessionDialog(sid, body, key);
        if (r.outcome === 'done') {
          const next = r.dialog;
          // The Mac took the answer and shows another dialog drawn the same way: say so, in the same render.
          const toggled = row.role === 'toggle' && next !== null && ticks(next) !== ticks(dialog);
          if (next && next.fingerprint !== dialog.fingerprint && whole(next) === whole(dialog) && !toggled) setRenewed(next.fingerprint);
          put(next, tap.text !== undefined ? typedLine(tap.text) : shownLabel(row.label));
          const note = tap.note?.trim();
          if (note) {
            setDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${note}` : note));
            toast(NOTE_IN_BOX, 'ok');
          }
        } else {
          // "No change" is about the dialog answered. Another fingerprint came back (a queued twin taller than
          // the window, which the daemon can't tell from this one scrolled): show it as new, never as a retry.
          const next = r.dialog;
          const other = next !== null && next.fingerprint !== dialog.fingerprint;
          if (other && whole(next) === whole(dialog)) setRenewed(next.fingerprint);
          put(next);
          setLine({ text: next === null ? CANT_TELL : other ? CHANGED : NO_CHANGE, error: false, for: next?.fingerprint ?? null });
        }
      } catch (e) {
        if (isApiError(e, 'network')) kept.current = { sig, key };
        if (isApiError(e, 'conflict')) {
          const fresh = await load();
          setLine({ text: e.message === COUNTDOWN_LATE ? COUNTDOWN_LATE : CHANGED, error: false, for: fresh?.dialog?.fingerprint ?? null });
        } else {
          setLine({ text: errorText(e), error: true, for: dialog.fingerprint });
        }
      } finally {
        flying.current = false;
        setBusy(null);
      }
    },
    [api, sid, put, load, setDraft, toast],
  );

  return { busy, line, renewed, answer };
}
