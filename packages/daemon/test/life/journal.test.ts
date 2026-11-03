/**
 * v0.12 People (P2): her journal (spec 3.11, O3).
 *
 * - Kinds and limits; a check-in needs a mood; the client id makes a double
 *   tap one entry; an entry's day is today or earlier, never later.
 * - Only she writes, edits and deletes her entries (no owner verb, D22).
 * - Comments by either person (his with comment.journal); each deletes only
 *   their own; deleting an entry deletes its comments.
 * - His comment pushes her once, with no text, held by her quiet hours and
 *   counted against her caps; her reply pushes him.
 * - The streak, and `hideStreaks` giving null on both sides (one DTO).
 * - No entry or comment text in a push, the audit, the logs or Activity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JournalEntryFull, JournalList, PersonActivityResponse } from '@jantar/protocol/people';
import { makeFixture, type Fixture } from '../people/isolation-fixture.js';
import { EP, kit } from '../people/p2-kit.js';

let f: Fixture;
const k = kit(() => f);
beforeEach(async () => {
  f = await makeFixture();
}, 60_000);
afterEach(async () => {
  await f?.close();
});

let n = 0;
const cid = () => `journal-${(n += 1).toString().padStart(4, '0')}`;
const create = (body: object, who = f.asha.full) => k.her('POST', '/v1/p/journal', { clientId: cid(), ...body }, who);
const list = async () => (await k.her('GET', '/v1/p/journal')).json() as JournalList;
const hisList = () => k.him('GET', `/v1/people/${f.asha.id}/journal`);
const hisComment = (id: string, text: string) => k.him('POST', `/v1/people/${f.asha.id}/journal/${id}/comments`, { text });

describe('entries', () => {
  it('kinds and limits; a double tap is one check-in; today or earlier only', async () => {
    const e = await create({ kind: 'entry', text: 'A long walk.', mood: 4, emotions: ['joy', 'joy', 'connection'] });
    expect(e.statusCode, e.body).toBe(201);
    const id = cid();
    const c1 = await k.her('POST', '/v1/p/journal', { kind: 'checkin', mood: 3, emotions: ['flat'], text: 'ok', clientId: id });
    const c2 = await k.her('POST', '/v1/p/journal', { kind: 'checkin', mood: 3, emotions: ['flat'], text: 'ok', clientId: id });
    expect(c1.json().id).toBe(c2.json().id);
    // A check-in needs a mood, its line is at most 200; an entry needs text or a mood; at most 3 emotions from the set.
    expect((await create({ kind: 'checkin', text: 'no mood' })).statusCode).toBe(400);
    expect((await create({ kind: 'checkin', mood: 3, text: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await create({ kind: 'entry' })).statusCode).toBe(400);
    expect((await create({ kind: 'entry', text: 'x', emotions: ['joy', 'fear', 'anger', 'flat'] })).statusCode).toBe(400);
    expect((await create({ kind: 'entry', text: 'x', emotions: ['bored'] })).statusCode).toBe(400);
    expect((await create({ kind: 'entry', text: 'x'.repeat(8001) })).statusCode).toBe(400);
    // Yesterday is fine; tomorrow is not. A review entry can't be made directly.
    expect((await create({ kind: 'entry', text: 'About yesterday', day: '2026-11-02' })).statusCode).toBe(201);
    expect((await create({ kind: 'entry', text: 'Tomorrow', day: '2026-11-04' })).statusCode).toBe(400);
    expect((await create({ kind: 'review', text: 'x' })).statusCode).toBe(400);
    const l = await list();
    expect(l.entries.map((x) => [x.kind, x.day, x.emotions])).toEqual([
      ['entry', '2026-11-02', undefined],
      ['checkin', '2026-11-03', ['flat']],
      ['entry', '2026-11-03', ['joy', 'connection']],
    ]);
    expect(l.streak).toEqual({ current: 2, best: 2 });
    // She edits (editedAt) and deletes her own.
    const eid = (e.json() as { id: string }).id;
    expect((await k.her('PATCH', `/v1/p/journal/${eid}`, { text: 'A longer walk.' })).statusCode).toBe(200);
    const one = (await k.her('GET', `/v1/p/journal/${eid}`)).json() as JournalEntryFull;
    expect(one.entry).toMatchObject({ text: 'A longer walk.', comments: 0 });
    expect(one.entry.editedAt).toBeDefined();
    expect((await k.her('PATCH', `/v1/p/journal/${eid}`, { text: null, mood: null })).statusCode).toBe(400);
  });

  it('hideStreaks gives null on her list, his and the mirror', async () => {
    await create({ kind: 'entry', text: 'x' });
    expect((await list()).streak).not.toBeNull();
    await k.her('PATCH', '/v1/p/prefs', { hideStreaks: true });
    expect((await list()).streak).toBeNull();
    expect(((await hisList()).json() as JournalList).streak).toBeNull();
    expect(((await k.her('GET', '/v1/p/mirror/journal')).json() as JournalList).streak).toBeNull();
  });

  it('he reads (a view mark, no text) but has no verb on her words; off is the unknown-person 404', async () => {
    const e = await create({ kind: 'entry', text: 'CANARY-JOURNAL-ENTRY' });
    const id = (e.json() as { id: string }).id;
    const his = await hisList();
    expect(his.statusCode).toBe(200);
    expect(his.json()).toEqual((await k.her('GET', '/v1/p/mirror/journal')).json());
    expect((await k.him('GET', `/v1/people/${f.asha.id}/journal/${id}`)).json().entry.text).toBe('CANARY-JOURNAL-ENTRY');
    for (const [m, url] of [
      ['POST', `/v1/people/${f.asha.id}/journal`],
      ['PATCH', `/v1/people/${f.asha.id}/journal/${id}`],
      ['DELETE', `/v1/people/${f.asha.id}/journal/${id}`],
    ] as const) {
      expect((await k.him(m, url, m === 'DELETE' ? undefined : { text: 'his words', kind: 'entry', clientId: 'xxxxxxxxxx' })).statusCode, url).toBe(404);
    }
    const act = (await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse;
    expect(act.activity.some((a) => a.action === 'view' && a.area === 'journal')).toBe(true);
    for (const t of [JSON.stringify(act), JSON.stringify(f.api.ctx.db.audit.list({ limit: 1000 })), JSON.stringify(f.api.ctx.log.records)]) expect(t).not.toMatch(/CANARY-JOURNAL/);
    await k.her('POST', '/v1/p/agreement/narrow', { see: { journal: false } });
    const off = await hisList();
    const unknown = await k.him('GET', '/v1/people/01JZZZZZZZZZZZZZZZZZZZZZZZ/journal');
    expect([off.statusCode, off.body]).toEqual([unknown.statusCode, unknown.body]);
    expect((await k.him('GET', `/v1/people/${f.asha.id}/journal/${id}`)).statusCode).toBe(404);
    // Bea (Standard: journal off) is the unknown-person 404 for him, and her own list never holds Asha's entries.
    expect((await k.him('GET', `/v1/people/${f.bea.id}/journal`)).statusCode).toBe(404);
    expect(((await k.her('GET', '/v1/p/journal', undefined, f.bea.full)).json() as JournalList).entries).toEqual([]);
  });
});

describe('comments', () => {
  it('either person comments; each deletes only their own; deleting the entry deletes them all', async () => {
    await k.subscribeAll();
    const id = ((await create({ kind: 'entry', text: 'Hard day.' })).json() as { id: string }).id;
    const his = await hisComment(id, 'CANARY-COMMENT-HIS');
    expect(his.statusCode, his.body).toBe(201);
    // Her push: once, no text, on her devices only.
    expect(k.to(EP.asha).map((p) => p.body)).toEqual(['Sam commented on your journal.']);
    expect(k.to(EP.bea)).toEqual([]);
    const mine = await k.her('POST', `/v1/p/journal/${id}/comments`, { text: 'CANARY-COMMENT-HERS' });
    expect(mine.statusCode).toBe(201);
    expect(k.to(EP.sam).map((p) => p.body)).toEqual(['Asha replied in the journal.']);
    const full = (await k.her('GET', `/v1/p/journal/${id}`)).json() as JournalEntryFull;
    expect(full.comments.map((c) => [c.by, c.text])).toEqual([
      ['', 'CANARY-COMMENT-HIS'],
      [f.asha.id, 'CANARY-COMMENT-HERS'],
    ]);
    expect(((await list()).entries[0])?.comments).toBe(2);
    const hisId = full.comments[0]?.id as string;
    const herId = full.comments[1]?.id as string;
    // She can't delete his; he can't delete hers.
    expect((await k.her('DELETE', `/v1/p/journal/${id}/comments/${hisId}`)).statusCode).toBe(404);
    expect((await k.him('DELETE', `/v1/people/${f.asha.id}/journal/${id}/comments/${herId}`)).statusCode).toBe(404);
    expect((await k.him('DELETE', `/v1/people/${f.asha.id}/journal/${id}/comments/${hisId}`)).statusCode).toBe(200);
    // Her Activity says he commented, never what.
    const act = (await k.her('GET', '/v1/p/activity')).json() as PersonActivityResponse;
    expect(act.activity.find((a) => a.action === 'journal.commented')?.title).toBe('your entry of Tue 3 Nov');
    for (const t of [JSON.stringify(act), JSON.stringify(f.api.ctx.db.audit.list({ limit: 1000 })), JSON.stringify(f.api.ctx.log.records), JSON.stringify(k.sent())]) {
      expect(t).not.toMatch(/CANARY-COMMENT/);
    }
    await k.her('DELETE', `/v1/p/journal/${id}`);
    const core = f.life.people.openCore();
    expect((core?.db.prepare('SELECT COUNT(*) AS n FROM journal_comments WHERE space = ?').get(f.asha.id) as { n: number }).n).toBe(0);
  });

  it('comment.journal off: his comment is 404; her quiet hours hold his comment push and release one summary', async () => {
    await k.subscribeAll();
    const id = ((await create({ kind: 'entry', text: 'x' })).json() as { id: string }).id;
    await k.her('PATCH', '/v1/p/prefs', { quiet: { from: '08:00', to: '10:00' } });
    expect((await hisComment(id, 'later')).statusCode).toBe(201);
    expect(k.to(EP.asha)).toEqual([]);
    await k.at('2026-11-03T10:00:30.000Z');
    await k.advance(2_000);
    expect(k.to(EP.asha).map((p) => p.body)).toEqual(['A comment from Sam while you were in quiet hours.']);
    await k.her('POST', '/v1/p/agreement/narrow', { comment: { journal: false } });
    expect((await hisComment(id, 'nope')).statusCode).toBe(404);
  });

  it('his comments count against her caps: over them the comment is kept, with no push', async () => {
    await k.subscribeAll();
    await k.her('PATCH', '/v1/p/prefs', { alertCaps: { hour: 1, day: 3, urgentDay: 1, nudgeGapMin: 60, nudgeDay: 0 } });
    const id = ((await create({ kind: 'entry', text: 'x' })).json() as { id: string }).id;
    expect((await hisComment(id, 'one')).statusCode).toBe(201);
    expect((await hisComment(id, 'two')).statusCode).toBe(201);
    expect(k.to(EP.asha)).toHaveLength(1);
    expect(((await k.her('GET', `/v1/p/journal/${id}`)).json() as JournalEntryFull).comments).toHaveLength(2);
  });
});
