/**
 * U8: no file name, label, path or byte of an upload reaches the audit log,
 * the event stream or the daemon's log, through a whole round (uploads,
 * refused uploads, a send with attachments, a refused send, a delete, a
 * store that can't write). Upload replies carry ids, kinds and sizes only.
 * Every planted string is synthetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadResponseSchema } from '@jantar/protocol';
import { HEIC, SID, SID2, tempHome } from '../uploads/helpers.js';
import { h, makeApi, makeSession, pairCookie, type TestApi } from './fakes.js';

const LABEL = 'planted-label-q3-budget';
const CONTENT = 'planted-bytes-7f3a91';
const WORDS = 'planted-words-read-these';

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

describe('upload privacy (U8)', () => {
  it('audit rows, events and log lines hold no label, path, file content or words; replies hold ids only', async () => {
    api = await makeApi({
      ctx: { userHome: home.home, home: join(home.home, '.jantar') },
      sessions: [makeSession({ sid: SID }), makeSession({ sid: SID2, tty: '/dev/ttys005' })],
    });
    const events: string[] = [];
    api.ctx.store.subscribe((ev) => void events.push(JSON.stringify(ev)));
    const { cookie } = await pairCookie(api);
    const root = api.ctx.paths.uploadsDir;
    const post = (body: Buffer, ext: string, sid = SID) =>
      api!.tcp.inject({ method: 'POST', url: `/v1/sessions/${sid}/uploads?ext=${ext}`, headers: h(cookie, { 'content-type': 'application/octet-stream' }), payload: body });
    const replies: string[] = [];

    const first = await post(Buffer.from(`# ${CONTENT}\n`), 'md');
    const second = await post(Buffer.from(`${CONTENT},1,2\n`), 'csv');
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    for (const r of [first, second]) {
      replies.push(r.body);
      expect(Object.keys(UploadResponseSchema.parse(r.json()).upload).sort()).toEqual(['bytes', 'id', 'kind']);
    }
    const a = UploadResponseSchema.parse(first.json()).upload.id;
    const b = UploadResponseSchema.parse(second.json()).upload.id;

    // Refused uploads: a type, and a store that can't write (a file where the session's folder goes).
    replies.push((await post(HEIC, 'jpg')).body);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, SID2), CONTENT);
    const unwritable = await post(Buffer.from(CONTENT), 'txt', SID2);
    expect(unwritable.statusCode).toBe(422);
    replies.push(unwritable.body);

    const sent = await api.tcp.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/prompt`,
      headers: h(cookie),
      payload: { text: WORDS, attachments: [{ upload: a, label: `${LABEL}.md` }] },
    });
    expect(sent.statusCode).toBe(202);
    const gone = await api.tcp.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/prompt`,
      headers: h(cookie),
      payload: { text: WORDS, attachments: [{ upload: '01jfz8x8y3t0v5g9wqk2m4n6pr', label: LABEL }] },
    });
    expect(gone.statusCode).toBe(404);
    replies.push(gone.body);
    const del = await api.tcp.inject({ method: 'DELETE', url: `/v1/sessions/${SID}/uploads/${b}`, headers: h(cookie) });
    expect(del.statusCode).toBe(200);
    replies.push(del.body);

    // The composed prompt (with the label and the path) went to the writer and nowhere else.
    expect(api.fakes.writer.submits[0]?.text).toContain(LABEL);
    expect(api.fakes.writer.submits[0]?.text).toContain(root);

    const audit = JSON.stringify(api.ctx.db.audit.list());
    const logs = JSON.stringify(api.ctx.log.records);
    const stream = events.join('\n');
    for (const [where, text] of [
      ['audit', audit],
      ['logs', logs],
      ['events', stream],
      ['replies', replies.join('\n')],
    ] as const) {
      for (const planted of [LABEL, CONTENT, WORDS, root, home.home, '.jantar/uploads']) expect(text, `${where}: ${planted}`).not.toContain(planted);
    }
    // The ids are fine where they are; what the audit keeps is counts and kinds.
    const rows = api.ctx.db.audit.list().filter((r) => r.action === 'uploadCreate' || r.action === 'sendPrompt' || r.action === 'uploadDelete');
    expect(rows.map((r) => [r.action, r.params])).toEqual([
      ['uploadCreate', { sid: SID, kind: 'text', bytes: CONTENT.length + 3 }],
      ['uploadCreate', { sid: SID, kind: 'text', bytes: CONTENT.length + 5 }],
      ['uploadCreate', { sid: SID }],
      ['uploadCreate', { sid: SID2 }],
      ['sendPrompt', expect.objectContaining({ attachments: 1, textLength: WORDS.length })],
      ['sendPrompt', expect.objectContaining({ attachments: 1 })],
      ['uploadDelete', { sid: SID }],
    ]);
    // The store's own log line names the errno only.
    expect(api.ctx.log.records.filter((r) => r.msg === 'upload not stored').map((r) => r.fields)).toEqual([{ code: 'EEXIST' }]);
  });
});
