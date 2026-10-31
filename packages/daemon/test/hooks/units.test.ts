import type { HookPayload } from '@jantar/protocol';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { correlationKey, sha256Hex, canonicalJson } from '../../src/core/hash.js';
import { unifiedDiff } from '../../src/hooks/diff.js';
import { cardKey, displayCopy, errorText, kindForTool, isSubagentPayload, parseQuestions, toolSummary } from '../../src/hooks/keys.js';
import { compareKeys, parseMono, ReorderBuffer, type OrderKey } from '../../src/hooks/ordering.js';
import { notificationKind, statusForEvent } from '../../src/hooks/status-map.js';
import { hookEvent } from './helpers.js';

describe('ordering', () => {
  it('compares by monotonic stamp, then wall clock, then arrival', () => {
    const k = (ts: number, seq: number, mono?: bigint): OrderKey => (mono === undefined ? { ts, seq } : { ts, seq, mono });
    expect(compareKeys(k(5, 1, 10n), k(1, 2, 20n))).toBeLessThan(0); // mono wins over ts
    expect(compareKeys(k(5, 1), k(1, 2, 20n))).toBeGreaterThan(0); // no mono on one side: ts
    expect(compareKeys(k(1, 2), k(1, 1))).toBeGreaterThan(0);
    expect(parseMono('123')).toBe(123n);
    expect(parseMono('12a')).toBeUndefined();
    expect(parseMono(undefined)).toBeUndefined();
  });

  it('holds events for the window and releases them sorted', () => {
    const clock = new FakeClock();
    const out: string[] = [];
    const buf = new ReorderBuffer<string>(clock, 100, (s) => out.push(s));
    buf.push('c', { ts: 3, seq: 1, mono: 3n });
    clock.advance(30);
    buf.push('a', { ts: 1, seq: 2, mono: 1n });
    buf.push('b', { ts: 2, seq: 3, mono: 2n });
    clock.advance(69);
    expect(out).toEqual([]);
    clock.advance(1); // 'c' is due; 'a' and 'b' sort before it and go with it
    expect(out).toEqual(['a', 'b', 'c']);
    buf.push('late', { ts: 0, seq: 4, mono: 0n });
    clock.advance(100);
    expect(out).toEqual(['a', 'b', 'c', 'late']);
    expect(clock.pending()).toBe(0);
  });

  it('delivers at once with a zero window, and flushAll empties the buffer', () => {
    const clock = new FakeClock();
    const out: string[] = [];
    new ReorderBuffer<string>(clock, 0, (s) => out.push(s)).push('now', { ts: 1, seq: 1 });
    expect(out).toEqual(['now']);
    const buf = new ReorderBuffer<string>(clock, 100, (s) => out.push(s));
    buf.push('y', { ts: 2, seq: 2 });
    buf.push('x', { ts: 1, seq: 3 });
    buf.flushAll();
    expect(out).toEqual(['now', 'x', 'y']);
    expect(buf.size).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it('keeps going when a handler throws', () => {
    const clock = new FakeClock();
    const out: string[] = [];
    const buf = new ReorderBuffer<string>(clock, 0, (s) => {
      if (s === 'bad') throw new Error('boom');
      out.push(s);
    });
    buf.push('bad', { ts: 1, seq: 1 });
    buf.push('good', { ts: 2, seq: 2 });
    expect(out).toEqual(['good']);
  });
});

describe('keys', () => {
  it('correlation key: sid | tool | hash of canonical input (key order does not matter)', () => {
    const a = cardKey('s1', 'Bash', { command: 'ls', description: 'list' });
    const b = cardKey('s1', 'Bash', { description: 'list', command: 'ls' });
    expect(a).toBe(b);
    expect(a).toBe(`s1|Bash|${sha256Hex(canonicalJson({ command: 'ls', description: 'list' }))}`);
    // same identity as core's correlationKey(), with the input part hashed
    expect(a.split('|')[2]).toBe(sha256Hex(correlationKey('s1', 'Bash', { command: 'ls', description: 'list' }).split('|').slice(2).join('|')));
    expect(cardKey('s2', 'Bash', { command: 'ls', description: 'list' })).not.toBe(a);
    expect(cardKey('s1', 'Edit', { command: 'ls', description: 'list' })).not.toBe(a);
    expect(cardKey('s1', 'Bash', { command: 'ls -a', description: 'list' })).not.toBe(a);
    expect(cardKey('s1', 'Bash', undefined)).toBe(cardKey('s1', 'Bash', {}));
  });

  it('card kinds and subagent detection', () => {
    expect(kindForTool('AskUserQuestion')).toBe('question');
    expect(kindForTool('ExitPlanMode')).toBe('plan');
    expect(kindForTool('Bash')).toBe('permission');
    expect(isSubagentPayload({ agent_id: 'a' })).toBe(true);
    expect(isSubagentPayload({ agent_id: '' })).toBe(false);
    expect(isSubagentPayload({})).toBe(false);
    expect(parseQuestions({ questions: [{ question: 'Q?', options: [{ label: 'A' }] }] })).toHaveLength(1);
    expect(parseQuestions({ questions: [] })).toBeUndefined();
    expect(parseQuestions({ questions: [{ options: [] }] })).toBeUndefined();
    expect(parseQuestions('x')).toBeUndefined();
  });

  it('display copies cut long strings and arrays, keep the rest', () => {
    const long = 'a'.repeat(20_000);
    const copy = displayCopy({ s: long, n: 1, b: true, z: null, list: Array.from({ length: 600 }, (_, i) => i), skip: undefined }) as Record<string, unknown>;
    expect((copy.s as string).startsWith('a'.repeat(100))).toBe(true);
    expect(copy.s as string).toMatch(/… \[3616 more characters\]$/);
    expect(copy).toMatchObject({ n: 1, b: true, z: null });
    expect((copy.list as unknown[]).length).toBe(501);
    expect((copy.list as unknown[]).at(-1)).toBe('[100 more items]');
    expect('skip' in copy).toBe(false);
  });

  it('one-line tool summaries', () => {
    expect(toolSummary('Bash', { command: 'npm  test\n--ci' })).toBe('npm test --ci');
    expect(toolSummary('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('/a/b.ts');
    expect(toolSummary('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(toolSummary('WebFetch', { url: 'https://example.com' })).toBe('https://example.com');
    expect(toolSummary('Task', { description: 'Explore the repo' })).toBe('Explore the repo');
    expect(toolSummary('mcp__thing__do', { query: 'q' })).toBe('q');
    expect(toolSummary('Bash', 'nope')).toBe('');
    expect(toolSummary('Bash', { command: 'x'.repeat(500) })).toHaveLength(200);
  });

  it('error text', () => {
    expect(errorText('  rate limited  ')).toBe('rate limited');
    expect(errorText({ message: 'Overloaded' })).toBe('Overloaded');
    expect(errorText({ code: 529 })).toBe('{"code":529}');
    expect(errorText(undefined)).toBeUndefined();
    expect(errorText('')).toBeUndefined();
  });
});

describe('status map', () => {
  const p = (event: string, fields: Record<string, unknown> = {}) => hookEvent(event, fields) as HookPayload;
  it('maps hook events to statuses', () => {
    expect(statusForEvent(p('SessionStart'))).toEqual({ status: 'idle' });
    for (const e of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
      expect(statusForEvent(p(e))).toEqual({ status: 'working' });
    }
    expect(statusForEvent(p('Notification', { notification_type: 'permission_prompt' }))).toEqual({ status: 'waiting', waitingFor: 'permission' });
    expect(statusForEvent(p('Notification', { notification_type: 'idle_prompt' }))).toEqual({ status: 'idle' });
    expect(statusForEvent(p('Notification', { notification_type: 'auth_success' }))).toBeNull();
    expect(statusForEvent(p('Stop'))).toEqual({ status: 'idle' });
    expect(statusForEvent(p('StopFailure'))).toEqual({ status: 'idle' });
    expect(statusForEvent(p('PreCompact'))).toEqual({ status: 'compacting' });
    expect(statusForEvent(p('SessionEnd'))).toEqual({ status: 'ended' });
    expect(statusForEvent(p('SubagentStart'))).toBeNull();
    expect(statusForEvent(p('PermissionRequest'))).toBeNull();
    expect(statusForEvent(p('SomethingNew'))).toBeNull();
  });

  it('falls back to the message wording when notification_type is missing', () => {
    expect(notificationKind({ message: 'Claude needs your permission to use Bash' })).toBe('permission');
    expect(notificationKind({ message: 'Claude is waiting for your input' })).toBe('idle');
    expect(notificationKind({ message: 'something else' })).toBeNull();
  });
});

describe('unified diff', () => {
  it('shows added and removed lines with context and hunk headers', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
    const b = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n') + '\n';
    const d = unifiedDiff(a, b, { fromLabel: 'x (current)', toLabel: 'x (after)', context: 1 });
    expect(d).toBe(['--- x (current)', '+++ x (after)', '@@ -3,3 +3,3 @@', ' c', '-d', '+D', ' e', '@@ -10,1 +10,2 @@', ' j', '+k', ''].join('\n'));
    expect(unifiedDiff(a, a)).toBe('');
    expect(unifiedDiff('', 'x\n')).toContain('@@ -0,0 +1,1 @@\n+x\n');
    expect(unifiedDiff('x', 'x\n')).toContain('trailing newline added');
  });
});
