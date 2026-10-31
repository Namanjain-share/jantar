/**
 * The MeetingsStore (meetings/store.ts) on an in-memory meetings.db, through
 * createTestMeetingsCore (the helper WP-MS and WP-SU build on): records
 * checked with zod on write and read, one meeting per (extension, client
 * id), lines kept at their highest revision, screenshot rows unique per key,
 * ends, removal with lines and shots, the list's cursor, project filter and
 * search (escaped, over name, people, summary and lines), and the stale and
 * waiting-summary reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeetingRecord, MeetingRow } from '../../src/contracts.js';
import { createTestMeetingsCore, type TestMeetingsCore } from '../../src/core/testing.js';

let core: TestMeetingsCore;
beforeEach(() => {
  core = createTestMeetingsCore();
});
afterEach(() => core.close());

const EXT = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const PROJECT = '01JFZ8X8Y3T0V5G9WQK2M4N6PS';
const T = (min: number) => new Date(Date.parse('2026-10-30T10:00:00.000Z') + min * 60_000).toISOString();

function record(over: Partial<MeetingRecord> = {}): MeetingRecord {
  return { name: 'Weekly sync', site: 'meet', autoTodos: false, notes: true, summary: { state: 'none', decisions: [], items: [] }, ...over };
}

function meeting(n: number, over: Partial<MeetingRow> = {}): MeetingRow {
  const id = core.newId();
  const row: MeetingRow = { id, extId: EXT, clientId: `client-${n}`, startedAt: T(n), endedAt: null, lastAt: T(n), projectId: null, record: record(), ...over };
  core.meetings.create(row);
  return row;
}

describe('MeetingsStore', () => {
  it('creates, finds by client id and by id, and refuses a second row for the same call', () => {
    const m = meeting(0, { projectId: PROJECT, record: record({ people: 'Sam, Priya' }) });
    expect(core.meetings.byClient(EXT, 'client-0')).toEqual(m);
    expect(core.meetings.get(m.id)).toEqual(m);
    expect(core.meetings.byClient('other', 'client-0')).toBeNull();
    expect(() => core.meetings.create({ ...m, id: core.newId() })).toThrow(/UNIQUE/);
    expect(core.store()).toBe(core.meetings);
  });

  it('checks the record on write, and skips (and logs by id) a row that fails on read', () => {
    expect(() => meeting(0, { record: { ...record(), surprise: 1 } as unknown as MeetingRecord })).toThrow();
    const m = meeting(1);
    core.db.prepare("UPDATE meetings SET json = '{\"name\":\"\"}' WHERE id = ?").run(m.id);
    expect(core.meetings.get(m.id)).toBeNull();
    expect(core.meetings.list({ limit: 30 }).rows).toEqual([]);
    expect(core.ctx.log.records.some((r) => r.msg === 'meetings: a meeting row failed its check' && r.fields?.meetingId === m.id)).toBe(true);
  });

  it('updates the record in one transaction, sets the project, touches and ends once', () => {
    const m = meeting(0);
    expect(core.meetings.update(m.id, (r) => ({ ...r, name: 'Renamed', notes: true }))).toBe(true);
    expect(core.meetings.update(core.newId(), (r) => r)).toBe(false);
    expect(() => core.meetings.update(m.id, (r) => ({ ...r, name: '' }))).toThrow();
    expect(core.meetings.get(m.id)?.record.name).toBe('Renamed');
    expect(core.meetings.setProject(m.id, PROJECT)).toBe(true);
    expect(core.meetings.get(m.id)?.projectId).toBe(PROJECT);
    expect(core.meetings.setProject(m.id, null)).toBe(true);
    core.meetings.touch(m.id, T(5));
    expect(core.meetings.get(m.id)?.lastAt).toBe(T(5));
    expect(core.meetings.openCount()).toBe(1);
    expect(core.meetings.end(m.id, T(6), 'left')).toBe(true);
    expect(core.meetings.end(m.id, T(7), 'user')).toBe(false);
    expect(core.meetings.get(m.id)).toMatchObject({ endedAt: T(6), record: { endReason: 'left' } });
    expect(core.meetings.openCount()).toBe(0);
    expect(core.meetings.count()).toBe(1);
  });

  it('keeps each line at its highest revision and counts what changed', () => {
    const m = meeting(0);
    const line = (lineId: string, rev: number, text: string, at = 1000) => ({ lineId, rev, at, speaker: 'Sam', text });
    expect(core.meetings.upsertLines(m.id, [line('a-1', 1, 'Hello'), line('a-2', 1, 'Second', 2000)])).toBe(2);
    expect(core.meetings.upsertLines(m.id, [line('a-1', 3, 'Hello there'), line('a-2', 1, 'stale')])).toBe(1);
    expect(core.meetings.upsertLines(m.id, [line('a-1', 2, 'older')])).toBe(0);
    expect(core.meetings.lines(m.id)).toEqual([line('a-1', 3, 'Hello there'), line('a-2', 1, 'Second', 2000)]);
    expect(core.meetings.lineCount(m.id)).toBe(2);
    expect(core.meetings.lineChars(m.id)).toBe('Hello there'.length + 'Second'.length);
    expect([...core.meetings.knownLineIds(m.id, ['a-2', 'a-9', 'a-1'])].sort()).toEqual(['a-1', 'a-2']);
    expect(core.meetings.knownLineIds(meeting(1).id, ['a-1']).size).toBe(0);
    // More ids than one statement takes.
    const many = Array.from({ length: 450 }, (_, i) => `b-${i}`);
    core.meetings.upsertLines(m.id, [line('b-0', 1, 'first'), line('b-449', 1, 'last')]);
    expect([...core.meetings.knownLineIds(m.id, many)].sort()).toEqual(['b-0', 'b-449']);
  });

  it('stores one screenshot row per key, reads them by time, and totals their bytes', () => {
    const a = meeting(0);
    const b = meeting(1);
    const s1 = { id: core.newId(), key: 'k1', at: 2000, bytes: 100 };
    expect(core.meetings.addShot(a.id, s1)).toEqual({ id: s1.id, duplicate: false });
    expect(core.meetings.addShot(a.id, { ...s1, id: core.newId() })).toEqual({ id: s1.id, duplicate: true });
    const s2 = { id: core.newId(), key: 'k2', at: 1000, bytes: 50 };
    core.meetings.addShot(a.id, s2);
    core.meetings.addShot(b.id, { id: core.newId(), key: 'k1', at: 0, bytes: 7 });
    expect(core.meetings.shots(a.id)).toEqual([s2, s1]);
    expect(core.meetings.shot(a.id, s1.id)).toEqual(s1);
    expect(core.meetings.shot(b.id, s1.id)).toBeNull();
    expect(core.meetings.shotByKey(a.id, 'k1')).toEqual(s1);
    expect(core.meetings.shotByKey(a.id, 'k3')).toBeNull();
    expect(core.meetings.shotByKey(b.id, 'k2')).toBeNull();
    expect(core.meetings.shotCount(a.id)).toBe(2);
    expect(core.meetings.shotBytesTotal()).toBe(157);
  });

  it('removes a meeting with its lines and screenshot rows, and nothing else', () => {
    const a = meeting(0);
    const b = meeting(1);
    core.meetings.upsertLines(a.id, [{ lineId: 'x-1', rev: 1, at: 0, speaker: 'Sam', text: 'hi' }]);
    core.meetings.addShot(a.id, { id: core.newId(), key: 'k', at: 0, bytes: 9 });
    core.meetings.upsertLines(b.id, [{ lineId: 'x-1', rev: 1, at: 0, speaker: 'Sam', text: 'kept' }]);
    expect(core.meetings.remove(a.id)).toBe(true);
    expect(core.meetings.remove(a.id)).toBe(false);
    expect(core.meetings.lines(a.id)).toEqual([]);
    expect(core.meetings.shotBytesTotal()).toBe(0);
    expect(core.meetings.lines(b.id)).toHaveLength(1);
  });

  it('lists newest first in pages with a cursor, and finds the newest open meeting whatever the filter', () => {
    const rows = Array.from({ length: 5 }, (_, i) => meeting(i, { endedAt: i === 4 ? null : T(i + 1) }));
    const first = core.meetings.list({ limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([rows[4]?.id, rows[3]?.id]);
    expect(first.next).toBe(`${rows[3]?.startedAt}|${rows[3]?.id}`);
    const second = core.meetings.list({ limit: 2, before: first.next ?? undefined });
    expect(second.rows.map((r) => r.id)).toEqual([rows[2]?.id, rows[1]?.id]);
    const last = core.meetings.list({ limit: 2, before: second.next ?? undefined });
    expect(last.rows.map((r) => r.id)).toEqual([rows[0]?.id]);
    expect(last.next).toBeNull();
    expect(core.meetings.list({ limit: 30, before: 'not a cursor' }).rows).toHaveLength(5);
    expect(core.meetings.newestOpen()?.id).toBe(rows[4]?.id);
  });

  it('filters by project or none', () => {
    const a = meeting(0, { projectId: PROJECT });
    const b = meeting(1);
    expect(core.meetings.list({ limit: 30, project: PROJECT }).rows.map((r) => r.id)).toEqual([a.id]);
    expect(core.meetings.list({ limit: 30, project: 'none' }).rows.map((r) => r.id)).toEqual([b.id]);
  });

  it('searches the name, people, summary text and any line, case-insensitively, with % and _ taken literally', () => {
    const byName = meeting(0, { record: record({ name: 'Launch review' }) });
    const byPeople = meeting(1, { record: record({ name: 'Sync', people: 'Priya' }) });
    const bySummary = meeting(2, { record: record({ name: 'Sync', summary: { state: 'done', text: 'The launch moves.', decisions: [], items: [] } }) });
    const byLine = meeting(3, { record: record({ name: 'Sync' }) });
    core.meetings.upsertLines(byLine.id, [{ lineId: 'l-1', rev: 1, at: 0, speaker: 'Sam', text: 'about the LAUNCH date' }]);
    const literal = meeting(4, { record: record({ name: '100% done_now' }) });
    meeting(5, { record: record({ name: 'Unrelated' }) });
    const ids = (q: string) => core.meetings.list({ limit: 30, q }).rows.map((r) => r.id).sort();
    expect(ids('launch')).toEqual([byName.id, bySummary.id, byLine.id].sort());
    expect(ids('priya')).toEqual([byPeople.id]);
    expect(ids('%')).toEqual([literal.id]);
    expect(ids('e_n')).toEqual([literal.id]);
    // A key of the record is not its text.
    expect(ids('autoTodos')).toEqual([]);
  });

  it('finds open meetings gone quiet, and summaries left queued or running', () => {
    const quiet = meeting(0, { lastAt: T(0) });
    meeting(1, { lastAt: T(20) });
    meeting(2, { lastAt: T(0), endedAt: T(1) });
    expect(core.meetings.staleOpen(T(10)).map((r) => r.id)).toEqual([quiet.id]);
    const queued = meeting(3, { record: record({ summary: { state: 'queued', decisions: [], items: [] } }) });
    const running = meeting(4, { record: record({ summary: { state: 'running', decisions: [], items: [] } }) });
    meeting(5, { record: record({ summary: { state: 'failed', reason: 'x', decisions: [], items: [] } }) });
    expect(core.meetings.summaryWaiting().map((r) => r.id)).toEqual([queued.id, running.id]);
  });
});

describe('createTestMeetingsCore', () => {
  it('counts ticks, records queued summaries and todo calls, and follows the Life zone', () => {
    core.changed();
    core.enqueueSummary('m1');
    expect(core.ticks).toBe(1);
    expect(core.enqueued).toEqual(['m1']);
    const created = core.life.todos.createTodo({ title: 'Send the quote' }, { kind: 'system' });
    expect(created.ok).toBe(true);
    expect(core.todos.created).toHaveLength(1);
    expect(core.life.todos.listProjects()).toEqual({ ok: true, value: { projects: [] } });
    expect(core.tz()).toBe('UTC');
    core.setSettings({ life: { timezone: 'Asia/Kolkata' } });
    expect(core.tz()).toBe('Asia/Kolkata');
    expect(core.readOnly).toBe(false);
  });
});
