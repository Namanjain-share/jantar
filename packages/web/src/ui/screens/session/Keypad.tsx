/**
 * The keypad (v0.4.2, spec 3): for a screen Jantar can't turn into buttons.
 * ↓ (and ↑ once DIALOG_GATES.up is on) add to a pending move; Enter sends
 * the moves and one Return in one write, `{ screen, lines, move, key }`,
 * which the Mac types only while it still shows the lines the phone was
 * shown (the read's screenKey, for the `lines` that read asked for). No text
 * field; Escape only with KEYPAD_ESCAPE, never with moves. After a send the
 * screen is read again (`onSent`) and the moves are cleared; after a refusal
 * they are kept. A 409 clears them and reads the screen again; two in a row
 * say the terminal keeps changing.
 *
 * Moves belong to the screen they were counted on. When a read brings
 * another screen before Enter, Enter sends nothing, clears the moves and
 * says so: the user counts again on the screen in front of them. An Enter
 * within TAP_GUARD_MS of a new screen showing, of the keypad opening, of a
 * 409 or of an Enter dropped before it is dropped as well (answer.ts
 * `useTapGuard`), so neither half of a double tap reaches a screen the user
 * hasn't looked at.
 *
 * One Idempotency-Key per send, kept only after a network error for the
 * same body. Nothing here shows while the screen has a dialog with buttons.
 */
import { useRef, useState } from 'react';
import { DIALOG_GATES, KEYPAD_ESCAPE, KEYPAD_LINES, type SessionKeypadBody } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { useAnswerBlock, useTapGuard } from './answer.js';
import { InlineError, OfflineLine } from './Fields.js';
import type { SessionScreenRead } from './screen.js';

export interface KeypadProps {
  sid: string;
  /** The read the keypad acts on: its `screen.screenKey` and `lines` go into the body. */
  screen: SessionScreenRead;
  phone: boolean;
  offline: boolean;
  /** Called after each send (the caller reads the screen again). */
  onSent: () => void;
}

/** The daemon's own limit on moves per send. */
export const KEYPAD_MAX_MOVE = 20;
export const KEYPAD_HINT = 'Terminal adds a Return to every key, so arrows move and choose at once. Nothing is typed until Enter.';
export const KEYPAD_CHANGED = 'The terminal changed. Look at it again.';
export const KEYPAD_CLEARED = 'The terminal changed, so the moves were cleared. Look at it, then count again.';
export const KEYPAD_LOOK = 'Look at the screen, then press Enter.';
export const KEYPAD_UNSTEADY = "The terminal keeps changing, so the keys can't be sent safely. Answer it at the Mac.";
const NO_KEY = "This screen read can't be checked at the moment of typing, so the keys are off. Refresh the screen.";

type Line = { text: string; error: boolean } | null;
/** The lines that say why the last Enter sent nothing: an Enter dropped right after keeps the one showing. */
const DROPS = new Set([KEYPAD_CHANGED, KEYPAD_CLEARED, KEYPAD_LOOK, KEYPAD_UNSTEADY]);

export function Keypad({ sid, screen: read, phone, offline, onSent }: KeypadProps) {
  const { api } = useDeps();
  const block = useAnswerBlock();
  const [move, setMove] = useState(0);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<Line>(null);
  const conflicts = useRef(0);
  const kept = useRef<{ sig: string; key: string } | null>(null);
  /** The screen key the pending moves were counted on. */
  const counted = useRef<string | null>(null);
  const screenKey = read.screen?.screenKey;
  const size = phone ? 'xl' : 'lg';
  const shown = read.screen && !read.screen.dialog ? (screenKey ?? null) : null;
  const guard = useTapGuard(shown);

  if (read.screen?.dialog) return null;
  const off = busy || offline || block !== null || !screenKey || read.lines < KEYPAD_LINES;
  const minMove = DIALOG_GATES.up ? -KEYPAD_MAX_MOVE : 0;
  const step = (by: number) => {
    if (move === 0) counted.current = screenKey ?? null;
    setMove(move + by);
  };
  const clear = () => {
    counted.current = null;
    setMove(0);
  };

  const send = async (key: 'enter' | 'escape') => {
    if (off || !screenKey) return;
    const moves = key === 'escape' ? 0 : move;
    // The screen the moves were counted on is gone: they go, and the next Enter waits for a look.
    if (moves !== 0 && counted.current !== screenKey) {
      clear();
      guard.restart();
      setLine({ text: KEYPAD_CLEARED, error: false });
      return;
    }
    // This screen (or the keypad) only just showed, or an Enter was just dropped: nothing is sent.
    const soon = guard.check();
    if (soon) {
      setLine((l) => (l && !l.error && DROPS.has(l.text) ? l : { text: soon === 'new' ? KEYPAD_LOOK : KEYPAD_CHANGED, error: false }));
      return;
    }
    const body: SessionKeypadBody = { screen: screenKey, lines: read.lines, move: moves, key };
    const sig = JSON.stringify(body);
    const idem = kept.current?.sig === sig ? kept.current.key : newIdempotencyKey();
    kept.current = null;
    setBusy(true);
    setLine(null);
    try {
      await api.sessionKeypad(sid, body, idem);
      conflicts.current = 0;
      clear();
      setLine({ text: key === 'escape' ? 'Sent Esc' : body.move ? `Sent ${arrows(body.move)} and Enter` : 'Sent Enter', error: false });
      onSent();
    } catch (e) {
      if (isApiError(e, 'network')) kept.current = { sig, key: idem };
      if (isApiError(e, 'conflict')) {
        // The Mac shows another screen than the one the moves were counted on.
        conflicts.current += 1;
        clear();
        guard.restart();
        setLine({ text: conflicts.current >= 2 ? KEYPAD_UNSTEADY : body.move ? KEYPAD_CLEARED : KEYPAD_CHANGED, error: false });
        onSent();
      } else {
        conflicts.current = 0;
        setLine({ text: errorText(e), error: true });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Keys" className="mt-12">
      <p className="type-small font-medium text-ink">Keys</p>
      <div className="mt-8 flex flex-wrap items-center gap-8">
        {DIALOG_GATES.up ? (
          <Button size={size} aria-label="Up" className="w-56" disabled={off || move <= minMove} onClick={() => step(-1)}>
            ↑
          </Button>
        ) : null}
        <Button size={size} aria-label="Down" className="w-56" disabled={off || move >= KEYPAD_MAX_MOVE} onClick={() => step(1)}>
          ↓
        </Button>
        <span className="type-mono text-ink-2" aria-live="polite">
          {move ? `moves: ${arrows(move)}` : 'no moves'}
        </span>
        {move ? (
          <Button variant="text" size={size} disabled={busy} onClick={clear}>
            clear
          </Button>
        ) : null}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-8">
        <Button variant="primary" size={size} className={phone ? 'flex-1' : undefined} disabled={off} onClick={() => void send('enter')}>
          {busy ? <Spinner label="Sending" /> : null}
          Enter ⏎
        </Button>
        {KEYPAD_ESCAPE ? (
          <Button size={size} disabled={off || move !== 0} onClick={() => void send('escape')}>
            Esc
          </Button>
        ) : null}
      </div>
      <p className="mt-8 type-small text-ink-3">{KEYPAD_HINT}</p>
      {line && !line.error ? (
        <p role="status" className="mt-8 type-small text-ink-2">
          {line.text}
        </p>
      ) : null}
      <InlineError error={line?.error ? line.text : null} />
      {block ? <p className="mt-8 type-small text-ink-2">{block}</p> : !screenKey && read.screen ? <p className="mt-8 type-small text-ink-2">{NO_KEY}</p> : null}
      <OfflineLine offline={offline} />
    </section>
  );
}

/** "↓ 2", "↑ 1". */
function arrows(move: number): string {
  return `${move < 0 ? '↑' : '↓'} ${Math.abs(move)}`;
}
