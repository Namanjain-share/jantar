/**
 * U10: imagePathLines mirrors Claude Code 2.1.314's paste split, so a
 * prompt line Claude would turn into an attached image (its path then
 * leaves the text, and the exact proof can never match) is refused before
 * anything is typed, for every send, the CLI's included. Rows from the
 * research table (attachments 1.3), then the composed attachment line.
 */
import { describe, expect, it } from 'vitest';
import { IMAGE_PATH_REFUSED, imagePathLines, validatePromptText } from '../../src/writer/text.js';
import { makeRig } from './helpers.js';

const UP = '/synthetic/state/uploads/s1/01abc.jpg';

describe('imagePathLines', () => {
  it.each([
    ['a lone absolute image path', UP],
    ['two image paths on one line', '/a/x.jpg /b/y.png'],
    ['a path and an image path', '/a/notes.txt /b/y.webp'],
    ['a quoted path with a space', '"/synthetic/Sam Doe/x.jpg"'],
    ['an unquoted path with a space', '/synthetic/Sam Doe/x.jpg'],
    ['a single-quoted path', "'/synthetic/x.gif'"],
    ['a backslash-escaped space', '/synthetic/Sam\\ Doe/x.jpeg'],
    ['a home-relative path', '~/Desktop/shot.PNG'],
    ['a Windows path', 'C:\\pics\\y.jpg'],
    ['one bare word', 'out.png'],
    ['one bare word with an escaped space', 'my\\ photo.png'],
    ['a quoted relative name', '"my photo.png"'],
    ['indented', '    /a/x.png  '],
    ['an escaped first slash, then a space', '\\/synthetic/my photo.png'],
    ['a UNC path, then a path', '\\\\host\\share\\a.png /synthetic/b.png'],
  ])('hit: %s', (_name, line) => {
    expect(imagePathLines(line)).toEqual([1]);
  });

  it.each([
    ['the composed attachment line', `- "IMG_0412": ${UP}`],
    ['the composed line with a quoted path', '- "photo": "/synthetic/state dir/uploads/s1/01abc.jpg"'],
    ['the research row with words first', '- photo 1 (image): /synthetic/home/.jantar/uploads/s1/01abc.jpg'],
    ['words, then a path', 'see /a/x.jpg'],
    ['a sentence ending in a name', 'I saved it as out.png'],
    ['a path to a text file', '/a/notes.md'],
    ['an image path followed by words', '/a/x.png is broken'],
    ['a name with a trailing period', 'out.png.'],
    ['a URL', 'https://example.com/x.png'],
    ['an empty line', ''],
  ])('no hit: %s', (_name, line) => {
    expect(imagePathLines(line)).toEqual([]);
  });

  it('works line by line (1-based) and reads CRLF as LF', () => {
    expect(imagePathLines(['Look at this:', UP, 'and this', '/b/y.png /c/z.gif'].join('\n'))).toEqual([2, 4]);
    expect(imagePathLines(`first\r\n${UP}\r\nlast`)).toEqual([2]);
    expect(imagePathLines(`Compare them.\n\nAttached files:\n- "a": ${UP}\n- "b": /synthetic/b.png`)).toEqual([]);
  });
});

describe('validatePromptText refuses image path lines', () => {
  it('with the fixed sentence, and passes the same files named with words', () => {
    expect(validatePromptText(`Please look\n${UP}`)).toEqual({ ok: false, reason: IMAGE_PATH_REFUSED });
    expect(IMAGE_PATH_REFUSED).toBe(
      "A line that is only an image path becomes an attached image in Claude Code, which Jantar can't prove sent. Add a word before it (on the phone, attach the file instead).",
    );
    const fine = `Please look\n- "shot": ${UP}`;
    expect(validatePromptText(fine)).toEqual({ ok: true, text: fine });
  });

  it('a CLI send of a bare image path is refused by the writer, and nothing is typed', async () => {
    const rig = makeRig();
    const r = await rig.writer.submit({ sid: rig.session().sid, text: '/synthetic/shots/screen.png', onDraft: 'refuse', actor: { kind: 'cli' } });
    expect(r).toMatchObject({ ok: false, reason: IMAGE_PATH_REFUSED });
    expect(rig.terminal.ops('type')).toEqual([]);
  });
});
