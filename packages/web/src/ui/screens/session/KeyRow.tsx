/**
 * The terminal key row (0.11, build plan c27; ipad-design.md 4.6): above the
 * session composer only while the on-screen keyboard is up (`kbUp`), where
 * it takes the control bar's place; never with a hardware keyboard, never
 * in Chat. The keys the Mac lets a phone press (daemon controls/keys.ts):
 *
 *   esc  Escape: stops Claude's turn and leaves a draft alone (refused while
 *        Escape is off at the Mac, or a draft is in the terminal's box)
 *   ⇧⇥   Shift+Tab: the next permission mode (refused unless the box shows
 *        and is empty)
 *   ^C   Interrupt, held 0.6 s like the bar's, since a second one within
 *        3 s would quit Claude (the Mac refuses that too)
 *
 * The design's ↑, ↓, Tab and Return are not here: the Mac never presses a
 * menu key from the phone (each one's Return is a selection nothing checks);
 * a dialog is answered with its own buttons or the keypad. Each press says
 * how it went in one line, the Mac's own sentence when it refuses.
 */
import { useEffect, useState } from 'react';
import type { ControlKey } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { HoldButton } from '../../kit/HoldButton.js';
import { INTERRUPT_HOLD_MS } from './controls/ControlBar.js';

const NOTE_MS = 4_000;
const KEY = 'h-44 min-w-52 px-8 type-mono';

const SENT: Partial<Record<ControlKey, string>> = { escape: 'Esc sent', shiftTab: 'Shift+Tab sent', interrupt: 'Interrupt sent' };

export function KeyRow({ sid, offline }: { sid: string; offline: boolean }) {
  const { api } = useDeps();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; refused: boolean } | null>(null);
  useEffect(() => {
    if (!note || note.refused) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  const press = async (key: 'escape' | 'shiftTab' | 'interrupt') => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await api.sessionKey(sid, key);
      setNote({ text: SENT[key] ?? 'Sent', refused: false });
    } catch (e) {
      setNote({ text: `Not sent: ${isApiError(e, 'rate_limited') && e.message ? e.message : errorText(e)}`, refused: true });
    } finally {
      setBusy(false);
    }
  };
  const off = offline || busy;
  // Pressing a key must not take the focus from the composer (the keyboard would drop).
  const keep = (e: { preventDefault: () => void }) => e.preventDefault();
  return (
    <div role="group" aria-label="Terminal keys" data-key-row className="flex flex-none flex-wrap items-center gap-x-8 gap-y-4 pb-8 pt-4">
      <Button className={KEY} aria-label="Escape" onMouseDown={keep} onClick={() => void press('escape')} disabled={off}>
        esc
      </Button>
      <Button className={KEY} aria-label="Shift Tab: next mode" onMouseDown={keep} onClick={() => void press('shiftTab')} disabled={off}>
        ⇧⇥
      </Button>
      <HoldButton className={KEY} holdingLabel="^C" durationMs={INTERRUPT_HOLD_MS} onCommit={() => void press('interrupt')} disabled={off} aria-label="Control C: interrupt. Hold">
        ^C
      </HoldButton>
      {note ? (
        <span role="status" className={note.refused ? 'min-w-0 type-small text-ink-2' : 'min-w-0 type-small text-ink-3'}>
          {note.text}
        </span>
      ) : null}
    </div>
  );
}
