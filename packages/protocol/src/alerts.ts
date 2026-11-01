/**
 * v0.5.3 alerts: every push belongs to one of five groups, and each group
 * has a tone the phone plays (made in code) and one fixed phrase it may
 * speak, chosen per device on the phone, only while Jantar is open on
 * screen. The lock screen always plays the iPhone's own alert sound.
 *
 * The urgent group is not a NotifyKind: it is a `permission` push that
 * carries a `deadline` (Claude's 2-minute auto-block countdown).
 */
import { z } from 'zod';
import type { NotifyKind } from './models.js';

/** v0.5.3: alerts sound per group, not per kind. The urgent group is a permission push with a deadline. */
export const AlertGroupSchema = z.enum(['urgent', 'needs', 'done', 'care', 'problem']);
export type AlertGroup = z.infer<typeof AlertGroupSchema>;
export const ALERT_GROUPS: readonly AlertGroup[] = AlertGroupSchema.options;
export const ALERT_GROUP_OF: Readonly<Record<NotifyKind, AlertGroup>> = {
  permission: 'needs',
  question: 'needs',
  plan: 'needs',
  reminder: 'needs',
  launch: 'needs',
  done: 'done',
  med: 'care',
  life: 'care',
  'send-failed': 'problem',
  blocked: 'problem',
  limit: 'problem',
  error: 'problem',
  usage: 'problem',
  security: 'problem',
};
export function alertGroupOf(kind: NotifyKind, deadline?: string): AlertGroup {
  return deadline !== undefined && kind === 'permission' ? 'urgent' : ALERT_GROUP_OF[kind];
}
export const AlertToneSchema = z.enum(['alarm', 'ding', 'success', 'bell', 'low', 'none']);
export type AlertTone = z.infer<typeof AlertToneSchema>;
export const DEFAULT_TONES: Readonly<Record<AlertGroup, AlertTone>> = { urgent: 'alarm', needs: 'ding', done: 'success', care: 'bell', problem: 'low' };
/** The only words Jantar speaks: never a prompt, a folder, a medicine or a name. */
export const ALERT_PHRASES: Readonly<Record<AlertGroup, string>> = {
  urgent: 'Answer soon',
  needs: 'Claude needs you',
  done: 'Done',
  care: 'Reminder',
  problem: 'Something needs a look',
};
/** Under this many seconds left on Claude's countdown no urgent alert is sent. */
export const URGENT_MIN_S = 20;
/** The one repeat goes out with this many seconds left, if the same ask is still on screen. */
export const URGENT_REPEAT_AT_S = 60;
/** POST /v1/notify/test (the Mac only: jantar notify test [group]). */
export const NotifyTestBodySchema = z.strictObject({ group: AlertGroupSchema });
export type NotifyTestBody = z.infer<typeof NotifyTestBodySchema>;
export const NotifyTestResponseSchema = z.object({ delivered: z.number().int(), failed: z.number().int() });
export type NotifyTestResponse = z.infer<typeof NotifyTestResponseSchema>;
