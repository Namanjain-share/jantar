/**
 * v0.5 Meetings through jantard end to end, without a browser (spec 9.3
 * flows 9 and 10): the daemon in-process on a synthetic HOME (harness.ts),
 * the extension's side spoken over HTTP the way its worker speaks it (a key
 * claimed from loopback with the extension's Origin), the phone as a paired
 * device, and `jantar` (main() from packages/cli) on the real ctl.sock.
 *
 * 9. The phone's API: the list newest first, `running` while a meeting is
 *    open, the project filter, search by a word said only in a line, a
 *    meeting with its lines and screenshots in order, the screenshot's bytes
 *    with their headers, an edit, and a delete (its folder gone; the call's
 *    next lines are 404). A read-only device gets 403 on all three reads.
 *    The summary runs through the fake claude at the end of the call, and
 *    `jantar meetings` / `jantar meetings export` read it all back.
 * 10. A broken meetings.db (MD1): stopped, the file replaced by random
 *    bytes, started again: the status says so, every meetings route answers
 *    503 with the sentence, the file is byte for byte what it was and
 *    nothing is made beside it, while the Board, Life and pairing the
 *    extension still work.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extLinesBody, extOpenBody, extShotBody, makeJpeg, perfBudgetMs, projectBody } from '@jantar/fixtures';
import {
  DEVICE_COOKIE,
  EXTENSION_ID,
  EXTENSION_KEY_HEADER,
  type ExtPairStartReply,
  type LineUpsert,
  type MeetingDetail,
  type MeetingsList,
  type MeetingsStatus,
  type PairStartResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';

const EXT_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const BROKEN = 'Meetings data could not be opened. The file is untouched. Move meetings.db aside at your Mac to start again (docs/extension.md).';

describe('v0.5 Meetings through jantard: the phone, the CLI and a broken meetings.db', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let phone: string;
  let reader: string;
  let key: string;
  let projectA = '';
  let out = '';
  const ids: Record<'launch' | 'hiring' | 'open', string> = { launch: '', hiring: '', open: '' };
  const clients = { launch: randomUUID(), hiring: randomUUID(), open: randomUUID() };

  async function device(name: string, scopes: string[]): Promise<string> {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name } });
    expect(claim.status, claim.text).toBe(200);
    const cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);
    return cookie;
  }

  const as = (cookie: string) => (method: string, path: string, body?: unknown) =>
    http(d.port, method, path, { cookie, headers: method === 'GET' ? {} : { 'idempotency-key': `k-${randomUUID()}` }, ...(body === undefined ? {} : { body }) });
  /** The extension's worker: its key, its Origin on a POST. */
  const fromExtension = (method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult> =>
    http(d.port, method, path, { origin: method === 'POST' ? EXT_ORIGIN : null, headers: { [EXTENSION_KEY_HEADER]: key }, ...(body === undefined ? {} : { body }) });

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  /** `n` lines said now, a second apart, as the page's tracker sends them. */
  const linesNow = (n: number, opts: { nonce: string; text?: (i: number) => string }): { lines: LineUpsert[] } => {
    const now = Date.now();
    return {
      lines: extLinesBody(n, { nonce: opts.nonce }).lines.map((l, i) => ({ ...l, at: now - (n - i) * 1_000, ...(opts.text ? { text: opts.text(i) } : {}) })),
    };
  };

  beforeAll(async () => {
    d = await bootDaemon({ home: { sessions: [] }, settings: { life: { todos: true }, meetings: { enabled: true } } });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    phone = await device('Example phone', ['read', 'control']);
    reader = await device('Example shared screen', ['read']);
    const code = (await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start')).code;
    const claim = await http(d.port, 'POST', '/v1/ext/pair', { body: { code }, origin: EXT_ORIGIN });
    expect(claim.status, claim.text).toBe(200);
    key = (claim.body as { key: string }).key;
    const made = await as(phone)('POST', '/v1/projects', projectBody({ name: 'Example launch' }));
    expect(made.status, made.text).toBe(200);
    projectA = (made.body as { id: string }).id;
    out = await mkdtemp(join(tmpdir(), 'jantar-export-'));
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('9. the phone reads, filters, searches, edits and deletes; a read-only device reads nothing', async () => {
    const phoneCall = as(phone);
    // Two calls ended, a third still going.
    for (const [which, body] of [
      ['launch', extOpenBody({ name: 'Launch review', projectId: projectA, at: Date.now() - 120_000 })],
      ['hiring', extOpenBody({ name: 'Hiring sync', people: 'Alex', at: Date.now() - 60_000 })],
      ['open', extOpenBody({ name: 'Standup', people: undefined, at: Date.now() - 30_000 })],
    ] as const) {
      const r = await fromExtension('POST', `/v1/ext/meetings/${clients[which]}`, body);
      expect(r.status, r.text).toBe(200);
      ids[which] = (r.body as { id: string }).id;
    }
    const launchLines = linesNow(12, { nonce: 'launchAA', text: (i) => (i === 7 ? 'We should ask about the zeppelin permit before Friday.' : `Line ${i + 1} about the launch, the quote and the room booking.`) });
    expect((await fromExtension('POST', `/v1/ext/meetings/${clients.launch}/lines`, launchLines)).status).toBe(200);
    expect((await fromExtension('POST', `/v1/ext/meetings/${clients.hiring}/lines`, linesNow(10, { nonce: 'hiringBB' }))).status).toBe(200);
    const shots: string[] = [];
    for (const size of [[64, 48], [96, 60]] as const) {
      const r = await fromExtension('POST', `/v1/ext/meetings/${clients.launch}/shots`, extShotBody(makeJpeg(size[0], size[1]), { at: Date.now() }));
      expect(r.status, r.text).toBe(200);
      shots.push((r.body as { id: string }).id);
    }
    for (const which of ['launch', 'hiring'] as const) expect((await fromExtension('POST', `/v1/ext/meetings/${clients[which]}/end`, { reason: 'user', at: Date.now() })).status).toBe(200);

    // The list: newest first, the open one running whatever the filter.
    const all = (await phoneCall('GET', '/v1/meetings')).body as MeetingsList;
    expect(all.meetings.map((m) => m.id)).toEqual([ids.open, ids.hiring, ids.launch]);
    expect(all.running?.id).toBe(ids.open);
    const filtered = (await phoneCall('GET', `/v1/meetings?project=${projectA}`)).body as MeetingsList;
    expect(filtered.meetings.map((m) => m.id)).toEqual([ids.launch]);
    expect(filtered.running?.id).toBe(ids.open);
    expect(((await phoneCall('GET', '/v1/meetings?project=none')).body as MeetingsList).meetings.map((m) => m.id)).toEqual([ids.open, ids.hiring]);
    // A word said only in one line finds its meeting.
    expect(((await phoneCall('GET', '/v1/meetings?q=zeppelin')).body as MeetingsList).meetings.map((m) => m.id)).toEqual([ids.launch]);

    // A meeting with its lines and screenshots in order, and a screenshot's bytes.
    const got = await phoneCall('GET', `/v1/meetings/${ids.launch}`);
    expect(got.status, got.text).toBe(200);
    const m = got.body as MeetingDetail;
    expect(m.meeting).toMatchObject({ name: 'Launch review', projectId: projectA, projectName: 'Example launch', lines: 12, shots: 2 });
    expect(m.lines.map((l) => l.id)).toEqual(launchLines.lines.map((l) => l.lineId));
    expect(m.shots.map((s) => s.id)).toEqual(shots);
    const bytes = await http(d.port, 'GET', `/v1/meetings/${ids.launch}/shots/${shots[0]}`, { cookie: phone });
    expect(bytes.status).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/jpeg');
    expect(bytes.headers['x-content-type-options']).toBe('nosniff');
    expect(bytes.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(bytes.headers['cache-control']).toBe('private, no-store');

    // The summary ran through the fake claude when the call ended.
    const summary = await eventually(async () => {
      const s = ((await phoneCall('GET', `/v1/meetings/${ids.launch}`)).body as MeetingDetail).summary;
      if (s.state === 'failed') throw new Error(`the summary failed: ${s.reason ?? ''}`);
      return s.state === 'done' ? s : null;
    }, 30_000, 'the summary');
    expect(summary.items).toHaveLength(2);

    // A read-only device: 403 on every read.
    const read = as(reader);
    for (const path of ['/v1/meetings', `/v1/meetings/${ids.launch}`, `/v1/meetings/${ids.launch}/shots/${shots[0]}`]) expect((await read('GET', path)).status, path).toBe(403);

    // An edit, then a delete: the folder goes, and the call's next lines are 404.
    const edited = await phoneCall('PATCH', `/v1/meetings/${ids.hiring}`, { name: 'Hiring sync (round 2)', projectId: projectA });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body).toEqual({ ok: true });
    expect(((await phoneCall('GET', `/v1/meetings/${ids.hiring}`)).body as MeetingDetail).meeting).toMatchObject({ name: 'Hiring sync (round 2)', projectId: projectA });
    const folder = join(d.ctx.paths.meetingsDir, ids.launch);
    expect(existsSync(folder)).toBe(true);
    const gone = await phoneCall('DELETE', `/v1/meetings/${ids.launch}`);
    expect(gone.status, gone.text).toBe(200);
    expect(existsSync(folder)).toBe(false);
    expect((await phoneCall('GET', `/v1/meetings/${ids.launch}`)).status).toBe(404);
    expect((await fromExtension('POST', `/v1/ext/meetings/${clients.launch}/lines`, linesNow(1, { nonce: 'launchAA' }))).status).toBe(404);
  }, perfBudgetMs(60_000));

  it('9. `jantar meetings` and `jantar meetings export` read it back over ctl.sock', async () => {
    const st = await cli('meetings');
    expect(st.code, st.err).toBe(0);
    expect(st.out).toContain('Meetings: on\nMeetings data: open\nMeetings kept: 2 (1 running)\n');
    // Another screenshot for the export, then the newest ended meeting written out.
    expect((await fromExtension('POST', `/v1/ext/meetings/${clients.open}/shots`, extShotBody(makeJpeg(64, 48), { at: Date.now() }))).status).toBe(200);
    const one = await cli('meetings', 'export', ids.open, '--out', out);
    expect(one.code, one.err).toBe(0);
    const [dir] = await readdir(out);
    expect(dir).toMatch(/^\d{4}-\d{2}-\d{2}-standup-[0-9a-z]{6}$/);
    expect((await stat(join(out, dir!))).mode & 0o777).toBe(0o700);
    const md = await readFile(join(out, dir!, 'meeting.md'), 'utf8');
    expect(md).toContain('# Standup');
    const shotFiles = await readdir(join(out, dir!, 'shots'));
    expect(shotFiles).toHaveLength(1);
    expect((await stat(join(out, dir!, 'shots', shotFiles[0]!))).mode & 0o777).toBe(0o600);
    expect(md).toContain(`shots/${shotFiles[0]}`);
    // --all writes the others and leaves the one already there as it is.
    const everything = await cli('meetings', 'export', '--all', '--out', out);
    expect(everything.code, everything.err).toBe(0);
    expect((await readdir(out)).sort()).toHaveLength(2);
  });

  it('10. a broken meetings.db is refused, untouched, and nothing else stops', async () => {
    const file = d.ctx.paths.meetingsDb;
    const junk = randomBytes(64 * 1024);
    await d.restart(async () => {
      for (const extra of ['-wal', '-shm']) await rm(`${file}${extra}`, { force: true });
      await writeFile(file, junk, { mode: 0o600 });
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const besideBefore = (await readdir(dirname(file))).filter((f) => f.startsWith('meetings.db'));

    const st = await callDaemon<MeetingsStatus>(ctl, 'GET', '/v1/meetings/status');
    expect(st).toMatchObject({ on: true, open: false, broken: BROKEN });
    const phoneCall = as(phone);
    for (const path of ['/v1/meetings', `/v1/meetings/${ids.hiring}`]) {
      const r = await phoneCall('GET', path);
      expect(r.status, path).toBe(503);
      expect((r.body as { error: { code: string; message: string } }).error).toEqual({ code: 'meetings_unavailable', message: BROKEN });
    }
    const info = await fromExtension('GET', '/v1/ext/info');
    expect(info.status).toBe(503);
    expect((await fromExtension('POST', `/v1/ext/meetings/${randomUUID()}`, extOpenBody({ at: Date.now() }))).status).toBe(503);
    const cliStatus = await cli('meetings');
    expect(cliStatus.out + cliStatus.err).toContain(BROKEN);

    // The file is what it was, and nothing was made beside it.
    expect(sha(await readFile(file))).toBe(sha(junk));
    expect((await readdir(dirname(file))).filter((f) => f.startsWith('meetings.db'))).toEqual(besideBefore);
    expect(besideBefore).toEqual(['meetings.db']);

    // The Board, Life and the extension's pairing still work.
    expect((await phoneCall('GET', '/v1/sessions')).status).toBe(200);
    expect((await phoneCall('GET', '/v1/todos')).status).toBe(200);
    const code = (await callDaemon<ExtPairStartReply>(ctl, 'POST', '/v1/ext/pair/start')).code;
    expect((await http(d.port, 'POST', '/v1/ext/pair', { body: { code }, origin: EXT_ORIGIN })).status).toBe(200);
  }, perfBudgetMs(60_000));
});
