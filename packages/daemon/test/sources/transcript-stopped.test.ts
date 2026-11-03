/**
 * v0.10.2: a tool call Claude stopped is not "you rejected".
 *
 * Claude Code writes the same record for a "No" at the permission dialog with
 * nothing typed and for a call it stopped (Esc on a running call, TaskStop,
 * a stop from the UI): "The user doesn't want to proceed with this tool use…",
 * `toolUseResult: "User rejected tool use"`, then "[Request interrupted by
 * user for tool use]". The scanner says "you rejected" only with proof of a
 * dialog, or where one could have been on screen. The shapes follow real
 * Claude Code 2.1.316 transcripts; every word, path and id here is made up.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROMPT_DENIED,
  agentPromptDeniedSaid,
  assistantToolUse,
  interruptedForToolUse,
  permissionMode,
  taskStopped,
  timeline,
  toolRejected,
  toolResult,
  toolResultWith,
  toolStopped,
  TOOL_DECLINED,
  TOOL_STOPPED_RUNNING,
  userPrompt,
  workflowLaunched,
  type Entry,
  type EntryContext,
} from '@jantar/fixtures';
import { AlertScanner, denialKind, type AlertScannerOptions, type FoundAlert } from '../../src/sources/transcripts/alerts.js';

const SID = 'sess-stops';
const CWD = '/w/app';
const SAVE_PROMPT = 'Save all the workflows and then stop them, so they can be continued later.';

function scanAll(entries: readonly Entry[], opts: AlertScannerOptions = {}): FoundAlert[] {
  const scanner = new AlertScanner(opts);
  return entries.flatMap((e, i) => scanner.scan(e, i, 0));
}

function kinds(found: readonly FoundAlert[]): Array<[string, string, string | undefined]> {
  return found.map((a) => [a.kind, a.what, a.why]);
}

/** A typed prompt carrying the session's mode, as Claude records it in the main conversation. */
function prompt(ctx: EntryContext, text: string, mode: string): Entry {
  return { ...userPrompt(ctx, text), permissionMode: mode };
}

/** An entry of a subagent's or workflow agent's own transcript. */
function agentEntry(e: Entry, agentId = 'a0000000000000001'): Entry {
  return { ...e, isSidechain: true, agentId };
}

describe('a stopped call is not "you rejected"', () => {
  it('bypass mode: no dialog could have been shown, so a stopped call makes no alert', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const found = scanAll([
      permissionMode(tl.next(), 'bypassPermissions'),
      prompt(tl.next(), 'Run the scan again, faster.', 'bypassPermissions'),
      assistantToolUse(tl.next(), 'Bash', { command: 'python scan.py', description: 'Run a faster scan' }, 'toolu_scan'),
      toolStopped(tl.next(), 'toolu_scan', { note: true }),
      interruptedForToolUse(tl.next()),
    ]);
    expect(found).toEqual([]);
  });

  it('a workflow agent whose parent stopped it after a save prompt: no alert', () => {
    // the parent (main transcript): the workflow, the save prompt, TaskStop
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const parent = [
      prompt(tl.next(), 'Scan the markets.', 'bypassPermissions'),
      assistantToolUse(tl.next(), 'Workflow', { script: 'scan.js' }, 'toolu_wf'),
      toolResultWith(tl.next(), 'toolu_wf', 'Workflow launched in the background.', workflowLaunched('wtask0001', 'scan')),
      prompt(tl.next(), SAVE_PROMPT, 'bypassPermissions'),
      assistantToolUse(tl.next(), 'TaskStop', { task_id: 'wtask0001' }, 'toolu_stop'),
      toolResultWith(tl.next(), 'toolu_stop', 'Successfully stopped task', taskStopped('wtask0001', 'local_workflow')),
    ];
    expect(scanAll(parent)).toEqual([]);

    // the agent's own transcript (subagents/workflows/wf_wtask0001/agent-….jsonl): its running calls are cancelled
    const at = timeline('2026-01-15T09:58:00.000Z', SID, CWD);
    const agent = [
      agentEntry(userPrompt(at.next(), 'Scan the markets and write a report.')),
      agentEntry(assistantToolUse(at.next(), 'Bash', { command: 'python scan.py --fast', description: 'Run a faster scan' }, 'toolu_a1')),
      agentEntry(assistantToolUse(at.next(), 'WebFetch', { url: 'https://example.com/markets' }, 'toolu_a2')),
      agentEntry(toolStopped(at.next(), 'toolu_a1')),
      agentEntry(toolStopped(at.next(), 'toolu_a2')),
      agentEntry(interruptedForToolUse(at.next())),
    ];
    expect(scanAll(agent, { agent: true })).toEqual([]);
    // a sidechain entry is the same, even in a scanner that does not know it reads an agent's transcript
    expect(scanAll(agent)).toEqual([]);
  });

  it('Esc on a running call (the interrupt marker follows, then the user types on): no alert in auto or bypass mode', () => {
    for (const mode of ['auto', 'bypassPermissions', 'dontAsk']) {
      const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
      const found = scanAll([
        prompt(tl.next(), 'Clean up the build output.', mode),
        assistantToolUse(tl.next(), 'Bash', { command: 'rm -rf build' }, 'toolu_rm'),
        toolStopped(tl.next(), 'toolu_rm'),
        interruptedForToolUse(tl.next()),
        prompt(tl.next(), 'leave it', mode),
      ]);
      expect(found, mode).toEqual([]);
    }
  });

  it('the session’s mode stands in until the transcript names one, and the transcript’s own mode wins', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const call = [
      assistantToolUse(tl.next(), 'Bash', { command: 'npm test' }, 'toolu_t'),
      toolStopped(tl.next(), 'toolu_t'),
      interruptedForToolUse(tl.next()),
    ];
    expect(scanAll(call, { mode: () => 'bypassPermissions' })).toEqual([]);
    expect(kinds(scanAll(call, { mode: () => 'default' }))).toEqual([['rejected', 'you rejected: Bash · npm test', undefined]]);
    const named = [permissionMode(tl.next(), 'default'), ...call];
    expect(kinds(scanAll(named, { mode: () => 'bypassPermissions' }))).toEqual([['rejected', 'you rejected: Bash · npm test', undefined]]);
  });

  it('follows the mode as it changes: plan, then bypass after the plan is approved', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const found = scanAll([
      prompt(tl.next(), 'Plan the refactor.', 'plan'),
      assistantToolUse(tl.next(), 'Bash', { command: 'git log' }, 'toolu_p'),
      toolStopped(tl.next(), 'toolu_p'),
      interruptedForToolUse(tl.next()),
      permissionMode(tl.next(), 'bypassPermissions'),
      assistantToolUse(tl.next(), 'Bash', { command: 'pnpm build' }, 'toolu_b'),
      toolStopped(tl.next(), 'toolu_b'),
      interruptedForToolUse(tl.next()),
    ]);
    expect(kinds(found)).toEqual([['rejected', 'you rejected: Bash · git log', undefined]]);
  });

  it('Claude’s own "stopped while running, not refused" record is a stop in every mode, no mode known too', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', undefined]) {
      for (const note of [false, true]) {
        const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
        const found = scanAll(
          [
            ...(mode ? [prompt(tl.next(), 'Deploy it.', mode)] : []),
            assistantToolUse(tl.next(), 'Bash', { command: 'make deploy' }, 'toolu_y'),
            toolStopped(tl.next(), 'toolu_y', { running: true, note }),
            interruptedForToolUse(tl.next()),
          ],
          { mode: () => undefined },
        );
        expect(found, `${String(mode)} note=${note}`).toEqual([]);
      }
    }
    expect(denialKind(TOOL_STOPPED_RUNNING)).toBe('rejected'); // text alone: Files reads it as before
  });
});

describe('a real rejection still says "you rejected"', () => {
  it('default mode: a "No" at the dialog with nothing typed (written like a stop)', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const found = scanAll([
      permissionMode(tl.next(), 'default'),
      prompt(tl.next(), 'Write the notes file.', 'default'),
      assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/notes.md', content: 'x' }, 'toolu_w'),
      toolStopped(tl.next(), 'toolu_w', { note: true }),
      interruptedForToolUse(tl.next()),
    ]);
    expect(kinds(found)).toEqual([['rejected', 'you rejected: Write · notes.md', undefined]]);
    expect(found[0]?.full).toBe(TOOL_DECLINED); // Claude's note to the model is left out
  });

  it('with "the user said: …", in any mode, with or without the corrections note', () => {
    for (const mode of ['default', 'auto', 'bypassPermissions']) {
      const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
      const found = scanAll([
        prompt(tl.next(), 'Write the notes file.', mode),
        assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/notes.md', content: 'x' }, 'toolu_w'),
        toolRejected(tl.next(), 'toolu_w', { said: 'write it to docs/ instead\nand keep it short', note: true }),
      ]);
      expect(kinds(found), mode).toEqual([['rejected', 'you rejected: Write · notes.md', 'write it to docs/ instead']]);
      expect(found[0]?.full).not.toContain('Note:');
    }
  });

  it('a plan rejected with words, or dismissed with Esc, in plan mode', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const found = scanAll([
      prompt(tl.next(), 'Plan the refactor.', 'plan'),
      assistantToolUse(tl.next(), 'ExitPlanMode', { plan: '1. Split the module' }, 'toolu_plan1'),
      toolRejected(tl.next(), 'toolu_plan1', { said: 'shorter please', note: true }),
      assistantToolUse(tl.next(), 'ExitPlanMode', { plan: '1. Split it' }, 'toolu_plan2'),
      toolStopped(tl.next(), 'toolu_plan2'),
      interruptedForToolUse(tl.next()),
    ]);
    expect(kinds(found)).toEqual([
      ['rejected', 'you rejected: plan ready for your approval', 'shorter please'],
      ['rejected', 'you rejected: plan ready for your approval', undefined],
    ]);
  });

  it('a question dismissed shows in every mode, bypass too (its dialog always shows)', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const found = scanAll([
      prompt(tl.next(), 'Pick a market.', 'bypassPermissions'),
      assistantToolUse(tl.next(), 'AskUserQuestion', { questions: [{ question: 'Which market first?' }] }, 'toolu_q'),
      toolStopped(tl.next(), 'toolu_q'),
      interruptedForToolUse(tl.next()),
    ]);
    expect(kinds(found)).toEqual([['rejected', 'you rejected: asks · Which market first?', undefined]]);
  });

  it('proof wins over the mode: an "Error: " result or a recorded decision by the user', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const found = scanAll([
      prompt(tl.next(), 'Tidy up.', 'auto'),
      assistantToolUse(tl.next(), 'Bash', { command: 'rm -rf cache' }, 'toolu_1'),
      toolRejected(tl.next(), 'toolu_1', { source: 'user_abort' }),
      assistantToolUse(tl.next(), 'Bash', { command: 'rm -rf dist' }, 'toolu_2'),
      { ...toolStopped(tl.next(), 'toolu_2'), permissionDecision: { decision: 'reject', source: 'user_reject' } },
      assistantToolUse(tl.next(), 'Bash', { command: 'rm -rf tmp' }, 'toolu_3'),
      toolRejected(tl.next(), 'toolu_3', { source: null }),
    ]);
    expect(kinds(found)).toEqual([
      ['rejected', 'you rejected: Bash · rm -rf cache', undefined],
      ['rejected', 'you rejected: Bash · rm -rf dist', undefined],
      ['rejected', 'you rejected: Bash · rm -rf tmp', undefined],
    ]);
  });

  it('a subagent’s prompt or a safety-check prompt the user said no to', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const found = scanAll(
      [
        agentEntry(assistantToolUse(tl.next(), 'Bash', { command: 'rm -rf data/old' }, 'toolu_d')),
        agentEntry(toolRejected(tl.next(), 'toolu_d', { text: AGENT_PROMPT_DENIED })),
      ],
      { agent: true },
    );
    expect(kinds(found)).toEqual([['rejected', 'you rejected: Bash · rm -rf data/old', undefined]]);
    expect(denialKind(AGENT_PROMPT_DENIED)).toBe('rejected');
  });

  it('a subagent’s prompt said no to with words typed: the words are the why ("The user said:", capital T)', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const said = 'keep data/old, delete data/tmp\nthen stop';
    const found = scanAll(
      [
        agentEntry(assistantToolUse(tl.next(), 'Bash', { command: 'rm -rf data/old' }, 'toolu_d')),
        agentEntry(toolRejected(tl.next(), 'toolu_d', { text: agentPromptDeniedSaid(said), note: true, source: null })),
      ],
      { agent: true },
    );
    expect(kinds(found)).toEqual([['rejected', 'you rejected: Bash · rm -rf data/old', 'keep data/old, delete data/tmp']]);
    expect(found[0]?.full).toBe(agentPromptDeniedSaid(said)); // Claude's note to the model is left out
    expect(denialKind(agentPromptDeniedSaid(said))).toBe('rejected');
  });
});

describe('the old cases are read as before', () => {
  it('the bare sentence with no mode and no structured fields is a rejection', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const found = scanAll([
      assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/app.ts', old_string: 'a', new_string: 'b' }, 'toolu_e'),
      toolResult(tl.next(), 'toolu_e', "The user doesn't want to proceed with this tool use. The tool use was rejected.", true),
    ]);
    expect(kinds(found)).toEqual([['rejected', 'you rejected: Edit · app.ts', undefined]]);
  });

  it('blocks are blocks in every mode and in agents’ transcripts', () => {
    const auto =
      'Permission for this action was denied by the Claude Code auto mode classifier. Reason: Deleting data is destructive. If you have a reason, ask the user.';
    const tl = timeline('2026-01-15T10:00:00.000Z', SID, CWD);
    const entries = [
      agentEntry(assistantToolUse(tl.next(), 'Bash', { command: 'rm -rf data' }, 'toolu_x')),
      agentEntry(toolResult(tl.next(), 'toolu_x', auto, true)),
      agentEntry(assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/.env', content: 'x' }, 'toolu_y')),
      agentEntry(toolResult(tl.next(), 'toolu_y', 'Permission to use Write with file_path /w/app/.env has been denied.', true)),
    ];
    expect(kinds(scanAll(entries, { agent: true }))).toEqual([
      ['blocked', 'auto mode: Bash · rm -rf data', 'Deleting data is destructive'],
      ['blocked', 'deny rule: Write · .env', undefined],
    ]);
    expect(denialKind(TOOL_DECLINED)).toBe('rejected'); // text alone cannot tell; the scanner can
  });
});
