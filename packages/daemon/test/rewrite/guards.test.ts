/**
 * The guards on what the prompt writer wrote (spec 4.3 "Output and guards",
 * rule R7). They flag; they never block Send.
 */
import { describe, expect, it } from 'vitest';
import { candidateTokens, checkPrompt, normaliseOutput, rebuildSpoken } from '../../src/rewrite/guards.js';

describe('normaliseOutput', () => {
  it('trims, unwraps one pair of quotes or one code fence, and strips one preface', () => {
    expect(normaliseOutput('  Run the tests.\n')).toEqual({ text: 'Run the tests.', preface: false });
    expect(normaliseOutput('"Run the tests."')).toEqual({ text: 'Run the tests.', preface: false });
    expect(normaliseOutput('“Run the tests.”')).toEqual({ text: 'Run the tests.', preface: false });
    expect(normaliseOutput('```\nRun the tests.\n```')).toEqual({ text: 'Run the tests.', preface: false });
    expect(normaliseOutput('```text\nRun the tests.\n```')).toEqual({ text: 'Run the tests.', preface: false });
    expect(normaliseOutput("Here's the prompt: Run the tests.")).toEqual({ text: 'Run the tests.', preface: true });
    expect(normaliseOutput('Here is your prompt for the session:\nRun the tests.')).toEqual({ text: 'Run the tests.', preface: true });
    expect(normaliseOutput('Here’s the message: Run the tests.')).toEqual({ text: 'Run the tests.', preface: true });
  });

  it('keeps quotes that do not wrap the whole text, and only one preface', () => {
    expect(normaliseOutput('"Fix it" and "test it"').text).toBe('"Fix it" and "test it"');
    expect(normaliseOutput("Here's the prompt: Here's the prompt: x").text).toBe("Here's the prompt: x");
  });

  it('keeps the fences of two code blocks with text between them', () => {
    const two = '```sh\npnpm test\n```\nThen run:\n```sh\npnpm lint\n```';
    expect(normaliseOutput(two)).toEqual({ text: two, preface: false });
  });

  it('unwraps the quotes or fence that follow a preface', () => {
    expect(normaliseOutput('Here is your prompt: "Fix it"')).toEqual({ text: 'Fix it', preface: true });
    expect(normaliseOutput('Here is the prompt:\n```\nFix it\n```')).toEqual({ text: 'Fix it', preface: true });
    expect(normaliseOutput('"Here is your prompt: Fix it"')).toEqual({ text: 'Fix it', preface: true });
  });

  it('drops control characters and CRLF, which the writer would refuse', () => {
    expect(normaliseOutput('Run\r\nthe \u001b[31mtests\u0007\tnow').text).toBe('Run\nthe [31mtests\tnow');
  });

  it('drops bidi embeddings, overrides, isolates and marks; Unicode line separators become line feeds', () => {
    expect(normaliseOutput('Run \u202etset\u202c the \u2066a\u2069 \u200fb\u200e\u061c tests').text).toBe('Run tset the a b tests');
    expect(normaliseOutput('one\u2028two\u2029three').text).toBe('one\ntwo\nthree');
  });

  it('an empty or whitespace result stays empty', () => {
    expect(normaliseOutput('   \n ').text).toBe('');
    expect(normaliseOutput('""').text).toBe('');
  });
});

describe('rebuildSpoken', () => {
  it('rebuilds dot, slash, dash dash, dash and underscore', () => {
    expect(rebuildSpoken('jo send dot ts hai')).toBe('jo send.ts hai');
    expect(rebuildSpoken('pnpm dash dash filter web build')).toBe('pnpm --filter web build');
    expect(rebuildSpoken('git push dash dash force')).toBe('git push --force');
    expect(rebuildSpoken('slash compact')).toBe('/compact');
    expect(rebuildSpoken('src slash ui slash App dot tsx')).toBe('src/ui/app.tsx');
    expect(rebuildSpoken('re dash run my underscore var')).toBe('re-run my_var');
  });
});

describe('candidateTokens', () => {
  it('finds backticked tokens, file names, paths, URLs and --flags', () => {
    expect(
      candidateTokens('In `send.ts`, update src/ui/App.tsx and README.md, run `pnpm test` with --force, see https://example.com/a/b.'),
    ).toEqual(['send.ts', 'pnpm test', 'https://example.com/a/b', 'src/ui/App.tsx', 'README.md', '--force']);
  });

  it('leaves out numbers, versions, abbreviations and and/or', () => {
    expect(candidateTokens('Raise it from 1.5 to 2.0, e.g. v1.2.3, and/or later.')).toEqual([]);
  });
});

describe('checkPrompt (R7)', () => {
  const ctx = ['packages/web/src/ui/shell/Palette.tsx', '[assistant 13:59] I changed proof.ts'];

  it('R7: an invented src/new-file.ts lands in newTokens', () => {
    const g = checkPrompt({
      input: 'haan toh jo send dot ts hai na usme timeout badha do',
      output: 'In `send.ts`, raise the timeout. Also update `src/new-file.ts` and add tests.',
      context: ctx,
    });
    expect(g.newTokens).toEqual(['src/new-file.ts']);
    expect(g.flags.newTokens).toBe(1);
  });

  it('tokens from what was said (spoken forms rebuilt), the vocabulary or the conversation are not new', () => {
    const g = checkPrompt({
      input: 'pallet dot tsx mein shortcut badlo, proof dot ts bhi, pnpm dash dash filter web build chalao',
      output: 'In `Palette.tsx`, change the shortcut, and `proof.ts` too. Run `pnpm --filter web build`.',
      context: ctx,
    });
    expect(g.newTokens).toEqual([]);
    expect(g.flags).toEqual({ expanded: false, newTokens: 0, leading: null });
  });

  it('R7: an output more than 2.5 x the input + 300 chars sets expanded', () => {
    const input = 'x'.repeat(200);
    expect(checkPrompt({ input, output: 'y'.repeat(800), context: [] }).flags.expanded).toBe(false);
    expect(checkPrompt({ input, output: 'y'.repeat(801), context: [] }).flags.expanded).toBe(true);
    const said = 'what does this function do';
    expect(checkPrompt({ input: said, output: `Sure! Here's how it works. ${'It does things. '.repeat(30)}`, context: [] }).flags.expanded).toBe(true);
  });

  it('R7: a leading "!" is always flagged bang', () => {
    expect(checkPrompt({ input: 'bang rm rf dist', output: '!rm -rf dist', context: [] }).flags.leading).toBe('bang');
  });

  it('a leading "/" is flagged unless the user said "slash" or typed "/"', () => {
    expect(checkPrompt({ input: 'compact karo', output: '/compact', context: [] }).flags.leading).toBe('slash');
    expect(checkPrompt({ input: 'slash compact', output: '/compact', context: [] }).flags.leading).toBeNull();
    expect(checkPrompt({ input: '/compact keep notes', output: '/compact keep notes', context: [] }).flags.leading).toBeNull();
  });

  it('reports at most 50 new tokens', () => {
    const output = Array.from({ length: 70 }, (_, i) => `file${i}.ts`).join(' ');
    const g = checkPrompt({ input: 'do it', output, context: [] });
    expect(g.newTokens).toHaveLength(50);
    expect(g.flags.newTokens).toBe(50);
  });
});
