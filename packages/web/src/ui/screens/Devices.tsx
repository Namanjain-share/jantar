/**
 * Devices (direction.md 5.5): this device (name, scopes, theme, install,
 * notifications), the paired devices table (admin), pairing a new device
 * (admin, on the Mac) and the version line. Max width 880, rail ledger
 * style: group rails, hairline rows, no cards.
 *
 * v0.6 (Fleet): once a machine is paired, Machines (devices/Machines.tsx,
 * its own chunk) follows the paired devices. It stays for the rest of the
 * visit once shown, so removing the last machine still shows its receipt.
 *
 * 0.12 (build plan 2.11): no 880 cap. From a pane of 760 two columns, this
 * device on the left and the paired devices, machines and pairing on the
 * right, each section a card (devices/card.ts) and each column a container
 * of its own, so its rows lay out by the column's width; the product line
 * stays under both. One measure of the pane decides (none in jsdom: 0.10).
 */
import { lazy, Suspense, useRef, useState } from 'react';
import { PRODUCT_NAME } from '../../brand.js';
import { useApp } from '../context.js';
import { useBucket } from '../kit/Columns.js';
import { DeviceCards } from './devices/card.js';
import { readLocalDevice } from './devices/local.js';
import { PairedDevices } from './devices/PairedDevices.js';
import { PairNew } from './devices/PairNew.js';
import { ThisDevice } from './devices/ThisDevice.js';
import { hasMachines } from './session/Info.js';

const Machines = lazy(() => import('./devices/Machines.js').then((m) => ({ default: m.Machines })));

export { LOCAL_DEVICE_KEY, readLocalDevice, type LocalDevice } from './devices/local.js';
export { NotificationsRow as PushSection } from './devices/Notifications.js';

function Sep() {
  return <span aria-hidden="true">·</span>;
}

export function Devices() {
  const me = readLocalDevice();
  const daemon = useApp((s) => s.state.daemon);
  const machines = useApp((s) => hasMachines(s.state));
  const machinesShown = useRef(false);
  if (machines) machinesShown.current = true;
  const [paired, setPaired] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // c32: from 760 (was 900), so the iPad's 804 beside its sidebar at 1024 gets them too.
  const two = useBucket(box, (w) => w >= 760);
  return (
    <div ref={box} className="px-16 pb-48 pt-16 animate-enter desk:px-32 desk:pt-24">
      <div>
        <h1 data-display className="type-display text-ink">
          Devices
        </h1>
        <p className="mt-6 flex min-h-24 flex-wrap items-center gap-x-8 type-mono text-ink-3">
          {paired !== null ? (
            <>
              <span>
                <span className="text-ink-2">{paired}</span> paired
              </span>
              <Sep />
            </>
          ) : null}
          <span>
            daemon <span className="text-ink-2">{daemon?.daemonVersion ?? 'unknown'}</span>
          </span>
          <Sep />
          <span>
            protocol <span className="text-ink-2">{daemon?.protocol ?? '?'}</span>
          </span>
        </p>
        <DeviceCards.Provider value={two}>
          <div className={two ? 'mt-32 grid grid-cols-2 items-start gap-x-24' : undefined}>
            <div className="@container min-w-0">
              <ThisDevice me={me} />
            </div>
            <div className="@container min-w-0">
              <PairedDevices onCount={setPaired} />
              {machinesShown.current ? (
                <Suspense fallback={null}>
                  <Machines />
                </Suspense>
              ) : null}
              <PairNew />
            </div>
          </div>
        </DeviceCards.Provider>
        <p className="mt-40 type-small text-ink-3">{PRODUCT_NAME} is not affiliated with or endorsed by Anthropic.</p>
      </div>
    </div>
  );
}
