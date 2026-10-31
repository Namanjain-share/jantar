/**
 * jantar meetings against an in-memory daemon (fakeCtl) and against the
 * daemon's own API built on createTestContext (ctl.sock and TCP through
 * Fastify's inject; nothing listens): the status lines, on and off with the
 * data-flow sentence, export (folder names, 0700 folders and 0600 files, the
 * zone, an existing folder refused by one export and skipped by `--all`,
 * `last` and `--all` paging the list, a screenshot the daemon cannot give
 * left out, a stopped `--all` run again), unpair, and the usage errors. The
 * API tests that need WP-MS's routes run once those stop being stubs.
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeService, TodosModule, CcwLegacySource, UsageSource } from '@jantar/daemon/contracts';
import { buildApp } from '@jantar/daemon/api/app';
import { EXT_ROUTE_IMPLS } from '@jantar/daemon/api/routes/ext';
import { MEETINGS_ROUTE_IMPLS } from '@jantar/daemon/api/routes/meetings';
import { ApiServices, type ApiDeps } from '@jantar/daemon/api/services';
import { notBuilt } from '@jantar/daemon/core/not-implemented';
import { createTestContext, notBuiltParts } from '@jantar/daemon/core/testing';
import { createMeetingsService } from '@jantar/daemon/meetings/index';
import { extLinesBody, extOpenBody, extShotBody, makeFakeHome, makeJpeg, meetingDetail, type FakeHome } from '@jantar/fixtures';
import {
  EXTENSION_ID,
  EXTENSION_KEY_HEADER,
  IDEMPOTENCY_HEADER,
  type Meeting,
  type MeetingDetail,
  type MeetingsList,
  type MeetingsStatus,
  type RouteName,
} from '@jantar/protocol';
import meetings, { MEETINGS_DATA_FLOW, exportFolderName, sizeText, slugOf } from '../src/commands/meetings.js';
import { EXIT } from '../src/command.js';
import { CtlUnavailableError, type CtlClient, type CtlRequestOptions, type CtlResponse } from '../src/ctl.js';
import { main } from '../src/index.js';
import { memoryIo } from '../src/io.js';
import { contextFor, fail, fakeCtl, fakeSettings, ok, testDeps, type CtlCall, type Handler } from './helpers.js';

const ENV = { HOME: '/synthetic/home', JANTAR_HOME: '/synthetic/state', TZ: 'UTC' };
const EXT_A = '01JFZ8X8Y3T0V5G9WQK2M4N7E1';
const EXT_B = '01JFZ8X8Y3T0V5G9WQK2M4N7E2';
const OFF = 'Meetings are off. Turn them on at your Mac: jantar meetings on';

function status(over: Partial<MeetingsStatus> = {}): MeetingsStatus {
  return {
    on: true,
    open: true,
    meetings: 12,
    running: 1,
    shotsBytes: 340 * 1024 * 1024,
    summary: { available: true },
    extensions: [{ id: EXT_A, pairedAt: '2026-01-12T10:00:00.000Z', lastSeenAt: '2026-01-15T08:00:00.000Z' }],
    ...over,
  };
}

/** The fixtures' meeting, or another one with this id, name and start (no screenshots unless given). */
function detail(id?: string, name?: string, startedAt?: string, shots?: MeetingDetail['shots']): MeetingDetail {
  const base = meetingDetail();
  if (!id) return base;
  const meeting = { ...base.meeting, id, name: name ?? base.meeting.name, startedAt: startedAt ?? base.meeting.startedAt, shots: shots?.length ?? 0 };
  return meetingDetail({ meeting, shots: shots ?? [] });
}

interface LibraryOpts {
  page?: number;
  jpeg?: Buffer;
  /** Answers for these screenshot ids instead of the bytes. */
  shotErrors?: Record<string, CtlResponse>;
  off?: boolean;
  /** Meeting ids answered 404. */
  gone?: string[];
  /** Meeting ids answered 500, read on every call (a test can clear it). */
  failing?: Set<string>;
  /** Life's time zone in the settings. */
  timezone?: string;
}

/**
 * A daemon holding `details`: the settings, the list newest first in pages
 * of `page` (the cursor is the last id of a page), each meeting, and each
 * screenshot's bytes (`jpeg`, or the answer in `shotErrors`).
 */
function library(details: MeetingDetail[], opts: LibraryOpts = {}) {
  const jpeg = opts.jpeg ?? makeJpeg(64, 48);
  const page = opts.page ?? 50;
  const s = fakeSettings({ meetings: { enabled: true }, ...(opts.timezone ? { life: { timezone: opts.timezone } } : {}) });
  const routes: Record<string, Handler> = {
    ...s.routes,
    'GET /v1/meetings/status': () => ok(status()),
    'GET /v1/meetings': (call: CtlCall) => {
      if (opts.off) return fail('forbidden', OFF, 403);
      const q = new URLSearchParams(call.path.split('?')[1] ?? '');
      const limit = Math.min(Number(q.get('limit') ?? 30), page);
      const before = q.get('before');
      const from = before ? details.findIndex((d) => d.meeting.id === before) + 1 : 0;
      const meetings: Meeting[] = details.slice(from, from + limit).map((d) => d.meeting);
      const more = from + limit < details.length;
      const body: MeetingsList = { meetings, next: more ? (meetings.at(-1)?.id ?? null) : null, running: null };
      return ok(body);
    },
  };
  for (const d of details) {
    routes[`GET /v1/meetings/${d.meeting.id}`] = () => {
      if (opts.off) return fail('forbidden', OFF, 403);
      if (opts.failing?.has(d.meeting.id)) return fail('internal', 'Something went wrong in jantard.', 500);
      return opts.gone?.includes(d.meeting.id) ? fail('not_found', 'No such meeting.', 404) : ok(d);
    };
    for (const shot of d.shots) {
      routes[`GET /v1/meetings/${d.meeting.id}/shots/${shot.id}`] = () => opts.shotErrors?.[shot.id] ?? ok(jpeg);
    }
  }
  return { ctl: fakeCtl(routes), jpeg, settings: s };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('jantar meetings (the status)', () => {
  it('prints on, the data, the counts, the screenshots of 5 GB, summaries and the extension', async () => {
    const ctl = fakeCtl({ 'GET /v1/meetings/status': ok(status()) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run([], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toBe(
      'Meetings: on\n' +
        'Meetings data: open\n' +
        'Meetings kept: 12 (1 running)\n' +
        'Screenshots: 340 MB of 5 GB\n' +
        'Summaries: available\n' +
        'Chrome extension: paired 3d ago, last used 2h ago\n',
    );
    expect(ctl.calls.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/meetings/status']);
  });

  it('says why summaries cannot run, and how many extensions are paired', async () => {
    const st = status({
      running: 0,
      summary: { available: false, reason: 'Summaries are off while Jantar is read-only.' },
      extensions: [
        { id: EXT_A, pairedAt: '2026-01-12T10:00:00.000Z', lastSeenAt: '2026-01-15T07:00:00.000Z' },
        { id: EXT_B, pairedAt: '2026-01-14T10:00:00.000Z', lastSeenAt: '2026-01-15T09:30:00.000Z' },
      ],
    });
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({ 'GET /v1/meetings/status': ok(st) }) });
    await meetings.run([], c.ctx);
    expect(c.io.stdout).toContain('Meetings kept: 12\n');
    expect(c.io.stdout).toContain('Summaries: not available: Summaries are off while Jantar is read-only.\n');
    expect(c.io.stdout).toContain('Chrome extensions: 2 paired, the last used 30m ago\n');
  });

  it('points at pairing when no extension is paired, and says when the one paired was never used', async () => {
    const none = contextFor({ env: ENV }, { ctl: fakeCtl({ 'GET /v1/meetings/status': ok(status({ extensions: [] })) }) });
    await meetings.run([], none.ctx);
    expect(none.io.stdout).toContain('Chrome extension: not paired. Pair the Chrome extension: jantar pair --extension (docs/extension.md)\n');
    const fresh = status({ extensions: [{ id: EXT_A, pairedAt: '2026-01-15T09:59:00.000Z', lastSeenAt: null }] });
    const unused = contextFor({ env: ENV }, { ctl: fakeCtl({ 'GET /v1/meetings/status': ok(fresh) }) });
    await meetings.run([], unused.ctx);
    expect(unused.io.stdout).toContain('Chrome extension: paired 1m ago, not used yet\n');
  });

  it('off: says so and how to turn them on, with no counts', async () => {
    const st = status({ on: false, open: false, meetings: 0, running: 0, shotsBytes: 0 });
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({ 'GET /v1/meetings/status': ok(st) }) });
    await meetings.run([], c.ctx);
    expect(c.io.stdout).toContain('Meetings: off. Your meetings stay on this Mac. Turn them on: jantar meetings on\n');
    expect(c.io.stdout).not.toContain('Meetings kept');
    expect(c.io.stdout).not.toContain('Screenshots');
    expect(c.io.stdout).toContain('Chrome extension: paired');
  });

  it('broken: the fixed sentence instead of the counts', async () => {
    const broken = 'Meetings data could not be opened. The file is untouched. Move meetings.db aside at your Mac to start again (docs/extension.md).';
    const st = status({ open: false, broken, meetings: 0, running: 0, shotsBytes: 0 });
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({ 'GET /v1/meetings/status': ok(st) }) });
    await meetings.run([], c.ctx);
    expect(c.io.stdout).toContain(`Meetings data: broken: ${broken}\n`);
    expect(c.io.stdout).not.toContain('Meetings kept');
  });

  it('on but not open yet (not broken): says so, with no counts', async () => {
    const st = status({ open: false, meetings: 0, running: 0, shotsBytes: 0 });
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({ 'GET /v1/meetings/status': ok(st) }) });
    await meetings.run([], c.ctx);
    expect(c.io.stdout).toContain('Meetings: on\nMeetings data: not open\nChrome extension: paired');
    expect(c.io.stdout).not.toContain('Meetings kept');
  });

  it('two extensions paired, neither used yet', async () => {
    const st = status({
      extensions: [
        { id: EXT_A, pairedAt: '2026-01-12T10:00:00.000Z', lastSeenAt: null },
        { id: EXT_B, pairedAt: '2026-01-14T10:00:00.000Z', lastSeenAt: null },
      ],
    });
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({ 'GET /v1/meetings/status': ok(st) }) });
    await meetings.run([], c.ctx);
    expect(c.io.stdout).toContain('Chrome extensions: 2 paired, none used yet\n');
  });

  describe('with the daemon down', () => {
    let home: FakeHome;
    beforeEach(async () => {
      home = await makeFakeHome({ sessions: [] });
    });
    afterEach(async () => {
      await home.cleanup();
    });

    it('reads config.json, and on writes it with the data-flow sentence', async () => {
      const st = contextFor(home);
      expect(await meetings.run([], st.ctx)).toBe(EXIT.ok);
      expect(st.io.stdout).toContain('jantard is not running');
      expect(st.io.stdout).toContain('Meetings: off\n');
      const on = contextFor(home);
      expect(await meetings.run(['on'], on.ctx)).toBe(EXIT.ok);
      expect(on.io.stdout).toContain(MEETINGS_DATA_FLOW);
      expect(on.io.stdout).toContain('Saved to config.json');
      expect(on.io.stdout).toContain('jantar pair --extension');
      const saved = JSON.parse(await readFile(join(home.env.JANTAR_HOME as string, 'config.json'), 'utf8')) as { meetings: { enabled: boolean } };
      expect(saved.meetings.enabled).toBe(true);
    });
  });
});

describe('jantar meetings on and off', () => {
  it('on: turns the switch on and says what stays on the Mac and what the summary sends', async () => {
    const s = fakeSettings();
    const ctl = fakeCtl({ ...s.routes, 'GET /v1/meetings/status': ok(status({ extensions: [] })) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['on'], c.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ meetings: { enabled: true } }]);
    expect(s.settings.meetings.enabled).toBe(true);
    expect(MEETINGS_DATA_FLOW).toBe(
      'Transcripts and screenshots stay in Jantar on this Mac. After a meeting, its transcript text (never a screenshot) goes to Claude through Claude Code on your account to write the summary.\n',
    );
    expect(c.io.stdout).toBe(
      `Meetings are on. The phone shows them under More > Meetings.\n${MEETINGS_DATA_FLOW}Pair the Chrome extension: jantar pair --extension (docs/extension.md)\n`,
    );
    expect(c.io.stderr).toBe('');
  });

  it('on: says at once when meetings.db would not open (stderr), and still exits 0', async () => {
    const broken = 'Meetings data could not be opened. The file is untouched. Move meetings.db aside at your Mac to start again (docs/extension.md).';
    const s = fakeSettings();
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({ ...s.routes, 'GET /v1/meetings/status': ok(status({ open: false, broken })) }) });
    expect(await meetings.run(['on'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Meetings are on.');
    expect(c.io.stderr).toBe(`${broken}\n`);
  });

  it('on: no pairing line once an extension is paired', async () => {
    const s = fakeSettings();
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({ ...s.routes, 'GET /v1/meetings/status': ok(status()) }) });
    await meetings.run(['on'], c.ctx);
    expect(c.io.stdout).not.toContain('jantar pair --extension');
  });

  it('off: turns the switch off and keeps the meetings', async () => {
    const s = fakeSettings({ meetings: { enabled: true } });
    const c = contextFor({ env: ENV }, { ctl: fakeCtl(s.routes) });
    expect(await meetings.run(['off'], c.ctx)).toBe(EXIT.ok);
    expect(s.patches).toEqual([{ meetings: { enabled: false } }]);
    expect(c.io.stdout).toBe('Meetings are off. The extension saves nothing and the phone no longer shows them; your meetings stay on this Mac.\n');
  });

  it('takes no argument and no export flag', async () => {
    const s = fakeSettings();
    const a = contextFor({ env: ENV }, { ctl: fakeCtl(s.routes) });
    expect(await meetings.run(['on', 'now'], a.ctx)).toBe(EXIT.usage);
    expect(a.io.stderr).toContain('on takes no argument');
    const b = contextFor({ env: ENV }, { ctl: fakeCtl(s.routes) });
    expect(await meetings.run(['off', '--out', '/tmp/x'], b.ctx)).toBe(EXIT.usage);
    expect(b.io.stderr).toContain('--out is not for "meetings off"');
    expect(s.patches).toEqual([]);
  });
});

describe('jantar meetings export', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jantar-cli-export-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes <day>-<slug>-<id end>/meeting.md and shots/<HHMMSS>-<n>.jpg: folders 0700, files 0600', async () => {
    const d = meetingDetail();
    const { ctl, jpeg } = library([d]);
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', d.meeting.id, '--out', dir], c.ctx)).toBe(EXIT.ok);
    const folder = join(dir, '2026-10-30-weekly-sync-m4n6pr');
    expect(await readdir(dir)).toEqual(['2026-10-30-weekly-sync-m4n6pr']);
    expect((await readdir(folder)).sort()).toEqual(['meeting.md', 'shots']);
    expect(await readdir(join(folder, 'shots'))).toEqual(['100500-1.jpg']);
    expect(await mode(folder)).toBe(0o700);
    expect(await mode(join(folder, 'shots'))).toBe(0o700);
    expect(await mode(join(folder, 'meeting.md'))).toBe(0o600);
    expect(await mode(join(folder, 'shots', '100500-1.jpg'))).toBe(0o600);
    expect(await readFile(join(folder, 'shots', '100500-1.jpg'))).toEqual(jpeg);
    const md = await readFile(join(folder, 'meeting.md'), 'utf8');
    expect(md.startsWith('# Weekly sync\n\nFri 30 Oct 2026 · 10:00 to 10:42 · Google Meet\n')).toBe(true);
    expect(md).toContain('Project: Acme site · People: Sam, Priya');
    expect(md).toContain('## Action items\n\n- [ ] Send the revised quote (Sam)\n- [x] Book the review room (You)');
    expect(md).toContain('**Priya** 10:03\nThen I will update the quote today.\n\n![Screenshot 10:05](shots/100500-1.jpg)\n\n**You** 10:06');
    expect(c.io.stdout).toBe(`Exported "Weekly sync" to ${folder} (meeting.md and 1 screenshot)\n`);
    expect(c.io.stderr).toBe('');
    // Reads only: the settings (for the zone), the meeting, then its screenshot.
    expect(ctl.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /v1/settings',
      `GET /v1/meetings/${d.meeting.id}`,
      `GET /v1/meetings/${d.meeting.id}/shots/${d.shots[0]?.id}`,
    ]);
  });

  it("names the day and the screenshots' times in the Mac's zone", async () => {
    const d = detail('01JFZ8X8Y3T0V5G9WQK2M4N7A1', 'Late call', '2026-10-30T20:00:00.000Z', [{ id: '01JFZ8X8Y3T0V5G9WQK2M4N7S1', at: '2026-10-30T20:05:30.000Z', bytes: 100 }]);
    const { ctl } = library([d]);
    const c = contextFor({ env: { ...ENV, TZ: 'Asia/Kolkata' } }, { ctl });
    expect(await meetings.run(['export', d.meeting.id, '--out', dir], c.ctx)).toBe(EXIT.ok);
    expect(await readdir(dir)).toEqual(['2026-10-31-late-call-m4n7a1']);
    expect(await readdir(join(dir, '2026-10-31-late-call-m4n7a1', 'shots'))).toEqual(['013530-1.jpg']);
    const md = await readFile(join(dir, '2026-10-31-late-call-m4n7a1', 'meeting.md'), 'utf8');
    expect(md).toContain('Sat 31 Oct 2026 · 01:30 to');
    expect(md).toContain('![Screenshot 01:35](shots/013530-1.jpg)');
  });

  it("Life's time zone, when set, wins over the Mac's (the zone the summary was written in)", async () => {
    const d = detail('01JFZ8X8Y3T0V5G9WQK2M4N7A1', 'Late call', '2026-10-30T20:00:00.000Z', [{ id: '01JFZ8X8Y3T0V5G9WQK2M4N7S1', at: '2026-10-30T20:05:30.000Z', bytes: 100 }]);
    const c = contextFor({ env: ENV }, { ctl: library([d], { timezone: 'Asia/Kolkata' }).ctl });
    expect(await meetings.run(['export', d.meeting.id, '--out', dir], c.ctx)).toBe(EXIT.ok);
    expect(await readdir(dir)).toEqual(['2026-10-31-late-call-m4n7a1']);
    expect(await readdir(join(dir, '2026-10-31-late-call-m4n7a1', 'shots'))).toEqual(['013530-1.jpg']);
  });

  it('a TZ this Node does not know falls back to the system zone', async () => {
    const d = meetingDetail();
    const c = contextFor({ env: { ...ENV, TZ: 'Not/AZone' } }, { ctl: library([d]).ctl });
    expect(await meetings.run(['export', d.meeting.id, '--out', dir], c.ctx)).toBe(EXIT.ok);
    expect(await readdir(dir)).toEqual([exportFolderName(d.meeting, Intl.DateTimeFormat().resolvedOptions().timeZone)]);
  });

  it('a meeting without screenshots has no shots folder', async () => {
    const d = detail('01JFZ8X8Y3T0V5G9WQK2M4N7A1', 'Standup', '2026-10-29T09:00:00.000Z');
    const c = contextFor({ env: ENV }, { ctl: library([d]).ctl });
    expect(await meetings.run(['export', d.meeting.id, '-o', dir], c.ctx)).toBe(EXIT.ok);
    expect(await readdir(join(dir, '2026-10-29-standup-m4n7a1'))).toEqual(['meeting.md']);
    expect(c.io.stdout).toContain('(meeting.md)\n');
  });

  it('without --out it writes into the current folder', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const c = contextFor({ env: ENV }, { ctl: library([meetingDetail()]).ctl });
      expect(await meetings.run(['export', 'last'], c.ctx)).toBe(EXIT.ok);
      expect(await readdir(dir)).toEqual(['2026-10-30-weekly-sync-m4n6pr']);
    } finally {
      cwd.mockRestore();
    }
  });

  it('makes --out when it is missing (0700), relative to nothing but the path given', async () => {
    const out = join(dir, 'exports', 'october');
    const c = contextFor({ env: ENV }, { ctl: library([meetingDetail()]).ctl });
    expect(await meetings.run(['export', meetingDetail().meeting.id, '--out', out], c.ctx)).toBe(EXIT.ok);
    expect(await mode(out)).toBe(0o700);
    expect(await readdir(out)).toEqual(['2026-10-30-weekly-sync-m4n6pr']);
  });

  it('refuses a folder that is already there and writes nothing into it', async () => {
    const folder = join(dir, '2026-10-30-weekly-sync-m4n6pr');
    await mkdir(folder);
    await writeFile(join(folder, 'mine.txt'), 'keep me');
    const { ctl } = library([meetingDetail()]);
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', meetingDetail().meeting.id, '--out', dir], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toBe(`jantar meetings: ${folder} is already there; nothing was written. Export into another folder with --out <dir>\n`);
    expect(await readdir(folder)).toEqual(['mine.txt']);
    expect(await readFile(join(folder, 'mine.txt'), 'utf8')).toBe('keep me');
    expect(ctl.calls.some((x) => x.path.includes('/shots/'))).toBe(false);
  });

  it('a screenshot the daemon cannot give (404, 503) is left out: meeting.md shows its time, said, exit 1', async () => {
    const shots = [
      { id: '01JFZ8X8Y3T0V5G9WQK2M4N7S1', at: '2026-10-30T09:01:00.000Z', bytes: 100 },
      { id: '01JFZ8X8Y3T0V5G9WQK2M4N7S2', at: '2026-10-30T09:02:00.000Z', bytes: 100 },
      { id: '01JFZ8X8Y3T0V5G9WQK2M4N7S3', at: '2026-10-30T09:03:00.000Z', bytes: 100 },
    ];
    const d = detail('01JFZ8X8Y3T0V5G9WQK2M4N7A1', 'Standup', '2026-10-30T09:00:00.000Z', shots);
    const shotErrors = {
      [shots[0]?.id as string]: fail('not_found', 'No such screenshot.', 404),
      [shots[2]?.id as string]: fail('unavailable', 'The screenshot could not be read on the Mac.', 503),
    };
    const c = contextFor({ env: ENV }, { ctl: library([d], { shotErrors }).ctl });
    expect(await meetings.run(['export', d.meeting.id, '--out', dir], c.ctx)).toBe(EXIT.failed);
    const folder = join(dir, '2026-10-30-standup-m4n7a1');
    // The one it could read keeps its place in time (n = 2).
    expect(await readdir(join(folder, 'shots'))).toEqual(['090200-2.jpg']);
    const md = await readFile(join(folder, 'meeting.md'), 'utf8');
    expect(md).toContain('*Screenshot 09:01*');
    expect(md).toContain('![Screenshot 09:02](shots/090200-2.jpg)');
    expect(md).toContain('*Screenshot 09:03*');
    expect(c.io.stdout).toBe(`Exported "Standup" to ${folder} (meeting.md and 1 screenshot; 2 left out)\n`);
    expect(c.io.stderr).toBe(
      '"Standup": the screenshot at 09:01 is left out (No such screenshot.)\n' +
        '"Standup": the screenshot at 09:03 is left out (The screenshot could not be read on the Mac.)\n' +
        "jantar meetings: 2 screenshots could not be read and are left out (above); meeting.md shows their time only. To try again, delete the meeting's folder and export it again.\n",
    );
  });

  it('every screenshot left out: no shots folder', async () => {
    const d = meetingDetail();
    const c = contextFor({ env: ENV }, { ctl: library([d], { shotErrors: { [d.shots[0]?.id as string]: fail('not_found', 'No such screenshot.', 404) } }).ctl });
    expect(await meetings.run(['export', d.meeting.id, '--out', dir], c.ctx)).toBe(EXIT.failed);
    expect(await readdir(join(dir, '2026-10-30-weekly-sync-m4n6pr'))).toEqual(['meeting.md']);
    expect(c.io.stdout).toContain('(meeting.md; 1 left out)\n');
    expect(c.io.stderr).toContain('1 screenshot could not be read and is left out (above); meeting.md shows its time only.');
  });

  it('any other answer for a screenshot stops the export and leaves no folder behind', async () => {
    const d = meetingDetail();
    const shot = d.shots[0]?.id as string;
    const cases: [string, (ctl: CtlClient) => void, number, string][] = [
      ['Meetings turned off', () => {}, EXIT.failed, `jantar meetings: a screenshot could not be read: ${OFF}\n`],
      ['not JSON', (ctl) => (ctl.bytes = async () => ({ status: 502, type: 'text/plain', body: Buffer.from('Bad gateway') })), EXIT.failed, 'jantar meetings: a screenshot could not be read: daemon answered HTTP 502\n'],
      ['200 but not a JPEG', (ctl) => (ctl.bytes = async () => ({ status: 200, type: 'text/html', body: Buffer.from('<p>') })), EXIT.failed, 'jantar meetings: a screenshot could not be read: daemon answered HTTP 200\n'],
      [
        'the daemon goes away',
        (ctl) =>
          (ctl.bytes = async () => {
            throw new CtlUnavailableError('/synthetic/run/ctl.sock', 'ECONNREFUSED');
          }),
        EXIT.daemonDown,
        'jantar meetings: jantard is not running',
      ],
    ];
    for (const [what, patch, exit, said] of cases) {
      const { ctl } = library([d], { shotErrors: { [shot]: fail('forbidden', OFF, 403) } });
      patch(ctl);
      const c = contextFor({ env: ENV }, { ctl });
      expect(await meetings.run(['export', d.meeting.id, '--out', dir], c.ctx), what).toBe(exit);
      expect(c.io.stderr, what).toContain(said);
      expect(c.io.stdout, what).toBe('');
      expect(await readdir(dir), what).toEqual([]);
    }
  });

  it('with Meetings off: the daemon\'s sentence, nothing written', async () => {
    const d = meetingDetail();
    const c = contextFor({ env: ENV }, { ctl: library([d], { off: true }).ctl });
    expect(await meetings.run(['export', d.meeting.id, '--out', dir], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toBe(`jantar meetings: ${OFF}\n`);
    expect(await readdir(dir)).toEqual([]);
  });

  it('last: the newest meeting, from one list page of one', async () => {
    const newest = detail('01JFZ8X8Y3T0V5G9WQK2M4N7A2', 'Retro', '2026-10-31T09:00:00.000Z');
    const older = detail('01JFZ8X8Y3T0V5G9WQK2M4N7A1', 'Planning', '2026-10-30T09:00:00.000Z');
    const { ctl } = library([newest, older]);
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', 'last', '--out', dir], c.ctx)).toBe(EXIT.ok);
    expect(await readdir(dir)).toEqual(['2026-10-31-retro-m4n7a2']);
    expect(ctl.calls.filter((x) => x.path.startsWith('/v1/meetings?')).map((x) => x.path)).toEqual(['/v1/meetings?limit=1']);
  });

  it('last with no meetings fails and says so', async () => {
    const c = contextFor({ env: ENV }, { ctl: library([]).ctl });
    expect(await meetings.run(['export', 'last', '--out', dir], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toBe('jantar meetings: there are no meetings yet\n');
  });

  it('--all pages the list and writes a folder per meeting', async () => {
    const ds = [
      detail('01JFZ8X8Y3T0V5G9WQK2M4N7A3', 'Retro', '2026-10-31T09:00:00.000Z'),
      meetingDetail(),
      detail('01JFZ8X8Y3T0V5G9WQK2M4N7A1', 'Kick-off: Acme / Q4!', '2026-10-29T09:00:00.000Z'),
    ];
    const { ctl } = library(ds, { page: 2 });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', '--all', '--out', dir], c.ctx)).toBe(EXIT.ok);
    expect((await readdir(dir)).sort()).toEqual(['2026-10-29-kick-off-acme-q4-m4n7a1', '2026-10-30-weekly-sync-m4n6pr', '2026-10-31-retro-m4n7a3']);
    const lists = ctl.calls.filter((x) => x.path.startsWith('/v1/meetings?')).map((x) => x.path);
    expect(lists).toEqual(['/v1/meetings?limit=50', `/v1/meetings?limit=50&before=${meetingDetail().meeting.id}`]);
    expect(c.io.stdout).toContain(`Exported 3 meetings to ${dir}\n`);
  });

  it('--all leaves a folder already there as it was, and reads nothing for it', async () => {
    const ds = [detail('01JFZ8X8Y3T0V5G9WQK2M4N7A3', 'Retro', '2026-10-31T09:00:00.000Z'), meetingDetail()];
    const mine = join(dir, '2026-10-30-weekly-sync-m4n6pr');
    await mkdir(mine);
    await writeFile(join(mine, 'mine.txt'), 'keep me');
    const { ctl } = library(ds);
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', '--all', '--out', dir], c.ctx)).toBe(EXIT.ok);
    expect((await readdir(dir)).sort()).toEqual(['2026-10-30-weekly-sync-m4n6pr', '2026-10-31-retro-m4n7a3']);
    expect(await readdir(mine)).toEqual(['mine.txt']);
    expect(c.io.stdout).toContain(`Exported 1 meeting to ${dir} (1 already there, left as they were)\n`);
    expect(ctl.calls.some((x) => x.path.startsWith(`/v1/meetings/${meetingDetail().meeting.id}`))).toBe(false);
  });

  it('--all that stops part way keeps what it wrote, says so, and the same command again does the rest', async () => {
    const ds = [
      detail('01JFZ8X8Y3T0V5G9WQK2M4N7A3', 'Retro', '2026-10-31T09:00:00.000Z'),
      meetingDetail(),
      detail('01JFZ8X8Y3T0V5G9WQK2M4N7A1', 'Planning', '2026-10-29T09:00:00.000Z'),
    ];
    const failing = new Set([meetingDetail().meeting.id]);
    const { ctl } = library(ds, { failing });
    const first = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', '--all', '--out', dir], first.ctx)).toBe(EXIT.failed);
    expect(await readdir(dir)).toEqual(['2026-10-31-retro-m4n7a3']);
    expect(first.io.stderr).toBe(
      'Stopped part way. The same command again exports the rest and leaves the folders already there as they are.\n' + 'jantar meetings: Something went wrong in jantard.\n',
    );
    failing.clear();
    const again = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', '--all', '--out', dir], again.ctx), again.io.stderr).toBe(EXIT.ok);
    expect((await readdir(dir)).sort()).toEqual(['2026-10-29-planning-m4n7a1', '2026-10-30-weekly-sync-m4n6pr', '2026-10-31-retro-m4n7a3']);
    expect(again.io.stdout).toContain(`Exported 2 meetings to ${dir} (1 already there, left as they were)\n`);
  });

  it('--all refuses, before writing anything, two meetings that would share a folder', async () => {
    // Same day, same name, and ids that end alike.
    const ds = [
      detail('01JFZ8X8Y3T0V5G9WQK3M4N7A1', 'Standup', '2026-10-30T09:30:00.000Z'),
      detail('01JFZ8X8Y3T0V5G9WQK2M4N7A1', 'Standup', '2026-10-30T09:00:00.000Z'),
    ];
    const { ctl } = library(ds);
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', '--all', '--out', dir], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toBe(`jantar meetings: two meetings would share the folder ${join(dir, '2026-10-30-standup-m4n7a1')}; export them one at a time\n`);
    expect(await readdir(dir)).toEqual([]);
  });

  it('--all stops paging at a cursor it has seen before', async () => {
    const newer = detail('01JFZ8X8Y3T0V5G9WQK2M4N7A3', 'Retro', '2026-10-31T09:00:00.000Z');
    const d = meetingDetail();
    const { ctl } = library([newer, d]);
    // The second page hands back the first page's cursor again.
    ctl.routes['GET /v1/meetings'] = (call: CtlCall) =>
      ok({ meetings: [call.path.includes('before=') ? d.meeting : newer.meeting], next: newer.meeting.id, running: null } satisfies MeetingsList);
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['export', '--all', '--out', dir], c.ctx), c.io.stderr).toBe(EXIT.ok);
    expect(ctl.calls.filter((x) => x.path.startsWith('/v1/meetings?')).map((x) => x.path)).toEqual(['/v1/meetings?limit=50', `/v1/meetings?limit=50&before=${newer.meeting.id}`]);
    expect((await readdir(dir)).sort()).toEqual(['2026-10-30-weekly-sync-m4n6pr', '2026-10-31-retro-m4n7a3']);
  });

  it('--all skips a meeting deleted after the list was read', async () => {
    const gone = '01JFZ8X8Y3T0V5G9WQK2M4N7A3';
    const ds = [detail(gone, 'Retro', '2026-10-31T09:00:00.000Z'), meetingDetail()];
    const c = contextFor({ env: ENV }, { ctl: library(ds, { gone: [gone] }).ctl });
    expect(await meetings.run(['export', '--all', '--out', dir], c.ctx)).toBe(EXIT.ok);
    expect(await readdir(dir)).toEqual(['2026-10-30-weekly-sync-m4n6pr']);
    expect(c.io.stdout).toContain(`Skipped ${gone}: deleted since the list was read.\n`);
    expect(c.io.stdout).toContain(`Exported 1 meeting to ${dir}\n`);
  });

  it('a meeting the daemon does not have fails a single export', async () => {
    const c = contextFor({ env: ENV }, { ctl: library([meetingDetail()], { gone: [meetingDetail().meeting.id] }).ctl });
    expect(await meetings.run(['export', meetingDetail().meeting.id, '--out', dir], c.ctx)).toBe(EXIT.failed);
    expect(c.io.stderr).toBe('jantar meetings: No such meeting.\n');
    expect(await readdir(dir)).toEqual([]);
  });

  it('--out takes a quoted ~ as the home folder', async () => {
    const c = contextFor({ env: { ...ENV, HOME: dir } }, { ctl: library([meetingDetail()]).ctl });
    expect(await meetings.run(['export', 'last', '--out', '~/exports'], c.ctx)).toBe(EXIT.ok);
    expect(await readdir(join(dir, 'exports'))).toEqual(['2026-10-30-weekly-sync-m4n6pr']);
  });

  it('--all with no meetings says so and succeeds', async () => {
    const c = contextFor({ env: ENV }, { ctl: library([]).ctl });
    expect(await meetings.run(['export', '--all', '--out', dir], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toBe('No meetings yet: nothing to export.\n');
  });

  it('usage: a target is needed, one of them, a real id, and nothing more', async () => {
    const cases: [string[], string][] = [
      [['export'], 'export needs a meeting id, last or --all'],
      [['export', 'last', '--all'], 'give a meeting id, last or --all, not two of them'],
      [['export', 'weekly-sync'], '"weekly-sync" is not a meeting id'],
      [['export', 'last', 'again'], 'unexpected argument "again"'],
      [['export', 'last', '--out='], '--out needs a folder'],
      [['unpair', '--all'], '--all is not for "meetings unpair"'],
      [['--out', dir], '--out is not for "meetings"'],
      [['list'], 'unknown action "list" (on, off, export or unpair)'],
    ];
    for (const [argv, said] of cases) {
      const ctl = fakeCtl({});
      const c = contextFor({ env: ENV }, { ctl });
      expect(await meetings.run(argv, c.ctx), argv.join(' ')).toBe(EXIT.usage);
      expect(c.io.stderr, argv.join(' ')).toContain(said);
      expect(ctl.calls, argv.join(' ')).toEqual([]);
    }
  });
});

describe('export folder names', () => {
  it('slugs are lowercase ASCII letters, digits and hyphens, at most 40, "meeting" when empty', () => {
    expect(slugOf('Weekly sync')).toBe('weekly-sync');
    expect(slugOf('  Kick-off: Acme / Q4!  ')).toBe('kick-off-acme-q4');
    expect(slugOf('Résumé review, café')).toBe('resume-review-cafe');
    expect(slugOf('Ünïcödé ñame')).toBe('unicode-name');
    expect(slugOf('会议')).toBe('meeting');
    expect(slugOf('---')).toBe('meeting');
    expect(slugOf('')).toBe('meeting');
    expect(slugOf('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
    expect(slugOf('x'.repeat(80))).toHaveLength(40);
    expect(slugOf('../../etc/passwd')).toBe('etc-passwd');
  });

  it('the day is the start in the zone given; the id end is its last 6, lowercase', () => {
    const m = { id: '01JFZ8X8Y3T0V5G9WQK2M4N6PR', name: 'Weekly sync', startedAt: '2026-10-30T22:30:00.000Z' };
    expect(exportFolderName(m, 'UTC')).toBe('2026-10-30-weekly-sync-m4n6pr');
    expect(exportFolderName(m, 'Asia/Kolkata')).toBe('2026-10-31-weekly-sync-m4n6pr');
    expect(exportFolderName(m, 'America/Los_Angeles')).toBe('2026-10-30-weekly-sync-m4n6pr');
  });

  it('sizes read in KB, MB and GB', () => {
    expect(sizeText(0)).toBe('0 bytes');
    expect(sizeText(1)).toBe('1 byte');
    expect(sizeText(2048)).toBe('2 KB');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(340 * 1024 * 1024)).toBe('340 MB');
    expect(sizeText(5 * 1024 ** 3)).toBe('5 GB');
    expect(sizeText(1.25 * 1024 ** 3)).toBe('1.3 GB');
  });
});

describe('jantar meetings unpair', () => {
  it('revokes every paired extension and says how to pair again', async () => {
    const ctl = fakeCtl({ 'POST /v1/ext/unpair': ok({ ok: true, revoked: 1 }) });
    const c = contextFor({ env: ENV }, { ctl });
    expect(await meetings.run(['unpair'], c.ctx)).toBe(EXIT.ok);
    expect(c.io.stdout).toBe('Unpaired 1 extension: its key no longer works. Pair again with: jantar pair --extension\n');
    expect(ctl.calls[0]?.opts.idempotencyKey).toBeTruthy();
    const two = contextFor({ env: ENV }, { ctl: fakeCtl({ 'POST /v1/ext/unpair': ok({ ok: true, revoked: 2 }) }) });
    await meetings.run(['unpair'], two.ctx);
    expect(two.io.stdout).toBe('Unpaired 2 extensions: their keys no longer work. Pair again with: jantar pair --extension\n');
  });

  it('says when nothing was paired, and fails when the daemon is down', async () => {
    const none = contextFor({ env: ENV }, { ctl: fakeCtl({ 'POST /v1/ext/unpair': ok({ ok: true, revoked: 0 }) }) });
    expect(await meetings.run(['unpair'], none.ctx)).toBe(EXIT.ok);
    expect(none.io.stdout).toBe('No extension was paired.\n');
    const down = contextFor({ env: ENV });
    expect(await meetings.run(['unpair'], down.ctx)).toBe(EXIT.daemonDown);
    expect(down.io.stderr).toContain('jantard is not running');
  });

  it('takes no argument', async () => {
    const c = contextFor({ env: ENV }, { ctl: fakeCtl({}) });
    expect(await meetings.run(['unpair', 'all'], c.ctx)).toBe(EXIT.usage);
  });
});

describe('jantar meetings --help', () => {
  it('names every action and the pairing command', async () => {
    const io = memoryIo(ENV);
    expect(await main(['meetings', '--help'], { io })).toBe(EXIT.ok);
    expect(io.stdout).toContain('usage: jantar meetings [on | off | export <id|last|--all> [--out <dir>] | unpair]');
    for (const said of ['meetings on | off', 'meetings export <id> | last', 'meetings export --all', 'meetings unpair', 'jantar pair --extension']) {
      expect(io.stdout).toContain(said);
    }
  });
});

// ---------------------------------------------------------------------------
// Against the daemon's own API (createTestContext, both transports through inject).

/** Never bound: requests go through Fastify's inject. The extension's Host names this port. */
const API_PORT = 7431;
const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const EXT_HOST = `127.0.0.1:${API_PORT}`;
const CLIENT_ID = '0b4e7c4e-0000-4000-8000-0000000000c1';

type App = Awaited<ReturnType<typeof buildApp>>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A CtlClient that sends what createCtlClient sends, into the ctl app. */
function injectCtl(app: App): CtlClient {
  return {
    socketPath: '/synthetic/run/ctl.sock',
    async request<T>(method: string, path: string, body?: unknown, opts: CtlRequestOptions = {}): Promise<CtlResponse<T>> {
      const headers: Record<string, string> = { accept: 'application/json', host: 'jantar.local' };
      if (opts.idempotencyKey) headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;
      const res = await app.inject({ method: method as Method, url: path, headers, ...(body === undefined ? {} : { payload: body as object }) });
      return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as T) : null };
    },
    async bytes(path: string) {
      const res = await app.inject({ method: 'GET', url: path, headers: { accept: '*/*', host: 'jantar.local' } });
      return { status: res.statusCode, type: String(res.headers['content-type'] ?? ''), body: res.rawPayload };
    },
  };
}

/** The daemon's API on a test context in a temp home, with the real Meetings shell and a Life that has no projects. */
async function daemonApi(home: string) {
  const ctx = createTestContext({ userHome: home, home: join(home, '.jantar') });
  await mkdir(ctx.paths.home, { recursive: true, mode: 0o700 });
  const todos = notBuilt<TodosModule>('Life', { name: 'todos', listProjects: () => ({ ok: true as const, value: { projects: [] } }) });
  const life = notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, todos });
  const usage = notBuilt<UsageSource>('Usage', { start: async () => {}, stop: async () => {}, latest: () => null });
  const ccwLegacy = notBuilt<CcwLegacySource>('ccw', { start: async () => {}, stop: async () => {}, present: () => false });
  const part = createMeetingsService(ctx, { life, usage, ccwLegacy });
  await part.start();
  // Only the settings, pairing and meetings routes are called here; every other part answers 501.
  const deps = { ...notBuiltParts(), life, meetings: part } as unknown as ApiDeps;
  const services = new ApiServices(ctx, deps, { port: API_PORT, webDist: null });
  const tcp = await buildApp(services, 'tcp');
  const ctl = await buildApp(services, 'ctl');
  /** The extension's side of pairing: the claim, from its Origin on loopback. */
  const claim = async (code: string) => {
    const res = await tcp.inject({ method: 'POST', url: '/v1/ext/pair', headers: { host: EXT_HOST, origin: EXT_ORIGIN }, payload: { code } });
    if (res.statusCode !== 200) throw new Error(`claim: ${res.statusCode} ${res.body}`);
    return res.json() as { id: string; key: string };
  };
  /** A request from the paired extension's service worker. */
  const ext = (key: string, method: Method, url: string, payload?: object) =>
    tcp.inject({ method, url, headers: { host: EXT_HOST, [EXTENSION_KEY_HEADER]: key, ...(method === 'GET' ? {} : { origin: EXT_ORIGIN }) }, ...(payload ? { payload } : {}) });
  return {
    ctx,
    part,
    ctl: injectCtl(ctl),
    claim,
    ext,
    async close() {
      await part.stop();
      await tcp.close();
      await ctl.close();
    },
  };
}

/** True while WP0's 501 stub still stands for any of these routes. */
function stubbed(...names: RouteName[]): boolean {
  return names.some((n) => (MEETINGS_ROUTE_IMPLS[n] ?? EXT_ROUTE_IMPLS[n])?.stub === true);
}

describe('jantar meetings against the daemon API (createTestContext)', () => {
  let home: string;
  let api: Awaited<ReturnType<typeof daemonApi>>;
  /** One set of deps for every command in a test, so their idempotency keys never repeat. */
  let deps: ReturnType<typeof testDeps>;
  const cli = () => contextFor({ env: ENV }, { ctl: api.ctl, deps });
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'jantar-cli-meetings-'));
    api = await daemonApi(home);
    deps = testDeps();
  });
  afterEach(async () => {
    await api.close();
    await rm(home, { recursive: true, force: true });
  });

  it('on and off change the switch, and the daemon opens and closes meetings.db', async () => {
    const on = cli();
    expect(await meetings.run(['on'], on.ctx), on.io.stderr).toBe(EXIT.ok);
    expect(api.ctx.settings.get().meetings.enabled).toBe(true);
    expect(api.part.status()).toMatchObject({ on: true, open: true });
    expect(on.io.stdout).toContain(MEETINGS_DATA_FLOW);
    expect((await lstat(api.ctx.paths.meetingsDb)).isFile()).toBe(true);
    const off = cli();
    expect(await meetings.run(['off'], off.ctx), off.io.stderr).toBe(EXIT.ok);
    expect(api.part.status()).toMatchObject({ on: false, open: false });
  });

  it('on with a meetings.db that will not open: the switch is on, the broken sentence on stderr, the file untouched', async () => {
    const junk = 'not a database '.repeat(400);
    await writeFile(api.ctx.paths.meetingsDb, junk, { mode: 0o600 });
    const on = cli();
    expect(await meetings.run(['on'], on.ctx), on.io.stderr).toBe(EXIT.ok);
    expect(api.part.status()).toMatchObject({ on: true, open: false });
    expect(on.io.stderr).toBe(`${api.part.status().broken}\n`);
    expect(on.io.stderr).toContain('Move meetings.db aside at your Mac');
    expect(await readFile(api.ctx.paths.meetingsDb, 'utf8')).toBe(junk);
  });

  it('unpair revokes the paired extension: its key is refused after', async () => {
    const start = await api.ctl.request<{ code: string }>('POST', '/v1/ext/pair/start');
    const { key } = await api.claim((start.body as { code: string }).code);
    expect((await api.ext(key, 'GET', '/v1/ext/info')).statusCode).not.toBe(401);
    const c = cli();
    expect(await meetings.run(['unpair'], c.ctx), c.io.stderr).toBe(EXIT.ok);
    expect(c.io.stdout).toBe('Unpaired 1 extension: its key no longer works. Pair again with: jantar pair --extension\n');
    expect((await api.ext(key, 'GET', '/v1/ext/info')).statusCode).toBe(401);
  });

  it.skipIf(stubbed('meetingsStatus'))('pair --extension waits for the real claim and says "Paired."', async () => {
    const io = memoryIo(ENV);
    let claimed: { id: string; key: string } | null = null;
    deps.sleep = async () => {
      // The person pastes the line into the popup while the CLI waits.
      if (claimed) return;
      const line = /^jantar-ext:(\d+):([A-Za-z0-9_-]+)$/m.exec(io.stdout);
      expect(line?.[1]).toBe(String(API_PORT));
      claimed = await api.claim(line?.[2] as string);
    };
    const c = contextFor({ env: ENV }, { ctl: api.ctl, deps, io });
    expect(await main(['pair', '--extension'], { io, context: c.ctx }), io.stderr).toBe(EXIT.ok);
    expect(io.stdout).toContain('Meetings are off: jantar meetings on\n');
    expect(io.stdout.endsWith('Paired.\n')).toBe(true);
    expect(api.part.status().extensions.map((e) => e.id)).toEqual([(claimed as unknown as { id: string }).id]);
  });

  it.skipIf(stubbed('meetingsStatus'))('the status reads the real part', async () => {
    await api.ctl.request('PATCH', '/v1/settings', { meetings: { enabled: true } }, { idempotencyKey: 'k-1' });
    const c = cli();
    expect(await meetings.run([], c.ctx), c.io.stderr).toBe(EXIT.ok);
    expect(c.io.stdout).toContain('Meetings: on\nMeetings data: open\nMeetings kept: 0\n');
    expect(c.io.stdout).toContain('Screenshots: 0 bytes of 5 GB\n');
    expect(c.io.stdout).toContain('Chrome extension: not paired.');
  });

  it.skipIf(stubbed('meetingsList', 'meetingGet', 'meetingShot', 'extMeetingOpen', 'extMeetingLines', 'extMeetingShot', 'extMeetingEnd'))(
    'export last and --all write what the extension captured',
    async () => {
      const on = cli();
      expect(await meetings.run(['on'], on.ctx)).toBe(EXIT.ok);
      const start = await api.ctl.request<{ code: string }>('POST', '/v1/ext/pair/start');
      const { key } = await api.claim((start.body as { code: string }).code);
      const jpeg = makeJpeg(64, 48);
      // Three short lines: under the summary's minimum, so no summary run starts.
      for (const [url, body] of [
        [`/v1/ext/meetings/${CLIENT_ID}`, extOpenBody()],
        [`/v1/ext/meetings/${CLIENT_ID}/lines`, extLinesBody(3)],
        [`/v1/ext/meetings/${CLIENT_ID}/shots`, extShotBody(jpeg)],
        [`/v1/ext/meetings/${CLIENT_ID}/end`, { reason: 'user', at: Date.parse('2026-01-15T10:00:00.000Z') }],
      ] as const) {
        const res = await api.ext(key, 'POST', url, body);
        expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      }
      const out = join(home, 'exports');
      const last = cli();
      expect(await meetings.run(['export', 'last', '--out', join(out, 'last')], last.ctx), last.io.stderr).toBe(EXIT.ok);
      const [folder] = await readdir(join(out, 'last'));
      expect(folder).toMatch(/^\d{4}-\d{2}-\d{2}-weekly-sync-[0-9a-z]{6}$/);
      const md = await readFile(join(out, 'last', folder as string, 'meeting.md'), 'utf8');
      expect(md).toContain('# Weekly sync');
      expect(md).toContain('Line 1 about the launch, the quote and the room booking.');
      const [shot] = await readdir(join(out, 'last', folder as string, 'shots'));
      expect(shot).toMatch(/^\d{6}-1\.jpg$/);
      expect(await readFile(join(out, 'last', folder as string, 'shots', shot as string))).toEqual(jpeg);
      expect(md).toContain(`](shots/${shot})`);
      const all = cli();
      expect(await meetings.run(['export', '--all', '--out', join(out, 'all')], all.ctx), all.io.stderr).toBe(EXIT.ok);
      expect(await readdir(join(out, 'all'))).toEqual([folder]);
    },
  );
});
