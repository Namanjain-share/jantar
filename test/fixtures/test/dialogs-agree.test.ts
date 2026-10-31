/**
 * The shared dialog fixtures (v0.4.2 wave 0, P2) hold together: every
 * expected model parses as a TerminalDialog, the web copy
 * (packages/web/test/term-dialog-fixtures.json) says the same apart from its
 * placeholder fingerprints, every screen fits 96 columns and holds
 * DIALOG_SECRET, every note is one of DIALOG_NOTES, and the bytes are one per
 * option, arrows and SAMPLE_TEXT only (Up only where the `up` gate opens it).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIALOG_GATES, DIALOG_NOTES, DialogTextSchema, TerminalDialogSchema } from '@jantar/protocol';
import { DIALOG_FIXTURES, DIALOG_SECRET, NOT_DIALOG_SCREENS, SAMPLE_TEXT, TYPED_ANSWER, TYPED_PLAN_NOTE, dialogFixture, withGates, type DialogFixture } from '../src/index.js';

const WEB_JSON = join(__dirname, '..', '..', '..', 'packages', 'web', 'test', 'term-dialog-fixtures.json');
const web = JSON.parse(readFileSync(WEB_JSON, 'utf8')) as Record<string, { dialog: (Record<string, unknown> & { fingerprint: string }) | null; note: string | null }>;

const NOTES = new Set<string>(Object.values(DIALOG_NOTES));
const PLACEHOLDER = '0'.repeat(64);

const expectations = (f: DialogFixture) => [
  { key: f.name, exp: f.expected, bytes: f.bytes, open: false },
  ...(f.expectedOpen ? [{ key: `${f.name}.open`, exp: f.expectedOpen, bytes: f.bytesOpen ?? [], open: true }] : []),
];

describe('the dialog fixtures', () => {
  it('are the ones spec 9.1 lists, each once', () => {
    expect(DIALOG_FIXTURES.map((f) => f.name).sort()).toEqual(
      [
        'PERM_OVERWRITE_3', 'PERM_OVERWRITE_3_TOP', 'PERM_CREATE_2', 'PERM_CREATE_ALWAYS', 'PERM_BASH_PREFIX', 'PERM_BASH_TWIN',
        'PERM_BASH_LONG', 'PERM_BASH_TALL', 'PERM_BASH_DONT_ASK', 'PERM_READ_OUTSIDE', 'PERM_FETCH', 'PERM_TICKING_A', 'PERM_TICKING_B', 'PERM_RAW_SPACES',
        'PERM_LONE_SUBMIT', 'PERM_DEFAULT_NO', 'PERM_WORKFLOW_133', 'PERM_WORKFLOW_132', 'PERM_WORKFLOW_005', 'PERM_WORKFLOW_LONG_133',
        'PERM_WORKFLOW_LONG_132', 'PERM_WORKFLOW_TWIN_A', 'PERM_WORKFLOW_TWIN_B', 'PLAN_FULLSCREEN', 'PLAN_80COL', 'PLAN_CLEAR', 'PLAN_FEEDBACK_TYPED',
        'PLAN_TEXT_PENDING', 'Q_SINGLE', 'Q_TEXT_PENDING', 'Q_TYPED', 'Q_ON_CHAT', 'Q_LONE_NEXT', 'Q_NUM_GAP', 'Q_TABS',
        'Q_MULTI', 'Q_MULTI_TICKED', 'Q_REVIEW', 'Q_REVIEW_WARN', 'Q_PREVIEW', 'Q_SCROLLED',
      ].sort(),
    );
    expect(Object.keys(NOT_DIALOG_SCREENS).sort()).toEqual([
      'ANSWERED_ABOVE_BOX',
      'CTRL_C_AGAIN',
      'IDLE_DRAFT',
      'INTERRUPTED',
      'MCP_FORM',
      'MODEL_PICKER',
      'NO_POINTER_LIST',
      'SAVED_IN_TRANSCRIPT_VIEW',
      'SAVED_OVER_FORM',
    ]);
    expect(dialogFixture('Q_SINGLE').name).toBe('Q_SINGLE');
    expect(() => dialogFixture('NOPE')).toThrow(/no dialog fixture/);
  });

  it('every expected model, with a placeholder fingerprint, is a TerminalDialog', () => {
    for (const f of DIALOG_FIXTURES) {
      for (const { key, exp } of expectations(f)) {
        if (exp.dialog === null) continue;
        const parsed = TerminalDialogSchema.safeParse({ ...exp.dialog, fingerprint: PLACEHOLDER });
        expect(parsed.success, `${key}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
        expect(exp.dialog.current, key).toBeLessThan(exp.dialog.options.length);
      }
    }
  });

  it('the gated ones list their gates and carry both models; the others carry one', () => {
    for (const f of DIALOG_FIXTURES) {
      expect(Boolean(f.expectedOpen), f.name).toBe(Boolean(f.gates?.length));
      expect(Boolean(f.bytesOpen), f.name).toBe(Boolean(f.gates?.length));
    }
  });

  it('withGates: the open pair when the gates open every gate a fixture lists, the gates-off pair when they open none', () => {
    const off = { up: false, tall: false, noFirst: false };
    const on = { up: true, tall: true, noFirst: true };
    for (const f of DIALOG_FIXTURES) {
      const closed = { expected: f.expected, bytes: f.bytes };
      expect(withGates(f, off), f.name).toEqual(closed);
      expect(withGates(f, on), f.name).toEqual(f.gates?.length ? { expected: f.expectedOpen, bytes: f.bytesOpen } : closed);
    }
    // What ships since SP14 and SP15: the up and tall fixtures read open, the No-first one doesn't.
    for (const name of ['PERM_OVERWRITE_3_TOP', 'PLAN_FULLSCREEN', 'Q_ON_CHAT', 'Q_MULTI_TICKED']) {
      expect(withGates(dialogFixture(name), DIALOG_GATES).expected, name).toBe(dialogFixture(name).expectedOpen);
    }
    expect(withGates(dialogFixture('PERM_DEFAULT_NO'), DIALOG_GATES).expected).toBe(dialogFixture('PERM_DEFAULT_NO').expected);
    expect(() => withGates({ ...dialogFixture('Q_ON_CHAT'), gates: ['up', 'noFirst'] }, DIALOG_GATES)).toThrow(/only partly open/);
  });

  it('every note is one of DIALOG_NOTES, on a locked row or for a screen with no dialog', () => {
    for (const f of DIALOG_FIXTURES) {
      for (const { key, exp } of expectations(f)) {
        if (exp.note !== null) {
          expect(NOTES.has(exp.note), key).toBe(true);
          expect(exp.dialog, key).toBeNull();
        }
        for (const o of exp.dialog?.options ?? []) {
          if (o.role === 'locked') expect(NOTES.has(o.note ?? ''), `${key} ${o.label}`).toBe(true);
          else expect(o.note, `${key} ${o.label}`).toBeUndefined();
        }
      }
    }
  });

  it('one write per option: arrows, then the sample text for a text row; null for a locked row; Up only with the up gate open', () => {
    for (const f of DIALOG_FIXTURES) {
      for (const { key, exp, bytes, open } of expectations(f)) {
        const options = exp.dialog?.options ?? [];
        expect(bytes.length, key).toBe(options.length);
        options.forEach((o, i) => {
          const b = bytes[i];
          if (o.role === 'locked') {
            expect(b, `${key} ${i}`).toBeNull();
            return;
          }
          expect(typeof b, `${key} ${i}`).toBe('string');
          const steps = i - (exp.dialog?.current ?? 0);
          const arrows = (steps > 0 ? '\u001b[B' : '\u001b[A').repeat(Math.abs(steps));
          expect(b, `${key} ${i}`).toBe(o.role === 'text' ? arrows + SAMPLE_TEXT : arrows);
          if (steps < 0) expect(open && f.gates?.includes('up'), `${key} ${i} moves up`).toBe(true);
        });
      }
    }
  });

  it('every screen fits 96 columns and holds DIALOG_SECRET', () => {
    const screens: [string, string][] = [...DIALOG_FIXTURES.map((f): [string, string] => [f.name, f.screen]), ...Object.entries(NOT_DIALOG_SCREENS)];
    for (const [name, screen] of screens) {
      expect(screen, name).toContain(DIALOG_SECRET);
      for (const line of screen.split(/\r\n|\r|\n/u)) expect([...line].length, `${name}: ${line}`).toBeLessThanOrEqual(96);
    }
    // One fixture is Terminal's raw text: CRLF line ends and trailing spaces.
    const raw = dialogFixture('PERM_RAW_SPACES').screen;
    expect(raw).toContain('\r\n');
    expect(raw).toMatch(/ \r\n/u);
  });

  it('the typed answers pass the dialog text rule, and the pending screens show them whole', () => {
    expect(TYPED_ANSWER).toHaveLength(120);
    expect(TYPED_PLAN_NOTE).toHaveLength(191);
    for (const t of [TYPED_ANSWER, TYPED_PLAN_NOTE, SAMPLE_TEXT]) expect(DialogTextSchema.parse(t)).toBe(t);
    const squash = (s: string) => s.replace(/\s+/gu, '');
    expect(squash(dialogFixture('Q_TEXT_PENDING').screen)).toContain(squash(TYPED_ANSWER));
    expect(squash(dialogFixture('PLAN_TEXT_PENDING').screen)).toContain(squash(TYPED_PLAN_NOTE));
  });
});

describe('the web copy (packages/web/test/term-dialog-fixtures.json)', () => {
  it('equals the fixtures apart from the fingerprints, which are distinct placeholders', () => {
    const keys: string[] = [];
    for (const f of DIALOG_FIXTURES) {
      for (const { key, exp } of expectations(f)) {
        keys.push(key);
        const entry = web[key];
        expect(entry, key).toBeDefined();
        if (!entry) continue;
        expect(entry.note, key).toBe(exp.note);
        if (exp.dialog === null) {
          expect(entry.dialog, key).toBeNull();
          continue;
        }
        const { fingerprint, ...rest } = entry.dialog ?? { fingerprint: '' };
        expect(fingerprint, key).toMatch(/^[0-9a-f]{64}$/);
        expect(rest, key).toEqual(exp.dialog);
      }
    }
    expect(Object.keys(web).sort()).toEqual(keys.sort());
    const prints = Object.values(web).flatMap((e) => (e.dialog ? [e.dialog.fingerprint] : []));
    expect(new Set(prints).size).toBe(prints.length);
  });
});
