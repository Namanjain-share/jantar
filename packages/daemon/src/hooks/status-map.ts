/**
 * Hook event -> session status (docs/hook-protocol.md section 7):
 *
 * | Event | Status |
 * |---|---|
 * | SessionStart | idle |
 * | UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied | working |
 * | PermissionRequest (main conversation, card opened) | waiting (permission / question / plan) |
 * | Notification permission_prompt | waiting |
 * | Notification idle_prompt, Stop, StopFailure | idle |
 * | PreCompact | compacting |
 * | SessionEnd | ended |
 *
 * PermissionRequest is handled by the bridge itself (it knows whether a card
 * was opened); SubagentStart / SubagentStop only move the subagent counter.
 */
import type { HookPayload, SessionStatus } from '@jantar/protocol';

export interface HookStatus {
  status: SessionStatus;
  waitingFor?: string;
}

/** Notification kinds. Older Claude builds send only `message`, so fall back to its wording. */
export function notificationKind(p: Pick<HookPayload, 'notification_type' | 'message'>): 'permission' | 'idle' | null {
  const t = p.notification_type;
  if (t === 'permission_prompt') return 'permission';
  if (t === 'idle_prompt') return 'idle';
  if (t) return null;
  const m = (p.message ?? '').toLowerCase();
  if (m.includes('needs your permission')) return 'permission';
  if (m.includes('waiting for your input')) return 'idle';
  return null;
}

export function statusForEvent(p: HookPayload): HookStatus | null {
  switch (p.hook_event_name) {
    case 'SessionStart':
      return { status: 'idle' };
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      return { status: 'working' };
    case 'Notification': {
      const k = notificationKind(p);
      if (k === 'permission') return { status: 'waiting', waitingFor: 'permission' };
      if (k === 'idle') return { status: 'idle' };
      return null;
    }
    case 'Stop':
    case 'StopFailure':
      return { status: 'idle' };
    case 'PreCompact':
      return { status: 'compacting' };
    case 'SessionEnd':
      return { status: 'ended' };
    default:
      return null;
  }
}
