/**
 * Words for a launch's stages (spec 5.3.4), shared by the receipt and the
 * Board's ghost rows. Every stage gets its own word, so the receipt and the
 * ghost rows tell the stages apart without colour (direction.md rule 16).
 * Pure functions: the current time is always passed in.
 */
import { LAUNCH_FINAL_STAGES, type LaunchJob, type LaunchStage } from '@jantar/protocol';
import { accountId } from '../../../lib/format.js';

/** Stages that end a launch badly: the receipt shows the reason and one way out. */
export const FAILED_STAGES: readonly LaunchStage[] = ['failed', 'refused', 'stalled', 'ready-prompt-failed'];

/** Stages after which the session exists and can be opened. */
export const OPENABLE_STAGES: readonly LaunchStage[] = ['ready', 'prompting', 'done', 'done-no-prompt', 'ready-prompt-failed'];

export const isFinal = (stage: LaunchStage) => LAUNCH_FINAL_STAGES.includes(stage);
export const isFailed = (stage: LaunchStage) => FAILED_STAGES.includes(stage);

/** The account a launch runs on: the one its config dir showed, else the one asked for. */
export function launchAccount(job: Pick<LaunchJob, 'account' | 'actualAccount'>): string {
  return accountId(job.actualAccount ?? job.account);
}

/**
 * The receipt's stage word for one step. `current` is the step the launch
 * is on now (not final): it reads as going on ("Opening a window"), the
 * steps behind it as done ("Opened a window"). With one Claude login
 * (`single`) no account is named.
 */
export function stepWord(stage: LaunchStage, job: Pick<LaunchJob, 'account' | 'actualAccount'>, current: boolean, single = false): string {
  switch (stage) {
    case 'queued':
      return current ? 'Checking' : 'Checked';
    case 'opening':
      return current ? 'Opening a window' : 'Opened a window';
    case 'starting':
      if (single) return current ? 'Starting Claude' : 'Started Claude';
      return `${current ? 'Starting' : 'Started'} on ${launchAccount(job)}`;
    case 'dialog':
      return 'Claude asks';
    case 'ready':
      return 'Ready';
    case 'prompting':
      return current ? 'Sending the first prompt' : 'Typed the first prompt';
    case 'done':
      return 'First prompt';
    case 'done-no-prompt':
      return 'Done';
    case 'ready-prompt-failed':
      return 'First prompt not delivered';
    case 'failed':
      return "Didn't start";
    case 'refused':
      return 'Refused';
    case 'stalled':
      return 'Stalled';
  }
}

/** Line 2 of a ghost row, after the account: "opened a window", "Claude asks: Trust this folder?". */
export function ghostWord(job: Pick<LaunchJob, 'stage' | 'dialog'>): string {
  switch (job.stage) {
    case 'queued':
      return 'checking';
    case 'opening':
      return 'opening a window';
    case 'starting':
      return 'starting Claude';
    case 'dialog':
      return job.dialog ? `Claude asks: ${job.dialog.title}` : 'Claude asks';
    case 'ready':
      return 'ready';
    case 'prompting':
      return 'sending the first prompt';
    default:
      return stepWord(job.stage, { account: 0 }, false).toLowerCase();
  }
}

/** The folder's own name from its display path: "~/Desktop/work/foo" -> "foo". */
export function folderName(display: string): string {
  const parts = display.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? display;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "14:02:11", 24-hour and locale-free like every clock in the app. */
export function hms(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "12s", "3m", "1h05": how long a launch has been going. */
export function elapsed(fromIso: string, now: number): string {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}`;
}
