/**
 * v0.10 (spec 0.10 B6.4, B6.5): the shared runner's tools mode for Chat,
 * the init check and the streamed stdout. Every caller without `tools`
 * keeps its argv byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { createExecFile } from '../../src/core/exec.js';
import { createFakeExec, onCommand } from '../../src/core/testing.js';
import {
  DROPPABLE_OPTIONS,
  ISOLATION_OPTIONS,
  TOOLS_ISOLATION_OPTIONS,
  initOfLine,
  initProblem,
  lineSplitter,
  refusedOption,
  rewriteArgv,
  type RunFlags,
} from '../../src/rewrite/run.js';

const base: RunFlags = { account: 3, model: 'sonnet', fallbackModel: 'haiku', effort: 'low', systemPromptFile: '/synthetic/run/chat-v1.md' };
const ALLOWED = ['mcp__jantar__today', 'mcp__jantar__todo_add'];

describe('rewriteArgv: tools mode', () => {
  it('is exactly the spec argv after cswap', () => {
    const argv = rewriteArgv({ ...base, tools: { mcpConfig: '/synthetic/run/mcp.json', allowed: ALLOWED, maxTurns: 12 } });
    expect(argv).toEqual([
      'run', '--share-history', '3', '--', '-p',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', 'sonnet', '--fallback-model', 'haiku', '--effort', 'low',
      '--max-turns', '12', '--max-budget-usd', '1.00',
      '--tools', '',
      '--mcp-config', '/synthetic/run/mcp.json', '--strict-mcp-config',
      '--allowedTools', 'mcp__jantar__today,mcp__jantar__todo_add',
      '--disable-slash-commands', '--no-session-persistence',
      '--setting-sources', 'local', '--settings', '{"disableAllHooks":true}',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--system-prompt-file', '/synthetic/run/chat-v1.md',
    ]);
    expect(argv).not.toContain('--disallowedTools');
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--bare');
  });

  it('on one login it starts at -p, and a voice run caps turns at 6', () => {
    const argv = rewriteArgv({ ...base, account: null, tools: { mcpConfig: '/m.json', allowed: ALLOWED, maxTurns: 6 } }, 'claude');
    expect(argv[0]).toBe('-p');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('6');
  });

  it('refuses a wildcard or an empty allow list', () => {
    expect(() => rewriteArgv({ ...base, tools: { mcpConfig: '/m.json', allowed: ['mcp__*'], maxTurns: 6 } })).toThrow();
    expect(() => rewriteArgv({ ...base, tools: { mcpConfig: '/m.json', allowed: [], maxTurns: 6 } })).toThrow();
    expect(() => rewriteArgv({ ...base, tools: { mcpConfig: '/m.json', allowed: ['Bash'], maxTurns: 6 } })).toThrow();
  });

  it('every caller without tools keeps its argv byte for byte', () => {
    expect(rewriteArgv(base)).toEqual([
      'run', '--share-history', '3', '--', '-p',
      '--output-format', 'json',
      '--model', 'sonnet', '--fallback-model', 'haiku', '--effort', 'low',
      '--max-turns', '1', '--max-budget-usd', '1.00',
      '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config',
      '--disable-slash-commands', '--no-session-persistence',
      '--setting-sources', 'local', '--settings', '{"disableAllHooks":true}',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--system-prompt-file', '/synthetic/run/chat-v1.md',
    ]);
    const stream = rewriteArgv({ ...base, io: 'stream' }, 'claude');
    expect(stream.slice(0, 5)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']);
    expect(stream).toContain('--disallowedTools');
  });

  it('--mcp-config and --allowedTools are isolation options: never dropped', () => {
    expect(TOOLS_ISOLATION_OPTIONS).toEqual(['--mcp-config', '--allowedTools']);
    for (const o of ISOLATION_OPTIONS.filter((x) => x !== '--disallowedTools')) {
      expect(rewriteArgv({ ...base, tools: { mcpConfig: '/m.json', allowed: ALLOWED, maxTurns: 6 } })).toContain(o);
    }
    expect(DROPPABLE_OPTIONS).not.toContain('--mcp-config');
    expect(refusedOption("error: unknown option '--mcp-config'")).toBe('--mcp-config');
    const kept = rewriteArgv({ ...base, dropped: new Set(['--mcp-config', '--allowedTools', '--effort']), tools: { mcpConfig: '/m.json', allowed: ALLOWED, maxTurns: 6 } });
    expect(kept).toContain('--mcp-config');
    expect(kept).toContain('--allowedTools');
    expect(kept).not.toContain('--effort');
  });
});

describe('initProblem', () => {
  const ok = { tools: [...ALLOWED].reverse(), mcpServers: [{ name: 'jantar', status: 'connected' }] };
  it('passes exactly the one server and the allowed tools, in any order', () => {
    expect(initProblem(ok, 'jantar', ALLOWED)).toBeNull();
  });
  it('fails a missing line, a built-in tool, a missing or extra server, a failed one', () => {
    expect(initProblem(null, 'jantar', ALLOWED)).toBe('no_init');
    expect(initProblem({ ...ok, tools: [...ALLOWED, 'Bash'] }, 'jantar', ALLOWED)).toBe('tools');
    expect(initProblem({ ...ok, tools: ['mcp__jantar__today'] }, 'jantar', ALLOWED)).toBe('tools');
    expect(initProblem({ ...ok, tools: ['mcp__jantar__today', 'mcp__jantar__today'] }, 'jantar', ALLOWED)).toBe('tools');
    expect(initProblem({ ...ok, mcpServers: [] }, 'jantar', ALLOWED)).toBe('servers');
    expect(initProblem({ ...ok, mcpServers: [{ name: 'jantar', status: 'failed' }] }, 'jantar', ALLOWED)).toBe('servers');
    expect(initProblem({ ...ok, mcpServers: [{ name: 'jantar', status: 'connected' }, { name: 'other', status: 'connected' }] }, 'jantar', ALLOWED)).toBe('servers');
  });
  it('initOfLine reads one line', () => {
    expect(initOfLine(JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }))).toEqual({ tools: [], mcpServers: [] });
    expect(initOfLine('{"type":"assistant"}')).toBeNull();
    expect(initOfLine('not json')).toBeNull();
  });
});

describe('lineSplitter and onStdout', () => {
  it('hands over whole lines only', () => {
    const lines: string[] = [];
    const split = lineSplitter((l) => lines.push(l));
    split.push('{"a":');
    split.push('1}\n{"b"');
    split.push(':2}\n\n{"c":3}');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    split.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('the real exec streams stdout whole characters at a time; the result is unchanged', async () => {
    const chunks: string[] = [];
    const exec = createExecFile();
    const script = "process.stdout.write(Buffer.from([0xe0, 0xa4])); setTimeout(() => process.stdout.write(Buffer.from([0x9c, 0x0a])), 20);";
    const r = await exec(process.execPath, ['-e', script], { onStdout: (c) => chunks.push(c), timeoutMs: 10_000 });
    expect(r.stdout).toBe('ज\n');
    expect(chunks.join('')).toBe('ज\n');
    expect(chunks.every((c) => !c.includes('�'))).toBe(true);
  });

  it('the fake exec hands its stdout over too', async () => {
    const seen: string[] = [];
    const exec = createFakeExec(onCommand('claude', { stdout: 'line\n' }));
    await exec('/synthetic/claude', [], { onStdout: (c) => seen.push(c) });
    expect(seen).toEqual(['line\n']);
  });
});
