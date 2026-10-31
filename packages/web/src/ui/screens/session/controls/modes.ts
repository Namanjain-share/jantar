/**
 * Permission modes as the phone names them (the controls addendum), and the
 * modes a session turned out not to have.
 *
 * The order is Claude's Shift+Tab cycle: Manual, Accept edits, Plan, then the
 * optional ones (bypass only when the session was started with it, auto when
 * it is enabled). Which optional ones a session has is learned the only way
 * there is: the daemon tries and answers 409 mode_unavailable. That answer
 * is kept for this page's life, per session, so the list greys the mode with
 * the reason (never the mode the session reports it is in).
 */
import { CONFIRM_MODES, type PermissionModeName } from '@jantar/protocol';

export const MODE_CHOICES: readonly PermissionModeName[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];

/** The chip's words for a mode (as Claude's status line says it, in sentence case). */
const LABEL: Readonly<Record<string, string>> = {
  default: 'Manual',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass permissions',
  auto: 'Auto',
  dontAsk: "Don't ask",
};

/** One line on what each mode does, under its name in the list. */
export const MODE_HINT: Readonly<Record<PermissionModeName, string>> = {
  default: 'Asks before each edit and command',
  acceptEdits: 'Edits files without asking',
  plan: 'Reads and plans, changes nothing',
  bypassPermissions: 'Never asks',
  auto: 'Claude decides when to ask',
};

export const UNKNOWN_MODE = 'Mode not known';

/**
 * Modes in which Claude runs commands without asking: switching a running
 * session to one takes the same 2-second hold and sentence as starting one
 * that way (U7), never a single tap in the list.
 */
export const NO_ASK_MODES: ReadonlySet<PermissionModeName> = new Set(CONFIRM_MODES);
export const NO_ASK_SENTENCE = "Claude won't ask before running commands in this session.";
export const NO_ASK_HOLD_MS = 2000;

export function modeLabel(mode: string | undefined): string {
  return (mode !== undefined && Object.hasOwn(LABEL, mode) ? LABEL[mode] : undefined) ?? UNKNOWN_MODE;
}

export const NOT_IN_CYCLE = "Not in this session's cycle";

const unavailable = new Map<string, Map<PermissionModeName, string>>();
const NONE: ReadonlyMap<PermissionModeName, string> = new Map();

/** Modes the daemon said this session does not have, with why (never the mode it reports now). */
export function unavailableModes(sid: string, current: string | undefined): ReadonlyMap<PermissionModeName, string> {
  const m = unavailable.get(sid);
  if (!m || m.size === 0) return NONE;
  if (current === undefined || !m.has(current as PermissionModeName)) return m;
  const rest = new Map(m);
  rest.delete(current as PermissionModeName);
  return rest;
}

export function markUnavailable(sid: string, mode: PermissionModeName): void {
  let m = unavailable.get(sid);
  if (!m) unavailable.set(sid, (m = new Map()));
  m.set(mode, NOT_IN_CYCLE);
}

/** Tests: forget everything learned. */
export function resetUnavailable(): void {
  unavailable.clear();
}
