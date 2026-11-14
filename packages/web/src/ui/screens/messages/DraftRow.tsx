/**
 * One reply waiting on him (0.15 Messages, Today's "Waiting on you"): who,
 * when they asked, what they asked, and the morning run's suggested reply,
 * then its buttons:
 *
 *   Copy               the draft to the clipboard, on his tap
 *   Open in WhatsApp   only for a 1:1 with a known number: wa.me with the
 *                      draft typed in, in a new tab with no opener and no
 *                      referrer; he presses send in WhatsApp (a group gets
 *                      Copy only). Jantar never sends anything.
 *   Done / Dismiss     marks it (Today's 5 s Undo opens it again)
 *
 * Every word on the row is someone else's or the model's: text only,
 * wrapped where it sits, so a long name or a word with no space never
 * pushes the pane sideways.
 */
import { WhatsappLogoIcon } from '@phosphor-icons/react';
import type { Draft } from '@jantar/protocol/messages';
import { Button, buttonClass } from '../../kit/Button.js';
import { copyText, useFlash } from '../devices/parts.js';
import { waLink, whenText } from './model.js';

const COPY = 'Copy';

export interface DraftRowProps {
  draft: Draft;
  tz?: string | null | undefined;
  /** A write is going, or the Mac can't be reached: Done and Dismiss wait. */
  disabled: boolean;
  onState: (draft: Draft, state: 'done' | 'dismissed') => void;
}

export function DraftRow({ draft: d, tz, disabled, onState }: DraftRowProps) {
  const [said, say] = useFlash(COPY);
  const wa = waLink(d.phone, d.draft);
  return (
    <li data-draft={d.id} className="border-b border-line px-16 py-12">
      <div className="flex items-baseline gap-8">
        <span className="min-w-0 flex-1 break-words type-row text-ink">{d.chatName}</span>
        <span className="flex-none type-mono text-ink-3">{whenText(d.at, tz)}</span>
      </div>
      {d.theyAsked ? (
        <p className="mt-4 break-words type-small text-ink-2">
          <span className="text-ink-3">They asked: </span>
          <span>{d.theyAsked}</span>
        </p>
      ) : null}
      <p className="mt-8 whitespace-pre-wrap break-words rounded-btn border border-line bg-bg px-12 py-8 type-body text-ink">{d.draft}</p>
      <div data-actions className="mt-8 flex flex-wrap items-center gap-8">
        <Button
          size="md"
          aria-label={said === COPY ? `Copy the reply to ${d.chatName}` : said}
          onClick={() => void copyText(d.draft).then((ok) => say(ok ? 'Copied' : 'Could not copy'))}
          className="coarse:min-w-44"
        >
          {said}
        </Button>
        {wa ? (
          <a
            href={wa}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            aria-label={`Open in WhatsApp: ${d.chatName}`}
            className={buttonClass('outline', 'md', 'coarse:min-w-44')}
          >
            <WhatsappLogoIcon size={16} aria-hidden="true" />
            Open in WhatsApp
          </a>
        ) : null}
        <Button size="md" aria-label={`Done: ${d.chatName}`} disabled={disabled} onClick={() => onState(d, 'done')} className="coarse:min-w-44">
          Done
        </Button>
        <Button variant="text" size="md" aria-label={`Dismiss: ${d.chatName}`} disabled={disabled} onClick={() => onState(d, 'dismissed')} className="coarse:min-w-44">
          Dismiss
        </Button>
      </div>
    </li>
  );
}
