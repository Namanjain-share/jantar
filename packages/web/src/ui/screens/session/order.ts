/**
 * Where a session sits among the others, for the header's "1 / 3" steppers
 * and the receipt's "Next: infra · Plan" triage (direction.md 5.1 "Start",
 * 5.2 "After answering").
 *
 *   needs-you session  steps through the needs-you queue, oldest first
 *   any other session  steps through the whole ledger (board order)
 */
import { boardOrder, needsYou, pendingFor, type PendingRequest, type Session, type State } from '@jantar/protocol';

/** When a session started needing you: its oldest open card, else when it began waiting. */
export function waitingSince(state: State, s: Session): string {
  const open = pendingFor(state, s.sid).find((p) => p.state === 'open' && p.kind !== 'subagent-info');
  return open?.createdAt ?? s.statusSince;
}

/** Sessions that need you, oldest first (the order "Start" and "Next" walk; boardOrder already sorts them so). */
export function needsQueue(state: State): Session[] {
  return boardOrder(state).filter((s) => needsYou(state, s.sid));
}

export interface Steps {
  list: Session[];
  index: number;
}

/** The list the steppers walk for `sid`, and its place in it (-1 when absent). */
export function stepsFor(state: State, sid: string): Steps {
  const list = needsYou(state, sid) ? needsQueue(state) : boardOrder(state);
  return { list, index: list.findIndex((s) => s.sid === sid) };
}

/** "Question", "Permission · Bash", "Plan", "Waiting in the terminal". */
export function kindWord(p: PendingRequest | undefined): string {
  if (!p) return 'Waiting in the terminal';
  switch (p.kind) {
    case 'question':
      return 'Question';
    case 'permission':
      return `Permission · ${p.tool}`;
    case 'plan':
      return 'Plan';
    case 'subagent-info':
      return 'Subagent waiting';
  }
}

/** The open card a needs-you session is waiting on (oldest first). */
export function openCard(state: State, sid: string): PendingRequest | undefined {
  return pendingFor(state, sid).find((p) => p.state === 'open' && p.kind !== 'subagent-info');
}

/** Compact time left: "12m", "2h02", "3d". */
export function inShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}d`;
}

/** A tool run's span: "40s", "2m04s", "1h02m". */
export function spanShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** "/Users/you/code/web-app" -> "~/code/web-app". */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

/** Claude's permission mode as words, or null for the default. */
export function modeWords(mode: string | undefined): string | null {
  switch (mode) {
    case undefined:
    case '':
    case 'default':
      return null;
    case 'acceptEdits':
      return 'auto-accept edits';
    case 'plan':
      return 'plan mode';
    case 'bypassPermissions':
      return 'bypass permissions';
    default:
      return `${mode} mode`;
  }
}
