/**
 * U7: the sweep unlinks regular files with an upload's name that were
 * written more than 7 days ago, removes the session folders left empty, and
 * leaves everything else alone: newer files, other names, links (never
 * followed, never removed), linked folders and stranger folders. It returns
 * the count.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_KEEP_MS } from '@jantar/protocol';
import { UPLOAD_SWEEP_EVERY_MS } from '../../src/api/server.js';
import { UploadStore } from '../../src/uploads/store.js';
import { sweepUploads } from '../../src/uploads/sweep.js';
import { NOTES, SID, SID2, tempHome, uploadsContext } from './helpers.js';

const NOW = Date.parse('2026-01-15T10:00:00.000Z');
const DAY = 24 * 60 * 60_000;

let home: ReturnType<typeof tempHome>;
let root: string;
beforeEach(() => {
  home = tempHome();
  root = join(home.home, '.jantar', 'uploads');
});
afterEach(() => home.cleanup());

/** A file at root/<rel>, last written `age` ms before NOW. */
function put(rel: string, age: number, body: string | Buffer = 'x'): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  const t = (NOW - age) / 1000;
  utimesSync(p, t, t);
  return p;
}

const ID1 = '01jfz8x8y3t0v5g9wqk2m4n6pr';
const ID2 = '01jfz8x8y3t0v5g9wqk2m4n6ps';
const ID3 = '01jfz8x8y3t0v5g9wqk2m4n6pt';

describe('sweepUploads', () => {
  it('removes uploads older than 7 days, keeps newer ones and the one exactly 7 days old', async () => {
    put(`${SID}/${ID1}.png`, UPLOAD_KEEP_MS + 1);
    put(`${SID}/${ID2}.txt`, UPLOAD_KEEP_MS);
    put(`${SID}/${ID3}.pdf`, DAY);
    put(`${SID2}/${ID1}.md`, 30 * DAY);
    expect(await sweepUploads(root, NOW)).toBe(2);
    expect(readdirSync(join(root, SID)).sort()).toEqual([`${ID2}.txt`, `${ID3}.pdf`]);
    // SID2's folder was left empty: it goes too.
    expect(readdirSync(root)).toEqual([SID]);
  });

  it('leaves other names, links and their targets, linked folders and stranger folders alone', async () => {
    const old = 30 * DAY;
    put(`${SID}/notes.txt`, old);
    put(`${SID}/${ID1.toUpperCase()}.png`, old);
    put(`${SID}/${ID1}.png.bak`, old);
    put(`${SID}/${ID1}`, old);
    const target = join(home.home, 'outside', `${ID2}.png`);
    mkdirSync(join(home.home, 'outside'));
    writeFileSync(target, 'not ours');
    utimesSync(target, (NOW - old) / 1000, (NOW - old) / 1000);
    symlinkSync(target, join(root, SID, `${ID2}.png`));
    // A linked session folder: never entered, never removed.
    symlinkSync(join(home.home, 'outside'), join(root, SID2));
    // Folders that are not session-shaped, and a file at the top.
    put(`.hidden/${ID3}.png`, old);
    put(`x/${ID3}.png`, old);
    put(`${ID3}.png`, old);
    // A real upload in a nested folder is not where uploads live.
    put(`${SID}/inner/${ID3}.png`, old);
    expect(await sweepUploads(root, NOW)).toBe(0);
    expect(readdirSync(join(root, SID)).sort()).toEqual([`${ID1}`, `${ID1.toUpperCase()}.png`, `${ID1}.png.bak`, `${ID2}.png`, 'inner', 'notes.txt'].sort());
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(join(root, SID2)).isSymbolicLink()).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['.hidden', `${ID3}.png`, SID, SID2, 'x'].sort());
  });

  it('removes empty session folders, keeps one with files, and is fine with a missing or linked uploads folder', async () => {
    mkdirSync(join(root, SID), { recursive: true });
    put(`${SID2}/${ID1}.txt`, DAY);
    expect(await sweepUploads(root, NOW)).toBe(0);
    expect(readdirSync(root)).toEqual([SID2]);
    expect(await sweepUploads(join(home.home, 'missing'), NOW)).toBe(0);
    const linked = join(home.home, 'linked-uploads');
    symlinkSync(root, linked);
    put(`${SID2}/${ID2}.txt`, 30 * DAY);
    expect(await sweepUploads(linked, NOW)).toBe(0);
    expect(readdirSync(join(root, SID2)).sort()).toEqual([`${ID1}.txt`, `${ID2}.txt`]);
  });
});

describe('UploadStore.sweep', () => {
  it("uses the daemon's clock and its uploads folder, and a saved file goes once it is 7 days old", async () => {
    const ctx = uploadsContext(home.home);
    const store = new UploadStore(ctx);
    const r = await store.save(SID, NOTES, { ext: 'md' });
    if (!r.ok) throw new Error(r.reason);
    const file = join(ctx.paths.uploadsDir, SID, `${r.upload.id}.md`);
    const t = ctx.clock.now() / 1000;
    utimesSync(file, t, t);
    expect(await store.sweep()).toBe(0);
    ctx.clock.advance(UPLOAD_KEEP_MS);
    expect(await store.sweep()).toBe(0);
    ctx.clock.advance(UPLOAD_SWEEP_EVERY_MS);
    expect(await store.sweep()).toBe(1);
    expect(existsSync(join(ctx.paths.uploadsDir, SID))).toBe(false);
  });
});
