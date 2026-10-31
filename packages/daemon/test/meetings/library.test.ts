/**
 * The library (meetings/library.ts) on createTestMeetingsCore with a real
 * meetings folder: the list (newest first, its cursor, the project filter
 * and 'none', search over name, people, summary and lines, `running`
 * whatever the filter, counts, `gist`, `projectName` only while Todos are on
 * and the project is there); get (every line and screenshot by time, a
 * page's counter breaking a tie in time, ISO times, 404); a screenshot's
 * bytes (only that meeting's, never a missing file, 503 when the disk will
 * not read); edits (name, project, people, null clearing, the todos switch
 * only while no summary runs or is done, an unknown project 404, any project
 * 404 while Todos are off); delete (MF6: the rows and the folder and
 * nothing else, a symlinked folder unlinked and its target kept, a folder
 * that will not go logged by code, the extension's next post 404, no summary
 * queued and a running one stopped); and
 * MP3 (each edit ticks once, reads never). The 9.5 gates for get and search
 * are measured through the routes (api/meetings-routes.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEETING_T0, extLinesBody, extOpenBody, extShotBody, lineUpsert, makeJpeg, transcriptLines } from '@jantar/fixtures';
import { MeetingDetailSchema, MeetingsListSchema, type MeetingsQuery, type ProjectView, type SummaryState } from '@jantar/protocol';
import type { Actor, MeetingCapture, MeetingLibrary, MeetingRecord, MeetingRow } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createTestMeetingsCore, type TestMeetingsCore } from '../../src/core/testing.js';
import { buildCapture } from '../../src/meetings/capture.js';
import { MEETING_REASONS } from '../../src/meetings/common.js';
import { buildLibrary } from '../../src/meetings/library.js';

const EXT = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const PHONE: Actor = { kind: 'device', deviceId: '01JFZ8X8Y3T0V5G9WQK2M4N6PD', scopes: ['read', 'control'] };
const MIN = 60_000;
const at = (min: number) => new Date(MEETING_T0 + min * MIN).toISOString();

let base: string;
let core: TestMeetingsCore;
let library: MeetingLibrary;
let capture: MeetingCapture;

function project(n: number, over: Partial<ProjectView> = {}): ProjectView {
  return { id: `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`, name: `Project ${n}`, status: 'active', open: 0, overdue: 0, createdAt: at(0), updatedAt: at(0), ...over };
}

function rig(opts: { todos?: boolean; projects?: ProjectView[] } = {}): void {
  core?.close();
  core = createTestMeetingsCore({ clock: new FakeClock(MEETING_T0), ctx: { home: base }, settings: { life: { todos: opts.todos ?? true } }, projects: opts.projects ?? [project(1), project(2)] });
  library = buildLibrary(core);
  capture = buildCapture(core);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-library-')));
  rig();
});
afterEach(() => {
  core.close();
  rmSync(base, { recursive: true, force: true });
});

function value<T>(r: { ok: true; value: T } | { ok: false; code: string; reason: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.value;
}

function record(over: Partial<MeetingRecord> = {}): MeetingRecord {
  return { name: 'Weekly sync', site: 'meet', autoTodos: false, notes: true, summary: { state: 'none', decisions: [], items: [] }, ...over };
}

/** A meeting row started `min` minutes after MEETING_T0 (ended unless `open`). */
function meeting(min: number, over: Partial<MeetingRow> & { open?: boolean } = {}): MeetingRow {
  const { open, ...rest } = over;
  const row: MeetingRow = { id: core.newId(), extId: EXT, clientId: randomUUID(), startedAt: at(min), endedAt: open ? null : at(min + 30), lastAt: at(min), projectId: null, record: record(), ...rest };
  core.meetings.create(row);
  return row;
}

const q = (over: Partial<MeetingsQuery> = {}): MeetingsQuery => ({ limit: 30, ...over });

describe('list', () => {
  it('is newest first with a cursor, each row with its counts and summary state', () => {
    const rows = [0, 10, 20, 30, 40].map((m) => meeting(m));
    core.meetings.upsertLines(rows[4]!.id, transcriptLines(3));
    core.meetings.addShot(rows[4]!.id, { id: core.newId(), key: randomUUID(), at: MEETING_T0, bytes: 100 });
    const first = value(library.list(q({ limit: 2 })));
    expect(MeetingsListSchema.parse(first)).toEqual(first);
    expect(first.meetings.map((m) => m.id)).toEqual([rows[4]!.id, rows[3]!.id]);
    expect(first.meetings[0]).toMatchObject({ lines: 3, shots: 1, summary: 'none', startedAt: at(40), endedAt: at(70), notes: true, site: 'meet' });
    const second = value(library.list(q({ limit: 2, before: first.next as string })));
    expect(second.meetings.map((m) => m.id)).toEqual([rows[2]!.id, rows[1]!.id]);
    const last = value(library.list(q({ limit: 2, before: second.next as string })));
    expect(last.meetings.map((m) => m.id)).toEqual([rows[0]!.id]);
    expect(last.next).toBeNull();
    expect(first.running).toBeNull();
  });

  it("filters by project ('none' is no project) and searches name, people, summary text and lines, literally", () => {
    const a = meeting(0, { projectId: project(1).id, record: record({ name: 'Budget review' }) });
    const b = meeting(10, { record: record({ people: 'Sam from Acme' }) });
    const c = meeting(20, { record: record({ summary: { state: 'done', text: 'Agreed a 50% discount.', decisions: [], items: [] } }) });
    const d = meeting(30, { projectId: project(2).id });
    core.meetings.upsertLines(d.id, [{ lineId: 'x-1', rev: 1, at: MEETING_T0, speaker: 'Priya', text: 'The quarterly_report is late' }]);
    const ids = (over: Partial<MeetingsQuery>) => value(library.list(q(over))).meetings.map((m) => m.id);
    expect(ids({ project: project(1).id })).toEqual([a.id]);
    expect(ids({ project: 'none' })).toEqual([c.id, b.id]);
    expect(ids({ q: 'budget' })).toEqual([a.id]);
    expect(ids({ q: 'Acme' })).toEqual([b.id]);
    expect(ids({ q: '50%' })).toEqual([c.id]);
    expect(ids({ q: 'quarterly_report' })).toEqual([d.id]);
    // % and _ match themselves only.
    expect(ids({ q: '%' })).toEqual([c.id]);
    expect(ids({ q: 'quarterly%report' })).toEqual([]);
  });

  it("names `running`, the newest open meeting, whatever the filter", () => {
    meeting(0, { open: true });
    const newer = meeting(10, { open: true, projectId: project(1).id });
    meeting(20);
    const list = value(library.list(q({ project: 'none', q: 'nothing matches this' })));
    expect(list.meetings).toEqual([]);
    expect(list.running).toMatchObject({ id: newer.id, endedAt: null, projectName: 'Project 1' });
  });

  it('gives the gist (160 characters, never half a surrogate pair) and the project name only while Todos are on and the project exists', () => {
    const long = `${'a'.repeat(159)}😀 and more`;
    const done = meeting(0, { projectId: project(1).id, record: record({ summary: { state: 'done', text: long, decisions: [], items: [] } }) });
    const gone = meeting(10, { projectId: project(9).id });
    const list = value(library.list(q()));
    const byId = new Map(list.meetings.map((m) => [m.id, m]));
    expect(byId.get(done.id)?.gist).toBe('a'.repeat(159));
    expect(byId.get(done.id)?.projectName).toBe('Project 1');
    expect(byId.get(gone.id)).toMatchObject({ projectId: project(9).id });
    expect(byId.get(gone.id)?.projectName).toBeUndefined();
    expect(byId.get(gone.id)?.gist).toBeUndefined();
    rig({ todos: false });
    meeting(0, { projectId: project(1).id });
    const off = value(library.list(q())).meetings[0];
    expect(off?.projectId).toBe(project(1).id);
    expect(off?.projectName).toBeUndefined();
  });
});

describe('get', () => {
  it('answers the meeting, its summary, every line and screenshot by time with ISO times; 404 for an unknown id', async () => {
    const id = value(capture.open(EXT, randomUUID(), extOpenBody({ projectId: project(2).id })));
    const clientId = core.meetings.get(id.id)!.clientId;
    value(capture.lines(EXT, clientId, extLinesBody(3)));
    const shot = value(await capture.shot(EXT, clientId, extShotBody(makeJpeg(16, 16), { at: MEETING_T0 + 20_000 })));
    const d = value(library.get(id.id));
    expect(MeetingDetailSchema.parse(d)).toEqual(d);
    expect(d.meeting).toMatchObject({ id: id.id, name: 'Weekly sync', people: 'Sam, Priya', projectId: project(2).id, projectName: 'Project 2', lines: 3, shots: 1, endedAt: null, summary: 'none' });
    expect(d.meeting.gist).toBeUndefined();
    expect(d.summary).toEqual({ state: 'none', decisions: [], items: [] });
    expect(d.lines.map((l) => [l.id, l.at, l.speaker])).toEqual([
      ['a1b2c3d4-1', new Date(MEETING_T0).toISOString(), 'Sam'],
      ['a1b2c3d4-2', new Date(MEETING_T0 + 15_000).toISOString(), 'Priya'],
      ['a1b2c3d4-3', new Date(MEETING_T0 + 30_000).toISOString(), 'You'],
    ]);
    expect(d.shots).toEqual([{ id: shot.id, at: new Date(MEETING_T0 + 20_000).toISOString(), bytes: makeJpeg(16, 16).length }]);
    expect(library.get(core.newId())).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.noMeeting });
  });

  it("orders lines that share a time by the page's counter ('-9' before '-10'), then by time as ever", () => {
    const m = meeting(0, { open: true });
    const seen = MEETING_T0 + 5_000;
    // One scan saw twelve lines at once (Start mid-call), and a second page (another nonce) one more at that time.
    const burst = Array.from({ length: 12 }, (_, i) => lineUpsert({ lineId: `p7Kq-${i + 1}`, text: `Line ${i + 1}`, at: seen }));
    core.meetings.upsertLines(m.id, [
      ...burst.reverse(),
      lineUpsert({ lineId: 'Zx-3', at: seen }),
      lineUpsert({ lineId: 'p7Kq-13', at: seen + 1_000 }),
      lineUpsert({ lineId: 'p7Kq-0', at: seen - 1_000 }),
    ]);
    expect(core.meetings.lines(m.id).map((l) => l.lineId).slice(1, 4)).toEqual(['Zx-3', 'p7Kq-1', 'p7Kq-10']);
    expect(value(library.get(m.id)).lines.map((l) => l.id)).toEqual(['p7Kq-0', 'Zx-3', ...Array.from({ length: 12 }, (_, i) => `p7Kq-${i + 1}`), 'p7Kq-13']);
  });
});

describe("a screenshot's bytes", () => {
  it("serves that meeting's screenshot only, and never a row without its file", async () => {
    const one = value(capture.open(EXT, randomUUID(), extOpenBody()));
    const two = value(capture.open(EXT, randomUUID(), extOpenBody()));
    const jpeg = makeJpeg(40, 30);
    const shot = value(await capture.shot(EXT, core.meetings.get(one.id)!.clientId, extShotBody(jpeg)));
    expect(value(await library.shotFile(one.id, shot.id)).body.equals(jpeg)).toBe(true);
    const noShot = { ok: false, code: 'not_found', reason: MEETING_REASONS.noShot };
    expect(await library.shotFile(two.id, shot.id)).toEqual(noShot);
    expect(await library.shotFile(one.id, core.newId())).toEqual(noShot);
    rmSync(join(core.ctx.paths.meetingsDir, one.id, `${shot.id}.jpg`));
    expect(await library.shotFile(one.id, shot.id)).toEqual(noShot);
  });

  it('a read the disk refuses is 503 with its sentence, logged by code', async () => {
    const one = value(capture.open(EXT, randomUUID(), extOpenBody()));
    const shot = value(await capture.shot(EXT, core.meetings.get(one.id)!.clientId, extShotBody()));
    const file = join(core.ctx.paths.meetingsDir, one.id, `${shot.id}.jpg`);
    chmodSync(file, 0o000);
    try {
      expect(await library.shotFile(one.id, shot.id)).toEqual({ ok: false, code: 'unavailable', reason: MEETING_REASONS.shotNotRead });
    } finally {
      chmodSync(file, 0o600);
    }
    expect(MEETING_REASONS.shotNotRead).toBe('The screenshot could not be read on the Mac.');
    expect(core.ctx.log.records.find((r) => r.msg === 'meetings: a screenshot was not read')?.fields?.error).toBe('EACCES');
    expect(JSON.stringify(core.ctx.log.records)).not.toContain(base);
  });

  it('drops the bytes when Meetings close while they are read', async () => {
    const one = value(capture.open(EXT, randomUUID(), extOpenBody()));
    const shot = value(await capture.shot(EXT, core.meetings.get(one.id)!.clientId, extShotBody()));
    let reads = 0;
    const closing = buildLibrary({ ...core, store: () => (++reads > 1 ? null : core.meetings) });
    expect(await closing.shotFile(one.id, shot.id)).toEqual({ ok: false, code: 'unavailable', reason: MEETING_REASONS.closed });
  });
});

describe('update', () => {
  it('changes the name, project and people (null clears both), ticking once per edit', () => {
    const m = meeting(0, { record: record({ people: 'Sam' }) });
    const ticks = core.ticks;
    expect(value(library.update(m.id, { name: 'Renamed', projectId: project(1).id, people: 'Sam, Priya' }, PHONE))).toBe(true);
    expect(core.meetings.get(m.id)).toMatchObject({ projectId: project(1).id, record: { name: 'Renamed', people: 'Sam, Priya' } });
    value(library.update(m.id, { projectId: null, people: null }, PHONE));
    expect(core.meetings.get(m.id)?.projectId).toBeNull();
    expect(core.meetings.get(m.id)?.record.people).toBeUndefined();
    expect(core.meetings.get(m.id)?.record.name).toBe('Renamed');
    expect(core.ticks).toBe(ticks + 2);
  });

  it('refuses an unknown meeting (404) and a project Jantar does not have (404), changing nothing', () => {
    const m = meeting(0);
    expect(library.update(core.newId(), { name: 'x' }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.noMeeting });
    expect(library.update(m.id, { name: 'x', projectId: project(9).id }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.projectGone });
    expect(core.meetings.get(m.id)?.record.name).toBe('Weekly sync');
    expect(core.ticks).toBe(0);
  });

  it('while Todos are off any project is 404 (none can be shown), and clearing one still works', () => {
    rig({ todos: false });
    const m = meeting(0, { projectId: project(1).id });
    expect(library.update(m.id, { projectId: project(2).id }, PHONE)).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.projectGone });
    expect(core.meetings.get(m.id)?.projectId).toBe(project(1).id);
    value(library.update(m.id, { projectId: null }, PHONE));
    expect(core.meetings.get(m.id)?.projectId).toBeNull();
  });

  it('changes the todos switch while no summary runs or is done (none, queued, failed); running or done, 409', () => {
    const states: SummaryState[] = ['none', 'queued', 'running', 'done', 'failed'];
    for (const state of states) {
      const m = meeting(0, { record: record({ summary: { state, decisions: [], items: [] } }) });
      const r = library.update(m.id, { autoTodos: true }, PHONE);
      if (state === 'none' || state === 'queued' || state === 'failed') {
        expect(r.ok, state).toBe(true);
        expect(core.meetings.get(m.id)?.record.autoTodos).toBe(true);
      } else {
        expect(r, state).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.summaryRan });
        expect(core.meetings.get(m.id)?.record.autoTodos).toBe(false);
        // Sending the value it has is no change, so it is fine.
        expect(library.update(m.id, { autoTodos: false, name: 'Kept' }, PHONE).ok, state).toBe(true);
      }
    }
    expect(MEETING_REASONS.summaryRan).toBe('The summary has run; add the action items by hand.');
  });
});

describe('delete (MF6)', () => {
  it('removes the rows and the folder, and nothing else; a sibling folder survives', async () => {
    const one = value(capture.open(EXT, randomUUID(), extOpenBody()));
    const two = value(capture.open(EXT, randomUUID(), extOpenBody()));
    for (const m of [one, two]) {
      const clientId = core.meetings.get(m.id)!.clientId;
      value(capture.lines(EXT, clientId, extLinesBody(3)));
      value(await capture.shot(EXT, clientId, extShotBody()));
    }
    const ticks = core.ticks;
    expect(value(await library.remove(one.id, PHONE))).toBe(true);
    expect(core.meetings.get(one.id)).toBeNull();
    expect(core.meetings.lineCount(one.id)).toBe(0);
    expect(core.meetings.shotCount(one.id)).toBe(0);
    expect(existsSync(join(core.ctx.paths.meetingsDir, one.id))).toBe(false);
    expect(core.meetings.get(two.id)).not.toBeNull();
    expect(core.meetings.shotCount(two.id)).toBe(1);
    expect(existsSync(join(core.ctx.paths.meetingsDir, two.id))).toBe(true);
    expect(core.ticks).toBe(ticks + 1);
    // A summary running for it stops (it would spend quota on a result kept nowhere).
    expect(core.cancelled).toEqual([one.id]);
    expect(await library.remove(one.id, PHONE)).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.noMeeting });
    expect(core.cancelled).toEqual([one.id]);
  });

  it("an open meeting: gone with no summary queued, and the extension's next line or screenshot for that call is 404", async () => {
    const clientId = randomUUID();
    const m = value(capture.open(EXT, clientId, extOpenBody()));
    value(capture.lines(EXT, clientId, extLinesBody(20)));
    value(await library.remove(m.id, PHONE));
    expect(core.enqueued).toEqual([]);
    expect(capture.lines(EXT, clientId, extLinesBody(1))).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.notOpen });
    expect(capture.lines(EXT, clientId, { lines: [] })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await capture.shot(EXT, clientId, extShotBody())).toMatchObject({ ok: false, code: 'not_found' });
    expect(capture.end(EXT, clientId, { reason: 'user', at: MEETING_T0 })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('unlinks a symlinked meeting folder and keeps its target', async () => {
    const m = meeting(0);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'keep.jpg'), 'keep me');
    mkdirSync(core.ctx.paths.meetingsDir, { mode: 0o700 });
    symlinkSync(elsewhere, join(core.ctx.paths.meetingsDir, m.id));
    value(await library.remove(m.id, PHONE));
    expect(existsSync(join(core.ctx.paths.meetingsDir, m.id))).toBe(false);
    expect(readFileSync(join(elsewhere, 'keep.jpg'), 'utf8')).toBe('keep me');
  });

  it('a folder rm cannot empty: the rows still go, the code is logged, and the sweep takes the folder once it can', async () => {
    const m = value(capture.open(EXT, randomUUID(), extOpenBody()));
    value(await capture.shot(EXT, core.meetings.get(m.id)!.clientId, extShotBody()));
    const folder = join(core.ctx.paths.meetingsDir, m.id);
    chmodSync(folder, 0o500);
    try {
      expect(value(await library.remove(m.id, PHONE))).toBe(true);
      expect(core.meetings.get(m.id)).toBeNull();
      expect(existsSync(folder)).toBe(true);
      expect(core.ctx.log.records.find((r) => r.msg === 'meetings: a meeting folder was not removed')?.fields?.error).toBe('EACCES');
    } finally {
      chmodSync(folder, 0o700);
    }
    await library.sweep(MEETING_T0);
    expect(existsSync(folder)).toBe(false);
    expect(JSON.stringify(core.ctx.log.records)).not.toContain(base);
  });

  it('logs by code, never a path, when the folder will not go (the sweep tries later)', async () => {
    const m = meeting(0);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(join(elsewhere, m.id), { recursive: true });
    symlinkSync(elsewhere, core.ctx.paths.meetingsDir);
    value(await library.remove(m.id, PHONE));
    expect(existsSync(join(elsewhere, m.id))).toBe(true);
    const logged = core.ctx.log.records.filter((r) => r.msg.startsWith('meetings:'));
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(base);
  });
});

describe('MP3: ticks', () => {
  it('reads never tick; each edit and delete ticks once', async () => {
    const m = meeting(0);
    library.list(q());
    library.get(m.id);
    await library.shotFile(m.id, core.newId());
    expect(core.ticks).toBe(0);
    value(library.update(m.id, { name: 'One' }, PHONE));
    value(library.update(m.id, { people: 'Two' }, PHONE));
    value(await library.remove(m.id, PHONE));
    expect(core.ticks).toBe(3);
  });
});

describe('when Meetings are closed', () => {
  it('every call answers 503 with the fixed sentence', async () => {
    const closed = buildLibrary({ ...core, store: () => null });
    const sentence = { ok: false, code: 'unavailable', reason: MEETING_REASONS.closed };
    const id = core.newId();
    expect(closed.list(q())).toEqual(sentence);
    expect(closed.get(id)).toEqual(sentence);
    expect(await closed.shotFile(id, id)).toEqual(sentence);
    expect(closed.update(id, { name: 'x' }, PHONE)).toEqual(sentence);
    expect(await closed.remove(id, PHONE)).toEqual(sentence);
    await closed.sweep(MEETING_T0);
  });
});
