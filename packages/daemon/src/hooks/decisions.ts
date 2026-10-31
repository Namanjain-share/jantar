/**
 * Decision encoder: an API decision body + the card it answers -> the exact
 * JSON a PermissionRequest hook prints for Claude Code (docs/hook-protocol.md
 * section 3). Pure; covered by exact-JSON tests because a wrong shape can
 * make Claude record an empty answer and stall the turn.
 *
 * Shapes (key order matters for the tests, not for Claude):
 *   allow once        {"behavior":"allow"}
 *   always allow      {"behavior":"allow","updatedPermissions":[<one of Claude's permission_suggestions>]}
 *   for this session  {"behavior":"allow","updatedPermissions":[<several of them, in index order>]}
 *   deny              {"behavior":"deny","message":"...","interrupt":false}
 *   chat about this   the same deny, with CLARIFY_MESSAGE (Claude's own words for that choice)
 *   question          {"behavior":"allow","updatedInput":{...original input,"answers":{"<question text>":"<label>"}}}
 *   plan              {"behavior":"allow","updatedInput":{...original input}}
 *   plan + mode       {"behavior":"allow","updatedInput":{...original input},"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}
 *                     (one of the card's planModes; "auto" only while HOOK_PLAN_AUTO is on and
 *                     once the session ran in auto mode)
 *
 * ExitPlanMode (like AskUserQuestion) requires user interaction: Claude Code
 * ignores an allow for it that carries no updatedInput and leaves its own
 * dialog open, so a plan approval always echoes the original tool_input.
 */
import {
  CONFIRM_MODES,
  PermissionRequestOutputSchema,
  type DecisionBody,
  type PendingKind,
  type PendingRequest,
  type PermissionDecision,
  type PermissionRequestOutput,
  type Question,
} from '@jantar/protocol';
import { isPlainObject } from './keys.js';

export const DEFAULT_DENY_MESSAGE = 'Denied from Jantar';
export const DEFAULT_QUESTION_DENY_MESSAGE = 'Declined from Jantar';
export const DEFAULT_PLAN_DENY_MESSAGE = 'Plan not approved from Jantar. Please revise the plan.';

/** A mode a plan card may approve with. */
export type PlanMode = NonNullable<PendingRequest['planModes']>[number];
/** What a plan card offers when it does not say: v0.4.1's two, both always valid. */
export const DEFAULT_PLAN_MODES: readonly PlanMode[] = Object.freeze<PlanMode[]>(['acceptEdits', 'default']);
/** A session that ran in auto mode: Claude's own first row is "Yes, and use auto mode". */
export const AUTO_PLAN_MODES: readonly PlanMode[] = Object.freeze<PlanMode[]>(['auto', 'default']);
/**
 * Whether plan cards may offer AUTO_PLAN_MODES at all. Off until spike SP8's
 * hook half passes on the real Mac. Claude's own "Yes, and use auto mode" row
 * applies no permission update: it checks the account's auto-mode gate,
 * marks auto mode active and drops broad allow rules (such as Bash(*))
 * before it switches. A hook's `setMode auto` only sets the mode, so the same
 * row answered from a card could leave the session more permissive than at
 * the Mac. SP8 must show that a tap leaves the same state as the Mac's row
 * (the mode line, and a broad rule set before plan mode no longer
 * auto-approving) before this turns on. The main session flips it.
 */
export const HOOK_PLAN_AUTO = false;
/** Indices one "for this session" answer may carry (DecisionBodySchema says the same). */
const MAX_SUGGESTIONS = 8;

/** What the encoder needs to know about a card. */
export interface DecisionCard {
  kind: PendingKind;
  tool: string;
  /** Claude's original tool_input (not the display copy). */
  input: unknown;
  /** Claude's permission_suggestions, verbatim. */
  suggestions: readonly unknown[];
  /** Parsed AskUserQuestion questions (undefined when the shape was not recognised). */
  questions?: readonly Question[];
  /** Plan cards: the modes the card offers (default DEFAULT_PLAN_MODES). */
  planModes?: readonly PlanMode[];
}

/** What is recorded about a decision (event stream and card history). No rule objects. */
export interface DecisionRecord {
  behavior: 'allow' | 'deny';
  suggestion?: number;
  /** v0.4.2: several suggestions at once (Claude's combined "for this session" row). */
  suggestions?: number[];
  mode?: 'acceptEdits' | 'default' | 'auto';
  interrupt?: boolean;
  /** Normalised answers, keyed by question text. */
  answers?: Record<string, string>;
  message?: string;
}

export type BuildDecisionResult =
  | { ok: true; output: PermissionRequestOutput; record: DecisionRecord }
  | { ok: false; code: 'invalid_request' | 'needs_confirm' | 'conflict'; message: string };

function fail(code: 'invalid_request' | 'needs_confirm' | 'conflict', message: string): BuildDecisionResult {
  return { ok: false, code, message };
}

function wrap(decision: PermissionDecision): PermissionRequestOutput {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function defaultDenyMessage(kind: PendingKind): string {
  if (kind === 'question') return DEFAULT_QUESTION_DENY_MESSAGE;
  if (kind === 'plan') return DEFAULT_PLAN_DENY_MESSAGE;
  return DEFAULT_DENY_MESSAGE;
}

/**
 * Choices that need a second tap (`confirm: true`): an "always allow" that
 * adds a Bash rule (or answers a Bash request), and any suggestion that would
 * switch the session to a mode CONFIRM_MODES holds (bypassPermissions, auto),
 * as the mode switch and the plan card's auto row do.
 */
export function suggestionNeedsConfirm(tool: string, suggestion: unknown): boolean {
  if (tool === 'Bash') return true;
  if (!isPlainObject(suggestion)) return false;
  if (suggestion.type === 'setMode' && (CONFIRM_MODES as readonly unknown[]).includes(suggestion.mode)) return true;
  const rules = suggestion.rules;
  if (Array.isArray(rules)) {
    for (const r of rules) if (isPlainObject(r) && r.toolName === 'Bash') return true;
  }
  return false;
}

/** Normalise the answers for an AskUserQuestion card, in question order. */
export function normaliseAnswers(
  questions: readonly Question[],
  answers: Record<string, string | string[]>,
): { ok: true; answers: Record<string, string> } | { ok: false; message: string } {
  const known = new Set(questions.map((q) => q.question));
  for (const key of Object.keys(answers)) {
    if (!known.has(key)) return { ok: false, message: `unknown question: ${JSON.stringify(key.slice(0, 80))}` };
  }
  const out: Record<string, string> = {};
  for (const q of questions) {
    if (Object.prototype.hasOwnProperty.call(out, q.question)) continue;
    const raw = Object.prototype.hasOwnProperty.call(answers, q.question) ? answers[q.question] : undefined;
    if (raw === undefined) return { ok: false, message: `answer every question (missing: ${JSON.stringify(q.question.slice(0, 80))})` };
    const parts = (Array.isArray(raw) ? raw : [raw]).map((s) => s.trim()).filter((s) => s.length > 0);
    if (parts.length === 0) return { ok: false, message: `empty answer for ${JSON.stringify(q.question.slice(0, 80))}` };
    if (parts.length > 1 && !q.multiSelect) {
      return { ok: false, message: `only one choice allowed for ${JSON.stringify(q.question.slice(0, 80))}` };
    }
    // Multi-select answers are the chosen labels joined with ","; "Other" is free text.
    out[q.question] = parts.join(',');
  }
  return { ok: true, answers: out };
}

/** Suggestion `i` of the card, or why it can't be used. */
function suggestionAt(card: DecisionCard, i: number): { type: string } | string {
  if (!Number.isInteger(i) || i < 0 || i >= card.suggestions.length) return `no suggestion ${i} on this card`;
  const suggestion = card.suggestions[i];
  if (!isPlainObject(suggestion) || typeof suggestion.type !== 'string') return `suggestion ${i} has an unexpected shape`;
  return suggestion as { type: string };
}

/**
 * Several suggestions at once: Claude's own "Yes, and allow access to … for
 * this session" row applies every session-scoped suggestion together. Each
 * entry is echoed verbatim, in index order, whatever order the body named
 * them in; one that needs a second tap makes the whole answer need it.
 */
function severalSuggestions(card: DecisionCard, body: DecisionBody, indices: readonly number[]): BuildDecisionResult {
  if (indices.length === 0 || indices.length > MAX_SUGGESTIONS) {
    return fail('invalid_request', `name one to ${MAX_SUGGESTIONS} suggestions`);
  }
  if (new Set(indices).size !== indices.length) return fail('invalid_request', 'each suggestion once');
  const order = [...indices].sort((a, b) => a - b);
  const entries: { type: string }[] = [];
  for (const i of order) {
    const s = suggestionAt(card, i);
    if (typeof s === 'string') return fail('invalid_request', s);
    entries.push(s);
  }
  if (body.confirm !== true && entries.some((s) => suggestionNeedsConfirm(card.tool, s))) {
    return fail('needs_confirm', 'always-allow for this request needs a second confirmation (confirm: true)');
  }
  return {
    ok: true,
    output: wrap({ behavior: 'allow', updatedPermissions: entries }),
    record: { behavior: 'allow', suggestions: order },
  };
}

/** Build Claude's decision JSON for `body` on `card`. Never throws on user input. */
export function buildDecision(card: DecisionCard, body: DecisionBody): BuildDecisionResult {
  if (card.kind === 'subagent-info') {
    return fail('conflict', 'subagent requests are answered from the dialog in the app, or at the Mac');
  }
  if (body.suggestion !== undefined && body.suggestions !== undefined) {
    return fail('invalid_request', 'send suggestion or suggestions, not both');
  }

  if (body.behavior === 'deny') {
    if (body.suggestion !== undefined || body.suggestions !== undefined || body.answers !== undefined) {
      return fail('invalid_request', 'suggestion and answers only apply to allow');
    }
    if (body.mode !== undefined) return fail('invalid_request', 'mode only applies to approving a plan');
    const message = body.message?.trim() ? body.message.trim() : defaultDenyMessage(card.kind);
    const interrupt = body.interrupt === true;
    const record: DecisionRecord = { behavior: 'deny', interrupt };
    if (body.message?.trim()) record.message = message;
    return { ok: true, output: wrap({ behavior: 'deny', message, interrupt }), record };
  }

  // allow
  if (body.interrupt !== undefined) return fail('invalid_request', 'interrupt only applies to deny');
  if (body.message !== undefined) return fail('invalid_request', 'message only applies to deny');

  switch (card.kind) {
    case 'permission': {
      if (body.answers !== undefined) return fail('invalid_request', 'answers only apply to questions');
      if (body.mode !== undefined) return fail('invalid_request', 'mode only applies to approving a plan');
      if (body.suggestions !== undefined) return severalSuggestions(card, body, body.suggestions);
      if (body.suggestion === undefined) {
        return { ok: true, output: wrap({ behavior: 'allow' }), record: { behavior: 'allow' } };
      }
      const i = body.suggestion;
      const suggestion = suggestionAt(card, i);
      if (typeof suggestion === 'string') return fail('invalid_request', suggestion);
      if (suggestionNeedsConfirm(card.tool, suggestion) && body.confirm !== true) {
        return fail('needs_confirm', 'always-allow for this request needs a second confirmation (confirm: true)');
      }
      return {
        ok: true,
        // Echo Claude's own suggestion verbatim; clients never send rule objects.
        output: wrap({ behavior: 'allow', updatedPermissions: [suggestion] }),
        record: { behavior: 'allow', suggestion: i },
      };
    }

    case 'question': {
      if (body.suggestion !== undefined || body.suggestions !== undefined) {
        return fail('invalid_request', 'suggestions do not apply to questions');
      }
      if (body.mode !== undefined) return fail('invalid_request', 'mode only applies to approving a plan');
      // The bridge holds no such question (the screen path answers it); an
      // open card would shut that path, so this one is left to the Mac.
      if (!card.questions || !isPlainObject(card.input)) {
        return fail('invalid_request', 'this question has an unrecognised format; answer it at the Mac');
      }
      if (!body.answers) return fail('invalid_request', 'answers are required');
      const norm = normaliseAnswers(card.questions, body.answers);
      if (!norm.ok) return fail('invalid_request', norm.message);
      const updatedInput: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(card.input)) if (k !== 'answers') updatedInput[k] = v;
      updatedInput.answers = norm.answers;
      return {
        ok: true,
        output: wrap({ behavior: 'allow', updatedInput }),
        record: { behavior: 'allow', answers: norm.answers },
      };
    }

    case 'plan': {
      if (body.suggestion !== undefined || body.suggestions !== undefined) {
        return fail('invalid_request', 'use mode to change the permission mode of a plan');
      }
      if (body.answers !== undefined) return fail('invalid_request', 'answers only apply to questions');
      // As for questions: the bridge holds no such plan.
      if (!isPlainObject(card.input)) {
        return fail('invalid_request', 'this plan has an unrecognised format; answer it at the Mac');
      }
      const updatedInput: Record<string, unknown> = { ...card.input };
      if (body.mode === undefined) {
        return { ok: true, output: wrap({ behavior: 'allow', updatedInput }), record: { behavior: 'allow' } };
      }
      // Only the rows the card shows (an empty list shows the default two, as
      // on the phone): "auto" only where the bridge offered it (HOOK_PLAN_AUTO).
      const offered = card.planModes?.length ? card.planModes : DEFAULT_PLAN_MODES;
      if (!offered.includes(body.mode)) {
        return fail('invalid_request', 'this plan card does not offer that mode');
      }
      if (body.mode === 'auto' && body.confirm !== true) {
        return fail('needs_confirm', 'approving with auto mode needs a second confirmation (confirm: true)');
      }
      return {
        ok: true,
        output: wrap({
          behavior: 'allow',
          updatedInput,
          updatedPermissions: [{ type: 'setMode', mode: body.mode, destination: 'session' }],
        }),
        record: { behavior: 'allow', mode: body.mode },
      };
    }
  }
}

/**
 * Audit params for a decision: which choice (indices, mode, counts), never
 * free text, a question, a rule object or a path.
 */
export function redactedDecision(r: DecisionRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { behavior: r.behavior };
  if (r.suggestion !== undefined) out.suggestion = r.suggestion;
  if (r.suggestions !== undefined) out.suggestions = r.suggestions;
  if (r.mode !== undefined) out.mode = r.mode;
  if (r.interrupt !== undefined) out.interrupt = r.interrupt;
  if (r.answers) out.answered = Object.keys(r.answers).length;
  if (r.message) out.hasMessage = true;
  return out;
}

/** Reply line for the hook client: `{"v":1,"output":...|null}` plus a newline. */
export function replyLine(output: PermissionRequestOutput | null): string {
  if (output !== null) PermissionRequestOutputSchema.parse(output); // programming-error guard
  return `${JSON.stringify({ v: 1, output })}\n`;
}
