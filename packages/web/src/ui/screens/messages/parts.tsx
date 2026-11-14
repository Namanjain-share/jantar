/**
 * What 0.15 Messages' screens share: the client for this app's API, and the
 * failed-load state in Messages' own words. LifeError covers offline, the
 * switch off (the daemon's sentence, its command in mono) and any other
 * failure with Try again; two need Messages' sentence instead: a device
 * without control (LifeError's names Life) and a 503 messages_unavailable
 * (the reader down, WhatsApp unreadable, messages.db broken: the daemon's
 * fixed sentence, which a retry here doesn't change).
 */
import { useMemo } from 'react';
import { isApiError } from '../../../lib/api.js';
import { useDeps } from '../../context.js';
import { CommandSentence, LifeError } from '../life/shared/states.js';
import { messagesClient, type MessagesClient } from './client.js';

export const NO_CONTROL = 'This device can read sessions only. Messages needs control access: pair it again from your Mac.';

/** The Messages client over this app's API (one per API). */
export function useMessages(): MessagesClient {
  const { api } = useDeps();
  return useMemo(() => messagesClient(api), [api]);
}

/** A failed load: offline, no control, Messages off or unavailable, else the sentence and Try again. */
export function MessagesError({ error, offline = false, onRetry }: { error: unknown; offline?: boolean; onRetry?: () => void }) {
  if (!offline && isApiError(error, 'forbidden') && /\bscope\b/.test(error.message)) {
    return (
      <div role="status" className="px-16 py-16 desk:px-24">
        <p className="type-small text-ink-2">{NO_CONTROL}</p>
      </div>
    );
  }
  if (!offline && isApiError(error, 'messages_unavailable')) {
    return (
      <div role="status" className="px-16 py-16 desk:px-24">
        <CommandSentence sentence={error.message} className="break-words" />
      </div>
    );
  }
  return <LifeError error={error} offline={offline} {...(onRetry ? { onRetry } : {})} />;
}
