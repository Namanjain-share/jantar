/**
 * Screenshot files (meetings/files.ts, MF2): the folders are 0700 (one found
 * open to group or others is closed to them) and the files 0600; a symlink
 * planted at <meetingsDir> or at a meeting's folder
 * refuses the write with nothing written through it; one planted at the
 * file's name is replaced, its target untouched; one planted as the file,
 * a folder, a FIFO or an oversized file is never served; a meeting's folder
 * goes with what is in it, while a symlinked one is unlinked and its target
 * kept; the sweep is shown only real directories named by a ulid.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeJpeg } from '@jantar/fixtures';
import { MEETING_SHOT_MAX_BYTES } from '@jantar/protocol';
import { meetingDirNames, readShot, removeMeetingDir, shotDir, shotPath, writeShot } from '../../src/meetings/files.js';

const MEETING = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const OTHER = '01JFZ8X8Y3T0V5G9WQK2M4N6PT';
const SHOT = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';

let base: string;
let meetingsDir: string;
/** A folder outside the meetings folder that a planted link points at. */
let elsewhere: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-meeting-files-')));
  meetingsDir = join(base, 'home', 'meetings');
  mkdirSync(join(base, 'home'), { mode: 0o700 });
  elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;

describe('writing a screenshot (MF2)', () => {
  it('makes <meetingsDir> and the meeting folder 0700 and the file 0600, the bytes as given', async () => {
    const jpeg = makeJpeg(64, 48);
    const dir = await shotDir(meetingsDir, MEETING);
    expect(dir).toBe(join(meetingsDir, MEETING));
    const path = await writeShot(dir as string, SHOT, jpeg);
    expect(path).toBe(shotPath(meetingsDir, MEETING, SHOT));
    expect(mode(meetingsDir)).toBe(0o700);
    expect(mode(join(meetingsDir, MEETING))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(path).equals(jpeg)).toBe(true);
    // No temp file is left beside it.
    expect(readdirSync(join(meetingsDir, MEETING))).toEqual([`${SHOT}.jpg`]);
    // A second screenshot reuses the folders.
    expect(await shotDir(meetingsDir, MEETING)).toBe(dir);
  });

  it('closes a <meetingsDir> or meeting folder found open to group or others, and never opens one up', async () => {
    mkdirSync(join(meetingsDir, MEETING), { recursive: true });
    mkdirSync(join(meetingsDir, OTHER));
    chmodSync(meetingsDir, 0o755);
    chmodSync(join(meetingsDir, MEETING), 0o775);
    chmodSync(join(meetingsDir, OTHER), 0o500);
    try {
      expect(await shotDir(meetingsDir, MEETING)).toBe(join(meetingsDir, MEETING));
      expect(await shotDir(meetingsDir, OTHER)).toBe(join(meetingsDir, OTHER));
      expect(mode(meetingsDir)).toBe(0o700);
      expect(mode(join(meetingsDir, MEETING))).toBe(0o700);
      expect(mode(join(meetingsDir, OTHER))).toBe(0o500);
    } finally {
      chmodSync(join(meetingsDir, OTHER), 0o700);
    }
  });

  it('refuses when <meetingsDir> is a symlink, and writes nothing through it', async () => {
    symlinkSync(elsewhere, meetingsDir);
    expect(await shotDir(meetingsDir, MEETING)).toBeNull();
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses when the meeting's folder is a symlink (or a file), and writes nothing through it", async () => {
    mkdirSync(meetingsDir, { mode: 0o700 });
    symlinkSync(elsewhere, join(meetingsDir, MEETING));
    expect(await shotDir(meetingsDir, MEETING)).toBeNull();
    expect(readdirSync(elsewhere)).toEqual([]);
    writeFileSync(join(meetingsDir, OTHER), 'not a folder');
    expect(await shotDir(meetingsDir, OTHER)).toBeNull();
    // A dangling link is no folder either.
    symlinkSync(join(base, 'missing'), join(meetingsDir, SHOT));
    expect(await shotDir(meetingsDir, SHOT)).toBeNull();
    expect(existsSync(join(base, 'missing'))).toBe(false);
  });

  it("replaces a symlink planted at the file's name, leaving its target untouched", async () => {
    const dir = (await shotDir(meetingsDir, MEETING)) as string;
    const target = join(elsewhere, 'target.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, join(dir, `${SHOT}.jpg`));
    const jpeg = makeJpeg(32, 24);
    const path = await writeShot(dir, SHOT, jpeg);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path).equals(jpeg)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });
});

describe('reading a screenshot (MF2)', () => {
  it('serves a regular file of at most 4 MB', async () => {
    const jpeg = makeJpeg(64, 48);
    await writeShot((await shotDir(meetingsDir, MEETING)) as string, SHOT, jpeg);
    expect((await readShot(meetingsDir, MEETING, SHOT))?.equals(jpeg)).toBe(true);
    // Exactly the cap is fine; one byte more is not served.
    truncateSync(shotPath(meetingsDir, MEETING, SHOT), MEETING_SHOT_MAX_BYTES);
    expect((await readShot(meetingsDir, MEETING, SHOT))?.length).toBe(MEETING_SHOT_MAX_BYTES);
    truncateSync(shotPath(meetingsDir, MEETING, SHOT), MEETING_SHOT_MAX_BYTES + 1);
    expect(await readShot(meetingsDir, MEETING, SHOT)).toBeNull();
  });

  it('never serves a symlink planted as the file, a folder, a FIFO, a missing file, or a file behind a linked folder', async () => {
    const dir = (await shotDir(meetingsDir, MEETING)) as string;
    const secret = join(elsewhere, 'secret.jpg');
    writeFileSync(secret, makeJpeg(8, 8));
    symlinkSync(secret, join(dir, `${SHOT}.jpg`));
    expect(await readShot(meetingsDir, MEETING, SHOT)).toBeNull();

    mkdirSync(join(dir, `${OTHER}.jpg`));
    expect(await readShot(meetingsDir, MEETING, OTHER)).toBeNull();

    const fifo = '01JFZ8X8Y3T0V5G9WQK2M4N6PV';
    execFileSync('/usr/bin/mkfifo', [join(dir, `${fifo}.jpg`)]);
    expect(await readShot(meetingsDir, MEETING, fifo)).toBeNull();

    expect(await readShot(meetingsDir, MEETING, '01JFZ8X8Y3T0V5G9WQK2M4N6PW')).toBeNull();
    expect(await readShot(meetingsDir, OTHER, SHOT)).toBeNull();

    // A meeting folder that is a link to a folder holding a real file.
    writeFileSync(join(elsewhere, `${SHOT}.jpg`), makeJpeg(8, 8));
    symlinkSync(elsewhere, join(meetingsDir, OTHER));
    expect(await readShot(meetingsDir, OTHER, SHOT)).toBeNull();
  });
});

describe("removing a meeting's folder (MF6, files part)", () => {
  it('removes the folder with what is in it and nothing else', async () => {
    await writeShot((await shotDir(meetingsDir, MEETING)) as string, SHOT, makeJpeg(8, 8));
    await writeShot((await shotDir(meetingsDir, OTHER)) as string, SHOT, makeJpeg(8, 8));
    expect(await removeMeetingDir(meetingsDir, MEETING)).toBe(true);
    expect(existsSync(join(meetingsDir, MEETING))).toBe(false);
    expect(existsSync(shotPath(meetingsDir, OTHER, SHOT))).toBe(true);
    // Gone already, or never made: fine.
    expect(await removeMeetingDir(meetingsDir, MEETING)).toBe(true);
    rmSync(meetingsDir, { recursive: true });
    expect(await removeMeetingDir(meetingsDir, MEETING)).toBe(true);
  });

  it('unlinks a symlinked folder and keeps its target', async () => {
    mkdirSync(meetingsDir, { mode: 0o700 });
    writeFileSync(join(elsewhere, 'keep.txt'), 'keep me');
    symlinkSync(elsewhere, join(meetingsDir, MEETING));
    expect(await removeMeetingDir(meetingsDir, MEETING)).toBe(true);
    expect(existsSync(join(meetingsDir, MEETING))).toBe(false);
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep me');
  });

  it('touches nothing while <meetingsDir> is a symlink', async () => {
    mkdirSync(join(elsewhere, MEETING));
    writeFileSync(join(elsewhere, MEETING, 'keep.txt'), 'keep me');
    symlinkSync(elsewhere, meetingsDir);
    expect(await removeMeetingDir(meetingsDir, MEETING)).toBe(false);
    expect(readFileSync(join(elsewhere, MEETING, 'keep.txt'), 'utf8')).toBe('keep me');
  });
});

describe('the folders the sweep may look at', () => {
  it('are the real directories named by a ulid, nothing else', async () => {
    expect(await meetingDirNames(meetingsDir)).toEqual([]);
    await shotDir(meetingsDir, MEETING);
    mkdirSync(join(meetingsDir, 'notes'));
    // 26 characters, but I is not in a ulid's alphabet.
    mkdirSync(join(meetingsDir, '01JFZ8X8Y3T0V5G9WQK2M4N6PI'));
    writeFileSync(join(meetingsDir, OTHER), 'a file named like a meeting');
    symlinkSync(elsewhere, join(meetingsDir, SHOT));
    expect(await meetingDirNames(meetingsDir)).toEqual([MEETING]);
    // Through a linked <meetingsDir>: nothing.
    rmSync(meetingsDir, { recursive: true });
    mkdirSync(join(elsewhere, MEETING));
    symlinkSync(elsewhere, meetingsDir);
    expect(await meetingDirNames(meetingsDir)).toEqual([]);
  });
});
