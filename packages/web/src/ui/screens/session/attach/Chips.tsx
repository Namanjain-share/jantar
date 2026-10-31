/**
 * The composer's attachments as chips (v0.4.2, spec 6.1), a row above the
 * box that scrolls sideways: a 36 px thumbnail (a `blob:` URL, revoked when
 * the chip goes) or a file glyph, the name cut to 24 characters, the
 * upload's progress then a tick, or "failed" with Retry (network failures
 * and 429s only); × removes the chip and its upload on the Mac
 * (`sends.removeAttachment`). Why a chip failed, and the composer's notice
 * ("Up to 10 files per prompt", offline), are lines under the row: a 44 px
 * chip has no room for a sentence. `FilesLine` is the Rewrite sheet's line;
 * the sheet covers the composer, so it offers Retry and Remove for a file
 * that failed itself.
 */
import { CheckIcon, XIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { Button } from '../../../kit/Button.js';
import { IconButton } from '../../../kit/IconButton.js';
import { attachmentsLine, cutName, type Attachment, type Sends } from '../sends.js';
import { Glyph, type GlyphName } from './glyph.js';

export interface ChipsProps {
  sends: Sends;
  phone: boolean;
}

/** A chip shows this many characters of the name at most. */
export const CHIP_NAME_MAX = 24;

export function shortName(name: string): string {
  return name.length > CHIP_NAME_MAX ? `${cutName(name, CHIP_NAME_MAX - 1)}…` : name;
}

/** The chip's glyph; a kind this app does not know (the Mac's reply is not checked here) gets the plain file (glyph.tsx). */
function glyphOf(a: Attachment): GlyphName {
  return a.kind ?? a.upload?.kind ?? 'text';
}

function stateWord(a: Attachment): string {
  if (a.state === 'preparing') return 'preparing';
  if (a.state === 'uploading') return `${Math.round(a.progress * 100)}%`;
  if (a.state === 'failed') return 'failed';
  return '';
}

function Chip({ a, sends }: { a: Attachment; sends: Sends }) {
  const name = shortName(a.name);
  return (
    <li data-state={a.state} className="flex h-44 max-w-240 flex-none items-center gap-8 rounded-btn border border-line bg-surface pl-4">
      {a.thumb ? (
        <img src={a.thumb} alt="" className="size-36 flex-none rounded-chip object-cover" />
      ) : (
        <span className="flex size-36 flex-none items-center justify-center rounded-chip bg-hover text-ink-3">
          <Glyph name={glyphOf(a)} size={18} />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate type-small text-ink">{name}</span>
        <span
          className={clsx('flex items-center type-mono', a.state === 'failed' ? 'text-ink-2' : 'text-ink-3')}
          // While it uploads, a progress bar for a screen reader (its percent is the text shown).
          {...(a.state === 'uploading'
            ? { role: 'progressbar', 'aria-label': `Uploading ${name}`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(a.progress * 100) }
            : {})}
        >
          {a.state === 'ready' ? <CheckIcon size={12} weight="bold" aria-label="on the Mac" /> : stateWord(a)}
        </span>
      </span>
      {a.state === 'failed' && a.retryable ? (
        <Button variant="text" size="sm" className="-mx-4 flex-none" aria-label={`Retry ${a.name}`} onClick={() => sends.retryAttachment(a.key)}>
          Retry
        </Button>
      ) : null}
      <IconButton aria-label={`Remove ${a.name}`} disabled={a.sending === true} onClick={() => sends.removeAttachment(a.key)}>
        <XIcon size={14} weight="bold" aria-hidden="true" />
      </IconButton>
    </li>
  );
}

export function Chips({ sends, phone }: ChipsProps) {
  const list = sends.attachments;
  const notice = sends.attachNotice;
  if (!list.length && !notice) return null;
  return (
    <div className="mb-8">
      {list.length ? (
        <ul aria-label="Attached files" className={clsx('no-scrollbar flex gap-8 overflow-x-auto', phone && '-mx-16 px-16')}>
          {list.map((a) => (
            <Chip key={a.key} a={a} sends={sends} />
          ))}
        </ul>
      ) : null}
      {list.map((a) =>
        a.state === 'failed' && a.error ? (
          <p key={a.key} role="status" className="mt-4 type-small text-ink-2 wrap-anywhere">
            {shortName(a.name)}: {a.error}
          </p>
        ) : null,
      )}
      {notice ? (
        <p role="status" className="mt-4 type-small text-ink-2">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Rewrite sheet's line about the files its send carries: "2 files go
 * with it" (spec 6.7). A file that failed is listed under it with its reason,
 * Retry (network failures and 429s) and Remove, as its chip has them.
 */
export function FilesLine({ sends }: { sends: Sends }) {
  const line = attachmentsLine(sends.attachments);
  if (!line) return null;
  const failed = sends.attachments.filter((a) => a.state === 'failed');
  return (
    <div className="mt-8">
      <p className="type-small text-ink-2">{line}</p>
      {failed.length ? (
        <ul aria-label="Files that didn't upload" className="mt-4 flex flex-col gap-4">
          {failed.map((a) => (
            <li key={a.key} className="flex flex-wrap items-center gap-x-4">
              <span className="min-w-0 type-small text-ink-2 wrap-anywhere">
                {shortName(a.name)}
                {a.error ? `: ${a.error}` : ''}
              </span>
              {a.retryable ? (
                <Button variant="text" size="sm" aria-label={`Retry ${a.name}`} onClick={() => sends.retryAttachment(a.key)}>
                  Retry
                </Button>
              ) : null}
              <Button variant="text" size="sm" aria-label={`Remove ${a.name}`} disabled={a.sending === true} onClick={() => sends.removeAttachment(a.key)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
