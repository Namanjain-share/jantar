/**
 * The permission-mode chip (v0.3, the controls addendum; work package C owns
 * this file): shows the session's mode and, on a tap, the mode list.
 *
 * - The mode is session.mode: the daemon publishes the mode it reads off
 *   Claude's status line after every switch, and every hook carries it.
 *   Until the first one arrives the chip says the mode is not known.
 * - Picking a mode asks the daemon to step there with Shift+Tab, checking
 *   the screen after each step; the chip says "Switching to Plan" meanwhile.
 *   Bypass permissions and Auto first open a sheet with U7's sentence and a
 *   2-second hold, as starting a session that way does.
 * - A mode the session turned out not to have (409 mode_unavailable) is
 *   greyed in the list with the reason from then on.
 * - Errors stay inline under the bar, in ink. Offline the chip is disabled.
 *
 * The list itself is Base UI (ModeMenu.tsx), loaded with the first chip like
 * the app's other menus; until then the same chip shows, disabled.
 */
import { CaretDownIcon } from '@phosphor-icons/react';
import { lazy, Suspense, useState } from 'react';
import type { PermissionModeName, Session } from '@jantar/protocol';
import { errorText, isApiError } from '../../../../lib/api.js';
import { useApp, useDeps } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { HoldButton } from '../../../kit/HoldButton.js';
import { Sheet } from '../../../kit/Sheet.js';
import { CHIP } from './look.js';
import { NO_ASK_HOLD_MS, NO_ASK_MODES, NO_ASK_SENTENCE, markUnavailable, modeLabel, unavailableModes } from './modes.js';

const ModeMenu = lazy(() => import('./ModeMenu.js').then((m) => ({ default: m.ModeMenu })));

export interface ModeChipProps {
  sid: string;
  session: Session;
  phone: boolean;
}

export function ModeChip({ sid, session }: ModeChipProps) {
  const { api } = useDeps();
  const offline = useApp((s) => s.conn.status === 'offline');
  const [switching, setSwitching] = useState<PermissionModeName | null>(null);
  // The mode the daemon reached, shown until session.mode moves at all (the event can trail the reply).
  const [reached, setReached] = useState<{ mode: string; over: string | undefined } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setLearned] = useState(0);
  // A mode that never asks, waiting on its confirm sheet.
  const [confirming, setConfirming] = useState<PermissionModeName | null>(null);

  const current = reached && reached.over === session.mode ? reached.mode : session.mode;
  const label = switching ? `Switching to ${modeLabel(switching)}` : modeLabel(current);
  const ariaLabel = `Permission mode: ${label}`;
  const disabled = offline || switching !== null;

  const choose = (mode: PermissionModeName) => {
    if (mode === current || switching) return;
    if (NO_ASK_MODES.has(mode)) setConfirming(mode);
    else void pick(mode);
  };

  const pick = async (mode: PermissionModeName) => {
    if (mode === current || switching) return;
    setConfirming(null);
    setSwitching(mode);
    setError(null);
    try {
      // The daemon wants the hold said too for a mode that never asks.
      const r = NO_ASK_MODES.has(mode) ? await api.sessionMode(sid, mode, { confirm: true }) : await api.sessionMode(sid, mode);
      setReached({ mode: r.mode, over: session.mode });
    } catch (e) {
      if (isApiError(e, 'mode_unavailable')) {
        markUnavailable(sid, mode);
        setLearned((n) => n + 1);
      }
      setError(`Could not switch to ${modeLabel(mode)}: ${errorText(e)}`);
    } finally {
      setSwitching(null);
    }
  };

  const fallback = (
    <button type="button" className={CHIP} disabled aria-label={ariaLabel}>
      <span className="truncate">{label}</span>
      <CaretDownIcon size={12} aria-hidden="true" />
    </button>
  );
  return (
    <>
      <Suspense fallback={fallback}>
        <ModeMenu
          label={label}
          ariaLabel={ariaLabel}
          current={current}
          busy={switching !== null}
          disabled={disabled}
          unavailable={unavailableModes(sid, session.mode)}
          onPick={choose}
        />
      </Suspense>
      <Sheet open={confirming !== null} onOpenChange={(o) => (o ? undefined : setConfirming(null))} title={`Switch to ${modeLabel(confirming ?? undefined)}?`}>
        <p className="type-body font-medium text-ink-2">{NO_ASK_SENTENCE}</p>
        <div className="mt-16 flex flex-wrap gap-8 pb-8">
          <HoldButton variant="primary" size="xl" className="flex-1" durationMs={NO_ASK_HOLD_MS} disabled={offline} onCommit={() => confirming && void pick(confirming)}>
            Hold to switch
          </HoldButton>
          <Button variant="text" size="xl" onClick={() => setConfirming(null)}>
            Cancel
          </Button>
        </div>
      </Sheet>
      {error ? (
        <p role="alert" className="order-last basis-full type-small text-ink-2">
          {error}
        </p>
      ) : null}
    </>
  );
}
