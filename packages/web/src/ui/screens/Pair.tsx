/**
 * Pairing on the phone (direction.md 5.5, 5.7). The QR from `<cli> pair`
 * opens /pair#c=<code>. The code stays in the fragment (never sent in a
 * URL), is removed from the address bar at once, and is only used when the
 * person taps "Pair this device". Then: install (iOS Home Screen steps, or
 * Chrome's install prompt), then notifications. Also the 401 screen.
 */
import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';
import { CLI_NAME, type DevicePublic } from '@jantar/protocol';
import { errorText, isApiError } from '../../lib/api.js';
import { writeLocal } from '../../lib/storage.js';
import { useDeps, useNavigate } from '../context.js';
import { Button } from '../kit/Button.js';
import { RailLabel } from '../kit/RailLabel.js';
import { Tag } from '../kit/Tag.js';
import { LOCAL_DEVICE_KEY, deviceNoun, guessDeviceName, userAgent } from './devices/local.js';
import { InstallStep, NotifyStep, PairFrame, wantsInstallStep } from './devices/PairSteps.js';
import { CommandBox, InlineError, SCOPE_TEXT } from './devices/parts.js';

export { guessDeviceName } from './devices/local.js';

export function PairScreen({ code: routeCode }: { code: string | null }) {
  const { api, connection } = useDeps();
  const navigate = useNavigate();
  const [code] = useState(routeCode);
  const [name, setName] = useState(() => guessDeviceName(userAgent()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DevicePublic | null>(null);
  // Whether this flow has the install step (decided at claim time), and whether it is on screen.
  const [withInstall, setWithInstall] = useState(wantsInstallStep);
  const [installing, setInstalling] = useState(false);
  const nameId = useId();
  const hintId = useId();
  const noun = deviceNoun(userAgent());
  const total = withInstall ? 3 : 2;

  // Drop the one-time code from the address bar and history right away.
  useEffect(() => {
    if (routeCode) navigate('/pair', { replace: true });
  }, [routeCode, navigate]);

  const claim = async () => {
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.pairClaim({ code, name: name.trim() || 'Device' });
      writeLocal(LOCAL_DEVICE_KEY, { id: r.device.id, name: r.device.name, scopes: r.device.scopes });
      const install = wantsInstallStep();
      setWithInstall(install);
      setInstalling(install);
      setDevice(r.device);
      connection?.kick();
    } catch (e) {
      if (isApiError(e, 'rate_limited')) setError('Too many tries. Wait a minute and try again.');
      else if (isApiError(e, 'network')) setError(errorText(e));
      else setError(`This pairing code is wrong, already used or expired. Run ${CLI_NAME} pair on the Mac for a new one.`);
    } finally {
      setBusy(false);
    }
  };

  if (device && installing) return <InstallStep device={device} step={[2, 3]} onNext={() => setInstalling(false)} />;
  if (device) return <NotifyStep device={device} step={[total, total]} />;

  if (!code) {
    return (
      <PairFrame>
        <h1 data-display className="type-display text-ink">
          Pair this {noun}
        </h1>
        <p className="mt-16 type-body text-ink-2">This link has no pairing code. On your Mac, run</p>
        <CommandBox className="mt-8">{CLI_NAME} pair</CommandBox>
        <p className="mt-8 type-body text-ink-2">and scan the new code with this {noun}'s camera.</p>
        <Button size="lg" className="mt-32" onClick={() => navigate('/', { replace: true })}>
          Go to the board
        </Button>
      </PairFrame>
    );
  }

  return (
    <PairFrame step={[1, total]}>
      <h1 data-display className="type-display text-ink">
        Pair this {noun}
      </h1>
      <p className="mt-8 type-body text-ink-2">with the Mac that showed you this code</p>
      <form
        className="mt-32"
        onSubmit={(e) => {
          e.preventDefault();
          void claim();
        }}
      >
        <label htmlFor={nameId} className="block type-small font-medium text-ink">
          Name for this device
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          maxLength={64}
          autoComplete="off"
          aria-describedby={hintId}
          onChange={(e) => setName(e.target.value)}
          className="mt-8 block h-48 w-full rounded-btn border border-line-strong bg-surface px-12 type-input text-ink focus-visible:outline-offset-0"
        />
        <p id={hintId} className="mt-6 type-small text-ink-3">
          The Mac lists it under this name.
        </p>

        <RailLabel ground="bg" sticky={false} inset={false} className="mt-32">
          What it can do
        </RailLabel>
        <dl>
          {(['read', 'control', 'admin'] as const).map((s) => (
            <div key={s} className="flex min-h-40 items-center gap-12 border-b border-line py-8">
              <dt className="w-72 flex-none">
                <Tag>{s}</Tag>
              </dt>
              <dd className="type-small text-ink-2">
                {SCOPE_TEXT[s]}
                {s === 'admin' ? <span className="text-ink-3">, if the Mac allowed it</span> : null}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-12 type-small text-ink-3">The Mac chose these when it made the code. You can revoke this {noun} from the Mac at any time.</p>

        <Button type="submit" variant="primary" size="xl" className="mt-32 w-full" disabled={busy || !name.trim()}>
          {busy ? 'Pairing…' : 'Pair this device'}
        </Button>
        {error ? <InlineError className="mt-12">{error}</InlineError> : null}
      </form>
    </PairFrame>
  );
}

/** The 401 screen: this browser has no (or a revoked) device key. */
export function NotPaired() {
  const { connection } = useDeps();
  return (
    <PairFrame>
      <h1 data-display className="type-display text-ink">
        This browser isn't paired
      </h1>
      <p className="mt-16 type-body text-ink-2">On your Mac, run</p>
      <CommandBox className="mt-8">{CLI_NAME} pair</CommandBox>
      <p className="mt-8 type-body text-ink-2">and scan the code.</p>
      <p className="mt-24 type-small text-ink-3">
        On the Mac itself, <code className="type-mono text-ink-2">{CLI_NAME} open</code> opens a link that pairs this browser in one tap.
      </p>
      <Button size="lg" className="mt-32" onClick={() => connection?.kick()}>
        <ArrowClockwiseIcon size={16} aria-hidden="true" />
        Try again
      </Button>
    </PairFrame>
  );
}
