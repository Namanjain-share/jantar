/**
 * This device's notifications: on or off, mute, and which kinds reach it
 * (direction.md 5.5). The kinds are a switch list; "Not delivered" is locked
 * on because a prompt that was not sent must reach you.
 */
import { LockSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { NotifyKind } from '@jantar/protocol';
import { PRODUCT_NAME } from '../../../brand.js';
import { errorText } from '../../../lib/api.js';
import { disablePush, enablePush, getPushState, type PushState } from '../../../lib/push.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { KINDS, readKinds, registerKinds, writeKinds } from './kinds.js';
import { InlineError, PropRow, Receipt, Switch, shortTime } from './parts.js';

export type Blocked = Exclude<PushState, 'on' | 'off'>;

/** Why push cannot be turned on here (kept from v0.1; tests pin them). */
export const PUSH_TEXT: Record<Blocked, string> = {
  'needs-install': `On iPhone and iPad, notifications only work in the Home Screen app: tap Share, then "Add to Home Screen", open ${PRODUCT_NAME} from there and come back here.`,
  insecure: `Notifications need HTTPS. Open ${PRODUCT_NAME} through your Tailscale Serve address (https://…ts.net), or on the Mac itself.`,
  unsupported: 'This browser cannot show web notifications.',
  denied: "Notifications are blocked for this site. Allow them in the browser's site settings, then reload.",
};

export function isBlocked(s: PushState | 'loading'): s is Blocked {
  return s !== 'loading' && s !== 'on' && s !== 'off';
}

/** Where push stands on this device, read once without prompting. */
export function usePushState(): [PushState | 'loading', (s: PushState) => void] {
  const { pushEnv } = useDeps();
  const [state, setState] = useState<PushState | 'loading'>('loading');
  useEffect(() => {
    let alive = true;
    getPushState(pushEnv).then(
      (s) => alive && setState(s),
      () => alive && setState('unsupported'),
    );
    return () => {
      alive = false;
    };
  }, [pushEnv]);
  return [state, setState];
}

type Note = { text: ReactNode; tone: 'ok' | 'error' } | null;

export function NotificationsRow() {
  const { api, pushEnv } = useDeps();
  const [state, setState] = usePushState();
  const [kinds, setKinds] = useState<NotifyKind[]>(readKinds);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const reasonId = useId();

  const turnOn = async () => {
    setBusy(true);
    setNote(null);
    try {
      const s = await enablePush(api, pushEnv);
      setState(s);
      if (s === 'on') {
        await registerKinds(api, kinds, pushEnv).catch(() => false);
        setNote({ text: 'Notifications are on', tone: 'ok' });
      }
    } catch (e) {
      setNote({ text: errorText(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setNote(null);
    try {
      setState(await disablePush(api, pushEnv));
      setNote({ text: 'Notifications are off', tone: 'ok' });
    } catch (e) {
      setNote({ text: errorText(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const mute = async (minutes: number) => {
    setNote(null);
    try {
      const r = await api.mute(minutes);
      setNote({
        text: r.mutedUntil ? (
          <>
            Muted until <span className="type-mono text-ink">{shortTime(r.mutedUntil)}</span>
          </>
        ) : (
          'Unmuted'
        ),
        tone: 'ok',
      });
    } catch (e) {
      setNote({ text: errorText(e), tone: 'error' });
    }
  };

  const toggle = (kind: NotifyKind, on: boolean) => {
    const next = writeKinds(on ? [...kinds, kind] : kinds.filter((k) => k !== kind));
    setKinds(next);
    if (state !== 'on') return;
    registerKinds(api, next, pushEnv).catch((e: unknown) => setNote({ text: errorText(e), tone: 'error' }));
  };

  const switchable = state === 'on' || state === 'off';

  let value;
  if (state === 'loading') value = <Spinner label="Checking notifications" />;
  else if (state === 'on')
    value = (
      <span className="inline-flex items-baseline gap-6">
        <span className="type-small font-medium text-ink">On</span>
        <span className="type-mono text-ink-2">
          · {kinds.length} of {KINDS.length} kinds
        </span>
      </span>
    );
  else if (state === 'off')
    value = (
      <>
        <span className="type-small font-medium text-ink">Off</span>
        <Button variant="primary" disabled={busy} onClick={() => void turnOn()}>
          Turn on notifications
        </Button>
      </>
    );
  else value = <span className="type-small text-ink">Not available here</span>;

  const aside =
    state === 'on' ? (
      <>
        <Button variant="text" size="sm" onClick={() => void mute(60)}>
          Mute 1 hour
        </Button>
        <Button variant="text" size="sm" onClick={() => void mute(8 * 60)}>
          Mute 8 hours
        </Button>
        <Button variant="text" size="sm" onClick={() => void mute(0)}>
          Unmute
        </Button>
        <Button variant="text" size="sm" disabled={busy} onClick={() => void turnOff()}>
          Turn off
        </Button>
      </>
    ) : undefined;

  return (
    <PropRow
      label="Notifications"
      aside={aside}
      below={
        <>
          {isBlocked(state) ? <p className="max-w-560 type-small text-ink-2">{PUSH_TEXT[state]}</p> : null}
          {state === 'off' ? (
            <p className="mb-12 max-w-560 type-small text-ink-2">
              Get a push on this device when a session needs you. Pick which kinds below.
            </p>
          ) : null}
          {switchable ? (
            <>
              <div role="group" aria-label="Notification kinds" className="grid border-t border-line md:grid-cols-2 md:gap-x-24">
                {KINDS.map((k) => (
                  <label
                    key={k.kind}
                    className="flex min-h-40 cursor-pointer items-center gap-12 border-b border-line py-8 has-disabled:cursor-default coarse:min-h-44"
                  >
                    <Switch
                      checked={k.locked ? true : kinds.includes(k.kind)}
                      disabled={k.locked}
                      describedBy={k.locked ? reasonId : undefined}
                      onChange={(on) => toggle(k.kind, on)}
                    />
                    <span className="flex w-112 flex-none items-center gap-4 type-small font-medium text-ink">
                      {k.word}
                      {k.locked ? <LockSimpleIcon size={16} aria-hidden="true" className="flex-none text-ink-3" /> : null}
                    </span>
                    <span id={k.locked ? reasonId : undefined} className="min-w-0 flex-1 type-small text-ink-3">
                      {k.text}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-12 max-w-560 type-small text-ink-3">These pick what reaches this device. A kind arrives only when the Mac sends it too.</p>
            </>
          ) : null}
          {note?.tone === 'ok' ? <Receipt className="mt-12">{note.text}</Receipt> : null}
          {note?.tone === 'error' ? <InlineError className="mt-12">{note.text}</InlineError> : null}
        </>
      }
    >
      {value}
    </PropRow>
  );
}
