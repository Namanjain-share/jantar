/**
 * Send-with-proof for one job. Runs while the
 * writer holds the pane's queue, from the precheck to the proof.
 *
 *  1. Preconditions (preconditions.ts). Any failure refuses: nothing typed.
 *  2. Record the transcript's byte size, then read the input box, so that
 *     box read is the last look at the terminal before typing.
 *  3. Drafts. Terminal.app cannot tell Claude's grey suggestion from a real
 *     draft, so text in the box is not a reason to refuse there; exact proof
 *     decides and a merged draft is flagged (proven-merged). A styled backend
 *     (tmux, v0.2) refuses a real draft unless onDraft is "replace".
 *     Never type twice, decided from the box itself (memory is lost on a
 *     restart): if the box already holds exactly this prompt, only press
 *     Enter; if it holds this prompt (or an earlier unproven one of ours)
 *     with other text, refuse.
 *  4. Check daemon state once more (cards, waiting), then type the literal
 *     text once.
 *  5. Enter 2.5 s after typing, then every 2.5 s, at most 12 times (slash
 *     commands 2). Before each Enter re-check status, cards, the foreground,
 *     the screen and the input box: a dialog means stop at once (an Enter
 *     would answer it); a box that holds anything but our text means stop at
 *     once (an Enter would submit someone else's draft); an empty box means
 *     our text has left it, so no more Enters, only waiting for proof.
 *     Between Enters the transcript is polled for proof (proof.ts). /compact
 *     is recorded only once compaction is done, so its proof is waited for
 *     much longer (compactProofMs), still without more Enters.
 *     - A typing or Enter error that may still have reached Terminal (a
 *       timeout: osascript stopped waiting, Terminal may run the keys later;
 *       or "not responding") is not a definite "not sent" (W7): no more
 *       Enters, but the proof is still polled for the usual window first.
 *     - Once the prompt shows up in Claude's queue (an enqueue), no more
 *       Enters either: the box is empty, or holds the queue the user pulled
 *       back. The enqueue is proof only once Claude takes it out of the
 *       queue (W9); waited for up to queuedProofMs. Popped back into the box
 *       at the Mac (Esc or Up) first: failed, and the box is left alone.
 *  6. Out of tries, or stopped: failed. The writer emits the failure (and the
 *     alert) first; only then does the cleanup here clear the box with
 *     Ctrl-U, and only if the input line shows exactly our text.
 */
import type { Pane, SendJob, SendProof, Session } from '@jantar/protocol';
import type { DaemonContext, Factories, TerminalErrorCode, TranscriptReader } from '../contracts.js';
import { squash, vimModeBelow } from '../terminal/screen.js';
import { checkSessionProcess } from './proc-start.js';
import { ccwCheck, lookupSession, paneCheck, stateBlocker } from './preconditions.js';
import { PROOF_SLACK_MS, scanForProof, type ProofHit } from './proof.js';
import { expectedPrompt, type ExpectedPrompt } from './text.js';

export type WriterDeps = Parameters<Factories['writer']>[1];

export interface SendTimings {
  /** First Enter this long after typing. Default 2500. */
  enterDelayMs: number;
  /** Then one Enter every this long. Default 2500. */
  enterIntervalMs: number;
  /** At most this many Enters. Default 12. */
  maxEnters: number;
  /** At most this many Enters for a slash command (a second Enter could pick from a menu). Default 2. */
  slashMaxEnters: number;
  /** The transcript is checked for proof this often while waiting. Default 500. */
  proofPollMs: number;
  /** An entry timestamped this long before typing started still counts. Default 5000. */
  proofSlackMs: number;
  /** Screen lines read for the dialog check. Default 60. */
  screenLines: number;
  /** Refuse when Claude's input box isn't on screen. Default true. */
  requireInputBox: boolean;
  /** Transcript bytes read per call. Default 8 MiB. */
  readChunkBytes: number;
  /** An unproven prompt we typed is assumed to be in the box for this long. Default 30 min. */
  paneMemoryMs: number;
  /** /compact is recorded after compaction finishes: its proof is waited for this long after typing. Default 5 min. */
  compactProofMs: number;
  /**
   * A prompt waiting in Claude's queue is watched this long (from when it was
   * seen queued) for Claude to take it, or for it to be popped back into the
   * box. Still queued after that: proven, with a note. Default 5 min.
   */
  queuedProofMs: number;
}

export const DEFAULT_TIMINGS: SendTimings = {
  enterDelayMs: 2500,
  enterIntervalMs: 2500,
  maxEnters: 12,
  slashMaxEnters: 2,
  proofPollMs: 500,
  proofSlackMs: PROOF_SLACK_MS,
  screenLines: 60,
  requireInputBox: true,
  readChunkBytes: 8 * 1024 * 1024,
  paneMemoryMs: 30 * 60_000,
  compactProofMs: 5 * 60_000,
  queuedProofMs: 5 * 60_000,
};

/** What the writer remembers about text it typed into a pane that was never proven. */
export interface PaneMemory {
  textHash: string;
  /** Squashed text, kept in memory only (never logged or emitted). */
  norm: string;
  at: number;
}

export interface SendRun {
  job(): SendJob;
  text: string;
  onDraft: 'refuse' | 'replace';
  progress(patch: Partial<Pick<SendJob, 'stage' | 'attempts' | 'paneId'>>): void;
  signal: AbortSignal;
  memory: Map<string, PaneMemory>;
}

export type SendOutcome =
  | { stage: 'proven' | 'proven-merged'; proof: SendProof; notes: string[] }
  | { stage: 'refused'; reason: string }
  | { stage: 'failed'; reason: string; cleanup?: () => Promise<void> };

class Aborted extends Error {}

function isAbort(e: unknown): boolean {
  return e instanceof Aborted || (e instanceof Error && e.name === 'AbortError');
}

/**
 * Whether keys may still reach Terminal after this error: osascript gave up
 * waiting (timeout) or Terminal was busy ("not responding", other script
 * errors). A missing tab, a refused permission or text we never sent is a
 * definite failure.
 */
function mayStillArrive(code: TerminalErrorCode): boolean {
  return code === 'timeout' || code === 'failed';
}

const NOT_PROVEN_YET = 'the prompt was not proven sent (it may still arrive, or be partly in the input box; check the session before sending it again)';

const MAX_SINGLE_READ = 64 * 1024 * 1024;

/** Reads a transcript forward from the offset recorded before typing, looking for proof. */
class ProofWatcher {
  partial = false;
  stale = false;
  /** Our prompt is waiting in Claude's queue (not proof yet; carried between reads). */
  queued: ProofHit | null = null;
  /** Our queued prompt was put back into the input box at the Mac. */
  popped = false;
  private constructor(
    private readonly reader: TranscriptReader,
    private readonly session: Session,
    private readonly expected: ExpectedPrompt,
    private readonly chunk: number,
    private path: string | null,
    private cursor: number,
    /** Entries without timestamps don't count (the read did not start at a recorded offset). */
    private strict: boolean,
  ) {}

  static async open(reader: TranscriptReader, session: Session, expected: ExpectedPrompt, chunk: number): Promise<ProofWatcher> {
    const path = await locate(reader, session);
    if (path) {
      try {
        const size = await reader.size(path);
        return new ProofWatcher(reader, session, expected, chunk, path, size, false);
      } catch {
        // fall through: read it from the start when it can be sized
      }
    }
    // No transcript yet (a brand-new session writes it with its first prompt): read the whole file once it
    // appears; only timestamps can then tell new entries from old ones.
    return new ProofWatcher(reader, session, expected, chunk, null, 0, true);
  }

  get pathKnown(): boolean {
    return this.path !== null;
  }

  async check(notBeforeMs: number, nowIso: string): Promise<ProofHit | null> {
    if (!this.path) {
      this.path = await locate(this.reader, this.session);
      if (!this.path) return null;
      this.cursor = 0;
      this.strict = true;
    }
    let size: number;
    try {
      size = await this.reader.size(this.path);
    } catch {
      return null;
    }
    if (size < this.cursor) {
      // Rewritten or truncated: start over, trusting timestamps only.
      this.cursor = 0;
      this.strict = true;
    }
    while (this.cursor < size) {
      let r = await this.read(this.cursor, this.chunk);
      if (r && r.next <= this.cursor && size - this.cursor > this.chunk) {
        // One line longer than a chunk (an image, say): read it whole.
        r = await this.read(this.cursor, Math.min(size - this.cursor, MAX_SINGLE_READ));
      }
      if (!r || r.next <= this.cursor) break;
      const scan = scanForProof(r.entries, this.expected, { notBeforeMs, requireTimestamp: this.strict, nowIso }, this.queued);
      this.partial ||= scan.partial;
      this.stale ||= scan.stale;
      this.queued = scan.queued;
      if (scan.hit) {
        this.popped = false;
        return scan.hit;
      }
      if (scan.popped) this.popped = true;
      else if (scan.queued) this.popped = false;
      this.cursor = r.next;
    }
    return null;
  }

  private async read(offset: number, maxBytes: number) {
    try {
      return await this.reader.readFrom(this.path as string, offset, { maxBytes });
    } catch {
      return null;
    }
  }
}

async function locate(reader: TranscriptReader, s: Session): Promise<string | null> {
  try {
    const hint: { cwd?: string; configDir?: string; transcriptPath?: string } = { cwd: s.cwd, configDir: s.configDir };
    if (s.transcriptPath) hint.transcriptPath = s.transcriptPath;
    return await reader.pathFor(s.sid, hint);
  } catch {
    return null;
  }
}

/** Text with all whitespace removed: a screen wraps long lines anywhere, even inside a word. */
function compact(s: string): string {
  return s.replace(/\s+/gu, '');
}

const PASTE_COLLAPSE = /^\[Pastedtext#\d+[^\]]*\]$/iu;

/** What the input box holds before an Enter, compared with what we typed. */
export type BoxState = 'ours' | 'empty' | 'other' | 'unknown';

/**
 * ours: exactly our text (perhaps after the draft that was there before we
 * typed, or as Claude's "[Pasted text #1 ...]" collapse of it); empty: our
 * text has left the box (or only a placeholder shows); other: anything else,
 * such as the user typing; unknown: no input box on screen.
 */
export function classifyBox(box: string | null, expectedNorm: string, before: string): BoxState {
  if (box === null) return 'unknown';
  const now = compact(box);
  if (!now) return 'empty';
  const ours = compact(expectedNorm);
  const prior = compact(before);
  const rests = [now];
  if (prior && now.startsWith(prior)) rests.push(now.slice(prior.length));
  return rests.some((r) => r === ours || PASTE_COLLAPSE.test(r)) ? 'ours' : 'other';
}

const PASTED_RE = /^\[Pasted text/iu;

/** Box text that is (part of) an earlier prompt of ours, or one of Claude's collapsed pastes. */
function looksLikeLeftover(boxNorm: string, earlier: string): boolean {
  if (PASTED_RE.test(boxNorm)) return true;
  // The box holds the start of the earlier prompt (perhaps with more after it)...
  const head = earlier.slice(0, 30);
  if (head && boxNorm.includes(head)) return true;
  // ...or a good part of it. A short suggestion that happens to occur in it doesn't count.
  const boxHead = boxNorm.slice(0, 30);
  return boxHead.length >= 12 && earlier.includes(boxHead);
}

/** The box holds the start of the prompt (at least 12 characters of it) together with other text. */
function holdsPrompt(boxNorm: string, norm: string): boolean {
  const head = norm.slice(0, 30);
  return head.length >= 12 && compact(boxNorm).includes(compact(head));
}

interface Prepared {
  pane: Pane;
  session: Session;
  watcher: ProofWatcher;
  /** Our own unproven text from an earlier try is in the box: press Enter only. */
  skipType: boolean;
  /** The box text (squashed) just before typing. */
  boxBefore: string;
}

/** Steps 1-3 up to typing: preconditions, the recorded offset, and the draft rules. */
async function prepare(
  ctx: DaemonContext,
  deps: WriterDeps,
  t: SendTimings,
  run: SendRun,
  expected: ExpectedPrompt,
  notes: string[],
): Promise<Prepared | { refused: string }> {
  const { clock } = ctx;
  const sid = run.job().sid;
  const textHash = run.job().textHash;
  const checkAbort = () => {
    if (run.signal.aborted) throw new Aborted('stopping');
  };

  // --- 1. preconditions -----------------------------------------------------
  const found = lookupSession(ctx, sid);
  if (!found) return { refused: 'the session is no longer running' };
  const early = stateBlocker(ctx, deps.hooks, found);
  if (early) return { refused: early };
  const proc = await checkSessionProcess(ctx, found.pid, found.procStart);
  if (!proc.ok) return { refused: proc.reason };
  const ccw = await ccwCheck(deps.ccwLegacy, sid);
  if (ccw.blocker) return { refused: ccw.blocker };
  if (ccw.note) notes.push(ccw.note);
  checkAbort();

  const pane = await deps.terminal.findPane({ ...(found.tty ? { tty: found.tty } : {}), pid: found.pid, sid });
  if (!pane) return { refused: paneMissingReason(deps) };
  if (pane.id !== run.job().paneId) run.progress({ paneId: pane.id });

  const pc = await paneCheck(deps.terminal, pane, { screenLines: t.screenLines, requireInputBox: t.requireInputBox });
  if (!pc.ok) return { refused: pc.reason };
  // State may have moved on while the terminal was being read.
  const session = lookupSession(ctx, sid);
  if (!session) return { refused: 'the session is no longer running' };
  const late = stateBlocker(ctx, deps.hooks, session);
  if (late) return { refused: late };
  checkAbort();

  // --- 2. record the offset (before the box read, the last look before typing)
  const watcher = await ProofWatcher.open(deps.transcripts, session, expected, t.readChunkBytes);
  checkAbort();

  // --- 3. drafts, and never typing twice -------------------------------------
  const box = await deps.terminal.readInputBox(pane);
  if (!box.ok) return { refused: `Claude's input box couldn't be read (${box.reason})` };
  const boxNorm = squash(box.text);
  let mem = run.memory.get(pane.id);
  if (mem && clock.now() - mem.at > t.paneMemoryMs) {
    run.memory.delete(pane.id);
    mem = undefined;
  }
  let skipType = false;
  let boxBefore = boxNorm;
  if (!boxNorm) {
    run.memory.delete(pane.id);
  } else if (compact(boxNorm) === compact(expected.norm)) {
    // Decided from the box, not from memory (lost on a restart, expires): typing again would send it twice.
    skipType = true;
    boxBefore = '';
    notes.push('the prompt was still in the input box from an earlier try, so only Enter was pressed');
  } else if (mem && looksLikeLeftover(boxNorm, mem.norm)) {
    return { refused: 'an earlier prompt that was never proven sent may still be in the input box; clear it first' };
  } else if (PASTED_RE.test(boxNorm)) {
    return { refused: 'the input box holds collapsed pasted text, which may be an earlier copy of this prompt; clear it first' };
  } else if (holdsPrompt(boxNorm, expected.norm)) {
    return { refused: 'the input box already holds this prompt with other text; clear it first' };
  } else if (box.styled) {
    if (run.onDraft !== 'replace' || !deps.terminal.clearInput) {
      return { refused: 'the input box holds an unsent draft; send with onDraft "replace" to replace it' };
    }
    const cleared = await deps.terminal.clearInput(pane);
    const again = cleared.ok ? await deps.terminal.readInputBox(pane) : null;
    if (!again || !again.ok || squash(again.text)) return { refused: "the draft in the input box couldn't be cleared" };
    boxBefore = '';
    notes.push('the draft that was in the input box was replaced');
  }
  checkAbort();
  return { pane, session, watcher, skipType, boxBefore };
}

export async function performSend(
  ctx: DaemonContext,
  deps: WriterDeps,
  t: SendTimings,
  run: SendRun,
): Promise<SendOutcome> {
  const { clock } = ctx;
  const sid = run.job().sid;
  const textHash = run.job().textHash;
  const expected = expectedPrompt(run.text);
  const notes: string[] = [];

  run.progress({ stage: 'checking' });

  let prep: Prepared | { refused: string };
  try {
    prep = await prepare(ctx, deps, t, run, expected, notes);
  } catch (e) {
    if (isAbort(e)) return { stage: 'refused', reason: 'the daemon is stopping' };
    throw e;
  }
  if ('refused' in prep) return { stage: 'refused', reason: prep.refused };
  const { pane, watcher, skipType, boxBefore } = prep;

  const typingStartedAt = clock.now();
  const notBefore = typingStartedAt - t.proofSlackMs;
  /** When the prompt was first seen waiting in Claude's queue (null: not queued). */
  let queuedSince: number | null = null;
  const check = async (): Promise<ProofHit | null> => {
    const hit = await watcher.check(notBefore, clock.iso());
    if (hit || !watcher.queued) queuedSince = null;
    else queuedSince ??= clock.now();
    return hit;
  };
  const proven = (hit: ProofHit): SendOutcome => {
    run.memory.delete(pane.id);
    if (hit.doubled) notes.push('the prompt went out twice (an earlier copy was still in the input box)');
    else if (hit.merged) notes.push('text that was already in the input box went out with it');
    return { stage: hit.merged ? 'proven-merged' : 'proven', proof: hit.proof, notes };
  };
  const cleanup = makeCleanup(ctx, deps, t, pane, sid, expected, check, run.memory);
  const failed = (reason: string, withCleanup = true): SendOutcome =>
    withCleanup ? { stage: 'failed', reason, cleanup } : { stage: 'failed', reason };

  // --- 4. type, once ---------------------------------------------------------
  // Daemon state once more, right before typing: a card may have opened while the box was read.
  const current = lookupSession(ctx, sid);
  if (!current) return { stage: 'refused', reason: 'the session is no longer running' };
  const last = stateBlocker(ctx, deps.hooks, current);
  if (last) return { stage: 'refused', reason: last };
  // Remember the text before the result is known: a failed call may still have typed some of it.
  run.memory.set(pane.id, { textHash, norm: expected.norm, at: clock.now() });
  /** Why no (more) Enter is pressed though the keys may still arrive: only waiting for proof is left. */
  let stoppedBy: string | null = null;
  if (!skipType) {
    const typed = await deps.terminal.type(pane, run.text);
    if (!typed.ok) {
      if (!mayStillArrive(typed.code)) {
        return failed(`typing into the terminal failed (${typed.reason}); the text may be partly in the input box`);
      }
      stoppedBy = `typing into the terminal failed (${typed.reason})`;
    }
  }
  if (!stoppedBy) run.progress({ stage: 'typed' });

  // --- 5. Enter until proven -------------------------------------------------
  const maxEnters = expected.slash ? t.slashMaxEnters : t.maxEnters;
  const enterPhaseEnd = typingStartedAt + t.enterDelayMs + maxEnters * t.enterIntervalMs;
  let enters = 0;
  let leftBox = false;
  /** Poll for proof for `ms`; stops early once the prompt is in Claude's queue (or was popped back). */
  const pollFor = async (ms: number): Promise<ProofHit | null> => {
    const deadline = clock.now() + ms;
    for (;;) {
      const left = deadline - clock.now();
      if (left <= 0) return null;
      await clock.sleep(Math.min(t.proofPollMs, left), run.signal);
      const hit = await check();
      if (hit) return hit;
      if (watcher.queued || watcher.popped) return null;
    }
  };
  /** No more Enters: poll until `until` (longer while the prompt waits in Claude's queue), or until it is popped back. */
  const settle = async (until: number): Promise<ProofHit | null> => {
    for (;;) {
      if (watcher.popped) return null;
      const deadline = queuedSince === null ? until : Math.max(until, queuedSince + t.queuedProofMs);
      const left = deadline - clock.now();
      if (left <= 0) return null;
      await clock.sleep(Math.min(t.proofPollMs, left), run.signal);
      const hit = await check();
      if (hit) return hit;
    }
  };

  try {
    while (!stoppedBy) {
      const hit = await pollFor(enters === 0 ? t.enterDelayMs : t.enterIntervalMs);
      if (hit) return proven(hit);
      // In Claude's queue (or pulled back out of it at the Mac): another Enter could only submit the wrong thing.
      if (watcher.queued || watcher.popped) break;
      if (enters >= maxEnters) break;

      const r = await recheck(ctx, deps, t, pane, sid);
      if ('block' in r) {
        const lastLook = await check();
        if (lastLook) return proven(lastLook);
        return failed(`${r.block}, so Enter was not pressed; the prompt was not proven sent (it may still be in the input box)`);
      }
      const box = classifyBox(r.box, expected.norm, boxBefore);
      if (box === 'empty') {
        // Claude took it (or it was cleared): another Enter could only submit whatever is typed next.
        leftBox = true;
        break;
      }
      if (box === 'other') {
        const lastLook = await check();
        if (lastLook) return proven(lastLook);
        return failed(
          'the input box no longer holds just this prompt (someone may be typing there), so Enter was not pressed; the prompt was not proven sent',
        );
      }
      if (run.signal.aborted) throw new Aborted('stopping');
      const pressed = await deps.terminal.pressEnter(pane);
      if (!pressed.ok) {
        if (!mayStillArrive(pressed.code)) {
          const lastLook = await check();
          if (lastLook) return proven(lastLook);
          return failed(`pressing Enter failed (${pressed.reason}); the prompt was not proven sent`);
        }
        stoppedBy = `pressing Enter failed (${pressed.reason})`;
        break;
      }
      enters += 1;
      run.progress({ stage: 'enter', attempts: enters });
    }
    // No more Enters: wait for the proof only. A /compact that left the box is recorded once compaction is done.
    const compacting = leftBox && expected.slash?.name === '/compact';
    const until = compacting ? Math.max(enterPhaseEnd, typingStartedAt + t.compactProofMs) : enterPhaseEnd;
    const hit = await settle(until);
    if (hit) return proven(hit);
  } catch (e) {
    if (isAbort(e)) return failed('the daemon stopped before the prompt was proven sent', false);
    throw e;
  }

  const lastLook = await check();
  if (lastLook) return proven(lastLook);
  if (watcher.popped) {
    // The user pulled it back at the Mac: the text is theirs to edit now. No Ctrl-U, and the
    // pane memory stays, so a retry from the phone is refused while it is in the box.
    return failed(
      'the prompt was queued while Claude worked, then put back into the input box at the Mac (Esc or Up), so it was not sent; it is in the input box there now',
      false,
    );
  }
  if (watcher.queued) {
    notes.push("it was still waiting in Claude's queue when the daemon stopped watching");
    return proven(watcher.queued);
  }
  if (stoppedBy) return failed(`${stoppedBy}; ${NOT_PROVEN_YET}`);
  const presses = `${enters} press${enters === 1 ? '' : 'es'} of Enter`;
  let reason = leftBox
    ? `the prompt left the input box after ${presses}, but Claude's transcript never recorded it`
    : `Claude didn't record the prompt after ${presses}`;
  if (watcher.partial) reason += '; its transcript shows only the beginning of it';
  if (!watcher.pathKnown) reason += "; the session's transcript was not found";
  return failed(leftBox ? reason : `${reason} (it may still be in the input box)`);
}

function paneMissingReason(deps: WriterDeps): string {
  const why = (deps.terminal as { lastError?: { reason?: string } | null }).lastError?.reason;
  return why ? `no terminal tab found for this session (${why})` : 'no terminal tab found for this session';
}

/** Before each Enter: anything that makes another Enter wrong, else what the input box shows (null: no box on screen). */
async function recheck(
  ctx: DaemonContext,
  deps: WriterDeps,
  t: SendTimings,
  pane: Pane,
  sid: string,
): Promise<{ block: string } | { box: string | null }> {
  const s = lookupSession(ctx, sid);
  if (!s) return { block: 'the session ended' };
  const sb = stateBlocker(ctx, deps.hooks, s);
  if (sb) return { block: sb };
  if (!ctx.proc.isAlive(s.pid)) return { block: "the session's process exited" };
  const ccw = await ccwCheck(deps.ccwLegacy, sid);
  if (ccw.blocker) return { block: ccw.blocker };
  const pc = await paneCheck(deps.terminal, pane, { screenLines: t.screenLines, requireInputBox: t.requireInputBox });
  if (!pc.ok) return { block: pc.reason };
  return { box: pc.screen.inputBox ? pc.screen.inputBox.text : null };
}

/**
 * After a failure has been reported: clear our text from the box (the
 * backend's clearInput: End, then Ctrl-U), but only when the input line shows
 * exactly our text on one row, the box's bottom edge too, vim mode (if on) is
 * in INSERT, nothing modal is up, and the prompt still hasn't arrived. In vim
 * NORMAL mode End does nothing and Ctrl-U keeps the cursor's character, so
 * the appended Return would send the rest.
 */
function makeCleanup(
  ctx: DaemonContext,
  deps: WriterDeps,
  t: SendTimings,
  pane: Pane,
  sid: string,
  expected: ExpectedPrompt,
  check: () => Promise<ProofHit | null>,
  memory: Map<string, PaneMemory>,
): () => Promise<void> {
  return async () => {
    try {
      if (!deps.terminal.clearInput) return;
      const s = lookupSession(ctx, sid);
      if (!s || stateBlocker(ctx, deps.hooks, s)) return;
      const pc = await paneCheck(deps.terminal, pane, { screenLines: t.screenLines, requireInputBox: true });
      if (!pc.ok) return;
      const ib = pc.screen.inputBox;
      if (!ib || ib.rows !== 1 || !ib.closed || ib.text !== expected.norm) return;
      const vim = vimModeBelow(pc.screen.lines, ib);
      if (vim !== null && vim !== 'INSERT') return;
      if (await check()) {
        ctx.log.info('send proof arrived after the job had failed', { sid, paneId: pane.id });
        memory.delete(pane.id);
        return;
      }
      const cleared = await deps.terminal.clearInput(pane);
      if (!cleared.ok) return;
      const after = await deps.terminal.readInputBox(pane);
      if (after.ok && !squash(after.text)) memory.delete(pane.id);
      ctx.log.info('cleared an unsent prompt from the input box', { sid, paneId: pane.id });
    } catch (e) {
      ctx.log.warn('clearing the input box failed', { sid, error: e instanceof Error ? e.name : 'unknown' });
    }
  };
}
