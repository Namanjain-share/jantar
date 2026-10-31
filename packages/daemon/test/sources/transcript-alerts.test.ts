/**
 * The denial texts shared by the alert scanner and the changed-files scanner
 * (v0.3: a Write or Edit refused this way is a `blocked` or `rejected` op).
 */
import { describe, expect, it } from 'vitest';
import { AlertScanner, denialKind, toolResultText } from '../../src/sources/transcripts/alerts.js';

const AUTO_MODE =
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: Deleting the build folder is destructive. If you have a reason, ask the user.';
const SAFETY = 'Permission for this Edit was denied by a built-in Claude Code safety check for sensitive files. Writing to .git is not allowed.';
const DENY_RULE = 'Permission to use Write with file_path /w/a/.env has been denied.';
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nwrite it to docs/ instead";

describe('denialKind', () => {
  it('names blocked and rejected tool results, and nothing else', () => {
    expect([AUTO_MODE, SAFETY, DENY_RULE].map(denialKind)).toEqual(['blocked', 'blocked', 'blocked']);
    expect(denialKind(REJECTED)).toBe('rejected');
    expect(denialKind(`  \n${REJECTED}`)).toBe('rejected');
    for (const other of ['File does not exist.', 'String to replace not found in file.', '', `Note: ${DENY_RULE}`]) {
      expect(denialKind(other), other).toBeNull();
    }
  });

  it('agrees with the alert scanner', () => {
    const scanner = new AlertScanner();
    const texts = [AUTO_MODE, SAFETY, DENY_RULE, REJECTED, 'File does not exist.'];
    const entry = {
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: texts.map((content, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, content, is_error: true })) },
    };
    const found = scanner.scan(entry, 0, 0);
    expect(found.map((a) => [a.key, a.kind])).toEqual(texts.flatMap((t, i) => (denialKind(t) ? [[`u-1#${i}`, denialKind(t)]] : [])));
  });
});

describe('toolResultText', () => {
  it('reads string content and joins text parts', () => {
    expect(toolResultText({ type: 'tool_result', content: REJECTED })).toBe(REJECTED);
    expect(toolResultText({ type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a  b');
    expect(toolResultText({ type: 'tool_result' })).toBe('');
  });
});
