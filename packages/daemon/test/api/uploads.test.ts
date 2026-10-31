/**
 * The upload routes and sendPrompt's attachments over the real UploadStore,
 * on a throwaway home: U3 (limits), U6 (delete takes only an id of this
 * session's own folder), U9 (a send names its files in the prompt, and any
 * file gone fails it with nothing typed), U11 (the rewrite origin hashes
 * the user's own words), and a send with two uploads typed exactly through
 * the fake terminal and proven by the fake transcript (lane L4's "done
 * when").
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLstart, makeSession as rigSession } from '@jantar/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOADS_TOTAL_MAX_BYTES, UPLOAD_MAX_BYTES, UPLOAD_TEXT_MAX_BYTES, V042_LIMITS, type AttachmentRef } from '@jantar/protocol';
import type { Actor, RewriteService } from '../../src/contracts.js';
import { ATTACHMENTS_WITH_SLASH } from '../../src/api/routes.js';
import { UPLOAD_BUDGET, UPLOAD_TOO_LARGE } from '../../src/api/errors.js';
import { FakeClock } from '../../src/core/clock.js';
import { sha256Hex } from '../../src/core/hash.js';
import { createFakeExec, fixedProbe, notBuiltParts } from '../../src/core/testing.js';
import { COMPOSED_TOO_LONG } from '../../src/uploads/compose.js';
import { EMPTY_UPLOAD, HEIC_REFUSED, TEXT_TOO_LARGE, TYPE_REFUSED } from '../../src/uploads/sniff.js';
import { ATTACHMENT_GONE, NO_SESSION, NO_UPLOAD, UPLOADS_FULL } from '../../src/uploads/store.js';
import { createWriterWith } from '../../src/writer/index.js';
import { IMAGE_PATH_REFUSED } from '../../src/writer/text.js';
import { ENDED, HEIC, JPEG, NOTES, PNG, SID, SID2, ZIP, tempHome } from '../uploads/helpers.js';
import {
  FakeCcw,
  FakeHooks as WriterHooks,
  FakeSessions as WriterSessions,
  FakeTerminal as WriterTerminal,
  FakeTranscripts as WriterTranscripts,
  advance,
  psLstart,
  userEntry,
} from '../writer/helpers.js';
import { h, makeApi, makeSession, pairCookie, type TestApi } from './fakes.js';

let home: ReturnType<typeof tempHome>;
let api: TestApi | undefined;
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  await api?.close();
  api = undefined;
  home.cleanup();
});

const SESSIONS = [makeSession({ sid: SID }), makeSession({ sid: SID2, tty: '/dev/ttys005' }), makeSession({ sid: ENDED, tty: '/dev/ttys006', status: 'ended' })];

async function rig(opts: { rewrite?: RewriteService } = {}) {
  api = await makeApi({
    ctx: { userHome: home.home, home: join(home.home, '.jantar') },
    sessions: SESSIONS,
    ...(opts.rewrite ? { deps: () => ({ rewrite: opts.rewrite as RewriteService }) } : {}),
  });
  const phone = await pairCookie(api);
  return { a: api, phone, root: api.ctx.paths.uploadsDir };
}

function upload(a: TestApi, cookie: string, body: Buffer, opts: { ext?: string; sid?: string; headers?: Record<string, string> } = {}) {
  return a.tcp.inject({
    method: 'POST',
    url: `/v1/sessions/${opts.sid ?? SID}/uploads${opts.ext ? `?ext=${opts.ext}` : ''}`,
    headers: h(cookie, { 'content-type': 'application/octet-stream', ...opts.headers }),
    payload: body,
  });
}

async function uploaded(a: TestApi, cookie: string, body: Buffer, ext?: string, sid = SID): Promise<string> {
  const res = await upload(a, cookie, body, { ...(ext ? { ext } : {}), sid });
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.body}`);
  return (res.json() as { upload: { id: string } }).upload.id;
}

function remove(a: TestApi, cookie: string, id: string, sid = SID) {
  return a.tcp.inject({ method: 'DELETE', url: `/v1/sessions/${sid}/uploads/${id}`, headers: h(cookie) });
}

function send(a: TestApi, cookie: string, body: { text?: string; attachments?: AttachmentRef[]; rewriteJobId?: string }, sid = SID) {
  return a.tcp.inject({ method: 'POST', url: `/v1/sessions/${sid}/prompt`, headers: h(cookie), payload: body });
}

describe('upload and delete over the real store', () => {
  it("stores the bytes under the session's folder by the type they are; the reply is the id, kind and size only", async () => {
    const { a, phone, root } = await rig();
    const res = await upload(a, phone.cookie, PNG, { ext: 'txt' });
    expect(res.statusCode).toBe(201);
    const { upload: up } = res.json() as { upload: { id: string; kind: string; bytes: number } };
    expect(Object.keys(up).sort()).toEqual(['bytes', 'id', 'kind']);
    expect(up).toMatchObject({ kind: 'image', bytes: PNG.length });
    expect(readdirSync(join(root, SID))).toEqual([`${up.id}.png`]);
    expect(readFileSync(join(root, SID, `${up.id}.png`)).equals(PNG)).toBe(true);
    expect(res.body).not.toContain(root);

    expect((await remove(a, phone.cookie, up.id)).statusCode).toBe(200);
    expect(readdirSync(join(root, SID))).toEqual([]);
    const again = await remove(a, phone.cookie, up.id);
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toEqual({ code: 'not_found', message: NO_UPLOAD });
  });

  it("refusals carry the store's code and sentence, and write nothing", async () => {
    const { a, phone, root } = await rig();
    const heic = await upload(a, phone.cookie, HEIC, { ext: 'jpg' });
    expect(heic.statusCode).toBe(415);
    expect(heic.json().error).toEqual({ code: 'unsupported_media_type', message: HEIC_REFUSED });
    const zip = await upload(a, phone.cookie, ZIP, { ext: 'zip' });
    expect(zip.statusCode).toBe(415);
    expect(zip.json().error.message).toBe(TYPE_REFUSED);
    const empty = await upload(a, phone.cookie, Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toEqual({ code: 'invalid_request', message: EMPTY_UPLOAD });
    const read = a.services.rawBodiesRead;
    const ended = await upload(a, phone.cookie, NOTES, { sid: ENDED });
    expect(ended.statusCode).toBe(404);
    expect(ended.json().error.message).toBe(NO_SESSION);
    // Refused before its body was read.
    expect(a.services.rawBodiesRead).toBe(read);
    expect(existsSync(root)).toBe(false);
  });
});

describe('limits (U3)', () => {
  it('20 MiB a file and 2 MiB of text; nothing is written', async () => {
    const { a, phone, root } = await rig();
    const big = await upload(a, phone.cookie, Buffer.alloc(UPLOAD_MAX_BYTES + 1));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.message).toBe(UPLOAD_TOO_LARGE);
    const text = await upload(a, phone.cookie, Buffer.alloc(UPLOAD_TEXT_MAX_BYTES + 1, 'a'), { ext: 'md' });
    expect(text.statusCode).toBe(413);
    expect(text.json().error).toEqual({ code: 'payload_too_large', message: TEXT_TOO_LARGE });
    expect(existsSync(root)).toBe(false);
  });

  it('120 uploads a minute per device, counted before the store sees a byte (tiny files would slow every count)', async () => {
    const { a, phone, root } = await rig();
    const who = `device:${phone.deviceId}`;
    for (let i = 0; i < V042_LIMITS.uploads.limit; i++) expect(a.services.uploadLimiter.hit(who).ok).toBe(true);
    const read = a.services.rawBodiesRead;
    const res = await upload(a, phone.cookie, Buffer.from('one more'));
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toBe(UPLOAD_BUDGET);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(a.services.rawBodiesRead).toBe(read);
    expect(existsSync(root)).toBe(false);
  });

  it('200 MiB per 10 minutes per device, taken before the store sees a byte', async () => {
    const { a, phone, root } = await rig();
    expect(a.services.uploadBytesBudget.take(`device:${phone.deviceId}`, V042_LIMITS.uploadBytes.limit - 10).ok).toBe(true);
    const res = await upload(a, phone.cookie, Buffer.from('eleven byte'));
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toBe(UPLOAD_BUDGET);
    expect(existsSync(root)).toBe(false);
  });

  it('1 GiB under the uploads folder: 422 with the sentence', async () => {
    const { a, phone, root } = await rig();
    mkdirSync(join(root, SID2), { recursive: true });
    const filler = join(root, SID2, '01jfz8x8y3t0v5g9wqk2m4n6pr.pdf');
    writeFileSync(filler, '');
    truncateSync(filler, UPLOADS_TOTAL_MAX_BYTES - 4);
    const res = await upload(a, phone.cookie, NOTES);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'refused', message: UPLOADS_FULL });
    expect((await upload(a, phone.cookie, Buffer.from('four'))).statusCode).toBe(201);
  });
});

describe('delete traversal (U6)', () => {
  it("takes only an id-shaped name; never another session's file or a link, which stay as they are", async () => {
    const { a, phone, root } = await rig();
    const theirs = await uploaded(a, phone.cookie, NOTES, 'md', SID2);
    for (const id of ['..', '%2e%2e', '%2E%2E%2F..', `${theirs}.md`, theirs.toUpperCase(), `..%2F${SID2}%2F${theirs}`]) {
      const res = await remove(a, phone.cookie, id);
      expect([400, 404], id).toContain(res.statusCode);
    }
    expect((await remove(a, phone.cookie, theirs)).statusCode).toBe(404);
    expect(readdirSync(join(root, SID2))).toEqual([`${theirs}.md`]);
    // A link named like an upload in this session's folder.
    const target = join(home.home, 'target.txt');
    writeFileSync(target, 'not ours');
    mkdirSync(join(root, SID), { recursive: true });
    const link = join(root, SID, '01jfz8x8y3t0v5g9wqk2m4n6ps.txt');
    symlinkSync(target, link);
    expect((await remove(a, phone.cookie, '01jfz8x8y3t0v5g9wqk2m4n6ps')).statusCode).toBe(404);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('not ours');
    // The owner removes its own.
    expect((await remove(a, phone.cookie, theirs, SID2)).statusCode).toBe(200);
  });
});

describe('send with attachments (U9)', () => {
  it("types the user's words, then one quoted line per file with its absolute path", async () => {
    const { a, phone, root } = await rig();
    const img = await uploaded(a, phone.cookie, JPEG);
    const doc = await uploaded(a, phone.cookie, NOTES, 'md');
    const res = await send(a, phone.cookie, {
      text: '  Compare the photo with the notes.  ',
      attachments: [
        { upload: img, label: 'IMG_0412' },
        { upload: doc, label: 'notes "draft"\n../x.md' },
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(a.fakes.writer.submits.map((s) => s.text)).toEqual([
      [
        'Compare the photo with the notes.',
        '',
        'Attached files:',
        `- "IMG_0412": ${join(root, SID, `${img}.jpg`)}`,
        `- "notes 'draft' .._x.md": ${join(root, SID, `${doc}.md`)}`,
      ].join('\n'),
    ]);
  });

  it('files alone open with "Please look at these files:"', async () => {
    const { a, phone, root } = await rig();
    const img = await uploaded(a, phone.cookie, PNG);
    expect((await send(a, phone.cookie, { text: '', attachments: [{ upload: img, label: 'image 1' }] })).statusCode).toBe(202);
    expect(a.fakes.writer.submits[0]?.text).toBe(`Please look at these files:\n- "image 1": ${join(root, SID, `${img}.png`)}`);
  });

  it("a file gone, another session's or a link fails the whole send with the sentence; nothing is typed", async () => {
    const { a, phone, root } = await rig();
    const mine = await uploaded(a, phone.cookie, NOTES);
    const theirs = await uploaded(a, phone.cookie, NOTES, undefined, SID2);
    const target = join(home.home, 'target.png');
    writeFileSync(target, PNG);
    symlinkSync(target, join(root, SID, '01jfz8x8y3t0v5g9wqk2m4n6ps.png'));
    for (const other of [theirs, '01jfz8x8y3t0v5g9wqk2m4n6ps', '01jfz8x8y3t0v5g9wqk2m4n6pt']) {
      const res = await send(a, phone.cookie, { text: 'look', attachments: [{ upload: mine, label: 'a' }, { upload: other, label: 'b' }] });
      expect(res.statusCode, other).toBe(404);
      expect(res.json().error).toEqual({ code: 'not_found', message: ATTACHMENT_GONE });
    }
    await remove(a, phone.cookie, mine);
    expect((await send(a, phone.cookie, { text: 'look', attachments: [{ upload: mine, label: 'a' }] })).statusCode).toBe(404);
    expect(a.fakes.writer.submits).toHaveLength(0);
  });

  it('refuses attachments with a slash command, and a prompt the file list makes too long', async () => {
    const { a, phone } = await rig();
    const id = await uploaded(a, phone.cookie, NOTES);
    const slash = await send(a, phone.cookie, { text: '/compact keep notes', attachments: [{ upload: id, label: 'a' }] });
    expect(slash.statusCode).toBe(400);
    expect(slash.json().error.message).toBe(ATTACHMENTS_WITH_SLASH);
    const long = await send(a, phone.cookie, { text: 'a'.repeat(15_950), attachments: [{ upload: id, label: 'a' }] });
    expect(long.statusCode).toBe(400);
    expect(long.json().error).toEqual({ code: 'invalid_request', message: COMPOSED_TOO_LONG });
    expect(a.fakes.writer.submits).toHaveLength(0);
  });
});

describe('rewrite origin with attachments (U11)', () => {
  function fakeRewrite() {
    const seen: { jobId: string; textHash: string; actor: Actor }[] = [];
    const released: string[] = [];
    const r: RewriteService = {
      ...notBuiltParts().rewrite,
      originFor: (jobId, _sid, textHash, actor) => {
        seen.push({ jobId, textHash, actor });
        return 'rewrite';
      },
      markSent: () => undefined,
      releaseOrigin: (jobId) => void released.push(jobId),
    };
    return { r, seen, released };
  }

  it("hashes the user's own words, never the composed prompt; the composed one is typed", async () => {
    const fake = fakeRewrite();
    const { a, phone, root } = await rig({ rewrite: fake.r });
    const id = await uploaded(a, phone.cookie, NOTES, 'md');
    const words = 'Tidy the intro of these notes';
    const res = await send(a, phone.cookie, { text: words, attachments: [{ upload: id, label: 'notes.md' }], rewriteJobId: 'rw-1' });
    expect(res.statusCode).toBe(202);
    expect(fake.seen.map((s) => [s.jobId, s.textHash])).toEqual([['rw-1', sha256Hex(words)]]);
    const typed = `${words}\n\nAttached files:\n- "notes.md": ${join(root, SID, `${id}.md`)}`;
    expect(a.fakes.writer.submits.map((s) => [s.text, s.origin])).toEqual([[typed, 'rewrite']]);
    expect(sha256Hex(typed)).not.toBe(sha256Hex(words));
  });

  it('a file gone refuses before the origin is claimed: nothing to release', async () => {
    const fake = fakeRewrite();
    const { a, phone } = await rig({ rewrite: fake.r });
    const res = await send(a, phone.cookie, { text: 'go', attachments: [{ upload: '01jfz8x8y3t0v5g9wqk2m4n6pr', label: 'a' }], rewriteJobId: 'rw-1' });
    expect(res.statusCode).toBe(404);
    expect(fake.seen).toEqual([]);
    expect(fake.released).toEqual([]);
  });
});

describe('a send with two uploads, through the real writer', () => {
  const START_MS = Date.parse('2026-01-15T09:00:00.000Z');
  const PID = 41001;
  const RSID = '11111111-1111-4111-8111-111111111111';
  const TTY = '/dev/ttys003';
  const CWD = '/synthetic/home/work/alpha-app';
  const TRANSCRIPT = `/synthetic/home/.claude/projects/-synthetic-home-work-alpha-app/${RSID}.jsonl`;

  async function writerRig() {
    const clock = new FakeClock('2026-01-15T10:00:00.000Z');
    const terminal = new WriterTerminal(clock, TTY);
    const transcripts = new WriterTranscripts();
    transcripts.create(RSID, TRANSCRIPT, []);
    api = await makeApi({
      ctx: { userHome: home.home, home: join(home.home, '.jantar'), clock, exec: createFakeExec(psLstart({ [PID]: START_MS })), proc: fixedProbe([PID]) },
      sessions: [rigSession({ sid: RSID, pid: PID, procStart: formatLstart(START_MS), status: 'idle', tty: TTY, cwd: CWD, folder: 'alpha-app', name: 'add login form' })],
      deps: (ctx) => ({ writer: createWriterWith(ctx, { sessions: new WriterSessions(), terminal, transcripts, hooks: new WriterHooks(), ccwLegacy: new FakeCcw() }) }),
    });
    // Claude takes what is in the box on the first Enter and records it as a user prompt.
    terminal.onEnter = (n) => {
      if (n !== 1) return;
      transcripts.append(RSID, [userEntry({ sessionId: RSID, cwd: CWD, at: clock.iso() }, terminal.box)]);
      terminal.box = '';
    };
    const phone = await pairCookie(api);
    return { a: api, phone, clock, terminal, transcripts, root: api.ctx.paths.uploadsDir };
  }

  it('types exactly the composed text and is proven by the transcript entry holding it', async () => {
    const { a, phone, clock, terminal, transcripts, root } = await writerRig();
    const img = await uploaded(a, phone.cookie, JPEG, undefined, RSID);
    const pdf = await uploaded(a, phone.cookie, Buffer.from('%PDF-1.7\n%synthetic\n'), 'pdf', RSID);
    const res = await send(a, phone.cookie, { text: 'Match the header to the mockup and the brief.', attachments: [{ upload: img, label: 'mockup' }, { upload: pdf, label: 'brief.pdf' }] }, RSID);
    expect(res.statusCode).toBe(202);
    const jobId = (res.json() as { jobId: string }).jobId;
    await advance(clock, 40_000);
    const expected = [
      'Match the header to the mockup and the brief.',
      '',
      'Attached files:',
      `- "mockup": ${join(root, RSID, `${img}.jpg`)}`,
      `- "brief.pdf": ${join(root, RSID, `${pdf}.pdf`)}`,
    ].join('\n');
    expect(terminal.ops('type').map((c) => c.text)).toEqual([expected]);
    expect(transcripts.files.get(TRANSCRIPT)).toContain(JSON.stringify(expected));
    const job = (await a.tcp.inject({ method: 'GET', url: `/v1/sends/${jobId}`, headers: h(phone.cookie) })).json() as { job: { stage: string; textLength: number; textHash: string } };
    expect(job.job.stage).toBe('proven');
    expect(job.job.textLength).toBe(expected.length);
    expect(job.job.textHash).toBe(sha256Hex(expected));
  });

  it('a line of the words that is only an image path is refused by the writer; nothing is typed', async () => {
    const { a, phone, terminal } = await writerRig();
    const img = await uploaded(a, phone.cookie, JPEG, undefined, RSID);
    const res = await send(a, phone.cookie, { text: 'Compare with\n/synthetic/shots/old.png', attachments: [{ upload: img, label: 'new' }] }, RSID);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'refused', message: IMAGE_PATH_REFUSED });
    expect(terminal.ops('type')).toEqual([]);
  });
});
