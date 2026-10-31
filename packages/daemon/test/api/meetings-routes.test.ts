/**
 * The meetings routes over the real pipeline, with the real capture and
 * library on a meetings.db and a meetings folder in a temp home (summaries
 * inert: WP-SU's): a call captured end to end by the extension and read,
 * edited and deleted by the phone and over ctl.sock; replies are ids only;
 * the audit holds the open's and the end's target and counts, nothing for
 * lines or screenshots, never text; ticks (MP3); a 404 on every capture
 * route means "no open meeting"; lines before Start are 409 (MP6). MF1 (the
 * screenshot's 413 and 400s, nothing written), MF3 (no path tricks reach a
 * file), MF4 (the JPEG's headers and the device's raw byte budget), MF7
 * (the day's screenshot bytes per extension, the total ceiling, Life's write
 * limit for phone writes), and the 9.5 gates for lines, a screenshot, get and
 * search, timed through the pipeline (body parsing, checks and the reply).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MEETING_MARKER, MEETING_T0, extLinesBody, extOpenBody, extShotBody, makeJpeg, markerJpeg, transcriptLines } from '@jantar/fixtures';
import {
  ExtInfoSchema,
  IdReplySchema,
  MEETING_SHOT_BODY_MAX,
  MEETING_SHOT_MAX_BYTES,
  MeetingDetailSchema,
  MeetingsListSchema,
  MeetingsStatusSchema,
  OkReplySchema,
  SettingsSchema,
  type ProjectView,
} from '@jantar/protocol';
import type { LifeService, MeetingSummaries, MeetingsCore, MeetingsService, MeetingsStore, TodosModule } from '../../src/contracts.js';
import { MEETING_WRITES_LIMITED } from '../../src/api/app.js';
import { SHOT_BYTES_LIMITED } from '../../src/api/routes/ext.js';
import { SHOT_READS_LIMITED } from '../../src/api/routes/meetings.js';
import { V03_LIMITS, V04_LIMITS, type V05Limits } from '../../src/api/services.js';
import { notBuilt } from '../../src/core/not-implemented.js';
import { buildCapture } from '../../src/meetings/capture.js';
import { MEETING_REASONS } from '../../src/meetings/common.js';
import { buildMeetingsService } from '../../src/meetings/index.js';
import { buildLibrary } from '../../src/meetings/library.js';
import { h, makeApi, pairCookie, type TestApi } from './fakes.js';
import { CLIENT_ID, extHeaders, pairExtension } from './v05-helpers.js';

const PROJECT: ProjectView = {
  id: '01JFZ8X8Y3T0V5G9WQK2M4N001',
  name: 'Acme site',
  status: 'active',
  open: 0,
  overdue: 0,
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
};

let api: TestApi;
let meetings: MeetingsService;
let core: MeetingsCore | undefined;
let base: string;

afterEach(async () => {
  await meetings?.stop();
  core = undefined;
  await api?.close();
  rmSync(base, { recursive: true, force: true });
});

/** A daemon with Meetings on, the real capture and library, an extension paired and a control phone. */
async function meetingsApi(opts: { v05Limits?: Partial<V05Limits>; shotsTotalMax?: number } = {}) {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-meetings-api-')));
  const home = join(base, 'state');
  mkdirSync(home, { mode: 0o700 });
  const todos = notBuilt<TodosModule>('Life', { listProjects: () => ({ ok: true, value: { projects: [PROJECT] } }) });
  const life = notBuilt<LifeService>('Life', { start: async () => {}, stop: async () => {}, broken: () => null, todos });
  const summaries = (): MeetingSummaries =>
    notBuilt<MeetingSummaries>('Meeting summaries', { status: () => ({ available: false }), enqueue: () => undefined, start: () => undefined, stop: () => undefined, cancel: () => undefined });
  api = await makeApi({
    ctx: { home, settings: SettingsSchema.parse({ meetings: { enabled: true }, life: { todos: true } }) },
    ...(opts.v05Limits ? { api: { v05Limits: opts.v05Limits } } : {}),
    deps: (ctx, fakes) => {
      meetings = buildMeetingsService(
        ctx,
        { life, usage: fakes.usage, ccwLegacy: fakes.ccwLegacy },
        opts.shotsTotalMax !== undefined ? { shotsTotalMax: opts.shotsTotalMax } : {},
        {
          capture: buildCapture,
          library: (c) => {
            core = c;
            return buildLibrary(c);
          },
          summaries,
        },
      );
      return { meetings };
    },
  });
  await meetings.start();
  const ext = await pairExtension(api);
  const phone = await pairCookie(api, ['read', 'control']);
  const ticks: unknown[] = [];
  api.ctx.store.subscribe((ev) => {
    if (ev.type === 'life.changed') ticks.push(ev.data);
  });
  const post = (path: string, payload: unknown, key = ext.key) => api.tcp.inject({ method: 'POST', url: `/v1/ext/meetings/${CLIENT_ID}${path}`, headers: extHeaders(key), payload: payload as object });
  /** The open meetings.db's store, for seeding what the routes would take too long to fill. */
  const store = (): MeetingsStore => {
    const open = core?.store();
    if (!open) throw new Error('meetings.db is not open');
    return open;
  };
  return { ext, phone, ticks, post, store, meetingsDir: api.ctx.paths.meetingsDir };
}

/** Every file under `dir` (none when it is missing). */
function files(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

describe('a call, end to end', () => {
  it('captured by the extension, read and edited by the phone and the CLI, with ids-only replies, counts-only audit and ticks only where they belong', async () => {
    const { ext, phone, ticks, post } = await meetingsApi();
    const info = await api.tcp.inject({ method: 'GET', url: '/v1/ext/info', headers: extHeaders(ext.key, null) });
    expect(info.statusCode, info.body).toBe(200);
    expect(ExtInfoSchema.parse(info.json())).toEqual({ projects: [{ id: PROJECT.id, name: 'Acme site' }] });

    const open = await post('', extOpenBody({ projectId: PROJECT.id }, { marked: true }));
    expect(open.statusCode, open.body).toBe(200);
    const { id } = IdReplySchema.strict().parse(open.json());
    expect(ticks).toHaveLength(1);

    const lines = await post('/lines', extLinesBody(12, { marked: true }));
    expect(OkReplySchema.strict().parse(lines.json())).toEqual({ ok: true });
    expect((await post('/lines', { lines: [] })).statusCode).toBe(200);
    expect(ticks).toHaveLength(1);

    const jpeg = markerJpeg();
    const shot = await post('/shots', extShotBody(jpeg));
    expect(shot.statusCode, shot.body).toBe(200);
    const shotId = IdReplySchema.strict().parse(shot.json()).id;
    expect(ticks).toHaveLength(2);

    const end = await post('/end', { reason: 'user', at: Date.parse('2026-01-15T10:30:00.000Z') });
    expect(OkReplySchema.strict().parse(end.json())).toEqual({ ok: true });
    expect(ticks).toHaveLength(3);

    for (const [transport, headers] of [['tcp', h(phone.cookie)], ['ctl', {}]] as const) {
      const list = await api[transport].inject({ method: 'GET', url: '/v1/meetings?limit=10', headers });
      expect(list.statusCode, `${transport} ${list.body}`).toBe(200);
      const body = MeetingsListSchema.parse(list.json());
      expect(body.meetings).toHaveLength(1);
      expect(body.meetings[0]).toMatchObject({ id, projectName: 'Acme site', lines: 12, shots: 1, endReason: 'user' });
      expect(body.running).toBeNull();
      const get = await api[transport].inject({ method: 'GET', url: `/v1/meetings/${id}`, headers });
      const detail = MeetingDetailSchema.parse(get.json());
      expect(detail.lines).toHaveLength(12);
      expect(detail.shots.map((s) => s.id)).toEqual([shotId]);
      const bytes = await api[transport].inject({ method: 'GET', url: `/v1/meetings/${id}/shots/${shotId}`, headers });
      expect(bytes.statusCode).toBe(200);
      expect(bytes.rawPayload.equals(jpeg)).toBe(true);
      const status = await api[transport].inject({ method: 'GET', url: '/v1/meetings/status', headers });
      expect(MeetingsStatusSchema.parse(status.json())).toMatchObject({ on: true, open: true, meetings: 1, running: 0, shotsBytes: jpeg.length, extensions: [{ id: ext.id }] });
    }
    expect(ticks).toHaveLength(3);

    const edit = await api.tcp.inject({ method: 'PATCH', url: `/v1/meetings/${id}`, headers: h(phone.cookie), payload: { name: 'Renamed', people: null } });
    expect(OkReplySchema.strict().parse(edit.json())).toEqual({ ok: true });
    expect(ticks).toHaveLength(4);
    // Writes are not on ctl.sock.
    expect((await api.ctl.inject({ method: 'PATCH', url: `/v1/meetings/${id}`, payload: { name: 'x' } })).statusCode).toBe(404);

    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/meetings/${id}`, headers: h(phone.cookie) });
    expect(OkReplySchema.strict().parse(del.json())).toEqual({ ok: true });
    expect(ticks).toHaveLength(5);
    expect(files(api.ctx.paths.meetingsDir)).toEqual([]);
    expect(ticks.every((t) => JSON.stringify(t) === '{}')).toBe(true);

    const audit = api.ctx.db.audit.list({ limit: 1000 });
    const rows = (action: string) => audit.filter((a) => a.action === action);
    expect(rows('extMeetingOpen').map((a) => [a.actor, a.target, a.params])).toEqual([[`extension:${ext.id}`, id, {}]]);
    expect(rows('extMeetingEnd').map((a) => [a.target, a.params])).toEqual([[id, { lines: 12, shots: 1 }]]);
    expect(rows('extMeetingLines')).toEqual([]);
    expect(rows('extMeetingShot')).toEqual([]);
    expect(rows('meetingUpdate').map((a) => [a.target, a.params])).toEqual([[id, {}]]);
    expect(rows('meetingDelete').map((a) => [a.target, a.params])).toEqual([[id, {}]]);
    expect(JSON.stringify(audit)).not.toContain(MEETING_MARKER);
    expect(JSON.stringify(api.ctx.log.records)).not.toContain(MEETING_MARKER);
  });

  it('404 on every capture route means no open meeting: never opened, ended, or deleted on the phone', async () => {
    const { phone, post } = await meetingsApi();
    for (const path of ['/lines', '/shots', '/end']) {
      const body = path === '/lines' ? extLinesBody(1) : path === '/shots' ? extShotBody() : { reason: 'user', at: 0 };
      const res = await post(path, body);
      expect(res.statusCode, path).toBe(404);
      expect(res.json().error).toEqual({ code: 'not_found', message: MEETING_REASONS.notOpen });
    }
    const { id } = (await post('', extOpenBody())).json() as { id: string };
    expect((await api.tcp.inject({ method: 'DELETE', url: `/v1/meetings/${id}`, headers: h(phone.cookie) })).statusCode).toBe(200);
    expect((await post('/lines', extLinesBody(1))).statusCode).toBe(404);
    expect((await post('/lines', { lines: [] })).statusCode).toBe(404);
    expect((await post('/shots', extShotBody())).statusCode).toBe(404);
    // A fresh open with the same client id makes a new meeting (the phone's delete is final).
    const again = (await post('', extOpenBody())).json() as { id: string };
    expect(again.id).not.toBe(id);
    expect((await post('/end', { reason: 'closed', at: 0 })).statusCode).toBe(200);
    expect((await post('/lines', { lines: [] })).statusCode).toBe(404);
    expect((await post('', extOpenBody())).statusCode).toBe(409);
  });

  it('a refused open or end is audited with its code and fixed sentence only: no target, no name', async () => {
    const { ext, post } = await meetingsApi();
    expect((await post('/end', { reason: 'user', at: 0 })).statusCode).toBe(404);
    const { id } = (await post('', extOpenBody({}, { marked: true }))).json() as { id: string };
    expect((await post('/end', { reason: 'user', at: 0 })).statusCode).toBe(200);
    expect((await post('', extOpenBody({}, { marked: true }))).statusCode).toBe(409);
    const audit = api.ctx.db.audit.list({ limit: 100 }).filter((a) => a.action === 'extMeetingOpen' || a.action === 'extMeetingEnd');
    expect(audit.map((a) => [a.action, a.result, a.target, a.params, a.detail])).toEqual([
      ['extMeetingEnd', 'refused', undefined, {}, `not_found: ${MEETING_REASONS.notOpen}`],
      ['extMeetingOpen', 'ok', id, {}, undefined],
      ['extMeetingEnd', 'ok', id, { lines: 0, shots: 0 }, undefined],
      ['extMeetingOpen', 'refused', undefined, {}, `conflict: ${MEETING_REASONS.ended}`],
    ]);
    expect(audit.every((a) => a.actor === `extension:${ext.id}`)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(MEETING_MARKER);
  });

  it('MP6: lines for a meeting a screenshot made are 409 until Start', async () => {
    const { post } = await meetingsApi();
    expect((await post('', extOpenBody({ captions: false }))).statusCode).toBe(200);
    expect((await post('/shots', extShotBody())).statusCode).toBe(200);
    const refused = await post('/lines', extLinesBody(2));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual({ code: 'conflict', message: MEETING_REASONS.notesOff });
    expect((await post('', extOpenBody({ captions: true }))).statusCode).toBe(200);
    expect((await post('/lines', extLinesBody(2))).statusCode).toBe(200);
  });
});

describe('MF1: what a screenshot upload may be', () => {
  it('over 6 MB is 413 with the route sentence; not a JPEG data URL, not JPEG bytes or over 4 MB decoded are 400; nothing written, no row', async () => {
    const { post, meetingsDir } = await meetingsApi();
    const { id } = (await post('', extOpenBody())).json() as { id: string };
    const shot = (image: string) => ({ key: '1c5f8d5f-0000-4000-8000-000000000000', at: 0, image });

    const tooBig = await post('/shots', shot(`data:image/jpeg;base64,${'A'.repeat(MEETING_SHOT_BODY_MAX)}`));
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toEqual({ code: 'payload_too_large', message: 'request body is larger than 6 MB' });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    expect((await post('/shots', shot(`data:image/png;base64,${png}`))).statusCode).toBe(400);
    for (const bytes of [Buffer.from(png, 'base64'), Buffer.from('<html><body>hi</body></html>'), Buffer.from('just text')]) {
      const res = await post('/shots', shot(`data:image/jpeg;base64,${bytes.toString('base64')}`));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toEqual({ code: 'invalid_request', message: MEETING_REASONS.notJpeg });
    }
    const big = await post('/shots', extShotBody(makeJpeg(64, 48, { padBytes: MEETING_SHOT_MAX_BYTES })));
    expect(big.statusCode).toBe(400);
    expect(big.json().error).toEqual({ code: 'invalid_request', message: MEETING_REASONS.shotTooLarge });

    expect(files(meetingsDir)).toEqual([]);
    const detail = MeetingDetailSchema.parse((await api.ctl.inject({ method: 'GET', url: `/v1/meetings/${id}` })).json());
    expect(detail.shots).toEqual([]);
  });
});

describe("MF3, MF4: a screenshot's bytes", () => {
  it('MF3: no path trick reaches a file: .., %2e%2e, %2f, a non-ulid or decorated id answer 400 or 404 as JSON', async () => {
    const { phone, post } = await meetingsApi();
    const { id } = (await post('', extOpenBody())).json() as { id: string };
    const shotId = ((await post('/shots', extShotBody())).json() as { id: string }).id;
    const tries = [
      `/v1/meetings/${id}/shots/..`,
      `/v1/meetings/${id}/shots/%2e%2e`,
      `/v1/meetings/${id}/shots/..%2f..%2fconfig.json`,
      `/v1/meetings/${id}/shots/${shotId}%2f..`,
      `/v1/meetings/..%2f${id}/shots/${shotId}`,
      `/v1/meetings/${id}/shots/${shotId.toLowerCase()}`,
      `/v1/meetings/${id}/shots/${shotId}.jpg`,
      `/v1/meetings/${id}/shots/not-a-ulid`,
    ];
    for (const url of tries) {
      const res = await api.tcp.inject({ method: 'GET', url, headers: h(phone.cookie) });
      expect([400, 404], url).toContain(res.statusCode);
      expect(res.headers['content-type'], url).toContain('application/json');
    }
  });

  it("MF3: another meeting's shot id is 404", async () => {
    const { phone, post, ext } = await meetingsApi();
    await post('', extOpenBody());
    const shotId = ((await post('/shots', extShotBody())).json() as { id: string }).id;
    const second = '0b4e7c4e-0000-4000-8000-0000000000ff';
    const other = (await api.tcp.inject({ method: 'POST', url: `/v1/ext/meetings/${second}`, headers: extHeaders(ext.key), payload: extOpenBody() })).json() as { id: string };
    const res = await api.tcp.inject({ method: 'GET', url: `/v1/meetings/${other.id}/shots/${shotId}`, headers: h(phone.cookie) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'not_found', message: MEETING_REASONS.noShot });
  });

  it("MF4: replies image/jpeg with nosniff, a sandbox CSP and private no-store, and counts against the device's raw byte budget (not the Mac's)", async () => {
    const { phone, post, meetingsDir } = await meetingsApi();
    const { id } = (await post('', extOpenBody())).json() as { id: string };
    const jpeg = makeJpeg(64, 48);
    const shotId = ((await post('/shots', extShotBody(jpeg))).json() as { id: string }).id;
    const url = `/v1/meetings/${id}/shots/${shotId}`;
    const res = await api.tcp.inject({ method: 'GET', url, headers: h(phone.cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers.etag).toBe(`"${shotId}"`);

    // Up to the 200 MB just short of this picture: the next read is 429.
    expect(api.services.rawBytesBudget.take(`device:${phone.deviceId}`, V03_LIMITS.rawBytes.limit - jpeg.length * 2 + 1).ok).toBe(true);
    const limited = await api.tcp.inject({ method: 'GET', url, headers: h(phone.cookie) });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'rate_limited', message: SHOT_READS_LIMITED });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Refused from the row's size before the file is read: with the file moved away it is still 429.
    const file = join(meetingsDir, id, `${shotId}.jpg`);
    renameSync(file, `${file}.aside`);
    expect((await api.tcp.inject({ method: 'GET', url, headers: h(phone.cookie) })).statusCode).toBe(429);
    renameSync(`${file}.aside`, file);
    // The Mac's export is not counted.
    expect((await api.ctl.inject({ method: 'GET', url })).statusCode).toBe(200);
  });
});

describe('MF7: ceilings', () => {
  it("past the extension's day of screenshot bytes: 429 with retry-after, nothing written", async () => {
    const jpeg = makeJpeg(64, 48);
    const size = Math.ceil((jpeg.toString('base64').length * 3) / 4);
    const { post, meetingsDir } = await meetingsApi({ v05Limits: { extShotBytes: { limit: size * 2, windowMs: 24 * 60 * 60_000 } } });
    await post('', extOpenBody());
    expect((await post('/shots', extShotBody(jpeg))).statusCode).toBe(200);
    expect((await post('/shots', extShotBody(jpeg))).statusCode).toBe(200);
    const limited = await post('/shots', extShotBody(jpeg));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'rate_limited', message: SHOT_BYTES_LIMITED });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(files(meetingsDir)).toHaveLength(2);
    // Lines still go through: only screenshot bytes are counted.
    expect((await post('/lines', extLinesBody(3))).statusCode).toBe(200);
  });

  it('a screenshot that would pass the total ceiling: 409 with its sentence, nothing written', async () => {
    const jpeg = makeJpeg(64, 48);
    const { post, meetingsDir } = await meetingsApi({ shotsTotalMax: jpeg.length + 10 });
    await post('', extOpenBody());
    expect((await post('/shots', extShotBody(jpeg))).statusCode).toBe(200);
    const full = await post('/shots', extShotBody(jpeg));
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toEqual({ code: 'conflict', message: MEETING_REASONS.shotsDiskFull });
    expect(files(meetingsDir)).toHaveLength(1);
  });

  it("a phone's edits past Life's write limit: 429 with the meetings sentence", async () => {
    const { phone, post } = await meetingsApi();
    const { id } = (await post('', extOpenBody())).json() as { id: string };
    for (let i = 0; i < V04_LIMITS.lifeWrite.limit; i++) {
      const res = await api.tcp.inject({ method: 'PATCH', url: `/v1/meetings/${id}`, headers: h(phone.cookie), payload: { name: `Name ${i}` } });
      expect(res.statusCode, `edit ${i + 1}`).toBe(200);
    }
    const limited = await api.tcp.inject({ method: 'PATCH', url: `/v1/meetings/${id}`, headers: h(phone.cookie), payload: { name: 'One more' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'rate_limited', message: MEETING_WRITES_LIMITED });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('performance gates (spec 9.5): server time through the pipeline, body parsing, checks and the reply included', () => {
  /** The median of five requests, in ms; each must answer 200. */
  async function median(send: (i: number) => Promise<{ statusCode: number; body: string }>): Promise<number> {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const res = await send(i);
      times.push(performance.now() - t0);
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    }
    return times.sort((a, b) => a - b)[2] ?? Infinity;
  }

  /** The extension's POST with its body already JSON, so only the server's parse is timed. */
  function postJson(key: string, path: string, json: string) {
    return api.tcp.inject({ method: 'POST', url: `/v1/ext/meetings/${CLIENT_ID}${path}`, headers: { ...extHeaders(key), 'content-type': 'application/json' }, payload: json });
  }

  it('extMeetingLines with 200 upserts, as long as a 64 KB body holds: at most 20 ms', async () => {
    const { ext, post } = await meetingsApi();
    expect((await post('', extOpenBody())).statusCode).toBe(200);
    const bodies = Array.from({ length: 5 }, (_, i) => JSON.stringify({ lines: transcriptLines(200, { nonce: `p${i}`, chars: 240 }) }));
    expect(Math.max(...bodies.map((b) => b.length))).toBeGreaterThan(60 * 1024);
    expect(await median((i) => postJson(ext.key, '/lines', bodies[i] ?? ''))).toBeLessThanOrEqual(20);
  });

  it('extMeetingShot with a 1 MB JPEG: at most 80 ms', async () => {
    const { ext, post } = await meetingsApi();
    expect((await post('', extOpenBody())).statusCode).toBe(200);
    const jpeg = makeJpeg(640, 480, { padBytes: 1024 * 1024 });
    const bodies = Array.from({ length: 5 }, () => JSON.stringify(extShotBody(jpeg)));
    expect(await median((i) => postJson(ext.key, '/shots', bodies[i] ?? ''))).toBeLessThanOrEqual(80);
  });

  it('GET /v1/meetings/:id with 5,000 lines of 400 characters and 100 shots: at most 80 ms', async () => {
    const { phone, post, store } = await meetingsApi();
    const { id } = (await post('', extOpenBody())).json() as { id: string };
    for (let from = 0; from < 5_000; from += 200) store().upsertLines(id, transcriptLines(200, { from, chars: 400 }));
    for (let i = 0; i < 100; i++) store().addShot(id, { id: core!.newId(), key: randomUUID(), at: MEETING_T0 + i * 1000, bytes: 200_000 });
    const get = () => api.tcp.inject({ method: 'GET', url: `/v1/meetings/${id}`, headers: h(phone.cookie) });
    const detail = MeetingDetailSchema.parse((await get()).json());
    expect([detail.lines.length, detail.shots.length]).toEqual([5_000, 100]);
    expect(await median(get)).toBeLessThanOrEqual(80);
  });

  it('GET /v1/meetings?q= over 1,000 meetings and 200,000 lines of 400 characters: at most 200 ms', async () => {
    const { ext, phone, store } = await meetingsApi();
    for (let i = 0; i < 1_000; i++) {
      const opened = meetings.capture.open(ext.id, randomUUID(), extOpenBody({ name: `Meeting ${i}` }));
      if (!opened.ok) throw new Error(opened.reason);
      store().upsertLines(opened.value.id, transcriptLines(200, { nonce: `m${i}`, chars: 400 }));
    }
    const search = () => api.tcp.inject({ method: 'GET', url: '/v1/meetings?q=zebra-crossing', headers: h(phone.cookie) });
    expect(MeetingsListSchema.parse((await search()).json()).meetings).toEqual([]);
    expect(await median(search)).toBeLessThanOrEqual(200);
  }, 300_000);
});
