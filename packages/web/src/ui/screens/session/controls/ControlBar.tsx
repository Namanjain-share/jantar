/**
 * The session's control bar (v0.3, the controls addendum; work package C
 * owns this file and the rest of session/controls/): the mode chip,
 * Interrupt (hold 0.6 s, so a stray tap never stops Claude), Clear draft
 * (End and Ctrl+U for every row of the draft in the terminal's input box,
 * not the composer's; shown only while the Mac allows it,
 * features.clearDraft), and the commands menu (CommandMenu.tsx).
 *
 * The session screen mounts it above the composer (or the waiting card, or
 * the receipt) while Controls are on and no card is open, and passes the
 * mode chip in. Each action says how it went on one line under the bar:
 * what happened in ink-3, a refusal in ink-2 with the daemon's reason (a
 * dialog is open, a draft is in the box, ...). Nothing here is ember.
 * Offline every control is disabled; the composer already says why.
 */
import { DotsThreeIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { ControlKey, Session, SessionCommandBody } from '@jantar/protocol';
import { errorText, isApiError } from '../../../../lib/api.js';
import { newIdempotencyKey } from '../../../../lib/ids.js';
import { useDeps } from '../../../context.js';
import { useFeatures } from '../../../shell/data.js';
import { Button } from '../../../kit/Button.js';
import { HoldButton } from '../../../kit/HoldButton.js';
import { IconButton } from '../../../kit/IconButton.js';

const CommandMenu = lazy(() => import('./CommandMenu.js').then((m) => ({ default: m.CommandMenu })));

/** Interrupt is held this long (a short hold: it is undone by typing again, unlike Always allow). */
export const INTERRUPT_HOLD_MS = 600;
/** A line saying what happened stays this long; a refusal stays until the next action. */
const NOTE_MS = 4_000;

export interface ControlBarProps {
  sid: string;
  session: Session;
  phone: boolean;
  offline: boolean;
  /** <ModeChip/>, already wired to this session. */
  modeChip: ReactNode;
}

type Busy = ControlKey | 'command' | null;
type Note = { text: string; refused: boolean } | null;

/** The daemon's own sentence when it has one (a 429 here is the 3-second Ctrl+C rule, not "a minute"). */
function reasonOf(e: unknown): string {
  return isApiError(e, 'rate_limited') && e.message ? e.message : errorText(e);
}

const slash = (cmd: SessionCommandBody) => (cmd.args ? `/${cmd.name} ${cmd.args}` : `/${cmd.name}`);

export function ControlBar({ sid, phone, offline, modeChip }: ControlBarProps) {
  const { api } = useDeps();
  const { clearDraft } = useFeatures();
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    if (!note || note.refused) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  const press = async (key: 'interrupt' | 'clearInput') => {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      await api.sessionKey(sid, key);
      setNote({ text: key === 'interrupt' ? 'Interrupt sent' : 'Draft cleared in the terminal', refused: false });
    } catch (e) {
      setNote({ text: `Not sent: ${reasonOf(e)}`, refused: true });
    } finally {
      setBusy(null);
    }
  };

  const run = async (cmd: SessionCommandBody) => {
    if (busy) return;
    setBusy('command');
    setNote(null);
    try {
      const r = await api.sessionCommand(sid, cmd, newIdempotencyKey());
      setNote({ text: r.proven ? `Claude ran ${slash(cmd)}` : `Typed ${slash(cmd)}; Claude has not confirmed it yet`, refused: false });
    } catch (e) {
      setNote({ text: `${slash(cmd)} not sent: ${reasonOf(e)}`, refused: true });
    } finally {
      setBusy(null);
    }
  };

  const off = offline || busy !== null;
  const commandsFallback = (
    <IconButton aria-label="Commands" className="size-32 coarse:size-44" disabled>
      <DotsThreeIcon size={20} weight="bold" aria-hidden="true" />
    </IconButton>
  );
  return (
    <div
      role="group"
      aria-label="Controls"
      className={clsx('flex flex-none flex-wrap items-center gap-x-8 gap-y-4', phone ? 'border-t border-line bg-bg px-16 py-8' : 'pb-12 pt-8')}
    >
      {modeChip}
      <HoldButton durationMs={INTERRUPT_HOLD_MS} onCommit={() => void press('interrupt')} disabled={off}>
        Interrupt
      </HoldButton>
      {clearDraft ? (
        <Button variant="text" aria-label="Clear draft in the Mac's terminal" onClick={() => void press('clearInput')} disabled={off}>
          Clear draft
        </Button>
      ) : null}
      <span className="min-w-0 flex-1" />
      <Suspense fallback={commandsFallback}>
        <CommandMenu disabled={off} onRun={(cmd) => void run(cmd)} />
      </Suspense>
      {note ? (
        <p role={note.refused ? 'alert' : 'status'} className={clsx('order-last basis-full type-small', note.refused ? 'text-ink-2' : 'text-ink-3')}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
