/**
 * G14 (spec 6.1): the shared runner's `io` option is additive. Every caller
 * from before 0.8 (Rewrite, Ask, Meetings, the food estimate) leaves it out,
 * so its argv is exactly 0.7's: `--output-format json`, never stream-json or
 * --verbose. Only Intel's read passes `io: 'stream'`. Read from the source
 * and pinned on the argv itself, for both ways a run starts (cswap, claude).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_OPTIONS, rewriteArgv, type RunFlags } from '../../src/rewrite/run.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const CALLERS = ['rewrite/service.ts', 'ask/service.ts', 'meetings/summary.ts', 'life/food/estimate.ts'];

const FLAGS: RunFlags = { account: 3 as RunFlags['account'], model: 'sonnet', fallbackModel: 'haiku', effort: 'low', systemPromptFile: '/synthetic/run/prompt.md' };

/** 0.7's argv after the program's own head, as every existing caller still gets it. */
const V07_TAIL = [
  '-p',
  '--output-format',
  'json',
  '--model',
  'sonnet',
  '--fallback-model',
  'haiku',
  '--effort',
  'low',
  '--max-turns',
  '1',
  '--max-budget-usd',
  '1.00',
  '--tools',
  '',
  '--disallowedTools',
  'mcp__*',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--setting-sources',
  'local',
  '--settings',
  '{"disableAllHooks":true}',
  '--permission-mode',
  'dontAsk',
  '--permission-prompts',
  'none',
  '--system-prompt-file',
  '/synthetic/run/prompt.md',
];

describe('G14: the runner callers from before 0.8', () => {
  it('none of them passes io or stream-json', () => {
    for (const f of CALLERS) {
      const text = readFileSync(join(SRC, f), 'utf8');
      expect(text, f).not.toMatch(/\bio\s*:/);
      expect(text, f).not.toContain('stream-json');
    }
    // Intel's read is the one stream caller.
    expect(readFileSync(join(SRC, 'intel', 'read', 'claude.ts'), 'utf8')).toContain("run('stream', ");
  });

  it('without io, and with io text, the argv is exactly 0.7\'s through cswap and through claude', () => {
    expect(rewriteArgv(FLAGS, 'cswap')).toEqual(['run', '--share-history', '3', '--', ...V07_TAIL]);
    expect(rewriteArgv(FLAGS, 'claude')).toEqual(V07_TAIL);
    expect(rewriteArgv({ ...FLAGS, io: 'text' }, 'claude')).toEqual(V07_TAIL);
  });

  it('stream swaps only the output option for the three stream ones, and they are never dropped', () => {
    const stream = rewriteArgv({ ...FLAGS, io: 'stream', dropped: new Set(CORE_OPTIONS) }, 'claude');
    expect(stream).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...V07_TAIL.slice(3)]);
  });
});
