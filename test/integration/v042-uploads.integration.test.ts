/**
 * v0.4.2 attachments end to end (spec 9.3 flow 8, rules U1-U11): jantard
 * in-process on a synthetic HOME with the scripted terminal, a phone paired
 * with read and control, and every upload sent over a real socket, so the
 * raw-body pipeline runs as it does behind the front door (Content-Length,
 * a body that never comes, a connection the phone drops).
 *
 * 1. A PNG and a text file go up; the replies carry an id, a kind and a
 *    size only; the files sit in <state dir>/uploads/<sid>/ (0700, 0600).
 *    "look at these" with both is typed as the composed prompt, in one
 *    write, and proven by the transcript.
 * 1b. A phone photo (JPEG, the phone's own redraw) and a PDF: the image
 *    and the PDF by their magic bytes whatever `?ext=` says, both absolute
 *    paths in the prompt, the label cleaned, the send proven.
 * 2. Refusals before the body is read: no device secret, a read-only
 *    device, another content type, no Content-Length, a declared size over
 *    20 MiB, a third upload in flight (and the slots come back when the
 *    phone drops the two).
 * 3. Refusals after it is read: HEIC, an empty file, a zip that is no
 *    office file, an unknown session.
 * 4. Remove: by id only, once; never another session's upload, never a
 *    traversal; a send naming a removed upload types nothing.
 * 5. A slash command with attachments is refused, nothing typed.
 * 6. The sweep at start removes week-old uploads, leaves new ones, names
 *    that are not upload ids and links alone.
 */
import { lstat, mkdir, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_COOKIE, DEVICE_SECRET_HEADER, UPLOAD_MAX_BYTES, type PairStartResponse, type SessionsResponse, type UploadResponse } from '@jantar/protocol';
import { perfBudgetMs } from '@jantar/fixtures';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';

const SID = '42424242-4242-4424-8424-424242424242';
const OTHER = '42424242-4242-4424-8424-4242424242ab';
const ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** A real 1x1 PNG (8-bit RGB). */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 0x2a, 0x6f, 0x9e]))), chunk('IEND', Buffer.alloc(0))]);
}

/** The first bytes of an iPhone photo that was not converted (`ftyp` brand heic). */
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic', 'latin1'), Buffer.alloc(64)]);
/** A zip (local file header) the phone does not call docx, xlsx or pptx. */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
const NOTES = Buffer.from('# Demo notes\n\nThe header should be teal.\n', 'utf8');
/** The first bytes of a JPEG (JFIF), as the phone's canvas writes one. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF', 'latin1'), Buffer.from([0x00]), Buffer.alloc(64)]);
/** A PDF's header and a line of it. */
const PDF = Buffer.from('%PDF-1.7\n%synthetic demo invoice\n', 'latin1');

interface RawOptions {
  cookie?: string;
  secret?: string | null;
  contentType?: string | null;
  /** Default: chunked when null, the body's length otherwise. */
  length?: number | null;
}

/**
 * One request with a raw body over a fresh socket (no keep-alive pool), the
 * way the phone's XMLHttpRequest sends an upload: octet-stream, a
 * Content-Length, the device cookie and secret, the daemon's own Origin.
 */
function raw(port: number, method: string, path: string, body: Buffer | null, opts: RawOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'application/json', host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.secret) headers[DEVICE_SECRET_HEADER] = opts.secret;
    if (body) {
      if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/octet-stream';
      if (opts.length === null) headers['transfer-encoding'] = 'chunked';
      else headers['content-length'] = String(opts.length ?? body.length);
    }
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * An upload whose body never finishes: the headers and a few bytes go out,
 * then nothing, until `drop()` closes the socket (a phone that lost its
 * signal). The daemon counts it as in flight from its headers on.
 */
function stalledUpload(port: number, path: string, cookie: string, secret: string, declared: number) {
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path,
    agent: false,
    headers: {
      accept: 'application/json',
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      cookie,
      [DEVICE_SECRET_HEADER]: secret,
      'content-type': 'application/octet-stream',
      'content-length': String(declared),
    },
  });
  const answered = new Promise<number>((resolve) => {
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.on('close', () => resolve(0));
  });
  req.flushHeaders();
  req.write(Buffer.from('partial'));
  return { answered, drop: () => req.destroy() };
}

describe('v0.4.2 attachments: upload, send with proof, refusals, remove, sweep', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let phone = '';
  let secret = '';
  let viewer = '';
  let viewerSecret = '';
  const sessionDir = () => join(d.ctx.paths.uploadsDir, SID);

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function pair(name: string, scopes: string[]): Promise<{ cookie: string; secret: string }> {
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name } });
    expect(claim.status, claim.text).toBe(200);
    const cookie = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(cookie, claim.body);
    return { cookie, secret: (claim.body as { deviceSecret: string }).deviceSecret };
  }

  const upload = (bytes: Buffer, ext?: string, sid = SID, opts: RawOptions = {}) =>
    raw(d.port, 'POST', `/v1/sessions/${sid}/uploads${ext ? `?ext=${ext}` : ''}`, bytes, { cookie: phone, secret, ...opts });

  async function uploaded(bytes: Buffer, ext?: string, sid = SID): Promise<UploadResponse['upload']> {
    const r = await upload(bytes, ext, sid);
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(201);
    return (r.body as UploadResponse).upload;
  }

  const send = (body: Record<string, unknown>, sid = SID) =>
    http(d.port, 'POST', `/v1/sessions/${sid}/prompt`, { cookie: phone, body: { onDraft: 'refuse', ...body }, headers: { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` } });

  beforeAll(async () => {
    d = await bootDaemon({
      home: {
        sessions: [
          { sid: SID, pid: 42001, account: 1, project: 'demo-app', status: 'idle', tty: 'ttys042', transcript: [] },
          { sid: OTHER, pid: 42002, account: 1, project: 'other-app', status: 'idle', tty: 'ttys043', transcript: [] },
        ],
      },
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => {
      const sids = (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.map((s) => s.sid);
      return sids.includes(SID) && sids.includes(OTHER);
    }, 15_000, 'the live sessions');
    ({ cookie: phone, secret } = await pair('uploads phone', ['read', 'control']));
    ({ cookie: viewer, secret: viewerSecret } = await pair('shared screen', ['read']));
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. a PNG and a text file go up, and "look at these" is typed with both and proven', async () => {
    const png = await uploaded(tinyPng(), 'png');
    const notes = await uploaded(NOTES, 'md');
    expect(png).toEqual({ id: expect.stringMatching(ULID), kind: 'image', bytes: tinyPng().length });
    expect(notes).toEqual({ id: expect.stringMatching(ULID), kind: 'text', bytes: NOTES.length });

    // Stored under generated names in the session's own folder, 0700 and 0600.
    const dir = sessionDir();
    expect((await stat(d.ctx.paths.uploadsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readdir(dir)).sort()).toEqual([`${notes.id}.md`, `${png.id}.png`].sort());
    for (const name of await readdir(dir)) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);

    const r = await send({ text: '  look at these  ', attachments: [{ upload: png.id, label: 'header.png' }, { upload: notes.id, label: 'notes.md' }] });
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(202);
    const jobId = (r.body as { jobId: string }).jobId;
    const job = await eventually(async () => {
      const j = d.parts.writer.get(jobId);
      if (j && (j.stage === 'failed' || j.stage === 'refused')) throw new Error(`the send ended ${j.stage}: ${j.reason ?? ''}\n${dumpLog()}`);
      return j?.stage === 'proven' ? j : null;
    }, 30_000, 'the send to be proven');
    expect(job.proof?.kind).toBe('user');

    // The user's words, then one line per file that starts with words (never a bare path).
    const composed = ['look at these', '', 'Attached files:', `- "header.png": ${join(dir, `${png.id}.png`)}`, `- "notes.md": ${join(dir, `${notes.id}.md`)}`].join('\n');
    expect(d.terminal.events.typed.map((t) => t.text)).toEqual([composed]);
    expect(d.terminal.events.enters.at(-1)?.submitted).toBe(composed);

    // The send's audit row counts the files; it never names one.
    const audit = d.ctx.db.audit.list({ after: 0, limit: 1000 }).filter((e) => e.action === 'sendPrompt');
    expect(audit.at(-1)?.params).toMatchObject({ attachments: 2 });
    expect(JSON.stringify(audit)).not.toContain('header.png');
    expect(JSON.stringify(audit)).not.toContain(d.ctx.paths.uploadsDir);
    // A file with no words: the daemon's own opening line.
    const only = await uploaded(NOTES, 'txt');
    const r2 = await send({ text: '', attachments: [{ upload: only.id, label: 'readme' }] });
    expect(r2.status, r2.text).toBe(202);
    const job2 = (r2.body as { jobId: string }).jobId;
    await eventually(async () => d.parts.writer.get(job2)?.stage === 'proven', 30_000, 'the files-only send');
    expect(d.terminal.events.typed.at(-1)?.text).toBe(['Please look at these files:', `- "readme": ${join(dir, `${only.id}.txt`)}`].join('\n'));
  }, perfBudgetMs(90_000));

  it('1b. a photo and a PDF go up and are named in the prompt by absolute path, proven', async () => {
    // The ext is the phone's guess; the bytes decide (a PDF named .png is a PDF).
    const photo = await uploaded(JPEG, 'jpg');
    const pdf = await uploaded(PDF, 'png');
    expect(photo).toEqual({ id: expect.stringMatching(ULID), kind: 'image', bytes: JPEG.length });
    expect(pdf).toEqual({ id: expect.stringMatching(ULID), kind: 'pdf', bytes: PDF.length });
    const dir = sessionDir();
    const before = d.terminal.events.typed.length;
    const r = await send({ text: 'What is on these two?', attachments: [{ upload: photo.id, label: 'IMG_0412.jpg' }, { upload: pdf.id, label: 'invoice "march"/2026.pdf' }] });
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(202);
    const jobId = (r.body as { jobId: string }).jobId;
    await eventually(async () => {
      const j = d.parts.writer.get(jobId);
      if (j && (j.stage === 'failed' || j.stage === 'refused')) throw new Error(`the send ended ${j.stage}: ${j.reason ?? ''}\n${dumpLog()}`);
      return j?.stage === 'proven' ? j : null;
    }, 30_000, 'the send to be proven');
    const composed = [
      'What is on these two?',
      '',
      'Attached files:',
      `- "IMG_0412.jpg": ${join(dir, `${photo.id}.jpg`)}`,
      `- "invoice 'march'_2026.pdf": ${join(dir, `${pdf.id}.pdf`)}`,
    ].join('\n');
    expect(d.terminal.events.typed.slice(before).map((t) => t.text)).toEqual([composed]);
    for (const line of composed.split('\n').slice(3)) expect(line.split(': ')[1]?.startsWith('/')).toBe(true);
  }, perfBudgetMs(60_000));

  it('2. refused before the body is read: secret, scope, content type, Content-Length, size, two in flight', async () => {
    const path = `/v1/sessions/${SID}/uploads?ext=png`;
    const png = tinyPng();
    expect((await raw(d.port, 'POST', path, png, { cookie: phone, secret: null })).status).toBe(401);
    expect((await raw(d.port, 'POST', path, png, { cookie: viewer, secret: viewerSecret })).status).toBe(403);
    expect((await raw(d.port, 'POST', path, png, { cookie: phone, secret, contentType: 'image/png' })).status).toBe(415);
    expect((await raw(d.port, 'POST', path, png, { cookie: phone, secret, contentType: 'multipart/form-data; boundary=x' })).status).toBe(415);
    const chunked = await raw(d.port, 'POST', path, png, { cookie: phone, secret, length: null });
    expect(chunked.status).toBe(411);
    expect((chunked.body as { error: { code: string } }).error.code).toBe('length_required');

    // A declared size over 20 MiB is refused from the headers alone: none of the 20 MiB is sent.
    const big = stalledUpload(d.port, path, phone, secret, UPLOAD_MAX_BYTES + 1);
    expect(await big.answered).toBe(413);
    big.drop();

    // Two uploads in flight from one phone; a third waits for neither and is refused.
    const one = stalledUpload(d.port, path, phone, secret, 4096);
    const two = stalledUpload(d.port, path, phone, secret, 4096);
    await eventually(async () => {
      const third = await upload(png, 'png');
      return third.status === 429 ? third : null;
    }, 5_000, 'the third upload to be refused');
    // The phone drops them: both slots come back.
    one.drop();
    two.drop();
    await one.answered;
    await two.answered;
    const after = await eventually(async () => {
      const r = await upload(png, 'png');
      return r.status === 201 ? r : null;
    }, 5_000, 'an upload once the stalled ones are gone');
    expect((after.body as UploadResponse).upload.kind).toBe('image');
    // Nothing of the refused or dropped uploads is on disk: only the files that got a 201.
    const ids = (await readdir(sessionDir())).map((n) => n.split('.')[0]);
    expect(ids).toContain((after.body as UploadResponse).upload.id);
    expect(ids.every((id) => ULID.test(id ?? ''))).toBe(true);
  }, perfBudgetMs(60_000));

  it('3. refused once read: HEIC, an empty file, a zip that is no office file, an unknown session', async () => {
    const before = (await readdir(sessionDir())).length;
    const heic = await upload(HEIC, 'heic');
    expect(heic.status).toBe(415);
    expect((heic.body as { error: { message: string } }).error.message).toMatch(/HEIC/);
    expect((await upload(Buffer.alloc(0), 'txt', SID, { length: 0 })).status).toBe(400);
    expect((await upload(ZIP, 'zip')).status).toBe(415);
    expect((await upload(ZIP, 'docx')).status).toBe(201);
    expect((await upload(NOTES, 'md', '99999999-9999-4999-8999-999999999999')).status).toBe(404);
    expect((await readdir(sessionDir())).length).toBe(before + 1);
  });

  it('4. remove: once, by id, only this session’s; a send naming a removed upload types nothing', async () => {
    const mine = await uploaded(NOTES, 'md');
    const theirs = await uploaded(NOTES, 'md', OTHER);
    const del = (sid: string, id: string) => raw(d.port, 'DELETE', `/v1/sessions/${sid}/uploads/${id}`, null, { cookie: phone, secret });
    expect((await del(SID, theirs.id)).status).toBe(404);
    expect((await lstat(join(d.ctx.paths.uploadsDir, OTHER, `${theirs.id}.md`))).isFile()).toBe(true);
    // Not an id: refused by the path's schema (400), never a 404 that looked for it or a 500.
    for (const id of ['..', '%2e%2e', `..%2F${OTHER}`, `${mine.id}.md`]) {
      const r = await del(SID, id);
      expect(r.status, `${id}: ${r.text}`).toBe(400);
      expect((r.body as { error: { code: string } }).error.code, id).toBe('invalid_request');
    }
    expect((await raw(d.port, 'DELETE', `/v1/sessions/${SID}/uploads/${mine.id}`, null, { cookie: viewer, secret: viewerSecret })).status).toBe(403);
    expect((await del(SID, mine.id)).status).toBe(200);
    expect((await del(SID, mine.id)).status).toBe(404);
    await expect(lstat(join(sessionDir(), `${mine.id}.md`))).rejects.toThrow();

    const typed = d.terminal.events.typed.length;
    const r = await send({ text: 'and this one', attachments: [{ upload: mine.id, label: 'notes.md' }] });
    expect(r.status).toBe(404);
    expect((r.body as { error: { message: string } }).error.message).toMatch(/no longer on the Mac/);
    expect(d.terminal.events.typed.length).toBe(typed);
  });

  it('5. a slash command with attachments is refused, nothing typed', async () => {
    const f = await uploaded(NOTES, 'md');
    const typed = d.terminal.events.typed.length;
    const r = await send({ text: '/compact', attachments: [{ upload: f.id, label: 'notes.md' }] });
    expect(r.status).toBe(400);
    expect((r.body as { error: { message: string } }).error.message).toMatch(/slash command/);
    expect(d.terminal.events.typed.length).toBe(typed);
  });

  it('6. the sweep at start: week-old uploads go, new ones, other names and links stay', async () => {
    const keep = await uploaded(NOTES, 'md');
    const old = await uploaded(NOTES, 'md');
    const dir = sessionDir();
    const outside = join(d.home.root, 'outside-uploads.txt');
    const stale = new Date(Date.now() - 8 * 24 * 3600_000);
    await d.restart(async () => {
      await utimes(join(dir, `${old.id}.md`), stale, stale);
      // Not an upload id: never touched, whatever its age.
      await writeFile(join(dir, 'notes-by-hand.txt'), 'kept\n');
      await utimes(join(dir, 'notes-by-hand.txt'), stale, stale);
      // A link named like an upload, to a file outside: neither followed nor removed.
      await writeFile(outside, 'outside\n');
      await utimes(outside, stale, stale);
      await symlink(outside, join(dir, '01jbzzzzzzzzzzzzzzzzzzzzzz.txt'));
      // A session folder left empty by an earlier sweep goes too.
      await mkdir(join(d.ctx.paths.uploadsDir, '77777777-7777-4777-8777-777777777777'), { mode: 0o700 });
    });
    await eventually(async () => !(await readdir(dir)).includes(`${old.id}.md`), 10_000, 'the sweep at start');
    const left = await readdir(dir);
    expect(left).toContain(`${keep.id}.md`);
    expect(left).toContain('notes-by-hand.txt');
    expect((await lstat(join(dir, '01jbzzzzzzzzzzzzzzzzzzzzzz.txt'))).isSymbolicLink()).toBe(true);
    expect((await stat(outside)).isFile()).toBe(true);
    await eventually(async () => !(await readdir(d.ctx.paths.uploadsDir)).includes('77777777-7777-4777-8777-777777777777'), 5_000, 'the empty folder to go');
    // The sweep logs a count, never a name.
    expect(JSON.stringify(d.log.records)).not.toContain(old.id);
  }, perfBudgetMs(60_000));
});
