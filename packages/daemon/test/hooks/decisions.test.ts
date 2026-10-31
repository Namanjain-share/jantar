/**
 * Acceptance gate 2: the exact JSON a PermissionRequest hook prints for each
 * decision shape (docs/hook-protocol.md section 3).
 */
import { PermissionRequestOutputSchema, type DecisionBody, type Question } from '@jantar/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildDecision,
  replyLine,
  suggestionNeedsConfirm,
  type BuildDecisionResult,
  type DecisionCard,
} from '../../src/hooks/decisions.js';

const BASH_SUGGESTION = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  behavior: 'allow',
  destination: 'session',
};
const EDIT_SUGGESTION = {
  type: 'addRules',
  rules: [{ toolName: 'Edit', ruleContent: 'src/**' }],
  behavior: 'allow',
  destination: 'localSettings',
};

const QUESTIONS: Question[] = [
  {
    question: 'Which database?',
    header: 'Database',
    options: [
      { label: 'Postgres', description: 'Relational, hosted' },
      { label: 'SQLite', description: 'One file' },
    ],
    multiSelect: false,
  },
  {
    question: 'Which features?',
    header: 'Features',
    options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
    multiSelect: true,
  },
];

const bash: DecisionCard = { kind: 'permission', tool: 'Bash', input: { command: 'npm test' }, suggestions: [BASH_SUGGESTION] };
const edit: DecisionCard = { kind: 'permission', tool: 'Edit', input: { file_path: '/synthetic/a.ts' }, suggestions: [EDIT_SUGGESTION] };
const question: DecisionCard = {
  kind: 'question',
  tool: 'AskUserQuestion',
  input: { questions: QUESTIONS },
  suggestions: [],
  questions: QUESTIONS,
};
const plan: DecisionCard = { kind: 'plan', tool: 'ExitPlanMode', input: { plan: '1. Do it' }, suggestions: [] };

function json(r: BuildDecisionResult): string {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  PermissionRequestOutputSchema.parse(r.output);
  return JSON.stringify(r.output);
}

function err(r: BuildDecisionResult): string {
  if (r.ok) throw new Error('expected a refusal');
  return r.code;
}

const d = (b: DecisionBody) => b;

describe('decision JSON (exact)', () => {
  it('allow once', () => {
    expect(json(buildDecision(bash, d({ behavior: 'allow' })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
  });

  it('always allow echoes the chosen suggestion verbatim', () => {
    expect(json(buildDecision(edit, d({ behavior: 'allow', suggestion: 0 })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Edit","ruleContent":"src/**"}],"behavior":"allow","destination":"localSettings"}]}}}',
    );
  });

  it('always allow on Bash needs a second tap, then matches the documented shape', () => {
    const first = buildDecision(bash, d({ behavior: 'allow', suggestion: 0 }));
    expect(err(first)).toBe('needs_confirm');
    expect(json(buildDecision(bash, d({ behavior: 'allow', suggestion: 0, confirm: true })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test:*"}],"behavior":"allow","destination":"session"}]}}}',
    );
    // allow once on Bash needs no confirmation
    expect(buildDecision(bash, d({ behavior: 'allow' })).ok).toBe(true);
  });

  it('deny with the default message', () => {
    expect(json(buildDecision(bash, d({ behavior: 'deny' })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Jantar","interrupt":false}}}',
    );
  });

  it('deny with a message and interrupt', () => {
    expect(json(buildDecision(bash, d({ behavior: 'deny', message: '  Not on main, please  ', interrupt: true })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Not on main, please","interrupt":true}}}',
    );
  });

  it('AskUserQuestion: answers keyed by question text, in question order, multi-select joined with ","', () => {
    const r = buildDecision(question, d({ behavior: 'allow', answers: { 'Which features?': ['Auth', 'Billing'], 'Which database?': 'Postgres' } }));
    const expected = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'Which database?': 'Postgres', 'Which features?': 'Auth,Billing' } } },
      },
    });
    expect(json(r)).toBe(expected);
    expect(json(r)).toContain('"answers":{"Which database?":"Postgres","Which features?":"Auth,Billing"}');
    // the original questions are echoed unchanged
    expect(json(r)).toContain(JSON.stringify(QUESTIONS));
  });

  it('AskUserQuestion: "Other" is free text, kept as typed (trimmed)', () => {
    const r = buildDecision(question, d({ behavior: 'allow', answers: { 'Which database?': ' CockroachDB, probably ', 'Which features?': ['Search'] } }));
    expect(json(r)).toContain('"answers":{"Which database?":"CockroachDB, probably","Which features?":"Search"}');
  });

  it('AskUserQuestion: keeps other input keys and replaces a stale answers key', () => {
    const card: DecisionCard = { ...question, input: { questions: QUESTIONS, answers: { old: 'x' }, metadata: { source: 'synthetic' } } };
    const r = buildDecision(card, d({ behavior: 'allow', answers: { 'Which database?': 'SQLite', 'Which features?': 'Auth' } }));
    const out = JSON.parse(json(r));
    expect(Object.keys(out.hookSpecificOutput.decision.updatedInput)).toEqual(['questions', 'metadata', 'answers']);
    expect(out.hookSpecificOutput.decision.updatedInput.answers).toEqual({ 'Which database?': 'SQLite', 'Which features?': 'Auth' });
  });

  it('AskUserQuestion: declining is a deny', () => {
    expect(json(buildDecision(question, d({ behavior: 'deny' })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Declined from Jantar","interrupt":false}}}',
    );
  });

  it('ExitPlanMode: approve, approve with a mode switch, ask for a revision', () => {
    // ExitPlanMode requires user interaction: Claude ignores an allow without updatedInput, so it echoes the plan input.
    expect(json(buildDecision(plan, d({ behavior: 'allow' })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"1. Do it"}}}}',
    );
    expect(json(buildDecision(plan, d({ behavior: 'allow', mode: 'acceptEdits' })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"1. Do it"},"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}',
    );
    expect(json(buildDecision(plan, d({ behavior: 'allow', mode: 'default' })))).toContain('"mode":"default"');
    expect(json(buildDecision(plan, d({ behavior: 'deny', message: 'Split step 2 in two.' })))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Split step 2 in two.","interrupt":false}}}',
    );
    expect(json(buildDecision(plan, d({ behavior: 'deny' })))).toContain('"message":"Plan not approved from Jantar. Please revise the plan."');
  });

  it('ExitPlanMode: updatedInput is the original tool_input (every key), and a plan without an object input is refused', () => {
    const card: DecisionCard = { ...plan, input: { plan: '1. Do it', planFilePath: '/synthetic/plan.md' } };
    const out = JSON.parse(json(buildDecision(card, d({ behavior: 'allow' }))));
    expect(out.hookSpecificOutput.decision.updatedInput).toEqual({ plan: '1. Do it', planFilePath: '/synthetic/plan.md' });
    const odd = buildDecision({ ...plan, input: 'not an object' }, d({ behavior: 'allow' }));
    expect(odd).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('the reply line wraps the output, or null for "no decision"', () => {
    const r = buildDecision(bash, d({ behavior: 'allow' }));
    if (!r.ok) throw new Error('unexpected');
    expect(replyLine(r.output)).toBe('{"v":1,"output":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}}\n');
    expect(replyLine(null)).toBe('{"v":1,"output":null}\n');
  });
});

describe('decision records (what the event stream and audit see)', () => {
  it('records the choice, not rule objects', () => {
    const r = buildDecision(bash, d({ behavior: 'allow', suggestion: 0, confirm: true }));
    expect(r.ok && r.record).toEqual({ behavior: 'allow', suggestion: 0 });
    const q = buildDecision(question, d({ behavior: 'allow', answers: { 'Which database?': 'Postgres', 'Which features?': ['Auth'] } }));
    expect(q.ok && q.record).toEqual({ behavior: 'allow', answers: { 'Which database?': 'Postgres', 'Which features?': 'Auth' } });
    const p = buildDecision(plan, d({ behavior: 'allow', mode: 'acceptEdits' }));
    expect(p.ok && p.record).toEqual({ behavior: 'allow', mode: 'acceptEdits' });
    const n = buildDecision(bash, d({ behavior: 'deny', interrupt: true }));
    expect(n.ok && n.record).toEqual({ behavior: 'deny', interrupt: true });
  });
});

describe('refusals', () => {
  it('rejects choices that do not fit the card', () => {
    expect(err(buildDecision(bash, d({ behavior: 'allow', suggestion: 1 })))).toBe('invalid_request');
    expect(err(buildDecision({ ...bash, suggestions: ['not an object'] }, d({ behavior: 'allow', suggestion: 0 })))).toBe('invalid_request');
    expect(err(buildDecision(bash, d({ behavior: 'allow', answers: { a: 'b' } })))).toBe('invalid_request');
    expect(err(buildDecision(bash, d({ behavior: 'allow', mode: 'acceptEdits' })))).toBe('invalid_request');
    expect(err(buildDecision(bash, d({ behavior: 'allow', interrupt: true })))).toBe('invalid_request');
    expect(err(buildDecision(bash, d({ behavior: 'allow', message: 'x' })))).toBe('invalid_request');
    expect(err(buildDecision(bash, d({ behavior: 'deny', mode: 'acceptEdits' })))).toBe('invalid_request');
    expect(err(buildDecision(plan, d({ behavior: 'allow', suggestion: 0 })))).toBe('invalid_request');
    expect(err(buildDecision(plan, d({ behavior: 'allow', answers: {} })))).toBe('invalid_request');
    expect(err(buildDecision(question, d({ behavior: 'allow', suggestion: 0 })))).toBe('invalid_request');
  });

  it('rejects incomplete or malformed answers', () => {
    const q = (answers: Record<string, string | string[]>) => buildDecision(question, d({ behavior: 'allow', answers }));
    expect(err(buildDecision(question, d({ behavior: 'allow' })))).toBe('invalid_request');
    expect(err(q({ 'Which database?': 'Postgres' }))).toBe('invalid_request'); // missing one
    expect(err(q({ 'Which database?': 'Postgres', 'Which features?': 'Auth', 'Unknown?': 'x' }))).toBe('invalid_request');
    expect(err(q({ 'Which database?': ['Postgres', 'SQLite'], 'Which features?': 'Auth' }))).toBe('invalid_request'); // single-select
    expect(err(q({ 'Which database?': '   ', 'Which features?': 'Auth' }))).toBe('invalid_request');
    expect(err(q({ 'Which database?': 'Postgres', 'Which features?': [] }))).toBe('invalid_request');
    const unknownShape: DecisionCard = { kind: 'question', tool: 'AskUserQuestion', input: { questions: 'nope' }, suggestions: [] };
    expect(err(buildDecision(unknownShape, d({ behavior: 'allow', answers: { a: 'b' } })))).toBe('invalid_request');
    // a deny still works on an unrecognised question
    expect(buildDecision(unknownShape, d({ behavior: 'deny' })).ok).toBe(true);
  });

  it('subagent cards cannot be answered from here', () => {
    const card: DecisionCard = { kind: 'subagent-info', tool: 'Bash', input: {}, suggestions: [] };
    expect(err(buildDecision(card, d({ behavior: 'allow' })))).toBe('conflict');
    expect(err(buildDecision(card, d({ behavior: 'deny' })))).toBe('conflict');
  });

  it('asks for confirmation on Bash rules and bypassPermissions', () => {
    expect(suggestionNeedsConfirm('Bash', {})).toBe(true);
    expect(suggestionNeedsConfirm('Edit', EDIT_SUGGESTION)).toBe(false);
    expect(suggestionNeedsConfirm('Task', BASH_SUGGESTION)).toBe(true);
    expect(suggestionNeedsConfirm('Edit', { type: 'setMode', mode: 'bypassPermissions', destination: 'session' })).toBe(true);
    expect(suggestionNeedsConfirm('Edit', { type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toBe(false);
    const card: DecisionCard = { ...edit, suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] };
    expect(err(buildDecision(card, d({ behavior: 'allow', suggestion: 0 })))).toBe('needs_confirm');
  });
});
