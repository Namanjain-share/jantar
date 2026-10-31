/**
 * The receipt under a prompt you sent (direction.md 5.2): mono, --ink-3,
 * `sending…`, then `typed`, then `delivered 14:02` with a check icon. A prompt that did not
 * arrive is loud, in --signal-text: `Not delivered: <reason>`, with the way
 * out right under it (Retry with the same key, Edit and resend, Put the text
 * back). `data-stage` carries the raw stage for tests and debugging.
 *
 * A prompt the Rewrite sheet wrote carries a mono `rewrite` tag beside its
 * receipt (spec 5.1's voice tag, U6), `rewrite · edited` once the user
 * changed it. The daemon decides that from the text's hash (SendJob.origin);
 * "Send what I said" is the user's own words and carries none.
 */
import { CheckIcon } from '@phosphor-icons/react';
import type { SendOrigin } from '@jantar/protocol';
import { clock } from '../../../lib/format.js';
import { Button } from '../../kit/Button.js';
import { Tag } from '../../kit/Tag.js';
import { isBad, type Sends, type SendView } from './sends.js';

/** The tag a prompt's origin earns; none for typed text and for "Send what I said". */
export function originTag(origin: SendOrigin | undefined): string | null {
  if (origin === 'rewrite') return 'rewrite';
  if (origin === 'rewrite-edited') return 'rewrite · edited';
  return null;
}

function OriginTag({ s }: { s: SendView }) {
  const tag = originTag(s.job?.origin);
  return tag ? <Tag className="ml-2">{tag}</Tag> : null;
}

function progressWord(s: SendView): string {
  const job = s.job;
  if (!job) return 'sending…';
  switch (job.stage) {
    case 'queued':
    case 'checking':
      return 'sending…';
    case 'typed':
      return 'typed';
    case 'enter':
      return job.attempts > 1 ? `typed · pressed Enter ${job.attempts} times, waiting for proof` : 'typed · waiting for proof';
    default:
      return '';
  }
}

export function SendReceipt({ s, sends, now }: { s: SendView; sends: Sends; now: number }) {
  const job = s.job;
  // The request itself failed (network, refusal, offline).
  if (s.error) {
    return (
      <div className="mt-6 flex flex-col items-start gap-6">
        <p role="alert" className="type-mono text-signal-text" data-stage="error">
          Not delivered: {s.error}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          {s.retryable && s.local ? (
            <Button variant="outline" size="sm" disabled={s.posting} onClick={() => s.local && void sends.retry(s.local)}>
              Retry
            </Button>
          ) : null}
          {s.text !== null ? (
            <Button variant="text" size="sm" onClick={() => sends.putBack(s.text ?? '', s.local)}>
              Edit and resend
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  if (job && isBad(job.stage)) {
    return (
      <div className="mt-6 flex flex-col items-start gap-6">
        <p role="alert" className="type-mono text-signal-text" data-stage={job.stage}>
          Not delivered{job.reason ? `: ${job.reason}` : '.'}
        </p>
        {s.text !== null ? (
          <Button variant="outline" size="sm" onClick={() => sends.putBack(s.text ?? '', s.local)}>
            Put the text back
          </Button>
        ) : null}
      </div>
    );
  }
  if (job && (job.stage === 'proven' || job.stage === 'proven-merged')) {
    const at = job.proof?.at ?? job.updatedAt;
    return (
      <p className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-4 type-mono text-ink-3" data-stage={job.stage}>
        <span>delivered {clock(at, now)}</span>
        <CheckIcon size={12} weight="bold" aria-label="proven by the transcript" />
        {job.stage === 'proven-merged' ? <span>· merged with text that was already in the input box</span> : null}
        <OriginTag s={s} />
      </p>
    );
  }
  const tag = originTag(job?.origin);
  if (tag) {
    // The live region says only the progress word; the tag sits beside it.
    return (
      <p className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-4 type-mono text-ink-3" data-stage={job?.stage ?? 'posting'}>
        <span aria-live="polite">{progressWord(s)}</span>
        <Tag className="ml-2">{tag}</Tag>
      </p>
    );
  }
  return (
    <p className="mt-6 type-mono text-ink-3" aria-live="polite" data-stage={job?.stage ?? 'posting'}>
      {progressWord(s)}
    </p>
  );
}
