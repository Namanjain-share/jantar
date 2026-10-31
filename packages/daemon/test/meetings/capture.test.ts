/**
 * Capture (meetings/capture.ts) on createTestMeetingsCore with a real
 * meetings folder in a temp home: info's projects (null while Todos are off
 * or Life does not answer; the active ones by name, with id, name and emoji
 * only, at most 200); open as an upsert on the client id (a start clamped to
 * now ± 5 minutes, an unknown project dropped, a screenshot's open turning
 * nothing on, Start turning notes on for good, an ended call 409, 5,000
 * meetings 409); lines (404 without an open meeting, the keep-alive touching
 * only, 409 before Start (MP6) and past 20,000 lines (MF5), text cleaned,
 * times clamped, the highest revision kept, a blank line taking no room
 * under the cap); screenshots (MF1's 400s with nothing written, one file per
 * key, 500 a meeting, the 5 GB ceiling (MF7), a failed write 409 and never a
 * 5xx, a file whose row was not added removed again, a meeting ended during
 * the write keeping it, a retry after the end answering its stored id); end
 * (idempotent, at a time in [start, now]; the summary queued only past the
 * minimum, else `none` with why); and the ticks
 * (MP3): an open, a screenshot and an end tick once each, lines and the
 * keep-alive never.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEETING_T0, extLinesBody, extOpenBody, extShotBody, lineUpsert, makeJpeg, transcriptLines } from '@jantar/fixtures';
import { MEETING_LIMITS, MEETING_SHOT_MAX_BYTES, MEETING_SUMMARY_MIN_CHARS, type ProjectView } from '@jantar/protocol';
import type { MeetingCapture, MeetingsCore } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createTestMeetingsCore, type TestMeetingsCore } from '../../src/core/testing.js';
import { buildCapture, cleanText } from '../../src/meetings/capture.js';
import { MEETING_REASONS } from '../../src/meetings/common.js';

const EXT = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const CLIENT = '0b4e7c4e-0000-4000-8000-000000000001';
const MIN = 60_000;

let base: string;
let core: TestMeetingsCore;
let capture: MeetingCapture;

function project(n: number, over: Partial<ProjectView> = {}): ProjectView {
  const at = new Date(MEETING_T0).toISOString();
  return { id: `01JFZ8X8Y3T0V5G9WQK2M4N${String(n).padStart(3, '0')}`, name: `Project ${n}`, status: 'active', open: 0, overdue: 0, createdAt: at, updatedAt: at, ...over };
}

function rig(opts: { todos?: boolean; projects?: ProjectView[]; shotsTotalMax?: number } = {}): void {
  core?.close();
  core = createTestMeetingsCore({
    clock: new FakeClock(MEETING_T0),
    ctx: { home: base },
    settings: { life: { todos: opts.todos ?? true } },
    projects: opts.projects ?? [],
    ...(opts.shotsTotalMax !== undefined ? { shotsTotalMax: opts.shotsTotalMax } : {}),
  });
  capture = buildCapture(core);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-capture-')));
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

/** Start from the popup (notes on) for CLIENT; answers the meeting's id. */
function start(over: Parameters<typeof extOpenBody>[0] = {}, clientId = CLIENT): string {
  return value(capture.open(EXT, clientId, extOpenBody(over))).id;
}

/** Every file under the meetings folder. */
function shotFiles(): string[] {
  const dir = core.ctx.paths.meetingsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

describe('info', () => {
  it("lists the active projects by name, with id, name and emoji only; null while Todos are off or Life won't answer", () => {
    rig({
      projects: [
        project(1, { name: 'Zeta', emoji: '🧪', notes: 'private notes', folder: '/synthetic/work/zeta' }),
        project(2, { name: 'alpha' }),
        project(3, { name: 'Paused one', status: 'paused' }),
        project(4, { name: 'Done one', status: 'done' }),
      ],
    });
    expect(value(capture.info())).toEqual({
      projects: [
        { id: project(2).id, name: 'alpha' },
        { id: project(1).id, name: 'Zeta', emoji: '🧪' },
      ],
    });
    core.todos.listFails = { ok: false, code: 'unavailable', reason: 'Life is not open right now. Try again in a moment.' };
    expect(value(capture.info())).toEqual({ projects: null });
    rig({ todos: false, projects: [project(1)] });
    expect(value(capture.info())).toEqual({ projects: null });
  });

  it('answers at most 200 (the reply schema caps the list there)', () => {
    rig({ projects: Array.from({ length: 230 }, (_, i) => project(i, { name: `P${String(i).padStart(3, '0')}` })) });
    const list = value(capture.info()).projects ?? [];
    expect(list).toHaveLength(200);
    expect(list[0]?.name).toBe('P000');
  });
});

describe('open', () => {
  it('makes a meeting from Start: the sheet as given, notes on, the start clamped to now ± 5 minutes, one tick', () => {
    rig({ projects: [project(1)] });
    const id = start({ projectId: project(1).id, autoTodos: true, at: MEETING_T0 - 30 * MIN });
    const row = core.meetings.get(id);
    expect(row).toMatchObject({
      extId: EXT,
      clientId: CLIENT,
      startedAt: new Date(MEETING_T0 - 5 * MIN).toISOString(),
      endedAt: null,
      lastAt: new Date(MEETING_T0).toISOString(),
      projectId: project(1).id,
      record: { name: 'Weekly sync', site: 'meet', people: 'Sam, Priya', autoTodos: true, notes: true, summary: { state: 'none', decisions: [], items: [] } },
    });
    expect(core.ticks).toBe(1);
    const ahead = value(capture.open(EXT, randomUUID(), extOpenBody({ at: MEETING_T0 + 60 * MIN }))).id;
    expect(core.meetings.get(ahead)?.startedAt).toBe(new Date(MEETING_T0 + 5 * MIN).toISOString());
  });

  it('is an upsert on the client id: the same id back, last_at touched, a tick each time', () => {
    const id = start();
    core.clock.advance(3 * MIN);
    expect(start()).toBe(id);
    expect(core.meetings.count()).toBe(1);
    expect(core.meetings.get(id)?.lastAt).toBe(new Date(MEETING_T0 + 3 * MIN).toISOString());
    expect(core.ticks).toBe(2);
    // Another extension's call with the same client id is its own meeting.
    const other = value(capture.open('01JFZ8X8Y3T0V5G9WQK2M4N6PZ', CLIENT, extOpenBody())).id;
    expect(other).not.toBe(id);
  });

  it("drops a project Jantar doesn't have (or can't read while Todos are off), never refuses for it", () => {
    rig({ projects: [project(1)] });
    expect(core.meetings.get(start({ projectId: project(9).id }))?.projectId).toBeNull();
    rig({ todos: false, projects: [project(1)] });
    expect(core.meetings.get(start({ projectId: project(1).id }))?.projectId).toBeNull();
  });

  it("a screenshot's open (captions false) makes a meeting without notes and changes nothing a Start chose; Start turns notes on for good", () => {
    rig({ projects: [project(1), project(2)] });
    const id = value(capture.open(EXT, CLIENT, extOpenBody({ captions: false, name: 'From the page title', people: undefined }))).id;
    expect(core.meetings.get(id)?.record).toMatchObject({ name: 'From the page title', notes: false });
    expect(core.meetings.get(id)?.record.people).toBeUndefined();

    expect(start({ name: 'Weekly sync', projectId: project(1).id, autoTodos: true })).toBe(id);
    expect(core.meetings.get(id)).toMatchObject({ projectId: project(1).id, record: { name: 'Weekly sync', people: 'Sam, Priya', autoTodos: true, notes: true } });

    // A later screenshot's open: notes stay on, the sheet's choices stay.
    expect(value(capture.open(EXT, CLIENT, extOpenBody({ captions: false, name: 'Other title', projectId: project(2).id, autoTodos: false })))).toEqual({ id });
    expect(core.meetings.get(id)).toMatchObject({ projectId: project(1).id, record: { name: 'Weekly sync', autoTodos: true, notes: true } });

    // A second Start replaces the sheet again (people cleared when not sent).
    start({ name: 'Renamed', people: undefined, projectId: undefined });
    expect(core.meetings.get(id)).toMatchObject({ projectId: null, record: { name: 'Renamed', notes: true } });
    expect(core.meetings.get(id)?.record.people).toBeUndefined();
  });

  it('refuses an ended call (409) and the 5,001st meeting (409)', () => {
    const id = start();
    value(capture.end(EXT, CLIENT, { reason: 'user', at: MEETING_T0 }));
    expect(capture.open(EXT, CLIENT, extOpenBody())).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.ended });
    expect(MEETING_REASONS.ended).toBe('This meeting has ended. Start notes again from the Jantar icon.');
    expect(core.meetings.count()).toBe(1);

    core.db.tx(() => {
      for (let i = 1; i < MEETING_LIMITS.meetings; i++) {
        const iso = new Date(MEETING_T0).toISOString();
        core.meetings.create({ id: core.newId(), extId: EXT, clientId: `filler-${i}`, startedAt: iso, endedAt: iso, lastAt: iso, projectId: null, record: core.meetings.get(id)!.record });
      }
    });
    expect(capture.open(EXT, randomUUID(), extOpenBody())).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.meetingsFull });
    expect(MEETING_REASONS.meetingsFull).toBe('You keep 5,000 meetings. Delete some in Jantar to start another.');
  });
});

describe('lines', () => {
  it('404 without an open meeting: unknown, ended or deleted', () => {
    const notOpen = { ok: false, code: 'not_found', reason: MEETING_REASONS.notOpen };
    expect(capture.lines(EXT, CLIENT, extLinesBody(1))).toEqual(notOpen);
    expect(capture.lines(EXT, CLIENT, { lines: [] })).toEqual(notOpen);
    start();
    expect(capture.lines('01JFZ8X8Y3T0V5G9WQK2M4N6PZ', CLIENT, extLinesBody(1))).toEqual(notOpen);
    value(capture.end(EXT, CLIENT, { reason: 'closed', at: MEETING_T0 }));
    expect(capture.lines(EXT, CLIENT, extLinesBody(1))).toEqual(notOpen);
    expect(MEETING_REASONS.notOpen).toBe('This meeting is not open in Jantar any more. Start notes again from the Jantar icon.');
    // Deleted on the phone.
    const deleted = randomUUID();
    core.meetings.remove(start({}, deleted));
    expect(capture.lines(EXT, deleted, extLinesBody(1))).toEqual(notOpen);
  });

  it('an empty list is the keep-alive: last_at touched, nothing stored, no tick, even before Start', () => {
    const id = value(capture.open(EXT, CLIENT, extOpenBody({ captions: false }))).id;
    const ticks = core.ticks;
    core.clock.advance(4 * MIN);
    expect(value(capture.lines(EXT, CLIENT, { lines: [] }))).toBe(true);
    expect(core.meetings.get(id)?.lastAt).toBe(new Date(MEETING_T0 + 4 * MIN).toISOString());
    expect(core.meetings.lineCount(id)).toBe(0);
    expect(core.ticks).toBe(ticks);
  });

  it('MP6: lines for a meeting a screenshot made are refused (409) until Start turns notes on', () => {
    const id = value(capture.open(EXT, CLIENT, extOpenBody({ captions: false }))).id;
    expect(capture.lines(EXT, CLIENT, extLinesBody(3))).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.notesOff });
    expect(MEETING_REASONS.notesOff).toBe('Notes are not on for this meeting.');
    expect(core.meetings.lineCount(id)).toBe(0);
    start();
    expect(value(capture.lines(EXT, CLIENT, extLinesBody(3)))).toBe(true);
    expect(core.meetings.lineCount(id)).toBe(3);
  });

  it('keeps the highest revision, cleans text and speakers, clamps times, touches last_at and never ticks', () => {
    const id = start();
    const ticks = core.ticks;
    core.clock.advance(MIN);
    value(
      capture.lines(EXT, CLIENT, {
        lines: [
          lineUpsert({ lineId: 'n-1', rev: 1, text: 'So the plan', at: MEETING_T0 + 1000 }),
          lineUpsert({ lineId: 'n-2', rev: 1, speaker: '  \u0007 ', text: 'Tab\there,\r\nnew   line\u0000end', at: MEETING_T0 - 60 * MIN }),
          lineUpsert({ lineId: 'n-3', rev: 1, speaker: 'Pri\u001bya', text: 'From the future', at: MEETING_T0 + 600 * MIN }),
          lineUpsert({ lineId: 'n-4', rev: 1, text: ' \u0000\u0009 ', at: MEETING_T0 }),
        ],
      }),
    );
    value(capture.lines(EXT, CLIENT, { lines: [lineUpsert({ lineId: 'n-1', rev: 3, text: 'So the plan for Friday', at: MEETING_T0 + 1000 })] }));
    value(capture.lines(EXT, CLIENT, { lines: [lineUpsert({ lineId: 'n-1', rev: 2, text: 'stale', at: MEETING_T0 + 1000 })] }));
    expect(core.meetings.lines(id)).toEqual([
      { lineId: 'n-2', rev: 1, at: MEETING_T0 - 15 * MIN, speaker: 'Unknown', text: 'Tab here, new line end' },
      { lineId: 'n-1', rev: 3, at: MEETING_T0 + 1000, speaker: 'Sam', text: 'So the plan for Friday' },
      { lineId: 'n-3', rev: 1, at: MEETING_T0 + MIN + 5 * MIN, speaker: 'Pri ya', text: 'From the future' },
    ]);
    expect(core.meetings.get(id)?.lastAt).toBe(new Date(MEETING_T0 + MIN).toISOString());
    expect(core.ticks).toBe(ticks);
    expect(cleanText('\u0085a  b ')).toBe('a b');
  });

  it('MF5: the 20,001st line is 409 (what fits is kept); revisions of stored lines still land at the cap', () => {
    const id = start();
    core.db.tx(() => {
      for (let from = 0; from < MEETING_LIMITS.linesPerMeeting - 1; from += MEETING_LIMITS.linesPerPost) {
        const n = Math.min(MEETING_LIMITS.linesPerPost, MEETING_LIMITS.linesPerMeeting - 1 - from);
        core.meetings.upsertLines(id, transcriptLines(n, { from }));
      }
    });
    expect(core.meetings.lineCount(id)).toBe(MEETING_LIMITS.linesPerMeeting - 1);
    // Two new lines and a revision: the first new one fits, the second does not.
    const over = capture.lines(EXT, CLIENT, {
      lines: [lineUpsert({ lineId: 'a1b2c3d4-1', rev: 2, text: 'Revised first line' }), lineUpsert({ lineId: 'late-1' }), lineUpsert({ lineId: 'late-2' })],
    });
    expect(over).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.linesFull });
    expect(MEETING_REASONS.linesFull).toBe('This meeting has 20,000 lines; notes stopped.');
    expect(core.meetings.lineCount(id)).toBe(MEETING_LIMITS.linesPerMeeting);
    const stored = core.meetings.lines(id);
    expect(stored.find((l) => l.lineId === 'a1b2c3d4-1')?.text).toBe('Revised first line');
    expect(stored.some((l) => l.lineId === 'late-1')).toBe(true);
    expect(stored.some((l) => l.lineId === 'late-2')).toBe(false);
    expect(capture.lines(EXT, CLIENT, { lines: [lineUpsert({ lineId: 'late-3' })] })).toMatchObject({ ok: false, code: 'conflict' });
    expect(value(capture.lines(EXT, CLIENT, { lines: [lineUpsert({ lineId: 'late-1', rev: 2, text: 'Still revisable' })] }))).toBe(true);
    expect(core.meetings.lineCount(id)).toBe(MEETING_LIMITS.linesPerMeeting);
  });

  it('near the cap a blank new line takes no room, and one new id sent twice in a post takes room once', () => {
    const id = start();
    core.db.tx(() => {
      for (let from = 0; from < MEETING_LIMITS.linesPerMeeting - 1; from += MEETING_LIMITS.linesPerPost) {
        const n = Math.min(MEETING_LIMITS.linesPerPost, MEETING_LIMITS.linesPerMeeting - 1 - from);
        core.meetings.upsertLines(id, transcriptLines(n, { from }));
      }
    });
    const blankFirst = capture.lines(EXT, CLIENT, {
      lines: [lineUpsert({ lineId: 'late-1', text: ' \u0000 ' }), lineUpsert({ lineId: 'late-2', rev: 1, text: 'The last' }), lineUpsert({ lineId: 'late-2', rev: 2, text: 'The last line' })],
    });
    expect(blankFirst).toEqual({ ok: true, value: true });
    expect(core.meetings.lineCount(id)).toBe(MEETING_LIMITS.linesPerMeeting);
    const stored = core.meetings.lines(id);
    expect(stored.find((l) => l.lineId === 'late-2')).toMatchObject({ rev: 2, text: 'The last line' });
    expect(stored.some((l) => l.lineId === 'late-1')).toBe(false);
  });
});

describe('screenshots', () => {
  it('writes the JPEG 0600 under a 0700 meeting folder, adds its row at its (clamped) time, touches last_at and ticks once', async () => {
    const id = start();
    const ticks = core.ticks;
    core.clock.advance(MIN);
    const jpeg = makeJpeg(64, 48);
    const shot = value(await capture.shot(EXT, CLIENT, extShotBody(jpeg, { at: MEETING_T0 - 60 * MIN })));
    const path = join(core.ctx.paths.meetingsDir, id, `${shot.id}.jpg`);
    expect(readFileSync(path).equals(jpeg)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(core.ctx.paths.meetingsDir, id)).mode & 0o777).toBe(0o700);
    expect(statSync(core.ctx.paths.meetingsDir).mode & 0o777).toBe(0o700);
    expect(core.meetings.shots(id)).toEqual([{ id: shot.id, key: expect.any(String), at: MEETING_T0 - 15 * MIN, bytes: jpeg.length }]);
    expect(core.meetings.get(id)?.lastAt).toBe(new Date(MEETING_T0 + MIN).toISOString());
    expect(core.ticks).toBe(ticks + 1);
  });

  it('MF1: not a JPEG (a PNG, HTML, text) or over 4 MB decoded is 400, with nothing written and no row', async () => {
    const id = start();
    const ticks = core.ticks;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    for (const bytes of [png, Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('plain text'), Buffer.alloc(0)]) {
      const r = await capture.shot(EXT, CLIENT, { key: randomUUID(), at: MEETING_T0, image: `data:image/jpeg;base64,${bytes.toString('base64')}` });
      expect(r).toEqual({ ok: false, code: 'invalid_request', reason: MEETING_REASONS.notJpeg });
    }
    expect(MEETING_REASONS.notJpeg).toBe('Not a JPEG image.');
    const big = makeJpeg(64, 48, { padBytes: MEETING_SHOT_MAX_BYTES });
    expect(big.length).toBeGreaterThan(MEETING_SHOT_MAX_BYTES);
    expect(await capture.shot(EXT, CLIENT, extShotBody(big))).toEqual({ ok: false, code: 'invalid_request', reason: MEETING_REASONS.shotTooLarge });
    expect(MEETING_REASONS.shotTooLarge).toBe('The screenshot is larger than 4 MB.');
    expect(shotFiles()).toEqual([]);
    expect(core.meetings.shotCount(id)).toBe(0);
    expect(core.ticks).toBe(ticks);
  });

  it('404 without an open meeting, with nothing written', async () => {
    expect(await capture.shot(EXT, CLIENT, extShotBody())).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.notOpen });
    start();
    value(capture.end(EXT, CLIENT, { reason: 'left', at: MEETING_T0 }));
    expect(await capture.shot(EXT, CLIENT, extShotBody())).toMatchObject({ ok: false, code: 'not_found' });
    expect(shotFiles()).toEqual([]);
  });

  it('MF5: the same key twice stores one file and answers one id; the 501st screenshot is 409', async () => {
    const id = start();
    const body = extShotBody();
    const first = value(await capture.shot(EXT, CLIENT, body));
    const ticks = core.ticks;
    expect(value(await capture.shot(EXT, CLIENT, body))).toEqual(first);
    expect(core.ticks).toBe(ticks);
    expect(shotFiles()).toHaveLength(1);
    expect(core.meetings.shotCount(id)).toBe(1);

    core.db.tx(() => {
      for (let i = 1; i < MEETING_LIMITS.shotsPerMeeting; i++) core.meetings.addShot(id, { id: core.newId(), key: randomUUID(), at: MEETING_T0, bytes: 1 });
    });
    expect(await capture.shot(EXT, CLIENT, extShotBody())).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.shotsFull });
    expect(MEETING_REASONS.shotsFull).toBe('This meeting has 500 screenshots.');
    // A retry of a stored one still answers its id.
    expect(value(await capture.shot(EXT, CLIENT, body))).toEqual(first);
    expect(shotFiles()).toHaveLength(1);
  });

  it('a retry whose answer was lost answers the stored id after its meeting ended; a new screenshot there is 404', async () => {
    const id = start();
    const body = extShotBody();
    const first = value(await capture.shot(EXT, CLIENT, body));
    value(capture.end(EXT, CLIENT, { reason: 'user', at: MEETING_T0 }));
    const ticks = core.ticks;
    expect(value(await capture.shot(EXT, CLIENT, body))).toEqual(first);
    expect(await capture.shot(EXT, CLIENT, extShotBody())).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.notOpen });
    expect(core.meetings.shotCount(id)).toBe(1);
    expect(shotFiles()).toHaveLength(1);
    expect(core.ticks).toBe(ticks);
  });

  it('MF7: a screenshot that would pass the total ceiling is 409 with its sentence, nothing written', async () => {
    const jpeg = makeJpeg(64, 48);
    rig({ shotsTotalMax: jpeg.length * 2 });
    const id = start();
    value(await capture.shot(EXT, CLIENT, extShotBody(jpeg)));
    value(await capture.shot(EXT, CLIENT, extShotBody(jpeg)));
    expect(await capture.shot(EXT, CLIENT, extShotBody(jpeg))).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.shotsDiskFull });
    expect(MEETING_REASONS.shotsDiskFull).toBe('Screenshots fill 5 GB in Jantar. Delete some meetings to take more.');
    expect(shotFiles()).toHaveLength(2);
    expect(core.meetings.shotCount(id)).toBe(2);
  });

  it('refuses (409: the extension reads a 5xx as Jantar not running) with nothing written when the meeting folder is a planted symlink', async () => {
    const id = start();
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(core.ctx.paths.meetingsDir, { mode: 0o700 });
    symlinkSync(elsewhere, join(core.ctx.paths.meetingsDir, id));
    expect(await capture.shot(EXT, CLIENT, extShotBody())).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.shotNotSaved });
    expect(MEETING_REASONS.shotNotSaved).toBe('The screenshot could not be saved on the Mac.');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(core.meetings.shotCount(id)).toBe(0);
    expect(core.ctx.log.records.some((r) => r.msg.includes('not a real directory'))).toBe(true);
  });

  it('a write that fails (a folder it may not write in) is 409 with its sentence: no file, no row, no tick, logged by code', async () => {
    const id = start();
    const ticks = core.ticks;
    const folder = join(core.ctx.paths.meetingsDir, id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o500);
    try {
      expect(await capture.shot(EXT, CLIENT, extShotBody())).toEqual({ ok: false, code: 'conflict', reason: MEETING_REASONS.shotNotSaved });
    } finally {
      chmodSync(folder, 0o700);
    }
    expect(shotFiles()).toEqual([]);
    expect(core.meetings.shotCount(id)).toBe(0);
    expect(core.ticks).toBe(ticks);
    const logged = core.ctx.log.records.find((r) => r.msg === 'meetings: a screenshot was not written');
    expect(logged?.fields?.error).toBe('EACCES');
    expect(JSON.stringify(core.ctx.log.records)).not.toContain(base);
  });

  describe('when something changes while the file is written', () => {
    /** The core, with `onSecondRead` run when capture reads the store again after its write. */
    function racing(onSecondRead: () => boolean): MeetingsCore {
      let reads = 0;
      return { ...core, store: () => (++reads === 2 && !onSecondRead() ? null : core.meetings) };
    }

    it('Meetings turned off: the file is removed, no row, 503', async () => {
      const id = start();
      capture = buildCapture(racing(() => false));
      expect(await capture.shot(EXT, CLIENT, extShotBody())).toEqual({ ok: false, code: 'unavailable', reason: MEETING_REASONS.closed });
      expect(shotFiles()).toEqual([]);
      expect(core.meetings.shotCount(id)).toBe(0);
    });

    it('the meeting was deleted: the file is removed, 404', async () => {
      const id = start();
      capture = buildCapture(racing(() => core.meetings.remove(id)));
      expect(await capture.shot(EXT, CLIENT, extShotBody())).toMatchObject({ ok: false, code: 'not_found' });
      expect(shotFiles()).toEqual([]);
    });

    it('another upload with the same key landed first: its id, and only its file', async () => {
      const id = start();
      const body = extShotBody();
      const winner = core.newId();
      capture = buildCapture(racing(() => core.meetings.addShot(id, { id: winner, key: body.key, at: MEETING_T0, bytes: 10 }).duplicate === false));
      expect(value(await capture.shot(EXT, CLIENT, body))).toEqual({ id: winner });
      expect(shotFiles()).toEqual([]);
      expect(core.meetings.shotCount(id)).toBe(1);
    });

    it('the meeting ended meanwhile (End, the stale sweep): the screenshot is kept, since the click came first', async () => {
      const id = start();
      const endedAt = new Date(MEETING_T0).toISOString();
      capture = buildCapture(racing(() => core.meetings.end(id, endedAt, 'user')));
      const shot = value(await capture.shot(EXT, CLIENT, extShotBody()));
      expect(core.meetings.shots(id).map((s) => s.id)).toEqual([shot.id]);
      expect(shotFiles()).toHaveLength(1);
      expect(core.meetings.get(id)).toMatchObject({ endedAt, record: { endReason: 'user' } });
      // The next one is refused: the meeting is not open.
      expect(await capture.shot(EXT, CLIENT, extShotBody())).toMatchObject({ ok: false, code: 'not_found' });
    });

    it('another upload took the last room: the file is removed, 409', async () => {
      const jpeg = makeJpeg(64, 48);
      rig({ shotsTotalMax: jpeg.length + 5 });
      const id = start();
      capture = buildCapture(racing(() => core.meetings.addShot(id, { id: core.newId(), key: randomUUID(), at: MEETING_T0, bytes: 10 }).duplicate === false));
      expect(await capture.shot(EXT, CLIENT, extShotBody(jpeg))).toMatchObject({ ok: false, code: 'conflict', reason: MEETING_REASONS.shotsDiskFull });
      expect(shotFiles()).toEqual([]);
    });
  });
});

describe('end', () => {
  it('ends the meeting at its (clamped) time and reason, queues the summary past the minimum, answers the counts, ticks once', async () => {
    const id = start();
    value(capture.lines(EXT, CLIENT, extLinesBody(5)));
    value(await capture.shot(EXT, CLIENT, extShotBody()));
    expect(core.meetings.lineChars(id)).toBeGreaterThanOrEqual(MEETING_SUMMARY_MIN_CHARS);
    const ticks = core.ticks;
    core.clock.advance(30 * MIN);
    expect(value(capture.end(EXT, CLIENT, { reason: 'left', at: MEETING_T0 + 120 * MIN }))).toEqual({ id, lines: 5, shots: 1 });
    // An extension clock ahead of the Mac's ends it now, not later.
    expect(core.meetings.get(id)).toMatchObject({ endedAt: new Date(MEETING_T0 + 30 * MIN).toISOString(), record: { endReason: 'left' } });
    expect(core.enqueued).toEqual([id]);
    expect(core.ticks).toBe(ticks + 1);
  });

  it('never ends before the start, nor after now: a start ahead of the Mac ends at the start', () => {
    const early = value(capture.open(EXT, CLIENT, extOpenBody({ at: MEETING_T0 + 3 * MIN }))).id;
    value(capture.end(EXT, CLIENT, { reason: 'user', at: MEETING_T0 - 60 * MIN }));
    expect(core.meetings.get(early)?.endedAt).toBe(new Date(MEETING_T0 + 3 * MIN).toISOString());
    const ahead = randomUUID();
    const late = value(capture.open(EXT, ahead, extOpenBody({ at: MEETING_T0 + 3 * MIN }))).id;
    value(capture.end(EXT, ahead, { reason: 'user', at: MEETING_T0 + 60 * MIN }));
    expect(core.meetings.get(late)?.endedAt).toBe(new Date(MEETING_T0 + 3 * MIN).toISOString());
  });

  it('is idempotent: an ended meeting answers the same, changes nothing, queues nothing again', () => {
    const id = start();
    value(capture.lines(EXT, CLIENT, extLinesBody(5)));
    const first = value(capture.end(EXT, CLIENT, { reason: 'user', at: MEETING_T0 }));
    const ticks = core.ticks;
    expect(value(capture.end(EXT, CLIENT, { reason: 'closed', at: MEETING_T0 + MIN }))).toEqual(first);
    expect(core.meetings.get(id)?.record.endReason).toBe('user');
    expect(core.enqueued).toEqual([id]);
    expect(core.ticks).toBe(ticks);
    expect(capture.end(EXT, randomUUID(), { reason: 'user', at: MEETING_T0 })).toEqual({ ok: false, code: 'not_found', reason: MEETING_REASONS.notOpen });
  });

  it('below the minimum, or without notes, queues no summary and says why', () => {
    const id = start();
    value(capture.lines(EXT, CLIENT, { lines: [lineUpsert({ text: 'x'.repeat(MEETING_SUMMARY_MIN_CHARS - 1) })] }));
    value(capture.end(EXT, CLIENT, { reason: 'user', at: MEETING_T0 }));
    expect(core.meetings.get(id)?.record.summary).toEqual({ state: 'none', reason: MEETING_REASONS.tooLittle, decisions: [], items: [] });
    expect(MEETING_REASONS.tooLittle).toBe('Too little was said for a summary.');

    const shotOnly = value(capture.open(EXT, randomUUID(), extOpenBody({ captions: false })));
    value(capture.end(EXT, core.meetings.get(shotOnly.id)!.clientId, { reason: 'closed', at: MEETING_T0 }));
    expect(core.meetings.get(shotOnly.id)?.record.summary).toMatchObject({ state: 'none', reason: MEETING_REASONS.noTranscript });
    expect(MEETING_REASONS.noTranscript).toBe('No transcript: notes were not started.');

    // Exactly the minimum queues.
    const enough = start({}, randomUUID());
    value(capture.lines(EXT, core.meetings.get(enough)!.clientId, { lines: [lineUpsert({ text: 'y'.repeat(MEETING_SUMMARY_MIN_CHARS) })] }));
    value(capture.end(EXT, core.meetings.get(enough)!.clientId, { reason: 'user', at: MEETING_T0 }));
    expect(core.enqueued).toEqual([enough]);
  });
});

describe('MP3: ticks', () => {
  it('an open, a screenshot and an end tick once each; lines and the keep-alive never', async () => {
    expect(core.ticks).toBe(0);
    start();
    expect(core.ticks).toBe(1);
    for (let i = 0; i < 5; i++) value(capture.lines(EXT, CLIENT, extLinesBody(10, { nonce: `n${i}` })));
    value(capture.lines(EXT, CLIENT, { lines: [] }));
    expect(core.ticks).toBe(1);
    value(await capture.shot(EXT, CLIENT, extShotBody()));
    expect(core.ticks).toBe(2);
    value(capture.end(EXT, CLIENT, { reason: 'user', at: MEETING_T0 }));
    expect(core.ticks).toBe(3);
    // Refusals never tick.
    capture.lines(EXT, CLIENT, extLinesBody(1));
    await capture.shot(EXT, CLIENT, extShotBody());
    expect(core.ticks).toBe(3);
  });
});

describe('when Meetings are closed', () => {
  it('every write answers 503 with the fixed sentence; info still answers', async () => {
    capture = buildCapture({ ...core, store: () => null });
    const closed = { ok: false, code: 'unavailable', reason: MEETING_REASONS.closed };
    expect(capture.open(EXT, CLIENT, extOpenBody())).toEqual(closed);
    expect(capture.lines(EXT, CLIENT, { lines: [] })).toEqual(closed);
    expect(await capture.shot(EXT, CLIENT, extShotBody())).toEqual(closed);
    expect(capture.end(EXT, CLIENT, { reason: 'user', at: MEETING_T0 })).toEqual(closed);
    expect(capture.info().ok).toBe(true);
  });
});
