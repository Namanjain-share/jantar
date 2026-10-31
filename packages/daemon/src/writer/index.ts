/**
 * Writer factory (work package D): send-with-proof, one queue per pane.
 *
 * `createWriter` is the `Factories['writer']` entry wired in main.ts.
 * `createWriterWith` takes options as well (timings for tests, or notifiers
 * to alert directly instead of through the notification router).
 */
import type { DaemonContext, Factories } from '../contracts.js';
import type { WriterDeps } from './send.js';
import { SendWriter, type WriterOptions } from './writer.js';

export const createWriter: Factories['writer'] = (ctx, deps) => new SendWriter(ctx, deps);

export function createWriterWith(ctx: DaemonContext, deps: WriterDeps, opts: WriterOptions = {}): SendWriter {
  return new SendWriter(ctx, deps, opts);
}

export { SendWriter, IDEMPOTENCY_KV_KEY, isFinalStage, type WriterOptions } from './writer.js';
export { DEFAULT_TIMINGS, performSend, type PaneMemory, type SendOutcome, type SendTimings, type WriterDeps } from './send.js';
export { sendFailedNotification } from './notification.js';
export {
  PROOF_SLACK_MS,
  compareCandidate,
  contentText,
  promptCandidate,
  scanForProof,
  type Comparison,
  type ProofHit,
  type ProofOptions,
  type ProofScan,
  type PromptCandidate,
} from './proof.js';
export {
  MOVING_STEPS,
  ccwCheck,
  lookupSession,
  openCards,
  paneCheck,
  stateBlocker,
  type CcwCheck,
  type PaneCheck,
} from './preconditions.js';
export { checkSessionProcess, parsePsLstartUtc, procStartCandidates, PROC_START_TOLERANCE_MS } from './proc-start.js';
export { MAX_PROMPT_CHARS, expectedPrompt, parseSlashCommand, validatePromptText, type ExpectedPrompt, type SlashCommand } from './text.js';
export { KeyedQueue } from './queue.js';
