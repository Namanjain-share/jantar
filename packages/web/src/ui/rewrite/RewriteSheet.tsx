/**
 * The Rewrite review sheet (decisions U6; spec 5.1 adapted to text, no mic
 * and no recording). It opens at once on the Sheet kit, phone and desktop:
 *
 *   You said      what the user typed or dictated, read-only (3 lines, Show all)
 *   Prompt        "Writing the prompt…" with the Spinner until the job is
 *                 ready, then the written prompt in an editable 16 px box
 *                 (2 to 8 lines, 16,000 characters at most); the guard flags
 *                 above it in --ink-2, with the names the user never said
 *                 underlined in mono (a textarea cannot underline in place);
 *                 `opus · 07 · 2.4 s` in mono under it
 *   actions       Send (primary; "Send edited" after an edit) · Send what I
 *                 said · Rewrite again · Rewrite with Sonnet · Discard
 *   sent          the transcript's receipt row for SENT_MS, then it closes
 *
 * When the prompt writer fails, what the user said goes in the box with one
 * sentence in --ink-2 (a fallback, spec 5.1), and the primary becomes "Send
 * what I said", one tap. Ember (--signal-text, the "Not delivered" family,
 * spec 5.0 rule 3) is only for a request that failed with nothing to review
 * and for a send the Mac refused. A prompt the daemon would refuse on sight
 * ("!" bash mode, /clear) says why and Send stays off. Nothing sends without
 * a tap. Desktop: Cmd+Enter sends, Shift+Cmd+Enter sends what you said,
 * Escape closes (the review is kept: tap Rewrite to bring it back).
 */
import clsx from 'clsx';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { RewriteFlags } from '@jantar/protocol';
import { accountId } from '../../lib/format.js';
import { useNow } from '../context.js';
import { Button } from '../kit/Button.js';
import { KeyHints } from '../kit/Keycap.js';
import { Sheet } from '../kit/Sheet.js';
import { Spinner } from '../kit/Spinner.js';
import { Actions, OfflineLine } from '../screens/session/Fields.js';
import { SendReceipt } from '../screens/session/SendReceipt.js';
import { FilesLine } from '../screens/session/attach/Chips.js';
import { chipsWaiting, promptProblem } from '../screens/session/sends.js';
import { PROMPT_MAX, boxTextOf, problemSentence, showsBox, type Rewrite, type RewritePhase } from './useRewrite.js';

const LINE = 22;
const MIN_LINES = 2;
const MAX_LINES = 8;
/** "You said" folds to three lines past this many characters or lines. */
const FOLD_CHARS = 180;
const FOLD_LINES = 3;

/** The sheet's live region per phase (failed and error say their sentence themselves). */
const ANNOUNCE: Record<RewritePhase, string> = {
  starting: 'Writing the prompt',
  writing: 'Writing the prompt',
  fetching: 'Writing the prompt',
  review: 'Prompt ready',
  failed: '',
  error: '',
  sending: 'Sending',
  sent: 'Sent',
};

export interface RewriteSheetProps {
  rw: Rewrite;
  folder: string;
  phone: boolean;
  offline: boolean;
}

export function RewriteSheet({ rw, folder, phone, offline }: RewriteSheetProps) {
  // Keep the last body while the sheet slides away after a send or Discard.
  const last = useRef<ReactNode>(null);
  const body = rw.review ? <Body rw={rw} phone={phone} offline={offline} /> : last.current;
  if (rw.review) last.current = body;
  return (
    <Sheet
      open={rw.open}
      onOpenChange={(next) => {
        if (!next) rw.hide();
      }}
      title={`Rewrite for ${folder}`}
    >
      {body}
    </Sheet>
  );
}

/** The guard flags as ink lines (counts only: the job carries no text). "!" is the problem line's. */
export function flagLines(flags: RewriteFlags | undefined): string[] {
  if (!flags) return [];
  const lines: string[] = [];
  if (flags.expanded) lines.push('Longer than what you said · check it');
  if (flags.newTokens === 1) lines.push("Mentions a name you didn't say · check it");
  else if (flags.newTokens > 1) lines.push(`Mentions ${flags.newTokens} names you didn't say · check them`);
  if (flags.leading === 'slash') lines.push('Starts with / so Claude reads it as a command · check it');
  return lines;
}

function Body({ rw, phone, offline }: { rw: Rewrite; phone: boolean; offline: boolean }) {
  const boxId = useId();
  const now = useNow();
  // A rewrite asked for over edits in the box: the first tap says the edits go, the second rewrites.
  const [dropping, setDropping] = useState<{ which: 'again' | 'sonnet'; text: string } | null>(null);
  const r = rw.review;
  const phase = rw.phase;
  if (!r || !phase) return null;
  const job = rw.job;
  // While a send is out (and once it went), the box shows what was sent.
  const box = r.sending ? r.sending.text : boxTextOf(r);
  const withBox = showsBox(phase);
  const busy = phase === 'sending' || phase === 'sent';
  const sentence = phase === 'failed' || phase === 'error' ? problemSentence(r, job) : null;
  // Ember only where nothing went and there is nothing to review: a request error, or a send the Mac refused.
  const loud = phase === 'error' || r.expired === 'send';
  const flags = phase === 'review' ? flagLines(job?.prompt?.flags) : [];
  const overCap = withBox && !busy && box.length > PROMPT_MAX;
  const problem = withBox && !busy ? promptProblem(box) : null;
  const canEdit = phase === 'review' || phase === 'failed';
  const edited = canEdit && r.text !== undefined && r.text.trim() !== (phase === 'review' ? (r.prompt ?? '') : r.input).trim();
  // v0.4.2: the composer's chips go with either send, once every one is on the Mac (FilesLine says why they wait).
  const filesWait = chipsWaiting(rw.sends.attachments);
  const canSend = canEdit && Boolean(box.trim()) && !problem && !overCap && !offline && !filesWait;
  // A failure puts what the user said in the box, so its Send is "Send what I said" (never hidden, U5), not a second button.
  const asSaidPrimary = phase === 'failed' && r.expired !== 'send' && box.trim() === r.input;
  const canAsSaid = !busy && !offline && !filesWait && !promptProblem(r.input);
  // Rewrite needs what the user said within REWRITE_TEXT_MAX and no run in flight.
  const showRewrite = phase === 'review' || (phase === 'failed' && !r.tooLong) || (phase === 'sending' && r.prompt !== undefined);
  const canRewrite = showRewrite && !busy && !offline;
  const canRetry = phase === 'error' && (r.startError ? r.startError.again : true);
  // Only while the box still holds the edits that were warned about.
  const asked = dropping && edited && dropping.text === box ? dropping.which : null;
  const rewrite = (which: 'again' | 'sonnet') => {
    if (edited && asked !== which) {
      setDropping({ which, text: box });
      return;
    }
    setDropping(null);
    rw.rewrite(which === 'sonnet' ? 'sonnet' : undefined);
  };
  const describedBy = [flags.length ? `${boxId}-flags` : '', phase === 'review' && r.newTokens?.length ? `${boxId}-tokens` : ''].filter(Boolean).join(' ');
  const size = phone ? 'xl' : 'lg';
  // "opus · 07 · 2.4 s": the model, the account and how long the run took.
  const meta =
    phase === 'review' && job
      ? [job.model, job.account !== undefined ? accountId(job.account) : null, job.ms !== undefined ? `${(job.ms / 1000).toFixed(1)} s` : null]
          .filter(Boolean)
          .join(' · ')
      : '';
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (e.shiftKey) {
      if (canAsSaid) rw.sendAsSaid();
    } else if (canSend) rw.send();
  };

  // Phone: two columns, one below 360 px, where two text labels no longer fit side by side.
  const wide = clsx(phone && 'col-span-2 max-[360px]:col-span-1');
  let primary: ReactNode = null;
  if (phase === 'review' || phase === 'failed' || phase === 'sending') {
    const label = busy
      ? 'Sending…'
      : r.expired === 'send'
        ? 'Send again'
        : asSaidPrimary
          ? 'Send what I said'
          : edited
            ? 'Send edited'
            : 'Send';
    primary = (
      <Button variant="primary" size={size} className={wide} disabled={!canSend || busy} onClick={rw.send}>
        {label}
      </Button>
    );
  } else if (canRetry) {
    primary = (
      <Button variant="primary" size={size} className={wide} disabled={offline} onClick={rw.retry}>
        Try again
      </Button>
    );
  }

  return (
    <div onKeyDown={onKey} data-phase={phase}>
      <YouSaid text={r.input} />

      {sentence ? (
        <p role={loud ? 'alert' : 'status'} className={clsx('mt-12 type-small', loud ? 'text-signal-text' : 'text-ink-2')}>
          {sentence}
        </p>
      ) : null}

      {withBox ? (
        <>
          <label htmlFor={boxId} className="mt-16 block type-small text-ink-3">
            Prompt
          </label>
          {flags.length ? (
            <div id={`${boxId}-flags`}>
              {flags.map((f) => (
                <p key={f} className="mt-4 type-small text-ink-2">
                  {f}
                </p>
              ))}
            </div>
          ) : null}
          {phase === 'review' && r.newTokens?.length ? (
            <ul id={`${boxId}-tokens`} aria-label="Not in what you said" className="mt-4 flex flex-wrap gap-x-12 gap-y-4 type-mono text-ink-2">
              {r.newTokens.map((t) => (
                <li key={t} className="underline decoration-ink-3 decoration-2 underline-offset-2 wrap-anywhere">
                  {t}
                </li>
              ))}
            </ul>
          ) : null}
          <PromptBox id={boxId} value={box} disabled={busy} describedBy={describedBy || undefined} onChange={rw.setText} />
          <FilesLine sends={rw.sends} />
          {phase === 'sent' && rw.sendView ? <SendReceipt s={rw.sendView} sends={rw.sends} now={now} /> : null}
          {meta ? <p className="mt-8 type-mono text-ink-3">{meta}</p> : null}
          {problem || overCap ? (
            <p role="status" className="mt-8 type-small text-ink-2">
              {problem ?? `The Mac takes ${PROMPT_MAX.toLocaleString('en-US')} characters at most. Shorten it to send.`}
            </p>
          ) : null}
        </>
      ) : phase !== 'error' ? (
        <>
          <p className="mt-16 type-small text-ink-3">Prompt</p>
          <p className="mt-4 flex min-h-24 items-center gap-8 type-small text-ink-2">
            {/* The sheet's own live region says it once; the spinner is only the picture. */}
            <span aria-hidden="true" className="flex empty:hidden">
              <Spinner label="Writing the prompt" />
            </span>
            <span>Writing the prompt…</span>
          </p>
        </>
      ) : null}

      {phase !== 'sent' ? (
        <Actions phone={phone} layout="grid" className={clsx(phone && 'max-[360px]:grid-cols-1')}>
          {primary}
          {!asSaidPrimary ? (
            <Button size={size} disabled={!canAsSaid} onClick={rw.sendAsSaid}>
              Send what I said
            </Button>
          ) : null}
          {showRewrite ? (
            <>
              <Button size={size} disabled={!canRewrite} onClick={() => rewrite('again')}>
                {asked === 'again' ? 'Replace my edits' : 'Rewrite again'}
              </Button>
              <Button variant="text" size={size} disabled={!canRewrite} onClick={() => rewrite('sonnet')}>
                {asked === 'sonnet' ? 'Replace my edits with Sonnet' : 'Rewrite with Sonnet'}
              </Button>
            </>
          ) : null}
          <Button variant="text" size={size} disabled={busy} onClick={rw.discard}>
            Discard
          </Button>
        </Actions>
      ) : null}
      {asked ? (
        <p role="status" className="mt-8 type-small text-ink-2">
          A new rewrite replaces your edits in the box. Tap again to go ahead.
        </p>
      ) : null}

      {rw.intro && phase !== 'sent' ? (
        <p className="mt-12 type-small text-pretty text-ink-3">
          What you typed and the last few messages of this session go to Claude on one of your accounts, which writes the prompt. The Mac
          forgets what you typed and the written prompt once you send or discard, or 30 minutes after.
        </p>
      ) : null}
      <OfflineLine offline={offline} />
      {!phone && phase !== 'sent' ? (
        <p className="mt-12 type-mono">
          <KeyHints
            hints={[
              { keys: ['⌘↵'], label: 'send' },
              { keys: ['⇧⌘↵'], label: 'send what I said' },
              { keys: ['esc'], label: 'close' },
            ]}
          />
        </p>
      ) : null}
      <span role="status" className="sr-only">
        {ANNOUNCE[phase]}
      </span>
    </div>
  );
}

function YouSaid({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
  return (
    <div>
      <div className="flex items-center">
        <p className="type-small text-ink-3">You said</p>
        {long ? (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className="ml-auto h-24 rounded-chip px-4 type-small text-ink-2 transition-colors duration-120 hover:text-ink coarse:h-44"
          >
            {all ? 'Show less' : 'Show all'}
          </button>
        ) : null}
      </div>
      <p className={clsx('mt-4 whitespace-pre-wrap type-small text-ink-2 wrap-break-word', long && !all && 'line-clamp-3')}>
        {text}
      </p>
    </div>
  );
}

/** The editable prompt: 16 px (no iOS zoom), growing from two lines to eight. */
function PromptBox({
  id,
  value,
  disabled,
  describedBy,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  /** The guard flags and the names not in what was said, read with the box. */
  describedBy?: string | undefined;
  onChange: (text: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grow with the text (CSSOM, which the CSP allows), as the composer does.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const min = LINE * MIN_LINES + 18;
    const max = LINE * MAX_LINES + 18;
    el.style.height = `${Math.max(min, Math.min(max, el.scrollHeight + 2))}px`;
  }, [value]);
  return (
    <textarea
      id={id}
      ref={ref}
      value={value}
      rows={MIN_LINES}
      maxLength={PROMPT_MAX}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
      className={clsx(
        'no-scrollbar mt-8 block w-full resize-none rounded-btn border border-line-strong bg-surface px-12 py-8 type-input text-ink transition-colors duration-120',
        'focus-visible:outline-offset-0 disabled:border-line disabled:text-ink-3',
      )}
    />
  );
}
