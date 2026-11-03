/**
 * This device: its name and scopes, the theme, whether it is installed, and
 * its notifications (direction.md 5.5 and 5.7). Installing is offered here
 * too, so "Not now" in the pair flow always has a way back.
 *
 * 0.12 (c31): an iPad says "This iPad" and "Safari · iPadOS" (iPadOS says
 * it is a Mac; its touch points tell it apart), and the Keyboard row sets
 * the shortcuts Auto (keys once a keyboard has been seen), On or Off on this
 * device, with Show shortcuts (the ? list).
 */
import { ExportIcon } from '@phosphor-icons/react';
import { useStore } from 'zustand';
import { keyboardStore, setKeyboardMode, type KeyboardMode } from '../../../lib/input.js';
import { setShortcuts } from '../../shell/navState.js';
import { Segmented } from '../accounts/Segmented.js';
import { PRODUCT_NAME } from '../../../brand.js';
import { pwaStore } from '../../../lib/pwa.js';
import { Button } from '../../kit/Button.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Tag } from '../../kit/Tag.js';
import { describeAgent, guessDeviceName, isIPad, touchPoints, userAgent, type LocalDevice } from './local.js';
import { NotificationsRow } from './Notifications.js';
import { NowMark, PropRow, ThemeRadios } from './parts.js';
import { useDeviceSection } from './card.js';

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

const KEYBOARD: { key: KeyboardMode; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'on', label: 'On' },
  { key: 'off', label: 'Off' },
];

function KeyboardRow() {
  const mode = useStore(keyboardStore, (s) => s.mode);
  return (
    <PropRow label="Keyboard">
      <Segmented label="Keyboard shortcuts" segments={KEYBOARD} value={mode} onChange={setKeyboardMode} />
      <Button variant="text" onClick={() => setShortcuts(true)}>
        Show shortcuts
      </Button>
    </PropRow>
  );
}

export function ThisDevice({ me }: { me: LocalDevice | null }) {
  const look = useDeviceSection('mt-32');
  const ua = userAgent();
  const title = isIPad(ua) ? 'This iPad' : 'This device';
  const agent = describeAgent(ua, { touchPoints: touchPoints() });
  return (
    <section aria-label={title} className={look.section}>
      <RailLabel ground={look.ground} sticky={false} inset={false} className={look.rail}>
        {title}
      </RailLabel>
      <PropRow label="Name">
        <span className="type-row font-medium text-ink">{me?.name ?? guessDeviceName(ua)}</span>
        {agent ? <span className="type-mono text-ink-3">{agent}</span> : null}
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
      <KeyboardRow />
      <NotificationsRow />
    </section>
  );
}
