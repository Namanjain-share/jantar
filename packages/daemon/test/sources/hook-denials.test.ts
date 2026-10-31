/**
 * A tool call a PreToolUse hook blocked reads `blocked`, for the alert
 * scanner and the changed-files scanner alike. The texts are Claude Code's
 * own (2.1.310 to 2.1.314 build them the same way): "<hook name> hook
 * error: <blocking error>", where a command hook that exits 2 gives
 * "[<command>]: <stderr>" and a JSON deny gives its reason;
 * "Hook PreToolUse:<tool> denied this tool" for a deny without a reason;
 * "Execution stopped by PreToolUse hook" when the hook also stopped the turn.
 */
import { describe, expect, it } from 'vitest';
import { assistantToolUse, timeline, toolResult, type Entry } from '@jantar/fixtures';
import { AlertScanner, denialKind } from '../../src/sources/transcripts/alerts.js';
import { FileChangeScanner, type ScannedOp } from '../../src/sources/transcripts/file-changes.js';

const EXIT_2 = 'PreToolUse:Bash hook error: [/synthetic/home/.claude/hooks/guard.sh]: Blocked: rm -rf is not allowed here\nAsk the user first.';
/** A command with brackets of its own (Claude's own pattern allows one level). */
const NESTED = 'PreToolUse:Write hook error: [python3 /synthetic/hooks/[guard].py]: Writes under dist/ are blocked';
const NO_STDERR = 'PreToolUse:Edit hook error: [./check.sh]: No stderr output';
const JSON_REASON = 'PreToolUse:Edit hook error: Edits to generated files are blocked';
const JSON_DEFAULT = 'PreToolUse:mcp__files__write hook error: Blocked by hook';
const NO_REASON = 'Hook PreToolUse:Write denied this tool';
const STOPPED = 'Execution stopped by PreToolUse hook: the release freeze is on';

describe('denialKind: a PreToolUse hook block', () => {
  it('reads blocked in every wording Claude Code uses', () => {
    for (const text of [EXIT_2, NESTED, NO_STDERR, JSON_REASON, JSON_DEFAULT, NO_REASON, STOPPED, 'Execution stopped by PreToolUse hook']) {
      expect(denialKind(text), text).toBe('blocked');
    }
    expect(denialKind(`\n  ${EXIT_2}`)).toBe('blocked');
  });

  it('other hooks, other wording and quotes of it are not a block', () => {
    for (const text of [
      'PostToolUse:Write hook error: [lint.sh]: 3 problems',
      'UserPromptSubmit hook error: x',
      'Stop hook error: x',
      `Note: ${EXIT_2}`,
      'PreToolUse hook error: no tool named',
      'Hook PreToolUse:Write allowed this tool',
      'Execution stopped by Stop hook',
    ]) {
      expect(denialKind(text), text).toBeNull();
    }
  });
});

describe('the alert scanner', () => {
  it('says which call a hook blocked and why, without the hook command', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', 'sess-hooks', '/w/app');
    const scanner = new AlertScanner();
    const calls: Array<[string, unknown, string]> = [
      ['Bash', { command: 'rm -rf build' }, EXIT_2],
      ['Write', { file_path: '/w/app/dist/out.js', content: 'x' }, NESTED],
      ['Edit', { file_path: '/w/app/src/gen.ts', old_string: 'a', new_string: 'b' }, JSON_REASON],
      ['Write', { file_path: '/w/app/a.txt', content: 'x' }, NO_REASON],
      ['Bash', { command: 'git push' }, STOPPED],
    ];
    const found = calls.flatMap(([tool, input, text], i) => {
      const id = `toolu_h${i}`;
      scanner.scan(assistantToolUse(tl.next(), tool, input, id) as never, i * 2, 0);
      return scanner.scan(toolResult(tl.next(), id, text, true) as never, i * 2 + 1, 0);
    });
    expect(found.map((a) => [a.kind, a.what, a.why])).toEqual([
      ['blocked', 'hook: Bash · rm -rf build', 'Blocked: rm -rf is not allowed here'],
      ['blocked', 'hook: Write · out.js', 'Writes under dist/ are blocked'],
      ['blocked', 'hook: Edit · gen.ts', 'Edits to generated files are blocked'],
      ['blocked', 'hook: Write · a.txt', undefined],
      ['blocked', 'hook: Bash · git push', 'the release freeze is on'],
    ]);
    expect(found.map((a) => a.why ?? '').join('\n')).not.toContain('guard');
  });
});

describe('the changed-files scanner', () => {
  it('a Write or Edit a hook blocked is a blocked op, not an error', () => {
    const tl = timeline('2026-01-15T10:00:00.000Z', 'sess-hooks', '/w/app');
    const scanner = new FileChangeScanner();
    const denied = (id: string, text: string): Entry => {
      const e = toolResult(tl.next(), id, text, true);
      e.toolUseResult = `Error: ${text}`;
      return e;
    };
    const entries = [
      assistantToolUse(tl.next(), 'Write', { file_path: '/w/app/dist/out.js', content: 'x' }, 'toolu_w'),
      denied('toolu_w', NESTED),
      assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/src/gen.ts', old_string: 'a', new_string: 'b' }, 'toolu_e'),
      denied('toolu_e', NO_REASON),
      assistantToolUse(tl.next(), 'Edit', { file_path: '/w/app/src/app.ts', old_string: 'nope', new_string: 'b' }, 'toolu_x'),
      denied('toolu_x', 'String to replace not found in file.'),
    ];
    const ops: ScannedOp[] = [];
    let offset = 0;
    for (const e of entries) {
      const line = JSON.stringify(e);
      ops.push(...scanner.scan(e, offset, Buffer.byteLength(line), 0));
      offset += Buffer.byteLength(line) + 1;
    }
    expect(ops.map((o) => [o.opId, o.status])).toEqual([
      ['toolu_w', 'blocked'],
      ['toolu_e', 'blocked'],
      ['toolu_x', 'error'],
    ]);
  });
});
