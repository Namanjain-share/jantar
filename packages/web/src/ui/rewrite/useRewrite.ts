/**
 * The Rewrite review's state (decisions U5, U6): start a run on what the
 * user typed or dictated, follow the job (`state.rewrites`, live over the
 * WebSocket, never any text), fetch the written prompt once with
 * `rewriteGet` when the job is ready, and send it through the composer's
 * `sends.post` so the transcript shows the receipt like any other prompt.
 * Nothing here ever sends on its own: every send is a tap.
 *
 * What the user said stays in the composer's draft until a send from the
 * sheet goes out, so Discard (or the Mac failing) loses nothing. Closing the
 * sheet with a swipe or Escape only hides it: tapping Rewrite again with the
 * same draft brings the same review back, unless that review can never send
 * (a final refusal, an expired or stopped job), which starts afresh. A job
 * that is no longer needed is cancelled, which drops its texts on the Mac at
 * once instead of after REWRITE_TTL_MS.
 *
 * Everything a send owes the composer (clearing the draft, cancelling a job
 * the send went without) is done the moment `sends.post` takes it, not when
 * the Mac answers: posting clears the answer receipt in Session.tsx, which
 * can remount the composer and this hook with it in the middle of the send.
 *
 * Sending with the job id lets the daemon tell a written, edited or "as
 * said" prompt apart by its hash. The daemon answers 404 when it no longer
 * has the job (texts dropped 30 min after the job ends, or a restart): the
 * sheet then keeps the text and offers to send it again without the id.
 * A 404 can also mean the session is gone, so a send with the id refused
 * with 404 is checked with one `rewriteGet`: a 404 there, or a job without
 * its texts, means the job is gone. A 409 means an earlier send of the job
 * is still being typed: the sheet closes and that send's receipt is the one
 * the transcript shows. Any other refusal closes the sheet and the
 * transcript says why. "Send again" drops the refused send's "Not
 * delivered" from the transcript (`sends.forget`): the new send replaces it.
 *
 * A job that stops moving (the daemon restarted, or its events stopped
 * coming) is asked about with one `rewriteGet`: when it leaves the state
 * snapshot, when the daemon's epoch changes, and every STALL_MS without news.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  REWRITE_TEXT_MAX,
  type RewriteDetail,
  type RewriteFailure,
  type RewriteJob,
  type RewriteModel,
  type RewriteState,
} from '@jantar/protocol';
import { ApiError, errorText, isApiError, type ApiErrorCode } from '../../lib/api.js';
import { newIdempotencyKey } from '../../lib/ids.js';
import { readLocal, writeLocal } from '../../lib/storage.js';
import { useApp, useDeps } from '../context.js';
import { promptProblem, type Sends, type SendView } from '../screens/session/sends.js';

/** POST /v1/sessions/:sid/prompt takes at most this many characters (the composer's cap too). */
export const PROMPT_MAX = 16_000;

/** rewrite.timeoutS (120 s by default) plus a margin: a job with no news for this long is asked about once. */
export const STALL_MS = 150_000;

/** The sheet stops waiting for a rewriteGet after this long (fetch: Try again; check after a send: closes). */
export const GET_TIMEOUT_MS = 15_000;

/** How long the sheet shows the receipt of an accepted send before it closes (spec 5.1). */
export const SENT_MS = 1_200;

/** localStorage key: the one-time line about where the text goes has been shown. */
const INTRO_KEY = 'rewrite-intro-seen';

/**
 * What the sheet shows:
 *   starting  the POST is in flight
 *   writing   queued or writing on the Mac
 *   fetching  ready; the prompt text is on its way (rewriteGet)
 *   review    the written prompt is in the box
 *   failed    no prompt: what the user said is in the box, with one sentence
 *   error     a request failed and there is nothing to review yet (Try again)
 *   sending   a send from the sheet is in flight
 *   sent      the Mac took it: the receipt shows for SENT_MS, then the sheet closes
 */
export type RewritePhase = 'starting' | 'writing' | 'fetching' | 'review' | 'failed' | 'error' | 'sending' | 'sent';

export interface Review {
  /** What the user said: the composer's draft, trimmed (the daemon hashes it as received). */
  input: string;
  /** This run's model when the user picked one ("Rewrite with Sonnet"). */
  model?: RewriteModel;
  /** One Idempotency-Key per start; a retry after a network failure reuses it. */
  startKey: string;
  jobId?: string;
  /** The newest snapshot of the job from the POST, the GET or an event (a fresh state snapshot may no longer hold it). */
  known?: RewriteJob;
  /** `again`: Try again makes sense; `network`: the request may not have arrived, so it reuses `startKey`. */
  startError?: { text: string; again: boolean; network: boolean };
  /** The written prompt, as GET /v1/rewrite/:jobId returned it. */
  prompt?: string;
  /** The names the guards found in it that the user never said (owner only, from the same GET). */
  newTokens?: string[];
  fetchError?: string;
  /** The Mac no longer has the job: found by a GET, or by a send that got 404. */
  expired?: 'fetch' | 'send';
  /** Longer than REWRITE_TEXT_MAX: never sent to the prompt writer. */
  tooLong?: boolean;
  /** The Prompt box once the user typed in it. */
  text?: string;
  /** A send from the sheet: `key` is its entry in `sends.views` (what `sends.post` returned). */
  sending?: { key: string; withJob: boolean; text: string };
  /** The send refused because the job had expired: "Send again" takes its place in the transcript. */
  refusedKey?: string;
  /** The Mac took the send: the receipt shows until the sheet closes. */
  sent?: boolean;
}

/** Sent and cancelled jobs hold no texts any more; every other job's cancel drops them (a failed one keeps what the user said). */
const holdsTexts = (state: RewriteState) => state !== 'sent' && state !== 'cancelled';

const RANK: Record<RewriteState, number> = { queued: 0, writing: 1, ready: 2, failed: 3, cancelled: 3, sent: 4 };

/** The later of two snapshots of one job (events, the POST reply and the GET reply race). */
export function newerJob(a: RewriteJob | undefined, b: RewriteJob | undefined): RewriteJob | undefined {
  if (!a || !b) return a ?? b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return RANK[b.state] > RANK[a.state] ? b : a;
}

/** Fixed sentences for a failed job without its own `reason` (the daemon normally sends one). */
const FAILURE_SENTENCE: Record<RewriteFailure, string> = {
  no_account: 'No account has room for the prompt writer. Send what you said, or edit it.',
  unavailable: "The prompt writer isn't available on the Mac. Here is what you said.",
  failed: "The prompt writer couldn't run. Here is what you said.",
  timeout: 'The prompt writer timed out. Here is what you said.',
  flags_rejected: "Claude on the Mac refused the prompt writer's settings. Here is what you said.",
  empty: 'The prompt writer wrote nothing. Here is what you said.',
};

const fmt = (n: number) => n.toLocaleString('en-US');

/** The one sentence the sheet shows in the failed and error phases. */
export function problemSentence(r: Review, job: RewriteJob | undefined): string | null {
  if (r.tooLong) {
    return `That's too long to rewrite: ${fmt(r.input.length)} characters, and the limit is ${fmt(REWRITE_TEXT_MAX)}. Send it as it is, or split it.`;
  }
  if (r.expired === 'send') return 'Nothing was typed: the Mac no longer has this rewrite (it keeps one for 30 minutes). Send it again to type it as it is.';
  if (r.expired === 'fetch') return 'The Mac no longer has this rewrite. Here is what you said.';
  if (r.startError) return r.startError.text;
  if (r.fetchError) return `Couldn't fetch the prompt: ${r.fetchError}`;
  if (!job) return null;
  if (job.state === 'failed') return job.reason ?? FAILURE_SENTENCE[job.failure ?? 'failed'];
  if (job.state === 'cancelled') return 'This rewrite was stopped. Here is what you said.';
  if (job.state === 'sent') return 'This rewrite was already sent. Here is what you said.';
  return null;
}

/** Refusals that the same request would meet again. */
const FINAL_START_ERRORS: readonly ApiErrorCode[] = ['forbidden', 'unauthorized', 'invalid_request', 'payload_too_large', 'not_implemented'];

function startErrorOf(e: unknown): NonNullable<Review['startError']> {
  const network = isApiError(e, 'network');
  const again = !(isApiError(e) && FINAL_START_ERRORS.includes(e.code));
  const text = isApiError(e, 'not_implemented') ? "Jantar on this Mac can't rewrite prompts yet." : errorText(e);
  return { text, again, network };
}

export function phaseOf(r: Review, job: RewriteJob | undefined): RewritePhase {
  if (r.sent) return 'sent';
  if (r.sending) return 'sending';
  if (r.tooLong || r.expired) return 'failed';
  if (r.startError) return 'error';
  if (!job) return 'starting';
  switch (job.state) {
    case 'queued':
    case 'writing':
      return 'writing';
    case 'ready':
      return r.prompt !== undefined ? 'review' : r.fetchError ? 'error' : 'fetching';
    default:
      return 'failed';
  }
}

/**
 * A held review that can never send or rewrite again as it stands: a final
 * refusal of the start, a job the Mac no longer has, or one that was stopped
 * or sent. Tapping Rewrite starts afresh instead of bringing it back.
 */
export function isSpent(r: Review, job: RewriteJob | undefined): boolean {
  if (r.startError && !r.startError.again) return true;
  if (r.expired) return true;
  return job?.state === 'cancelled' || job?.state === 'sent';
}

/**
 * The job is no longer sendable with its id: the daemon's originFor takes
 * only a ready job that still holds its texts (sent and cancelled jobs stay,
 * text-free, until their expiry).
 */
const goneForSend = (d: RewriteDetail) => d.state !== 'ready' || d.input === undefined;

/** The Prompt box: what the user typed in it, else the written prompt, else what they said. */
export const boxTextOf = (r: Review) => r.text ?? (r.expired ? undefined : r.prompt) ?? r.input;

/** The box shows in these phases (sending and sent keep showing what went). */
export const showsBox = (phase: RewritePhase) => phase === 'review' || phase === 'failed' || phase === 'sending' || phase === 'sent';

/** A request the sheet stops waiting for after `ms` (rewriteGet takes no AbortSignal): a timeout reads as a network failure. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ApiError('network', 'The Mac did not answer in time', 0)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const uniq = (list: readonly string[] | undefined) => [...new Set(list ?? [])];

export function useRewrite({ sid, sends }: { sid: string; sends: Sends }) {
  const { api, store } = useDeps();
  const [review, setReview] = useState<Review | null>(null);
  const [open, setOpen] = useState(false);
  const [intro, setIntro] = useState(() => !readLocal<boolean>(INTRO_KEY, false));

  const stored = useApp((s) => (review?.jobId ? s.state.rewrites[review.jobId] : undefined));
  const epoch = useApp((s) => s.epoch);
  const job = newerJob(stored, review?.known);
  const phase = review ? phaseOf(review, job) : null;

  // Latest values for async callbacks and the unmount cleanup.
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const openRef = useRef(open);
  openRef.current = open;
  const sendsRef = useRef(sends);
  sendsRef.current = sends;
  /** The start whose reply is still wanted; a reply for any other start cancels its job. */
  const liveKey = useRef<string | null>(null);
  const fetching = useRef<string | null>(null);
  const checking = useRef<string | null>(null);
  const probed = useRef<string | null>(null);

  const update = useCallback((startKey: string, fn: (r: Review) => Review) => {
    setReview((cur) => (cur && cur.startKey === startKey ? fn(cur) : cur));
  }, []);

  const cancelJob = useCallback(
    (jobId: string) => {
      void api.rewriteCancel(jobId).catch(() => undefined);
    },
    [api],
  );

  /** The job of a review as far as anyone here knows (the store, else the review's own snapshot). */
  const jobOf = useCallback((r: Review) => newerJob(r.jobId ? store.getState().state.rewrites[r.jobId] : undefined, r.known), [store]);

  /** Cancel a review's job so the Mac drops its texts now (a start still in flight is cancelled when it answers). */
  const dropJob = useCallback(
    (r: Review) => {
      if (!r.jobId) return;
      const j = jobOf(r);
      if (!j || holdsTexts(j.state)) cancelJob(r.jobId);
    },
    [jobOf, cancelJob],
  );

  /** The sheet closed: the line about where the text goes has been seen. */
  const introSeen = useCallback(() => {
    if (!intro) return;
    setIntro(false);
    writeLocal(INTRO_KEY, true);
  }, [intro]);

  const close = useCallback(() => {
    liveKey.current = null;
    setReview(null);
    setOpen(false);
    introSeen();
  }, [introSeen]);
  const closeRef = useRef(close);
  closeRef.current = close;

  const start = useCallback(
    (input: string, model?: RewriteModel, key: string = newIdempotencyKey()) => {
      const held = reviewRef.current;
      if (held && held.startKey !== key) dropJob(held);
      liveKey.current = key;
      fetching.current = null;
      const base: Review = { input, startKey: key, ...(model ? { model } : {}) };
      setOpen(true);
      if (input.length > REWRITE_TEXT_MAX) {
        setReview({ ...base, tooLong: true });
        return;
      }
      setReview(base);
      api.rewriteStart(sid, input, { ...(model ? { model } : {}), idempotencyKey: key }).then(
        (res) => {
          if (liveKey.current !== key) {
            cancelJob(res.jobId);
            return;
          }
          update(key, (cur) => ({ ...cur, jobId: res.jobId, known: res.job }));
        },
        (e: unknown) => update(key, (cur) => ({ ...cur, startError: startErrorOf(e) })),
      );
    },
    [api, sid, dropJob, cancelJob, update],
  );

  /** The composer's button: bring back the review held for this text, or start one. */
  const openFor = useCallback(
    (input: string) => {
      const held = reviewRef.current;
      if (held && held.input === input && !held.sending && !isSpent(held, jobOf(held))) setOpen(true);
      else start(input);
    },
    [start, jobOf],
  );

  /** Swipe, Escape or the backdrop: hide the sheet and keep the review. */
  const hide = useCallback(() => {
    setOpen(false);
    introSeen();
  }, [introSeen]);

  const discard = useCallback(() => {
    const held = reviewRef.current;
    if (held && !held.sending) dropJob(held);
    close();
  }, [dropJob, close]);

  /** "Try again" after a failed request: the start (same key after a network failure) or the GET. */
  const retry = useCallback(() => {
    const r = reviewRef.current;
    if (!r) return;
    if (r.startError) start(r.input, r.model, r.startError.network ? r.startKey : undefined);
    else if (r.fetchError) update(r.startKey, (cur) => ({ ...cur, fetchError: undefined }));
  }, [start, update]);

  // ----- the written prompt arrives only through rewriteGet, once the job is ready -----
  const jobId = review?.jobId;
  const startKey = review?.startKey;
  const needsFetch = Boolean(jobId && job?.state === 'ready' && review?.prompt === undefined && !review?.fetchError && !review?.expired);
  useEffect(() => {
    if (!needsFetch || !jobId || !startKey || fetching.current === jobId) return;
    fetching.current = jobId;
    const done = () => {
      if (fetching.current === jobId) fetching.current = null;
    };
    withTimeout(api.rewriteGet(jobId), GET_TIMEOUT_MS).then(
      (d) => {
        done();
        if (d.prompt !== undefined)
          update(startKey, (cur) => ({ ...cur, prompt: d.prompt, newTokens: uniq(d.newTokens), known: newerJob(cur.known, d.job) }));
        else
          update(startKey, (cur) => ({
            ...cur,
            known: newerJob(cur.known, d.job),
            ...(d.state === 'ready' ? { fetchError: 'the Mac sent no text' } : {}),
          }));
      },
      (e: unknown) => {
        done();
        update(startKey, (cur) => (isApiError(e, 'not_found') ? { ...cur, expired: 'fetch' } : { ...cur, fetchError: errorText(e) }));
      },
    );
  }, [needsFetch, jobId, startKey, api, update]);

  // ----- a job that stops moving: ask the Mac once (a 404 means it is gone) -----
  const check = useCallback(
    (id: string, key: string) => {
      if (checking.current === id) return;
      checking.current = id;
      const done = () => {
        if (checking.current === id) checking.current = null;
      };
      withTimeout(api.rewriteGet(id), GET_TIMEOUT_MS).then(
        (d) => {
          done();
          update(key, (cur) => {
            if (cur.jobId !== id || cur.sending) return cur;
            const known = newerJob(cur.known, d.job);
            // Ready with its text: take the prompt now rather than fetching it a second time.
            return d.state === 'ready' && d.prompt !== undefined && cur.prompt === undefined
              ? { ...cur, known, prompt: d.prompt, newTokens: uniq(d.newTokens) }
              : { ...cur, known };
          });
        },
        (e: unknown) => {
          done();
          // Anything else (offline, a timeout) waits for the next event or the next STALL_MS. A prompt
          // already in the box stays: a send then finds out with its own 404.
          if (isApiError(e, 'not_found'))
            update(key, (cur) => (cur.jobId === id && !cur.sending && cur.prompt === undefined ? { ...cur, expired: 'fetch' } : cur));
        },
      );
    },
    [api, update],
  );

  const writing = phase === 'writing';
  // Keep the newest snapshot in the review, so a fresh state snapshot without the job cannot take the sheet back a step.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!jobId || !startKey) return;
    if (stored) {
      seen.current = jobId;
      update(startKey, (cur) => (cur.jobId === jobId && newerJob(cur.known, stored) !== cur.known ? { ...cur, known: stored } : cur));
    } else if (seen.current === jobId && writing) {
      // The job left the state: the daemon restarted (its jobs live in memory) or forgot it.
      seen.current = null;
      check(jobId, startKey);
    }
  }, [stored, jobId, startKey, writing, update, check]);

  // A new daemon (epoch) has none of the old one's jobs.
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    const before = lastEpoch.current;
    lastEpoch.current = epoch;
    if (before !== null && before !== epoch && writing && jobId && startKey) check(jobId, startKey);
  }, [epoch, writing, jobId, startKey, check]);

  // No news for STALL_MS (the run's own timeout has passed): ask, and again every STALL_MS until it moves.
  const lastMove = job?.updatedAt;
  useEffect(() => {
    if (!writing || !jobId || !startKey) return;
    const t = setInterval(() => check(jobId, startKey), STALL_MS);
    return () => clearInterval(t);
  }, [writing, jobId, startKey, lastMove, check]);

  // ----- sending -----
  const sending = review?.sending;
  const sendView: SendView | undefined = useMemo(
    () => (sending ? sends.views.find((v) => v.key === sending.key) : undefined),
    [sends.views, sending],
  );

  const accepted = Boolean(sendView?.local?.jobId) && !sendView?.posting;
  const failedWith = sendView && !sendView.posting && !sendView.local?.jobId ? (sendView.error ?? null) : null;
  useEffect(() => {
    const r = reviewRef.current;
    if (!r?.sending || r.sent || !sendView) return;
    if (accepted) {
      update(r.startKey, (cur) => ({ ...cur, sent: true }));
      return;
    }
    if (failedWith === null) return;
    // Sent with the job id and refused with 404: is the job gone (expired), or the session?
    if (r.sending.withJob && r.jobId && sendView.errorCode === 'not_found') {
      if (probed.current === sendView.key) return;
      probed.current = sendView.key;
      const { startKey: key, jobId: id, input } = r;
      const sentText = r.sending.text;
      const refusedKey = sendView.key;
      const expire = () => {
        update(key, (x) => ({ ...x, sending: undefined, expired: 'send', text: sentText, refusedKey }));
        // Nothing was typed: what the user said goes back in the composer, as it was before the send.
        const s = sendsRef.current;
        if (!s.draft.trim()) s.setDraft(input);
      };
      withTimeout(api.rewriteGet(id), GET_TIMEOUT_MS).then(
        (d) => {
          if (reviewRef.current?.startKey !== key) return;
          if (goneForSend(d)) expire();
          else closeRef.current();
        },
        (e: unknown) => {
          if (reviewRef.current?.startKey !== key) return;
          if (isApiError(e, 'not_found')) expire();
          else closeRef.current();
        },
      );
      return;
    }
    // 409: an earlier send of this job is still being typed, and its own receipt follows it. This
    // one typed nothing and failed nothing, so it leaves no "Not delivered" behind.
    if (r.sending.withJob && sendView.errorCode === 'conflict') {
      sendsRef.current.forget(sendView.key);
      close();
      return;
    }
    // Refused or unreachable: the transcript says why, with Retry or Edit and resend.
    close();
  }, [accepted, failedWith, sendView, api, close, update]);

  // The receipt shows for SENT_MS, then the sheet closes.
  const sent = Boolean(review?.sent);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => closeRef.current(), SENT_MS);
    return () => clearTimeout(t);
  }, [sent]);

  const post = (text: string, withJob: boolean) => {
    const r = reviewRef.current;
    if (!r) return;
    const s = sendsRef.current;
    const id = withJob ? r.jobId : undefined;
    const key = id ? s.post(text, { rewriteJobId: id }) : s.post(text);
    if (key === null) return;
    // From here this hook may be remounted before the Mac answers, so the send's duties are done now.
    if (s.draft.trim() === r.input) s.setDraft('');
    // Sent again after an expiry: the refused send's "Not delivered" would say the same text twice.
    if (r.refusedKey) s.forget(r.refusedKey);
    if (!id) {
      // A plain send never needs the job: drop its texts now (an expired one has none), and cancel a start still in flight when it answers.
      if (!r.expired) dropJob(r);
      liveKey.current = null;
    }
    update(r.startKey, (cur) => ({ ...cur, sending: { key, withJob: Boolean(id), text: text.trim() }, refusedKey: undefined }));
  };

  /** Send the Prompt box: with the job id while the job is ready, plainly once it failed or expired. */
  const send = () => {
    const r = reviewRef.current;
    if (!r || (phase !== 'review' && phase !== 'failed')) return;
    post(boxTextOf(r), phase === 'review');
  };

  /** "Send what I said": with the job id when it is ready (the daemon records "as said"), else plainly and the run is stopped. */
  const sendAsSaid = () => {
    const r = reviewRef.current;
    if (!r || r.sending || promptProblem(r.input)) return;
    post(r.input, phase === 'review' || (job?.state === 'ready' && !r.expired));
  };

  const setText = (text: string) => {
    const r = reviewRef.current;
    if (r) update(r.startKey, (cur) => ({ ...cur, text }));
  };

  // A hidden review whose draft changed is for text that no longer exists: drop it.
  const draft = sends.draft;
  useEffect(() => {
    const r = reviewRef.current;
    if (!r || openRef.current || r.sending || draft.trim() === r.input) return;
    dropJob(r);
    liveKey.current = null;
    setReview(null);
  }, [draft, open, dropJob]);

  // Unmount (a card took the pane, the session closed, Rewrite was switched off): never send.
  // An open review's text goes to the composer draft, and the job is dropped. A send in
  // flight already did its part in post().
  const dropRef = useRef(dropJob);
  dropRef.current = dropJob;
  useEffect(
    () => () => {
      const r = reviewRef.current;
      liveKey.current = null;
      if (!r || r.sending) return;
      const p = phaseOf(r, newerJob(store.getState().state.rewrites[r.jobId ?? ''], r.known));
      if (openRef.current && (p === 'review' || p === 'failed')) {
        const text = boxTextOf(r);
        if (text.trim()) sendsRef.current.setDraft(text);
      }
      dropRef.current(r);
    },
    [store],
  );

  return {
    review,
    job,
    phase,
    open: open && review !== null,
    intro,
    /** The send from the sheet as the transcript shows it (its receipt row while the sheet says Sent). */
    sendView,
    sends,
    openFor,
    hide,
    discard,
    retry,
    /** "Rewrite again" (the Mac's model) and "Rewrite with Sonnet": a new run on the same text. */
    rewrite: (model?: RewriteModel) => {
      const r = reviewRef.current;
      if (r && !r.sending) start(r.input, model);
    },
    send,
    sendAsSaid,
    setText,
  };
}

export type Rewrite = ReturnType<typeof useRewrite>;
