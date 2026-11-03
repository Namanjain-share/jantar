/**
 * One Chat turn (v0.10, spec 0.10 B14): the user's words (pre-wrap) and
 * photo thumbnails, a Siri tag on voice turns; "Working…" with Stop while
 * it runs; the reply as plain text (never Markdown, never a link); then one
 * row per change Chat made, from the Mac's journal ("Added", "Changed",
 * "Logged", "Undone") with Undo while it is fresh; then the cards: Confirm
 * (a delete or an action, only the tap runs it; 0.11: named by its verb,
 * Delete, Stop, Summarize, Re-read) or Do it (a write held back
 * after Chat read someone else's text), and Dismiss. A failed turn shows
 * its reason and Try again. Every tap has its own Idempotency-Key.
 *
 * Ink only, with ember (design rule 3) for a failure alone: a turn that
 * failed, and a refused tap.
 */
import clsx from 'clsx';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ChatCard, ChatChange, ChatPhotoRef, ChatTurn } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { Tag } from '../../kit/Tag.js';
import { CHAT_COPY, changeWord, confirmVerb, undoable } from './model.js';

/** A failure, in ember: the Mac's sentence for a refused tap, or a failed turn's reason. */
export function Refused({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={clsx('type-small text-signal-text', className)}>
      {children}
    </p>
  );
}

/** A refusal in words: the Mac's own sentence for Chat's limits and conflicts, else what every screen says. */
export function refusalText(e: unknown): string {
  if (isApiError(e, 'conflict')) return e.message || CHAT_COPY.undoConflict;
  return isApiError(e, 'rate_limited') && e.message ? e.message : errorText(e);
}

/** One write at a time with a new Idempotency-Key for every tap, and its failure kept to show until the next run or reset. */
export function useTap() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (fn: (key: string) => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn(newIdempotencyKey());
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const reset = useCallback(() => setError(null), []);
  return { busy, error, run, reset };
}

/** A photo of the thread through a blob: URL (the CSP allows blob: images, never data:). */
function usePhoto(id: string | null): string | null {
  const { api } = useDeps();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    const ac = new AbortController();
    let made: string | null = null;
    api.chatPhoto(id, { signal: ac.signal }).then(
      (blob) => {
        made = URL.createObjectURL(blob);
        setUrl(made);
      },
      () => setUrl(null),
    );
    return () => {
      ac.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [api, id]);
  return url;
}

export function Thumb({ photo, onOpen, label = 'Open the photo' }: { photo: ChatPhotoRef; onOpen: (p: ChatPhotoRef) => void; label?: string }) {
  const url = usePhoto(photo.gone ? null : photo.id);
  if (photo.gone) {
    return <span className="flex size-64 items-center justify-center rounded-btn border border-line px-4 text-center type-small text-ink-3">{CHAT_COPY.photoGone}</span>;
  }
  return (
    <button type="button" aria-label={label} className="size-64 overflow-hidden rounded-btn border border-line bg-surface" onClick={() => onOpen(photo)}>
      {url ? <img src={url} alt="" className="size-full object-cover" /> : null}
    </button>
  );
}

function FullPhoto({ photo, onClose }: { photo: ChatPhotoRef | null; onClose: () => void }) {
  const url = usePhoto(photo?.id ?? null);
  return (
    <Sheet open={photo !== null} onOpenChange={(o) => (o ? null : onClose())} title="Photo">
      <div className="pb-16">{url ? <img src={url} alt="A photo you sent" className="max-h-[70vh] w-full rounded-btn object-contain" /> : <Spinner label="Opening the photo" />}</div>
    </Sheet>
  );
}

export interface TurnProps {
  turn: ChatTurn;
  nowMs: number;
  offline: boolean;
  canSend: boolean;
  /** Sent again from this phone: Try again is gone. */
  retried?: boolean;
  onRetry: (turn: ChatTurn) => void;
  onChanged: () => void;
}

export function Turn({ turn, nowMs, offline, canSend, retried = false, onRetry, onChanged }: TurnProps) {
  const { api } = useDeps();
  const stop = useTap();
  const [open, setOpen] = useState<ChatPhotoRef | null>(null);
  const running = turn.state === 'queued' || turn.state === 'running';
  return (
    <li data-turn={turn.id} className="border-b border-line px-16 py-12" aria-label={turn.via === 'voice' ? 'A question by Siri' : 'A message'}>
      <div className="flex flex-col items-end gap-6">
        {turn.via === 'voice' ? <Tag>{CHAT_COPY.siri}</Tag> : null}
        {turn.context ? <p className="max-w-[85%] truncate type-mono text-ink-3">looking at {turn.context.label}</p> : null}
        {turn.text ? <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-card bg-surface px-12 py-8 type-body text-ink">{turn.text}</p> : null}
        {turn.photos.length ? (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-6">
            {turn.photos.map((p) => (
              <Thumb key={p.id} photo={p} onOpen={setOpen} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-8">
        {running ? (
          <div className="flex items-center gap-12">
            <Spinner label={CHAT_COPY.working} delayMs={0} />
            <span className="type-small text-ink-2">{CHAT_COPY.working}</span>
            <Button variant="text" size="sm" disabled={offline || stop.busy} onClick={() => void stop.run((k) => api.chatCancel(turn.id, k)).then(onChanged)}>
              {CHAT_COPY.stop}
            </Button>
          </div>
        ) : null}
        {turn.reply ? <p className="whitespace-pre-wrap break-words type-body text-ink">{turn.reply}</p> : null}
        {turn.state === 'failed' || turn.state === 'cancelled' ? (
          <div className="flex flex-wrap items-center gap-8">
            {turn.state === 'failed' ? <Refused>{turn.reason ?? "Claude couldn't answer. Try again."}</Refused> : <p className="type-small text-ink-2">{turn.reason ?? 'Cancelled.'}</p>}
            {turn.state === 'failed' && retried ? <p className="type-small text-ink-2">{CHAT_COPY.sentAgain}</p> : null}
            {turn.state === 'failed' && !retried ? (
              <Button variant="outline" size="sm" disabled={!canSend} onClick={() => onRetry(turn)}>
                {CHAT_COPY.tryAgain}
              </Button>
            ) : null}
          </div>
        ) : null}
        {stop.error ? <Refused className="mt-4">{refusalText(stop.error)}</Refused> : null}
      </div>

      {turn.changes.length ? (
        <ul aria-label="What Chat changed" className="mt-8 flex flex-col gap-4">
          {turn.changes.map((c) => (
            <Change key={c.n} turn={turn} change={c} nowMs={nowMs} offline={offline} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
      {turn.cards.length ? (
        <ul aria-label="Waiting for your tap" className="mt-8 flex flex-col gap-8">
          {turn.cards.map((c) => (
            <Card key={c.n} turn={turn} card={c} offline={offline} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
      <FullPhoto photo={open} onClose={() => setOpen(null)} />
    </li>
  );
}

/**
 * One change: its word, its label (up to two lines, so the part that changed shows), Undo while it may run.
 * A refused Undo says why on its own line under the row, at full width; after a 409 (changed since, already
 * undone) Undo goes, as it would only be refused again.
 */
export function Change({ turn, change, nowMs, offline, onChanged }: { turn: ChatTurn; change: ChatChange; nowMs: number; offline: boolean; onChanged: () => void }) {
  const { api } = useDeps();
  const tap = useTap();
  const can = undoable(change, turn, nowMs) && !isApiError(tap.error, 'conflict');
  return (
    <li>
      <div className="flex min-h-32 items-center gap-8">
        <span className={clsx('w-64 flex-none type-small', change.state === 'undone' ? 'text-ink-3' : 'text-ink-2')}>{changeWord(change)}</span>
        <span className={clsx('line-clamp-2 min-w-0 flex-1 break-words type-small', change.state === 'undone' ? 'text-ink-3 line-through' : 'text-ink')}>{change.label}</span>
        {can ? (
          <Button variant="text" size="sm" data-undo="change" disabled={offline || tap.busy} onClick={() => void tap.run((k) => api.chatUndo(turn.id, change.n, k)).then(onChanged)}>
            {tap.busy ? <Spinner label="Undoing" /> : null}
            Undo
          </Button>
        ) : null}
      </div>
      {tap.error ? <Refused className="mt-2 pl-72">{refusalText(tap.error)}</Refused> : null}
    </li>
  );
}

function Card({ turn, card, offline, onChanged }: { turn: ChatTurn; card: ChatCard; offline: boolean; onChanged: () => void }) {
  const { api } = useDeps();
  const run = useTap();
  const dismiss = useTap();
  const waiting = card.state === 'waiting';
  const state = card.state === 'done' ? (card.kind === 'confirm' ? 'Done.' : 'Done. It is in the list above, with Undo.') : card.state === 'dismissed' ? 'Dismissed.' : card.state === 'expired' ? 'Over a day old.' : null;
  return (
    <li className="rounded-card border border-line px-12 py-10">
      <p className="type-body text-ink">{card.label}</p>
      {waiting ? (
        <div className="mt-8 flex flex-wrap items-center gap-8">
          <Button variant={card.kind === 'confirm' ? 'outline' : 'primary'} size="md" className={card.kind === 'confirm' ? 'text-signal-text' : undefined} disabled={offline || run.busy} onClick={() => void run.run((k) => api.chatCard(turn.id, card.n, k)).then(onChanged)}>
            {run.busy ? <Spinner label="Running" /> : null}
            {card.kind === 'confirm' ? confirmVerb(card.op) : CHAT_COPY.doIt}
          </Button>
          <Button variant="text" size="md" disabled={offline || dismiss.busy} onClick={() => void dismiss.run((k) => api.chatCardDismiss(turn.id, card.n, k)).then(onChanged)}>
            {CHAT_COPY.dismiss}
          </Button>
        </div>
      ) : card.state === 'failed' ? (
        <Refused className="mt-4">{card.reason ?? "That couldn't be done."}</Refused>
      ) : state ? (
        <p className="mt-4 type-small text-ink-2">{state}</p>
      ) : null}
      {run.error ? <Refused className="mt-4">{refusalText(run.error)}</Refused> : null}
      {dismiss.error ? <Refused className="mt-4">{refusalText(dismiss.error)}</Refused> : null}
    </li>
  );
}
