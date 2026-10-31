/**
 * The upload store on a throwaway home. U3 (the quotas: 20 MiB a file, text
 * 2 MiB, 1 GiB under the uploads folder, counted afresh), U5 (names are
 * generated, never the client's; the session must be session-shaped and
 * live; the path stays under <uploads>/<sid>/; neither folder may be a
 * link; dirs 0700, files 0600, written with wx so nothing is clobbered),
 * and remove and resolve (one regular, id-named file of this session, never
 * a link).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOADS_TOTAL_MAX_BYTES, UPLOAD_MAX_BYTES, UPLOAD_TEXT_MAX_BYTES, UploadInfoSchema } from '@jantar/protocol';
import { UPLOAD_TOO_LARGE } from '../../src/api/errors.js';
import type { TestContext } from '../../src/core/testing.js';
import { HEIC_REFUSED, TEXT_TOO_LARGE } from '../../src/uploads/sniff.js';
import { ATTACHMENT_GONE, NOT_STORED, NO_SESSION, NO_UPLOAD, UPLOADS_FULL, UPLOADS_LINKED, UploadStore } from '../../src/uploads/store.js';
import { ENDED, HEIC, JPEG, NOTES, PDF, PNG, SID, SID2, tempHome, uploadsContext } from './helpers.js';

// The next id newId() gives, when a test needs to know it in advance.
const ids = vi.hoisted(() => ({ next: null as string | null }));
vi.mock('../../src/core/ids.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/ids.js')>();
  return { ...real, newId: () => ids.next ?? real.newId() };
});

let home: ReturnType<typeof tempHome>;
let ctx: TestContext;
let store: UploadStore;
let root: string;
beforeEach(() => {
  home = tempHome();
  ctx = uploadsContext(home.home);
  store = new UploadStore(ctx);
  root = ctx.paths.uploadsDir;
  ids.next = null;
});
afterEach(() => home.cleanup());

const mode = (p: string) => lstatSync(p).mode & 0o777;

async function saved(sid: string, bytes: Buffer, ext?: string) {
  const r = await store.save(sid, bytes, ext !== undefined ? { ext } : {});
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.reason}`);
  return r.upload;
}

describe('save: names, modes, links, traversal (U5)', () => {
  it('stores <uploads>/<sid>/<id>.<ext> with a fresh lowercase ULID; the reply is the id, the kind and the size', async () => {
    const up = await saved(SID, PNG, 'txt');
    expect(UploadInfoSchema.parse(up)).toEqual({ id: up.id, kind: 'image', bytes: PNG.length });
    expect(up.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    expect(root).toBe(join(home.home, '.jantar', 'uploads'));
    expect(readdirSync(join(root, SID))).toEqual([`${up.id}.png`]);
    expect(readFileSync(join(root, SID, `${up.id}.png`)).equals(PNG)).toBe(true);
    const again = await saved(SID, NOTES, 'md');
    expect(again.id).not.toBe(up.id);
    expect(readdirSync(join(root, SID)).sort()).toEqual([`${up.id}.png`, `${again.id}.md`].sort());
    expect(JSON.stringify(again)).not.toContain(root);
  });

  it('dirs are 0700 and files 0600, even when the uploads folder was made with a looser mode', async () => {
    mkdirSync(root, { recursive: true, mode: 0o755 });
    expect(mode(root)).toBe(0o755);
    const up = await saved(SID, JPEG);
    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, SID))).toBe(0o700);
    expect(mode(join(root, SID, `${up.id}.jpg`))).toBe(0o600);
  });

  it('a session that is unknown, ended or not session-shaped is not_found, and nothing is made', async () => {
    for (const sid of ['sess-nope-9999', ENDED, '../sess-aaaa-1111', 'sess-aaaa-1111/..', '..', 'short', 'constructor', '__proto__', `${'a'.repeat(65)}`]) {
      expect(await store.save(sid, NOTES, {}), sid).toEqual({ ok: false, code: 'not_found', reason: NO_SESSION });
    }
    expect(existsSync(root)).toBe(false);
  });

  it('refuses an uploads folder that is a link, and writes nothing through it', async () => {
    const outside = join(home.home, 'outside');
    mkdirSync(outside);
    mkdirSync(join(home.home, '.jantar'), { recursive: true });
    symlinkSync(outside, root);
    expect(await store.save(SID, NOTES, {})).toEqual({ ok: false, code: 'refused', reason: UPLOADS_LINKED });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a session folder that is a link, and writes nothing through it", async () => {
    const outside = join(home.home, 'outside');
    mkdirSync(outside);
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, SID));
    expect(await store.save(SID, NOTES, {})).toEqual({ ok: false, code: 'refused', reason: UPLOADS_LINKED });
    expect(readdirSync(outside)).toEqual([]);
    // Another session is not held up.
    expect((await store.save(SID2, NOTES, {})).ok).toBe(true);
  });

  it('never clobbers: a file or a link already at the new name is left alone and the save refused', async () => {
    const id = '01jfz8x8y3t0v5g9wqk2m4n6pr';
    mkdirSync(join(root, SID), { recursive: true });
    writeFileSync(join(root, SID, `${id}.txt`), 'already here');
    ids.next = id.toUpperCase();
    expect(await store.save(SID, NOTES, {})).toEqual({ ok: false, code: 'refused', reason: NOT_STORED });
    expect(readFileSync(join(root, SID, `${id}.txt`), 'utf8')).toBe('already here');
    const target = join(home.home, 'target.png');
    writeFileSync(target, 'not ours');
    symlinkSync(target, join(root, SID, `${id}.png`));
    expect(await store.save(SID, PNG, {})).toEqual({ ok: false, code: 'refused', reason: NOT_STORED });
    expect(readFileSync(target, 'utf8')).toBe('not ours');
    // The log names the errno only.
    expect(ctx.log.records.filter((r) => r.msg === 'upload not stored').map((r) => r.fields)).toEqual([{ code: 'EEXIST' }, { code: 'EEXIST' }]);
  });

  it('HEIC and unreadable kinds are refused before anything is written', async () => {
    expect(await store.save(SID, HEIC, { ext: 'jpg' })).toEqual({ ok: false, code: 'unsupported_media_type', reason: HEIC_REFUSED });
    expect(existsSync(root)).toBe(false);
  });
});

describe('save: quotas (U3)', () => {
  it('a file up to 20 MiB, text up to 2 MiB', async () => {
    expect(await store.save(SID, Buffer.alloc(UPLOAD_TEXT_MAX_BYTES + 1, 'a'), { ext: 'txt' })).toEqual({ ok: false, code: 'payload_too_large', reason: TEXT_TOO_LARGE });
    expect(await store.save(SID, Buffer.concat([PDF, Buffer.alloc(UPLOAD_MAX_BYTES)]), {})).toEqual({ ok: false, code: 'payload_too_large', reason: UPLOAD_TOO_LARGE });
    expect((await saved(SID, Buffer.alloc(UPLOAD_TEXT_MAX_BYTES, 'a'), 'txt')).bytes).toBe(UPLOAD_TEXT_MAX_BYTES);
  });

  it('1 GiB under the uploads folder, all sessions together, counted afresh each time', async () => {
    // A sparse file stands in for a full folder (its size counts; it takes no disk).
    mkdirSync(join(root, SID2), { recursive: true });
    const filler = join(root, SID2, '01jfz8x8y3t0v5g9wqk2m4n6pr.pdf');
    writeFileSync(filler, '');
    truncateSync(filler, UPLOADS_TOTAL_MAX_BYTES - NOTES.length - 1);
    expect(await store.save(SID, Buffer.concat([NOTES, Buffer.from('!!')]), {})).toEqual({ ok: false, code: 'refused', reason: UPLOADS_FULL });
    expect((await saved(SID, Buffer.concat([NOTES, Buffer.from('!')]), 'md')).bytes).toBe(NOTES.length + 1);
    expect(await store.save(SID, Buffer.from('a'), {})).toEqual({ ok: false, code: 'refused', reason: UPLOADS_FULL });
    // Space comes back as soon as files go.
    truncateSync(filler, 0);
    expect((await store.save(SID, NOTES, {})).ok).toBe(true);
  });

  it('two saves at once can never both pass the quota: one counts and writes before the other counts', async () => {
    mkdirSync(join(root, SID2), { recursive: true });
    const filler = join(root, SID2, '01jfz8x8y3t0v5g9wqk2m4n6pr.pdf');
    writeFileSync(filler, '');
    // Room for one of the two.
    truncateSync(filler, UPLOADS_TOTAL_MAX_BYTES - NOTES.length - 1);
    const both = await Promise.all([store.save(SID, NOTES, { ext: 'md' }), store.save(SID, NOTES, { ext: 'md' })]);
    expect(both.map((r) => r.ok)).toEqual([true, false]);
    expect(both[1]).toEqual({ ok: false, code: 'refused', reason: UPLOADS_FULL });
    // A refusal or a failure doesn't stop the next save.
    truncateSync(filler, 0);
    expect((await store.save(SID, NOTES, {})).ok).toBe(true);
  });

  it('files the store did not write, and links, do not count', async () => {
    mkdirSync(join(root, SID2), { recursive: true });
    const stranger = join(root, SID2, 'stranger.bin');
    writeFileSync(stranger, '');
    truncateSync(stranger, UPLOADS_TOTAL_MAX_BYTES);
    const big = join(home.home, 'big.pdf');
    writeFileSync(big, '');
    truncateSync(big, UPLOADS_TOTAL_MAX_BYTES);
    symlinkSync(big, join(root, SID2, '01jfz8x8y3t0v5g9wqk2m4n6pr.pdf'));
    expect((await store.save(SID, NOTES, {})).ok).toBe(true);
  });
});

describe('remove', () => {
  it('removes the one file of this session by id; a second remove is not_found', async () => {
    const up = await saved(SID, PDF);
    const keep = await saved(SID, NOTES);
    expect(await store.remove(SID, up.id)).toEqual({ ok: true });
    expect(readdirSync(join(root, SID))).toEqual([`${keep.id}.txt`]);
    expect(await store.remove(SID, up.id)).toEqual({ ok: false, code: 'not_found', reason: NO_UPLOAD });
  });

  it("takes only an id-shaped name of this session's own folder; never another session's file or a link", async () => {
    const theirs = await saved(SID2, NOTES);
    for (const id of ['..', '%2e%2e', `${theirs.id}.txt`, theirs.id.toUpperCase(), '', `../${SID2}/${theirs.id}`]) {
      expect(await store.remove(SID, id), id).toEqual({ ok: false, code: 'not_found', reason: NO_UPLOAD });
    }
    expect(await store.remove(SID, theirs.id)).toEqual({ ok: false, code: 'not_found', reason: NO_UPLOAD });
    expect(await store.remove('..', theirs.id)).toEqual({ ok: false, code: 'not_found', reason: NO_UPLOAD });
    expect(readdirSync(join(root, SID2))).toEqual([`${theirs.id}.txt`]);
    const target = join(home.home, 'target.txt');
    writeFileSync(target, 'not ours');
    mkdirSync(join(root, SID), { recursive: true });
    symlinkSync(target, join(root, SID, '01jfz8x8y3t0v5g9wqk2m4n6pr.txt'));
    expect(await store.remove(SID, '01jfz8x8y3t0v5g9wqk2m4n6pr')).toEqual({ ok: false, code: 'not_found', reason: NO_UPLOAD });
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(join(root, SID, '01jfz8x8y3t0v5g9wqk2m4n6pr.txt')).isSymbolicLink()).toBe(true);
  });

  it('a session folder that is a link is not looked into', async () => {
    const outside = join(home.home, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '01jfz8x8y3t0v5g9wqk2m4n6pr.txt'), 'not ours');
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, SID));
    expect(await store.remove(SID, '01jfz8x8y3t0v5g9wqk2m4n6pr')).toEqual({ ok: false, code: 'not_found', reason: NO_UPLOAD });
    expect(existsSync(join(outside, '01jfz8x8y3t0v5g9wqk2m4n6pr.txt'))).toBe(true);
  });
});

describe('resolve', () => {
  it('gives each ref its absolute path and the label as the phone sent it, in order', async () => {
    const a = await saved(SID, JPEG);
    const b = await saved(SID, NOTES, 'md');
    const r = await store.resolve(SID, [
      { upload: b.id, label: 'notes "draft".md' },
      { upload: a.id, label: 'IMG_0412' },
    ]);
    expect(r).toEqual({
      ok: true,
      files: [
        { label: 'notes "draft".md', path: join(root, SID, `${b.id}.md`) },
        { label: 'IMG_0412', path: join(root, SID, `${a.id}.jpg`) },
      ],
    });
  });

  it("any ref that is gone, another session's, or a link refuses the whole list", async () => {
    const mine = await saved(SID, NOTES);
    const theirs = await saved(SID2, NOTES);
    const gone = { ok: false, code: 'not_found', reason: ATTACHMENT_GONE };
    expect(await store.resolve(SID, [{ upload: mine.id, label: 'a' }, { upload: theirs.id, label: 'b' }])).toEqual(gone);
    expect(await store.resolve(SID, [{ upload: '01jfz8x8y3t0v5g9wqk2m4n6pr', label: 'a' }])).toEqual(gone);
    const target = join(home.home, 'target.png');
    writeFileSync(target, PNG);
    symlinkSync(target, join(root, SID, '01jfz8x8y3t0v5g9wqk2m4n6ps.png'));
    expect(await store.resolve(SID, [{ upload: '01jfz8x8y3t0v5g9wqk2m4n6ps', label: 'a' }])).toEqual(gone);
    await store.remove(SID, mine.id);
    expect(await store.resolve(SID, [{ upload: mine.id, label: 'a' }])).toEqual(gone);
  });
});
