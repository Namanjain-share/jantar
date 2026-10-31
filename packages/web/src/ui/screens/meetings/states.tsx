/**
 * The states Meetings say in their own words (v0.5 spec 5.6). LifeError
 * covers offline, the switch off (the daemon's FEATURE_OFF sentence, its
 * command in mono) and any other failure with Try again; two need the
 * Meetings sentence instead: a device without control (LifeError's names
 * Life) and meetings.db that would not open (a 503 with the daemon's fixed
 * sentence, which no retry changes).
 */
import { isApiError } from '../../../lib/api.js';
import { CommandSentence, LifeError } from '../life/shared/states.js';
import { NO_CONTROL } from './model.js';

/** A failed load: offline, no control, Meetings off or broken, else the sentence and Try again. */
export function MeetingsError({ error, offline = false, onRetry }: { error: unknown; offline?: boolean; onRetry?: () => void }) {
  if (!offline && isApiError(error, 'forbidden') && /\bscope\b/.test(error.message)) {
    return (
      <div role="status" className="px-16 py-16 md:px-24">
        <p className="type-small text-ink-2">{NO_CONTROL}</p>
      </div>
    );
  }
  if (!offline && isApiError(error, 'meetings_unavailable')) {
    return (
      <div role="status" className="px-16 py-16 md:px-24">
        <CommandSentence sentence={error.message} />
      </div>
    );
  }
  return <LifeError error={error} offline={offline} {...(onRetry ? { onRetry } : {})} />;
}
