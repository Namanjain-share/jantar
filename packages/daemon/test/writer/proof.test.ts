import { describe, expect, it } from 'vitest';
import {
  assistantText,
  metaUser,
  queueOperation,
  queuedCommand,
  slashCommand,
  toolResult,
  userBlocks,
  userPrompt,
  type Entry,
  type EntryContext,
} from '@jantar/fixtures';
import type { TranscriptEntry } from '../../src/contracts.js';
import { compareCandidate, contentText, promptCandidate, scanForProof } from '../../src/writer/proof.js';
import { expectedPrompt, parseSlashCommand, validatePromptText } from '../../src/writer/text.js';
import { parsePsLstartUtc, procStartCandidates } from '../../src/writer/proc-start.js';

const SID = '11111111-1111-4111-8111-111111111111';
const CWD = '/synthetic/home/work/alpha-app';
const TYPED_AT = Date.parse('2026-01-15T10:00:10.000Z');
const ctx = (sec: number, extra: Partial<EntryContext> = {}): EntryContext => ({
  sessionId: SID,
  cwd: CWD,
  at: new Date(TYPED_AT + sec * 1000).toISOString(),
  ...extra,
});

function asEntries(list: Entry[]): TranscriptEntry[] {
  let offset = 0;
  return list.map((raw) => {
    const line = JSON.stringify(raw);
    const e: TranscriptEntry = { offset, length: Buffer.byteLength(line), type: String(raw.type), raw };
    if (typeof raw.uuid === 'string') e.uuid = raw.uuid;
    if (typeof raw.timestamp === 'string') e.timestamp = raw.timestamp;
    if (typeof raw.isSidechain === 'boolean') e.isSidechain = raw.isSidechain;
    offset += Buffer.byteLength(line) + 1;
    return e;
  });
}

const PROMPT = 'Add a logout button to the synthetic header and cover it with a test';
const opts = { notBeforeMs: TYPED_AT - 5000, requireTimestamp: false, nowIso: '2026-01-15T10:00:30.000Z' };

/** A queue-operation Claude writes when the queue is put back into the input box (Esc or Up at the Mac). */
function popAll(c: EntryContext, content?: string): Entry {
  return { ...queueOperation(c, 'remove', content), operation: 'popAll' };
}

describe('proof: a queued prompt is proven only once Claude takes it from the queue (W9)', () => {
  const e = expectedPrompt(PROMPT);

  it('enqueue, then a remove or dequeue (with or without the text): final', () => {
    for (const op of ['remove', 'dequeue'] as const) {
      for (const content of [undefined, PROMPT]) {
        const r = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT), queueOperation(ctx(9), op, content)]), e, opts);
        expect(r.hit?.proof.kind, `${op} ${content ? 'with' : 'without'} text`).toBe('queue-operation');
        expect(r.hit?.proof.at).toBe(ctx(2).at);
        expect(r.queued).toBeNull();
      }
    }
  });

  it("enqueue, then the remove of someone else's queued text: still waiting", () => {
    const r = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT), queueOperation(ctx(3), 'remove', 'something else entirely')]), e, opts);
    expect(r.hit).toBeNull();
    expect(r.queued).not.toBeNull();
  });

  it('enqueue, then a queued_command attachment or a user entry with the text: final, and that entry is the proof', () => {
    const a = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT), queuedCommand(ctx(5), PROMPT)]), e, opts);
    expect(a.hit?.proof.kind).toBe('queued_command');
    const u = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT), userPrompt(ctx(6), PROMPT)]), e, opts);
    expect(u.hit?.proof.kind).toBe('user');
  });

  it('enqueue, then popAll (Esc at the Mac): popped back into the input box, not proof', () => {
    for (const content of [undefined, PROMPT, `older queued text\n${PROMPT}`]) {
      const r = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT), popAll(ctx(4), content)]), e, opts);
      expect(r.hit, String(content)).toBeNull();
      expect(r.queued).toBeNull();
      expect(r.popped).toBe(true);
    }
  });

  it('a popAll of other text only does not pop ours', () => {
    const r = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT), popAll(ctx(4), 'a different queued prompt')]), e, opts);
    expect(r.popped).toBe(false);
    expect(r.queued).not.toBeNull();
  });

  it('popped, then sent at the Mac after all (a user entry): final', () => {
    const r = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT), popAll(ctx(4)), userPrompt(ctx(7), PROMPT)]), e, opts);
    expect(r.hit?.proof.kind).toBe('user');
    expect(r.popped).toBe(false);
  });

  it('popped, then queued again: waiting again', () => {
    const r = scanForProof(
      asEntries([queueOperation(ctx(2), 'enqueue', PROMPT), popAll(ctx(4)), queueOperation(ctx(6), 'enqueue', PROMPT)]),
      e,
      opts,
    );
    expect(r.popped).toBe(false);
    expect(r.queued?.proof.at).toBe(ctx(6).at);
  });

  it('the waiting enqueue carries over between reads', () => {
    const first = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT)]), e, opts);
    const second = scanForProof(asEntries([queueOperation(ctx(9), 'remove')]), e, opts, first.queued);
    expect(second.hit?.proof.kind).toBe('queue-operation');
    const popped = scanForProof(asEntries([popAll(ctx(9))]), e, opts, first.queued);
    expect(popped.popped).toBe(true);
    // Without a waiting enqueue, a lone remove or popAll means nothing for us.
    const lone = scanForProof(asEntries([queueOperation(ctx(9), 'remove'), popAll(ctx(9))]), e, opts);
    expect(lone).toMatchObject({ hit: null, queued: null, popped: false });
  });
});

describe('proof: accepted forms', () => {
  it('a user entry with exactly the prompt (string content)', () => {
    const r = scanForProof(asEntries([userPrompt(ctx(1), PROMPT)]), expectedPrompt(PROMPT), opts);
    expect(r.hit?.proof.kind).toBe('user');
    expect(r.hit?.merged).toBe(false);
    expect(r.hit?.proof.uuid).toMatch(/^0{8}-/);
    expect(r.hit?.proof.at).toBe(ctx(1).at);
  });

  it('a user entry in content-block form', () => {
    const r = scanForProof(asEntries([userBlocks(ctx(1), PROMPT)]), expectedPrompt(PROMPT), opts);
    expect(r.hit?.proof.kind).toBe('user');
  });

  it('whitespace differences do not matter (line wraps, trailing newline from Terminal)', () => {
    const r = scanForProof(asEntries([userPrompt(ctx(1), `${PROMPT.replace(/ /g, '\n  ')}\n\n`)]), expectedPrompt(PROMPT), opts);
    expect(r.hit?.proof.kind).toBe('user');
  });

  it('a queued_command attachment (typed while Claude was busy)', () => {
    const r = scanForProof(asEntries([queuedCommand(ctx(2), PROMPT)]), expectedPrompt(PROMPT), opts);
    expect(r.hit?.proof.kind).toBe('queued_command');
  });

  it('a queue-operation enqueue (waiting in Claude\'s queue), which has no uuid, is only provisional (W9)', () => {
    const r = scanForProof(asEntries([queueOperation(ctx(2), 'enqueue', PROMPT)]), expectedPrompt(PROMPT), opts);
    expect(r.hit).toBeNull();
    expect(r.queued?.proof.kind).toBe('queue-operation');
    expect(r.queued?.proof.uuid).toBeUndefined();
    expect(r.popped).toBe(false);
  });

  it('a slash command in its <command-name> form, with the same arguments', () => {
    const text = '/compact keep the API notes';
    const r = scanForProof(asEntries([slashCommand(ctx(1), '/compact', 'keep the API notes')]), expectedPrompt(text), opts);
    expect(r.hit?.proof.kind).toBe('user');
    const bare = scanForProof(asEntries([slashCommand(ctx(1), '/clear')]), expectedPrompt('/clear'), opts);
    expect(bare.hit).not.toBeNull();
  });

  it('extra leading text (the user\'s draft) is proof, flagged as merged', () => {
    const r = scanForProof(asEntries([userPrompt(ctx(1), `half typed idea ${PROMPT}`)]), expectedPrompt(PROMPT), opts);
    expect(r.hit?.merged).toBe(true);
  });

  it('an entry at typing start minus 5 s still counts', () => {
    const r = scanForProof(asEntries([userPrompt(ctx(-5), PROMPT)]), expectedPrompt(PROMPT), opts);
    expect(r.hit).not.toBeNull();
  });
});

describe('proof: rejected', () => {
  it('a 40-character prefix match is not proof (reported as partial)', () => {
    const r = scanForProof(asEntries([userPrompt(ctx(1), PROMPT.slice(0, 40))]), expectedPrompt(PROMPT), opts);
    expect(r.hit).toBeNull();
    expect(r.partial).toBe(true);
  });

  it('our prompt followed by more text is not proof', () => {
    const r = scanForProof(asEntries([userPrompt(ctx(1), `${PROMPT} and also rewrite the footer`)]), expectedPrompt(PROMPT), opts);
    expect(r.hit).toBeNull();
  });

  it('an identical prompt older than typing start minus 5 s is not proof', () => {
    const r = scanForProof(asEntries([userPrompt(ctx(-6), PROMPT)]), expectedPrompt(PROMPT), opts);
    expect(r.hit).toBeNull();
    expect(r.stale).toBe(true);
  });

  it('a different slash command, or the same one with other arguments, is not proof', () => {
    expect(scanForProof(asEntries([slashCommand(ctx(1), '/clear')]), expectedPrompt('/compact'), opts).hit).toBeNull();
    expect(
      scanForProof(asEntries([slashCommand(ctx(1), '/compact', 'other notes')]), expectedPrompt('/compact keep the API notes'), opts).hit,
    ).toBeNull();
  });

  it('meta rows, sidechain rows, assistant text, tool results and dequeues are not prompts', () => {
    const list = [
      metaUser(ctx(1), PROMPT),
      userPrompt(ctx(1, { isSidechain: true }), PROMPT),
      assistantText(ctx(1), PROMPT),
      toolResult(ctx(1), 'toolu_1', PROMPT),
      queueOperation(ctx(1), 'dequeue', PROMPT),
      queueOperation(ctx(1), 'remove', PROMPT),
    ];
    expect(scanForProof(asEntries(list), expectedPrompt(PROMPT), opts).hit).toBeNull();
  });

  it('without a timestamp an entry counts only when the read started at a recorded offset', () => {
    const e = { ...userPrompt(ctx(1), PROMPT) } as Entry;
    delete e.timestamp;
    expect(scanForProof(asEntries([e]), expectedPrompt(PROMPT), opts).hit?.proof.at).toBe(opts.nowIso);
    expect(scanForProof(asEntries([e]), expectedPrompt(PROMPT), { ...opts, requireTimestamp: true }).hit).toBeNull();
  });
});

describe('proof helpers', () => {
  it('contentText drops tool_result blocks and joins text blocks', () => {
    expect(contentText('hi')).toBe('hi');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(contentText([{ type: 'tool_result', tool_use_id: 'x', content: 'out' }])).toBeNull();
    expect(contentText(42)).toBeNull();
  });

  it('promptCandidate reads the three accepted kinds only', () => {
    const [u, q, op, a] = asEntries([
      userPrompt(ctx(1), 'one'),
      queuedCommand(ctx(1), 'two'),
      queueOperation(ctx(1), 'enqueue', 'three'),
      assistantText(ctx(1), 'four'),
    ]);
    expect(promptCandidate(u as TranscriptEntry)?.text).toBe('one');
    expect(promptCandidate(q as TranscriptEntry)?.kind).toBe('queued_command');
    expect(promptCandidate(op as TranscriptEntry)?.kind).toBe('queue-operation');
    expect(promptCandidate(a as TranscriptEntry)).toBeNull();
  });

  it('compareCandidate', () => {
    const e = expectedPrompt('fix the build');
    expect(compareCandidate('fix  the\nbuild ', e)).toBe('exact');
    expect(compareCandidate('please fix the build', e)).toBe('merged');
    expect(compareCandidate('fix the bu', e)).toBe('partial');
    expect(compareCandidate('fix', e)).toBeNull(); // too short to call it part of the prompt
    expect(compareCandidate('', e)).toBeNull();
    // Our prompt twice: an earlier copy was still in the box.
    expect(compareCandidate('fix the build fix the build', e)).toBe('doubled');
    expect(compareCandidate('fix the buildfix the build', e)).toBe('doubled');
    const long = expectedPrompt(PROMPT);
    expect(compareCandidate(`a draft ${PROMPT} ${PROMPT}`, long)).toBe('doubled');
    expect(compareCandidate(`a draft ${PROMPT}`, long)).toBe('merged');
  });

  it('a doubled prompt is a merged hit flagged doubled', () => {
    const r = scanForProof(asEntries([userPrompt(ctx(1), `${PROMPT}\n${PROMPT}`)]), expectedPrompt(PROMPT), opts);
    expect(r.hit).toMatchObject({ merged: true, doubled: true });
  });
});

describe('prompt text', () => {
  it('validates and normalises', () => {
    expect(validatePromptText('a\r\nb\rc')).toEqual({ ok: true, text: 'a\nb\nc' });
    expect(validatePromptText('   \n ').ok).toBe(false);
    expect(validatePromptText('bad \u001b[201~ escape').ok).toBe(false);
    expect(validatePromptText('nul \u0000').ok).toBe(false);
    expect(validatePromptText('tabs\tand\nnewlines are fine').ok).toBe(true);
    expect(validatePromptText('x'.repeat(16_001)).ok).toBe(false);
  });

  it("refuses what can never be proven sent: a leading '!' (bash mode) and /clear", () => {
    expect(validatePromptText('!git push origin main')).toMatchObject({ ok: false, reason: expect.stringMatching(/shell command/) });
    expect(validatePromptText('! ls').ok).toBe(false);
    expect(validatePromptText('ship it!').ok).toBe(true);
    expect(validatePromptText(' !not bash mode').ok).toBe(true);
    for (const t of ['/clear', '/clear  ', '/reset', '/new now']) {
      expect(validatePromptText(t)).toMatchObject({ ok: false, reason: expect.stringMatching(/new transcript/) });
    }
    expect(validatePromptText('/compact').ok).toBe(true);
    expect(validatePromptText('/clearly-not-clear').ok).toBe(true);
  });

  it('recognises slash commands', () => {
    expect(parseSlashCommand('/compact  keep notes ')).toEqual({ name: '/compact', args: 'keep notes' });
    expect(parseSlashCommand('/clear')).toEqual({ name: '/clear', args: '' });
    expect(parseSlashCommand('/plugin:cmd x')).toEqual({ name: '/plugin:cmd', args: 'x' });
    expect(parseSlashCommand('not /a command')).toBeNull();
    expect(parseSlashCommand('/ nope')).toBeNull();
  });
});

describe('process start times', () => {
  it('reads ps lstart (run with TZ=UTC) and the session file value', () => {
    const ms = Date.UTC(2026, 0, 15, 9, 0, 0);
    expect(parsePsLstartUtc('Thu Jan 15 09:00:00 2026\n')).toBe(ms);
    expect(parsePsLstartUtc('Thu Jan  5 09:00:00 2026')).toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
    expect(parsePsLstartUtc('garbage')).toBeNull();
    expect(procStartCandidates('Thu Jan 15 09:00:00 2026')[0]).toBe(ms);
    expect(procStartCandidates('2026-01-15T09:00:00.000Z')).toEqual([ms]);
    expect(procStartCandidates(String(ms))).toEqual([ms]);
    expect(procStartCandidates(String(ms / 1000))).toEqual([ms]);
    expect(procStartCandidates('')).toEqual([]);
    expect(procStartCandidates('Thu Foo 15 09:00:00 2026')).toEqual([]);
  });
});
