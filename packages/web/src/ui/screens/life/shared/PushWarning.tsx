/**
 * "No device gets medicine pings." (v0.4 spec 1.3, 5.2, 5.4): on Medicines
 * and Today while medicines are on and no control device has a push
 * subscription, or Web Push is off at the Mac. The scheduler counts "no
 * device" as sent, so without this a missed ping would look like nothing due.
 * v0.7: Posts shows it for its own part, "No device gets post reminders."
 */
import { BellSlashIcon } from '@phosphor-icons/react';
import type { LifeStatus } from '@jantar/protocol';

export const NO_PUSH = 'No device gets medicine pings.';
export const NO_PUSH_POSTS = 'No device gets post reminders.';
export const NO_PUSH_DEVICES = 'Turn on notifications in Devices on the phone that should ring.';
export const NO_PUSH_SWITCH = "Web Push is switched off in this Mac's notification settings.";

/** The Life parts that ring, with the lead sentence each says. */
export type PushPart = 'medicines' | 'posts';
const LEAD: Record<PushPart, string> = { medicines: NO_PUSH, posts: NO_PUSH_POSTS };

/** Why no device would get `part`'s ping now, or null when one would (or the part is off). */
export function pushProblem(status: LifeStatus | null, part: PushPart = 'medicines'): string | null {
  if (!status || status.modules[part] !== true) return null;
  if (!status.push.webpush) return NO_PUSH_SWITCH;
  if (status.push.devices === 0) return NO_PUSH_DEVICES;
  return null;
}

export function PushWarning({ status, part = 'medicines' }: { status: LifeStatus | null; part?: PushPart }) {
  const why = pushProblem(status, part);
  if (!why) return null;
  return (
    <div role="status" className="flex items-start gap-8 border-b border-line px-16 py-10">
      <BellSlashIcon size={16} aria-hidden="true" className="mt-2 flex-none text-signal-text" />
      <p className="type-small">
        <span className="text-signal-text">{LEAD[part]}</span> <span className="text-ink-2">{why}</span>
      </p>
    </div>
  );
}
