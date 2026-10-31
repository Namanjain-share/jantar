/**
 * The real parts of terminal/dialog.ts in wave 0 (spec 2.3, last
 * paragraphs): `screenKey` hashes exactly lines the phone was shown, cut
 * after the last box edge unless a pointer row comes after it (K2, daemon
 * part), `screenKeyRange` says where they
 * are, and `rawSlice` cuts Terminal's own text exactly, trailing spaces and
 * CRLF kept (D10, the substring half). `dialogOfScreen` is lane L1's.
 */
import { describe, expect, it } from 'vitest';
import { DIALOG_FIXTURES, NOT_DIALOG_SCREENS, dialogFixture } from '@jantar/fixtures';
import { sha256Hex } from '../../src/core/hash.js';
import { rawSlice, screenKey, screenKeyRange } from '../../src/terminal/dialog.js';
import { isBoxEdge, lastLines, screenLines } from '../../src/terminal/screen.js';

const RULE = '─'.repeat(80);
const NAME = `${'─'.repeat(73)} demo ─`;

/** A row with the highlight on it, as menu.ts reads one. */
const POINTER = /^\s*[❯›](\s|$)/u;

/** A cut's lines as screenLines reads each one (trailing spaces trimmed), blank ones kept. */
const linesOf = (cut: string) => cut.split(/\r\n|\r|\n/u).map((l) => l.replace(/\s+$/u, ''));

const screenWith = (status: string, above = 'older output') =>
  [above, ...Array.from({ length: 45 }, (_, i) => `line ${i}`), ' ❯ 1. Yes', '   2. No', '', ' Enter to confirm · Esc to cancel', RULE, NAME, status].join('\n');

describe('screenKeyRange', () => {
  it('names the last `lines` lines, cut after the last box edge among them', () => {
    const text = screenWith('  ⏵⏵ auto mode on (shift+tab to cycle)');
    const all = screenLines(text);
    const r = screenKeyRange(text, 40);
    expect(r.from).toBe(all.length - 40);
    expect(all[r.to]).toBe(NAME);
    expect(r.to).toBe(all.length - 2);
    // Exactly the lines the phone shows, minus those under the box.
    expect(all.slice(r.from, r.to + 1)).toEqual(lastLines(text, 40).slice(0, -1));
  });

  it('keeps every line when there is no box edge, and is empty for an empty screen', () => {
    const text = ['a', 'b', 'c'].join('\n');
    expect(screenKeyRange(text, 40)).toEqual({ from: 0, to: 2 });
    const empty = screenKeyRange('', 40);
    expect(empty.to).toBeLessThan(empty.from);
    expect(screenKeyRange('a\nb', 0).to).toBeLessThan(screenKeyRange('a\nb', 0).from);
  });

  it('K2: every line it names is one the phone was shown', () => {
    const screens = [...DIALOG_FIXTURES.map((f) => f.screen), ...Object.values(NOT_DIALOG_SCREENS)];
    for (const text of screens) {
      for (const lines of [40, 12, 80]) {
        const r = screenKeyRange(text, lines);
        const shown = lastLines(text, lines);
        const named = screenLines(text).slice(r.from, r.to + 1);
        expect(named).toEqual(shown.slice(0, named.length));
        // Nothing after the last box edge is in it, unless a pointer row comes after that edge.
        const lastEdge = shown.findLastIndex((l) => isBoxEdge(l));
        const lastPointer = shown.findLastIndex((l) => POINTER.test(l));
        if (lastEdge >= 0 && lastEdge > lastPointer) expect(named).toHaveLength(lastEdge + 1);
        else expect(named).toEqual(shown);
      }
    }
  });

  it("keeps a dialog's rows when its only rule is above them, so the keypad sees the pointer", () => {
    // Screens the keypad is for: no buttons, a pointer, and no bottom edge (outside fullscreen).
    const screens = {
      MODEL_PICKER: NOT_DIALOG_SCREENS.MODEL_PICKER as string,
      MCP_FORM: NOT_DIALOG_SCREENS.MCP_FORM as string,
      PERM_DEFAULT_NO: dialogFixture('PERM_DEFAULT_NO').screen,
      PERM_LONE_SUBMIT: dialogFixture('PERM_LONE_SUBMIT').screen,
      Q_SCROLLED: dialogFixture('Q_SCROLLED').screen,
    };
    for (const [name, text] of Object.entries(screens)) {
      const all = screenLines(text);
      const r = screenKeyRange(text, 40);
      expect(r, name).toEqual({ from: 0, to: all.length - 1 });
      expect(all.slice(r.from, r.to + 1).some((l) => POINTER.test(l)), name).toBe(true);
    }
    // A list with no pointer at all is still cut at its rule (the keypad refuses it: K5).
    const plain = NOT_DIALOG_SCREENS.NO_POINTER_LIST as string;
    expect(screenKeyRange(plain, 40).to).toBe(screenLines(plain).findIndex((l) => isBoxEdge(l)));
  });

  it("still drops the mode line under Claude's input box, a draft that starts like a row included", () => {
    for (const name of ['IDLE_DRAFT', 'CTRL_C_AGAIN', 'INTERRUPTED', 'ANSWERED_ABOVE_BOX']) {
      const text = NOT_DIALOG_SCREENS[name] as string;
      const all = screenLines(text);
      const r = screenKeyRange(text, 40);
      expect(r.to, name).toBe(all.length - 2);
      expect(isBoxEdge(all[r.to] ?? ''), name).toBe(true);
    }
  });

  it('a pointer under the bottom edge keeps every shown line (a ticking status line then fails the check, safely)', () => {
    const text = ['older output', RULE, ' Pick one', ' ❯ 1. Yes', '   2. No', RULE, NAME, ' › one background task'].join('\n');
    expect(screenKeyRange(text, 40)).toEqual({ from: 0, to: 7 });
  });
});

describe('screenKey', () => {
  it('is the sha256 of the named lines joined with newlines', () => {
    const text = screenWith('status');
    const r = screenKeyRange(text, 40);
    expect(screenKey(text, 40)).toBe(sha256Hex(screenLines(text).slice(r.from, r.to + 1).join('\n')));
    expect(screenKey(text, 40)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores the mode and status lines under the box, and lines above what the phone shows', () => {
    const base = screenKey(screenWith('  ⏵⏵ auto mode on (shift+tab to cycle)'), 40);
    expect(screenKey(screenWith('  ⏸ manual mode on · ? for shortcuts'), 40)).toBe(base);
    expect(screenKey(screenWith('  ⏵⏵ auto mode on (shift+tab to cycle)', 'a line far above'), 40)).toBe(base);
  });

  it('changes with any shown line: the pointer, a label, a line ticking in the transcript', () => {
    const text = screenWith('status');
    const base = screenKey(text, 40);
    expect(screenKey(text.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. No', ' ❯ 2. No'), 40)).not.toBe(base);
    expect(screenKey(text.replace('2. No', '2. Nope'), 40)).not.toBe(base);
    expect(screenKey(text.replace('line 30', 'line 30 · 13s'), 40)).not.toBe(base);
    // And with how many lines were shown.
    expect(screenKey(text, 41)).not.toBe(base);
  });

  it("is the same for Terminal's raw text and the trimmed text the API returns", () => {
    const raw = dialogFixture('PERM_RAW_SPACES').screen;
    expect(screenKey(raw, 40)).toBe(screenKey(lastLines(raw, 60).join('\n'), 40));
    expect(screenKey(raw, 40)).toBe(screenKey(dialogFixture('PERM_CREATE_2').screen, 40));
  });
});

describe('rawSlice', () => {
  const raw = dialogFixture('PERM_RAW_SPACES').screen;
  const lines = screenLines(raw);

  it('D10: is always an exact substring of the raw text, trailing spaces and CRLF kept', () => {
    for (let from = 0; from < lines.length; from++) {
      for (let to = from; to < lines.length; to++) {
        const cut = rawSlice(raw, from, to);
        expect(raw.includes(cut), `${from}..${to}`).toBe(true);
        expect(linesOf(cut), `${from}..${to}`).toEqual(lines.slice(from, to + 1));
        expect(cut.endsWith('\r\n') || cut.endsWith('\n') || cut.endsWith('\r'), `${from}..${to}`).toBe(false);
      }
    }
    const one = rawSlice(raw, 3, 3);
    expect(one).toBe(' Create file'.padEnd(80));
    expect(rawSlice(raw, 3, 4)).toBe(`${' Create file'.padEnd(80)}\r\n${' /tmp/demo/b.txt'.padEnd(80)}`);
  });

  it('splits where screenLines splits: CRLF, CR and LF, mixed', () => {
    const mixed = 'a  \r\nb\rc \n\nd';
    expect(screenLines(mixed)).toEqual(['a', 'b', 'c', '', 'd']);
    expect(rawSlice(mixed, 0, 0)).toBe('a  ');
    expect(rawSlice(mixed, 1, 2)).toBe('b\rc ');
    expect(rawSlice(mixed, 2, 4)).toBe('c \n\nd');
    expect(rawSlice(mixed, 0, 4)).toBe(mixed);
  });

  it('is empty for an empty range, and clamps a range past either end', () => {
    expect(rawSlice('a\nb', 1, 0)).toBe('');
    expect(rawSlice('a\nb', 5, 9)).toBe('');
    expect(rawSlice('a\nb', -3, 0)).toBe('a');
    // A trailing blank line is a line of the raw text (screenLines drops it): its separator is kept.
    expect(rawSlice('a\nb\n', 1, 9)).toBe('b\n');
    expect(rawSlice('', 0, 0)).toBe('');
  });

  it("the keypad's range cut from the raw text holds exactly the hashed lines", () => {
    for (const f of DIALOG_FIXTURES) {
      const r = screenKeyRange(f.screen, 40);
      const cut = rawSlice(f.screen, r.from, r.to);
      expect(f.screen.includes(cut), f.name).toBe(true);
      expect(r.to >= r.from ? linesOf(cut) : [], f.name).toEqual(screenLines(f.screen).slice(r.from, r.to + 1));
    }
  });
});
