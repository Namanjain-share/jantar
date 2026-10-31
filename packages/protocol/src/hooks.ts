/**
 * Hook wire format between `jantar-hook` and the daemon's hooks socket, plus
 * the decision output Claude Code accepts from a PermissionRequest hook.
 * The full description is docs/hook-protocol.md; keep the two in step.
 *
 * Payload schemas are loose on purpose: Claude Code adds fields over time and
 * the daemon must keep working when it does.
 */
import { z } from 'zod';
import { HOOK_TAG } from './constants.js';

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** Only this event is registered as blocking (the hook waits for a reply). */
export const BLOCKING_HOOK_EVENTS: readonly HookEventName[] = ['PermissionRequest'];

/** Metadata the hook client adds under `_jantar`. */
export const HookTagSchema = z.looseObject({
  v: z.literal(1),
  /** Wall clock, epoch milliseconds, when the hook process started. */
  ts: z.number(),
  /** Monotonic nanoseconds (process.hrtime.bigint()) as a decimal string; orders events on one machine. */
  mono: z.string().regex(/^\d+$/).optional(),
  /** Parent pid: the claude process (or a shim directly under it). */
  ppid: z.number().int(),
  /** True when the hook was registered as blocking and waits for a decision. */
  wait: z.boolean(),
  termProgram: z.string().optional(),
  itermSessionId: z.string().optional(),
  tmuxPane: z.string().optional(),
  /** Identifies the cswap account directly (cswap sets it per profile). */
  claudeConfigDir: z.string().optional(),
  ghostty: z.boolean().optional(),
  hookVersion: z.string().optional(),
});
export type HookTag = z.infer<typeof HookTagSchema>;

/** One hook event as forwarded to the daemon: Claude's stdin JSON plus `_jantar`. */
export const HookPayloadSchema = z.looseObject({
  hook_event_name: z.string().min(1),
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  tool_response: z.unknown().optional(),
  permission_suggestions: z.array(z.unknown()).optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  prompt: z.string().optional(),
  notification_type: z.string().optional(),
  message: z.string().optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  error: z.unknown().optional(),
  is_interrupt: z.boolean().optional(),
  [HOOK_TAG]: HookTagSchema,
});
export type HookPayload = z.infer<typeof HookPayloadSchema>;

// ---------------------------------------------------------------------------
// Claude Code decision output (what the hook prints on stdout)

export const PermissionDestinationSchema = z.enum([
  'session',
  'localSettings',
  'projectSettings',
  'userSettings',
]);

export const PermissionRuleSchema = z.looseObject({
  toolName: z.string().min(1),
  ruleContent: z.string().optional(),
});

/** One `updatedPermissions` entry (addRules, setMode, ...). Loose: Claude owns this shape. */
export const PermissionUpdateSchema = z.looseObject({
  type: z.string().min(1),
  destination: PermissionDestinationSchema.optional(),
});
export type PermissionUpdate = z.infer<typeof PermissionUpdateSchema>;

export const PermissionDecisionSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    updatedPermissions: z.array(PermissionUpdateSchema).optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string().optional(),
    interrupt: z.boolean().optional(),
  }),
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionRequestOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('PermissionRequest'),
    decision: PermissionDecisionSchema,
  }),
});
export type PermissionRequestOutput = z.infer<typeof PermissionRequestOutputSchema>;

/**
 * The daemon's reply line on the hooks socket (blocking hooks only).
 * `output: null` means "no decision": the hook prints nothing and Claude's own
 * dialog stays in charge. A closed socket without a reply means the same.
 */
export const HookReplySchema = z.object({
  v: z.literal(1),
  output: z.record(z.string(), z.unknown()).nullable(),
});
export type HookReply = z.infer<typeof HookReplySchema>;
