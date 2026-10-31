/**
 * U9, the prompt half: the user's words, then `Attached files:` with one
 * `- "<label>": <absolute path>` line per file. Labels are untrusted (a
 * downloaded file's name): cleaned and quoted. No composed line is
 * path-only, so Claude Code never turns one into an attached image, and the
 * whole must fit a prompt.
 */
import { describe, expect, it } from 'vitest';
import { UPLOAD_LABEL_MAX } from '@jantar/protocol';
import { COMPOSED_TOO_LONG, cleanLabel, composePrompt } from '../../src/uploads/compose.js';
import { MAX_PROMPT_CHARS, imagePathLines, validatePromptText } from '../../src/writer/text.js';

const DIR = '/synthetic/state/uploads/sess-aaaa-1111';
const JPG = `${DIR}/01jfz8x8y3t0v5g9wqk2m4n6pr.jpg`;
const PDF = `${DIR}/01jfz8x8y3t0v5g9wqk2m4n6ps.pdf`;
const MD = `${DIR}/01jfz8x8y3t0v5g9wqk2m4n6pt.md`;

function composed(text: string, files: { label: string; path: string }[]): string {
  const r = composePrompt(text, files);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.text;
}

describe('composePrompt', () => {
  it('the trimmed words, a blank line, then one quoted line per file in the order given', () => {
    const text = composed('  Compare these two and fix the header.\n', [
      { label: 'IMG_0412', path: JPG },
      { label: 'budget.pdf', path: PDF },
    ]);
    expect(text).toBe(['Compare these two and fix the header.', '', 'Attached files:', `- "IMG_0412": ${JPG}`, `- "budget.pdf": ${PDF}`].join('\n'));
    expect(validatePromptText(text)).toEqual({ ok: true, text });
  });

  it('with no words, the block opens with "Please look at these files:"', () => {
    expect(composed(' \n ', [{ label: 'notes.md', path: MD }])).toBe(`Please look at these files:\n- "notes.md": ${MD}`);
    expect(composed('', [{ label: 'notes.md', path: MD }])).toBe(`Please look at these files:\n- "notes.md": ${MD}`);
  });

  it('keeps the words as written inside (CRLF as LF), and never touches a prompt with no files', () => {
    expect(composed('line one\r\nline two', [{ label: 'a', path: MD }])).toBe(`line one\nline two\n\nAttached files:\n- "a": ${MD}`);
    expect(composePrompt('  as is  ', [])).toEqual({ ok: true, text: '  as is  ' });
  });

  it('a path holding whitespace is quoted; never @, never backslash escapes', () => {
    const spaced = '/synthetic/state dir/uploads/sess-aaaa-1111/01jfz8x8y3t0v5g9wqk2m4n6pr.jpg';
    const text = composed('look', [{ label: 'photo', path: spaced }]);
    expect(text.split('\n').at(-1)).toBe(`- "photo": "${spaced}"`);
    expect(text).not.toContain('@');
    expect(text).not.toContain('\\');
  });

  it('no composed line is one Claude Code would turn into an attached image', () => {
    const files = [
      { label: '/synthetic/elsewhere/x.png', path: JPG },
      { label: 'C:\\pics\\y.jpg', path: JPG },
      { label: `"${JPG}"`, path: JPG },
      { label: JPG, path: '/synthetic/state dir/uploads/sess-aaaa-1111/01jfz8x8y3t0v5g9wqk2m4n6pr.png' },
    ];
    for (const words of ['', 'see these']) expect(imagePathLines(composed(words, files))).toEqual([]);
  });

  it('a label with nothing left is "image N" or "file N", numbered by kind', () => {
    const text = composed('x', [
      { label: '\u0000\u202e', path: JPG },
      { label: ' ', path: PDF },
      { label: '\n', path: JPG },
      { label: 'kept', path: MD },
    ]);
    expect(text.split('\n').slice(3)).toEqual([`- "image 1": ${JPG}`, `- "file 1": ${PDF}`, `- "image 2": ${JPG}`, `- "kept": ${MD}`]);
  });

  it('refuses a prompt the file list makes longer than 16,000 characters', () => {
    const files = [{ label: 'IMG_0412', path: JPG }];
    const room = MAX_PROMPT_CHARS - `\n\nAttached files:\n- "IMG_0412": ${JPG}`.length;
    expect(composePrompt('a'.repeat(room), files)).toMatchObject({ ok: true });
    expect(composePrompt('a'.repeat(room + 1), files)).toEqual({ ok: false, reason: COMPOSED_TOO_LONG });
    expect(COMPOSED_TOO_LONG).toBe('With the file list the prompt is longer than 16,000 characters');
  });
});

describe('cleanLabel', () => {
  it('drops controls and format characters, and turns line breaks and tabs into a space', () => {
    expect(cleanLabel('a\u0000b\u0007c\u001b[31md', 'f')).toBe('abc[31md');
    expect(cleanLabel('first\nsecond\r\nthird\tfourth\u2028fifth', 'f')).toBe('first second third fourth fifth');
    // A right-to-left override can't disguise the name; zero-width marks go too.
    expect(cleanLabel('invoice\u202efdp.exe', 'f')).toBe('invoicefdp.exe');
    expect(cleanLabel('a\u200bb\u2066c\ufeff', 'f')).toBe('abc');
  });

  it('no path inside a label, and the quotes stay closed', () => {
    expect(cleanLabel('../../etc/x.png', 'f')).toBe('.._.._etc_x.png');
    expect(cleanLabel('C:\\pics\\y.jpg', 'f')).toBe('C:_pics_y.jpg');
    expect(cleanLabel('say "hi"', 'f')).toBe("say 'hi'");
  });

  it('an @ that would start a word is neutralised; one inside a word stays', () => {
    expect(cleanLabel('@notes.md', 'f')).toBe('_notes.md');
    expect(cleanLabel('see @.env now', 'f')).toBe('see _.env now');
    expect(cleanLabel('see\n@.env', 'f')).toBe('see _.env');
    expect(cleanLabel('logo@2x final', 'f')).toBe('logo@2x final');
    // Claude Code also starts a mention after CJK punctuation: only an @ after a letter, digit or _ stays.
    expect(cleanLabel('report\u3002@.env', 'f')).toBe('report\u3002_.env');
    expect(cleanLabel('a\u3001@b \uff1f@c \uff01@d (@e)', 'f')).toBe('a\u3001_b \uff1f_c \uff01_d (_e)');
    expect(cleanLabel('name_@x 2@y', 'f')).toBe('name_@x 2@y');
  });

  it('squashes spaces, trims, and cuts to 80 characters by code point', () => {
    expect(cleanLabel('  a    b  ', 'f')).toBe('a b');
    expect(cleanLabel('x'.repeat(200), 'f')).toBe('x'.repeat(UPLOAD_LABEL_MAX));
    const emoji = '🙂'.repeat(100);
    const cut = cleanLabel(emoji, 'f');
    expect(Array.from(cut)).toHaveLength(UPLOAD_LABEL_MAX);
    expect(cut).toBe('🙂'.repeat(UPLOAD_LABEL_MAX));
    // A cut that leaves a trailing space trims it.
    expect(cleanLabel(`${'y'.repeat(UPLOAD_LABEL_MAX - 1)} tail`, 'f')).toBe('y'.repeat(UPLOAD_LABEL_MAX - 1));
  });

  it('falls back when nothing is left', () => {
    expect(cleanLabel('', 'image 3')).toBe('image 3');
    expect(cleanLabel('\u0000 \t\u200b', 'file 2')).toBe('file 2');
  });
});
