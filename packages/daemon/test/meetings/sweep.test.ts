/**
 * The sweep (meetings/sweep.ts, through `library.sweep(now)` as the shell
 * calls it), MF6's sweep part: an open meeting whose last post is 10 minutes
 * old is ended 'stale' at that last post with its summary queued as an end
 * would, one 9 minutes old is not; quiet time counts only while meetings.db
 * is open, so a call that went on while Jantar was down is not ended as it
 * comes back (its page's held lines land), nor a call going on while the
 * Mac slept; folders in <meetingsDir> named by
 * a ulid that no meeting owns are removed, and nothing else ever is (other
 * names, files, links, a live meeting's folder and the strays in it, the
 * folder of a row whose record fails its check), one that will not go
 * logged by code. Then the shell: a sweep when meetings.db opens and every
 * 5 minutes after, and a restart after downtime.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEETING_T0, extLinesBody, transcriptLines } from '@jantar/fixtures';
import { MEETING_STALE_MS, SettingsSchema } from '@jantar/protocol';
import type { MeetingRecord, MeetingRow, MeetingSummaries, MeetingsService } from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { createTestContext, createTestMeetingsCore, notBuiltParts, type TestMeetingsCore } from '../../src/core/testing.js';
import { buildCapture } from '../../src/meetings/capture.js';
import { MEETING_REASONS } from '../../src/meetings/common.js';
import { MEETINGS_SWEEP_EVERY_MS, buildMeetingsService } from '../../src/meetings/index.js';
import { buildLibrary } from '../../src/meetings/library.js';
import { endStale, removeOrphans } from '../../src/meetings/sweep.js';

const EXT = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let base: string;
let core: TestMeetingsCore;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-sweep-')));
  core = createTestMeetingsCore({ clock: new FakeClock(MEETING_T0), ctx: { home: base } });
});
afterEach(() => {
  core.close();
  rmSync(base, { recursive: true, force: true });
});

function record(over: Partial<MeetingRecord> = {}): MeetingRecord {
  return { name: 'Weekly sync', site: 'teams', autoTodos: false, notes: true, summary: { state: 'none', decisions: [], items: [] }, ...over };
}

/** An open meeting last heard from at `lastAt` (ms). */
function meeting(lastAt: number, over: Partial<MeetingRow> = {}): MeetingRow {
  const row: MeetingRow = { id: core.newId(), extId: EXT, clientId: randomUUID(), startedAt: iso(MEETING_T0 - 60 * MIN), endedAt: null, lastAt: iso(lastAt), projectId: null, record: record(), ...over };
  core.meetings.create(row);
  return row;
}

describe('stale meetings', () => {
  it('ends one quiet for 10 minutes (at its last post, reason stale), not one quiet for 9, and ticks once', async () => {
    const now = MEETING_T0;
    const quiet = meeting(now - MEETING_STALE_MS);
    core.meetings.upsertLines(quiet.id, transcriptLines(5));
    const older = meeting(now - 3 * MEETING_STALE_MS);
    const recent = meeting(now - 9 * MIN);
    const almost = meeting(now - MEETING_STALE_MS + 1);
    const ended = meeting(now - 60 * MIN, { endedAt: iso(now - 50 * MIN), record: record({ endReason: 'user' }) });

    const library = buildLibrary(core);
    // meetings.db opened 10 minutes ago, with the sweep that first saw it.
    await library.sweep(now - MEETING_STALE_MS);
    expect(core.ticks).toBe(0);
    await library.sweep(now);
    expect(core.meetings.get(quiet.id)).toMatchObject({ endedAt: iso(now - MEETING_STALE_MS), record: { endReason: 'stale' } });
    expect(core.meetings.get(older.id)?.record.endReason).toBe('stale');
    expect(core.meetings.get(recent.id)?.endedAt).toBeNull();
    expect(core.meetings.get(almost.id)?.endedAt).toBeNull();
    expect(core.meetings.get(ended.id)).toMatchObject({ endedAt: iso(now - 50 * MIN), record: { endReason: 'user' } });
    expect(core.ticks).toBe(1);
    // Nothing more to end: no tick.
    await library.sweep(now);
    expect(core.ticks).toBe(1);
  });

  it('counts quiet only while meetings.db is open: calls last heard an hour ago stay open as it opens, and end 10 minutes on', async () => {
    const now = MEETING_T0;
    const heardAgain = meeting(now - 60 * MIN);
    const neverAgain = meeting(now - 60 * MIN);
    const library = buildLibrary(core);
    await library.sweep(now);
    expect(core.meetings.openCount()).toBe(2);
    // The page held its lines while Jantar was down; its 2-s retry lands.
    expect(buildCapture(core).lines(EXT, heardAgain.clientId, extLinesBody(3))).toEqual({ ok: true, value: true });
    await library.sweep(now + MEETING_STALE_MS - 1);
    expect(core.meetings.openCount()).toBe(2);
    expect(core.ticks).toBe(0);
    await library.sweep(now + MEETING_STALE_MS);
    expect(core.meetings.get(neverAgain.id)).toMatchObject({ endedAt: iso(now - 60 * MIN), record: { endReason: 'stale' } });
    expect(core.meetings.get(heardAgain.id)).toMatchObject({ endedAt: iso(now), record: { endReason: 'stale' } });
    expect(core.meetings.lineCount(heardAgain.id)).toBe(3);
  });

  it('queues the summary as an end would: past the minimum queued, else none with why', () => {
    const now = MEETING_T0;
    const talked = meeting(now - 20 * MIN);
    core.meetings.upsertLines(talked.id, transcriptLines(5));
    const little = meeting(now - 20 * MIN);
    core.meetings.upsertLines(little.id, transcriptLines(1));
    const shotOnly = meeting(now - 20 * MIN, { record: record({ notes: false }) });
    expect(endStale(core, now)).toBe(3);
    expect(core.enqueued).toEqual([talked.id]);
    expect(core.meetings.get(little.id)?.record.summary).toMatchObject({ state: 'none', reason: MEETING_REASONS.tooLittle });
    expect(core.meetings.get(shotOnly.id)?.record.summary).toMatchObject({ state: 'none', reason: MEETING_REASONS.noTranscript });
  });

  it('never ends a meeting before it started (an extension clock that ran ahead)', () => {
    const now = MEETING_T0;
    const ahead = meeting(now - 20 * MIN, { startedAt: iso(now - 17 * MIN) });
    endStale(core, now);
    expect(core.meetings.get(ahead.id)?.endedAt).toBe(iso(now - 17 * MIN));
  });

  it('a keep-alive keeps a quiet meeting open; once they stop it ends', async () => {
    const capture = buildCapture(core);
    const clientId = randomUUID();
    const id = (capture.open(EXT, clientId, { site: 'meet', name: 'Quiet call', autoTodos: false, captions: true, at: MEETING_T0 }) as { ok: true; value: { id: string } }).value.id;
    const library = buildLibrary(core);
    for (let i = 0; i < 30; i++) {
      core.clock.advance(MIN);
      capture.lines(EXT, clientId, { lines: [] });
      await library.sweep(core.clock.now());
    }
    expect(core.meetings.get(id)?.endedAt).toBeNull();
    core.clock.advance(MEETING_STALE_MS);
    await library.sweep(core.clock.now());
    expect(core.meetings.get(id)).toMatchObject({ endedAt: iso(MEETING_T0 + 30 * MIN), record: { endReason: 'stale' } });
  });

  it('a Mac asleep for 15 minutes ends no call at wake: a tab heard again stays open, one gone ends 10 minutes on', async () => {
    const capture = buildCapture(core);
    const open = (clientId: string) => (capture.open(EXT, clientId, { site: 'meet', name: 'Long call', autoTodos: false, captions: true, at: core.clock.now() }) as { ok: true; value: { id: string } }).value.id;
    const [stays, gone] = [randomUUID(), randomUUID()];
    const ids = [open(stays), open(gone)];
    const library = buildLibrary(core);
    await library.sweep(core.clock.now());
    // 20 minutes of the call: a keep-alive a minute from both tabs, a sweep every 5.
    for (let i = 0; i < 20; i++) {
      core.clock.advance(MIN);
      for (const c of [stays, gone]) capture.lines(EXT, c, { lines: [] });
      if ((i + 1) % 5 === 0) await library.sweep(core.clock.now());
    }
    const lastHeard = core.clock.now();
    // Asleep: nothing lands, and the overdue sweep runs the moment the Mac wakes.
    core.clock.advance(15 * MIN);
    await library.sweep(core.clock.now());
    expect(ids.map((id) => core.meetings.get(id)?.endedAt)).toEqual([null, null]);
    // One tab's keep-alive lands after wake; the other tab was closed while the Mac slept.
    core.clock.advance(MIN);
    expect(capture.lines(EXT, stays, { lines: [] })).toEqual({ ok: true, value: true });
    core.clock.advance(4 * MIN);
    await library.sweep(core.clock.now());
    expect(ids.map((id) => core.meetings.get(id)?.endedAt)).toEqual([null, null]);
    core.clock.advance(5 * MIN);
    capture.lines(EXT, stays, { lines: [] });
    await library.sweep(core.clock.now());
    expect(core.meetings.get(ids[0]!)?.endedAt).toBeNull();
    expect(core.meetings.get(ids[1]!)).toMatchObject({ endedAt: iso(lastHeard), record: { endReason: 'stale' } });
  });
});

describe('orphan folders', () => {
  it('removes ulid folders no meeting owns, and nothing else', async () => {
    const dir = core.ctx.paths.meetingsDir;
    mkdirSync(dir, { mode: 0o700 });
    const live = meeting(MEETING_T0);
    mkdirSync(join(dir, live.id));
    writeFileSync(join(dir, live.id, `${core.newId()}.jpg`), 'stray');
    writeFileSync(join(dir, live.id, `.${core.newId()}.jpg.123.tmp`), 'half written');
    const orphan = core.newId();
    mkdirSync(join(dir, orphan, 'nested'), { recursive: true });
    writeFileSync(join(dir, orphan, 'nested', 'x.jpg'), 'x');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, core.newId()), 'a file named like a meeting');
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'keep.txt'), 'keep me');
    const linked = core.newId();
    symlinkSync(elsewhere, join(dir, linked));
    // A row whose record fails its check: the store skips it, but it still owns its screenshots.
    const broken = meeting(MEETING_T0);
    core.meetings.addShot(broken.id, { id: core.newId(), key: randomUUID(), at: MEETING_T0, bytes: 5 });
    core.db.prepare("UPDATE meetings SET json = '{}' WHERE id = ?").run(broken.id);
    mkdirSync(join(dir, broken.id));

    expect(await removeOrphans(core, core.ctx.log)).toBe(1);
    expect(existsSync(join(dir, orphan))).toBe(false);
    expect(readdirSync(join(dir, live.id))).toHaveLength(2);
    expect(existsSync(join(dir, 'notes'))).toBe(true);
    expect(existsSync(join(dir, linked))).toBe(true);
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(dir, broken.id))).toBe(true);
    expect(readdirSync(dir)).toHaveLength(5);
    expect(core.ctx.log.records.some((r) => r.msg === 'meetings: orphan folders removed' && r.fields?.count === 1)).toBe(true);
    expect(JSON.stringify(core.ctx.log.records)).not.toContain(base);
  });

  it('stops when Meetings close part way, and does nothing without a meetings folder', async () => {
    expect(await removeOrphans(core, core.ctx.log)).toBe(0);
    const dir = core.ctx.paths.meetingsDir;
    mkdirSync(dir, { mode: 0o700 });
    const orphans = [core.newId(), core.newId(), core.newId()];
    for (const o of orphans) mkdirSync(join(dir, o));
    let reads = 0;
    const closing = { ...core, store: () => (++reads > 1 ? null : core.meetings) };
    expect(await removeOrphans(closing, core.ctx.log)).toBe(1);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('logs a folder that will not go by its code, never a path, and goes on to the next', async () => {
    const dir = core.ctx.paths.meetingsDir;
    mkdirSync(dir, { mode: 0o700 });
    const stuck = join(dir, core.newId());
    const next = join(dir, core.newId());
    mkdirSync(stuck);
    writeFileSync(join(stuck, `${core.newId()}.jpg`), 'x');
    mkdirSync(next);
    chmodSync(stuck, 0o500);
    try {
      expect(await removeOrphans(core, core.ctx.log)).toBe(1);
    } finally {
      chmodSync(stuck, 0o700);
    }
    expect(existsSync(stuck)).toBe(true);
    expect(existsSync(next)).toBe(false);
    expect(core.ctx.log.records.find((r) => r.msg === 'meetings: an orphan folder was not removed')?.fields?.error).toBe('EACCES');
    expect(JSON.stringify(core.ctx.log.records)).not.toContain(base);
  });
});

describe('the shell runs it', () => {
  let started: MeetingsService | undefined;
  afterEach(async () => {
    await started?.stop();
    started = undefined;
  });

  /** The shell on a temp home with Meetings on, the real capture and library, summaries recorded. */
  function shell(clock: FakeClock): { svc: MeetingsService; meetingsDir: string; queued: string[] } {
    const home = join(base, 'state');
    mkdirSync(home, { mode: 0o700 });
    const ctx = createTestContext({ home, clock, settings: SettingsSchema.parse({ meetings: { enabled: true } }) });
    const queued: string[] = [];
    const summaries = (): MeetingSummaries =>
      notBuilt<MeetingSummaries>('Meeting summaries', { status: () => ({ available: false }), enqueue: (id) => void queued.push(id), start: () => undefined, stop: () => undefined, cancel: () => undefined });
    const parts = notBuiltParts();
    const svc = buildMeetingsService(ctx, { life: parts.life, usage: notBuilt('Usage'), ccwLegacy: notBuilt('ccw') }, {}, { capture: buildCapture, library: buildLibrary, summaries });
    started = svc;
    return { svc, meetingsDir: ctx.paths.meetingsDir, queued };
  }

  /** Plant an orphan folder; answers a wait for the next sweep to have run (it removes the orphan last). */
  function nextSweep(meetingsDir: string): () => Promise<void> {
    const orphan = join(meetingsDir, core.newId());
    mkdirSync(orphan, { recursive: true, mode: 0o700 });
    return () => vi.waitFor(() => expect(existsSync(orphan)).toBe(false));
  }

  it('when meetings.db opens, and every 5 minutes while it is open', async () => {
    const clock = new FakeClock(MEETING_T0);
    const { svc, meetingsDir, queued } = shell(clock);
    const swept = nextSweep(meetingsDir);

    await svc.start();
    expect(svc.status().open).toBe(true);
    await swept();

    const clientId = randomUUID();
    const opened = svc.capture.open(EXT, clientId, { site: 'meet', name: 'Left running', autoTodos: false, captions: true, at: MEETING_T0 });
    if (!opened.ok) throw new Error(opened.reason);
    // Quiet for just under 10 minutes: the sweep at 5 left it open.
    clock.advance(MEETING_STALE_MS - 1);
    expect(svc.status().running).toBe(1);
    // The sweep at 10 minutes ends it.
    clock.advance(MEETINGS_SWEEP_EVERY_MS);
    await vi.waitFor(() => expect(svc.status().running).toBe(0));
    expect(svc.capture.lines(EXT, clientId, { lines: [] })).toMatchObject({ ok: false, code: 'not_found' });
    expect(queued).toEqual([]);
  });

  it('after Jantar was down for half an hour: the calls are left open as meetings.db opens (held lines land), and one never heard again ends 10 minutes on', async () => {
    const clock = new FakeClock(MEETING_T0);
    const { svc, meetingsDir } = shell(clock);
    await svc.start();
    const open = (clientId: string) => {
      const r = svc.capture.open(EXT, clientId, { site: 'meet', name: 'Through a restart', autoTodos: false, captions: true, at: MEETING_T0 });
      if (!r.ok) throw new Error(r.reason);
      return r.value.id;
    };
    const [onCall, chromeQuit] = [randomUUID(), randomUUID()];
    open(onCall);
    const quitId = open(chromeQuit);
    await svc.stop();

    clock.advance(30 * MIN);
    let swept = nextSweep(meetingsDir);
    await svc.start();
    await swept();
    expect(svc.status().running).toBe(2);
    expect(svc.capture.lines(EXT, onCall, extLinesBody(3))).toEqual({ ok: true, value: true });

    swept = nextSweep(meetingsDir);
    clock.advance(MEETINGS_SWEEP_EVERY_MS);
    await swept();
    expect(svc.status().running).toBe(2);
    expect(svc.capture.lines(EXT, onCall, { lines: [] }).ok).toBe(true);

    swept = nextSweep(meetingsDir);
    clock.advance(MEETINGS_SWEEP_EVERY_MS);
    await swept();
    expect(svc.status().running).toBe(1);
    const ended = svc.library.get(quitId);
    expect(ended.ok && ended.value.meeting).toMatchObject({ endedAt: iso(MEETING_T0), endReason: 'stale' });
  });
});
