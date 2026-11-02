/**
 * Chat's photos (spec 0.10 B4): only JPEG, PNG, WebP and GIF by their magic
 * bytes (HEIC, SVG and text refused), the size from the fake sips, a
 * re-encode to JPEG at 1568 px past the edge or 1.5 MB, a refusal when sips
 * is missing and one would be needed, files 0600 in a 0700 folder written
 * with O_EXCL (never through a link), the store-wide cap oldest first.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFakeHome, makeJpeg, makePng, type FakeHome } from '@jantar/fixtures';
import type { Bins, LifeDb } from '../../src/contracts.js';
import { openChatDb } from '../../src/chat/db.js';
import { CHAT_PHOTO_SENTENCES, ChatPhotos, headerSize, sipsSize } from '../../src/chat/photos.js';
import { ChatStore } from '../../src/chat/store.js';
import { createExecFile } from '../../src/core/exec.js';
import { createTestContext } from '../../src/core/testing.js';

let home: FakeHome;
let root: string;
const dbs: LifeDb[] = [];
beforeAll(async () => {
  home = await makeFakeHome({ sessions: [] });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-chatphotos-')));
});
afterAll(async () => {
  for (const d of dbs) d.close();
  rmSync(root, { recursive: true, force: true });
  await home.cleanup();
});

let n = 0;
function rig(sips: string | null = 'fake') {
  n += 1;
  const dir = join(root, `h${n}`);
  mkdirSync(dir, { mode: 0o700 });
  const ctx = createTestContext({ exec: createExecFile({ env: home.env }) });
  const paths = { ...ctx.paths, chatDir: join(dir, 'chat') };
  const bins: Bins = { ...ctx.bins, sips: sips === 'fake' ? home.bins.sips : sips };
  const photos = new ChatPhotos({ ...ctx, paths, bins });
  const r = openChatDb(':memory:');
  if (!r.ok) throw new Error(r.reason);
  dbs.push(r.db);
  return { photos, store: new ChatStore(r.db), dir: join(dir, 'chat', 'photos') };
}

describe('headerSize and sipsSize', () => {
  it('read PNG, JPEG and GIF headers; sips -g output', () => {
    expect(headerSize(makePng(30, 20))).toEqual({ w: 30, h: 20 });
    expect(headerSize(makeJpeg(64, 48))).toEqual({ w: 64, h: 48 });
    const gif = Buffer.from('GIF89a\x10\x00\x08\x00', 'latin1');
    expect(headerSize(gif)).toEqual({ w: 16, h: 8 });
    expect(headerSize(Buffer.from('<svg/>'))).toBeNull();
    expect(sipsSize('/x.png\n  pixelWidth: 640\n  pixelHeight: 480\n')).toEqual({ w: 640, h: 480 });
  });
});

describe('ChatPhotos.add', () => {
  it('keeps a small JPEG as it is: 0600 in a 0700 folder, its size from sips', async () => {
    const { photos, store, dir } = rig();
    const r = await photos.add(makeJpeg(64, 48), store);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.value.id : '';
    expect(store.photo(id)).toMatchObject({ w: 64, h: 48, type: 'image/jpeg', turnId: null });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual([`${id}.jpg`]);
    expect(statSync(join(dir, `${id}.jpg`)).mode & 0o777).toBe(0o600);
    expect((await photos.read(store.photo(id)!))?.length).toBeGreaterThan(0);
  });

  it('re-encodes a big one to JPEG at 1568 px', async () => {
    const { photos, store, dir } = rig();
    const r = await photos.add(makePng(3000, 2000), store);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.value.id : '';
    expect(store.photo(id)).toMatchObject({ w: 1568, h: 1045, type: 'image/jpeg' });
    expect(readdirSync(dir)).toEqual([`${id}.jpg`]);
  });

  it('refuses HEIC, SVG, text, empty; without sips a big one is too big and a small one is kept', async () => {
    const { photos, store } = rig();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(32)]);
    expect(await photos.add(heic, store)).toMatchObject({ ok: false, reason: CHAT_PHOTO_SENTENCES.heic });
    expect(await photos.add(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), store)).toMatchObject({ ok: false, reason: CHAT_PHOTO_SENTENCES.notPhoto });
    expect(await photos.add(Buffer.from('just some text'), store)).toMatchObject({ ok: false, reason: CHAT_PHOTO_SENTENCES.notPhoto });
    expect(await photos.add(Buffer.alloc(0), store)).toMatchObject({ ok: false, reason: CHAT_PHOTO_SENTENCES.empty });
    const none = rig(null);
    expect(await none.photos.add(makePng(3000, 2000), none.store)).toMatchObject({ ok: false, reason: CHAT_PHOTO_SENTENCES.tooBig });
    const small = await none.photos.add(makePng(40, 30), none.store);
    expect(small.ok).toBe(true);
    expect(none.store.photo(small.ok ? small.value.id : '')).toMatchObject({ w: 40, h: 30, type: 'image/png' });
  });

  it('never reads through a link', async () => {
    const { photos, store, dir } = rig();
    const r = await photos.add(makeJpeg(10, 10), store);
    const row = store.photo(r.ok ? r.value.id : '')!;
    const file = join(dir, `${row.id}.jpg`);
    rmSync(file);
    const outside = join(root, 'outside.jpg');
    writeFileSync(outside, makeJpeg(10, 10));
    symlinkSync(outside, file);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(await photos.read(row)).toBeNull();
  });

  it('keeps the folder under the cap, oldest first', async () => {
    const { photos, store } = rig();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await photos.add(makeJpeg(20, 20), store);
      if (r.ok) ids.push(r.value.id);
    }
    const each = store.photo(ids[0]!)!.bytes;
    const gone = await photos.cap(store, each * 2);
    expect(gone.map((p) => p.id)).toEqual([ids[0]]);
    expect(store.photoCount()).toBe(2);
    chmodSync(root, 0o700);
  });
});
