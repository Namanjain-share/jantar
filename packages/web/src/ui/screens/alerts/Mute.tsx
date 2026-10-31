/**
 * "Mute pushes" in the Alerts header (direction.md 5.4): Mute 1 hour, Mute 8
 * hours, or Unmute with "Muted until 18:40". Read-scope devices cannot read
 * settings, so this device remembers the `mutedUntil` the daemon last sent
 * back. Errors stay inline beside the control.
 */
import { CaretDownIcon } from '@phosphor-icons/react';
import { lazy, Suspense, useState } from 'react';
import { errorText } from '../../../lib/api.js';
import { readLocal, writeLocal } from '../../../lib/storage.js';
import { useDeps, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { hhmm } from '../accounts/time.js';

const MuteMenu = lazy(() => import('./MuteMenu.js').then((m) => ({ default: m.MuteMenu })));

/** This device's copy of the daemon's `notify.muted_until`. */
export const MUTED_UNTIL_KEY = 'notify-muted-until';

export function Mute() {
  const { api } = useDeps();
  const now = useNow(30_000);
  const [until, setUntil] = useState<string | null>(() => readLocal<string | null>(MUTED_UNTIL_KEY, null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const untilMs = until ? Date.parse(until) : NaN;
  const muted = Number.isFinite(untilMs) && untilMs > now;
  const label = muted ? `Muted until ${hhmm(untilMs)}` : 'Mute pushes';

  const mute = async (minutes: number) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.mute(minutes);
      const next = r.mutedUntil ?? null;
      setUntil(next);
      writeLocal(MUTED_UNTIL_KEY, next ?? undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-8">
      {error ? (
        <span role="alert" className="type-small text-signal-text">
          {error}
        </span>
      ) : null}
      <Suspense
        fallback={
          <Button size="sm" disabled>
            {label}
            <CaretDownIcon size={12} aria-hidden="true" />
          </Button>
        }
      >
        <MuteMenu label={label} muted={muted} busy={busy} onMute={(m) => void mute(m)} />
      </Suspense>
    </span>
  );
}
