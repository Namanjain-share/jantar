/**
 * Work package C: the hooks bridge.
 *
 * - `createHooksBridge` (Factories['hooks']): the hooks socket server, the
 *   pending-card map and hook-derived session status.
 * - installer.ts: `installHooks`, `uninstallHooks`, `hooksStatus` against a
 *   given Claude settings.json (used by `jantar hooks`).
 * - cli.ts: `runHooksCommand`, the body of `jantar hooks`.
 */
import type { DaemonContext, Factories, HooksBridge } from '../contracts.js';
import { HooksBridgeImpl, type HooksBridgeDeps, type HooksBridgeOptions } from './bridge.js';

/**
 * Factories['hooks']. The optional third argument exists for tests and
 * tuning; the integration step calls it with two arguments.
 */
export const createHooksBridge = ((ctx: DaemonContext, deps: HooksBridgeDeps, opts?: HooksBridgeOptions): HooksBridge =>
  new HooksBridgeImpl(ctx, deps, opts)) satisfies Factories['hooks'];

export { HooksBridgeImpl, type HooksBridgeDeps, type HooksBridgeOptions } from './bridge.js';
export {
  buildDecision,
  normaliseAnswers,
  replyLine,
  suggestionNeedsConfirm,
  DEFAULT_DENY_MESSAGE,
  DEFAULT_PLAN_DENY_MESSAGE,
  DEFAULT_QUESTION_DENY_MESSAGE,
  type BuildDecisionResult,
  type DecisionCard,
  type DecisionRecord,
} from './decisions.js';
export { cardKey, kindForTool, isSubagentPayload, toolSummary } from './keys.js';
export { compareKeys, ReorderBuffer, type OrderKey } from './ordering.js';
export { statusForEvent, notificationKind } from './status-map.js';
export { MAX_HOOK_LINE_BYTES } from './socket.js';
