/**
 * The phone's pair flow after the code is claimed (direction.md 5.5, 5.7):
 *
 *   step 2  install: iOS Safari gets the three Home Screen steps; Chrome and
 *           Android get an "Install Jantar" button (beforeinstallprompt). Skipped
 *           when already installed or when the browser cannot install.
 *   step 3  notifications: a real-looking banner stamped EXAMPLE DATA, then
 *           "Turn on notifications", which asks the OS.
 *
 * Full screen, no tabs, no connection chrome (the shell renders /pair bare).
 */
import { CheckIcon, ExportIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { DevicePublic } from '@jantar/protocol';
import { PRODUCT_NAME } from '../../../brand.js';
import { errorText } from '../../../lib/api.js';
import { enablePush } from '../../../lib/push.js';
import { pwaStore } from '../../../lib/pwa.js';
import { useDeps, useNavigate } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Mark, Wordmark } from '../../kit/Mark.js';
import { Spinner } from '../../kit/Spinner.js';
import { readKinds, registerKinds } from './kinds.js';
import { userAgent } from './local.js';
import { PUSH_TEXT, isBlocked, usePushState } from './Notifications.js';
import { InlineError, Receipt, StepNumber } from './parts.js';

/** The bare frame: wordmark, the step count, one column (440 max). */
export function PairFrame({ step, children }: { step?: [number, number]; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-440 px-16 pb-32 md:pt-48">
      <div className="flex h-52 items-center justify-between">
        <Wordmark />
        {step ? (
          <span className="type-mono text-ink-3">
            step <span className="text-ink-2">{step[0]}</span> of {step[1]}
          </span>
        ) : null}
      </div>
      <div key={step?.[0] ?? 0} className="mt-16 animate-enter">
        {children}
      </div>
    </div>
  );
}

/** Whether this browser gets the install step (iOS Safari, or a captured install prompt). */
export function wantsInstallStep(): boolean {
  const s = pwaStore.getState();
  return !s.standalone && (s.ios || s.installEvent !== null);
}

/** "Paired · iPhone · read, control": the receipt at the top of steps 2 and 3. */
function PairedLine({ device }: { device: DevicePublic }) {
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
      <CheckIcon size={16} weight="bold" aria-hidden="true" className="text-ink" />
      <h1 className="type-row font-medium text-ink">Paired</h1>
      <span className="type-mono text-ink-3">
        {device.name} · {device.scopes.join(', ')}
      </span>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex min-h-56 items-center gap-16 border-b border-line py-8">
      <StepNumber n={n} />
      <span className="type-body text-ink-2">{children}</span>
    </li>
  );
}

export function InstallStep({ device, step, onNext }: { device: DevicePublic; step: [number, number]; onNext: () => void }) {
  const ios = useStore(pwaStore, (s) => s.ios);
  const installEvent = useStore(pwaStore, (s) => s.installEvent);
  const promptInstall = useStore(pwaStore, (s) => s.promptInstall);
  const [busy, setBusy] = useState(false);
  const iPad = /iPad/.test(userAgent());
  // Nothing to install with any more (the prompt was used, or the app got installed): move on.
  const nothing = !ios && !installEvent;
  useEffect(() => {
    if (nothing) onNext();
  }, [nothing, onNext]);
  if (nothing) return null;
  return (
    <PairFrame step={step}>
      <PairedLine device={device} />
      {ios ? (
        <>
          <h2 data-display className="mt-24 type-display text-ink">
            Add {PRODUCT_NAME} to your Home Screen
          </h2>
          <ol className="mt-24 border-t border-line">
            <Step n={1}>
              Tap <b className="font-medium text-ink">Share</b>{' '}
              <ExportIcon size={20} aria-hidden="true" className="inline-block align-text-bottom text-ink" />
            </Step>
            <Step n={2}>
              Tap <b className="font-medium text-ink">Add to Home Screen</b>
            </Step>
            <Step n={3}>
              Open <b className="font-medium text-ink">{PRODUCT_NAME}</b> from your Home Screen
            </Step>
          </ol>
          <p className="mt-16 type-small text-ink-3">{iPad ? 'iPad' : 'iPhone'} only sends notifications to installed apps.</p>
          <Button variant="text" size="xl" className="mt-24 w-full" onClick={onNext}>
            Not now
          </Button>
        </>
      ) : (
        <>
          <h2 data-display className="mt-24 type-display text-ink">
            Install {PRODUCT_NAME}
          </h2>
          <p className="mt-8 type-body text-ink-2">It opens like an app, and notifications arrive even when the browser is closed.</p>
          <Button
            variant="primary"
            size="xl"
            className="mt-32 w-full"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void promptInstall()
                .catch(() => false)
                .then(() => {
                  setBusy(false);
                  onNext();
                });
            }}
          >
            Install {PRODUCT_NAME}
          </Button>
          <Button variant="text" size="xl" className="mt-8 w-full" onClick={onNext}>
            Not now
          </Button>
        </>
      )}
    </PairFrame>
  );
}

/** What a push looks like on the lock screen, in the iOS banner shape. Made-up content, stamped. */
export function ExampleBanner({ className }: { className?: string }) {
  return (
    <figure className={clsx('m-0', className)}>
      <figcaption className="mb-8 type-rail text-ink-3">Example data</figcaption>
      <div
        role="img"
        aria-label="Example notification: web-app needs you. Question: Which module should own the session cookie?"
        className="rounded-dock border border-line bg-raised px-12 pb-12 pt-10"
      >
        <div className="flex items-center gap-8" aria-hidden="true">
          <span className="flex size-20 flex-none items-center justify-center rounded-chip border border-line bg-bg">
            <Mark label={null} />
          </span>
          <span className="type-small text-ink-2">{PRODUCT_NAME}</span>
          <span className="ml-auto type-mono text-ink-3">now</span>
        </div>
        <p className="mt-8 type-small font-medium text-ink" aria-hidden="true">
          web-app needs you
        </p>
        <p className="type-small text-ink-2" aria-hidden="true">
          Question: Which module should own the session cookie?
        </p>
      </div>
    </figure>
  );
}

export function NotifyStep({ device, step }: { device: DevicePublic; step: [number, number] }) {
  const { api, pushEnv } = useDeps();
  const navigate = useNavigate();
  const [state, setState] = usePushState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAsk = state === 'off';
  const answers = device.scopes.includes('control');

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await enablePush(api, pushEnv);
      setState(s);
      if (s === 'on') await registerKinds(api, readKinds(), pushEnv).catch(() => false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PairFrame step={step}>
      <PairedLine device={device} />
      <h2 data-display className="mt-24 type-display text-ink">
        Know when a session needs you
      </h2>
      <p className="mt-8 type-body text-ink-2">
        {device.name} can now see{answers ? ' and answer' : ''} your Claude sessions. A push tells you when one is waiting.
      </p>
      <ExampleBanner className="mt-24" />
      {state === 'loading' ? <Spinner className="mt-16" label="Checking notifications" /> : null}
      {isBlocked(state) ? <p className="mt-16 type-small text-ink-2">{PUSH_TEXT[state]}</p> : null}
      {state === 'on' ? <Receipt className="mt-16">Notifications are on</Receipt> : null}
      {error ? <InlineError className="mt-12">{error}</InlineError> : null}
      <div className="mt-24 flex flex-col gap-8">
        {canAsk ? (
          <Button variant="primary" size="xl" className="w-full" disabled={busy} onClick={() => void turnOn()}>
            Turn on notifications
          </Button>
        ) : null}
        <Button variant={canAsk ? 'text' : 'primary'} size="xl" className="w-full" onClick={() => navigate('/', { replace: true })}>
          Open the board
        </Button>
      </div>
    </PairFrame>
  );
}
