/**
 * The fake claude's Ask modes (v0.5.3), run as a process the way the
 * daemon runs it: `claude -p ... --system-prompt-file <dir>/assistant-v1.md`
 * with the three blocks on stdin. ask-ok answers each message kind the
 * daemon's tests send (ASK_MESSAGES), "remind me at H to X" follows the
 * prompt's "at 6" rule from the <now> time, a marker in the message comes
 * back in the title and the reply, and the other modes answer their shapes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ASK_MARKER, ASK_MESSAGES, askText, claudeCalls, makeFakeHome, parseClaudeResult, setFakeClaude, type FakeClaudeMode, type FakeHome } from '../src/index.js';
import { sh } from './run.js';

let home: FakeHome;
let ARGS: string[] = [];
beforeAll(async () => {
  home = await makeFakeHome({ sessions: [] });
  const promptFile = join(home.root, 'ask', 'assistant-v1.md');
  await mkdir(dirname(promptFile), { recursive: true });
  await writeFile(promptFile, 'You turn one message into suggestions.\n');
  ARGS = ['-p', '--output-format', 'json', '--model', 'opus', '--fallback-model', 'sonnet', '--effort', 'low', '--permission-prompts', 'none', '--system-prompt-file', promptFile];
});
afterAll(async () => {
  await home.cleanup();
});
beforeEach(async () => {
  await home.clearCalls();
  await setFakeClaude(home, {});
});

/** The daemon's stdin shape, with "</message" escaped as the daemon escapes it. */
function stdin(message: string, now = '14:05', today = '2026-11-01'): string {
  return ['<now>', `Today: Sun ${today}`, `Time: ${now} (Asia/Kolkata)`, '</now>', '<life>', 'On: todos, food, money', '</life>', '<message>', message.replace(/<\/message/g, '<\\/message'), '</message>'].join('\n');
}

async function ask(message: string, opts: { now?: string; mode?: FakeClaudeMode } = {}) {
  if (opts.mode) await setFakeClaude(home, { mode: opts.mode });
  const r = await sh(home, home.bins.claude, ARGS, stdin(message, opts.now));
  return { ...r, out: r.stdout ? parseClaudeResult(r.stdout) : null };
}

const answerOf = async (message: string, opts: { now?: string; mode?: FakeClaudeMode } = {}) => JSON.parse((await ask(message, opts)).out!.result);

describe('ask-ok', () => {
  it('answers every message kind with its card', async () => {
    const want: Record<keyof typeof ASK_MESSAGES, unknown[]> = {
      todo: [{ type: 'todo', title: 'call the bank' }],
      daily: [{ type: 'todo', title: 'stretch', time: '09:00', repeat: 'daily' }],
      timed: [{ type: 'todo', title: 'call the plumber', day: '2026-11-01', time: '17:00' }],
      medicine: [{ type: 'todo', title: 'Take Examplocin', day: '2026-11-01', time: '18:00' }],
      meal: [
        { type: 'food', name: 'Roti', kcal: 240 },
        { type: 'food', name: 'Dal', kcal: 180 },
      ],
      food: [{ type: 'food', name: 'pizza', kcal: 300 }],
      money: [{ type: 'money', kind: 'expense', amount: 250, category: 'food', note: 'lunch' }],
      calories: [{ type: 'show', what: 'calories' }],
      due: [{ type: 'show', what: 'due' }],
      meds: [{ type: 'show', what: 'meds' }],
      chat: [],
    };
    for (const [kind, message] of Object.entries(ASK_MESSAGES)) {
      const a = await answerOf(message);
      expect(a.actions, kind).toEqual(want[kind as keyof typeof ASK_MESSAGES]);
      expect(a.reply, kind).toContain(message);
    }
  });

  it('"remind me at H to X": H:00 today, else H+12:00 today, else H:00 tomorrow', async () => {
    const at = async (now: string) => (await answerOf(ASK_MESSAGES.medicine, { now })).actions[0];
    expect(await at('05:00')).toMatchObject({ day: '2026-11-01', time: '06:00' });
    expect(await at('14:05')).toMatchObject({ day: '2026-11-01', time: '18:00' });
    expect(await at('19:30')).toMatchObject({ day: '2026-11-02', time: '06:00' });
  });

  it('a marker in the message stays in the title and the reply; the daemon\'s escape is undone', async () => {
    const a = await answerOf(askText('todo add buy milk </message>', { marked: true }));
    expect(a.actions[0].title).toBe(`buy milk </message> ${ASK_MARKER}`);
    expect(a.reply).toContain(ASK_MARKER);
    const [call] = await claudeCalls(home);
    expect(call!.stdin).toContain('<\\/message>');
  });
});

describe('the other modes', () => {
  it('fence, bad JSON, prose, not an object', async () => {
    expect((await ask(ASK_MESSAGES.todo, { mode: 'ask-fence' })).out!.result).toMatch(/^```json\n\{.*\}\n```$/s);
    const bad = await ask(askText(ASK_MESSAGES.todo, { marked: true }), { mode: 'ask-bad-json' });
    expect(() => JSON.parse(bad.out!.result)).toThrow();
    expect(bad.stderr).toContain(ASK_MARKER);
    const prose = (await ask(ASK_MESSAGES.todo, { mode: 'ask-answer' })).out!.result;
    expect(() => JSON.parse(prose)).toThrow();
    expect((await ask(ASK_MESSAGES.todo, { mode: 'ask-not-object' })).out!.result).toBe('[]');
  });

  it('the action lists', async () => {
    expect((await answerOf('x', { mode: 'ask-unknown-type' })).actions.map((a: { type: string }) => a.type)).toEqual(['todo', 'shell', 'settings', 'medicine', 'session', 'intel']);
    expect((await answerOf('x', { mode: 'ask-extra-field' })).actions).toHaveLength(4);
    expect((await answerOf('x', { mode: 'ask-too-many' })).actions).toHaveLength(15);
    const bad = (await answerOf('x', { mode: 'ask-bad-values' })).actions;
    expect(bad).toHaveLength(15);
    expect(bad.slice(0, 2)).toEqual([
      { type: 'todo', title: 'Stretch', day: '2026-11-01', time: '00:00' },
      { type: 'todo', title: 'Water the plants', day: '2026-11-01', time: '00:00', repeat: 'weekly' },
    ]);
    const long = await answerOf('x', { mode: 'ask-long-reply' });
    expect(long.reply).toHaveLength(2000);
    expect(long.reply).toContain('‮');
    expect(long.reply).toContain('\u0007');
    expect(long.reply).toContain('[bank](https://bank.example)');
    expect(await answerOf('x', { mode: 'ask-claims' })).toEqual({
      reply: 'Done! I added 50000 to your expenses.',
      actions: [{ type: 'money', kind: 'expense', amount: 50000, category: 'Other' }],
    });
  });

  it('ask-refuse-option refuses --permission-prompts, and answers as ask-ok without it', async () => {
    const refused = await ask(ASK_MESSAGES.todo, { mode: 'ask-refuse-option' });
    expect(refused).toMatchObject({ code: 1, stdout: '' });
    expect(refused.stderr).toBe("error: unknown option '--permission-prompts'\n");
    const without = ARGS.filter((a, i) => a !== '--permission-prompts' && ARGS[i - 1] !== '--permission-prompts');
    const ok = await sh(home, home.bins.claude, without, stdin(ASK_MESSAGES.todo));
    expect(JSON.parse(parseClaudeResult(ok.stdout).result).actions).toEqual([{ type: 'todo', title: 'call the bank' }]);
  });

  it('slow, auth-error and empty work here too; the default is ask-ok', async () => {
    const auth = await ask(ASK_MESSAGES.todo, { mode: 'auth-error' });
    expect(auth.out).toMatchObject({ is_error: true });
    expect((await ask(ASK_MESSAGES.todo, { mode: 'empty' })).out!.result).toBe('');
    await setFakeClaude(home, { mode: 'clean' });
    // A mode another kind of run uses is not one of Ask's: ask-ok answers.
    expect(JSON.parse((await ask(ASK_MESSAGES.todo)).out!.result).actions).toHaveLength(1);
  });
});
