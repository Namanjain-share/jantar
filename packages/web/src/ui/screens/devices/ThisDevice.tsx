/**
 * This device: its name and scopes, the theme, whether it is installed, and
 * its notifications (direction.md 5.5 and 5.7). Installing is offered here
 * too, so "Not now" in the pair flow always has a way back.
 */
import { ExportIcon } from '@phosphor-icons/react';
import { useStore } from 'zustand';
import { PRODUCT_NAME } from '../../../brand.js';
import { pwaStore } from '../../../lib/pwa.js';
import { Button } from '../../kit/Button.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Tag } from '../../kit/Tag.js';
import { guessDeviceName, userAgent, type LocalDevice } from './local.js';
import { NotificationsRow } from './Notifications.js';
import { NowMark, PropRow, ThemeRadios } from './parts.js';

function InstallState() {
  const installEvent = useStore(pwaStore, (s) => s.installEvent);
  const standalone = useStore(pwaStore, (s) => s.standalone);
  const ios = useStore(pwaStore, (s) => s.ios);
  const promptInstall = useStore(pwaStore, (s) => s.promptInstall);
  if (standalone) return <span className="type-small font-medium text-ink">Installed</span>;
  if (installEvent) {
    return (
      <Button onClick={() => void promptInstall()}>
        Install {PRODUCT_NAME}
      </Button>
    );
  }
  if (ios) {
    return (
      <span className="type-small text-ink-2">
        Not installed. In Safari, tap Share <ExportIcon size={16} aria-hidden="true" className="inline-block align-text-bottom text-ink" /> then Add to
        Home Screen.
      </span>
    );
  }
  return <span className="type-small text-ink-2">Not installed. Use the browser's Install app or Add to Home Screen menu item.</span>;
}

export function ThisDevice({ me }: { me: LocalDevice | null }) {
  return (
    <section aria-label="This device">
      <RailLabel ground="bg" sticky={false} inset={false} className="mt-32">
        This device
      </RailLabel>
      <PropRow label="Name">
        <span className="type-row font-medium text-ink">{me?.name ?? guessDeviceName(userAgent())}</span>
        {me ? (
          <span className="inline-flex flex-wrap gap-4">
            <span className="sr-only">scopes </span>
            {me.scopes.map((s) => (
              <Tag key={s}>{s}</Tag>
            ))}
          </span>
        ) : null}
        <NowMark className="ml-auto" />
      </PropRow>
      <PropRow label="Theme">
        <ThemeRadios />
      </PropRow>
      <PropRow label="Install">
        <InstallState />
      </PropRow>
      <NotificationsRow />
    </section>
  );
}
