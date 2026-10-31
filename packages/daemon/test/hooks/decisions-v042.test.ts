/**
 * v0.4.2 decision shapes (spec 4.1-4.2): a plan approved with auto mode (H1),
 * Claude's combined "for this session" row (H2) and "Chat about this", each
 * pinned as the exact JSON the hook prints, and the audit's redaction of
 * them (P1).
 */
import { CLARIFY_MESSAGE, DecisionBodySchema, PermissionRequestOutputSchema, type DecisionBody, type Question } from '@jantar/protocol';
import { describe, expect, it } from 'vitest';
import {
  AUTO_PLAN_MODES,
  buildDecision,
  DEFAULT_PLAN_MODES,
  HOOK_PLAN_AUTO,
  redactedDecision,
  replyLine,
  suggestionNeedsConfirm,
  type BuildDecisionResult,
  type DecisionCard,
} from '../../src/hooks/decisions.js';

const PLAN_INPUT = { plan: '1. Add the migration\n2. Update the API' };
const autoPlan: DecisionCard = { kind: 'plan', tool: 'ExitPlanMode', input: PLAN_INPUT, suggestions: [], planModes: AUTO_PLAN_MODES };
const editsPlan: DecisionCard = { kind: 'plan', tool: 'ExitPlanMode', input: PLAN_INPUT, suggestions: [], planModes: DEFAULT_PLAN_MODES };
const oldPlan: DecisionCard = { kind: 'plan', tool: 'ExitPlanMode', input: PLAN_INPUT, suggestions: [] };

// mac-1's option 2 as Claude 2.1.314 sends it: two session-scoped entries, plus one saved for the project.
const DIRS = {
  type: 'addDirectories',
  directories: ['/synthetic/home/.claude/plans', '/synthetic/home/work/demo/plans'],
  destination: 'session',
};
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session', extra: { kept: true } };
const PROJECT_RULE = { type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: 'docs/**' }], behavior: 'allow', destination: 'localSettings' };
const write: DecisionCard = {
  kind: 'permission',
  tool: 'Write',
  input: { file_path: '/synthetic/home/work/demo/notes.md', content: 'x' },
  suggestions: [DIRS, ACCEPT_EDITS, PROJECT_RULE],
};

const QUESTIONS: Question[] = [
  { question: 'Which level?', header: 'Level', options: [{ label: 'Junior' }, { label: 'Senior' }], multiSelect: false },
];
const question: DecisionCard = { kind: 'question', tool: 'AskUserQuestion', input: { questions: QUESTIONS }, suggestions: [], questions: QUESTIONS };

function json(r: BuildDecisionResult): string {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  PermissionRequestOutputSchema.parse(r.output);
  return JSON.stringify(r.output);
}
function err(r: BuildDecisionResult): string {
  if (r.ok) throw new Error('expected a refusal');
  return r.code;
}
const d = (b: Record<string, unknown>) => b as DecisionBody;
const wire = (decision: string) => `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":${decision}}}`;

describe('plan auto (H1)', () => {
  it('stays off hook cards until spike SP8 checks the hook path on the real Mac', () => {
    // Flipping this is the main session's call, after SP8 (decisions.ts says what it must show).
    expect(HOOK_PLAN_AUTO).toBe(false);
  });

  it('approves with auto mode as the exact JSON, when the card offers it and the body confirms', () => {
    const r = buildDecision(autoPlan, d({ behavior: 'allow', mode: 'auto', confirm: true }));
    expect(json(r)).toBe(
      wire(
        '{"behavior":"allow","updatedInput":{"plan":"1. Add the migration\\n2. Update the API"},' +
          '"updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}',
      ),
    );
    expect(r.ok && r.record).toEqual({ behavior: 'allow', mode: 'auto' });
    expect(replyLine(r.ok ? r.output : null)).toBe(`{"v":1,"output":${json(r)}}\n`);
  });

  it('needs confirm: true (the encoder answers needs_confirm, the API body refuses it outright)', () => {
    expect(err(buildDecision(autoPlan, d({ behavior: 'allow', mode: 'auto' })))).toBe('needs_confirm');
    expect(err(buildDecision(autoPlan, d({ behavior: 'allow', mode: 'auto', confirm: false })))).toBe('needs_confirm');
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', mode: 'auto' }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ behavior: 'allow', mode: 'auto', confirm: true }).success).toBe(true);
  });

  it('refuses a mode the card does not offer, before asking for a confirm', () => {
    const notOffered = (card: DecisionCard, body: DecisionBody) => {
      const r = buildDecision(card, body);
      expect(r).toEqual({ ok: false, code: 'invalid_request', message: 'this plan card does not offer that mode' });
    };
    notOffered(editsPlan, d({ behavior: 'allow', mode: 'auto', confirm: true }));
    notOffered(editsPlan, d({ behavior: 'allow', mode: 'auto' }));
    // A card from before v0.4.2 (no planModes) offers the two it always did, and so does an empty list, as on the phone.
    notOffered(oldPlan, d({ behavior: 'allow', mode: 'auto', confirm: true }));
    const emptyPlan: DecisionCard = { ...oldPlan, planModes: [] };
    notOffered(emptyPlan, d({ behavior: 'allow', mode: 'auto', confirm: true }));
    expect(buildDecision(emptyPlan, d({ behavior: 'allow', mode: 'acceptEdits' })).ok).toBe(true);
    expect(buildDecision(emptyPlan, d({ behavior: 'allow', mode: 'default' })).ok).toBe(true);
    // A session that ran in auto mode: Claude shows auto instead of auto-accept edits.
    notOffered(autoPlan, d({ behavior: 'allow', mode: 'acceptEdits' }));
  });

  it('keeps every offered mode working, and the plain approval and the feedback deny', () => {
    const setMode = (mode: string) =>
      wire(`{"behavior":"allow","updatedInput":${JSON.stringify(PLAN_INPUT)},"updatedPermissions":[{"type":"setMode","mode":"${mode}","destination":"session"}]}`);
    expect(json(buildDecision(autoPlan, d({ behavior: 'allow', mode: 'default' })))).toBe(setMode('default'));
    expect(json(buildDecision(editsPlan, d({ behavior: 'allow', mode: 'acceptEdits' })))).toBe(setMode('acceptEdits'));
    expect(json(buildDecision(oldPlan, d({ behavior: 'allow', mode: 'default' })))).toBe(setMode('default'));
    expect(json(buildDecision(autoPlan, d({ behavior: 'allow' })))).toBe(wire(`{"behavior":"allow","updatedInput":${JSON.stringify(PLAN_INPUT)}}`));
    expect(json(buildDecision(autoPlan, d({ behavior: 'deny', message: 'Split step 2' })))).toBe(
      wire('{"behavior":"deny","message":"Split step 2","interrupt":false}'),
    );
    // Modes stay on approvals only.
    expect(err(buildDecision(autoPlan, d({ behavior: 'deny', mode: 'auto', confirm: true })))).toBe('invalid_request');
  });
});

describe('session row (H2)', () => {
  it('echoes every named suggestion verbatim, in index order, as one answer', () => {
    const r = buildDecision(write, d({ behavior: 'allow', suggestions: [1, 0] }));
    expect(json(r)).toBe(
      wire(
        '{"behavior":"allow","updatedPermissions":[' +
          '{"type":"addDirectories","directories":["/synthetic/home/.claude/plans","/synthetic/home/work/demo/plans"],"destination":"session"},' +
          '{"type":"setMode","mode":"acceptEdits","destination":"session","extra":{"kept":true}}]}',
      ),
    );
    expect(r.ok && r.record).toEqual({ behavior: 'allow', suggestions: [0, 1] });
  });

  it('one index gives exactly what `suggestion` gives', () => {
    expect(json(buildDecision(write, d({ behavior: 'allow', suggestions: [2] })))).toBe(json(buildDecision(write, d({ behavior: 'allow', suggestion: 2 }))));
  });

  it('wants confirm when any of them needs it', () => {
    const bypass = { type: 'setMode', mode: 'bypassPermissions', destination: 'session' };
    const card: DecisionCard = { ...write, suggestions: [DIRS, bypass] };
    expect(err(buildDecision(card, d({ behavior: 'allow', suggestions: [0, 1] })))).toBe('needs_confirm');
    expect(json(buildDecision(card, d({ behavior: 'allow', suggestions: [0, 1], confirm: true })))).toContain('"bypassPermissions"');
    // Every suggestion on a Bash request is a shell rule's worth of trust.
    const bash: DecisionCard = { kind: 'permission', tool: 'Bash', input: { command: 'cat /synthetic/a' }, suggestions: [DIRS, ACCEPT_EDITS] };
    expect(err(buildDecision(bash, d({ behavior: 'allow', suggestions: [0, 1] })))).toBe('needs_confirm');
    expect(buildDecision(bash, d({ behavior: 'allow', suggestions: [0, 1], confirm: true })).ok).toBe(true);
    // The harmless pair needs no second tap.
    expect(buildDecision(write, d({ behavior: 'allow', suggestions: [0, 1] })).ok).toBe(true);
  });

  it('holds a switch to auto mode as it holds bypass (CONFIRM_MODES), in one row or alone', () => {
    const auto = { type: 'setMode', mode: 'auto', destination: 'session' };
    expect(suggestionNeedsConfirm('Edit', auto)).toBe(true);
    expect(suggestionNeedsConfirm('Edit', { ...auto, mode: 'bypassPermissions' })).toBe(true);
    expect(suggestionNeedsConfirm('Edit', ACCEPT_EDITS)).toBe(false);
    expect(suggestionNeedsConfirm('Edit', { ...auto, mode: 'default' })).toBe(false);
    const card: DecisionCard = { ...write, suggestions: [DIRS, auto] };
    expect(err(buildDecision(card, d({ behavior: 'allow', suggestions: [0, 1] })))).toBe('needs_confirm');
    expect(err(buildDecision(card, d({ behavior: 'allow', suggestion: 1 })))).toBe('needs_confirm');
    expect(json(buildDecision(card, d({ behavior: 'allow', suggestions: [0, 1], confirm: true })))).toContain('"mode":"auto"');
  });

  it('takes only valid, unique indices, and never together with suggestion', () => {
    const bad = (body: Record<string, unknown>, card: DecisionCard = write) => expect(err(buildDecision(card, d(body)))).toBe('invalid_request');
    bad({ behavior: 'allow', suggestions: [0, 3] });
    bad({ behavior: 'allow', suggestions: [-1] });
    bad({ behavior: 'allow', suggestions: [0.5] });
    bad({ behavior: 'allow', suggestions: [0, 0] });
    bad({ behavior: 'allow', suggestions: [] });
    bad({ behavior: 'allow', suggestions: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
    bad({ behavior: 'allow', suggestion: 0, suggestions: [1] });
    bad({ behavior: 'allow', suggestions: [0] }, { ...write, suggestions: ['not an object'] });
    bad({ behavior: 'allow', suggestions: [0] }, { ...write, suggestions: [{ directories: [] }] });
    // allow only, and only on permission cards
    bad({ behavior: 'deny', suggestions: [0] });
    bad({ behavior: 'allow', suggestions: [0] }, question);
    bad({ behavior: 'allow', suggestions: [0] }, autoPlan);
    // The API body refuses the same shapes before the encoder sees them.
    for (const body of [
      { behavior: 'allow', suggestions: [0, 0] },
      { behavior: 'allow', suggestions: [] },
      { behavior: 'allow', suggestion: 0, suggestions: [1] },
      { behavior: 'deny', suggestions: [0] },
    ]) {
      expect(DecisionBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('Chat about this', () => {
  it("declines the question with Claude's own opening sentence, as the exact JSON", () => {
    const r = buildDecision(question, d({ behavior: 'deny', message: CLARIFY_MESSAGE }));
    expect(json(r)).toBe(
      wire(
        '{"behavior":"deny","message":"The user wants to clarify these questions. Start by asking them what they would like to clarify.","interrupt":false}',
      ),
    );
    expect(r.ok && r.record).toEqual({ behavior: 'deny', interrupt: false, message: CLARIFY_MESSAGE });
  });
});

describe('audit redaction', () => {
  it('records the new shapes as indices, modes and counts: no rule, path, question or text', () => {
    const rows = [
      buildDecision(write, d({ behavior: 'allow', suggestions: [1, 0] })),
      buildDecision(autoPlan, d({ behavior: 'allow', mode: 'auto', confirm: true })),
      buildDecision(question, d({ behavior: 'deny', message: CLARIFY_MESSAGE })),
      buildDecision(question, d({ behavior: 'allow', answers: { 'Which level?': 'A typed answer' } })),
      buildDecision(autoPlan, d({ behavior: 'deny', message: 'Split step 2' })),
    ].map((r) => {
      if (!r.ok) throw new Error(r.message);
      return redactedDecision(r.record);
    });
    expect(rows).toEqual([
      { behavior: 'allow', suggestions: [0, 1] },
      { behavior: 'allow', mode: 'auto' },
      { behavior: 'deny', interrupt: false, hasMessage: true },
      { behavior: 'allow', answered: 1 },
      { behavior: 'deny', interrupt: false, hasMessage: true },
    ]);
    const all = JSON.stringify(rows);
    for (const secret of ['/synthetic', 'addDirectories', 'setMode', 'clarify', 'Which level', 'typed answer', 'Split step']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('wording', () => {
  it('points subagent cards at the dialog in the app, and an open card it cannot answer at the Mac', () => {
    // A subagent card leaves the screen path open.
    const sub = buildDecision({ kind: 'subagent-info', tool: 'Bash', input: {}, suggestions: [] }, d({ behavior: 'allow' }));
    expect(sub).toMatchObject({ ok: false, message: 'subagent requests are answered from the dialog in the app, or at the Mac' });
    // The bridge holds neither of these; if one were open it would shut the screen path, so only the Mac is left.
    const q = buildDecision({ ...question, questions: undefined }, d({ behavior: 'allow', answers: { a: 'b' } }));
    const p = buildDecision({ ...oldPlan, input: 'not an object' }, d({ behavior: 'allow' }));
    expect(q).toMatchObject({ ok: false, message: 'this question has an unrecognised format; answer it at the Mac' });
    expect(p).toMatchObject({ ok: false, message: 'this plan has an unrecognised format; answer it at the Mac' });
  });
});
