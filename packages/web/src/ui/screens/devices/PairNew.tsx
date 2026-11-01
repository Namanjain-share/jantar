/**
 * Pair a device (on the Mac): a code made here gives read and control; an
 * admin device is paired with the CLI (the daemon refuses launch and admin
 * codes over TCP). "Show pairing code" opens a dialog with the QR (black on white, 220 px in a 12 px white card),
 * the link with Copy, a per-second expiry countdown, three numbered steps and
 * one warning line (direction.md 5.5).
 *
 * v0.5.3: the QR and its encoder (the qrcode package) are their own chunk,
 * loaded the first time a code is shown, so the app's first load has room
 * for Ask; a white card of the same size holds the place meanwhile.
 */
import { Dialog } from '@base-ui/react/dialog';
import { CopyIcon, QrCodeIcon, XIcon } from '@phosphor-icons/react';
import { lazy, Suspense, useState } from 'react';
import { CLI_NAME, type PairStartResponse, type Scope } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { useDeps, useNow } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Spinner } from '../../kit/Spinner.js';
import { Tag } from '../../kit/Tag.js';
import { InlineError, SCOPE_TEXT, StepNumber, copyText, useFlash } from './parts.js';

const QrCard = lazy(() => import('./Qr.js').then((m) => ({ default: m.QrCard })));

export const PAIR_STEPS = ["Open your phone's camera", 'Scan the code', 'Pick a name and tap Pair this device'] as const;

/** "4:32" */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function PairCode({ pair, scopes, busy, onRenew, onDone }: { pair: PairStartResponse; scopes: Scope[]; busy: boolean; onRenew: () => void; onDone: () => void }) {
  const now = useNow(1000);
  const [copied, flash] = useFlash<'Copy' | 'Copied' | 'Could not copy'>('Copy');
  const left = Date.parse(pair.expiresAt) - now;
  const expired = left <= 0;
  return (
    <>
      <div className="flex items-center gap-8">
        <Dialog.Title className="type-title text-ink">Pair a device</Dialog.Title>
        <Dialog.Close render={<IconButton aria-label="Close" className="ml-auto -mr-4" />}>
          <XIcon size={16} aria-hidden="true" />
        </Dialog.Close>
      </div>
      <Dialog.Description className="mt-4 type-small text-ink-2">
        The device gets <span className="type-mono text-ink">{scopes.join(', ')}</span>. The code works once.
      </Dialog.Description>

      <div className="mt-20 flex flex-col gap-24 md:flex-row md:items-start">
        <Suspense fallback={<div aria-hidden="true" className="size-244 flex-none rounded-dock bg-qr-paper" />}>
          <QrCard text={pair.url} label={expired ? 'Expired pairing QR code' : 'Pairing QR code'} dim={expired} />
        </Suspense>
        <div className="min-w-0 flex-1">
          <ol className="border-t border-line">
            {PAIR_STEPS.map((s, i) => (
              <li key={s} className="flex min-h-48 items-center gap-12 border-b border-line py-8">
                <StepNumber n={i + 1} />
                <span className="type-small text-ink">{s}</span>
              </li>
            ))}
          </ol>
          <p className="mt-16 type-mono text-ink-3" aria-live={expired ? 'polite' : 'off'}>
            {expired ? (
              <span className="text-ink">This code expired.</span>
            ) : (
              <>
                expires in <span className="text-ink">{countdown(left)}</span>
              </>
            )}
          </p>
          {expired ? (
            <div className="mt-12 flex items-center gap-12">
              <Button variant="primary" disabled={busy} onClick={onRenew}>
                Make a new code
              </Button>
              <Spinner active={busy} label="Making a code" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-20 flex items-center gap-8 border-t border-line pt-12">
        <code className="min-w-0 flex-1 truncate type-mono text-ink-2">{pair.url.replace(/#.*$/, '#c=…')}</code>
        <Button
          size="sm"
          disabled={expired}
          aria-label={copied === 'Copy' ? 'Copy the pairing link' : copied}
          onClick={() => void copyText(pair.url).then((ok) => flash(ok ? 'Copied' : 'Could not copy'))}
        >
          <CopyIcon size={16} aria-hidden="true" />
          {copied}
        </Button>
      </div>
      <p className="mt-12 type-small text-ink-3">Anyone with this code can pair until it expires. Don't share it.</p>
      <div className="mt-20 flex justify-end">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  );
}

export function PairNew() {
  const { api } = useDeps();
  const [pair, setPair] = useState<PairStartResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scopes: Scope[] = ['read', 'control'];
  // The daemon only makes codes for a browser on the Mac itself (loopback).
  const remote = typeof location !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.pairStart({});
      setPair(r);
    } catch (e) {
      setPair(null);
      setProblem(isApiError(e, 'forbidden') ? `Pairing codes can only be made on the Mac. Run ${CLI_NAME} pair in Terminal there.` : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Pair a device">
      <RailLabel ground="bg" sticky={false} inset={false} className="mt-40">
        Pair a device
      </RailLabel>
      <p className="mt-12 max-w-560 type-small text-ink-2">Show a one-time code here, then scan it with the phone's camera. Every paired device can:</p>
      <div className="mt-12 border-t border-line">
        {(['read', 'control'] as const).map((s) => (
          <div key={s} className="flex min-h-40 items-center gap-12 border-b border-line py-8">
            <span className="w-72 flex-none">
              <Tag>{s}</Tag>
            </span>
            <span className="min-w-0 flex-1 type-small text-ink-2">{SCOPE_TEXT[s]}</span>
            <span className="type-mono text-ink-3">always</span>
          </div>
        ))}
        <div className="flex min-h-40 items-center gap-12 border-b border-line py-8">
          <span className="w-72 flex-none">
            <Tag>admin</Tag>
          </span>
          <span className="min-w-0 flex-1 type-small text-ink-2">
            {SCOPE_TEXT.admin}. Paired in the Mac's Terminal only: <code className="type-mono text-ink">{CLI_NAME} pair --admin</code>
          </span>
        </div>
      </div>
      {remote ? (
        <p className="mt-12 max-w-560 type-small text-ink-3">
          Codes are made on the Mac itself: open this page there, or run <code className="type-mono text-ink-2">{CLI_NAME} pair</code> in its Terminal.
        </p>
      ) : null}
      <div className="mt-16 flex items-center gap-12">
        <Button disabled={busy} onClick={() => void start()}>
          <QrCodeIcon size={16} aria-hidden="true" />
          Show pairing code
        </Button>
        <Spinner active={busy && pair === null} label="Making a code" />
      </div>
      {problem ? <InlineError className="mt-8 max-w-560">{problem}</InlineError> : null}

      <Dialog.Root open={pair !== null} onOpenChange={(o) => (o ? undefined : setPair(null))}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-35 bg-scrim animate-fade" />
          <Dialog.Viewport className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto px-16 py-48 md:items-center">
            <Dialog.Popup className="w-full max-w-600 rounded-dock bg-raised p-24 text-ink shadow-float outline-none animate-pop">
              {pair ? <PairCode pair={pair} scopes={scopes} busy={busy} onRenew={() => void start()} onDone={() => setPair(null)} /> : null}
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
